/**
 * Pure workspace-direnv projections and the activation preflight for the
 * `workspaceEnvrc` provider.
 *
 * This module is deliberately framework-free: every builder validates its
 * inputs, never touches `process.env`, never runs through a shell
 * (`shell: true`), and never executes, reads, parses, or hashes any
 * workspace `.envrc` — native direnv owns that world. The provider binds the
 * validated Config values and the execution adapters consume the projections
 * from the service.
 *
 * @module dsh-workspace-envrc/core
 */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  spawn,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
} from 'node:child_process'
import { isAbsolute } from 'node:path'

/** Config of the `workspaceEnvrc` provider, validated strictly per the plan. */
export interface WorkspaceEnvrcConfig {
  /**
   * The direnv executable. A bare PATH command (e.g. `direnv`) or an
   * absolute path; never empty and never containing a NUL byte.
   */
  executable: string
  /**
   * Absolute bash-compatible shell that runs the managed-env restoration
   * shim (the plan defaults `/bin/bash`); never containing a NUL byte.
   */
  shimShell: string
  /** Whether the Bash adapter applies to workspace Bash executions. */
  enableBash: boolean
  /** Whether the persistent-terminal adapter applies. */
  enableTerminal: boolean
  /**
   * Activation preflight deadline in milliseconds: a positive integer no
   * greater than `MAX_TIMER_DELAY_MS`.
   */
  versionCheckTimeoutMs: number
}

/** The plan's config defaults. */
export const defaultConfig: WorkspaceEnvrcConfig = {
  executable: 'direnv',
  shimShell: '/bin/bash',
  enableBash: true,
  enableTerminal: true,
  versionCheckTimeoutMs: 5_000,
}

/**
 * Validate the semantic config invariants the schema cannot express: the
 * executable must be non-empty and NUL-free, the shim shell must be an
 * absolute NUL-free path, and the timeout must be a positive integer within
 * the timer ceiling. Throws a `TypeError` on the first violation.
 */
export function assertWorkspaceEnvrcConfig(config: WorkspaceEnvrcConfig): void {
  assertNonEmpty(config.executable, 'config.executable')
  assertNoNul(config.executable, 'config.executable')
  assertNonEmpty(config.shimShell, 'config.shimShell')
  assertNoNul(config.shimShell, 'config.shimShell')
  if (!isAbsolute(config.shimShell)) {
    throw new TypeError(`workspace-envrc: config.shimShell must be an absolute path: ${config.shimShell}`)
  }
  if (!Number.isInteger(config.versionCheckTimeoutMs) || config.versionCheckTimeoutMs <= 0) {
    throw new TypeError('workspace-envrc: config.versionCheckTimeoutMs must be a positive integer')
  }
  if (config.versionCheckTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `workspace-envrc: config.versionCheckTimeoutMs must not exceed MAX_TIMER_DELAY_MS (${MAX_TIMER_DELAY_MS})`,
    )
  }
}

/** Strict managed-env name: `DSH_` followed by at least one `[A-Z0-9_]` byte. */
export const MANAGED_ENV_NAME = /^DSH_[A-Z0-9_]+$/

/**
 * Stable diagnostic label of the managed-env shim invocation. It is the
 * first post-script argument, consumed by the shim before the name/value
 * pairs, and must not contain a NUL byte.
 */
export const MANAGED_ENV_SHIM_LABEL = 'workspace-envrc-managed-env-shim'

/**
 * POSIX Bash shim restoring DSH ownership after native direnv evaluation.
 *
 * Arguments (after `-c`): `label`, `count`, then `count` name/value pairs,
 * then the original program argv. With `bash -c` semantics the label lands
 * in `$0` and the count in `$1`; the script shifts only the count away, so
 * the first name/value pair starts at `$1`. It deletes every `DSH_*`
 * variable present in the direnv-produced environment, restores exactly the
 * managed snapshot passed through argv (never through ambient variables),
 * and execs the original program. `BASH_ENV` and `ENV` are stripped by the
 * invoking `env` and never restored, so an allowed environment cannot alter
 * this restoration step and the original program does not see those control
 * variables either; every other ordinary variable follows native direnv
 * semantics.
 */
export const MANAGED_ENV_SHIM_SCRIPT = `for name in \${!DSH_@}; do
  unset "$name"
done
label=$0
count=$1
shift
i=0
while [ "$i" -lt "$count" ]; do
  name=$1
  value=$2
  shift 2
  export "$name=$value"
  i=$((i + 1))
done
exec "$@"`

