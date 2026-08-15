import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { MANAGED_ENV_SHIM_LABEL, buildManagedEnvShimArgv } from '../src/core.js'

/**
 * Run the real managed-env shim as an actual child with a deliberately plain
 * isolated environment — no direnv, no .envrc, no user state — and return the
 * original program's exit facts and output.
 */
async function runShim(
  env: Record<string, string>,
  snapshot: Record<string, string>,
  originalArgv: readonly string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const argv = buildManagedEnvShimArgv({
    shimShell: '/bin/bash',
    label: MANAGED_ENV_SHIM_LABEL,
    snapshot,
    originalArgv,
  })
  const [envBin, ...rest] = argv
  return new Promise((resolve, reject) => {
    const child = spawn(envBin!, rest, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

const PLAIN_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/tmp',
  // Ambient DSH_* facts a direnv evaluation might have produced.
  DSH_DIRTY: 'ambient-value',
  DSH_STALE: 'stale-value',
  // An ordinary credential-shaped variable must never be touched by the core.
  API_TOKEN: 'topsecret-canary',
}

describe('managed-env shim child', () => {
  it('clears ambient DSH_*, restores the exact snapshot, and leaves ordinary vars alone', async () => {
    const snapshot = { DSH_HOME: '/restored-home', DSH_SESSION_ID: 'sess-42' }
    const original = [
      '/bin/bash',
      '-c',
      'printf "%s|%s|%s|%s|%s" "${DSH_DIRTY-}" "${DSH_STALE-}" "${DSH_HOME-}" "${DSH_SESSION_ID-}" "${API_TOKEN-}"',
    ]
    const { code, stdout } = await runShim(PLAIN_ENV, snapshot, original)
    expect(code).toBe(0)
    // DSH_DIRTY/DSH_STALE were deleted, the snapshot was restored verbatim,
    // and the ordinary secret-like variable survived untouched.
    expect(stdout).toBe('||/restored-home|sess-42|topsecret-canary')
  })

  it('deletes every DSH_* variable when the snapshot is empty', async () => {
    const original = ['/bin/bash', '-c', 'printf "%s|%s" "${DSH_DIRTY-unset}" "${DSH_HOME-unset}"']
    const { code, stdout } = await runShim(PLAIN_ENV, {}, original)
    expect(code).toBe(0)
    expect(stdout).toBe('unset|unset')
  })

  it('round-trips values with spaces, single quotes, and newlines through argv', async () => {
    const weird = "a b'c\nd"
    const original = ['/bin/bash', '-c', 'printf "%s" "$DSH_WEIRD"']
    const { code, stdout } = await runShim(PLAIN_ENV, { DSH_WEIRD: weird }, original)
    expect(code).toBe(0)
    expect(stdout).toBe(weird)
  })

  it('restores an empty value as set-but-empty', async () => {
    const original = ['/bin/bash', '-c', 'printf "%s" "${DSH_EMPTY-unset}"']
    const { code, stdout } = await runShim(PLAIN_ENV, { DSH_EMPTY: '' }, original)
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('strips BASH_ENV and ENV from the shim (and thus the exec chain)', async () => {
    const env = {
      ...PLAIN_ENV,
      BASH_ENV: '/nonexistent-evil-bashenv-xyz',
      ENV: '/nonexistent-evil-env-xyz',
    }
    const original = [
      '/bin/bash',
      '-c',
      'printf "%s|%s" "${BASH_ENV-unset}" "${ENV-unset}"',
    ]
    const { code, stdout, stderr } = await runShim(env, {}, original)
    expect(code).toBe(0)
    expect(stdout).toBe('unset|unset')
    expect(stderr).not.toContain('evil')
  })

  it('execs a non-shell original program and preserves its exit status', async () => {
    const original = ['/bin/sh', '-c', 'printf "sh:%s" "${DSH_HOME-}"; exit 7']
    const { code, stdout } = await runShim(PLAIN_ENV, { DSH_HOME: '/h' }, original)
    expect(stdout).toBe('sh:/h')
    expect(code).toBe(7)
  })
})
