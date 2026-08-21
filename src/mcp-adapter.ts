/**
 * Reversible workspace MCP adapter: applies the workspace's native direnv
 * environment to local stdio workspace MCP rows.
 *
 * One wrapper projects the provider into the concrete `ctx.workspaceMcp`
 * target via the public `dsh-workspace-overlay/method-wrapper`; it rewrites
 * only `command`/`args` of the row config and delegates every other field by
 * reference. Classification is authoritative and scope-based, read at each
 * `activate(rowCtx, rawConfig)` call:
 *
 * - `ctx.workspaceEnvrc.workspaceMcpEnabled` false — the adapter stays
 *   installed but is permanently transparent;
 * - `rowCtx` not a Cordis Context, or the raw config argument missing —
 *   delegate unchanged, so the manager's own argument handling decides;
 * - `scopeOf(rowCtx) === undefined` — a global MCP row (one shared process
 *   across workspaces); delegate unchanged with the raw config object
 *   identity untouched. A global process cannot safely consume one caller
 *   workspace's environment;
 * - a scope key mapped by `ctx.workspaceCordis.workspaceForScope(key)` — a
 *   workspace MCP row; its canonical root is the direnv lookup directory;
 * - any other scoped row (preset or foreign scope) — delegate unchanged and
 *   let the manager's own validation reject the invalid placement;
 * - the raw config is a legal stdio shape (`transport === 'stdio'`, a
 *   non-empty string `command`, and omitted `args` or a `string[]`) — replace only
 *   `command` and `args` with the provider's wrapped argv; streamable HTTP
 *   rows (no local child) and malformed configs pass through unchanged, so
 *   the manager schema still produces its original error.
 *
 * MCP transport environment correction: the MCP SDK's stdio transport spawns
 * with `{...scrubbedParentEnv(), ...config.env}` — the ambient `DSH_*`
 * namespace is scrubbed before the child exists and there is NO Harness
 * managed snapshot for an MCP child. The wrapped argv therefore carries an
 * EMPTY managed snapshot (`wrapArgv(canonical, [command, ...args], {})`):
 * after native direnv evaluation the
 * restoration shim deletes every `DSH_*` the environment still carries
 * (including names a workspace config or an allowed `.envrc` explicitly
 * exported — DSH must never be able to forge the Harness namespace) and
 * restores nothing, while ordinary config env and `.envrc` exports follow
 * native direnv semantics. The caller's raw config object is never mutated;
 * the manager still resolves workspace cwd and owns connection, process,
 * tool, mask, retry, and teardown lifecycles.
 *
 * Disposal restores the exact previous method descriptor and is idempotent;
 * a successor wrapper installed on top survives an earlier dispose (HMR
 * safety). A throwing `wrapArgv` (invalid canonical workspace) propagates
 * unchanged rather than degrading into an unwrapped run; the manager's
 * returned promise and rejected/ thrown errors pass through untouched.
 *
 * @module dsh-workspace-envrc/mcp-adapter
 */
import { Context } from '@deepseek-ai/cordis'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
// Side-effect type imports: declaration-merge `ctx.workspaceCordis` (the
// overlay registry) and `ctx.workspaceMcp` (the overlay MCP manager) onto
// Context. No value from either module is ever imported.
import type WorkspaceMcpManager from 'dsh-workspace-overlay/mcp/manager'
import type WorkspaceRegistry from 'dsh-workspace-overlay'
import { installMethodWrapper, type MethodWrapperHandle } from 'dsh-workspace-overlay/method-wrapper'

/** The adapter's disposal boundary. */
export interface WorkspaceEnvrcMcpAdapterHandle {
  /** Restore the pre-install `activate` descriptor. Idempotent; inert for successors. */
  dispose(): void
}

/** The legal stdio shape the adapter wraps; omitted args use the manager default. */
interface LegalStdioConfig {
  transport: 'stdio'
  command: string
  args?: string[]
}

/** Narrow the raw config to the legal stdio shape without validating anything else. */
function isLegalStdioConfig(rawConfig: unknown): rawConfig is LegalStdioConfig & Record<string, unknown> {
  if (typeof rawConfig !== 'object' || rawConfig === null) return false
  const record = rawConfig as Record<string, unknown>
  if (record.transport !== 'stdio') return false
  if (typeof record.command !== 'string' || record.command.length === 0) return false
  if (record.args === undefined) return true
  if (!Array.isArray(record.args)) return false
  return record.args.every((arg) => typeof arg === 'string')
}

/**
 * Install the workspace MCP adapter on the concrete `ctx.workspaceMcp`
 * provider target.
 *
 * The returned handle restores the exact pre-install `activate` descriptor
 * and may be disposed any number of times (idempotent). Installing twice
 * nests two wrappers with the public method-wrapper's successor semantics:
 * an earlier handle's dispose never removes a later wrapper, and each handle
 * restores the state it found, so a full restoration disposes in reverse
 * install order.
 * @param ctx - composition context whose `workspaceMcp`, `workspaceCordis`,
 *   and `workspaceEnvrc` services the wrapper reads on every call.
 * @returns the adapter handle.
 */
export function installWorkspaceEnvrcMcpAdapter(ctx: Context): WorkspaceEnvrcMcpAdapterHandle {
  const handle: MethodWrapperHandle = installMethodWrapper(
    ctx.workspaceMcp,
    'activate',
    (original, receiver, args) => {
      if (!ctx.workspaceEnvrc.workspaceMcpEnabled) {
        return Reflect.apply(original, receiver, args)
      }
      const rowCtx = args[0]
      if (rowCtx === undefined || !Context.is(rowCtx) || args.length < 2) {
        return Reflect.apply(original, receiver, args)
      }
      const scope: ScopeKey | undefined = scopeOf(rowCtx)
      if (scope === undefined) {
        // Global row: raw config identity and bytes pass through unchanged.
        return Reflect.apply(original, receiver, args)
      }
      // A throwing workspaceForScope (the registry disposed out of dependency
      // order) propagates unchanged rather than degrading into an unwrapped run.
      const canonical = ctx.workspaceCordis.workspaceForScope(scope)
      if (canonical === undefined) {
        // Unmapped/preset/foreign scope: the manager's own validation rejects
        // the placement; the wrapper must not preempt its error.
        return Reflect.apply(original, receiver, args)
      }
      const rawConfig = args[1]
      if (!isLegalStdioConfig(rawConfig)) {
        // streamable-http (no local child) and malformed configs pass
        // through, so the manager schema produces its original error.
        return Reflect.apply(original, receiver, args)
      }
      // The MCP child's final env is `{...scrubbedParentEnv(), ...config.env}`:
      // ambient DSH_* is already gone and there is no Harness managed
      // snapshot, so the wrapped argv carries an EMPTY managed snapshot —
      // after direnv every DSH_* is deleted and nothing is restored, while
      // ordinary config env / .envrc exports follow native direnv semantics.
      const wrappedArgv = ctx.workspaceEnvrc.wrapArgv(
        canonical,
        [rawConfig.command, ...(rawConfig.args ?? [])],
        {},
      )
      // Only command/args change; every other field keeps its exact reference
      // and value, and the caller's raw config object is never mutated.
      const nextConfig = { ...rawConfig, command: wrappedArgv[0]!, args: wrappedArgv.slice(1) }
      return Reflect.apply(original, receiver, [rowCtx, nextConfig, ...args.slice(2)])
    },
  )
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      handle.dispose()
    },
  }
}
