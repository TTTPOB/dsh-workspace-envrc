import { describe, expect, it } from 'vitest'
import {
  DEFERRED_ENV_CAPTURE_SCRIPT,
  DEFERRED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_SCRIPT,
  buildDeferredManagedExecArgv,
  buildExecArgv,
  buildManagedEnvShimArgv,
  managedEnvPairs,
  shq,
  wrapCommand,
} from '../src/core.js'

describe('buildManagedEnvShimArgv', () => {
  it('builds the exact plan argv with label, count, pairs, and original argv', () => {
    const argv = buildManagedEnvShimArgv({
      shimShell: '/bin/bash',
      label: 'label-x',
      snapshot: { DSH_HOME: '/dsh-home', DSH_SESSION_ID: 's1' },
      originalArgv: ['bash', '-c', 'echo hi'],
    })
    expect(argv).toEqual([
      'env',
      '-u',
      'BASH_ENV',
      '-u',
      'ENV',
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      MANAGED_ENV_SHIM_SCRIPT,
      'label-x',
      '2',
      'DSH_HOME',
      '/dsh-home',
      'DSH_SESSION_ID',
      's1',
      'bash',
      '-c',
      'echo hi',
    ])
  })

  it('passes values through argv in snapshot insertion order', () => {
    expect(managedEnvPairs({ DSH_B: 'b', DSH_A: 'a' }).map(([name, value]) => `${name}=${value}`)).toEqual([
      'DSH_B=b',
      'DSH_A=a',
    ])
  })

  it('emits a zero count and no pairs for an empty snapshot', () => {
    const argv = buildManagedEnvShimArgv({
      shimShell: '/bin/bash',
      label: 'l',
      snapshot: {},
      originalArgv: ['sh', '-c', 'true'],
    })
    expect(argv.slice(0, 12)).toEqual([
      'env',
      '-u',
      'BASH_ENV',
      '-u',
      'ENV',
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      MANAGED_ENV_SHIM_SCRIPT,
      'l',
      '0',
    ])
    expect(argv.slice(12)).toEqual(['sh', '-c', 'true'])
  })

  it('rejects empty original argv', () => {
    expect(() =>
      buildManagedEnvShimArgv({ shimShell: '/bin/bash', label: 'l', snapshot: {}, originalArgv: [] }),
    ).toThrow(/original argv must be a non-empty array/)
  })

  it('rejects a NUL byte in any argument', () => {
    const base = { shimShell: '/bin/bash', label: 'l', snapshot: {}, originalArgv: ['true'] } as const
    expect(() => buildManagedEnvShimArgv({ ...base, shimShell: '/bin/ba\0sh' })).toThrow(/NUL/)
    expect(() => buildManagedEnvShimArgv({ ...base, label: 'a\0b' })).toThrow(/NUL/)
    expect(() => buildManagedEnvShimArgv({ ...base, originalArgv: ['a\0b'] })).toThrow(/NUL/)
    expect(() =>
      buildManagedEnvShimArgv({ ...base, snapshot: { DSH_X: 'a\0b' } }),
    ).toThrow(/NUL/)
  })

  it('rejects managed names that do not match DSH_[A-Z0-9_]+ and non-string values', () => {
    const base = { shimShell: '/bin/bash', label: 'l', originalArgv: ['true'] } as const
    expect(() => buildManagedEnvShimArgv({ ...base, snapshot: { 'DSH-FOO': 'v' } })).toThrow(/must match/)
    expect(() => buildManagedEnvShimArgv({ ...base, snapshot: { DSH_: 'v' } })).toThrow(/must match/)
    expect(() => buildManagedEnvShimArgv({ ...base, snapshot: { dsh_HOME: 'v' } })).toThrow(/must match/)
    expect(() => buildManagedEnvShimArgv({ ...base, snapshot: { DSH_A1_: 'v' } })).not.toThrow()
    expect(() =>
      buildManagedEnvShimArgv({ ...base, snapshot: { DSH_X: 42 as never } }),
    ).toThrow(/must be a string/)
  })

  it('requires an absolute shim shell', () => {
    expect(() =>
      buildManagedEnvShimArgv({ shimShell: 'bash', label: 'l', snapshot: {}, originalArgv: ['true'] }),
    ).toThrow(/shimShell must be an absolute path/)
  })
})

