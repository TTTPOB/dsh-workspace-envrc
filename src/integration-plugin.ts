/**
 * Cordis function plugin wiring the workspace-envrc execution adapters into
 * a composition.
 *
 * Declares `agents`, `shell`, `sandbox`, `subprocess`, `terminals`, and
 * `workspaceEnvrc` as required services, so the row activates only once the
 * official agent registry, a shell provider, a sandbox provider, a subprocess
 * provider, the PTY registry, and this bundle's provider all exist. `apply`
 * installs the Bash adapter first and the persistent-terminal adapter second
 * inside one effect, so fiber unload (HMR safe) disposes terminal-first then
 * Bash; if the terminal adapter fails to install, the Bash adapter is rolled
 * back before the error propagates. Requiring `ctx.sandbox` up front (never a
 * late optional provider) guarantees direnv is always wrapped INSIDE the
 * sandbox when one is mounted.
 *
 * @module dsh-workspace-envrc/integration-plugin
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installWorkspaceEnvrcBashAdapter } from './bash-adapter.js'
import {
  installWorkspaceEnvrcTerminalAdapter,
  type WorkspaceEnvrcTerminalAdapterHandle,
} from './terminal-adapter.js'

export const name = 'workspace-envrc-integration'

/** Activate once the agent/shell/sandbox/subprocess/PTY registries and the workspaceEnvrc provider exist. */
export const inject = ['agents', 'shell', 'sandbox', 'subprocess', 'terminals', 'workspaceEnvrc']

/** No integration-local settings; feature switches belong to the provider row. */
export interface Config {}

export const Config = z.object({}) as z<Config>

export function apply(ctx: Context, _config: Config): void {
  ctx.effect(() => {
    const bashAdapter = installWorkspaceEnvrcBashAdapter(ctx)
    let terminalAdapter: WorkspaceEnvrcTerminalAdapterHandle
    try {
      terminalAdapter = installWorkspaceEnvrcTerminalAdapter(ctx)
    } catch (error) {
      // Partial-install rollback: a failing terminal adapter must not leave
      // the Bash adapter mounted behind it.
      bashAdapter.dispose()
      throw error
    }
    return () => {
      // Reverse install order: terminal adapter first, then the Bash adapter.
      terminalAdapter.dispose()
      bashAdapter.dispose()
    }
  })
}
