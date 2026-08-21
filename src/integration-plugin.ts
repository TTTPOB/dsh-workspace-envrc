/**
 * Cordis function plugin wiring the workspace-envrc execution adapters into
 * the Host composition.
 *
 * Declares the Agent registry, shell provider, workspace registry, workspace
 * MCP manager, and workspaceEnvrc provider as required services. `apply`
 * installs the Bash adapter first and the workspace MCP adapter second inside
 * one effect. Fiber unload reverse-disposes MCP then Bash; a failed MCP
 * install rolls back the Bash adapter before propagating the error.
 *
 * Persistent terminals are deliberately outside this integration. DSH mounts
 * their `terminals` service inside preset-private isolated realms, while this
 * bundle is a Host profile layer. Supporting that path would require preset
 * augmentation against unstable internal mount APIs; see ADR 0001.
 *
 * @module dsh-workspace-envrc/integration-plugin
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installWorkspaceEnvrcBashAdapter } from './bash-adapter.js'
import { installWorkspaceEnvrcMcpAdapter, type WorkspaceEnvrcMcpAdapterHandle } from './mcp-adapter.js'

export const name = 'workspace-envrc-integration'

/** Activate once the Host services consumed by the Bash and MCP adapters exist. */
export const inject = [
  'agents',
  'shell',
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
    let mcpAdapter: WorkspaceEnvrcMcpAdapterHandle
    try {
      mcpAdapter = installWorkspaceEnvrcMcpAdapter(ctx)
    } catch (error) {
      bashAdapter.dispose()
      throw error
    }
    return () => {
      mcpAdapter.dispose()
      bashAdapter.dispose()
    }
  })
}