/** Validate and project one managed snapshot into ordered name/value pairs. */
export function managedEnvPairs(
  snapshot: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = []
  for (const [name, value] of Object.entries(snapshot)) {
    if (!MANAGED_ENV_NAME.test(name)) {
      throw new TypeError(`workspace-envrc: managed environment name must match ${MANAGED_ENV_NAME}: ${name}`)
    }
    if (typeof value !== 'string') {
      throw new TypeError(`workspace-envrc: managed environment value for ${name} must be a string`)
    }
    assertNoNul(value, `managed environment value for ${name}`)
    pairs.push([name, value])
  }
  return pairs
}

function assertString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`workspace-envrc: ${what} must be a string`)
  }
}

function assertNonEmpty(value: string, what: string): void {
  if (value.length === 0) {
    throw new TypeError(`workspace-envrc: ${what} must not be empty`)
  }
}

function assertNoNul(value: string, what: string): void {
  if (value.includes('\0')) {
    throw new TypeError(`workspace-envrc: ${what} must not contain a NUL byte`)
  }
}

function assertOriginalArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('workspace-envrc: original argv must be a non-empty array of strings')
  }
  for (const [index, arg] of argv.entries()) {
    assertString(arg, `original argv[${index}]`)
    assertNoNul(arg, `original argv[${index}]`)
  }
}

/** Options for {@link buildManagedEnvShimArgv}. */
export interface ManagedEnvShimOptions {
  /** Absolute bash-compatible shell running the restoration script. */
  shimShell: string
  /** Stable diagnostic label; the first argument after the script. */
  label: string
  /** The exact managed DSH_* snapshot for this execution. */
  snapshot: Readonly<Record<string, string>>
  /** The original program to exec after restoration; must be non-empty. */
  originalArgv: readonly string[]
}

/**
 * Build the managed-env shim argv that runs right after `direnv exec`:
 *
 * ```text
 * env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c SCRIPT
 *   label count name value... original argv
 * ```
 *
 * Values travel through argv, never spliced into the script. Managed names
 * are validated strictly (`DSH_[A-Z0-9_]+`), values must be strings, and
 * every argument must be NUL-free.
 */
export function buildManagedEnvShimArgv(options: ManagedEnvShimOptions): readonly string[] {
  const { shimShell, label, snapshot, originalArgv } = options
  assertNonEmpty(shimShell, 'shimShell')
  assertNoNul(shimShell, 'shimShell')
  if (!isAbsolute(shimShell)) {
    throw new TypeError(`workspace-envrc: shimShell must be an absolute path: ${shimShell}`)
  }
  assertNonEmpty(label, 'label')
  assertNoNul(label, 'label')
  const pairs = managedEnvPairs(snapshot)
  assertOriginalArgv(originalArgv)
  const flat: string[] = []
  for (const [name, value] of pairs) flat.push(name, value)
  return [
    'env',
    '-u',
    'BASH_ENV',
    '-u',
    'ENV',
    shimShell,
    '--noprofile',
    '--norc',
    '-c',
    MANAGED_ENV_SHIM_SCRIPT,
    label,
    String(pairs.length),
    ...flat,
    ...originalArgv,
  ]
}

/**
 * Stable diagnostic label of the deferred capture shim invocation.
 * It is the first argument after the capture script (`$0` in the outer shim)
 * and must not contain a NUL byte.
 */
export const DEFERRED_ENV_SHIM_LABEL = 'workspace-envrc-deferred-env-shim'

/**
 * Deferred managed-env capture shim for persistent terminals.
 *
 * The persistent-terminal backend computes the final managed DSH_* snapshot
 * only inside the `SubprocessTerminalSpawnSpec.env` it builds AFTER the
 * `ctx.sandbox.confine(argv)` commit seam, so the snapshot cannot be known at
 * wrap time. Instead of guessing from `process.env` in the Host (which would
 * be stale and ambient), this outer shim runs as the wrapped argv's program:
 * it enumerates `${!DSH_@}` from ITS OWN process environment — exactly the
 * environment the subprocess provider merged from the final spec — records
 * the exact name/value pairs in a Bash array, and `exec`s
 * `direnv exec <canonical-workspace>` plus the post-direnv restoration shim
 * with the captured pairs as its managed snapshot. Every dynamic input
 * travels through argv (never `process.env`, no temp files, no `.envrc`
 * parsing).
 *
 * Arguments after `-c` (Bash `-c` semantics): `$0` the diagnostic capture
 * label, `$1` the absolute shim shell for the restoration shim, `$2` the
 * direnv executable, `$3` the canonical workspace root, `$4` the diagnostic
 * restoration label, `$5...` the original program argv. `BASH_ENV`/`ENV` were
 * stripped by the invoking `env -u` and are never restored, so an allowed
 * environment cannot alter either shim step and the original program does
 * not see those control variables either.
 */
