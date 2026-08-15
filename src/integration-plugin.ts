/**
 * Cordis function plugin wiring the workspace-envrc execution adapters into
 * a composition.
 *
 * Declares `agents`, `shell`, and `workspaceEnvrc` as required services, so
 * the row activates only once the official agent registry, a shell provider,
 * and this bundle's provider all exist. `apply` installs the Bash adapter
 * inside an effect and reverse-disposes it on fiber unload (HMR safe). Block
 * C will extend this same installer with the persistent-terminal adapter —
 * no additional integration row is added.
 *
 * @module dsh-workspace-envrc/integration-plugin
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installWorkspaceEnvrcBashAdapter } from './bash-adapter.js'

export const name = 'workspace-envrc-integration'

/** Activate once the agent registry, the shell provider, and the workspaceEnvrc provider exist. */
export const inject = ['agents', 'shell', 'workspaceEnvrc']

/** No integration-local settings; feature switches belong to the provider row. */
export interface Config {}

export const Config = z.object({}) as z<Config>

export function apply(ctx: Context, _config: Config): void {
  ctx.effect(() => {
    const adapter = installWorkspaceEnvrcBashAdapter(ctx)
    return () => adapter.dispose()
  })
}
