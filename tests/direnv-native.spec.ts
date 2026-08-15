/**
 * REAL native direnv state machine tests (Block D).
 *
 * These tests execute the actual `/usr/bin/direnv` (v2.32.1 on the dev
 * machine) through the REAL `workspaceEnvrc` provider projections
 * (`wrapCommand` / `buildDeferredManagedExecArgv`) as real child processes.
 * Nothing is mocked:
 *
 * - the provider activates through the real class-plugin path with the real
 *   preflight spawner, only the child ENVIRONMENT is made explicit;
 * - every `direnv allow` / `deny` / `exec` child runs with repo-internal
 *   isolated `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` and
 *   `HOME`, so the user's real direnv authorization state is never read,
 *   compared, or written (the `~/.local/share/direnv` directory is never
 *   accessed at all);
 * - every child is bounded by a timeout, killed on expiry, and awaited
 *   through `close` (reaped); `process.env` is never modified.
 *
 * Error-semantics assertions deliberately avoid pinning ANSI or exact
 * wording: blocked/denied executions must exit nonzero with the original
 * program not running, stderr may carry the direnv path but must never leak
 * `.envrc`-exported canary values, and the tests never snapshot full stderr
 * into logs.
 *
 * @module tests/direnv-native
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFERRED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_LABEL,
  buildDeferredManagedExecArgv,
  defaultConfig,
  type PreflightExit,
  type PreflightSpawn,
  type WorkspaceEnvrcConfig,
} from '../src/core.js'
import WorkspaceEnvrc from '../src/provider.js'

/** The repository root: every temp dir below lives inside the repo. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Repo-internal gitignored scratch root for all native-direnv state. */
const ARTIFACTS_ROOT = join(REPO_ROOT, '.artifacts', 'direnv-native')

/** One settled child, bounded and reaped. */
interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** Whether the bounded timeout fired and the child was killed. */
  timedOut: boolean
  stdout: string
  stderr: string
}

/**
 * Spawn one child with an EXPLICIT environment and bounded lifetime.
 *
 * stdout/stderr are byte-capped, the child is SIGKILLed when `timeoutMs`
 * elapses, and the promise settles only on `close` — so every child is
 * reaped and no handle outlives the call.
 */
function runChild(
  argv: readonly string[],
  options: { cwd?: string; env: Record<string, string>; timeoutMs?: number },
): Promise<ChildResult> {
  const { cwd, env, timeoutMs = 15_000 } = options
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (current: string, chunk: Buffer): string =>
      current.length >= 256 * 1024 ? current : current + chunk.toString('utf8')
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, stdout, stderr })
    })
  })
}

/**
 * Detect the native direnv binary: `direnv version` must succeed, and the
 * resolved absolute path is returned. `undefined` skips the whole suite
 * (describe.skipIf) on machines without direnv; on this development machine
 * the suite MUST run.
 */
function detectDirenv(): string | undefined {
  try {
    execFileSync('direnv', ['version'], { stdio: 'ignore' })
  } catch {
    return undefined
  }
  try {
    const resolved = execFileSync('bash', ['-c', 'command -v direnv'], { encoding: 'utf8' }).trim()
    if (resolved.length > 0) return resolved
  } catch {
    // fall through to the fixed system path
  }
  return existsSync('/usr/bin/direnv') ? '/usr/bin/direnv' : undefined
}

const direnvPath = detectDirenv()
const nativeDescribe = describe.skipIf(direnvPath === undefined)

/**
 * One isolated native-direnv test harness: a repo-internal temp root holding
 * the XDG trio, the home, and every workspace; the real provider activated
 * over the detected direnv; and an env builder that never falls back to
 * `process.env`.
 */
interface NativeHarness {
  root: string
  direnv: string
  provider: WorkspaceEnvrc
  env(extra?: Record<string, string>): Record<string, string>
  cleanup(): Promise<void>
}

/** All live harness roots; afterEach sweeps any the test forgot to clean. */
const liveRoots: string[] = []

