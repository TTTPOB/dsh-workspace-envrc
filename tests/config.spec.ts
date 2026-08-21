import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { describe, expect, it } from 'vitest'
import WorkspaceEnvrc, { defaultConfig } from '../src/provider.js'

describe('WorkspaceEnvrc.Config schema', () => {
  it('applies the plan defaults for an empty config', () => {
    expect(WorkspaceEnvrc.Config({} as never)).toEqual(defaultConfig)
    expect(defaultConfig).toEqual({
      executable: 'direnv',
      shimShell: '/bin/bash',
      enableBash: true,
      enableWorkspaceMcp: true,
      versionCheckTimeoutMs: 5_000,
    })
  })

  it('merges partial config over the defaults', () => {
    const config = WorkspaceEnvrc.Config({ executable: '/usr/local/bin/direnv', versionCheckTimeoutMs: 123 } as never)
    expect(config).toEqual({ ...defaultConfig, executable: '/usr/local/bin/direnv', versionCheckTimeoutMs: 123 })
  })

  it('accepts the timeout ceiling', () => {
    expect(WorkspaceEnvrc.Config({ versionCheckTimeoutMs: MAX_TIMER_DELAY_MS } as never).versionCheckTimeoutMs).toBe(
      MAX_TIMER_DELAY_MS,
    )
  })

  it('rejects invalid field types and out-of-range timeouts', () => {
    expect(() => WorkspaceEnvrc.Config({ executable: 42 as never } as never)).toThrow()
    expect(() => WorkspaceEnvrc.Config({ shimShell: 42 as never } as never)).toThrow()
    expect(() => WorkspaceEnvrc.Config({ enableBash: 'yes' as never } as never)).toThrow()
    expect(() => WorkspaceEnvrc.Config({ enableWorkspaceMcp: 'yes' as never } as never)).toThrow()
    expect(() => WorkspaceEnvrc.Config({ versionCheckTimeoutMs: 0 } as never)).toThrow()
    expect(() => WorkspaceEnvrc.Config({ versionCheckTimeoutMs: -1 } as never)).toThrow()
    expect(() => WorkspaceEnvrc.Config({ versionCheckTimeoutMs: 3.5 } as never)).toThrow()
    expect(() => WorkspaceEnvrc.Config({ versionCheckTimeoutMs: MAX_TIMER_DELAY_MS + 1 } as never)).toThrow()
  })
})

describe('WorkspaceEnvrc constructor validation', () => {
  // Each construction needs a fresh context: `super()` registers the service
  // before the semantic assert runs (the loader rolls the registration back
  // on failure), so a second construction on one context would hit the
  // duplicate-service error instead of the validation error under test.
  it('rejects an empty or NUL-bearing executable', () => {
    expect(() => new WorkspaceEnvrc(new Context(), { ...defaultConfig, executable: '' })).toThrow(
      /config\.executable must not be empty/,
    )
    expect(() => new WorkspaceEnvrc(new Context(), { ...defaultConfig, executable: 'd\x00' })).toThrow(/NUL/)
  })

  it('rejects a non-absolute or NUL-bearing shim shell', () => {
    expect(() => new WorkspaceEnvrc(new Context(), { ...defaultConfig, shimShell: 'bash' })).toThrow(
      /config\.shimShell must be an absolute path/,
    )
    expect(() => new WorkspaceEnvrc(new Context(), { ...defaultConfig, shimShell: '/bin/ba\0sh' })).toThrow(/NUL/)
  })

  it('rejects a non-positive or oversized timeout', () => {
    expect(() => new WorkspaceEnvrc(new Context(), { ...defaultConfig, versionCheckTimeoutMs: 0 })).toThrow(
      /must be a positive integer/,
    )
    expect(
      () => new WorkspaceEnvrc(new Context(), { ...defaultConfig, versionCheckTimeoutMs: MAX_TIMER_DELAY_MS + 1 }),
    ).toThrow(/MAX_TIMER_DELAY_MS/)
  })

  it('accepts the defaults unchanged', () => {
    expect(() => new WorkspaceEnvrc(new Context())).not.toThrow()
  })
})
