# dsh-workspace-envrc

> Chinese original: [`../README.md`](../README.md)

An out-of-tree DSH bundle that applies the local machine's native direnv environment to explicitly Agent/workspace-owned Bash executions (foreground and background) and local stdio workspace MCP rows. It delegates `.envrc` discovery, evaluation, authorization hashes, allow/deny state, stdlib behavior, and environment changes to the installed `direnv` executable. It does not parse or source `.envrc`, maintain authorization state, call `direnv allow`/`permit`/`grant`/`edit`, use `direnv export`, watch or cache `.envrc`, mutate the Harness `process.env`, or expose an allow/deny tool to models.

The target DSH version is `0.1.0-rc.6`. The bundle depends on `dsh-workspace-overlay` for canonical workspace scopes, the workspace-aware MCP manager, and reversible method wrappers.

## Installation

Install the overlay first, then this bundle. The host must already provide `direnv`:

```sh
dsh plugin --profile web add /path/to/dsh-workspace-overlay
dsh plugin --profile web add /path/to/dsh-workspace-envrc
dsh --profile web --dump-config
```

The bundle patch adds only the `workspace-envrc` provider and `workspace-envrc-integration` rows. Activation runs `direnv version` and a bounded shim probe but reads no workspace `.envrc`.

To uninstall:

```sh
dsh plugin --profile web remove dsh-workspace-envrc
```

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