export const DEFERRED_ENV_CAPTURE_SCRIPT = `label=$0
shim_shell=$1
direnv_executable=$2
workspace=$3
restore_label=$4
shift 4
pairs=()
for name in \${!DSH_@}; do
  pairs+=("\$name" "\${!name}")
done
count=\$(( \${#pairs[@]} / 2 ))
exec "\$direnv_executable" exec "\$workspace" env -u BASH_ENV -u ENV "\$shim_shell" --noprofile --norc -c '${MANAGED_ENV_SHIM_SCRIPT}' "\$restore_label" "\$count" "\${pairs[@]}" "\$@"`

/** Options for {@link buildDeferredManagedExecArgv}. */
export interface DeferredManagedExecOptions {
  /** The direnv executable (bare PATH name or absolute path). */
  executable: string
  /** Canonical workspace root used as the lookup directory. */
  canonicalWorkspace: string
  /** Absolute bash-compatible shell running both shims. */
  shimShell: string
  /** Stable diagnostic label of the deferred capture shim invocation. */
  captureLabel: string
  /** Stable diagnostic label of the post-direnv restoration shim invocation. */
  restoreLabel: string
  /** The original program and arguments; must be non-empty. */
  originalArgv: readonly string[]
}

/**
 * Build the deferred managed-env argv for one terminal execution:
 *
 * ```text
 * env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c CAPTURE_SCRIPT
 *   captureLabel shimShell <executable> <canonical-workspace> restoreLabel <original argv>
 * ```
 *
 * The capture shim runs BEFORE native direnv and therefore before the final
 * `SubprocessTerminalSpawnSpec.env` exists: it captures the exact
 * DSH_* snapshot from the spawned process environment, then execs
 * `<executable> exec <canonical-workspace>` plus the post-direnv restoration
 * shim carrying the captured pairs, so DSH ownership survives any direnv
 * mutation while ordinary variables follow native direnv semantics. All
 * dynamic inputs are validated (non-empty, NUL-free, absolute workspace and
 * shim shell) and travel through argv.
 */
export function buildDeferredManagedExecArgv(options: DeferredManagedExecOptions): readonly string[] {
  const { executable, canonicalWorkspace, shimShell, captureLabel, restoreLabel, originalArgv } = options
  assertNonEmpty(executable, 'executable')
  assertNoNul(executable, 'executable')
  assertNonEmpty(canonicalWorkspace, 'canonicalWorkspace')
  assertNoNul(canonicalWorkspace, 'canonicalWorkspace')
  if (!isAbsolute(canonicalWorkspace)) {
    throw new TypeError(`workspace-envrc: canonicalWorkspace must be an absolute path: ${canonicalWorkspace}`)
  }
  assertNonEmpty(shimShell, 'shimShell')
  assertNoNul(shimShell, 'shimShell')
  if (!isAbsolute(shimShell)) {
    throw new TypeError(`workspace-envrc: shimShell must be an absolute path: ${shimShell}`)
  }
  assertNonEmpty(captureLabel, 'captureLabel')
  assertNoNul(captureLabel, 'captureLabel')
  assertNonEmpty(restoreLabel, 'restoreLabel')
  assertNoNul(restoreLabel, 'restoreLabel')
  assertOriginalArgv(originalArgv)
  return [
    'env',
    '-u',
    'BASH_ENV',
    '-u',
    'ENV',
    shimShell,
    '--noprofile',
    '--norc',
    '-c',
    DEFERRED_ENV_CAPTURE_SCRIPT,
    captureLabel,
    shimShell,
    executable,
    canonicalWorkspace,
    restoreLabel,
    ...originalArgv,
  ]
}

/** Options for {@link buildExecArgv} and {@link wrapCommand}. */
export interface WrapArgvOptions {
  /** The direnv executable (bare PATH name or absolute path). */
  executable: string
  /** Canonical workspace root used as the lookup directory. */
  canonicalWorkspace: string
  /** Absolute bash-compatible shell running the managed-env shim. */
  shimShell: string
  /** Stable diagnostic label of the managed-env shim invocation. */
  shimLabel: string
  /** The exact managed DSH_* snapshot for this execution. */
  managedEnv: Readonly<Record<string, string>>
  /** The original program and arguments; must be non-empty. */
  originalArgv: readonly string[]
}

