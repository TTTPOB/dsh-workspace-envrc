/**
 * Shared test helpers: a recording shell executor (stubs the `ctx.shell`
 * provider while capturing every resolved request and its trace receiver),
 * a mutable fake `workspaceCordis` registry, an always-ok preflight spawn
 * seam, and a recording workspace MCP manager.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
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
