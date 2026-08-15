/**
 * Workspace MCP adapter tests (plan §11, source + deterministic unit block).
 *
 * The adapter decorates the concrete `ctx.workspaceMcp.activate(rowCtx,
 * rawConfig)` through the real `dsh-workspace-overlay/method-wrapper`; the
 * manager is a recording Service stub, so every classification decision is
 * observable without spawning any MCP process. Coverage:
 *
 * - workspace stdio rows are wrapped with the exact known argv (empty managed
 *   snapshot, since the MCP child env is `{...scrubbedParentEnv(),
 *   ...config.env}` and there is NO Harness managed snapshot);
 * - global rows, streamable-http rows, malformed configs, foreign/preset
 *   scopes, and `enableWorkspaceMcp: false` pass through with the raw config
 *   object identity and bytes untouched, so the manager's own validation
 *   errors survive unchanged;
 * - the caller's raw config object is never mutated; every other field keeps
 *   its exact reference; the exact receiver, returned promise, and thrown
 *   errors pass through untouched;
 * - HMR descriptor restoration, double-install successor safety, and the
 *   complete integration row install/dispose order (real adapters);
 * - one child-process test executes the wrapped argv through a FAKE direnv
 *   (the real-direnv allow/deny state machine belongs to the next test
 *   block): config explicit ordinary env survives, direnv ordinary
 *   override/additions are visible, config/.envrc DSH_* names are all
 *   cleared, and the original exit status propagates.
 *
 * @module tests/mcp-adapter
 */
import { spawn } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_SCRIPT,
  defaultConfig,
  type WorkspaceEnvrcConfig,
} from '../src/core.js'
import {
  installWorkspaceEnvrcMcpAdapter,
  type WorkspaceEnvrcMcpAdapterHandle,
} from '../src/mcp-adapter.js'
import * as Integration from '../src/integration-plugin.js'
import WorkspaceEnvrc from '../src/provider.js'
import {
  RecordingWorkspaceMcp,
  mutableWorkspaceRegistry,
  okSpawn,
} from './helpers.js'
import { terminalHarness } from './terminal-harness.js'

/** The repository root: every temp dir and fake binary lives inside the repo. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Repo-internal gitignored scratch root for the MCP adapter tests. */
const ARTIFACTS_ROOT = join(REPO_ROOT, '.artifacts', 'mcp-adapter')

/** One stdio raw config; the adapter wraps only this legal shape. */
function stdioRawConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: ['hi'],
    env: { ORDINARY: 'value' },
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
    ...extra,
  }
}

/** A streamable-http raw config; never wrapped. */
function httpRawConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'streamable-http',
    serverName: 'srv',
    url: 'http://127.0.0.1:9999/mcp',
    headers: { Authorization: 'token' },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
    ...extra,
  }
}

/**
 * A deterministic MCP adapter harness: a real Cordis context, the real
 * workspaceEnvrc provider (ok preflight seam), the recording workspaceMcp
 * manager, a mutable workspace registry, and scope minting. No shell,
 * terminal, sandbox, or subprocess services exist — the adapter alone never
 * touches them.
 */
interface McpHarness {
  ctx: Context
  registry: ReturnType<typeof mutableWorkspaceRegistry>
  /** The recording manager target (also the wrap target). */
  mcp: RecordingWorkspaceMcp
  /** Install the MCP adapter on demand so tests can observe the baseline. */
  install(): WorkspaceEnvrcMcpAdapterHandle
  /** Mint a scoped row ctx under `key`, optionally parented under `parent`. */
  scoped(key: ScopeKey, parent?: ScopeKey): { ctx: Context; dispose(): Promise<void> }
  dispose(): Promise<void>
}

const liveHarnesses: McpHarness[] = []

afterEach(async () => {
  for (const h of liveHarnesses.splice(0)) {
    await h.dispose()
  }
})

