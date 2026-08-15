/**
 * Reversible persistent-terminal adapter: applies the workspace's
 * native direnv environment to every explicitly owned
 * `ctx.terminals.spawn(owner, request, signal)` creation chain.
 *
 * The official terminal-bash backend resolves the final
 * `SubprocessTerminalSpawnSpec.env` (including `DSH_SESSION_ID` and
 * `DSH_PTY_SESSION_ID`) only AFTER it commits the argv through
 * `ctx.sandbox.confine(argv, policy)` — so the managed DSH_* snapshot is not
 * visible at wrap time. Instead of guessing from `process.env` in the Host,
 * the adapter replaces the incoming argv with the provider's deferred
 * managed-env chain ({@link WorkspaceEnvrc.wrapDeferredArgv}): an outer
 * capture shim records the exact DSH_* facts from the spawned process
 * environment, then runs `direnv exec <canonical-workspace>` and the
 * post-direnv restoration shim. The sandbox (when confined) therefore wraps
 * the WHOLE direnv chain and `.envrc` evaluation stays inside confinement.
 *
 * One operation-local context `{owner, canonical, wrapped}` is carried per
 * explicit `terminals.spawn` call through an `AsyncLocalStorage`, so
 * concurrent owners in different workspaces are isolated and unrelated
 * subprocess terminal spawns outside an explicit chain stay unchanged:
 *
 * - `ctx.terminals.spawn` — establishes the operation context across the
 *   whole returned creation promise; unmapped owners, absent owners, and
 *   `enableTerminal: false` delegate unchanged;
 * - `ctx.sandbox.confine` — while an operation is active and not yet wrapped,
 *   replaces the incoming argv with `wrapDeferredArgv(canonical, argv)`
 *   before delegating, then confirms `wrapped` so the final
 *   `spawnTerminal` never double-wraps; a throwing wrapper or confine
 *   propagates unchanged;
 * - `ctx.subprocess.spawnTerminal` — while an operation is active and not
 *   yet wrapped (danger-full-access or an unconfined backend never called
 *   `confine`), replaces only `spec.argv` with the deferred wrapper and
 *   delegates; `env`/`cwd`/`rows`/`cols`/`graceMs`/`signal` keep their exact
 *   references.
 *
 * Installation requires `ctx.sandbox` to exist (the integration row injects
 * it): a late optional provider could otherwise leave direnv wrapped outside
 * the sandbox. Disposal restores the three descriptors in reverse install
 * order (subprocess → sandbox → terminals), is idempotent, and never
 * clobbers a successor wrapper (HMR safety); a failing later install rolls
 * back the wrappers already mounted by this call. Disposing the adapter
 * never kills or restarts already-running terminals: their environment is
 * frozen at spawn, and only NEW terminal creations are direnv-wrapped.
 *
 * @module dsh-workspace-envrc/terminal-adapter
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
// Loads the @deepseek-ai/dsh-terminal declaration merging that registers
// `ctx.terminals`; the adapter installs a wrapper but consumes no value.
import type {} from '@deepseek-ai/dsh-terminal'
import { installMethodWrapper, type MethodWrapperHandle } from 'dsh-workspace-overlay/method-wrapper'

/** One explicit terminal creation chain's operation-local context. */
export interface TerminalOperation {
  /** The exact owner of the in-flight `terminals.spawn` call. */
  readonly owner: Agent
  /** The owner's canonical workspace, resolved exactly once at spawn time. */
  readonly canonical: string
  /**
   * Whether the argv was already committed to the deferred direnv wrapper
   * (by `sandbox.confine` or by `subprocess.spawnTerminal`), so the chain
   * never wraps twice.
   */
  wrapped: boolean
}

/** The operation-local storage; active only across an explicit spawn chain. */
const terminalOperationStore = new AsyncLocalStorage<TerminalOperation>()

/** The adapter's disposal boundary. */
export interface WorkspaceEnvrcTerminalAdapterHandle {
  /** Restore the pre-install descriptors. Idempotent; inert for successors. */
  dispose(): void
}

