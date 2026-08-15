import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import {
  DEFERRED_ENV_CAPTURE_SCRIPT,
  DEFERRED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_LABEL,
  defaultConfig,
  type WorkspaceEnvrcConfig,
} from '../src/core.js'
import * as Integration from '../src/integration-plugin.js'
import WorkspaceEnvrc from '../src/provider.js'
import { installWorkspaceEnvrcTerminalAdapter } from '../src/terminal-adapter.js'
import { okSpawn, RecordingSandbox, RecordingShellExecutor } from './helpers.js'
import { confinedBackend, terminalHarness, unconfinedBackend, type TerminalHarness } from './terminal-harness.js'

/** The exact deferred wrapper prefix the adapter must hand to the sandbox. */
function deferredPrefix(canonical: string): readonly string[] {
  return [
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
    'direnv',
    canonical,
    MANAGED_ENV_SHIM_LABEL,
  ]
}

/** A sandbox whose confine throws the given failure (propagation test). */
class ThrowingSandbox extends RecordingSandbox {
  constructor(ctx: Context, private readonly failure: unknown) {
    super(ctx)
  }

  override confine(_argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    throw this.failure
  }
}

async function mappedAgent(h: TerminalHarness, root: string): Promise<{ agent: Agent; dispose(): Promise<void> }> {
  const key: ScopeKey = {}
  h.registry.set(key, root)
  return h.scopedAgent(key)
}

async function spawnThrough(
  h: TerminalHarness,
  agent: Agent,
  request: { type: string; cwd?: string } = { type: 'shell' },
  signal?: AbortSignal,
): Promise<void> {
  await h.ctx.terminals.spawn(agent, request, signal)
}