/** Boot the harness with a configurable provider config. */
async function mcpHarness(config: WorkspaceEnvrcConfig = defaultConfig): Promise<McpHarness> {
  const ctx = new Context()
  const registry = mutableWorkspaceRegistry()
  const fibers: Fiber[] = []
  const scopes: Scope[] = []
  ctx.provide('workspaceCordis', registry)
  ctx.provide('agents', { currentInitiator: () => undefined })
  const mcp = new RecordingWorkspaceMcp(ctx)
  const RuntimeProvider = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, config, { spawn: okSpawn() })
    }
  }
  fibers.push(await ctx.plugin(RuntimeProvider, config as never))
  const h: McpHarness = {
    ctx,
    registry,
    mcp,
    install: () => installWorkspaceEnvrcMcpAdapter(ctx),
    scoped(key, parent) {
      const scope = createScope(ctx, key, parent !== undefined ? { parent } : undefined)
      scopes.push(scope)
      return {
        ctx: scope.ctx,
        dispose: () => scope.dispose(),
      }
    },
    async dispose() {
      for (const scope of scopes.reverse()) await scope.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      const index = liveHarnesses.indexOf(h)
      if (index >= 0) liveHarnesses.splice(index, 1)
    },
  }
  liveHarnesses.push(h)
  return h
}

/** The exact wrapped argv the adapter must produce for a legal stdio row. */
function expectedWrappedArgv(
  executable: string,
  canonical: string,
  rawConfig: Record<string, unknown>,
): string[] {
  return [
    executable,
    'exec',
    canonical,
    'env',
    '-u',
    'BASH_ENV',
    '-u',
    'ENV',
    defaultConfig.shimShell,
    '--noprofile',
    '--norc',
    '-c',
    MANAGED_ENV_SHIM_SCRIPT,
    MANAGED_ENV_SHIM_LABEL,
    // The EMPTY managed snapshot: after direnv every DSH_* is deleted and
    // nothing is restored, because the MCP child env is scrubbed-parent-plus-
    // explicit and carries no Harness managed facts.
    '0',
    rawConfig.command as string,
    ...((rawConfig.args as string[] | undefined) ?? []),
  ]
}

