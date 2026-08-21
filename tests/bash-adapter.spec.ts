import { symbols, Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { installWorkspaceEnvrcBashAdapter, type WorkspaceEnvrcBashAdapterHandle } from '../src/bash-adapter.js'
import { defaultConfig, type WorkspaceEnvrcConfig } from '../src/core.js'
import * as Integration from '../src/integration-plugin.js'
import WorkspaceEnvrc from '../src/provider.js'
import {
  inertWorkspaceMcp,
  mutableWorkspaceRegistry,
  okSpawn,
  RecordingShellExecutor,
} from './helpers.js'

/** The fake `agents` service shape the adapter reads. */
interface FakeAgents {
  currentInitiator: () => Agent | undefined
}

interface Harness {
  ctx: Context
  /** The concrete shell provider target (behind the traceable proxy). */
  executor: RecordingShellExecutor
  agents: FakeAgents
  registry: ReturnType<typeof mutableWorkspaceRegistry>
  install(): WorkspaceEnvrcBashAdapterHandle
  /** Mint one scoped agent ctx under `key`, optionally parented under `parent`. */
  scopedAgent(key: ScopeKey, parent?: ScopeKey): { agent: Agent; dispose(): Promise<void> }
  dispose(): Promise<void>
}

/**
 * Boot the real provider (with the ok preflight seam) and a real
 * `RecordingShellExecutor` on one context, with fake `agents`/`workspaceCordis`
 * services. The adapter is installed on demand so tests can observe the
 * unwrapped baseline first.
 */
async function harness(config: WorkspaceEnvrcConfig = defaultConfig): Promise<Harness> {
  const ctx = new Context()
  const agents: FakeAgents = { currentInitiator: () => undefined }
  const registry = mutableWorkspaceRegistry()
  ctx.provide('agents', agents)
  ctx.provide('workspaceCordis', registry)
  // The integration row injects the MCP manager; the Bash tests never
  // activate an MCP row, so an inert service satisfies activation.
  ctx.provide('workspaceMcp', inertWorkspaceMcp())
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(RecordingShellExecutor))
  const RuntimeProvider = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, config, { spawn: okSpawn() })
    }
  }
  fibers.push(await ctx.plugin(RuntimeProvider, config as never))
  const raw = (ctx.shell as unknown as { [symbols.original]?: RecordingShellExecutor })[symbols.original]
  const scopes: Scope[] = []
  return {
    ctx,
    executor: raw!,
    agents,
    registry,
    install: () => installWorkspaceEnvrcBashAdapter(ctx),
    scopedAgent(key, parent) {
      const scope = createScope(ctx, key, parent !== undefined ? { parent } : undefined)
      scopes.push(scope)
      const agent = { ctx: scope.ctx } as unknown as Agent
      return {
        agent,
        dispose: () => scope.dispose(),
      }
    },
    async dispose() {
      for (const scope of scopes.reverse()) await scope.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

/** A request exercising every ShellExecRequest field with distinct identities. */
function fullRequest(command = 'echo hi'): Record<string, unknown> {
  return {
    command,
    workdir: '/workdir/custom',
    timeoutMs: 42_000,
    stdoutMaxBytes: 4096,
    signal: new AbortController().signal,
    stdin: 'stdin-bytes',
    env: { ORDINARY: 'ordinary-value' },
    dshEnv: { DSH_HOME: '/dsh/home', DSH_SESSION_ID: 'sess-1' },
    sandboxPolicy: { mode: 'read-only', workspaceRoot: '/workdir/custom' },
  }
}

function asRequest(value: Record<string, unknown>): Parameters<RecordingShellExecutor['resolve']>[0] {
  return value as unknown as Parameters<RecordingShellExecutor['resolve']>[0]
}

describe('installWorkspaceEnvrcBashAdapter', () => {
  it('wraps only request.command for an initiating agent with a live workspace', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const request = asRequest(fullRequest())
      const handle = h.install()
      try {
        h.ctx.shell.resolve(request)
      } finally {
        handle.dispose()
      }

      expect(h.executor.records).toHaveLength(1)
      const recorded = h.executor.records[0]!.request
      expect(recorded.command).toBe(h.ctx.workspaceEnvrc.wrapCommand('/workspaces/demo', 'echo hi', { DSH_HOME: '/dsh/home', DSH_SESSION_ID: 'sess-1' }))
      expect(recorded.command).not.toBe('echo hi')
      // Every other field keeps its exact reference and value.
      expect(recorded.workdir).toBe('/workdir/custom')
      expect(recorded.timeoutMs).toBe(42_000)
      expect(recorded.stdoutMaxBytes).toBe(4096)
      expect(recorded.signal).toBe(request.signal)
      expect(recorded.stdin).toBe('stdin-bytes')
      expect(recorded.env).toBe(request.env)
      expect(recorded.dshEnv).toBe(request.dshEnv)
      expect(recorded.sandboxPolicy).toBe(request.sandboxPolicy)
    } finally {
      await h.dispose()
    }
  })

  it('never mutates the caller request object', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const request = asRequest(fullRequest())
      const before = { ...request }
      const handle = h.install()
      try {
        h.ctx.shell.resolve(request)
      } finally {
        handle.dispose()
      }
      expect(request.command).toBe('echo hi')
      expect(request).toEqual(before)
      // The recorded command differs from the caller's request only in `command`.
      const recorded = h.executor.records[0]!.request
      const recordedKeys = Object.keys(recorded).sort()
      const requestKeys = Object.keys(request).sort()
      expect(recordedKeys).toEqual(requestKeys)
    } finally {
      await h.dispose()
    }
  })

  it('preserves the exact trace receiver for the original resolver', async () => {
    const h = await harness()
    try {
      // Baseline unwrapped call records the receiver the caller's proxy
      // provided.
      h.ctx.shell.resolve(asRequest({ command: 'baseline' }))
      const baseline = h.executor.records[0]!

      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const handle = h.install()
      try {
        h.ctx.shell.resolve(asRequest({ command: 'wrapped' }))
      } finally {
        handle.dispose()
      }
      const wrapped = h.executor.records[1]!
      // The original resolver must see the traceable shadow, never the raw
      // provider target: both receivers are shadow objects whose `this.ctx`
      // names the CALLER's context lineage (same fiber as the composition
      // context), not the raw instance's plugin fiber. Compared via booleans
      // because vitest's own equality helpers would touch the traceable
      // proxy and trip its inject guard.
      const baselineCtx = baseline.receiver as { ctx: Context }
      const wrappedCtx = wrapped.receiver as { ctx: Context }
      expect(baseline.receiver === h.executor).toBe(false)
      expect(wrapped.receiver === h.executor).toBe(false)
      expect(baselineCtx.ctx.fiber === h.ctx.fiber).toBe(true)
      expect(wrappedCtx.ctx.fiber === h.ctx.fiber).toBe(true)
    } finally {
      await h.dispose()
    }
  })

  it('delegates unchanged without an initiator, even when workdir lies inside a workspace', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')

      // No initiator: the request must pass through untouched although its
      // workdir names the mapped workspace root — no cwd-based guessing.
      const request = asRequest(fullRequest('echo agentless'))
      const handle = h.install()
      try {
        h.ctx.shell.resolve(request)
      } finally {
        handle.dispose()
      }
      expect(h.executor.records).toHaveLength(1)
      expect(h.executor.records[0]!.request.command).toBe('echo agentless')
    } finally {
      await h.dispose()
    }
  })

  it('delegates unchanged for an unmapped scoped agent', async () => {
    const h = await harness()
    try {
      const { agent } = h.scopedAgent({})
      h.agents.currentInitiator = () => agent

      const request = asRequest(fullRequest('echo unmapped'))
      const handle = h.install()
      try {
        h.ctx.shell.resolve(request)
      } finally {
        handle.dispose()
      }
      expect(h.executor.records).toHaveLength(1)
      expect(h.executor.records[0]!.request.command).toBe('echo unmapped')
    } finally {
      await h.dispose()
    }
  })

  it('stays installed but transparent when bash is disabled', async () => {
    const h = await harness({ ...defaultConfig, enableBash: false })
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const request = asRequest(fullRequest('echo disabled'))
      const handle = h.install()
      try {
        h.ctx.shell.resolve(request)
      } finally {
        handle.dispose()
      }
      expect(h.executor.records).toHaveLength(1)
      expect(h.executor.records[0]!.request.command).toBe('echo disabled')
    } finally {
      await h.dispose()
    }
  })

  it('hands the original resolver the wrapped command and the same sandbox policy', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const policy = { mode: 'read-only' as const, workspaceRoot: '/workspaces/demo' }
      const request = asRequest({ ...fullRequest('echo confined'), sandboxPolicy: policy })
      const handle = h.install()
      try {
        h.ctx.shell.resolve(request)
      } finally {
        handle.dispose()
      }
      const recorded = h.executor.records[0]!.request
      // The resolver (which owns confinement) receives the whole wrapped
      // command plus the unchanged policy, so direnv and .envrc evaluation
      // run INSIDE the executor's confine — the outer executor never sees
      // an unwrapped command outside the sandbox.
      expect(recorded.command.startsWith("exec 'direnv' 'exec' '/workspaces/demo'")).toBe(true)
      expect(recorded.sandboxPolicy).toBe(policy)
    } finally {
      await h.dispose()
    }
  })

  it('propagates a throwing currentInitiator instead of swallowing it', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      h.agents.currentInitiator = () => {
        throw new Error('agents service disposed')
      }
      const handle = h.install()
      try {
        expect(() => h.ctx.shell.resolve(asRequest(fullRequest()))).toThrow('agents service disposed')
      } finally {
        handle.dispose()
      }
      expect(h.executor.records).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('dispose is idempotent and restores the previous descriptor', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      // The concrete target has no own `resolve` before install (class method).
      expect(Object.prototype.hasOwnProperty.call(h.executor, 'resolve')).toBe(false)

      const handle = h.install()
      // The installed wrapper is an own method on the concrete target.
      expect(Object.prototype.hasOwnProperty.call(h.executor, 'resolve')).toBe(true)

      h.ctx.shell.resolve(asRequest({ command: 'echo first' }))
      handle.dispose()
      handle.dispose() // second dispose is a no-op
      expect(h.executor.records).toHaveLength(1)
      expect(h.executor.records[0]!.request.command.startsWith("exec 'direnv'")).toBe(true)

      // Descriptor restored: the own wrapper is gone and the next resolve
      // runs the original prototype method unwrapped.
      expect(Object.prototype.hasOwnProperty.call(h.executor, 'resolve')).toBe(false)
      const recordedBefore = h.executor.records.length
      h.ctx.shell.resolve(asRequest({ command: 'echo after-dispose' }))
      expect(h.executor.records[recordedBefore]!.request.command).toBe('echo after-dispose')
    } finally {
      await h.dispose()
    }
  })

  it('double install: an earlier dispose never clobbers a successor; LIFO disposal fully restores', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const first = h.install()
      const second = h.install()

      // Disposing the LATER handle restores the state it found — the FIRST
      // wrapper — so resolution stays wrapped (successor semantics).
      second.dispose()
      h.ctx.shell.resolve(asRequest({ command: 'echo under-first' }))
      expect(h.executor.records[0]!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/demo'")).toBe(true)

      // Disposing the EARLIER handle now restores the original descriptor:
      // the wrapper chain is gone and the resolve runs unwrapped.
      first.dispose()
      expect(Object.prototype.hasOwnProperty.call(h.executor, 'resolve')).toBe(false)
      h.ctx.shell.resolve(asRequest({ command: 'echo restored' }))
      expect(h.executor.records[1]!.request.command).toBe('echo restored')

      // Both handles stay idempotent after full restoration.
      first.dispose()
      second.dispose()
    } finally {
      await h.dispose()
    }
  })

  it('double install: disposing the first leaves the successor active', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const first = h.install()
      const second = h.install()

      // The earlier handle must never remove a later wrapper.
      first.dispose()
      h.ctx.shell.resolve(asRequest({ command: 'echo under-successor' }))
      expect(h.executor.records[0]!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/demo'")).toBe(true)
    } finally {
      await h.dispose()
    }
  })
})

