# dsh-workspace-envrc

> **Languages / docs**: this is the English version of the project README; the Chinese original is [`../README.md`](../README.md). The implementation plan (in Chinese) is at [`implementation-plan.md`](./implementation-plan.md).

Out-of-tree DSH bundle that applies the local machine's native direnv environment to explicitly Agent/workspace-owned Bash executions and persistent terminals. The plugin delegates discovery, `.envrc` evaluation, authorization hashes, `allow`/`deny`, stdlib behavior, and environment mutation to the installed `direnv` executable — it never parses or sources `.envrc`, never maintains an authorization database, never calls `direnv allow`, and never mutates the Harness process's `process.env`.

Target DSH: `0.1.0-rc.6`. Runtime peers include `@deepseek-ai/cordis` 4.0.1, `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-scope` / `@deepseek-ai/dsh-shell` / `@deepseek-ai/dsh-timeout` 0.1.0-rc.6, and `dsh-workspace-overlay` ^0.1.0; `@deepseek-ai/schemastery` follows the actual identity policy as a plain dependency (the same declaration DSH's own packages and the sibling `dsh-workspace-overlay` repository use). All versions match the installed release.

## Current status (Block A provider core + Block B Bash adapter)

This repository is implemented in blocks per [`implementation-plan.md`](./implementation-plan.md). **Block A (package skeleton and the `workspaceEnvrc` provider core) and Block B (the reversible Bash adapter) are done**; Block C (persistent-terminal adapter) and Block D (real Loader composition, real direnv allow/deny verification, release audit) remain.

- `ctx.workspaceEnvrc` (`WorkspaceEnvrc extends Service`, default export, `static inject = ['agents', 'workspaceCordis']`).
- Strict Config (schema + semantic validation): `executable` (default `direnv`; non-empty, NUL-free, a PATH command or an absolute path), `shimShell` (default `/bin/bash`; must be absolute), `enableBash`/`enableTerminal` (default `true`), `versionCheckTimeoutMs` (default `5000`; a positive integer no greater than `MAX_TIMER_DELAY_MS`). Readonly `bashEnabled`/`terminalEnabled` getters serve the adapters; no mutable config handle is exposed.
- Bounded activation preflight (strictly awaited inside `[Service.init]`; the service is not ready before init completes): `direnv version` and `<shimShell> --noprofile --norc -c 'exit 0'` — no `shell: true`, no workspace `.envrc` executed or read, no `process.env` mutation. Failure messages carry only the stage and the executable/path, never child stdout/stderr, environment, or secrets; the child is always reaped on timeout, abort, and init rollback (`done` is always awaited — no unhandled rejections). V1 is POSIX-only; Windows fails at activation. A third constructor argument is an injectable preflight spawn seam for deterministic tests (never part of the Config schema).
- Agent→workspace resolution: start at `scopeOf(agent.ctx)` and walk `scopeParentOf`, asking `workspaceCordis.workspaceForScope` at every key, first hit wins (covers agent→preset→workspace chains); unscoped or unmapped agents yield `undefined`. No `session.header.cwd`, no cwd guessing, no import of the overlay's private coordinator.
- Pure wrapper core (`dsh-workspace-envrc/core`): `direnv exec <canonical-workspace> <managed-env-shim> <original argv>`; the managed shim runs after direnv as `env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c SCRIPT label count name value... original argv`, the SCRIPT deletes every `${!DSH_@}` variable, restores only the request's exact managed `DSH_*` snapshot, then execs the original program; values travel through argv, never spliced into the script; managed names are validated strictly (`DSH_[A-Z0-9_]+`, string values). `wrapCommand` produces a POSIX-safe command (every dynamic argv element single-quoted; `'` and newlines handled, NUL rejected) that replaces only `request.command` — workdir, env, dshEnv, and everything else survive. The workspace is fixed at the canonical root; V1 never selects nested `.envrc` files from a per-command workdir.
- **Block B: the Bash adapter (`dsh-workspace-envrc/bash-adapter`).** `installWorkspaceEnvrcBashAdapter(ctx)` reversibly decorates `resolve` on the concrete `ctx.shell` provider target through the public `dsh-workspace-overlay/method-wrapper`, returning an idempotent dispose handle (restores the exact prior descriptor; under double install an earlier handle's dispose never removes a later wrapper, and full restoration disposes in reverse install order). Per call: `bashEnabled` false → passthrough; no `ctx.agents.currentInitiator()` (agentless/direct Shell calls) → passthrough; `workspaceEnvrc.workspaceForAgent(agent)` unmapped → passthrough; mapped → only `request.command` is replaced with `wrapCommand(canonical, command, request.dshEnv ?? {})` while every other field (workdir/timeout/stdoutMaxBytes/signal/stdin/env/dshEnv/sandboxPolicy) keeps its exact reference and value, and the caller's request object is never mutated. `Reflect.apply(original, receiver, ...)` preserves the trace receiver (`this.ctx` inside the original resolver still names the caller's context). The workspace comes exclusively from the Agent's scope mapping — never guessed from `workdir` or `session.header.cwd`. A throwing `currentInitiator()` (agents service disposed out of dependency order) propagates out of `resolve` unchanged.
- **Block B: the integration row (`dsh-workspace-envrc/integration-plugin`).** A function plugin (named exports `name`/`inject`/`apply`, no default), `inject = ['agents', 'shell', 'workspaceEnvrc']`; `ctx.effect` installs the adapter and reverse-disposes it on fiber unload (HMR safe). `cordis.patch.yml` contains the `workspace-envrc` provider row and the single `workspace-envrc-integration` row; Block C will extend the same integration installer — no additional integration row. With `enableBash: false` the adapter may stay installed but is permanently transparent.

**Execution semantics (proven by tests)**:

- Foreground and `run_in_background` both go through the same resolve wrapper: in the background path the `jobs.start` run starter (synchronous) calls `ctx.shell.resolve` inside the inherited initiator context and still sees the exact initiating Agent and its canonical workspace — not a coincidental workdir.
- Two Agents in two workspaces run concurrently without cross-talk; agent→preset→workspace chains resolve to the workspace root.
- Agentless/direct `ctx.shell.resolve()` calls pass through untouched, even when `workdir` lies inside a mapped workspace.
- Native direnv semantics: a blocked/denied/changed-`.envrc` execution fails with native direnv's own stderr/exit status reaching the Bash caller; with no `.envrc`, native direnv executes with the inherited environment. **Real allow/deny behavior belongs to Block D**; the current tests prove the execution chain itself with a fake executable shim.
- `DSH_*` ownership: after direnv evaluation the shim deletes every `DSH_*` variable in the environment and restores only this request's managed snapshot. **Shim-controlled variables**: `BASH_ENV` and `ENV` are stripped for the shim and its whole exec chain by `env -u BASH_ENV -u ENV` — so the original program also never sees these two variables even when direnv (or the environment) sets them; every other ordinary variable (including credential-shaped ones) follows native direnv semantics. V1 does not refactor to a native shim; this is the current implementation fact.

**Not yet wired**: Block C (the persistent-terminal adapter) is not implemented — terminal executions are still unwrapped. The current bundle is loadable on its own.

## API

- `WorkspaceEnvrc` (root export, default): `workspaceForAgent(agent)`, `wrapArgv(canonicalWorkspace, originalArgv, dshEnv?)`, `wrapCommand(canonicalWorkspace, originalCommand, dshEnv?)`, readonly `bashEnabled`/`terminalEnabled` getters.
- `dsh-workspace-envrc/core`: `defaultConfig`, `assertWorkspaceEnvrcConfig`, `managedEnvPairs`, `buildManagedEnvShimArgv`, `buildExecArgv`, `shq`, `wrapCommand`, `resolveAgentWorkspace`, `runPreflight`, `assertPosixPlatform`, `PreflightError`, and the related types. All are framework-free pure functions; the public surface never exposes secrets or environment snapshots.
- `dsh-workspace-envrc/bash-adapter`: `installWorkspaceEnvrcBashAdapter(ctx)` and `WorkspaceEnvrcBashAdapterHandle`.
- `dsh-workspace-envrc/integration-plugin`: `name`/`inject`/`Config`/`apply` (function plugin, no default).

## Development

```sh
pnpm install        # repository-local store (see .npmrc)
pnpm test           # full vitest suite
pnpm typecheck      # strict typecheck of src + tests
pnpm build          # tsc -> dist
```

Tests never read or write the real user's direnv authorization state (no real `direnv allow`, no workspace `.envrc` execution); the shim script and the wrapped command are exercised through real child processes with explicit isolated environments (no `process.env` mutation); the background path is verified through the real AgentRegistry + ToolRuntime + tool-bash + jobs provider (only the `ctx.shell` provider is a recording stub).

## Security and trust boundary

- Authorization always happens on the user's native direnv side (`direnv allow` belongs to the user); changing an allowed `.envrc` invalidates the native hash and blocks later executions until the user re-allows. DSH has no allow/deny/edit entry point.
- Every enabled execution is shaped as `direnv exec <canonical-root> <managed-env-shim> <original>`: evaluation and the command share one process tree (inside the executor's confine when sandboxing is on); `DSH_*` ownership is restored after evaluation, `BASH_ENV`/`ENV` are controlled by the shim, and every other ordinary variable (including credential-shaped variables an allowed `.envrc` explicitly exports) follows native direnv semantics.
- Diagnostics and errors contain only the stage, the executable path, and exit facts — never stdout/stderr, environment, or secrets; the public API accepts and returns nothing sensitive beyond the environment projections.

## License

MIT, see [LICENSE](../LICENSE).