/**
 * Build the wrapped argv for one owned execution:
 *
 * ```text
 * <executable> exec <canonical-workspace> <managed-env-shim> <original argv>
 * ```
 *
 * The canonical workspace root is fixed as the lookup directory; V1 never
 * selects nested `.envrc` files from a per-command workdir. The original
 * process working directory is unchanged because `direnv exec DIR` loads the
 * environment for `DIR` without chdir-ing the command.
 */
export function buildExecArgv(options: WrapArgvOptions): readonly string[] {
  const { executable, canonicalWorkspace } = options
  assertNonEmpty(executable, 'executable')
  assertNoNul(executable, 'executable')
  assertNonEmpty(canonicalWorkspace, 'canonicalWorkspace')
  assertNoNul(canonicalWorkspace, 'canonicalWorkspace')
  if (!isAbsolute(canonicalWorkspace)) {
    throw new TypeError(`workspace-envrc: canonicalWorkspace must be an absolute path: ${canonicalWorkspace}`)
  }
  return [
    executable,
    'exec',
    canonicalWorkspace,
    ...buildManagedEnvShimArgv({
      shimShell: options.shimShell,
      label: options.shimLabel,
      snapshot: options.managedEnv,
      originalArgv: options.originalArgv,
    }),
  ]
}

/**
 * Quote one value as a POSIX single-quoted shell word: embedded `'` becomes
 * `'\''`, embedded newlines stay literal inside the quotes, and a NUL byte
 * is rejected (no shell argument can carry one).
 */
export function shq(value: string): string {
  assertString(value, 'shell argument')
  assertNoNul(value, 'shell argument')
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Wrap one shell command as a POSIX-safe `exec` of the wrapped argv, whose
 * original program is `<shimShell> -c <originalCommand>`:
 *
 * ```text
 * exec '<executable>' 'exec' '<canonical-workspace>' ... '<originalCommand>'
 * ```
 *
 * Every dynamic argument is single-quoted via {@link shq}. The returned
 * string replaces only `request.command`; the caller's workdir, timeout,
 * signal, sandbox policy, stdin, ordinary env, and managed DSH_* snapshot
 * all survive untouched.
 */
export function wrapCommand(options: Omit<WrapArgvOptions, 'originalArgv'>, originalCommand: string): string {
  assertString(originalCommand, 'originalCommand')
  assertNoNul(originalCommand, 'originalCommand')
  const argv = buildExecArgv({
    ...options,
    originalArgv: [options.shimShell, '-c', originalCommand],
  })
  return `exec ${argv.map(shq).join(' ')}`
}

/** The workspace-root mapping authority the resolution walks against. */
export interface WorkspaceCordisLookup {
  /**
   * The canonical root of a live workspace scope key, or undefined when the
   * key is not (or no longer is) a workspace entry's scope. The registry is
   * the only authority on the workspace-root mapping, so consumers never
   * resolve workspace identity from ambient cwd.
   */
  workspaceForScope(key: ScopeKey): string | undefined
}

/**
 * Resolve the canonical workspace root of an exact live Agent by scope
 * ancestry: start at `scopeOf(agent.ctx)` and walk `scopeParentOf`, asking
 * the registry at every key and returning the first hit. The walk covers an
 * optional workspace-local preset generation between the Agent and the
 * workspace scope. dsh-scope guarantees acyclic chains, and disposed access
 * terminates through the public API (unmapped keys and exhausted chains
 * yield undefined) — there is no session.header.cwd fallback and no
 * cwd-based guessing.
 */
export function resolveAgentWorkspace(
  agent: { readonly ctx: Context },
  workspaceCordis: WorkspaceCordisLookup,
): string | undefined {
  for (let key = scopeOf(agent.ctx); key !== undefined; key = scopeParentOf(key)) {
    const canonical = workspaceCordis.workspaceForScope(key)
    if (canonical !== undefined) return canonical
  }
  return undefined
}

/**
 * V1 supports POSIX platforms only. Throws on Windows so activation fails
 * loud instead of half-wrapping commands that could never run.
 */
export function assertPosixPlatform(platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    throw new Error('workspace-envrc: Windows is not supported in V1')
  }
}

/** Exit facts of one preflight child. */
export interface PreflightExit {
  /** Exit code, or null when the child died from a signal or never started. */
  code: number | null
  /** Terminating signal, or null on a normal exit or a spawn failure. */
  signal: NodeJS.Signals | null
  /** The spawn-level error (e.g. ENOENT), when the process never started. */
  spawnError?: Error
}

