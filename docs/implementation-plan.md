# DSH workspace direnv integration plan

Status: **implemented and published**. Every block in §9 and every completion criterion in §10 is complete. The READMEs describe the current behavior; this document retains the implementation decomposition and verified contract.

## 1. Objective

Publish an independent out-of-tree DSH bundle, `dsh-workspace-envrc`, that depends on `dsh-workspace-overlay` and applies the local machine's native direnv environment to explicitly Agent/workspace-owned Bash executions and persistent terminals.

The plugin delegates discovery, `.envrc` evaluation, authorization hashes, `allow`/`deny`, stdlib behavior, and environment mutation to the installed `direnv` executable. It never parses or sources `.envrc`, never maintains an authorization database, never runs `direnv allow`, and never mutates the Harness process's `process.env`.

V1 supports foreground Bash, background Bash jobs, and persistent terminal creation. Workspace MCP, LSP, subagent providers, and generic subprocess calls are out of scope.

## 2. Package and dependency boundary

This is a separate Git repository and installable DSH bundle. Its dependency direction is:

```text
dsh-workspace-overlay
  └─ workspaceCordis: canonical workspace identity and live scope mapping

dsh-workspace-envrc
  ├─ workspaceEnvrc service
  └─ reversible Bash/terminal execution adapters
```

`dsh-workspace-overlay` never depends on this package. Installing the workspace overlay does not enable direnv. Installing this bundle is the explicit opt-in.

The plugin uses only public runtime seams:

- `ctx.agents.currentInitiator()` for Agent-owned Bash attribution;
- `scopeOf(agent.ctx)` plus `scopeParentOf()` to walk through an optional workspace-local preset generation;
- `ctx.workspaceCordis.workspaceForScope(key)` as the only workspace-root authority;
- `ctx.terminals.spawn(owner, ...)` for explicit persistent-terminal ownership;
- reversible method decorators around public service methods;
- `ctx.sandbox.confine()` and `ctx.subprocess.spawnTerminal()` only inside an operation-local terminal-owner context.

It does not import the workspace overlay's private `AgentBindingCoordinator`.

## 3. Native direnv semantics

### 3.1 Execution primitive

Every enabled execution is wrapped as:

```text
direnv exec <canonical-workspace-root> <managed-env-shim> <original program and arguments>
```

The canonical workspace root is the lookup directory. V1 deliberately does not select nested `.envrc` files from a Bash `workdir`; one Agent has one workspace environment even when a command runs in a subdirectory. The original process working directory remains unchanged because `direnv exec DIR` loads the environment for `DIR` but does not chdir the command.

If no `.envrc` or `.env` applies, native direnv executes with the inherited environment unchanged. If the file is blocked, denied, or changed since `direnv allow`, native direnv refuses the execution and its original stderr/exit status reaches the Bash or terminal caller.

### 3.2 Authorization

The plugin must never call any of:

```text
direnv allow
direnv permit
direnv grant
direnv edit
```

Users authorize files outside DSH using the same OS account that runs DSH. Modifying an allowed `.envrc` invalidates the native hash and blocks later executions until the user explicitly allows the new content.

Tests use isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`; they never read or write the user's real direnv authorization state.

### 3.3 Evaluation world

`.envrc` evaluation must occur inside the same confinement and process-tree lifecycle as the requested command:

```text
sandbox (when enabled)
  -> direnv exec
      -> .envrc evaluation
      -> managed-env shim
      -> original command
