import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as ptyLocal from '@deepseek-ai/dsh-terminal-bash'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFERRED_ENV_CAPTURE_SCRIPT, DEFERRED_ENV_SHIM_LABEL, defaultConfig, type WorkspaceEnvrcConfig } from '../src/core.js'
import * as Integration from '../src/integration-plugin.js'
import WorkspaceEnvrc from '../src/provider.js'
import {
  inertWorkspaceMcp,
  mutableWorkspaceRegistry,
  okSpawn,
  RecordingSandbox,
  RecordingShellExecutor,
  RecordingSubprocessRuntime,
} from './helpers.js'

/**
 * REAL terminal-path harness: the official AgentRegistry, the official
 * TerminalSessionService (owner-scoped PTY registry), the official
 * terminal-bash backend plugin, the official SandboxPolicyService, this
 * bundle's provider + integration plugin — and ONLY the sandbox and
 * subprocess providers are recording stubs (the sandbox never confines the
 * host, the subprocess never allocates a real PTY). The backend's real
 * `spawnArgv` → `sandbox.confine` → `spawnTerminal` chain is exactly what the
 * adapter intercepts in production.
 */
interface Harness {
  ctx: Context
  registry: ReturnType<typeof mutableWorkspaceRegistry>
  sandbox: RecordingSandbox
  subprocess: RecordingSubprocessRuntime
  makeAgent(id: string, key: ScopeKey, parent?: ScopeKey): Promise<{ agent: Agent; dispose(): Promise<void> }>
  spawn(owner: Agent, request: { type: string; cwd?: string }, signal?: AbortSignal): Promise<unknown>
  dispose(): Promise<void>
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
})

