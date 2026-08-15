/**
 * Shared unit harness for the terminal adapter: a real Cordis context, the
 * real workspaceEnvrc provider (ok preflight seam), the recording sandbox and
 * subprocess services, a recording shell provider, a recording
 * `workspaceMcp` service (satisfies the integration row's inject), and a
 * fake `terminals` service whose `spawn` runs a configurable backend
 * closure — the same backend shape the official terminal-bash provider uses
 * (confine the argv, then `spawnTerminal` with the final spec). The fake
 * lets unit tests pin the adapter's wrapper mechanics without real PTYs or
 * the registry.
 */
import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { defaultConfig, type WorkspaceEnvrcConfig } from '../src/core.js'
import WorkspaceEnvrc from '../src/provider.js'
import {
  installWorkspaceEnvrcTerminalAdapter,
  type WorkspaceEnvrcTerminalAdapterHandle,
} from '../src/terminal-adapter.js'
import {
  RecordingSandbox,
  RecordingShellExecutor,
  RecordingSubprocessRuntime,
  RecordingWorkspaceMcp,
  mutableWorkspaceRegistry,
  okSpawn,
} from './helpers.js'

/** Inputs the fake backend receives for one simulated terminal creation. */
export interface BackendInput {
  ctx: Context
  owner: Agent
  request: { type: string; cwd?: string }
  signal: AbortSignal | undefined
}

/** The fake `terminals.spawn` backend body (mirrors terminal-bash's flow). */
export type TerminalBackend = (input: BackendInput) => unknown

/** The official confined flow: `sandbox.confine(argv)` then `spawnTerminal(spec)`. */
export const confinedBackend: TerminalBackend = ({ ctx, request }) => {
  // Like terminal-bash's spawnArgv, the confined argv commit seam hands the
  // sandbox's RETURNED argv to the final spawnTerminal call.
  const confined = ctx.sandbox.confine(['/bin/bash', '--noprofile', '--norc', '-i'], {
    mode: 'read-only',
    workspaceRoot: '/ws-root',
  })
  return ctx.subprocess.spawnTerminal({
    argv: confined.argv,
    cwd: request.cwd ?? '/ws-root',
    env: { DSH_SESSION_ID: 'sess-1', DSH_PTY_SESSION_ID: 'pty-1' },
    rows: 24,
    cols: 80,
    graceMs: 3000,
  })
}

/** The unconfined flow: `spawnTerminal` directly, no confine call. */
export const unconfinedBackend: TerminalBackend = ({ ctx, request }) =>
  ctx.subprocess.spawnTerminal({
    argv: ['/bin/bash', '-i'],
    cwd: request.cwd ?? '/ws-root',
    env: {},
    rows: 24,
    cols: 80,
    graceMs: 3000,
  })

/** One recorded fake `spawn` invocation. */
export interface RecordedSpawn {
  owner: Agent
  request: { type: string; cwd?: string }
  signal: AbortSignal | undefined
}

/** The fake `terminals` service shape the adapter wraps. */
export interface FakeTerminalsService {
  readonly spawns: RecordedSpawn[]
  spawn(
    owner: Agent,
    request: { type: string; cwd?: string },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; type: string; status: { kind: 'running' } }>
}

/** Harness overrides; all optional with faithful defaults. */
export interface TerminalHarnessOptions {
  backend?: TerminalBackend
  config?: WorkspaceEnvrcConfig
  /** Replace the recording sandbox (e.g. a throwing variant). */
  sandbox?: (ctx: Context) => SandboxProvider
}

export interface TerminalHarness {
  ctx: Context
  registry: ReturnType<typeof mutableWorkspaceRegistry>
  /** The raw sandbox target (also the wrapped target); recording by default. */
  sandbox: SandboxProvider & { readonly calls: Array<{ argv: readonly string[]; policy: SandboxPolicy }> }
  /** The raw recording subprocess runtime target (also the wrapped target). */
  subprocess: RecordingSubprocessRuntime
  /** The raw recording shell executor (the Bash adapter's target). */
  shell: RecordingShellExecutor
  fakeTerminals: FakeTerminalsService
  /** The recording workspaceMcp target (the MCP adapter's wrap target). */
  mcp: RecordingWorkspaceMcp
  /** Install the terminal adapter on demand so tests can observe the baseline. */
  install(): WorkspaceEnvrcTerminalAdapterHandle
  /** Mint one scoped agent ctx under `key`, optionally parented under `parent`. */
  scopedAgent(key: ScopeKey, parent?: ScopeKey): { agent: Agent; dispose(): Promise<void> }
  dispose(): Promise<void>
}

/** Boot the real provider (ok preflight seam) plus all recording services. */
export async function terminalHarness(options: TerminalHarnessOptions = {}): Promise<TerminalHarness> {
  const { config = defaultConfig, backend = confinedBackend } = options
  const ctx = new Context()
  const registry = mutableWorkspaceRegistry()
  ctx.provide('workspaceCordis', registry)
  ctx.provide('agents', { currentInitiator: () => undefined })
  const fibers: Fiber[] = []
  const scopes: Scope[] = []
  fibers.push(await ctx.plugin(RecordingShellExecutor))
  // Constructed directly like the sandbox/subprocess fakes: the Service
  // constructor registers `workspaceMcp` in this context.
  const mcp = new RecordingWorkspaceMcp(ctx)
  const sandbox = options.sandbox === undefined ? new RecordingSandbox(ctx) : options.sandbox(ctx)
  const subprocess = new RecordingSubprocessRuntime(ctx)
  const fakeTerminals: FakeTerminalsService = {
    spawns: [],
    async spawn(owner, request, signal) {
      this.spawns.push({ owner, request, signal })
      await backend({ ctx, owner, request, signal })
      return { sessionId: 'pty-fake', type: request.type, status: { kind: 'running' } }
    },
  }
  ctx.provide('terminals', fakeTerminals)
  const RuntimeProvider = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, config, { spawn: okSpawn() })
    }
  }
  fibers.push(await ctx.plugin(RuntimeProvider, config as never))
  return {
    ctx,
    registry,
    sandbox: sandbox as TerminalHarness['sandbox'],
    subprocess,
    shell: (ctx.shell as unknown as { [symbols.original]?: RecordingShellExecutor })[symbols.original]!,
    fakeTerminals,
    mcp,
    install: () => installWorkspaceEnvrcTerminalAdapter(ctx),
    scopedAgent(key, parent) {
      const scope = createScope(ctx, key, parent !== undefined ? { parent } : undefined)
      scopes.push(scope)
      const agent = { id: 'agent', session: { id: 'agent' }, ctx: scope.ctx } as unknown as Agent
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
