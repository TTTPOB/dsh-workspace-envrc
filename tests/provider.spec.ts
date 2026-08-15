import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it, vi } from 'vitest'
import type WorkspaceRegistry from 'dsh-workspace-overlay'
import {
  DEFERRED_ENV_CAPTURE_SCRIPT,
  DEFERRED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_SCRIPT,
  type PreflightChild,
  type PreflightExit,
  type PreflightSpawn,
} from '../src/core.js'
import WorkspaceEnvrc, { defaultConfig, type WorkspaceEnvrcConfig, type WorkspaceEnvrcRuntime } from '../src/provider.js'

/**
 * Activate the provider through the real class-plugin path so the inherited
 * `[Service.init]` gate runs, while injecting the runtime seam through a
 * subclass that closes over it (the plugin loader cannot pass constructor
 * arguments). Fake `agents`/`workspaceCordis` services satisfy the inherited
 * `static inject`.
 */
function activate(
  ctx: Context,
  config: WorkspaceEnvrcConfig = defaultConfig,
  runtime: WorkspaceEnvrcRuntime = {},
): Fiber & PromiseLike<Fiber> {
  ctx.provide('agents', {})
  ctx.provide('workspaceCordis', {})
  const RuntimeProvider = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, config, runtime)
    }
  }
  return ctx.plugin(RuntimeProvider, config as never)
}

/** A spawn seam whose children settle only when the test resolves them. */
function controllableSpawn(): {
  spawn: PreflightSpawn
  children: PreflightChild[]
  resolve: (index: number, exit: PreflightExit) => void
} {
  const children: PreflightChild[] = []
  const resolvers: Array<(exit: PreflightExit) => void> = []
  const spawn: PreflightSpawn = vi.fn((_argv, _signal) => {
    let resolveDone!: (exit: PreflightExit) => void
    const kill = vi.fn(() => resolveDone({ code: null, signal: 'SIGTERM' }))
    const child: PreflightChild = {
      kill,
      done: new Promise<PreflightExit>((resolve) => {
        resolveDone = resolve
      }),
    }
    children.push(child)
    resolvers.push(resolveDone)
    return child
  })
  return {
    spawn,
    children,
    resolve: (index, exit) => {
      const resolver = resolvers[index]
      if (resolver === undefined) throw new Error(`no child at ${index}`)
      resolver(exit)
    },
  }
}

function okSpawn(): PreflightSpawn {
  return vi.fn(() => ({ kill: vi.fn(), done: Promise.resolve({ code: 0, signal: null }) }))
}

describe('WorkspaceEnvrc activation', () => {
  it('is strictly ready only after both preflight stages complete', async () => {
    const ctx = new Context()
    const { spawn, resolve } = controllableSpawn()

    const plugin = activate(ctx, defaultConfig, { spawn })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(spawn).toHaveBeenNthCalledWith(1, ['direnv', 'version'], expect.any(AbortSignal))

    // The service must not be ready while the preflight is still in flight.
    let settled = false
    void plugin.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    resolve(0, { code: 0, signal: null })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      [
        'env', '-u', 'BASH_ENV', '-u', 'ENV',
        'DSH_ENVRC_STALE=must-be-cleared',
        '/bin/bash', '--noprofile', '--norc', '-c',
        MANAGED_ENV_SHIM_SCRIPT,
        MANAGED_ENV_SHIM_LABEL,
        '1', 'DSH_ENVRC_PREFLIGHT', 'restored',
        '/bin/bash', '--noprofile', '--norc', '-c',
        'test -z "${DSH_ENVRC_STALE-}" && test "${DSH_ENVRC_PREFLIGHT-}" = restored',
      ],
      expect.any(AbortSignal),
    )
    resolve(1, { code: 0, signal: null })

    await plugin
    expect(ctx.workspaceEnvrc).toBeInstanceOf(WorkspaceEnvrc)
  })

  it('fails loud, unregisters, and leaks no output when a stage fails', async () => {
    const ctx = new Context()
    const spawn = vi.fn(() => ({ kill: vi.fn(), done: Promise.resolve({ code: 127, signal: null }) }))
    const plugin = activate(ctx, defaultConfig, { spawn })
    await expect(plugin).rejects.toThrow(
      'workspace-envrc: preflight direnv version for "direnv" failed: exited with code 127',
    )
    expect(ctx.get('workspaceEnvrc')).toBeUndefined()
  })

  it('reaps the child when the fiber is disposed while the preflight is pending', async () => {
    const ctx = new Context()
    const { spawn, children } = controllableSpawn()

    const plugin = activate(ctx, { ...defaultConfig, versionCheckTimeoutMs: 30 }, { spawn })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    const child = children[0]!

    // Roll back the init: cordis teardown awaits the pending load, so the
    // preflight's own bounded deadline fires, kills the child, the load then
    // settles, and the fiber unloads (the constructor's effect disposer
    // aborts the controller as a backstop).
    await plugin.dispose()
    expect(child.kill).toHaveBeenCalledTimes(1)
    await expect(plugin).rejects.toThrow(/timed out after 30 ms/)
    expect(ctx.get('workspaceEnvrc')).toBeUndefined()
  })

  it('fails loud on Windows before any preflight', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    const ctx = new Context()
    const spawn = vi.fn()
    const plugin = activate(ctx, defaultConfig, { spawn })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await expect(plugin).rejects.toThrow(/Windows is not supported in V1/)
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
    expect(spawn).not.toHaveBeenCalled()
    expect(ctx.get('workspaceEnvrc')).toBeUndefined()
  })
})

