/**
 * Shared test helpers: a recording shell executor (stubs the `ctx.shell`
 * provider while capturing every resolved request and its trace receiver),
 * a mutable fake `workspaceCordis` registry, an always-ok preflight spawn
 * seam for the workspaceEnvrc activation gate, and the recording sandbox /
 * subprocess fakes the terminal adapter tests use.
 */
import { PassThrough } from 'node:stream'
import { Service, type Context } from '@deepseek-ai/cordis'
import SandboxProvider, { type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  ShellExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellProcessRead,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { PreflightSpawn } from '../src/core.js'

/** One captured `resolve` invocation: the request and the exact receiver. */
export interface RecordedResolve {
  request: ShellExecRequest
  receiver: unknown
}

/**
 * A concrete `ctx.shell` provider that records every resolved request (with
 * the exact receiver the call came in on) and settles canned foreground and
 * background handles. Installed through `ctx.plugin(...)` so `ctx.shell` is
 * a genuine Cordis traceable proxy — the same shape the adapter wraps in
 * production.
 */
export class RecordingShellExecutor extends ShellExecutor {
  readonly records: RecordedResolve[] = []

  resolve(request: ShellExecRequest): ShellExecSpec {
    this.records.push({ request, receiver: this })
    return {
      command: request.command,
      workdir: request.workdir ?? '/default-workdir',
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run(_spec: ShellExecSpec): Promise<ShellRunResult> {
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  start(_spec: ShellExecSpec): ShellProcess {
    return {
      status: 'completed',
      exitCode: 0,
      signal: null,
      done: Promise.resolve(),
      readOutput: (): ShellProcessRead => ({ delta: '', lossy: false }),
      kill: () => false,
    }
  }
}

/**
 * A fake `workspaceCordis` mirroring the real registry's public contract:
 * live workspace scope keys map to canonical roots. The mapping is mutable
 * so one harness instance serves many tests.
 */
export function mutableWorkspaceRegistry(): {
  set(key: ScopeKey, root: string): void
  workspaceForScope(key: ScopeKey): string | undefined
} {
  const roots = new WeakMap<ScopeKey, string>()
  return {
    set: (key, root) => {
      roots.set(key, root)
    },
    workspaceForScope: (key) => roots.get(key),
  }
}

/** A preflight spawn seam whose children always exit 0. */
export function okSpawn(): PreflightSpawn {
  return () => ({ kill: () => {}, done: Promise.resolve({ code: 0, signal: null }) })
}

/**
 * A concrete `ctx.sandbox` provider that records every confined argv/policy
 * pair and wraps each argv as `[marker, '--', ...argv]`, mirroring the real
 * sandbox runners' shape while staying inert (no host confinement). Loaded
 * through `ctx.plugin(...)` so `ctx.sandbox` is a genuine traceable proxy —
 * the same target the terminal adapter wraps in production.
 */
export class RecordingSandbox extends SandboxProvider {
  readonly calls: Array<{ argv: readonly string[]; policy: SandboxPolicy }> = []

  constructor(
    ctx: Context,
    private readonly marker = '/sandbox',
  ) {
    super(ctx)
  }

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.calls.push({ argv, policy })
    return {
      argv: [this.marker, '--', ...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

/** A terminal handle whose output ends on terminate, so backend close settles. */
export function fakeTerminalHandle(pid = 123): SubprocessTerminalHandle {
  const output = new PassThrough()
  return {
    pid,
    output,
    done: Promise.resolve({ exitCode: 0, signal: null }),
    write: async () => {},
    inspectForeground: async () => ({ processGroupId: pid, inputWaiting: true }),
    signalForeground: async () => pid,
    terminate: async () => {
      output.end()
    },
  }
}

/**
 * A concrete `ctx.subprocess` provider that records every terminal spawn
 * spec (with its exact argv and env references) and returns a fake terminal
 * handle instead of allocating a real PTY — no long-lived terminal processes
 * in tests. `spawn` is never used by the terminal path and fails loud.
 */
export class RecordingSubprocessRuntime extends SubprocessRuntime {
  readonly terminalSpecs: SubprocessTerminalSpawnSpec[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  async resolveExecutable(command: string): Promise<string> {
    return command
  }

  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
    throw new Error('unused: RecordingSubprocessRuntime.spawn')
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.terminalSpecs.push(spec)
    return fakeTerminalHandle()
  }
}

/** An inert `terminals` service shape for harnesses that never spawn terminals. */
export function inertTerminals(): { spawn(): never } {
  return { spawn: () => {
    throw new Error('unused: inertTerminals.spawn')
  } }
}

/** An inert `sandbox` service shape for harnesses that never confine. */
export function inertSandbox(): { confine(): never } {
  return { confine: () => {
    throw new Error('unused: inertSandbox.confine')
  } }
}

/** An inert `subprocess` service shape for harnesses that never spawn. */
export function inertSubprocess(): { spawnTerminal(): never } {
  return { spawnTerminal: () => {
    throw new Error('unused: inertSubprocess.spawnTerminal')
  } }
}

/** An inert `workspaceMcp` service shape for harnesses that never activate MCP rows. */
export function inertWorkspaceMcp(): { activate(): never } {
  return { activate: () => {
    throw new Error('unused: inertWorkspaceMcp.activate')
  } }
}

/** One captured `activate` invocation on the recording MCP manager. */
export interface RecordedMcpActivation {
  rowCtx: unknown
  rawConfig: unknown
  /** The exact receiver the call came in on (the traceable service proxy). */
  receiver: unknown
  /** Any future positional arguments after rowCtx/rawConfig. */
  extraArgs: unknown[]
}

/**
 * A concrete `ctx.workspaceMcp` provider that records every `activate` call
 * (with the exact receiver) and settles canned outcomes. Installed through
 * `ctx.plugin(...)` or constructed directly so `ctx.workspaceMcp` is a
 * genuine Cordis traceable proxy — the same shape the adapter wraps in
 * production. The default activation resolves immediately; tests may pin
 * behavior with `throwing` (a synchronous error) or `outcome` (the exact
 * promise the manager returns).
 */
export class RecordingWorkspaceMcp extends Service {
  readonly activations: RecordedMcpActivation[] = []
  /** When set, `activate` throws this error synchronously. */
  throwing: Error | undefined
  /** When set, `activate` returns exactly this promise. */
  outcome: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'workspaceMcp')
  }

  activate(rowCtx: unknown, rawConfig: unknown, ...extraArgs: unknown[]): Promise<void> {
    this.activations.push({ rowCtx, rawConfig, receiver: this, extraArgs })
    if (this.throwing !== undefined) {
      throw this.throwing
    }
    return this.outcome ?? Promise.resolve()
  }
}
