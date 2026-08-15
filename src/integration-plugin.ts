/**
 * Cordis function plugin wiring the workspace-envrc execution adapters into
 * a composition.
 *
 * Declares `agents`, `shell`, `sandbox`, `subprocess`, `terminals`,
 * `workspaceCordis`, `workspaceMcp`, and `workspaceEnvrc` as required
 * services, so the row activates only once the official agent registry, a
 * shell provider, a sandbox provider, a subprocess provider, the PTY
 * registry, the workspace registry (the MCP adapter's scope authority), the
 * workspace MCP manager, and this bundle's provider all exist. `apply`
 * installs the Bash adapter first, the persistent-terminal adapter second,
 * and the workspace MCP adapter third inside one effect, so fiber unload
 * (HMR safe) disposes MCP-first then terminal then Bash; a failing later
 * install rolls back every adapter already mounted by this call before the
 * error propagates. Requiring `ctx.sandbox` up front (never a late optional
 * provider) guarantees direnv is always wrapped INSIDE the sandbox when one
 * is mounted.
 *
 * @module dsh-workspace-envrc/integration-plugin
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installWorkspaceEnvrcBashAdapter } from './bash-adapter.js'
import { installWorkspaceEnvrcMcpAdapter, type WorkspaceEnvrcMcpAdapterHandle } from './mcp-adapter.js'
import {
  installWorkspaceEnvrcTerminalAdapter,
  type WorkspaceEnvrcTerminalAdapterHandle,
} from './terminal-adapter.js'

export const name = 'workspace-envrc-integration'

/** Activate once the agent/shell/sandbox/subprocess/PTY/registry/MCP services and the workspaceEnvrc provider exist. */
export const inject = [
  'agents',
  'shell',
  'sandbox',
  'subprocess',
  'terminals',
  'workspaceCordis',
  'workspaceMcp',
  'workspaceEnvrc',
]

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
    let mcpAdapter: WorkspaceEnvrcMcpAdapterHandle
    try {
      mcpAdapter = installWorkspaceEnvrcMcpAdapter(ctx)
    } catch (error) {
      // Partial-install rollback: a failing MCP adapter must not leave the
      // Bash and terminal adapters mounted behind it.
      terminalAdapter.dispose()
      bashAdapter.dispose()
      throw error
    }
    return () => {
      // Reverse install order: MCP adapter first, then terminal, then Bash.
      mcpAdapter.dispose()
      terminalAdapter.dispose()
      bashAdapter.dispose()
    }
  })
}
