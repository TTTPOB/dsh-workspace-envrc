import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFERRED_ENV_SHIM_LABEL, MANAGED_ENV_SHIM_LABEL, buildDeferredManagedExecArgv } from '../src/core.js'

/**
 * A fake native `direnv` for the deferred-chain execution tests. It consumes
 * the canonical workspace argument like `direnv exec DIR`, simulates an
 * ALLOWED `.envrc` evaluation by exporting ordinary variables (including a
 * credential-shaped one), exporting control-variable traps (BASH_ENV/ENV) and
 * stale `DSH_*` facts, overwriting one managed fact, and UNSETTING another,
 * then execs the post-direnv restoration shim. No real direnv, no
 * authorization state, no `.envrc` file.
 */
const FAKE_DIRENV_MUTATE = `#!/bin/sh
# Fake direnv: \`exec DIR <shim argv...>\` — simulates an allowed .envrc.
sub=$1
dir=$2
shift 2
export MY_DIRENV_VAR="value-from-$dir"
export API_TOKEN='native-secret'
export BASH_ENV='/nonexistent-evil-bashenv-xyz'
export ENV='/nonexistent-evil-env-xyz'
export DSH_STALE='stale-from-direnv'
export DSH_SESSION_ID='overwritten-by-direnv'
unset DSH_SHELL
exec "$@"
`

/** A fake direnv that REFUSES the execution like a blocked/denied .envrc. */
const FAKE_DIRENV_BLOCKED = `#!/bin/sh
echo 'direnv: error .envrc is blocked. Run \`direnv allow\` to approve its content.' >&2
exit 3
`

/** The deliberate child environment the subprocess provider would produce. */
function childEnv(workspace: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/nonexistent-home',
    // Ambient control variables the invoking `env -u` must strip.
    BASH_ENV: '/nonexistent-ambient-bashenv',
    ENV: '/nonexistent-ambient-env',
    // Managed facts that must survive direnv evaluation exactly.
    DSH_SESSION_ID: 'sess-deferred-7',
    DSH_PTY_SESSION_ID: 'pty-deferred-7',
    DSH_SHELL: '1',
    DSH_DIRTY: 'ambient-dirty',
    ...extra,
  }
}

/** Spawn the deferred wrapper argv as a real child with an explicit env. */
function runDeferred(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

/** Materialize a fake direnv executable in a temp workspace. */
async function fakeDirenv(script: string): Promise<{ workspace: string; executable: string; cleanup(): Promise<void> }> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-envrc-deferred-'))
  const executable = join(workspace, 'fake-direnv')
  await writeFile(executable, script)
  await chmod(executable, 0o755)
  return {
    workspace,
    executable,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  }
}

