/**
 * Reversible Bash adapter: applies the workspace's native direnv environment
 * to every Agent-owned `ctx.shell.resolve()` call.
 *
 * One wrapper projects the provider into the concrete `ctx.shell` target via
 * the public `dsh-workspace-overlay/method-wrapper`; it rewrites only
 * `request.command` and delegates every other field by reference. The
 * decision inputs are read at each call:
 *
 * - `ctx.workspaceEnvrc.bashEnabled` — disabled means the adapter stays
 *   installed but is permanently transparent;
 * - `ctx.agents.currentInitiator()` — absent (agentless/direct Shell calls)
 *   delegates unchanged, regardless of where the request's `workdir` points;
 * - `ctx.workspaceEnvrc.workspaceForAgent(agent)` — the canonical workspace
 *   root is resolved exclusively through scope ancestry; an unmapped Agent
 *   delegates unchanged. The wrapper never guesses a workspace from
 *   `workdir` or `session.header.cwd`.
 *
 * Disposal restores the exact previous method descriptor and is idempotent;
 * a successor wrapper installed on top survives an earlier dispose (HMR
 * safety). A throwing `currentInitiator()` (the agents service disposed out
 * of dependency order) propagates out of `resolve` — it is never swallowed.
 *
 * @module dsh-workspace-envrc/bash-adapter
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'
import { installMethodWrapper, type MethodWrapperHandle } from 'dsh-workspace-overlay/method-wrapper'

/** The adapter's disposal boundary. */
export interface WorkspaceEnvrcBashAdapterHandle {
  /** Restore the pre-install `resolve` descriptor. Idempotent; inert for successors. */
  dispose(): void
}

/**
 * Install the Bash adapter on the concrete `ctx.shell` provider target.
 *
 * The returned handle restores the exact pre-install `resolve` descriptor and
 * may be disposed any number of times (idempotent). Installing twice nests
 * two wrappers with the public method-wrapper's successor semantics: an
 * earlier handle's dispose never removes a later wrapper, and each handle
 * restores the state it found, so a full restoration disposes in reverse
 * install order.
 * @param ctx - composition context whose `shell`, `agents`, and
 *   `workspaceEnvrc` services the wrapper reads on every call.
 * @returns the adapter handle.
 */
export function installWorkspaceEnvrcBashAdapter(ctx: Context): WorkspaceEnvrcBashAdapterHandle {
  const handle: MethodWrapperHandle = installMethodWrapper(ctx.shell, 'resolve', (original, receiver, args) => {
    const request = args[0] as ShellExecRequest | undefined
    if (request === undefined) {
      return Reflect.apply(original, receiver, args)
    }
    if (!ctx.workspaceEnvrc.bashEnabled) {
      return Reflect.apply(original, receiver, args)
    }
    // currentInitiator() throws when the agents service has been disposed;
    // Cordis dependency-unload ordering surfaces that error here and it must
    // reach the caller unchanged rather than degrade into an unwrapped run.
    const agent: Agent | undefined = ctx.agents.currentInitiator()
    if (agent === undefined) {
      return Reflect.apply(original, receiver, args)
    }
    const canonicalWorkspace = ctx.workspaceEnvrc.workspaceForAgent(agent)
    if (canonicalWorkspace === undefined) {
      return Reflect.apply(original, receiver, args)
    }
    const command = ctx.workspaceEnvrc.wrapCommand(canonicalWorkspace, request.command, request.dshEnv ?? {})
    // Only `command` changes; every other field keeps its exact reference and
    // value, and the caller's request object is never mutated.
    return Reflect.apply(original, receiver, [{ ...request, command }])
  })
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      handle.dispose()
    },
  }
}