```

The plugin must not run `direnv export`, evaluate `.envrc` in the Host before sandboxing, or cache an exported environment snapshot.

### 3.4 Environment ownership

Native direnv semantics apply to ordinary environment variables, including credential-shaped variables explicitly exported by an allowed `.envrc`. This is a deliberate consequence of the user's native `direnv allow`: model-controlled Bash can read any variable available to that process.

Harness-managed `DSH_*` facts remain owned by DSH. After direnv evaluates `.envrc`, a small POSIX Bash shim:

1. removes every `DSH_*` variable present in the direnv-produced environment;
2. restores only the exact managed `DSH_*` snapshot supplied for this execution;
3. `exec`s the original argv.

The shim receives values through argv, not ambient private variables, and invokes no parser for `.envrc`. `BASH_ENV` and `ENV` are explicit control-variable exceptions: `env -u BASH_ENV -u ENV` strips them from the post-direnv restoration segment and original program, so an allowed environment cannot alter the ownership-restoration step. The Bash tool's pre-existing outer executor shell and direnv evaluation may still observe ambient startup controls before that segment; the terminal deferred wrapper removes them from its outermost argv. Every other ordinary environment entry — including credential-shaped variables explicitly exported by an allowed `.envrc` — follows native direnv semantics.

For persistent terminals the final `SubprocessTerminalSpawnSpec.env` is built only after the backend's `ctx.sandbox.confine(argv)` commit seam, so the managed snapshot cannot be known at wrap time. The deferred capture shim therefore runs before direnv as the wrapped argv's program: it records the exact `DSH_*` name/value pairs present in the spawned process environment (the environment the subprocess provider merged from the final spec), then executes `direnv exec <canonical-workspace>` plus the restoration shim with the captured pairs. `DSH_SESSION_ID`/`DSH_PTY_SESSION_ID` thus survive any direnv mutation exactly; all dynamic inputs travel through argv.

## 4. Service and configuration

Provide `ctx.workspaceEnvrc` through a default-exported `WorkspaceEnvrc extends Service`.

```ts
interface WorkspaceEnvrcConfig {
  executable: string
  shimShell: string
  enableBash: boolean
  enableTerminal: boolean
  versionCheckTimeoutMs: number
}
```

Defaults:

```ts
{
  executable: 'direnv',
  shimShell: '/bin/bash',
  enableBash: true,
  enableTerminal: true,
  versionCheckTimeoutMs: 5_000,
}
```

The provider supports POSIX platforms only in V1 and fails at activation on Windows. Activation preflight runs exactly two bounded children: `direnv version`, then one real managed-environment clear/restore shim probe under `env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c <shim> ...`. The probe rejects shells that cannot execute the Bash 3.2+-compatible `${!DSH_*}` prefix expansion, keeps ambient startup code out of the check, and never executes or reads a workspace file. A missing executable, bad version command, invalid absolute `shimShell`, or timeout fails loudly and leaves no decorators installed.

The service owns pure projections:

- resolve the canonical workspace for an exact live Agent by scope ancestry;
- wrap argv as native `direnv exec` plus the managed-env shim;
- wrap one shell command without changing the Shell request's cwd, timeout, signal, sandbox policy, stdin, ordinary env, or managed env snapshot.

It never falls back to cwd-based workspace guessing.

## 5. Bash adapter

Decorate the concrete `ctx.shell.resolve(request)` method reversibly.

At each call:

1. read `ctx.agents.currentInitiator()`;
2. if absent, delegate unchanged;
3. resolve the Agent's canonical workspace through `workspaceCordis` and scope ancestry;
4. if no live workspace mapping exists, delegate unchanged;
5. if Bash support is disabled, delegate unchanged;
6. replace only `request.command` with an `exec direnv exec ...` wrapper;
7. delegate to the original resolver.

The existing Bash Consumer already resolves the model's `workdir`, sandbox policy, timeout, stdin, ordinary env, and managed `dshEnv` before calling `ctx.shell.resolve()`. The wrapper preserves every field except `command`.

Foreground calls inherit the AgentLoop initiator context. The background-job starter must be tested through the real Jobs service: the later `ctx.shell.resolve()` must retain the exact initiating Agent, and the environment snapshot freezes when the process starts. Agentless/direct Shell calls are deliberately unchanged.

## 6. Persistent terminal adapter

Persistent terminal ownership is explicit in `ctx.terminals.spawn(owner, request, signal)`. Install an operation-local context around that public method. While the original call remains in flight:

- resolve `owner` to one canonical workspace;
- carry the exact owner/workspace only through that asynchronous terminal creation chain (an operation-local `AsyncLocalStorage` context, so concurrent owners are isolated and unrelated spawns are unchanged);
- if the backend calls `ctx.sandbox.confine(argv, policy)`, wrap `argv` before delegating so direnv and `.envrc` evaluation run inside confinement; the deferred capture shim (section 3.4) supplies the managed snapshot the backend cannot know at this seam;
- if no sandbox call occurs (`danger-full-access` or an unconfined backend), wrap the final `ctx.subprocess.spawnTerminal(spec).argv` instead;
- never wrap twice;
- restore all three method descriptors on plugin disposal.

The terminal's cwd remains the backend-resolved cwd. Its initial environment is frozen at spawn. Editing or re-allowing `.envrc` affects new terminals only; an existing terminal is never restarted or mutated. Interactive directory changes use any direnv hook configured in the user's shell and are not emulated by this plugin.

Agentless or unrelated subprocess terminal spawns outside the explicit `terminals.spawn(owner, ...)` chain are unchanged.

## 7. Failure and lifecycle semantics

- Missing or unusable `direnv`/shim shell: provider activation fails before decorators install.
- Blocked/denied/changed `.envrc`: the requested Bash/terminal process fails with native direnv output; the Agent, workspace lease, and plugin stay alive.
- No `.envrc`: native direnv executes normally with no plugin-level fallback branch.
- Plugin HMR/disposal restores exact previous method descriptors. Already spawned processes retain their environment and process owner; no process is killed solely because the decorator unloads.
- Workspace overlay disposal before this adapter causes future Agent lookups to delegate unchanged or fail through the ordinary workspace lifecycle; no cached workspace path outlives the mapping.
- Concurrent Agents in different workspaces inherit independent native direnv evaluations.

## 8. Explicit non-goals

- Calling or exposing `direnv allow`/`deny` as a model tool or automatic action.
- Parsing, sourcing, hashing, watching, or caching `.envrc`.
- Using `direnv export`.
- Mutating `process.env`.
- Applying environments to every `ctx.subprocess.spawn()` based on cwd.
- Nested `.envrc` selection from per-command workdir in V1.
- Automatically restarting a running background job or terminal after `.envrc` changes.
- Workspace MCP, global MCP, LSP, filesystem helpers, generic subprocesses, or subagent providers.
- Windows support.

## 9. Implementation blocks and commits

Every implementation block was delegated to `opencode-go/deepseek-v4-flash` with `max` reasoning in the foreground. Subagents edited and tested but never committed. The main agent reviewed, ran focused gates, and created atomic commits. **All four blocks are implemented**; the commits below are the actual history (Block D landed as `test: cover native direnv integration`).

### Block A — package skeleton and provider core *(implemented)*

- Create pnpm/ESM/strict TypeScript package metadata, exports, patch, license, and test harness.
- Implement Config validation, version preflight, Agent-to-workspace ancestry resolution, POSIX argv wrapper, command quoting, and managed `DSH_*` restoration shim.
- Unit-test exact argv/command behavior, no workspace guessing, preset-parent traversal, duplicate/invalid values, error containment, and secrets absent from diagnostics.

Suggested commit: `feat: add workspace direnv provider`

### Block B — Bash adapter *(implemented)*

- Reversibly decorate Shell resolve.
- Test foreground, real background Jobs ownership, two-workspace isolation, agentless/direct calls, workdir preservation, sandbox placement, blocked/allowed/changed/denied behavior, cancellation, and HMR restoration.

Suggested commit: `feat: apply direnv to workspace bash`

### Block C — persistent terminal adapter *(implemented)*

- Add operation-local owner context and reversible terminal/sandbox/subprocess decorators.
- Test confined and danger-full-access ordering, no double wrap, explicit owner isolation, direct subprocess bypass, concurrent terminal creation, initial environment, blocked state, and HMR restoration.

Suggested commit: `feat: apply direnv to workspace terminals`

### Block D — real composition, docs, and release audit *(implemented)*

- Add real Loader composition tests against installed DSH rc.6 and the built workspace overlay dependency.
- Use isolated XDG direnv state to prove native allow, content-change invalidation, re-allow, and deny.
- Verify no write to the real direnv state, no user profile changes, no process residue, complete patch rows, package exports, pack contents, and isolated `DSH_HOME` installation.
- Write Chinese and English READMEs with security/trust and execution-boundary details.

Suggested commit: `docs: document workspace direnv integration` (the final commit history is `05fb756 docs: plan workspace direnv integration` → `bdc0739 feat: add workspace direnv provider` → `5feeca3 feat: apply direnv to workspace bash` → `7d17997 feat: apply direnv to workspace terminals` → `8140a26 test: cover native direnv integration`.)

## 10. Completion criteria

**All criteria below are met** (tests, typecheck, build, pack, installed rc.6 activation, isolated bundle composition, and the native state machine against real direnv were verified during the release audit):

- ✅ A live workspace Agent's foreground Bash, background Bash, and new persistent terminals execute through the local `direnv exec` under the same sandbox/process owner.
- ✅ Native allow/deny/content-hash behavior is proven with isolated direnv state (`tests/direnv-native.spec.ts`).
- ✅ Ordinary environment mutations are preserved while `DSH_*` ownership is restored (`BASH_ENV`/`ENV` are the documented control-variable exceptions).
- ✅ Unrelated and agentless subprocess calls remain unchanged.
- ✅ Two workspaces remain isolated (concurrent Bash executions and terminal creations).
- ✅ All decorators reverse on unload (idempotent, successor-safe; verified through the real Loader in `tests/loader-composition.spec.ts`).
- ✅ No real user direnv/profile/Harness state is modified by any test or by the plugin.
- ✅ Focused/full tests, typecheck, build, pack, installed rc.6 Loader activation, and isolated bundle composition verification pass.
- ✅ The independent repository is published at `https://github.com/TTTPOB/dsh-workspace-envrc`.