/** One bounded preflight child handle. */
export interface PreflightChild {
  /** Terminate the child; safe to call once or after close. */
  kill(): void
  /** Resolves exactly once with the exit facts; never rejects. */
  readonly done: Promise<PreflightExit>
}

/**
 * Injectable child launcher for deterministic activation tests. Production
 * uses node's `child_process` spawn with `stdio: 'ignore'`; the seam keeps
 * the timeout/abort/reap logic in {@link runPreflight} testable without
 * real processes. The `signal` aborts the child (Node kills it for the
 * production spawner; the seam contract is that core also calls `kill()` on
 * abort, so a seam may ignore the signal).
 */
export type PreflightSpawn = (argv: readonly string[], signal: AbortSignal) => PreflightChild

/** A failure of one activation preflight stage, safe to log. */
export class PreflightError extends Error {
  constructor(stage: string, identity: string, reason: string) {
    super(`workspace-envrc: preflight ${stage} for "${identity}" failed: ${reason}`)
    this.name = 'PreflightError'
  }
}

/** Options for {@link runPreflight}. */
export interface PreflightOptions {
  /** Full argv including the executable. */
  argv: readonly string[]
  /** Human-readable stage name for diagnostics (e.g. `direnv version`). */
  stage: string
  /** The configured executable/path this stage checks, for diagnostics. */
  identity: string
  /** Positive deadline in milliseconds; the child is killed when it elapses. */
  timeoutMs: number
  /** Upstream cancellation; the child is killed when it fires. */
  signal?: AbortSignal | undefined
  /** Injectable child launcher; defaults to the production spawner. */
  spawn?: PreflightSpawn | undefined
}

/**
 * Run one bounded activation preflight check and settle with a
 * `PreflightError` on any failure. Only exit facts are observed — the child
 * runs with `stdio: 'ignore'`, so no stdout/stderr, environment, or secret
 * ever reaches the error message, which carries only the stage, the
 * configured executable/path, and the failure reason. The child is killed on
 * timeout and on abort, and `done` is always awaited so every path reaps the
 * process (the promise never rejects, so there is no unhandled rejection).
 */
export async function runPreflight(options: PreflightOptions): Promise<void> {
  const { argv, stage, identity, timeoutMs, signal } = options
  assertOriginalArgv(argv)
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('workspace-envrc: preflight timeout must be a positive integer')
  }
  const child = (options.spawn ?? defaultPreflightSpawn)(argv, signal ?? new AbortController().signal)
  let timedOut = false
  let aborted = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  const onAbort = (): void => {
    aborted = true
    child.kill()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const exit = await child.done
    if (exit.code === 0) return
    if (exit.spawnError !== undefined) {
      throw new PreflightError(stage, identity, `could not be started: ${exit.spawnError.message}`)
    }
    if (timedOut) throw new PreflightError(stage, identity, `timed out after ${timeoutMs} ms`)
    if (aborted) throw new PreflightError(stage, identity, 'aborted')
    if (exit.code !== null) throw new PreflightError(stage, identity, `exited with code ${exit.code}`)
    if (exit.signal !== null) throw new PreflightError(stage, identity, `killed by ${exit.signal}`)
    throw new PreflightError(stage, identity, 'exited unexpectedly')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * The production preflight spawner: node `child_process` spawn with
 * `stdio: 'ignore'`, the caller's abort signal, and a settle-once `done`
 * that resolves on either event — `error` alone covers a spawn failure
 * (e.g. ENOENT) and `close` reports real exits, so `done` never hangs and
 * the mandatory `error` listener prevents an unhandled 'error' crash.
 */
function defaultPreflightSpawn(argv: readonly string[], signal: AbortSignal): PreflightChild {
  const file = argv[0]
  if (file === undefined) {
    throw new TypeError('workspace-envrc: preflight argv must be a non-empty array')
  }
  const options: SpawnOptionsWithStdioTuple<StdioNull, StdioNull, StdioNull> = {
    stdio: ['ignore', 'ignore', 'ignore'],
    signal,
  }
  const child = spawn(file, argv.slice(1), options)
  let settled = false
  const done = new Promise<PreflightExit>((resolve) => {
    const settle = (exit: PreflightExit): void => {
      if (settled) return
      settled = true
      resolve(exit)
    }
    child.once('error', (error) => settle({ code: null, signal: null, spawnError: error }))
    child.once('close', (code, signal) => settle({ code, signal }))
  })
  return { kill: () => child.kill('SIGTERM'), done }
}
