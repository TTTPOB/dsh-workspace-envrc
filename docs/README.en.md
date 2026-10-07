# dsh-workspace-envrc

> Chinese original: [`../README.md`](../README.md)

An out-of-tree DSH bundle that applies the local machine's native direnv environment to explicitly Agent/workspace-owned Bash executions (foreground and background) and local stdio workspace MCP rows. It delegates `.envrc` discovery, evaluation, authorization hashes, allow/deny state, stdlib behavior, and environment changes to the installed `direnv` executable. It does not parse or source `.envrc`, maintain authorization state, call `direnv allow`/`permit`/`grant`/`edit`, use `direnv export`, watch or cache `.envrc`, mutate the Harness `process.env`, or expose an allow/deny tool to models.

The development and release baseline is DSH `0.1.7-rc.2`, Agent/preset-registry `0.1.7-rc.2-fork1`, Cordis `4.0.4`, Schemastery `3.18.4`, and overlay `0.2.0`. The bundle consumes overlay for canonical workspace scopes, the workspace-aware MCP manager, and reversible method wrappers. Shared peers resolve to the Host module instances; see Release validation for exact source assets.


## Release validation

[Validate and release](../.github/workflows/release.yml) and local checks share `pnpm prepare:release`. The [dependency contract](../.github/release-dependencies.json) fixes Agent/preset-registry fork1 and overlay `0.2.0`; the registry is consumed through overlay, not an added envrc service peer. Unset asset URLs block preparation. Publish the core assets and overlay first, then record exact immutable URLs in the contract/workspace overrides and generate the source lockfile with pnpm. Official llm stays at `0.1.7-rc.2`.

`node .github/scripts/prepare-local.mjs <inputs.json>` checks the local tarballs named by the input package-to-path map and prepares `.artifacts/local-source` for diagnostics only. `pnpm verify:consumer` validates packed exports and real Loader activation through the official resolver with Host-shared peers and a plugin-only profile (`autoInstallPeers: false`). It checks rejection of fork-only peers before granting an exact exemption to its isolated package-version/runtime pair. Native direnv tests operate only on disposable fixtures; no Host is launched.

## Installation

Install overlay and envrc as ordinary dependencies in the resolving profile (`autoInstallPeers: false`); declare their shared rows, overlay before envrc, in `$DSH_HOME/cordis.patch.yml`. This profile is the resolution location, not a Web-specific scope. Keep daily bundles to official base/Web app rather than auto-appending these bundle patches and duplicating the shared rows. The host must already provide `direnv`.

The bundle patch adds only the `workspace-envrc` provider and `workspace-envrc-integration` rows. Activation runs `direnv version` and a bounded shim probe but reads no workspace `.envrc`.

To uninstall, remove the shared envrc rows from `$DSH_HOME/cordis.patch.yml` and its ordinary profile dependency.

## Native direnv semantics

- The workspace comes only from the initiating Agent's scope ancestry: walk from `scopeOf(agent.ctx)` through `scopeParentOf` and take the first `workspaceCordis.workspaceForScope` match. Command workdir and `session.header.cwd` never select a workspace.
- `direnv exec <canonical-workspace>` selects the environment without changing the caller-resolved cwd.
- Native direnv passes through inherited environment when no `.envrc` applies. A blocked, denied, or changed authorization hash rejects execution before the original program runs.
- Authorization remains a user action outside DSH: `direnv allow <exact .envrc>`. The plugin exposes no authorization operation.
- Ordinary variables exported by an allowed `.envrc` follow native direnv semantics. Harness-owned `DSH_*` values are restored from the execution path's explicit snapshot; workspace MCP uses an empty snapshot and removes forged `DSH_*` names.
- `BASH_ENV` and `ENV` are removed from the managed shim and original program environment.

## Bash

The Host integration reversibly decorates `ctx.shell.resolve`. It wraps a request only when there is a current initiating Agent mapped to a canonical workspace:

```text
exec direnv exec <canonical-workspace> <managed-env-shim> <original-command>
```

Workdir, timeout, stdout cap, signal, stdin, ordinary env, `dshEnv`, and sandbox policy remain unchanged. Foreground and `run_in_background` executions freeze their environment when their new process starts. Agentless and unmapped calls pass through unchanged.

## Workspace MCP

The Host integration reversibly decorates `ctx.workspaceMcp.activate`. It wraps only mapped local stdio workspace rows. Global, HTTP, foreign-scope, and malformed rows pass through to the manager unchanged. Only `command` and `args` change; cwd, explicit env, reconnect behavior, startup policy, and tool timeout retain their values.

The current overlay MCP stdio transport exposes no sandbox/confine seam. MCP children and `.envrc` evaluation therefore run with the transport host's process authority, not the Bash sandbox.

## Persistent shells are unsupported

The bundle does not support persistent shell or terminal creation. DSH mounts `terminals` in preset-private isolated realms while this bundle is a Host profile layer. Adding preset augmentation would depend on unstable internal mount APIs, and the current deployment does not need the capability. See [ADR 0001](adr/0001-no-persistent-shell.md).

## Configuration

```ts
interface WorkspaceEnvrcConfig {
  executable: string
  shimShell: string
  enableBash: boolean
  enableWorkspaceMcp: boolean
  versionCheckTimeoutMs: number
}
```

Defaults:

```yaml
executable: direnv
shimShell: /bin/bash
enableBash: true
enableWorkspaceMcp: true
versionCheckTimeoutMs: 5000
```

## Security boundary

- The plugin does not read or log full environment snapshots, `.envrc` contents, stdout/stderr, or secrets.
- It never mutates Host `process.env`; each execution resolves its workspace from the Agent scope.
- Commands use argv/spawn or existing DSH service seams, never `shell: true` path interpolation.
- Fiber disposal restores wrappers in MCP-then-Bash order; a failed MCP install rolls back the Bash adapter.

## License

MIT, see [LICENSE](../LICENSE).