describe('buildDeferredManagedExecArgv', () => {
  const base = {
    executable: 'direnv',
    canonicalWorkspace: '/workspaces/demo',
    shimShell: '/bin/bash',
    captureLabel: DEFERRED_ENV_SHIM_LABEL,
    restoreLabel: MANAGED_ENV_SHIM_LABEL,
    originalArgv: ['/bin/bash', '-i'],
  } as const

  it('builds the exact deferred capture argv: outer shim, then the original argv', () => {
    const argv = buildDeferredManagedExecArgv({ ...base, originalArgv: ['/bin/bash', '--noprofile', '--norc', '-i'] })
    expect(argv).toEqual([
      'env',
      '-u',
      'BASH_ENV',
      '-u',
      'ENV',
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      DEFERRED_ENV_CAPTURE_SCRIPT,
      DEFERRED_ENV_SHIM_LABEL,
      '/bin/bash',
      'direnv',
      '/workspaces/demo',
      MANAGED_ENV_SHIM_LABEL,
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-i',
    ])
  })

  it('embeds the post-direnv restoration shim inside the capture script', () => {
    // The capture script must exec `direnv exec <workspace>` plus the exact
    // managed-env restoration shim carrying the captured pairs, with the
    // inner label/count/pairs position preserved.
    expect(DEFERRED_ENV_CAPTURE_SCRIPT).toContain(`exec "$direnv_executable" exec "$workspace" env -u BASH_ENV -u ENV "$shim_shell" --noprofile --norc -c '${MANAGED_ENV_SHIM_SCRIPT}' "$restore_label" "$count" "\${pairs[@]}" "$@"`)
    expect(DEFERRED_ENV_CAPTURE_SCRIPT).toContain('for name in ${!DSH_*}; do')
    expect(DEFERRED_ENV_CAPTURE_SCRIPT).toContain('pairs+=("$name" "${!name}")')
    // The restoration script itself contains no single quotes, so embedding
    // it verbatim inside one single-quoted word is safe.
    expect(MANAGED_ENV_SHIM_SCRIPT).not.toContain("'")
  })

  it('rejects empty original argv, NUL bytes, and non-absolute workspace/shim shell', () => {
    expect(() => buildDeferredManagedExecArgv({ ...base, originalArgv: [] })).toThrow(/original argv/)
    expect(() => buildDeferredManagedExecArgv({ ...base, originalArgv: ['a\0b'] })).toThrow(/NUL/)
    expect(() => buildDeferredManagedExecArgv({ ...base, executable: '' })).toThrow(/executable must not be empty/)
    expect(() => buildDeferredManagedExecArgv({ ...base, executable: 'd\0' })).toThrow(/NUL/)
    expect(() => buildDeferredManagedExecArgv({ ...base, canonicalWorkspace: 'ws' })).toThrow(
      /canonicalWorkspace must be an absolute path/,
    )
    expect(() => buildDeferredManagedExecArgv({ ...base, canonicalWorkspace: '/w\0s' })).toThrow(/NUL/)
    expect(() => buildDeferredManagedExecArgv({ ...base, shimShell: 'bash' })).toThrow(/shimShell must be an absolute path/)
    expect(() => buildDeferredManagedExecArgv({ ...base, captureLabel: 'a\0b' })).toThrow(/NUL/)
    expect(() => buildDeferredManagedExecArgv({ ...base, restoreLabel: 'a\0b' })).toThrow(/NUL/)
  })
})