async function setup(mode: 'read-only' | 'danger-full-access', config: WorkspaceEnvrcConfig = defaultConfig): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  const registry = mutableWorkspaceRegistry()
  const fibers: Fiber[] = []
  const scopes: Scope[] = []
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(TerminalSessionService))
  // The integration row injects a shell provider; the terminal path never
  // resolves through it, so the recording executor satisfies activation.
  fibers.push(await ctx.plugin(RecordingShellExecutor))
  const sandbox = new RecordingSandbox(ctx)
  fibers.push(await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: '/workspace/root' }))
  const subprocess = new RecordingSubprocessRuntime(ctx)
  fibers.push(await ctx.plugin(ptyLocal, {
    backendType: 'shell',
    shellPath: '/bin/bash',
    shellArgs: ['--noprofile', '--norc', '-i'],
    rows: 24,
    cols: 80,
    scrollbackLines: 10,
    scrollbackMaxBytes: 1024,
    maxReadBytes: 256,
    pollIntervalMs: 5,
    exactProbeAfterMs: 10,
    idleSilenceMs: 40,
    handoffGraceMs: 10,
    timeoutMs: 120,
    disposeGraceMs: 20,
  }))
  ctx.provide('workspaceCordis', registry)
  // The integration row injects the MCP manager; the terminal path never
  // activates an MCP row, so an inert service satisfies activation.
  ctx.provide('workspaceMcp', inertWorkspaceMcp())
  const Runtime = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, config, { spawn: okSpawn() })
    }
  }
  fibers.push(await ctx.plugin(Runtime, config as never))
  fibers.push(await ctx.plugin(Integration))
  return {
    ctx,
    registry,
    sandbox: ctx.sandbox as RecordingSandbox,
    subprocess: ctx.subprocess as RecordingSubprocessRuntime,
    async makeAgent(id, key, parent) {
      const scope = createScope(ctx, key, parent !== undefined ? { parent } : undefined)
      scopes.push(scope)
      // The backend reads session.id, session.header.cwd, and session.events.
      const session = {
        id,
        header: { id, cwd: `/cwd/${id}`, version: 0, createdAt: 0 },
        events: [],
      }
      const agent = { id, session, ctx: scope.ctx } as unknown as Agent
      const detach = ctx.agents.register(agent)
      return {
        agent,
        dispose: async () => {
          detach()
          await scope.dispose()
        },
      }
    },
    spawn(owner, request, signal) {
      return ctx.terminals.spawn(owner, request, signal)
    },
    async dispose() {
      for (const scope of scopes.reverse()) await scope.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

/** The real backend's spawn rejects when the fake terminal never reaches readiness. */
async function settleSpawn(h: Harness, agent: Agent, request: { type: string; cwd?: string } = { type: 'shell' }): Promise<void> {
  await h.spawn(agent, request).catch(() => {})
}

describe('workspace-envrc terminal adapter over the real terminal-bash path', () => {
  it('confined: the sandbox sees the deferred envrc wrapper and direnv stays inside the sandbox', async () => {
    const h = await setup('read-only')
    try {
      const ws: ScopeKey = {}
      h.registry.set(ws, '/workspaces/demo')
      const { agent } = await h.makeAgent('agent-demo', ws)
      await settleSpawn(h, agent)

      // The argv commit seam is exactly sandbox.confine: its input starts
      // with the deferred envrc wrapper and names the canonical workspace.
      expect(h.sandbox.calls).toHaveLength(1)
      const confined = h.sandbox.calls[0]!
      expect(confined.argv.slice(0, 12)).toEqual([
        'env',
        '-u',
        'BASH_ENV',
        '-u',
        'ENV',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        DEFERRED_ENV_CAPTURE_SCRIPT,
        DEFERRED_ENV_SHIM_LABEL,
        '/bin/bash',
      ])
      expect(confined.argv).toContain('direnv')
      expect(confined.argv).toContain('/workspaces/demo')

      // The final spawnTerminal argv starts with the sandbox runner and the
      // whole deferred direnv chain is INSIDE it — exactly once.
      const spec = h.subprocess.terminalSpecs[0]!
      expect(spec.argv[0]).toBe('/sandbox')
      expect(spec.argv).toContain('direnv')
      expect(spec.argv).toContain('/workspaces/demo')
      expect(spec.argv.filter(arg => arg === DEFERRED_ENV_CAPTURE_SCRIPT)).toHaveLength(1)
      expect(spec.argv).toEqual(['/sandbox', '--', ...confined.argv])

      // The final env carries the exact backend-published managed facts.
      expect(spec.env?.DSH_SESSION_ID).toBe('agent-demo')
      expect(spec.env?.DSH_PTY_SESSION_ID).toBe('pty-1')
      expect(spec.env?.DSH_SHELL).toBe('1')
    } finally {
      await h.dispose()
    }
  })

  it('danger-full-access: confine is never called and the final argv is the deferred wrapper directly', async () => {
    const h = await setup('danger-full-access')
    try {
      const ws: ScopeKey = {}
      h.registry.set(ws, '/workspaces/demo')
      const { agent } = await h.makeAgent('agent-danger', ws)
      await settleSpawn(h, agent)

      expect(h.sandbox.calls).toHaveLength(0)
      const spec = h.subprocess.terminalSpecs[0]!
      expect(spec.argv.slice(0, 12)).toEqual([
        'env',
        '-u',
        'BASH_ENV',
        '-u',
        'ENV',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        DEFERRED_ENV_CAPTURE_SCRIPT,
        DEFERRED_ENV_SHIM_LABEL,
        '/bin/bash',
      ])
      expect(spec.argv).toContain('direnv')
      expect(spec.argv).toContain('/workspaces/demo')
      expect(spec.env?.DSH_SESSION_ID).toBe('agent-danger')
    } finally {
      await h.dispose()
    }
  })

  it('keeps the backend-resolved terminal cwd (requested and defaulted)', async () => {
    const h = await setup('read-only')
    try {
      const ws: ScopeKey = {}
      h.registry.set(ws, '/workspaces/demo')
      const { agent } = await h.makeAgent('agent-cwd', ws)
      await settleSpawn(h, agent, { type: 'shell', cwd: '/custom/cwd' })
      expect(h.subprocess.terminalSpecs[0]!.cwd).toBe('/custom/cwd')

      await settleSpawn(h, agent)
      // No request cwd: the backend falls back to the policy workspace root.
      const expected = h.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
      expect(h.subprocess.terminalSpecs[1]!.cwd).toBe(expected)
    } finally {
      await h.dispose()
    }
  })

  it('uses the exact owner workspace, never the terminal cwd', async () => {
    const h = await setup('read-only')
    try {
      const ws: ScopeKey = {}
      h.registry.set(ws, '/workspaces/demo')
      const { agent } = await h.makeAgent('agent-exact', ws)
      await settleSpawn(h, agent, { type: 'shell', cwd: '/workspaces/other' })

      const confined = h.sandbox.calls[0]!
      expect(confined.argv).toContain('/workspaces/demo')
      expect(confined.argv).not.toContain('/workspaces/other')
      expect(h.subprocess.terminalSpecs[0]!.cwd).toBe('/workspaces/other')
    } finally {
      await h.dispose()
    }
  })

  it('resolves through an agent -> preset -> workspace scope chain', async () => {
    const h = await setup('read-only')
    try {
      const wsKey: ScopeKey = {}
      h.registry.set(wsKey, '/workspaces/preset-root')
      const presetKey: ScopeKey = {}
      createScope(h.ctx, presetKey, { parent: wsKey })
      const agentKey: ScopeKey = {}
      const { agent } = await h.makeAgent('agent-preset', agentKey, presetKey)
      await settleSpawn(h, agent)

      expect(h.sandbox.calls[0]!.argv).toContain('/workspaces/preset-root')
      expect(h.subprocess.terminalSpecs[0]!.argv).toContain('/workspaces/preset-root')
    } finally {
      await h.dispose()
    }
  })

  it('delegates unchanged for an unmapped scoped owner', async () => {
    const h = await setup('read-only')
    try {
      const { agent } = await h.makeAgent('agent-unmapped', {})
      await settleSpawn(h, agent)

      expect(h.sandbox.calls).toHaveLength(1)
      expect(h.sandbox.calls[0]!.argv).toEqual(['/bin/bash', '--noprofile', '--norc', '-i'])
      expect(h.subprocess.terminalSpecs[0]!.argv).toEqual([
        '/sandbox',
        '--',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-i',
      ])
      expect(h.subprocess.terminalSpecs[0]!.argv).not.toContain(DEFERRED_ENV_CAPTURE_SCRIPT)
    } finally {
      await h.dispose()
    }
  })

  it('stays installed but transparent when terminal support is disabled', async () => {
    const h = await setup('read-only', { ...defaultConfig, enableTerminal: false })
    try {
      const ws: ScopeKey = {}
      h.registry.set(ws, '/workspaces/demo')
      const { agent } = await h.makeAgent('agent-disabled', ws)
      await settleSpawn(h, agent)

      expect(h.sandbox.calls[0]!.argv).toEqual(['/bin/bash', '--noprofile', '--norc', '-i'])
      expect(h.subprocess.terminalSpecs[0]!.argv).not.toContain(DEFERRED_ENV_CAPTURE_SCRIPT)
    } finally {
      await h.dispose()
    }
  })

  it('isolates two concurrent terminal creations in different workspaces', async () => {
    const h = await setup('read-only')
    try {
      const wsA: ScopeKey = {}
      h.registry.set(wsA, '/workspaces/a')
      const wsB: ScopeKey = {}
      h.registry.set(wsB, '/workspaces/b')
      const { agent: agentA } = await h.makeAgent('agent-a', wsA)
      const { agent: agentB } = await h.makeAgent('agent-b', wsB)
      await Promise.all([settleSpawn(h, agentA), settleSpawn(h, agentB)])

      expect(h.sandbox.calls).toHaveLength(2)
      const aCall = h.sandbox.calls.find(call => call.argv.includes('/workspaces/a'))
      const bCall = h.sandbox.calls.find(call => call.argv.includes('/workspaces/b'))
      expect(aCall).toBeDefined()
      expect(bCall).toBeDefined()
      expect(aCall!.argv).not.toContain('/workspaces/b')
      expect(bCall!.argv).not.toContain('/workspaces/a')
      // Each final spec carries its own owner's workspace AND its own env.
      const specs = h.subprocess.terminalSpecs
      expect(specs).toHaveLength(2)
      const byWorkspace = (spec: (typeof specs)[number]): string =>
        spec.argv.includes('/workspaces/a') ? 'a' : spec.argv.includes('/workspaces/b') ? 'b' : 'none'
      expect(new Set(specs.map(byWorkspace))).toEqual(new Set(['a', 'b']))
      expect(new Set(specs.map(spec => spec.env?.DSH_SESSION_ID))).toEqual(new Set(['agent-a', 'agent-b']))
    } finally {
      await h.dispose()
    }
  })

  it('leaves direct subprocess.spawnTerminal outside an explicit spawn unchanged', async () => {
    const h = await setup('read-only')
    try {
      const argv = ['/bin/bash', '-i']
      await h.ctx.subprocess.spawnTerminal({ argv, cwd: '/ws', env: {}, rows: 1, cols: 1, graceMs: 1 })
      expect(h.subprocess.terminalSpecs[0]!.argv).toBe(argv)
      expect(h.sandbox.calls).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('fails the spawn when the deferred wrapper cannot validate the canonical workspace', async () => {
    const h = await setup('read-only')
    try {
      const ws: ScopeKey = {}
      h.registry.set(ws, 'relative-workspace')
      const { agent } = await h.makeAgent('agent-relative', ws)
      await expect(h.spawn(agent, { type: 'shell' })).rejects.toThrow(/canonicalWorkspace must be an absolute path/)
      expect(h.sandbox.calls).toHaveLength(0)
      expect(h.subprocess.terminalSpecs).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })
})
