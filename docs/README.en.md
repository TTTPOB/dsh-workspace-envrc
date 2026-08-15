# dsh-workspace-envrc

> **Languages / docs**: this is the English version of the project README; the Chinese original is [`../README.md`](../README.md). The implementation plan (in Chinese) is at [`implementation-plan.md`](./implementation-plan.md).

Out-of-tree DSH bundle that applies the local machine's native direnv environment to explicitly Agent/workspace-owned Bash executions and persistent terminals. The plugin delegates discovery, `.envrc` evaluation, authorization hashes, `allow`/`deny`, stdlib behavior, and environment mutation to the installed `direnv` executable — it never parses or sources `.envrc`, never maintains an authorization database, never calls `direnv allow`, and never mutates the Harness process's `process.env`.

Target DSH: `0.1.0-rc.6`. Runtime peers include `@deepseek-ai/cordis` 4.0.1, `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-scope` / `@deepseek-ai/dsh-timeout` 0.1.0-rc.6, and `dsh-workspace-overlay` ^0.1.0; `@deepseek-ai/schemastery` follows the actual identity policy as a plain dependency (the same declaration DSH's own packages and the sibling `dsh-workspace-overlay` repository use). All versions match the installed release.

## Current status (Block A: provider core)

This repository is implemented in blocks per [`implementation-plan.md`](./implementation-plan.md). **Only Block A is done**: the standalone package skeleton and the `workspaceEnvrc` provider core.

- `ctx.workspaceEnvrc` (`WorkspaceEnvrc extends Service`, default export, `static inject = ['agents', 'workspaceCordis']`).
- Strict Config (schema + semantic validation): `executable` (default `direnv`; non-empty, NUL-free, a PATH command or an absolute path), `shimShell` (default `/bin/bash`; must be absolute), `enableBash`/`enableTerminal` (default `true`), `versionCheckTimeoutMs` (default `5000`; a positive integer no greater than `MAX_TIMER_DELAY_MS`).
- Bounded activation preflight (strictly awaited inside `[Service.init]`; the service is not ready before init completes): `direnv version` and `<shimShell> --noprofile --norc -c 'exit 0'` — no `shell: true`, no workspace `.envrc` executed or read, no `process.env` mutation. Failure messages carry only the stage and the executable/path, never child stdout/stderr, environment, or secrets; the child is always reaped on timeout, abort, and init rollback (`done` is always awaited — no unhandled rejections). V1 is POSIX-only; Windows fails at activation. A third constructor argument is an injectable preflight spawn seam for deterministic tests (never part of the Config schema).
- Agent→workspace resolution: start at `scopeOf(agent.ctx)` and walk `scopeParentOf`, asking `workspaceCordis.workspaceForScope` at every key, first hit wins (covers agent→preset→workspace chains); unscoped or unmapped agents yield `undefined`. No `session.header.cwd`, no cwd guessing, no import of the overlay's private coordinator.
- Pure wrapper core (`dsh-workspace-envrc/core`): `direnv exec <canonical-workspace> <managed-env-shim> <original argv>`; the managed shim runs after direnv as `env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c SCRIPT label count name value... original argv`, the SCRIPT deletes every `${!DSH_@}` variable, restores only the request's exact managed `DSH_*` snapshot, then execs the original program; values travel through argv, never spliced into the script; managed names are validated strictly (`DSH_[A-Z0-9_]+`, string values). Ordinary environment variables are handled natively by direnv and never touched by the core. `wrapCommand` produces a POSIX-safe command (every dynamic argv element single-quoted; `'` and newlines handled, NUL rejected) that replaces only `request.command` — workdir, env, dshEnv, and everything else survive. The workspace is fixed at the canonical root; V1 never selects nested `.envrc` files from a per-command workdir.

**Not yet wired**: Block B (reversible Bash adapter decorating `ctx.shell.resolve`) and Block C (persistent-terminal adapter) are not implemented — the provider currently wraps nothing. `cordis.patch.yml` contains only the `workspace-envrc` provider row (explicit full Config); integration rows land in later blocks, and the current bundle is loadable on its own.

## API

- `WorkspaceEnvrc` (root export, default): `workspaceForAgent(agent)`, `wrapArgv(canonicalWorkspace, originalArgv, dshEnv?)`, `wrapCommand(canonicalWorkspace, originalCommand, dshEnv?)`.
- `dsh-workspace-envrc/core`: `defaultConfig`, `assertWorkspaceEnvrcConfig`, `managedEnvPairs`, `buildManagedEnvShimArgv`, `buildExecArgv`, `shq`, `wrapCommand`, `resolveAgentWorkspace`, `runPreflight`, `assertPosixPlatform`, `PreflightError`, and the related types. All are framework-free pure functions; the public surface never exposes secrets or environment snapshots.

## Development

```sh
pnpm install        # repository-local store (see .npmrc)
pnpm test           # full vitest suite
pnpm typecheck      # strict typecheck of src + tests
pnpm build          # tsc -> dist
```

Tests never read or write the real user's direnv authorization state (no real `direnv allow`, no workspace `.envrc` execution); the shim script is exercised through a real child process in an isolated plain environment.

## Security and trust boundary

- Authorization always happens on the user's native direnv side (`direnv allow` belongs to the user); changing an allowed `.envrc` invalidates the native hash and blocks later executions until the user re-allows. DSH has no allow/deny/edit entry point.
- Every enabled execution is shaped as `direnv exec <canonical-root> <managed-env-shim> <original>`: evaluation and the command share one process tree; `DSH_*` ownership is restored after evaluation, while ordinary variables (including credential-shaped variables an allowed `.envrc` explicitly exports) follow native direnv semantics.
- Diagnostics and errors contain only the stage, the executable path, and exit facts — never stdout/stderr, environment, or secrets; the public API accepts and returns nothing sensitive beyond the environment projections.

## License

MIT, see [LICENSE](../LICENSE).