describe('deferred managed-env wrapper child', () => {
  it('captures the spawned DSH_* snapshot, survives direnv mutation, and restores it exactly', async () => {
    const fake = await fakeDirenv(FAKE_DIRENV_MUTATE)
    try {
      const argv = buildDeferredManagedExecArgv({
        executable: fake.executable,
        canonicalWorkspace: fake.workspace,
        shimShell: '/bin/bash',
        captureLabel: DEFERRED_ENV_SHIM_LABEL,
        restoreLabel: MANAGED_ENV_SHIM_LABEL,
        originalArgv: [
          '/bin/bash',
          '-c',
          'printf "%s|%s|%s|%s|%s|%s|%s|%s" "${DSH_SESSION_ID-}" "${DSH_PTY_SESSION_ID-}" '
            + '"${DSH_SHELL-unset}" "${DSH_DIRTY-}" "${DSH_STALE-unset}" "$MY_DIRENV_VAR" '
            + '"${API_TOKEN-}" "${BASH_ENV-unset}"',
        ],
      })
      const result = await runDeferred(argv, childEnv(fake.workspace))
      expect(result.code).toBe(0)
      // Managed facts captured before direnv are restored verbatim (including
      // the one direnv overwrote and the one it unset); direnv-added DSH_*
      // facts are cleared; ordinary variables including the credential-shaped
      // one follow native direnv; BASH_ENV/ENV never reach the program.
      expect(result.stdout).toBe(
        `sess-deferred-7|pty-deferred-7|1|ambient-dirty|unset|value-from-${fake.workspace}|native-secret|unset`,
      )
      expect(result.stderr).not.toContain('evil')
    } finally {
      await fake.cleanup()
    }
  })

  it('clears every DSH_* variable when the spawned environment has none', async () => {
    const fake = await fakeDirenv(FAKE_DIRENV_MUTATE)
    try {
      const argv = buildDeferredManagedExecArgv({
        executable: fake.executable,
        canonicalWorkspace: fake.workspace,
        shimShell: '/bin/bash',
        captureLabel: DEFERRED_ENV_SHIM_LABEL,
        restoreLabel: MANAGED_ENV_SHIM_LABEL,
        originalArgv: ['/bin/bash', '-c', 'printf "%s|%s" "${DSH_SESSION_ID-unset}" "${DSH_STALE-unset}"'],
      })
      const result = await runDeferred(argv, { PATH: '/usr/bin:/bin', HOME: '/tmp' })
      expect(result.code).toBe(0)
      // Nothing was captured, so the direnv-set stale fact is deleted too.
      expect(result.stdout).toBe('unset|unset')
    } finally {
      await fake.cleanup()
    }
  })

  it('round-trips values with spaces, single quotes, and newlines through the capture', async () => {
    const fake = await fakeDirenv(FAKE_DIRENV_MUTATE)
    try {
      const weird = "a b'c\nd"
      const argv = buildDeferredManagedExecArgv({
        executable: fake.executable,
        canonicalWorkspace: fake.workspace,
        shimShell: '/bin/bash',
        captureLabel: DEFERRED_ENV_SHIM_LABEL,
        restoreLabel: MANAGED_ENV_SHIM_LABEL,
        originalArgv: ['/bin/bash', '-c', 'printf "%s" "$DSH_WEIRD"'],
      })
      const result = await runDeferred(argv, childEnv(fake.workspace, { DSH_WEIRD: weird }))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(weird)
    } finally {
      await fake.cleanup()
    }
  })

  it('preserves the original program exit status through the whole chain', async () => {
    const fake = await fakeDirenv(FAKE_DIRENV_MUTATE)
    try {
      const argv = buildDeferredManagedExecArgv({
        executable: fake.executable,
        canonicalWorkspace: fake.workspace,
        shimShell: '/bin/bash',
        captureLabel: DEFERRED_ENV_SHIM_LABEL,
        restoreLabel: MANAGED_ENV_SHIM_LABEL,
        originalArgv: ['/bin/bash', '-c', 'printf "exit:%s" "${DSH_SESSION_ID-}"; exit 7'],
      })
      const result = await runDeferred(argv, childEnv(fake.workspace))
      expect(result.stdout).toBe('exit:sess-deferred-7')
      expect(result.code).toBe(7)
    } finally {
      await fake.cleanup()
    }
  })

  it('propagates a blocked direnv refusal with its stderr and exit status', async () => {
    const fake = await fakeDirenv(FAKE_DIRENV_BLOCKED)
    try {
      const argv = buildDeferredManagedExecArgv({
        executable: fake.executable,
        canonicalWorkspace: fake.workspace,
        shimShell: '/bin/bash',
        captureLabel: DEFERRED_ENV_SHIM_LABEL,
        restoreLabel: MANAGED_ENV_SHIM_LABEL,
        originalArgv: ['/bin/bash', '-c', 'echo must-not-run'],
      })
      const result = await runDeferred(argv, childEnv(fake.workspace))
      expect(result.code).toBe(3)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('direnv: error .envrc is blocked')
    } finally {
      await fake.cleanup()
    }
  })

  it('execs a non-shell original program after the restoration', async () => {
    const fake = await fakeDirenv(FAKE_DIRENV_MUTATE)
    try {
      const argv = buildDeferredManagedExecArgv({
        executable: fake.executable,
        canonicalWorkspace: fake.workspace,
        shimShell: '/bin/bash',
        captureLabel: DEFERRED_ENV_SHIM_LABEL,
        restoreLabel: MANAGED_ENV_SHIM_LABEL,
        originalArgv: ['/bin/sh', '-c', 'printf "sh:%s" "${DSH_SESSION_ID-}"'],
      })
      const result = await runDeferred(argv, childEnv(fake.workspace))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('sh:sess-deferred-7')
    } finally {
      await fake.cleanup()
    }
  })
})