describe('WorkspaceEnvrc projections', () => {
  it('wrapArgv binds the config executable, workspace, and shim shell', async () => {
    const ctx = new Context()
    await activate(ctx, { ...defaultConfig, executable: '/usr/local/bin/direnv' }, { spawn: okSpawn() })
    expect(ctx.workspaceEnvrc.wrapArgv('/workspaces/demo', ['bash', '-c', 'echo hi'], { DSH_HOME: '/h' })).toEqual([
      '/usr/local/bin/direnv',
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
      'workspace-envrc-managed-env-shim',
      '1',
      'DSH_HOME',
      '/h',
      'bash',
      '-c',
      'echo hi',
    ])
  })

  it('wrapDeferredArgv builds the deferred capture chain from the config', async () => {
    const ctx = new Context()
    await activate(ctx, { ...defaultConfig, executable: '/usr/local/bin/direnv' }, { spawn: okSpawn() })
    expect(ctx.workspaceEnvrc.wrapDeferredArgv('/workspaces/demo', ['/bin/bash', '-i'])).toEqual([
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
      '/usr/local/bin/direnv',
      '/workspaces/demo',
      MANAGED_ENV_SHIM_LABEL,
      '/bin/bash',
      '-i',
    ])
    // The restoration label stays the shared managed-env shim label.
    expect(ctx.workspaceEnvrc.wrapDeferredArgv('/workspaces/demo', ['true'])).toContain(MANAGED_ENV_SHIM_LABEL)
  })

  it('wrapCommand produces the quoted exec command from the config', async () => {
    const ctx = new Context()
    await activate(ctx, defaultConfig, { spawn: okSpawn() })
    expect(ctx.workspaceEnvrc.wrapCommand('/workspaces/demo', 'echo hi')).toBe(
      `exec 'direnv' 'exec' '/workspaces/demo' 'env' '-u' 'BASH_ENV' '-u' 'ENV' '/bin/bash' '--noprofile' '--norc' '-c' '${MANAGED_ENV_SHIM_SCRIPT}' 'workspace-envrc-managed-env-shim' '0' '/bin/bash' '-c' 'echo hi'`,
    )
  })

  it('workspaceForAgent resolves through the injected workspaceCordis', async () => {
    const ctx = new Context()
    const host = new Context()
    const key = {}
    const agent = { ctx: createScope(host, key).ctx }
    const fake = {
      workspaceForScope: (candidate: object) => (candidate === key ? '/workspaces/fake' : undefined),
    } as unknown as WorkspaceRegistry
    await activate(ctx, defaultConfig, { spawn: okSpawn() })
    // The provider reads the real injected registry, not the activation stub.
    ctx.set('workspaceCordis', fake)
    expect(ctx.workspaceEnvrc.workspaceForAgent(agent as unknown as Agent)).toBe('/workspaces/fake')
    expect(ctx.workspaceEnvrc.workspaceForAgent({ ctx: host } as unknown as Agent)).toBeUndefined()
  })
})
