# dsh-workspace-envrc

> **Languages / docs**: this is the English version of the project README; the Chinese original is [`../README.md`](../README.md). The implementation plan (in Chinese) is at [`implementation-plan.md`](./implementation-plan.md).

An out-of-tree DSH bundle that applies the local machine's native direnv environment to explicitly Agent/workspace-owned Bash executions (foreground and background) and persistent terminal creation. The plugin delegates discovery, `.envrc` evaluation, authorization hashes, `allow`/`deny`, stdlib behavior, and environment mutation to the installed `direnv` executable — it never parses or sources `.envrc`, never maintains an authorization database, never calls `direnv allow`/`permit`/`grant`/`edit`, never uses `direnv export`, never watches or caches any `.envrc`, never mutates the Harness process's `process.env`, and exposes no allow/deny tool to models. Authorization always happens on the user's side, outside DSH, with `direnv allow <exact .envrc>`.

Target DSH: `0.1.0-rc.6`. Runtime peers include `@deepseek-ai/cordis` 4.0.1, `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-scope` / `@deepseek-ai/dsh-shell` / `@deepseek-ai/dsh-sandbox` / `@deepseek-ai/dsh-subprocess` / `@deepseek-ai/dsh-terminal` / `@deepseek-ai/dsh-timeout` 0.1.0-rc.6, and `dsh-workspace-overlay` ^0.1.0; `@deepseek-ai/schemastery` follows the actual identity policy as a plain dependency (the same declaration DSH's own packages and the sibling `dsh-workspace-overlay` repository use). All versions match the installed release.

## Current state

Everything is implemented and covered by tests: the `workspaceEnvrc` provider core, the reversible Bash adapter, the persistent-terminal adapter, the integration row, and two real-composition test paths (a real `direnv` allow/deny/content-change state machine, and a real Cordis Loader composing the built `dist` provider/integration rows). The implementation plan [`implementation-plan.md`](./implementation-plan.md) is marked **implemented**, and its completion criteria are met (except the final GitHub publication; see §10 of the plan). This README describes the current implementation facts and no longer narrates the work in historical blocks.

## Dependencies and installation

- This bundle is an independent repository that depends on the `dsh-workspace-overlay` bundle: `workspaceCordis` (canonical workspace identity and scope mapping) and the public `dsh-workspace-overlay/method-wrapper` (reversible method decoration).
- **Install the overlay bundle first, then this bundle.** This bundle's patch (`cordis.patch.yml`) inserts only its own two rows (the provider row and the integration row) and **never inserts overlay rows automatically** — the overlay rows come from the overlay bundle's own patch, and `dsh plugin add` never rewrites a profile across bundles.
- **The host must already have direnv installed**: activation preflight runs `direnv version`. This bundle neither installs direnv nor calls `direnv allow`; `.envrc` authorization is done manually outside DSH (see "Native direnv semantics").

```sh
# 1) install the workspace overlay bundle first (provides workspaceCordis and method-wrapper)
dsh plugin --profile web add /path/to/dsh-workspace-overlay
# 2) then install this bundle
dsh plugin --profile web add /path/to/dsh-workspace-envrc
# 3) verify the final composition: this bundle's two rows and the full config are visible
dsh --profile web --dump-config
```

To uninstall: `dsh plugin --profile web remove dsh-workspace-envrc` (the overlay stays in place; without this bundle's wrappers, Bash and terminals return to their native unwrapped behavior).

## Native direnv semantics

- **Fixed canonical workspace root lookup**: the workspace comes exclusively from the initiating Agent's scope mapping — start at `scopeOf(agent.ctx)` and walk `scopeParentOf`, asking `workspaceCordis.workspaceForScope` at every key, first hit wins (covers agent→preset→workspace chains); V1 never selects nested `.envrc` files from a per-command `workdir`, and never reads `session.header.cwd`.
- **`direnv exec DIR` does not chdir**: the environment is loaded for the canonical root while the child's cwd stays where the caller (the Bash request's `workdir` / the terminal backend's resolved cwd) put it.
- **No `.envrc` → passthrough**: when no `.envrc`/`.env` applies, native direnv executes with the inherited environment unchanged; there is no plugin-level fallback branch.
- **Blocked / denied / changed content**: when the `.envrc` is not allowed, has been denied, or changed after `direnv allow` so the native hash is invalid, native direnv refuses the execution and its original stderr/exit status reaches the Bash or terminal caller; the original program never runs.
- **Authorization happens outside DSH**: the user runs `direnv allow <exact .envrc>` manually in a local terminal under the same OS account that runs DSH; until re-allowed, later executions keep failing. DSH has no allow/deny/edit entry point.
- **The plugin never calls**: `direnv allow`/`permit`/`grant`/`edit`, `direnv export`, any parse/source/hash/watch/cache of `.envrc`, or any read/write of `process.env`. **No allow/deny tool is exposed to models.**

## Execution semantics

### Bash (foreground and background)

- Every execution is a **new process** (foreground or `run_in_background`); the environment snapshot freezes when the process starts, and no long-lived shell is reused.
- `ctx.shell.resolve` is decorated: when `bashEnabled` is false, when `ctx.agents.currentInitiator()` is absent (agentless/direct Shell calls), or when `workspaceEnvrc.workspaceForAgent(agent)` is unmapped, the call passes through unchanged — even when `workdir` lies inside a mapped workspace, nothing is guessed.
- When mapped, only `request.command` is replaced with `exec <direnv> exec <canonical-root> <managed-env-shim> <original>`; every other field (`workdir`/timeout/stdoutMaxBytes/signal/stdin/env/dshEnv/sandboxPolicy) keeps its exact reference and value, and the caller's request object is never mutated.
- In the background path the `jobs.start` run starter (synchronous) calls `ctx.shell.resolve` inside the inherited initiator context and still sees the exact initiating Agent and its canonical workspace — not a coincidental workdir.
- With sandboxing on, the whole wrapped chain (including `.envrc` evaluation) runs inside the executor's confine.

### Terminal

- Ownership is explicit: only `ctx.terminals.spawn(owner, request, signal)` creation chains are affected; when `terminalEnabled` is false, the owner is missing, or `workspaceForAgent(owner)` is unmapped, the call is delegated unchanged (no operation context is established).
- Each spawn chain carries one operation-local `AsyncLocalStorage` context `{owner, canonical, wrapped}` across the whole unpublished creation chain (including the returned promise), so concurrent owners stay isolated.
- **Deferred wrapper before confine**: `ctx.sandbox.confine(argv, policy)` (terminal-bash's argv commit seam) receives the deferred envrc wrapper — the sandbox wraps the whole direnv chain and `.envrc` evaluation stays inside confinement; a throwing wrapper/confine propagates unchanged.
- **danger-full-access final fallback**: `danger-full-access` or a backend that never calls `confine` reaches `ctx.subprocess.spawnTerminal`, which replaces only `spec.argv` with the deferred wrapper; a chain is never wrapped twice, and direct calls outside a spawn chain pass through unchanged.
- **DSH final environment capture**: the backend builds the final `SubprocessTerminalSpawnSpec.env` (including `DSH_SESSION_ID`/`DSH_PTY_SESSION_ID`) only AFTER the confine seam, so the outer capture shim enumerates the Bash 3.2+-compatible `${!DSH_*}` from ITS OWN process environment (the exact environment the subprocess provider merged from the final spec) before direnv, then execs `<direnv> exec <canonical>` plus the post-direnv restoration shim (deletes every post-direnv `DSH_*`, restores the captured exact snapshot, execs the original argv).
- **New-terminal snapshot**: the environment is frozen at spawn; **already-running terminals stay untouched** — adapter disposal never kills or restarts processes, in-flight creations are never killed, and only NEW terminals re-run direnv.
- The interactive `cd` hook is **not emulated**: in-terminal directory changes are handled by the user shell's own direnv hook.

## Environment safety

- Ordinary environment variables (including credential-shaped variables an allowed `.envrc` explicitly exports) follow native direnv semantics: once the user allows the file, those variables enter the process environment and are **readable by the model** — a deliberate consequence of the user's native `direnv allow`.
- `DSH_*` ownership: after direnv evaluation the shim deletes every `DSH_*` variable in the environment and restores only this request's exact managed snapshot (the terminal path's deferred capture records the exact snapshot from the spawned process environment before direnv). Managed names are strictly `DSH_[A-Z0-9_]+` with string values; values travel through argv, never spliced into the script.
- **`BASH_ENV`/`ENV` are explicit exceptions**: the post-direnv shim and original program run after `env -u BASH_ENV -u ENV`, so neither sees values direnv sets for these controls. The Bash tool's existing outer executor shell and direnv's own evaluation shell may still read an ambient `BASH_ENV` supplied before this plugin's chain starts; the plugin does not carry that Host input into the post-direnv segment. The terminal deferred argv removes both controls from its outermost wrapper. A plain direnv shell does not remove them, so this is a documented difference.
- **Preflight checks version and real shim semantics, never `.envrc`**: activation runs `direnv version`, then executes one real `DSH_*` clear/restore probe under the configured shell. Both children are bounded, use no `shell: true`, execute or read no workspace `.envrc`, and never mutate `process.env`. The probe also validates the Bash 3.2+-compatible `${!DSH_*}` behavior; failure messages carry only the stage and executable/path, never child stdout/stderr, environment, or secrets.
- **The sandbox must be able to read the native allow database**: direnv validates authorization inside confinement. If a deployment puts `XDG_DATA_HOME` somewhere the sandbox masks (for example `/tmp` under the local bwrap profile's tmpfs), direnv inside the sandbox treats an externally allowed `.envrc` as blocked; keep direnv authorization state in a persistent sandbox-readable directory.
- Diagnostics and errors never print stdout/stderr, environment, or secrets; the public API accepts and returns nothing sensitive beyond the environment projections.

## Failure and lifecycle boundaries

- **Activation failure**: a missing/unusable direnv, an invalid shim shell, or a preflight timeout fails the provider activation loudly, and no adapter is installed.
- **Blocked/denied/changed content**: the original program does not run and the native error reaches the caller; the Agent, the workspace lease, and the plugin stay alive.
- **HMR/dispose**: the exact previous method descriptors are restored (idempotent; an earlier dispose never removes a later wrapper, and full restoration disposes in reverse install order); already-spawned processes keep their environment and process owner and are never killed solely because a decorator unloads.
- **Overlay disposed before this plugin**: later Agent lookups delegate unchanged (unmapped) or fail through the ordinary workspace lifecycle; no cached workspace path outlives the mapping.
- **Concurrency**: Agents and terminal creations in different workspaces get independent native direnv evaluations with no cross-talk.
- **Composition requirement**: the single integration row injects `agents`, `shell`, `sandbox`, `subprocess`, `terminals`, and `workspaceEnvrc` together, ensuring the terminal direnv chain can never land outside a late sandbox. If any service is absent the whole row stays pending and the Bash adapter is not installed separately, even with `enableTerminal: false`.
- **Not covered**: Workspace MCP, global MCP, LSP, subagent providers, and generic `ctx.subprocess.spawn()` calls stay explicitly out of scope (the full non-goal list is in [`implementation-plan.md`](./implementation-plan.md) §8). **Windows is unsupported** (activation fails).
- **No watcher / no auto restart**: this bundle watches no files (including `.envrc` — content changes are rejected by the native hash on the next execution); a `.envrc` change never automatically restarts a running background job or terminal.

## Config

The `workspaceEnvrc` provider row's schema (schema + semantic validation, implemented in `dsh-workspace-envrc/core`):

| Field | Default | Constraint |
|---|---|---|
| `executable` | `direnv` | non-empty, NUL-free; a PATH command or an absolute path |
| `shimShell` | `/bin/bash` | absolute path, NUL-free |
| `enableBash` | `true` | boolean; when false the Bash adapter may stay installed but is permanently transparent |
| `enableTerminal` | `true` | boolean; when false the terminal adapter may stay installed but is permanently transparent |
| `versionCheckTimeoutMs` | `5000` | positive integer ≤ `MAX_TIMER_DELAY_MS` |

Readonly `bashEnabled`/`terminalEnabled` getters serve the adapters; no mutable config handle is exposed. A third constructor argument is an injectable preflight spawn seam for deterministic tests (never part of the Config schema).

## API and exports

- Root export `dsh-workspace-envrc` (`dist/provider.js`, default export `WorkspaceEnvrc extends Service`): `workspaceForAgent(agent)`, `wrapArgv(canonicalWorkspace, originalArgv, dshEnv?)`, `wrapCommand(canonicalWorkspace, originalCommand, dshEnv?)`, `wrapDeferredArgv(canonicalWorkspace, originalArgv)` (the terminal deferred-capture chain), readonly `bashEnabled`/`terminalEnabled` getters.
- `dsh-workspace-envrc/core`: `defaultConfig`, `assertWorkspaceEnvrcConfig`, `managedEnvPairs`, `buildManagedEnvShimArgv`, `buildExecArgv`, `buildDeferredManagedExecArgv`, `DEFERRED_ENV_CAPTURE_SCRIPT`, `DEFERRED_ENV_SHIM_LABEL`, `shq`, `wrapCommand`, `resolveAgentWorkspace`, `runPreflight`, `assertPosixPlatform`, `PreflightError`, and the related types. All are framework-free pure functions.
- `dsh-workspace-envrc/bash-adapter`: `installWorkspaceEnvrcBashAdapter(ctx)` and `WorkspaceEnvrcBashAdapterHandle`.
- `dsh-workspace-envrc/terminal-adapter`: `installWorkspaceEnvrcTerminalAdapter(ctx)` and `WorkspaceEnvrcTerminalAdapterHandle` (the operation-local AsyncLocalStorage context is internal).
- `dsh-workspace-envrc/integration-plugin`: `name`/`inject`/`Config`/`apply` (function plugin, no default).
- `dsh-workspace-envrc/cordis.patch.yml`: the bundle patch (two rows; see "Dependencies and installation").

## Development

```sh
pnpm install        # repository-local store (see .npmrc)
pnpm test           # full vitest suite (builds dist first)
pnpm typecheck      # strict typecheck of src + tests
pnpm build          # tsc -> dist
```

Tests never read or write the real user's direnv authorization state: `tests/direnv-native.spec.ts` drives the full allow/deny/content-change state machine and the deferred terminal wrapper through the real `direnv`, with all authorization state confined to repo-internal isolated `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`HOME` (under `.artifacts/`, gitignored); the shim script and the wrapped command run through real child processes with explicit isolated environments (no `process.env` mutation); the background path is verified through the real AgentRegistry + ToolRuntime + tool-bash + jobs provider; the terminal path through the real TerminalSessionService + terminal-bash + SandboxPolicyService; `tests/loader-composition.spec.ts` composes the built `dist` provider/integration rows with real DSH services and overlay dependencies through a real Cordis Loader reading a test `cordis.yml`.

## Security and trust boundary

- Authorization always happens on the user's native direnv side, outside DSH (`direnv allow` belongs to the user); changing an allowed `.envrc` invalidates the native hash and blocks later executions until the user re-allows. DSH has no allow/deny/edit entry point, and no allow/deny tool is exposed to models.
- Every enabled execution is shaped as `direnv exec <canonical-root> <managed-env-shim> <original>`: evaluation and the command share one process tree (inside the executor's/terminal's confine when sandboxing is on); `DSH_*` ownership is restored after evaluation (the terminal path's deferred capture supplies the exact snapshot before spawn); `BASH_ENV`/`ENV` are control-variable exceptions absent from the post-direnv segment and original program (see the outer Bash executor's ambient-startup behavior above); every other ordinary variable (including credential-shaped variables an allowed `.envrc` explicitly exports) follows native direnv semantics.
- Diagnostics and errors contain only the stage, the executable path, and exit facts — never stdout/stderr, environment, or secrets; the public API accepts and returns nothing sensitive beyond the environment projections.

## License

MIT, see [LICENSE](../LICENSE).