describe('workspace MCP adapter classification', () => {
  it('wraps a mapped workspace stdio row with the exact known argv (empty managed snapshot)', async () => {
    const h = await mcpHarness()
    try {
      const canonical = '/workspaces/demo'
      const key: ScopeKey = {}
      h.registry.set(key, canonical)
      const row = h.scoped(key)
      try {
        h.install()
        const rawConfig = stdioRawConfig()
        await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)

        expect(h.mcp.activations).toHaveLength(1)
        const next = h.mcp.activations[0]!.rawConfig as { command: string; args: string[] }
        // A NEW config object: only command/args change.
        expect(next).not.toBe(rawConfig)
        // The wrapped argv is the provider's exact wrapArgv projection with
        // the empty managed snapshot.
        expect([next.command, ...next.args]).toEqual(
          expectedWrappedArgv(defaultConfig.executable, canonical, rawConfig),
        )
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('wraps a programmatic stdio config whose args field is omitted using the manager default []', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const rawConfig = stdioRawConfig()
        delete rawConfig.args
        await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)
        const next = h.mcp.activations[0]!.rawConfig as { command: string; args: string[] }
        expect([next.command, ...next.args]).toEqual(
          expectedWrappedArgv(defaultConfig.executable, '/workspaces/demo', rawConfig),
        )
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('preserves future positional arguments after rowCtx/rawConfig on wrapped calls', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const tail = { future: true }
        await (h.ctx.workspaceMcp.activate as unknown as (...args: unknown[]) => Promise<void>)(
          row.ctx,
          stdioRawConfig(),
          tail,
          42,
        )
        expect(h.mcp.activations[0]!.extraArgs).toEqual([tail, 42])
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('passes a global row through with raw config identity and bytes untouched', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const rawConfig = Object.freeze(stdioRawConfig({ serverName: 'global' }))
      await h.ctx.workspaceMcp.activate(h.ctx, rawConfig)

      expect(h.mcp.activations).toHaveLength(1)
      const recorded = h.mcp.activations[0]!
      // Identity passthrough: the manager sees the exact same object.
      expect(recorded.rawConfig).toBe(rawConfig)
      // Byte passthrough: the frozen object never changed.
      expect(JSON.stringify(recorded.rawConfig)).toBe(JSON.stringify(stdioRawConfig({ serverName: 'global' })))
      expect(recorded.rowCtx).toBe(h.ctx)
    } finally {
      await h.dispose()
    }
  })

  it('passes a streamable-http row through unchanged even under a mapped scope', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const rawConfig = httpRawConfig()
        await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)
        expect(h.mcp.activations[0]!.rawConfig).toBe(rawConfig)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('passes a foreign-scoped row through and preserves the manager error unchanged', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      // A scope that is NOT a workspace entry (preset/foreign placement).
      const row = h.scoped({})
      try {
        const rawConfig = stdioRawConfig()
        const managerError = new Error('workspace-mcp: row activates under a scope that is not a workspace scope')
        h.mcp.throwing = managerError
        // The recording stub throws synchronously, exactly like an unwrapped
        // manager would: the wrapper must propagate the SAME error instance.
        let caught: unknown
        try {
          h.ctx.workspaceMcp.activate(row.ctx, rawConfig)
        } catch (error) {
          caught = error
        }
        // The raw config identity reached the manager untouched...
        expect(h.mcp.activations[0]!.rawConfig).toBe(rawConfig)
        // ...and the manager's own error propagated unchanged.
        expect(caught).toBe(managerError)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('passes malformed stdio configs through so the manager schema produces its original error', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const malformed = [
          { transport: 'stdio' }, // missing command/args
          { transport: 'stdio', command: '' }, // empty command
          { transport: 'stdio', command: 'echo', args: 'not-an-array' },
          { transport: 'stdio', command: 'echo', args: [42] },
          'garbage',
          null,
        ]
        for (const rawConfig of malformed) {
          await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)
          expect(h.mcp.activations.at(-1)!.rawConfig).toBe(rawConfig)
        }
        // The manager's schema rejection (stubbed) also passes through as
        // the exact same error instance.
        const schemaError = new Error('workspace-mcp: config validation failed')
        h.mcp.throwing = schemaError
        let caught: unknown
        try {
          h.ctx.workspaceMcp.activate(row.ctx, { transport: 'stdio' })
        } catch (error) {
          caught = error
        }
        expect(caught).toBe(schemaError)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('stays permanently transparent when enableWorkspaceMcp is false', async () => {
    const h = await mcpHarness({ ...defaultConfig, enableWorkspaceMcp: false })
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const rawConfig = stdioRawConfig()
        await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)
        expect(h.mcp.activations[0]!.rawConfig).toBe(rawConfig)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('requires the row to sit at the exact workspace scope: preset/ancestor rows pass through', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const wsKey: ScopeKey = {}
      h.registry.set(wsKey, '/workspaces/demo')
      // A preset row under the workspace scope: its OWN scope key is unmapped,
      // so it passes through and the manager rejects the placement itself.
      const preset = h.scoped({}, wsKey)
      try {
        const rawConfig = stdioRawConfig({ serverName: 'preset' })
        await h.ctx.workspaceMcp.activate(preset.ctx, rawConfig)
        expect(h.mcp.activations[0]!.rawConfig).toBe(rawConfig)
      } finally {
        await preset.dispose()
      }
      // A row directly under the workspace scope IS the exact workspace row.
      const direct = h.scoped(wsKey)
      try {
        const rawConfig = stdioRawConfig({ serverName: 'direct' })
        await h.ctx.workspaceMcp.activate(direct.ctx, rawConfig)
        const next = h.mcp.activations[1]!.rawConfig as { command: string; args: string[] }
        expect(next).not.toBe(rawConfig)
        expect([next.command, ...next.args]).toEqual(
          expectedWrappedArgv(defaultConfig.executable, '/workspaces/demo', rawConfig),
        )
      } finally {
        await direct.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('delegates when the row context is not a Cordis Context or the raw config is missing', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const rawConfig = stdioRawConfig()
      // Missing args entirely: the manager decides.
      await h.ctx.workspaceMcp.activate(undefined as never, rawConfig)
      await h.ctx.workspaceMcp.activate(42 as never, rawConfig)
      await h.ctx.workspaceMcp.activate({} as never, rawConfig)
      await h.ctx.workspaceMcp.activate(h.ctx, undefined as never)
      expect(h.mcp.activations).toHaveLength(4)
      // The first three calls carried the raw config identity untouched; the
      // fourth passed an explicit undefined raw config, which the manager
      // receives as-is.
      for (const recorded of h.mcp.activations.slice(0, 3)) {
        expect(recorded.rawConfig).toBe(rawConfig)
      }
      expect(h.mcp.activations[3]!.rawConfig).toBeUndefined()
    } finally {
      await h.dispose()
    }
  })

  it('isolates two mapped workspaces with their own canonical roots', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const keyA: ScopeKey = {}
      const keyB: ScopeKey = {}
      h.registry.set(keyA, '/workspaces/a')
      h.registry.set(keyB, '/workspaces/b')
      const rowA = h.scoped(keyA)
      const rowB = h.scoped(keyB)
      try {
        const rawA = stdioRawConfig({ serverName: 'a' })
        const rawB = stdioRawConfig({ serverName: 'b' })
        await h.ctx.workspaceMcp.activate(rowA.ctx, rawA)
        await h.ctx.workspaceMcp.activate(rowB.ctx, rawB)
        const configA = h.mcp.activations[0]!.rawConfig as { command: string; args: string[] }
        const configB = h.mcp.activations[1]!.rawConfig as { command: string; args: string[] }
        expect([configA.command, ...configA.args]).toEqual(
          expectedWrappedArgv(defaultConfig.executable, '/workspaces/a', rawA),
        )
        expect([configB.command, ...configB.args]).toEqual(
          expectedWrappedArgv(defaultConfig.executable, '/workspaces/b', rawB),
        )
      } finally {
        await rowA.dispose()
        await rowB.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('preserves every other field by reference and never mutates the caller config', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const env = { ORDINARY: 'value', DSH_EXPLICIT: 'must-not-forge' }
        const reconnect = { enabled: true, initialDelayMs: 100 }
        const rawConfig = stdioRawConfig({ env, reconnect })
        const before = JSON.stringify(rawConfig)
        await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)

        // The caller object keeps its exact bytes and references.
        expect(JSON.stringify(rawConfig)).toBe(before)
        expect(rawConfig.env).toBe(env)
        const next = h.mcp.activations[0]!.rawConfig as Record<string, unknown>
        expect(next).not.toBe(rawConfig)
        expect(next.env).toBe(env)
        expect(next.reconnect).toBe(reconnect)
        expect(next.cwd).toBe('')
        expect(next.toolCallTimeoutMs).toBe(60_000)
        expect(next.failOnStartupError).toBe(true)
        expect(next.serverName).toBe('srv')
        // Only command/args differ.
        expect(next.command).not.toBe(rawConfig.command)
        expect(next.args).not.toBe(rawConfig.args)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('keeps a DSH_* config env untouched in the config while the child shim carries the empty snapshot', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const env = { DSH_EXPLICIT: 'config-value', ORDINARY: 'config-value' }
        const rawConfig = stdioRawConfig({ env, command: '/bin/bash', args: ['-c', 'true'] })
        await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)

        const next = h.mcp.activations[0]!.rawConfig as {
          env: Record<string, string>
          command: string
          args: string[]
        }
        // The manager still receives the config env with its exact reference
        // (the scrub of ambient DSH_* happens in the transport, not here).
        expect(next.env).toBe(env)
        expect(next.env.DSH_EXPLICIT).toBe('config-value')
        // The shim argv carries the EMPTY managed snapshot: count 0 and no
        // name/value pairs between the label and the original argv.
        const argv = [next.command, ...next.args]
        const labelIndex = argv.indexOf(MANAGED_ENV_SHIM_LABEL)
        expect(labelIndex).toBeGreaterThan(0)
        expect(argv[labelIndex + 1]).toBe('0')
        expect(argv.slice(labelIndex + 2)).toEqual(['/bin/bash', '-c', 'true'])
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })
})

describe('workspace MCP adapter receiver, promise, and error passthrough', () => {
  it('applies with the exact receiver the call came in on', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const service = h.ctx.workspaceMcp
        await service.activate(row.ctx, stdioRawConfig())
        const recorded = h.mcp.activations[0]!.receiver
        // The exact receiver the call came in on: a traceable wrapper of the
        // raw manager target (never the raw instance substituted by the
        // adapter, and never a different receiver).
        expect(recorded === h.mcp).toBe(false)
        expect((recorded as { [symbols.original]?: unknown })[symbols.original] === h.mcp).toBe(true)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('returns the manager promise unchanged and propagates thrown errors as the same instance', async () => {
    const h = await mcpHarness()
    try {
      h.install()
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        // Wrapped path: the exact promise the manager returns.
        const outcome = Promise.resolve()
        h.mcp.outcome = outcome
        expect(h.ctx.workspaceMcp.activate(row.ctx, stdioRawConfig())).toBe(outcome)

        // Passthrough path: the same promise contract.
        const httpOutcome = Promise.resolve()
        h.mcp.outcome = httpOutcome
        expect(h.ctx.workspaceMcp.activate(row.ctx, httpRawConfig())).toBe(httpOutcome)

        // A throwing manager propagates its exact error instance on both paths.
        const boom = new Error('manager exploded')
        h.mcp.throwing = boom
        let caughtWrapped: unknown
        let caughtGlobal: unknown
        try {
          h.ctx.workspaceMcp.activate(row.ctx, stdioRawConfig())
        } catch (error) {
          caughtWrapped = error
        }
        try {
          h.ctx.workspaceMcp.activate(h.ctx, stdioRawConfig())
        } catch (error) {
          caughtGlobal = error
        }
        expect(caughtWrapped).toBe(boom)
        expect(caughtGlobal).toBe(boom)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })
})

describe('workspace MCP adapter lifecycle', () => {
  it('restores the exact previous descriptor on dispose; dispose is idempotent', async () => {
    const h = await mcpHarness()
    try {
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const target = (h.ctx.workspaceMcp as unknown as { [symbols.original]?: RecordingWorkspaceMcp })[
          symbols.original
        ]!
        const original = target.activate

        const handle = h.install()
        expect(target.activate).not.toBe(original)
        handle.dispose()
        expect(target.activate).toBe(original)
        // Idempotent: a second dispose changes nothing.
        handle.dispose()
        expect(target.activate).toBe(original)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('double install nests wrappers with successor safety (HMR)', async () => {
    const h = await mcpHarness()
    try {
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        const target = (h.ctx.workspaceMcp as unknown as { [symbols.original]?: RecordingWorkspaceMcp })[
          symbols.original
        ]!
        const original = target.activate

        const first = h.install()
        const second = h.install()

        // LIFO disposal restores the state the later handle found — the FIRST
        // wrapper — so activation stays wrapped exactly once.
        second.dispose()
        expect(target.activate).not.toBe(original)
        const lifoRaw = stdioRawConfig({ serverName: 'lifo' })
        await h.ctx.workspaceMcp.activate(row.ctx, lifoRaw)
        const lifoNext = h.mcp.activations[0]!.rawConfig as { command: string; args: string[] }
        expect(lifoNext).not.toBe(lifoRaw)
        expect([lifoNext.command, ...lifoNext.args]).toEqual(
          expectedWrappedArgv(defaultConfig.executable, '/workspaces/demo', lifoRaw),
        )

        // Disposing the FIRST handle now restores the original descriptor.
        first.dispose()
        expect(target.activate).toBe(original)

        // Re-install both and dispose the EARLIER handle first: the successor
        // wrapper must survive and still intercept — an earlier dispose never
        // removes a later wrapper. (Full restoration requires LIFO disposal,
        // as asserted above; out-of-order disposal keeps the successor chain
        // alive by design.)
        const firstAgain = h.install()
        const secondAgain = h.install()
        firstAgain.dispose()
        expect(target.activate).not.toBe(original)
        const successorRaw = stdioRawConfig({ serverName: 'successor' })
        await h.ctx.workspaceMcp.activate(row.ctx, successorRaw)
        const successorNext = h.mcp.activations[1]!.rawConfig as { command: string; args: string[] }
        expect(successorNext).not.toBe(successorRaw)
        expect(successorNext.command).toBe('direnv')
        // The successor handle still restores the state it found (the first
        // wrapper) — it never clobbers anything installed above it.
        secondAgain.dispose()
        expect(target.activate).not.toBe(original)
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('fails loud when the workspaceMcp target has no wrapable activate, leaving nothing installed', async () => {
    const h = await mcpHarness()
    try {
      // A broken target: the installer must reject instead of degrading into
      // an unwrapped manager.
      const ctx = new Context()
      ctx.provide('workspaceCordis', h.registry)
      ctx.provide('workspaceMcp', {}) // no activate method
      ctx.provide('workspaceEnvrc', { workspaceMcpEnabled: true, wrapArgv: () => [] })
      expect(() => installWorkspaceEnvrcMcpAdapter(ctx)).toThrow(/cannot wrap non-function method activate/)
    } finally {
      await h.dispose()
    }
  })

  it('complete integration order: the real integration row installs and dispose restores activate', async () => {
    const h = await mcpHarness()
    try {
      const key: ScopeKey = {}
      h.registry.set(key, '/workspaces/demo')
      const row = h.scoped(key)
      try {
        // Nothing installed yet: identity passthrough.
        const plain = stdioRawConfig({ serverName: 'plain' })
        await h.ctx.workspaceMcp.activate(row.ctx, plain)
        expect(h.mcp.activations[0]!.rawConfig).toBe(plain)

        // Mount the REAL integration row through the full harness (it carries
        // every service the row injects, including the recording manager).
        const full = await terminalHarness()
        try {
          full.registry.set(key, '/workspaces/demo')
          const fullRow = full.scopedAgent(key).agent.ctx
          let fiber: Fiber | undefined
          try {
            fiber = await full.ctx.plugin(Integration)
            const rawConfig = stdioRawConfig({ serverName: 'wrapped' })
            await full.ctx.workspaceMcp.activate(fullRow, rawConfig)
            const next = full.mcp.activations.at(-1)!.rawConfig as { command: string; args: string[] }
            expect(next).not.toBe(rawConfig)
            expect([next.command, ...next.args]).toEqual(
              expectedWrappedArgv(defaultConfig.executable, '/workspaces/demo', rawConfig),
            )

            // Disposing the integration fiber restores activate: identity
            // passthrough again, services stay composed.
            await fiber.dispose()
            await full.ctx.workspaceMcp.activate(fullRow, rawConfig)
            expect(full.mcp.activations.at(-1)!.rawConfig).toBe(rawConfig)
          } finally {
            await fiber?.dispose()
          }
        } finally {
          await full.dispose()
        }
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })
})

// ---- Fake direnv child execution (deterministic; the real allow/deny state
// machine is the next test block) ----

interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Spawn one child with an explicit environment and bounded lifetime. */
function runChild(argv: readonly string[], env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** Write a fake direnv binary (simulating an allowed .envrc) and chmod it. */
async function writeFakeDirenv(name: string, body: string): Promise<string> {
  await mkdir(ARTIFACTS_ROOT, { recursive: true })
  const path = join(ARTIFACTS_ROOT, name)
  await writeFile(path, body)
  await chmod(path, 0o755)
  return path
}

/** The probe program observing the MCP child's final environment. */
const MCP_PROBE = [
  'printf "CONFIG_ONLY=%s|OVERRIDE=%s|NEW=%s|EXPLICIT=%s|FORGED=%s|SID=%s\\n"',
  '"$CONFIG_ONLY"',
  '"$ORDINARY_OVERRIDE"',
  '"${DIRENV_ONLY_NEW-unset}"',
  '"${DSH_EXPLICIT-unset}"',
  '"${DSH_FORGED-unset}"',
  '"${DSH_SESSION_ID-unset}"',
].join(' ')

describe('wrapped MCP argv through a fake direnv (deterministic child)', () => {
  it('keeps explicit config ordinary env, shows direnv override/additions, clears every DSH_*, preserves exit status', async () => {
    const fakeDirenv = await writeFakeDirenv(
      'fake-direnv',
      [
        '#!/usr/bin/env bash',
        '# Simulates `direnv exec DIR program...` with an allowed .envrc:',
        '# overrides one ordinary var, adds another, and forges a DSH_* fact.',
        '# `exec env "$@"` (not a bare `exec "$@"`) because bash would parse',
        '# the shim chain leading "-u" as an exec option.',
        'shift 3',
        'export ORDINARY_OVERRIDE=from-direnv',
        'export DIRENV_ONLY_NEW=from-direnv',
        'export DSH_FORGED=forged-by-fake-direnv',
        'exec env "$@"',
        '',
      ].join('\n'),
    )
    const h = await mcpHarness({ ...defaultConfig, executable: fakeDirenv })
    try {
      h.install()
      const canonical = '/workspaces/demo'
      const key: ScopeKey = {}
      h.registry.set(key, canonical)
      const row = h.scoped(key)
      try {
        // The raw config a workspace MCP row would carry: the MCP SDK spawns
        // the child with `{...scrubbedParentEnv(), ...config.env}` — no
        // ambient DSH_* exists, so the explicit env below IS the full child
        // base the transport would hand direnv.
        const rawConfig = stdioRawConfig({
          command: '/bin/bash',
          args: ['-c', MCP_PROBE],
          env: {
            CONFIG_ONLY: 'from-config',
            ORDINARY_OVERRIDE: 'from-config',
            DSH_EXPLICIT: 'config-value',
          },
        })
        await h.ctx.workspaceMcp.activate(row.ctx, rawConfig)
        const next = h.mcp.activations[0]!.rawConfig as { command: string; args: string[] }
        const childEnv: Record<string, string> = {
          PATH: '/usr/bin:/bin',
          HOME: join(ARTIFACTS_ROOT, 'home'),
          XDG_DATA_HOME: join(ARTIFACTS_ROOT, 'data'),
          XDG_CONFIG_HOME: join(ARTIFACTS_ROOT, 'config'),
          XDG_CACHE_HOME: join(ARTIFACTS_ROOT, 'cache'),
          ...(rawConfig.env as Record<string, string>),
        }
        const result = await runChild([next.command, ...next.args], childEnv)
        expect(result.signal).toBeNull()
        expect(result.code).toBe(0)
        // Config explicit ordinary env survives; direnv ordinary override
        // wins; direnv-only additions are visible; config/.envrc DSH_* are
        // ALL cleared (empty managed snapshot restores nothing).
        expect(result.stdout).toContain('CONFIG_ONLY=from-config')
        expect(result.stdout).toContain('OVERRIDE=from-direnv')
        expect(result.stdout).toContain('NEW=from-direnv')
        expect(result.stdout).toContain('EXPLICIT=unset')
        expect(result.stdout).toContain('FORGED=unset')
        expect(result.stdout).toContain('SID=unset')

        // The original program's exit status survives the whole chain.
        const exitRaw = stdioRawConfig({ command: '/bin/bash', args: ['-c', 'exit 7'] })
        await h.ctx.workspaceMcp.activate(row.ctx, exitRaw)
        const exitNext = h.mcp.activations[1]!.rawConfig as { command: string; args: string[] }
        const exitResult = await runChild([exitNext.command, ...exitNext.args], childEnv)
        expect(exitResult.signal).toBeNull()
        expect(exitResult.code).toBe(7)

        // A blocked direnv (never reaches the shim) propagates its own exit
        // status and the original program never runs.
        const blockedDirenv = await writeFakeDirenv(
          'fake-direnv-blocked',
          ['#!/usr/bin/env bash', 'echo "blocked: .envrc not allowed" >&2', 'exit 3', ''].join('\n'),
        )
        const blockedHarness = await mcpHarness({ ...defaultConfig, executable: blockedDirenv })
        try {
          blockedHarness.install()
          blockedHarness.registry.set(key, canonical)
          const blockedRow = blockedHarness.scoped(key)
          try {
            await blockedHarness.ctx.workspaceMcp.activate(blockedRow.ctx, rawConfig)
            const blockedNext = blockedHarness.mcp.activations[0]!.rawConfig as {
              command: string
              args: string[]
            }
            const blocked = await runChild([blockedNext.command, ...blockedNext.args], childEnv)
            expect(blocked.code).toBe(3)
            expect(blocked.stdout).toBe('')
            expect(blocked.stderr).toContain('blocked')
          } finally {
            await blockedRow.dispose()
          }
        } finally {
          await blockedHarness.dispose()
        }
      } finally {
        await row.dispose()
      }
    } finally {
      await h.dispose()
    }
  })
})