describe('workspace-envrc-integration plugin', () => {
  it('installs the adapter in an effect and reverse-disposes it on fiber unload', async () => {
    const h = await harness()
    try {
      const workspaceKey: ScopeKey = {}
      h.registry.set(workspaceKey, '/workspaces/demo')
      const { agent } = h.scopedAgent(workspaceKey)
      h.agents.currentInitiator = () => agent

      const fiber = await h.ctx.plugin(Integration)
      h.ctx.shell.resolve(asRequest({ command: 'echo wired' }))
      expect(h.executor.records[0]!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/demo'")).toBe(true)

      await fiber.dispose()
      h.ctx.shell.resolve(asRequest({ command: 'echo unwired' }))
      expect(h.executor.records[1]!.request.command).toBe('echo unwired')
    } finally {
      await h.dispose()
    }
  })
})

describe('provider feature getters', () => {
  it('exposes a readonly bashEnabled projection of the config', async () => {
    const h = await harness({ ...defaultConfig, enableBash: false })
    try {
      const service = h.ctx.workspaceEnvrc
      expect(service.bashEnabled).toBe(false)
      const bash = Object.getOwnPropertyDescriptor(WorkspaceEnvrc.prototype, 'bashEnabled')
      expect(bash?.get).toBeTypeOf('function')
      expect(bash?.set).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(service, 'bashEnabled')).toBe(false)
    } finally {
      await h.dispose()
    }
  })

  it('reflects the defaults when the config is untouched', async () => {
    const h = await harness()
    try {
      expect(h.ctx.workspaceEnvrc.bashEnabled).toBe(true)
    } finally {
      await h.dispose()
    }
  })
})