describe('buildExecArgv', () => {
  it('builds the exact wrapped argv: executable exec workspace + shim + original', () => {
    const argv = buildExecArgv({
      executable: 'direnv',
      canonicalWorkspace: '/workspaces/demo',
      shimShell: '/bin/bash',
      shimLabel: 'label-x',
      managedEnv: { DSH_HOME: '/dsh-home' },
      originalArgv: ['bash', '-c', 'echo hi'],
    })
    expect(argv).toEqual([
      'direnv',
      'exec',
      '/workspaces/demo',
      'env',
      '-u',
      'BASH_ENV',
      '-u',
      'ENV',
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      MANAGED_ENV_SHIM_SCRIPT,
      'label-x',
      '1',
      'DSH_HOME',
      '/dsh-home',
      'bash',
      '-c',
      'echo hi',
    ])
  })

  it('rejects empty or NUL-bearing executable and non-absolute workspace', () => {
    const base = {
      canonicalWorkspace: '/ws',
      shimShell: '/bin/bash',
      shimLabel: 'l',
      managedEnv: {},
      originalArgv: ['true'],
    } as const
    expect(() => buildExecArgv({ ...base, executable: '' })).toThrow(/executable must not be empty/)
    expect(() => buildExecArgv({ ...base, executable: 'd\x00' })).toThrow(/NUL/)
    expect(() => buildExecArgv({ ...base, executable: 'direnv', canonicalWorkspace: 'ws' })).toThrow(
      /canonicalWorkspace must be an absolute path/,
    )
    expect(() => buildExecArgv({ ...base, executable: 'direnv', canonicalWorkspace: '/w\0s' })).toThrow(/NUL/)
  })
})

describe('shq', () => {
  it('quotes plain words', () => {
    expect(shq('plain')).toBe("'plain'")
    expect(shq('')).toBe("''")
  })

  it('keeps spaces inside one single-quoted word', () => {
    expect(shq('a b')).toBe("'a b'")
  })

  it('escapes embedded single quotes with the known 4-char sequence', () => {
    expect(shq("a'b")).toBe("'a'\\''b'")
    expect(shq("it's")).toBe("'it'\\''s'")
  })

  it('keeps newlines literal inside the quotes', () => {
    expect(shq('a\nb')).toBe("'a\nb'")
  })

  it('rejects NUL bytes', () => {
    expect(() => shq('a\0b')).toThrow(/NUL/)
  })
})

describe('wrapCommand', () => {
  const base = {
    executable: 'direnv',
    canonicalWorkspace: '/workspaces/demo',
    shimShell: '/bin/bash',
    shimLabel: 'l',
    managedEnv: {},
  } as const

  it('produces the exact exec command with every argument quoted', () => {
    const command = wrapCommand(base, 'echo hi')
    expect(command).toBe(
      `exec 'direnv' 'exec' '/workspaces/demo' 'env' '-u' 'BASH_ENV' '-u' 'ENV' '/bin/bash' '--noprofile' '--norc' '-c' '${MANAGED_ENV_SHIM_SCRIPT}' 'l' '0' '/bin/bash' '-c' 'echo hi'`,
    )
  })

  it('quotes spaces, single quotes, and newlines in the original command', () => {
    expect(wrapCommand(base, "echo 'a b'")).toBe(
      `exec 'direnv' 'exec' '/workspaces/demo' 'env' '-u' 'BASH_ENV' '-u' 'ENV' '/bin/bash' '--noprofile' '--norc' '-c' '${MANAGED_ENV_SHIM_SCRIPT}' 'l' '0' '/bin/bash' '-c' 'echo '\\''a b'\\'''`,
    )
    expect(wrapCommand(base, 'echo a\nb')).toContain(`'/bin/bash' '-c' 'echo a\nb'`)
  })

  it('rejects a NUL byte in the original command', () => {
    expect(() => wrapCommand(base, 'echo a\0b')).toThrow(/NUL/)
  })
})