describe('installWorkspaceEnvrcTerminalAdapter', () => {
  it('wraps argv at the sandbox confine seam so direnv stays inside the sandbox, and never double-wraps', async () => {
    const h = await terminalHarness()
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        await spawnThrough(h, agent)
      } finally {
        handle.dispose()
      }
      expect(h.sandbox.calls).toHaveLength(1)
      const confined = h.sandbox.calls[0]!
      // The sandbox input IS the deferred envrc wrapper — the argv commit
      // seam sees the whole chain, so direnv and .envrc evaluation run inside
      // confinement.
      expect(confined.argv.slice(0, deferredPrefix('/workspaces/demo').length)).toEqual(
        deferredPrefix('/workspaces/demo'),
      )
      expect(confined.argv.slice(deferredPrefix('/workspaces/demo').length)).toEqual([
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-i',
      ])
      // The final spawnTerminal argv starts with the sandbox runner and the
      // deferred direnv chain is INSIDE it — exactly once.
      const spec = h.subprocess.terminalSpecs[0]!
      expect(spec.argv).toEqual(['/sandbox', '--', ...confined.argv])
      expect(spec.argv.filter(arg => arg === DEFERRED_ENV_CAPTURE_SCRIPT)).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })

  it('danger-full-access: no confine call; the final argv is the deferred wrapper directly', async () => {
    const h = await terminalHarness({ backend: unconfinedBackend })
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        await spawnThrough(h, agent)
      } finally {
        handle.dispose()
      }
      expect(h.sandbox.calls).toHaveLength(0)
      const spec = h.subprocess.terminalSpecs[0]!
      expect(spec.argv).toEqual([...deferredPrefix('/workspaces/demo'), '/bin/bash', '-i'])
    } finally {
      await h.dispose()
    }
  })

  it('uses the exact owner workspace, never the terminal cwd', async () => {
    const h = await terminalHarness()
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        await spawnThrough(h, agent, { type: 'shell', cwd: '/workspaces/other' })
      } finally {
        handle.dispose()
      }
      const confined = h.sandbox.calls[0]!
      expect(confined.argv).toContain('/workspaces/demo')
      expect(confined.argv).not.toContain('/workspaces/other')
      // The backend-resolved cwd keeps its exact value.
      expect(h.subprocess.terminalSpecs[0]!.cwd).toBe('/workspaces/other')
    } finally {
      await h.dispose()
    }
  })

  it('keeps the final spec env and other fields by exact reference', async () => {
    let capturedEnv: Record<string, string> | undefined
    const backendArgv = ['/bin/bash', '-i']
    const signal = new AbortController().signal
    const h = await terminalHarness({
      backend: ({ ctx }) => {
        const env = { DSH_SESSION_ID: 'sess-1' }
        capturedEnv = env
        return ctx.subprocess.spawnTerminal({
          argv: backendArgv,
          cwd: '/cwd',
          env,
          rows: 5,
          cols: 6,
          graceMs: 7,
          signal,
        })
      },
    })
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        await spawnThrough(h, agent)
      } finally {
        handle.dispose()
      }
      const spec = h.subprocess.terminalSpecs[0]!
      // Only argv changes; every other field keeps its exact reference.
      expect(spec.env).toBe(capturedEnv)
      expect(spec.cwd).toBe('/cwd')
      expect(spec.rows).toBe(5)
      expect(spec.cols).toBe(6)
      expect(spec.graceMs).toBe(7)
      expect(spec.signal).toBe(signal)
      // argv is a fresh array; the original elements survive as its tail.
      expect(spec.argv).not.toBe(backendArgv)
      expect(spec.argv.slice(-backendArgv.length)).toEqual(backendArgv)
    } finally {
      await h.dispose()
    }
  })

  it('delegates unchanged for an unmapped scoped owner', async () => {
    const h = await terminalHarness()
    try {
      const { agent } = h.scopedAgent({})
      const handle = h.install()
      try {
        await spawnThrough(h, agent)
      } finally {
        handle.dispose()
      }
      // The fake spawn still runs its backend; without an operation context
      // neither seam is direnv-wrapped: the sandbox sees the raw shell argv
      // and the final spec argv is only the sandbox's own wrapper.
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
    const h = await terminalHarness({ config: { ...defaultConfig, enableTerminal: false } })
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        await spawnThrough(h, agent)
      } finally {
        handle.dispose()
      }
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

  it('leaves direct subprocess.spawnTerminal outside an explicit spawn unchanged', async () => {
    const h = await terminalHarness()
    try {
      const handle = h.install()
      try {
        const argv = ['/bin/bash', '-i']
        await h.ctx.subprocess.spawnTerminal({ argv, cwd: '/ws', env: {}, rows: 1, cols: 1, graceMs: 1 })
        expect(h.subprocess.terminalSpecs[0]!.argv).toBe(argv)
        expect(h.sandbox.calls).toHaveLength(0)
      } finally {
        handle.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('propagates a backend throw unchanged', async () => {
    const failure = new Error('backend exploded')
    const h = await terminalHarness({
      backend: () => {
        throw failure
      },
    })
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        await expect(spawnThrough(h, agent)).rejects.toBe(failure)
      } finally {
        handle.dispose()
      }
      expect(h.sandbox.calls).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('propagates a throwing sandbox confine unchanged', async () => {
    const failure = new Error('confine exploded')
    const h = await terminalHarness({ sandbox: ctx => new ThrowingSandbox(ctx, failure) })
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        await expect(spawnThrough(h, agent)).rejects.toBe(failure)
      } finally {
        handle.dispose()
      }
      expect(h.subprocess.terminalSpecs).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('propagates a deferred-wrapper validation failure instead of running unwrapped', async () => {
    const h = await terminalHarness()
    try {
      const { agent } = await mappedAgent(h, 'relative-workspace')
      const handle = h.install()
      try {
        await expect(spawnThrough(h, agent)).rejects.toThrow(/canonicalWorkspace must be an absolute path/)
      } finally {
        handle.dispose()
      }
      // Nothing reached the subprocess seam — the spawn failed before any argv.
      expect(h.sandbox.calls).toHaveLength(0)
      expect(h.subprocess.terminalSpecs).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('propagates cancellation unchanged', async () => {
    const abortReason = new Error('spawn cancelled')
    const controller = new AbortController()
    const h = await terminalHarness({
      backend: ({ signal: backendSignal }) => {
        if (backendSignal?.aborted) throw backendSignal.reason
        return undefined
      },
    })
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      try {
        controller.abort(abortReason)
        await expect(spawnThrough(h, agent, { type: 'shell' }, controller.signal)).rejects.toBe(abortReason)
      } finally {
        handle.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('isolates two concurrent terminal creations in different workspaces', async () => {
    const h = await terminalHarness()
    try {
      const keyA: ScopeKey = {}
      h.registry.set(keyA, '/workspaces/a')
      const keyB: ScopeKey = {}
      h.registry.set(keyB, '/workspaces/b')
      const { agent: agentA } = h.scopedAgent(keyA)
      const { agent: agentB } = h.scopedAgent(keyB)
      const handle = h.install()
      try {
        await Promise.all([spawnThrough(h, agentA), spawnThrough(h, agentB)])
      } finally {
        handle.dispose()
      }
      expect(h.sandbox.calls).toHaveLength(2)
      // Each confine input carries exactly its own owner's workspace.
      const aCall = h.sandbox.calls.find(call => call.argv.includes('/workspaces/a'))
      const bCall = h.sandbox.calls.find(call => call.argv.includes('/workspaces/b'))
      expect(aCall).toBeDefined()
      expect(bCall).toBeDefined()
      expect(aCall!.argv).not.toContain('/workspaces/b')
      expect(bCall!.argv).not.toContain('/workspaces/a')
      // Each final spawnTerminal argv resolves to its own owner's workspace.
      const specs = h.subprocess.terminalSpecs
      const aSpec = specs.find(spec => spec.argv.includes('/workspaces/a'))
      const bSpec = specs.find(spec => spec.argv.includes('/workspaces/b'))
      expect(aSpec).toBeDefined()
      expect(bSpec).toBeDefined()
      expect(aSpec).not.toBe(bSpec)
      // Both chains stayed wrapped exactly once.
      expect(specs.flatMap(spec => spec.argv.filter(arg => arg === DEFERRED_ENV_CAPTURE_SCRIPT))).toHaveLength(2)
    } finally {
      await h.dispose()
    }
  })

  it('dispose restores all three descriptors, is idempotent, and never clobbers a successor', async () => {
    const h = await terminalHarness()
    try {
      // Baseline descriptors: the fake terminals' spawn is an OWN method; the
      // sandbox/subprocess methods live on the class prototypes.
      const originalSpawn = h.fakeTerminals.spawn
      expect(Object.prototype.hasOwnProperty.call(h.sandbox, 'confine')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(h.subprocess, 'spawnTerminal')).toBe(false)

      const first = h.install()
      expect(h.fakeTerminals.spawn).not.toBe(originalSpawn)
      expect(Object.prototype.hasOwnProperty.call(h.sandbox, 'confine')).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(h.subprocess, 'spawnTerminal')).toBe(true)

      const second = h.install()
      // Disposing the LATER handle restores the state it found — the FIRST
      // wrapper — so the chain stays wrapped (successor semantics).
      second.dispose()
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      await spawnThrough(h, agent)
      expect(h.sandbox.calls[0]!.argv).toContain('/workspaces/demo')

      // Disposing the EARLIER handle restores the exact previous descriptors.
      first.dispose()
      first.dispose() // second dispose is a no-op
      expect(h.fakeTerminals.spawn).toBe(originalSpawn)
      expect(Object.prototype.hasOwnProperty.call(h.sandbox, 'confine')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(h.subprocess, 'spawnTerminal')).toBe(false)

      // Fully restored: a fresh spawn runs without any direnv wrapping.
      await spawnThrough(h, agent)
      expect(h.sandbox.calls[1]!.argv).toEqual(['/bin/bash', '--noprofile', '--norc', '-i'])
    } finally {
      await h.dispose()
    }
  })

  it('disposing the adapter never kills an in-flight creation; later chains run unwrapped', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const h = await terminalHarness({
      backend: async ({ ctx }) => {
        await gate
        ctx.sandbox.confine(['/bin/bash', '-i'], { mode: 'read-only', workspaceRoot: '/ws-root' })
      },
    })
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const handle = h.install()
      const pending = spawnThrough(h, agent)
      // The adapter unloads while the creation is still unpublished: the
      // in-flight promise is neither killed nor rejected by disposal.
      handle.dispose()
      release()
      await pending
      // The in-flight confine landed after disposal and therefore ran
      // unwrapped — the chain converged to the restored descriptor.
      expect(h.sandbox.calls[0]!.argv).toEqual(['/bin/bash', '-i'])
      // A NEW terminal creation is fully unwrapped (no direnv).
      await spawnThrough(h, agent)
      expect(h.sandbox.calls[1]!.argv).toEqual(['/bin/bash', '-i'])
    } finally {
      await h.dispose()
    }
  })
})

describe('workspace-envrc-integration plugin terminal wiring', () => {
  it('installs the terminal adapter in the effect and reverse-disposes on fiber unload', async () => {
    const h = await terminalHarness()
    try {
      const { agent } = await mappedAgent(h, '/workspaces/demo')
      const originalSpawn = h.fakeTerminals.spawn
      const fiber = await h.ctx.plugin(Integration)
      expect(Object.prototype.hasOwnProperty.call(h.sandbox, 'confine')).toBe(true)
      await spawnThrough(h, agent)
      expect(h.sandbox.calls[0]!.argv).toContain('/workspaces/demo')

      await fiber.dispose()
      expect(Object.prototype.hasOwnProperty.call(h.sandbox, 'confine')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(h.subprocess, 'spawnTerminal')).toBe(false)
      expect(h.fakeTerminals.spawn).toBe(originalSpawn)
      await spawnThrough(h, agent)
      expect(h.sandbox.calls[1]!.argv).toEqual(['/bin/bash', '--noprofile', '--norc', '-i'])
    } finally {
      await h.dispose()
    }
  })

  it('rolls back the Bash adapter when the terminal adapter fails to install', async () => {
    const ctx = new Context()
    const fibers: Fiber[] = []
    try {
      ctx.provide('workspaceCordis', { workspaceForScope: () => undefined })
      ctx.provide('agents', { currentInitiator: () => undefined })
      const fakeTerminals = {
        spawn: () => {
          throw new Error('unused')
        },
      }
      const originalSpawn = fakeTerminals.spawn
      ctx.provide('terminals', fakeTerminals)
      // A sandbox service that exists but offers no confinable method: the
      // integration inject is satisfied, yet the terminal adapter cannot
      // install on it.
      ctx.provide('sandbox', {})
      ctx.provide('subprocess', {
        spawnTerminal: () => {
          throw new Error('unused')
        },
      })
      fibers.push(await ctx.plugin(RecordingShellExecutor))
      const Runtime = class extends WorkspaceEnvrc {
        constructor(applyCtx: Context) {
          super(applyCtx, defaultConfig, { spawn: okSpawn() })
        }
      }
      fibers.push(await ctx.plugin(Runtime, defaultConfig as never))
      const shellRaw = (ctx.shell as unknown as { [symbols.original]?: object })[symbols.original]!
      expect(Object.prototype.hasOwnProperty.call(shellRaw, 'resolve')).toBe(false)

      await expect(ctx.plugin(Integration)).rejects.toThrow(/cannot wrap non-function method confine/)
      // The Bash adapter installed before the failure was rolled back.
      expect(Object.prototype.hasOwnProperty.call(shellRaw, 'resolve')).toBe(false)
      // The terminal adapter's own partial install was rolled back too: the
      // already-installed terminals.spawn wrapper is gone again.
      expect((ctx.get('terminals') as unknown as { spawn(): never }).spawn).toBe(originalSpawn)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })
})
