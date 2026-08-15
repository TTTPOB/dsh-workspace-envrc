import { describe, expect, it, vi } from 'vitest'
import {
  PreflightError,
  assertPosixPlatform,
  runPreflight,
  type PreflightChild,
  type PreflightExit,
} from '../src/core.js'

/** A child whose `done` settles only when killed or explicitly resolved. */
function controllableChild(): {
  child: PreflightChild
  resolve: (exit: PreflightExit) => void
  kill: ReturnType<typeof vi.fn>
} {
  let resolveDone!: (exit: PreflightExit) => void
  const kill = vi.fn()
  const child: PreflightChild = {
    kill: () => {
      kill()
      resolveDone({ code: null, signal: 'SIGTERM' })
    },
    done: new Promise<PreflightExit>((resolve) => {
      resolveDone = resolve
    }),
  }
  return { child, resolve: resolveDone, kill }
}

const OPTIONS = {
  argv: ['direnv', 'version'],
  stage: 'direnv version',
  identity: 'direnv',
  timeoutMs: 1_000,
} as const

/** A child that settles immediately with the given exit facts. */
function doneChild(exit: PreflightExit): PreflightChild {
  return { kill: vi.fn(), done: Promise.resolve(exit) }
}

describe('runPreflight', () => {
  it('resolves on a clean exit 0', async () => {
    const spawn = vi.fn(() => doneChild({ code: 0, signal: null }))
    await expect(runPreflight({ ...OPTIONS, spawn })).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledWith(['direnv', 'version'], expect.any(AbortSignal))
  })

  it('rejects with the stage, identity, and exit code on a non-zero exit', async () => {
    const spawn = vi.fn(() => doneChild({ code: 127, signal: null }))
    const error = await runPreflight({ ...OPTIONS, spawn }).then(
      () => null,
      (reason) => reason,
    )
    expect(error).toBeInstanceOf(PreflightError)
    expect((error as Error).message).toBe(
      'workspace-envrc: preflight direnv version for "direnv" failed: exited with code 127',
    )
  })

  it('rejects with the spawn error when the process never started', async () => {
    const spawn = vi.fn(() =>
      doneChild({ code: null, signal: null, spawnError: new Error('spawn direnv ENOENT') }),
    )
    const error = await runPreflight({ ...OPTIONS, spawn }).then(
      () => null,
      (reason) => reason,
    )
    expect((error as Error).message).toBe(
      'workspace-envrc: preflight direnv version for "direnv" failed: could not be started: spawn direnv ENOENT',
    )
  })

  it('rejects when the child died from a signal', async () => {
    const spawn = vi.fn(() => doneChild({ code: null, signal: 'SIGTERM' }))
    const error = await runPreflight({ ...OPTIONS, spawn }).then(
      () => null,
      (reason) => reason,
    )
    expect((error as Error).message).toContain('killed by SIGTERM')
  })

  it('kills the child and reports the deadline on timeout', async () => {
    const { child, kill } = controllableChild()
    const error = await runPreflight({ ...OPTIONS, timeoutMs: 20, spawn: () => child }).then(
      () => null,
      (reason) => reason,
    )
    expect(kill).toHaveBeenCalledTimes(1)
    expect((error as Error).message).toBe(
      'workspace-envrc: preflight direnv version for "direnv" failed: timed out after 20 ms',
    )
  })

  it('kills the child and reports the abort when the signal fires', async () => {
    const controller = new AbortController()
    const { child, kill } = controllableChild()
    const pending = runPreflight({ ...OPTIONS, signal: controller.signal, spawn: () => child })
    controller.abort()
    const error = await pending.then(
      () => null,
      (reason) => reason,
    )
    expect(kill).toHaveBeenCalledTimes(1)
    expect((error as Error).message).toContain('aborted')
  })

  it('does not kill a child that already settled', async () => {
    const kill = vi.fn()
    const spawn = vi.fn(() => ({ kill, done: Promise.resolve({ code: 0, signal: null }) }))
    await runPreflight({ ...OPTIONS, timeoutMs: 5, spawn })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(kill).not.toHaveBeenCalled()
  })

  it('never leaks child stdout or stderr into the error (real bash child)', async () => {
    const error = await runPreflight({
      argv: ['/bin/bash', '-c', 'printf "CANARY_TOP_SECRET_XYZ\\n" >&2; printf "CANARY_STDOUT\\n"; exit 1'],
      stage: 'shim shell',
      identity: '/bin/bash',
      timeoutMs: 5_000,
    }).then(
      () => null,
      (reason) => reason,
    )
    expect(error).toBeInstanceOf(PreflightError)
    const message = (error as Error).message
    expect(message).toContain('exited with code 1')
    expect(message).toContain('shim shell')
    expect(message).toContain('/bin/bash')
    expect(message).not.toContain('CANARY_TOP_SECRET_XYZ')
    expect(message).not.toContain('CANARY_STDOUT')
  })

  it('runs the real production spawner for the shim shell check', async () => {
    await expect(
      runPreflight({
        argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'exit 0'],
        stage: 'shim shell',
        identity: '/bin/bash',
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined()
  })

  it('reports a missing executable through the production spawner without crashing', async () => {
    const error = await runPreflight({
      argv: ['/definitely/missing/direnv-binary-xyz', 'version'],
      stage: 'direnv version',
      identity: '/definitely/missing/direnv-binary-xyz',
      timeoutMs: 5_000,
    }).then(
      () => null,
      (reason) => reason,
    )
    expect((error as Error).message).toContain('could not be started')
  })

  it('rejects empty argv and non-positive timeouts', async () => {
    await expect(runPreflight({ ...OPTIONS, argv: [] })).rejects.toThrow(/non-empty/)
    await expect(runPreflight({ ...OPTIONS, argv: ['a\0b'] })).rejects.toThrow(/NUL/)
    await expect(runPreflight({ ...OPTIONS, timeoutMs: 0 })).rejects.toThrow(/positive integer/)
  })
})

describe('assertPosixPlatform', () => {
  it('fails loud on Windows', () => {
    expect(() => assertPosixPlatform('win32')).toThrow(/Windows is not supported in V1/)
  })

  it('accepts POSIX platforms', () => {
    for (const platform of ['linux', 'darwin', 'freebsd', 'openbsd'] as const) {
      expect(() => assertPosixPlatform(platform)).not.toThrow()
    }
  })
})
