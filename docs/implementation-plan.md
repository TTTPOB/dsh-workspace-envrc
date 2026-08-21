# DSH workspace direnv integration plan

Status: **implemented**. The current implementation covers Agent-owned foreground/background Bash and mapped workspace stdio MCP. Persistent shells are intentionally unsupported; [ADR 0001](adr/0001-no-persistent-shell.md) owns that decision and supersedes the earlier terminal implementation.

## 1. Objective

Publish an independent out-of-tree DSH bundle, `dsh-workspace-envrc`, that depends on `dsh-workspace-overlay` and applies the local machine's native direnv environment to explicitly Agent/workspace-owned Bash executions and workspace stdio MCP rows.

The plugin delegates discovery, `.envrc` evaluation, authorization hashes, allow/deny state, stdlib behavior, and environment changes to the installed `direnv` executable. It never parses or sources `.envrc`, maintains an authorization database, runs `direnv allow`, or mutates the Harness process's `process.env`.

## 2. Package boundary

```text
dsh-workspace-overlay
├─ workspaceCordis: canonical workspace identity and live scope mapping
├─ workspaceMcp: workspace-aware MCP manager
└─ method-wrapper: reversible method decoration

dsh-workspace-envrc
├─ workspaceEnvrc provider
└─ Host integration
   ├─ Bash adapter
   └─ workspace MCP adapter
```

`dsh-workspace-overlay` never depends on this package. Installing this bundle is the explicit direnv opt-in.

## 3. Native direnv semantics

Every supported execution runs:

```text
direnv exec <canonical-workspace> <managed-env-shim> <original-program>
```

The canonical workspace comes only from the initiating Agent's scope ancestry and `workspaceCordis`. `direnv exec` selects the environment without changing the original cwd. Native direnv owns allow/deny behavior and rejects blocked or changed `.envrc` content before the original program runs.

The managed-env shim removes every inherited `DSH_*` after direnv evaluation and restores only the caller-provided Harness snapshot. Workspace MCP deliberately supplies an empty snapshot because its transport scrubs Harness-managed values before spawn. `BASH_ENV` and `ENV` remain removed from the shim and original program environment.

## 4. Provider and configuration

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

```ts
{
  executable: 'direnv',
  shimShell: '/bin/bash',
  enableBash: true,
  enableWorkspaceMcp: true,
  versionCheckTimeoutMs: 5_000,
}
```

Activation validates the configuration, runs `direnv version`, and executes a bounded shim probe. It reads no workspace `.envrc` during activation.

## 5. Bash adapter

Decorate `ctx.shell.resolve` through `dsh-workspace-overlay/method-wrapper`:

1. Require `enableBash`, a current initiating Agent, and a mapped canonical workspace.
2. Replace only `request.command` with a POSIX-safe `exec direnv exec ...` command.
3. Preserve every other request field and object reference.
4. Restore the previous descriptor on dispose.

Foreground and background Bash share this projection because both resolve through the Host shell service under an Agent initiator.

## 6. Workspace MCP adapter

Decorate `ctx.workspaceMcp.activate`:

1. Wrap only mapped local stdio workspace rows.
2. Replace only `command` and `args` with the provider's wrapped argv.
3. Leave global, HTTP, malformed, and foreign-scope rows unchanged.
4. Preserve cwd, explicit env, startup policy, reconnect behavior, and tool timeout.
5. Restore the previous descriptor on dispose.

The current MCP stdio transport has no DSH sandbox seam, so its child process and direnv evaluation use the transport Host's process authority.

## 7. Integration lifecycle

The Host integration injects:

```text
agents, shell, workspaceCordis, workspaceMcp, workspaceEnvrc
```

It installs Bash then MCP. MCP install failure rolls back Bash. Fiber disposal restores MCP then Bash. There is no terminal, sandbox, or subprocess dependency.

## 8. Explicit non-goals

- Persistent shell or terminal creation; see [ADR 0001](adr/0001-no-persistent-shell.md).
- Parsing, sourcing, watching, hashing, or authorizing `.envrc` inside DSH.
- Mutating Host `process.env`.
- Selecting nested `.envrc` from command workdir.
- Generic subprocess, LSP, remote MCP, or subagent environment injection.
- Adding preset augmentation against DSH internal mount APIs.

## 9. Verification

The maintained verification surfaces are:

- strict provider/config type checking;
- built ESM entry generation;
- real Cordis Loader composition of the built provider and integration rows;
- Bash foreground/background behavior tests;
- workspace MCP classification and live-reload tests;
- native direnv allow/deny/content-change behavior;
- target `web` profile `--dump-config` and startup smoke verification.
