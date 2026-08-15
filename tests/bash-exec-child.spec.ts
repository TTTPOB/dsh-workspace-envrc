import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { defaultConfig, type WorkspaceEnvrcConfig } from '../src/core.js'
import WorkspaceEnvrc from '../src/provider.js'
import { okSpawn } from './helpers.js'

/**
 * A fake native `direnv` for the execution-level test. It consumes the
 * canonical workspace argument like the real `direnv exec DIR`, simulates an
 * ALLOWED `.envrc` evaluation by exporting ordinary variables (including a
 * credential-shaped one and BASH_ENV/ENV) plus a stale `DSH_*` fact, and
 * execs the managed-env shim. No real direnv, no authorization state, no
 * `.envrc` file — real allow/deny behavior is a later block.
 */
const FAKE_DIRENV_SH = `#!/bin/sh
# Fake direnv: \`exec DIR <shim argv...>\` — simulates an allowed .envrc.
sub=$1
dir=$2
shift 2
export MY_DIRENV_VAR="value-from-$dir"
export API_TOKEN='native-secret'
export BASH_ENV='/nonexistent-evil-bashenv-xyz'
export ENV='/nonexistent-evil-env-xyz'
export DSH_STALE='stale-from-direnv'
exec "$@"
`

/** Deliberately explicit child environment: no process.env is ever touched. */
const EXPLICIT_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent-home',
  // An ambient DSH_* fact the shim must clear (it is not in the snapshot).
  DSH_DIRTY: 'ambient-dirty',
  // Ambient BASH_ENV/ENV the invoking `env -u` must strip.
  BASH_ENV: '/nonexistent-ambient-bashenv',
  ENV: '/nonexistent-ambient-env',
}

function runBash(command: string, env: Record<string, string>): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Activate the real provider over one temp workspace whose fake direnv
 * replaces the native executable, and run one wrapped command as an actual
 * child with an explicit environment.
 */
async function runWrapped(
  originalCommand: string,
  snapshot: Record<string, string>,
): Promise<{ workspace: string; code: number | null; stdout: string; stderr: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-envrc-exec-'))
  try {
    const fakeDirenv = join(workspace, 'fake-direnv')
    await writeFile(fakeDirenv, FAKE_DIRENV_SH)
    await chmod(fakeDirenv, 0o755)

    const config: WorkspaceEnvrcConfig = { ...defaultConfig, executable: fakeDirenv }
    const ctx = new Context()
    // The provider row injects these; the projections under test never read
    // them (wrapCommand needs no Agent/workspace mapping).
    ctx.provide('agents', {})
    ctx.provide('workspaceCordis', {})
    const RuntimeProvider = class extends WorkspaceEnvrc {
      constructor(applyCtx: Context) {
        super(applyCtx, config, { spawn: okSpawn() })
      }
    }
    const fiber = await ctx.plugin(RuntimeProvider, config as never)
    try {
      const command = ctx.workspaceEnvrc.wrapCommand(workspace, originalCommand, snapshot)
      const result = await runBash(command, EXPLICIT_ENV)
      return { workspace, ...result }
    } finally {
      await fiber.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

describe('wrapped shell command execution (fake direnv shim)', () => {
  it('runs the original command with ordinary direnv vars preserved and DSH_* restored', async () => {
    const original = [
      'printf "%s|%s|%s|%s|%s|%s|%s"',
      '"$MY_DIRENV_VAR"',
      '"$API_TOKEN"',
      '"${DSH_HOME-}"',
      '"${DSH_SESSION_ID-}"',
      '"${DSH_STALE-}"',
      '"${DSH_DIRTY-}"',
      '"${BASH_ENV-unset}"',
    ].join(' ')
    const { workspace, code, stdout, stderr } = await runWrapped(original, {
      DSH_HOME: '/restored-home',
      DSH_SESSION_ID: 'sess-9',
    })
    expect(code).toBe(0)
    // Ordinary variables exported by the (simulated) allowed .envrc survive,
    // including the credential-shaped one; the managed snapshot is restored;
    // ambient and direnv-set DSH_* facts are cleared; BASH_ENV/ENV never
    // reach the original program (`env -u` stripped them for the shim).
    expect(stdout).toBe(`value-from-${workspace}|native-secret|/restored-home|sess-9|||unset`)
    // A leaked BASH_ENV would make bash try to source the evil file.
    expect(stderr).not.toContain('evil')
  })

  it('preserves the original command exit status through the whole chain', async () => {
    const { code, stdout } = await runWrapped('printf "exit:%s" "${DSH_HOME-}"; exit 7', { DSH_HOME: '/h' })
    expect(stdout).toBe('exit:/h')
    expect(code).toBe(7)
  })

  it('clears every DSH_* variable when the managed snapshot is empty', async () => {
    const original = 'printf "%s|%s|%s" "${DSH_HOME-unset}" "${DSH_STALE-unset}" "${DSH_DIRTY-unset}"'
    const { code, stdout } = await runWrapped(original, {})
    expect(code).toBe(0)
    // Snapshot-less, ambient, and direnv-set DSH_* variables are all deleted.
    expect(stdout).toBe('unset|unset|unset')
  })
})