/**
 * Install the terminal adapter on the concrete provider targets.
 *
 * Wraps `ctx.terminals.spawn` (the operation context), `ctx.sandbox.confine`
 * (the argv commit seam, wrapping direnv INSIDE the sandbox), and
 * `ctx.subprocess.spawnTerminal` (the unconfined fallback seam). The
 * returned handle restores the exact pre-install descriptors in reverse
 * install order and may be disposed any number of times; with the public
 * method-wrapper's successor semantics an earlier dispose never removes a
 * later wrapper.
 * @param ctx - composition context whose `terminals`, `sandbox`, `subprocess`,
 *   and `workspaceEnvrc` services the wrappers read on every call.
 * @returns the adapter handle.
 */
export function installWorkspaceEnvrcTerminalAdapter(ctx: Context): WorkspaceEnvrcTerminalAdapterHandle {
  const spawnHandle: MethodWrapperHandle = installMethodWrapper(ctx.terminals, 'spawn', (original, receiver, args) => {
    if (!ctx.workspaceEnvrc.terminalEnabled) {
      return Reflect.apply(original, receiver, args)
    }
    const owner = args[0] as Agent | undefined
    if (owner === undefined) {
      return Reflect.apply(original, receiver, args)
    }
    // A throwing workspaceForAgent (the workspace registry disposed out of
    // dependency order) propagates unchanged rather than degrading into an
    // unwrapped spawn.
    const canonical = ctx.workspaceEnvrc.workspaceForAgent(owner)
    if (canonical === undefined) {
      return Reflect.apply(original, receiver, args)
    }
    const operation: TerminalOperation = { owner, canonical, wrapped: false }
    // The context stays active across the whole returned creation promise:
    // every confine/spawnTerminal call the backend makes inside this spawn
    // chain observes the exact same operation object.
    return terminalOperationStore.run(operation, () => Reflect.apply(original, receiver, args))
  })
  let confineHandle: MethodWrapperHandle
  try {
    confineHandle = installMethodWrapper(ctx.sandbox, 'confine', (original, receiver, args) => {
      const operation = terminalOperationStore.getStore()
      if (operation === undefined || operation.wrapped) {
        return Reflect.apply(original, receiver, args)
      }
      const argv = args[0] as readonly string[] | undefined
      const policy = args[1] as SandboxPolicy | undefined
      if (argv === undefined || policy === undefined) {
        return Reflect.apply(original, receiver, args)
      }
      // A validation failure in the deferred wrapper propagates unchanged, so
      // a bad canonical workspace fails the spawn instead of running unwrapped.
      const wrappedArgv = ctx.workspaceEnvrc.wrapDeferredArgv(operation.canonical, argv)
      const result = Reflect.apply(original, receiver, [wrappedArgv, policy, ...args.slice(2)])
      operation.wrapped = true
      return result
    })
  } catch (error) {
    // Partial-install rollback: a failing sandbox wrapper must not leave the
    // terminals.spawn wrapper mounted behind it.
    spawnHandle.dispose()
    throw error
  }
  let spawnTerminalHandle: MethodWrapperHandle
  try {
    spawnTerminalHandle = installMethodWrapper(
      ctx.subprocess,
      'spawnTerminal',
      (original, receiver, args) => {
        const operation = terminalOperationStore.getStore()
        if (operation === undefined || operation.wrapped) {
          return Reflect.apply(original, receiver, args)
        }
        const spec = args[0] as SubprocessTerminalSpawnSpec | undefined
        if (spec === undefined) {
          return Reflect.apply(original, receiver, args)
        }
        const argv = ctx.workspaceEnvrc.wrapDeferredArgv(operation.canonical, spec.argv)
        operation.wrapped = true
        // Only argv changes; env/cwd/rows/cols/graceMs/signal keep their exact
        // references, and the caller's spec object is never mutated.
        return Reflect.apply(original, receiver, [{ ...spec, argv }, ...args.slice(1)])
      },
    )
  } catch (error) {
    confineHandle.dispose()
    spawnHandle.dispose()
    throw error
  }
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      // Reverse install order: subprocess -> sandbox -> terminals.
      spawnTerminalHandle.dispose()
      confineHandle.dispose()
      spawnHandle.dispose()
    },
  }
}