afterEach(async () => {
  for (const root of liveRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A preflight child launcher that spawns with the SAME isolated environment
 * as every other child in this suite. The production default spawner would
 * inherit `process.env`; this seam keeps the activation children (the real
 * `direnv version` and shim-shell checks) inside the isolation boundary too.
 */
function isolatedPreflightSpawn(root: string): PreflightSpawn {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'home'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
  }
  return (argv, signal) => {
    const file = argv[0]!
    const child = spawn(file, argv.slice(1), { stdio: ['ignore', 'ignore', 'ignore'], signal, env })
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
}

async function makeHarness(): Promise<NativeHarness> {
  await mkdir(ARTIFACTS_ROOT, { recursive: true })
  const root = await mkdtemp(join(ARTIFACTS_ROOT, 'case-'))
  liveRoots.push(root)
  for (const sub of ['data', 'config', 'cache', 'home']) {
    await mkdir(join(root, sub))
  }
  const direnv = direnvPath!
  const config: WorkspaceEnvrcConfig = { ...defaultConfig, executable: direnv }
  const ctx = new Context()
  // The provider row injects these; the projections under test never read
  // them (wrapCommand/wrapDeferredArgv need no Agent/workspace mapping).
  ctx.provide('agents', {})
  ctx.provide('workspaceCordis', {})
  const RuntimeProvider = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, config, { spawn: isolatedPreflightSpawn(root) })
    }
  }
  const fiber = await ctx.plugin(RuntimeProvider, config as never)
  return {
    root,
    direnv,
    provider: ctx.workspaceEnvrc,
    env: (extra = {}) => ({
      PATH: '/usr/bin:/bin',
      HOME: join(root, 'home'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      // Non-TTY direnv would suppress logs anyway; keep stderr clean so the
      // secret-leak assertions only ever see real direnv errors.
      DIRENV_LOG_FORMAT: '',
      ...extra,
    }),
    cleanup: async () => {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
      const index = liveRoots.indexOf(root)
      if (index >= 0) liveRoots.splice(index, 1)
    },
  }
}

/** Write one workspace `.envrc` file. */
async function writeEnvrc(h: NativeHarness, path: string, content: string): Promise<void> {
  await writeFile(path, `${content}\n`)
}

/** Run one native direnv CLI child (allow/deny/...) with the isolated env. */
function runDirenv(
  h: NativeHarness,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<ChildResult> {
  return runChild([h.direnv, ...args], { cwd: options.cwd, env: options.env ?? h.env() })
}

/** Run one wrapped command as a real bash child under the isolated env. */
function runBash(
  h: NativeHarness,
  wrappedCommand: string,
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<ChildResult> {
  return runChild(['/bin/bash', '-c', wrappedCommand], { cwd: options.cwd, env: options.env ?? h.env() })
}

/**
 * Probe command observing ordinary vars, credential-shaped vars, managed
 * DSH_* restoration, direnv-forged DSH_* clearing, BASH_ENV/ENV stripping,
 * and the child PWD.
 */
const PROBE_COMMAND = [
  'printf "GREETING=%s\\nFAKE_API_KEY=%s\\nSID=%s\\nHOME=%s\\nFORGED=%s\\nDIRTY=%s\\nBASHENV=%s\\nPWD=%s\\n"',
  '"$GREETING"',
  '"$FAKE_API_KEY"',
  '"${DSH_SESSION_ID-}"',
  '"${DSH_HOME-}"',
  '"${DSH_FORGED-unset}"',
  '"${DSH_DIRTY-unset}"',
  '"${BASH_ENV-unset}"',
  '"$PWD"',
].join(' ')

/** The native direnv allow directory under this harness's isolated XDG_DATA_HOME. */
function allowDir(h: NativeHarness): string {
  return join(h.root, 'data', 'direnv', 'allow')
}

/** Names of the allow files native direnv wrote under the isolated XDG state. */
async function allowFiles(h: NativeHarness): Promise<string[]> {
  return readdir(allowDir(h))
}

nativeDescribe('real direnv native state machine (isolated repo-internal XDG)', () => {
  it('unallowed .envrc blocks; direnv allow runs it; content change re-blocks; re-allow serves the new value; deny blocks', async () => {
    const h = await makeHarness()
    try {
      const ws = join(h.root, 'ws')
      await mkdir(ws)
      const envrc = join(ws, '.envrc')
      const canary = 'canary-value-9f3a'
      await writeEnvrc(h, envrc, [
        'export GREETING=hello',
        `export FAKE_API_KEY=${canary}`,
        'export DSH_FORGED=forged-value',
      ].join('\n'))
      const snapshot = { DSH_SESSION_ID: 'sess-native-1', DSH_HOME: '/restored-home' }
      const command = h.provider.wrapCommand(ws, PROBE_COMMAND, snapshot)

      // 1. Never allowed: native direnv refuses; the original program never
      // runs (no stdout) and the refusal carries the direnv path but no
      // .envrc-exported value.
      const blocked = await runBash(h, command)
      expect(blocked.timedOut).toBe(false)
      expect(blocked.code).not.toBe(0)
      expect(blocked.stdout).toBe('')
      // v2.32.1 refuses by naming the blocked .envrc; the exact wording and
      // any ANSI are deliberately not pinned, and the refusal never carries
      // an .envrc-exported value.
      expect(blocked.stderr).toContain('.envrc')
      expect(blocked.stderr).toMatch(/blocked|denied/i)
      expect(blocked.stderr).not.toContain(canary)

      // 2. `direnv allow <exact .envrc>`: the authorization lands ONLY under
      // the repo-internal XDG_DATA_HOME (never the user's real state).
      const allowed = await runDirenv(h, ['allow', envrc])
      expect(allowed.timedOut).toBe(false)
      expect(allowed.code).toBe(0)
      const files = await allowFiles(h)
      expect(files).toHaveLength(1)
      const allowEntry = await readFile(join(allowDir(h), files[0]!), 'utf8')
      expect(allowEntry).toContain(envrc)

      // 3. The wrapped bash now runs: ordinary and credential-shaped
      // .envrc exports are visible, the managed DSH_* snapshot is restored,
      // the direnv-forged DSH_* fact is cleared, and BASH_ENV/ENV never
      // reach the original program.
      const ok = await runBash(h, command)
      expect(ok.timedOut).toBe(false)
      expect(ok.code).toBe(0)
      expect(ok.stdout).toContain('GREETING=hello')
      expect(ok.stdout).toContain(`FAKE_API_KEY=${canary}`)
      expect(ok.stdout).toContain('SID=sess-native-1')
      expect(ok.stdout).toContain('HOME=/restored-home')
      expect(ok.stdout).toContain('FORGED=unset')
      expect(ok.stdout).toContain('DIRTY=unset')
      expect(ok.stdout).toContain('BASHENV=unset')

      // 4. Editing the allowed .envrc invalidates the native hash: blocked
      // again, original program still never runs.
      await writeEnvrc(h, envrc, [
        'export GREETING=world',
        `export FAKE_API_KEY=${canary}`,
        'export DSH_FORGED=forged-value',
      ].join('\n'))
      const changed = await runBash(h, command)
      expect(changed.timedOut).toBe(false)
      expect(changed.code).not.toBe(0)
      expect(changed.stdout).toBe('')
      expect(changed.stderr).toMatch(/blocked|denied/i)
      expect(changed.stderr).not.toContain(canary)

      // 5. Re-allow serves the NEW content.
      const reallowedCli = await runDirenv(h, ['allow', envrc])
      expect(reallowedCli.code).toBe(0)
      const reallowed = await runBash(h, command)
      expect(reallowed.code).toBe(0)
      expect(reallowed.stdout).toContain('GREETING=world')

      // 6. `direnv deny <exact .envrc>` blocks again.
      const deniedCli = await runDirenv(h, ['deny', envrc])
      expect(deniedCli.code).toBe(0)
      const afterDeny = await runBash(h, command)
      expect(afterDeny.timedOut).toBe(false)
      expect(afterDeny.code).not.toBe(0)
      expect(afterDeny.stdout).toBe('')
      expect(afterDeny.stderr).toMatch(/blocked|denied/i)
      expect(afterDeny.stderr).not.toContain(canary)
    } finally {
      await h.cleanup()
    }
  })

  it('loads the canonical workspace root .envrc while the child PWD stays the calling cwd; nested .envrc is never selected', async () => {
    const h = await makeHarness()
    try {
      const ws = join(h.root, 'ws')
      const sub = join(ws, 'sub')
      const otherCwd = join(h.root, 'other-cwd')
      await mkdir(sub, { recursive: true })
      await mkdir(otherCwd)
      await writeEnvrc(h, join(ws, '.envrc'), 'export ROOT_MARKER=from-root')
      // A NESTED .envrc exists but is never allowed: if the wrapper selected
      // it, the run would be blocked; success proves the V1 fixed-root
      // lookup never consults per-command workdirs.
      await writeEnvrc(h, join(sub, '.envrc'), 'export NESTED_MARKER=from-nested')
      const allowed = await runDirenv(h, ['allow', join(ws, '.envrc')])
      expect(allowed.code).toBe(0)
      expect(await allowFiles(h)).toHaveLength(1)

      const command = h.provider.wrapCommand(
        ws,
        'printf "ROOT=%s|NESTED=%s|PWD=%s\\n" "$ROOT_MARKER" "${NESTED_MARKER-unset}" "$PWD"',
      )
      const fromSub = await runBash(h, command, { cwd: sub })
      expect(fromSub.timedOut).toBe(false)
      expect(fromSub.code).toBe(0)
      expect(fromSub.stdout).toContain('ROOT=from-root')
      expect(fromSub.stdout).toContain('NESTED=unset')
      expect(fromSub.stdout).toContain(`PWD=${sub}`)

      // A cwd completely outside the workspace behaves identically: the
      // canonical root still drives the environment, the child PWD stays
      // where the caller put it.
      const fromOther = await runBash(h, command, { cwd: otherCwd })
      expect(fromOther.code).toBe(0)
      expect(fromOther.stdout).toContain('ROOT=from-root')
      expect(fromOther.stdout).toContain(`PWD=${otherCwd}`)
    } finally {
      await h.cleanup()
    }
  })

  it('isolates two concurrent workspaces; denying one leaves the other intact', async () => {
    const h = await makeHarness()
    try {
      const wsA = join(h.root, 'ws-a')
      const wsB = join(h.root, 'ws-b')
      await mkdir(wsA)
      await mkdir(wsB)
      const canaryA = 'canary-alpha-77'
      const canaryB = 'canary-beta-88'
      await writeEnvrc(h, join(wsA, '.envrc'), `export WS_TAG=alpha\nexport FAKE_API_KEY=${canaryA}`)
      await writeEnvrc(h, join(wsB, '.envrc'), `export WS_TAG=beta\nexport FAKE_API_KEY=${canaryB}`)
      expect((await runDirenv(h, ['allow', join(wsA, '.envrc')])).code).toBe(0)
      expect((await runDirenv(h, ['allow', join(wsB, '.envrc')])).code).toBe(0)
      expect(await allowFiles(h)).toHaveLength(2)

      const cmdA = h.provider.wrapCommand(wsA, 'printf "TAG=%s|KEY=%s\\n" "$WS_TAG" "$FAKE_API_KEY"')
      const cmdB = h.provider.wrapCommand(wsB, 'printf "TAG=%s|KEY=%s\\n" "$WS_TAG" "$FAKE_API_KEY"')
      const [resultA, resultB] = await Promise.all([runBash(h, cmdA), runBash(h, cmdB)])
      expect(resultA.timedOut).toBe(false)
      expect(resultB.timedOut).toBe(false)
      expect(resultA.code).toBe(0)
      expect(resultA.stdout).toContain('TAG=alpha')
      expect(resultA.stdout).toContain(canaryA)
      expect(resultA.stdout).not.toContain(canaryB)
      expect(resultB.code).toBe(0)
      expect(resultB.stdout).toContain('TAG=beta')
      expect(resultB.stdout).toContain(canaryB)
      expect(resultB.stdout).not.toContain(canaryA)

      // Denying A must not disturb B's authorization or value.
      expect((await runDirenv(h, ['deny', join(wsA, '.envrc')])).code).toBe(0)
      const [deniedA, stillB] = await Promise.all([runBash(h, cmdA), runBash(h, cmdB)])
      expect(deniedA.timedOut).toBe(false)
      expect(deniedA.code).not.toBe(0)
      expect(deniedA.stdout).toBe('')
      expect(deniedA.stderr).toMatch(/blocked|denied/i)
      expect(deniedA.stderr).not.toContain(canaryA)
      expect(stillB.code).toBe(0)
      expect(stillB.stdout).toContain('TAG=beta')
      expect(stillB.stdout).toContain(canaryB)
    } finally {
      await h.cleanup()
    }
  })

  it('real terminal deferred wrapper: managed DSH facts preserved, forged DSH cleared, ordinary vars visible; content change blocks', async () => {
    const h = await makeHarness()
    try {
      const ws = join(h.root, 'ws')
      await mkdir(ws)
      const envrc = join(ws, '.envrc')
      const canary = 'cred-canary-5f'
      await writeEnvrc(h, envrc, [
        'export TERM_MARKER=deferred-ok',
        `export FAKE_CRED=${canary}`,
        'export DSH_FORGED=forged-value',
      ].join('\n'))
      expect((await runDirenv(h, ['allow', envrc])).code).toBe(0)

      // The exact argv the terminal adapter would commit (Block C deferred
      // chain), with the final spec-style environment a subprocess provider
      // would merge: managed DSH facts, an ambient DSH_DIRTY, forged
      // BASH_ENV/ENV, and the ordinary vars.
      const argv = buildDeferredManagedExecArgv({
        executable: h.direnv,
        canonicalWorkspace: ws,
        shimShell: '/bin/bash',
        captureLabel: DEFERRED_ENV_SHIM_LABEL,
        restoreLabel: MANAGED_ENV_SHIM_LABEL,
        originalArgv: [
          '/bin/bash',
          '-c',
          [
            'printf "SID=%s|PTY=%s|SHELL=%s|FORGED=%s|DIRTY=%s|MARKER=%s|CRED=%s|BASHENV=%s\\n"',
            '"${DSH_SESSION_ID-}"',
            '"${DSH_PTY_SESSION_ID-}"',
            '"${DSH_SHELL-}"',
            '"${DSH_FORGED-unset}"',
            '"${DSH_DIRTY-unset}"',
            '"$TERM_MARKER"',
            '"$FAKE_CRED"',
            '"${BASH_ENV-unset}"',
          ].join(' '),
        ],
      })
      const env = h.env({
        DSH_SESSION_ID: 'sess-deferred-7',
        DSH_PTY_SESSION_ID: 'pty-deferred-7',
        DSH_SHELL: '1',
        // A managed DSH_* fact the final spec env carries beyond the backend
        // trio: the deferred capture treats everything in the spawned env as
        // the snapshot, so it survives direnv exactly like the trio.
        DSH_DIRTY: 'ambient-dirty',
        BASH_ENV: '/nonexistent-evil-bashenv-xyz',
        ENV: '/nonexistent-evil-env-xyz',
      })
      const ok = await runChild([...argv], { env })
      expect(ok.timedOut).toBe(false)
      expect(ok.code).toBe(0)
      expect(ok.stdout).toContain('SID=sess-deferred-7')
      expect(ok.stdout).toContain('PTY=pty-deferred-7')
      expect(ok.stdout).toContain('SHELL=1')
      // direnv-forged DSH_* facts are cleared; captured facts are restored.
      expect(ok.stdout).toContain('FORGED=unset')
      expect(ok.stdout).toContain('DIRTY=ambient-dirty')
      expect(ok.stdout).toContain('MARKER=deferred-ok')
      expect(ok.stdout).toContain(`CRED=${canary}`)
      expect(ok.stdout).toContain('BASHENV=unset')
      // A leaked BASH_ENV would make bash try to source the evil file.
      expect(ok.stderr).not.toContain('evil')

      // Content change invalidates the native hash for the deferred chain
      // too: blocked with the original program never running.
      await writeEnvrc(h, envrc, [
        'export TERM_MARKER=changed',
        `export FAKE_CRED=${canary}`,
      ].join('\n'))
      const blocked = await runChild([...argv], { env })
      expect(blocked.timedOut).toBe(false)
      expect(blocked.code).not.toBe(0)
      expect(blocked.stdout).toBe('')
      expect(blocked.stderr).toMatch(/blocked|denied/i)
      expect(blocked.stderr).not.toContain(canary)
    } finally {
      await h.cleanup()
    }
  })

  it('activation preflight failures carry only stage and identity, never environment or secret values', async () => {
    const h = await makeHarness()
    try {
      const config: WorkspaceEnvrcConfig = { ...defaultConfig, executable: '/nonexistent/direnv-nowhere' }
      const ctx = new Context()
      ctx.provide('agents', {})
      ctx.provide('workspaceCordis', {})
      const RuntimeProvider = class extends WorkspaceEnvrc {
        constructor(applyCtx: Context) {
          super(applyCtx, config, { spawn: isolatedPreflightSpawn(h.root) })
        }
      }
      const failure = await ctx.plugin(RuntimeProvider, config as never).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeDefined()
      const message = String(failure)
      expect(message).toMatch(/preflight direnv version/)
      expect(message).toContain('/nonexistent/direnv-nowhere')
      // The plugin never reads .envrc or child output: its diagnostics must
      // stay limited to the stage and the configured identity.
      expect(message).not.toContain('canary')
      expect(message).not.toContain('XDG_DATA_HOME')
      await ctx.fiber.dispose()
    } finally {
      await h.cleanup()
    }
  })

  it('activation runs the REAL direnv version and shim-shell preflight children', async () => {
    const h = await makeHarness()
    try {
      // makeHarness already activated the provider through the real
      // preflight (real `direnv version` + real shim-shell child under the
      // isolated env); reaching this point proves both children exited 0.
      expect(h.provider.bashEnabled).toBe(true)
      expect(h.provider.terminalEnabled).toBe(true)
      expect(h.provider.wrapCommand(join(h.root, 'ws'), 'true').startsWith(`exec '${h.direnv}'`)).toBe(true)
    } finally {
      await h.cleanup()
    }
  })
})
