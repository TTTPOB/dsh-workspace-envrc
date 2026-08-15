# dsh-workspace-envrc

> English version: [docs/README.en.md](docs/README.en.md)

DSH 树外独立 bundle：把本机原生 direnv 环境应用到显式归属于 Agent/workspace 的 Bash 执行（foreground 与 background）、持久终端创建与本地 stdio workspace MCP 行。插件把「发现、`.envrc` 求值、授权 hash、allow/deny、stdlib、环境变更」全部委托给已安装的 `direnv` 可执行文件——它绝不解析或 source `.envrc`、绝不维护授权数据库、绝不调用 `direnv allow`/`permit`/`grant`/`edit`、绝不使用 `direnv export`、不 watch 也不缓存任何 `.envrc`、绝不修改 Harness 进程的 `process.env`，并且不向模型暴露任何 allow/deny 工具。授权始终由用户在 DSH 之外的终端里用 `direnv allow <exact .envrc>` 完成。

目标 DSH：`0.1.0-rc.6`。运行时 peer 包括 `@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-scope` / `@deepseek-ai/dsh-shell` / `@deepseek-ai/dsh-sandbox` / `@deepseek-ai/dsh-subprocess` / `@deepseek-ai/dsh-terminal` / `@deepseek-ai/dsh-timeout` 0.1.0-rc.6 与 `dsh-workspace-overlay` ^0.1.0；`@deepseek-ai/schemastery` 按实际身份策略作为普通依赖（与 DSH 各包及兄弟仓库 `dsh-workspace-overlay` 的声明方式一致）。版本均与安装版一致。

## 当前状态

全部能力已实现并有测试覆盖（156 个测试全绿）：`workspaceEnvrc` provider core、可逆 Bash adapter、持久终端 adapter、workspace MCP adapter（§11 完整实现：源码、确定性单测、真实 MCP SDK fixture、真实 WorkspaceTree 热重载与原生 direnv 的组合验证）、集成行，以及三条真实组合测试路径（真实 `direnv` 的 allow/deny/内容变更状态机、真实 Cordis Loader 组合内置 dist 的 provider/integration 行、真实 MCP SDK stdio fixture + 原生 direnv + 顶层配置热重载的全生命周期）。实现计划 [docs/implementation-plan.md](docs/implementation-plan.md) §9 与 §11 状态均为 **implemented and published**。本 README 描述当前实现事实，不再按历史 Block 分期叙述。

## 依赖与安装

- 本 bundle 是独立仓库，依赖 `dsh-workspace-overlay` bundle：`workspaceCordis`（canonical workspace 身份与 scope 映射）、`workspaceMcp`（workspace-aware MCP manager，由 overlay 的 `workspace-mcp-manager` 行提供）与公开的 `dsh-workspace-overlay/method-wrapper`（可逆方法装饰）。
- **安装顺序：先装 overlay bundle，再装本 bundle。** 本 bundle 的 patch（`cordis.patch.yml`）只插入自己的两行（provider 行 + 集成行），**绝不自动插入 overlay 行**——overlay 行由 overlay 自己的 bundle patch 提供，`dsh plugin add` 不会跨 bundle 改写 profile。
- **系统必须已安装 direnv**：激活 preflight 会运行 `direnv version`。本 bundle 不安装 direnv，也不调用 `direnv allow`；`.envrc` 授权由用户在 DSH 外人工完成（见「原生 direnv 语义」）。

```sh
# 1) 先装 workspace overlay bundle（提供 workspaceCordis 与 method-wrapper）
dsh plugin --profile web add /path/to/dsh-workspace-overlay
# 2) 再装本 bundle
dsh plugin --profile web add /path/to/dsh-workspace-envrc
# 3) 检查最终组合：本 bundle 的两行与完整 config 均可见
dsh --profile web --dump-config
```

卸载：`dsh plugin --profile web remove dsh-workspace-envrc`（overlay 保持在原位；没有本 bundle 的包装时，Bash 与终端回到原生未包装行为）。

## 原生 direnv 语义

- **固定 canonical workspace root 查找**：workspace 只来自发起 Agent 的 scope 映射——以 `scopeOf(agent.ctx)` 为起点沿 `scopeParentOf` 上行，逐 key 询问 `workspaceCordis.workspaceForScope`，首个命中即 canonical root（覆盖 agent→preset→workspace 链）；V1 绝不从 per-command `workdir` 选择嵌套 `.envrc`，也不读 `session.header.cwd`。
- **`direnv exec DIR` 不 chdir**：环境按 canonical root 加载，子进程 cwd 保持调用方（Bash request 的 `workdir` / 终端 backend 解析的 cwd）不变。
- **无 `.envrc` 透传**：没有适用的 `.envrc`/`.env` 时，原生 direnv 以继承环境正常执行，无任何插件级 fallback 分支。
- **blocked / deny / 内容变更**：`.envrc` 未 allow、被 deny、或 allow 后内容变更使原生 hash 失效时，原生 direnv 拒绝执行，其原始 stderr/exit status 原样到达 Bash/terminal 调用方，原程序不会运行。
- **授权在 DSH 外**：用户在本机终端（与运行 DSH 相同的 OS 账号）人工执行 `direnv allow <exact .envrc>`；重新 allow 前，后续执行持续失败。DSH 侧没有任何 allow/deny/编辑入口。
- **插件绝不调用**：`direnv allow`/`permit`/`grant`/`edit`、`direnv export`、`.envrc` 的 parse/source/hash/watch/cache，以及 `process.env` 的任何读写。**不向模型暴露 allow/deny 工具。**

## 执行语义

### Bash（foreground 与 background）

- 每次执行都是**新进程**（foreground 或 `run_in_background`），环境快照在进程启动时冻结；没有常驻 shell 复用。
- 装饰 `ctx.shell.resolve`：`bashEnabled` 为 false、无 `ctx.agents.currentInitiator()`（agentless / 直接 Shell 调用）、或 `workspaceEnvrc.workspaceForAgent(agent)` 无映射时，一律原样透传——即使 `workdir` 落在某个 workspace 内也不猜测。
- 有映射时只替换 `request.command` 为 `exec <direnv> exec <canonical-root> <managed-env-shim> <original>`；`workdir`/timeout/stdoutMaxBytes/signal/stdin/env/dshEnv/sandboxPolicy 等其余字段引用与值原样保留，调用方 request 对象不被修改。
- background 路径的 `jobs.start` run starter（同步）在继承的 initiator 上下文里调用 `ctx.shell.resolve`，仍然拿到发起调用的精确 Agent 及其 canonical workspace，而不是碰巧的 workdir。
- sandbox 开启时，整个 wrapped chain（含 `.envrc` 求值）位于 executor 的 confine 之内。

### Terminal

- 所有权显式：只在 `ctx.terminals.spawn(owner, request, signal)` 创建链内生效；`terminalEnabled` 为 false、owner 缺失、或 `workspaceForAgent(owner)` 无映射时，原样委托（不建立 context）。
- 每个 spawn 链用一个 operation-local `AsyncLocalStorage` 上下文 `{owner, canonical, wrapped}` 跨整个未发布创建链（含 returned Promise），并发 owner 互不串扰。
- **deferred wrapper 在 confine 之前**：`ctx.sandbox.confine(argv, policy)`（terminal-bash 的 argv commit seam）收到的是 deferred envrc wrapper——sandbox 包住整个 direnv 链，`.envrc` 求值留在 confinement 内；wrapper/confine 抛错原样传播。
- **danger final fallback**：`danger-full-access` 或不调用 confine 的 backend 走 `ctx.subprocess.spawnTerminal`，只替换 `spec.argv` 为 deferred wrapper；已 wrapped 绝不 double wrap；spawn 链之外的直接调用一律原样。
- **DSH 最终环境捕获**：backend 在 confine 之后才构造最终 `SubprocessTerminalSpawnSpec.env`（`DSH_SESSION_ID`/`DSH_PTY_SESSION_ID` 此时尚不可见），因此外层 capture shim 在 direnv 之前从**自身进程环境**枚举 Bash 3.2+ 兼容的 `${!DSH_*}`（即 subprocess provider 合并后的最终环境），再 `exec <direnv> exec <canonical>` + post-direnv 恢复 shim（删除 direnv 后所有 `DSH_*`、恢复 captured exact snapshot、exec 原 argv）。
- **新 terminal 快照**：环境在 spawn 时冻结；**已运行 terminal 不变**——adapter dispose 不杀进程、不重启，in-flight 创建不被 kill；只有新 terminal 重新 direnv。
- 交互式 `cd` hook **不仿真**：终端内目录变化由用户 shell 自己的 direnv hook 处理。

### Workspace MCP（本地 stdio 行）

- **scope 权威分类**：装饰公开的 `ctx.workspaceMcp.activate(rowCtx, rawConfig)`。分类只读 `scopeOf(rowCtx)` 并询问 `workspaceCordis.workspaceForScope`——绝不从行的 `cwd`/`serverName`/`env`、headers 或调用方 Agent 猜测归属。`workspaceMcpEnabled` 为 false、`rowCtx` 不是 Cordis Context、缺 rawConfig、`scopeOf(rowCtx) === undefined`（global 行）、scope 未被 `workspaceCordis.workspaceForScope` 映射（preset/foreign 行，让 manager 自己拒绝）时一律原样透传，raw config 对象身份与字节不变；streamable-http 行（无本地子进程）与 malformed config 也原样透传，manager schema 产生原错误。
- **只替换 command/args**：mapped workspace 的合法 stdio 行（`transport === 'stdio'`、非空 string `command`、`args`缺省或为`string[]`）替换为 `<direnv> exec <canonical-root> <managed-env-shim> <command> <args...>`；其余字段（`cwd`/`env`/reconnect/toolCallTimeoutMs 等）引用与值原样保留，调用方 raw config 对象不被修改。manager 仍负责 workspace cwd 解析与连接/进程/工具/mask/重试/拆除生命周期。
- **空 managed snapshot（重要修正）**：MCP SDK stdio transport 的子进程环境是 `{...scrubbedParentEnv(), ...config.env}`——ambient `DSH_*` 在子进程存在前就被 scrub，**没有 Harness managed snapshot**。因此 wrapped argv 携带**空快照**（不是 terminal 的 deferred capture）：direnv 求值后 shim 删除环境里全部 `DSH_*`（包括 workspace config 或已 allow 的 `.envrc` 显式导出的——config 不得伪造 Harness namespace）并恢复为空；ordinary config env 与 `.envrc` 导出遵循原生 direnv 语义（`.envrc` 的同名导出可覆盖 config env）。
- **MCP 行必须在精确 workspace scope**：只有 `scopeOf(rowCtx)` 自身被映射的行被包装；preset 子 scope 行（即使父链指向 workspace）透传并让 manager 拒绝。
- **receiver/promise/error 原样**：精确 receiver 透传，manager 返回的 promise 与抛出的错误原样到达调用方。
- **`enableWorkspaceMcp: false`**：MCP adapter 保持安装但永远透明——workspace stdio 行直接启动（**不经过 direnv**，即使 `.envrc` 处于 blocked 状态也照常启动），显式 config env 原样到达子进程（没有 shim 执行，config 里的 `DSH_*` 条目也不被删除）。

## 环境安全

- 普通环境变量（包括被允许的 `.envrc` 显式导出的 credential-shaped 变量）遵循原生 direnv 语义：一旦用户 allow，这些变量进入该进程环境，**模型可读取**（这是用户原生 `direnv allow` 的刻意后果）。
- `DSH_*` 归属：direnv 求值后 shim 删除环境里全部 `DSH_*`，只恢复本次请求的精确 managed 快照（terminal 路径由 deferred capture 在 direnv 之前从 spawn 进程环境捕获精确快照；MCP 路径的子进程环境已被 scrub 且无 managed snapshot，因此快照为空——direnv 之后全部 `DSH_*` 被删除、恢复为空，config/.envrc 显式写的 `DSH_*` 同样被清除）。managed name 严格 `DSH_[A-Z0-9_]+` 且 value 为 string；value 全部走 argv，不拼进脚本。
- **`BASH_ENV`/`ENV` 是明确例外**：post-direnv shim 与原始程序都在 `env -u BASH_ENV -u ENV` 后运行，因此看不到 direnv 设置的这两个控制变量。Bash工具的既有外层executor shell以及direnv自身的求值shell仍可能读取启动前ambient的`BASH_ENV`；插件不把这个Host输入继续传给post-direnv段。Terminal路径的deferred argv则从最外层开始移除它们。普通direnv shell不会做这种移除，因此这是文档化差异。
- **preflight只验证version与shim语义，不读`.envrc`**：激活先运行`direnv version`，再在配置的shell下实际运行一次`DSH_*`清除/恢复probe；两个child都bounded，不用`shell: true`，不执行、不读取任何workspace `.envrc`，不改`process.env`。probe同时验证Bash 3.2+兼容的`${!DSH_*}`行为；失败消息只含stage与executable/path，不含子进程stdout/stderr/env/secret。
- **sandbox边界**：Bash/Terminal的direnv链在DSH执行器或terminal confine内，因此sandbox必须能读取原生allow数据库；若`XDG_DATA_HOME`位于sandbox会遮蔽的位置（例如local bwrap用tmpfs覆盖的`/tmp`），会把外部已allow的`.envrc`视为blocked。当前overlay的workspace MCP由MCP SDK直接spawn，没有sandbox/confine接缝，所以MCP进程和其`.envrc`求值不经过DSH sandbox；这是显式边界，不应把Terminal的confinement保证外推到MCP。
- 诊断与错误不打印 stdout/stderr/env/secret；公开 API 不接受、不返回环境快照之外的敏感内容。

## 失败与生命周期边界

- **激活失败**：direnv 缺失/不可用、shim shell 非法、或 preflight 超时 → provider 激活即失败，任何 adapter 都不安装。
- **blocked/denied/内容变更**：原程序不运行，原生错误原样到达调用方；Agent、workspace lease、插件全部存活。
- **HMR/dispose**：还原确切的先前 method descriptor（幂等；后装 wrapper 不会被先装者的 dispose 移除，完全还原按逆安装序 dispose）；已启动进程保留其环境与进程属主，不因 decorator 卸载被杀。
- **overlay 先于本插件卸载**：后续 Agent 查找无映射 → 原样透传，或按普通 workspace 生命周期失败；没有缓存的 workspace 路径比映射活得更久。
- **并发**：不同 workspace 的 Agent / 终端创建各自独立 direnv 求值，互不串扰。
- **组合要求**：唯一integration row同时注入`agents`、`shell`、`sandbox`、`subprocess`、`terminals`、`workspaceCordis`、`workspaceMcp`与`workspaceEnvrc`，保证terminal的direnv链不会落到late sandbox外；缺少任何一个service时整行保持pending，任何 adapter 都不会单独安装，即使 `enableTerminal: false` 或 `enableWorkspaceMcp: false`。
- **不覆盖**：global MCP、LSP、subagent providers 与 generic `ctx.subprocess.spawn()` 明确不在范围（完整非目标清单见 [docs/implementation-plan.md](docs/implementation-plan.md) §8；Workspace MCP 已由 §11 覆盖）。**Windows 不支持**（激活即失败）。
- **no watcher / no auto restart**：本 bundle 不 watch 任何文件（包括 `.envrc`——内容变更由原生 direnv 在下次执行时按 hash 拒绝）。只改 `.envrc` 不触碰任何已运行进程：MCP 进程环境在 spawn 时冻结、pid 不变，后台 job 与已运行 terminal 也不自动重启；内容变更只让**未来的** spawn 被原生 direnv blocked，直到用户在 DSH 外重新 `direnv allow`。保存/触碰 workspace 顶层 `.dsh/cordis.yml` 走既有 WorkspaceTree 热重载：旧 MCP 进程退出，新进程重新经过 direnv 启动；若新启动被 blocked，按 overlay 既有失败语义 workspace 的工具/mask 暂时缺失、Agent 与 workspace lease 存活，下次顶层配置事件自动重试；用户 re-allow 后再次保存配置即得到 fresh pid/tools/mask。global 行不受 workspace reload 影响（进程与视图全程存活）；最终 release/dispose 退出全部 MCP 进程，无进程残留。

## Config

`workspaceEnvrc` provider 行的 schema（schema + 语义校验，实现在 `dsh-workspace-envrc/core`）：

| 字段 | 默认 | 约束 |
|---|---|---|
| `executable` | `direnv` | 非空、无 NUL；PATH 命令或绝对路径 |
| `shimShell` | `/bin/bash` | 绝对路径、无 NUL |
| `enableBash` | `true` | boolean；false 时 Bash adapter 可安装但永远透明 |
| `enableTerminal` | `true` | boolean；false 时 terminal adapter 可安装但永远透明 |
| `enableWorkspaceMcp` | `true` | boolean；false 时 MCP adapter 可安装但永远透明 |
| `versionCheckTimeoutMs` | `5000` | 正整数且 ≤ `MAX_TIMER_DELAY_MS` |

只读 getter `bashEnabled`/`terminalEnabled`/`workspaceMcpEnabled` 供 adapter 读取，不暴露可变 config。第三个构造函数参数是可注入的 preflight spawn seam（确定性测试用，不进 Config schema）。

## API 与 exports

- 根导出 `dsh-workspace-envrc`（`dist/provider.js`，默认导出 `WorkspaceEnvrc extends Service`）：`workspaceForAgent(agent)`、`wrapArgv(canonicalWorkspace, originalArgv, dshEnv?)`、`wrapCommand(canonicalWorkspace, originalCommand, dshEnv?)`、`wrapDeferredArgv(canonicalWorkspace, originalArgv)`（终端的 deferred capture 链），只读 `bashEnabled`/`terminalEnabled`/`workspaceMcpEnabled`。
- `dsh-workspace-envrc/core`：`defaultConfig`、`assertWorkspaceEnvrcConfig`、`managedEnvPairs`、`buildManagedEnvShimArgv`、`buildExecArgv`、`buildDeferredManagedExecArgv`、`DEFERRED_ENV_CAPTURE_SCRIPT`、`DEFERRED_ENV_SHIM_LABEL`、`shq`、`wrapCommand`、`resolveAgentWorkspace`、`runPreflight`、`assertPosixPlatform`、`PreflightError` 与相关类型；均为无框架纯函数。
- `dsh-workspace-envrc/bash-adapter`：`installWorkspaceEnvrcBashAdapter(ctx)` 与 `WorkspaceEnvrcBashAdapterHandle`。
- `dsh-workspace-envrc/terminal-adapter`：`installWorkspaceEnvrcTerminalAdapter(ctx)` 与 `WorkspaceEnvrcTerminalAdapterHandle`（operation-local ALS 上下文为内部实现）。
- `dsh-workspace-envrc/mcp-adapter`：`installWorkspaceEnvrcMcpAdapter(ctx)` 与 `WorkspaceEnvrcMcpAdapterHandle`（scope 权威分类；只包装 mapped workspace stdio 行，空 managed snapshot）。
- `dsh-workspace-envrc/integration-plugin`：`name`/`inject`/`Config`/`apply`（函数插件，无 default；安装顺序 Bash→Terminal→MCP，卸载逆序）。
- `dsh-workspace-envrc/cordis.patch.yml`：bundle patch（两行，见「依赖与安装」）。

## 开发

```sh
pnpm install        # repo-local store（.npmrc）
pnpm test           # vitest 全量（先 build dist）
pnpm typecheck      # src + tests 严格类型检查
pnpm build          # tsc -> dist
```

全套 156 个测试全绿，且测试从不读取、不写入真实用户 direnv 授权状态：`tests/direnv-native.spec.ts` 用真实 `direnv` 驱动完整 allow/deny/内容变更状态机与 deferred terminal wrapper，授权状态全部落在仓库内隔离的 `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`HOME`（`.artifacts/` 下，gitignored）；shim 脚本与 wrapped command 用真实子进程在隔离显式环境中验证（不改 `process.env`）；`tests/mcp-adapter.spec.ts` 确定性覆盖 MCP adapter 的 scope 分类/透传/生命周期，并用仓库内 fake direnv 子进程执行 wrapped MCP argv；`tests/mcp-live-direnv.spec.ts`（fixture：`tests/fixtures/mcp/fixture-server.mjs`，真实 `@modelcontextprotocol/sdk` `Server`/`StdioServerTransport`）在真实 overlay registry（真实 chokidar 热重载）+ 真实 `WorkspaceMcpManager`/`workspace-client` + 真实 provider/integration + 原生 direnv（仓库内隔离 XDG/HOME）下端到端证明：allowed `.envrc` 以原生优先级与 credential-shaped 可见性到达 MCP 子进程、空 managed snapshot（config/.envrc/ambient 的全部 `DSH_*` 缺失）、manager 解析的 workspace cwd、global 同 serverName 行 byte-for-byte 不包装且不受 workspace reload 影响、无 `.envrc` watcher（只改 `.envrc` 时 v1 进程冻结）、blocked 重载（旧进程退出、workspace 工具/mask 移除、lease 与 scope 存活、诊断无 canary）、re-allow 恢复（fresh pid + v2 环境 + mask 恢复）、最终 release/dispose 零进程残留（marker 对账）、以及 `enableWorkspaceMcp: false` 在 blocked `.envrc` 下不经 direnv 直接启动；后台路径用真实 AgentRegistry + ToolRuntime + tool-bash + jobs provider 验证；终端路径用真实 TerminalSessionService + terminal-bash + SandboxPolicyService 验证；`tests/loader-composition.spec.ts` 用真实 Cordis Loader 读取 test `cordis.yml`，组合内置 dist 的 provider/integration 行与真实 DSH services/overlay 依赖；built-entry smoke（`.artifacts/smoke-built.mjs`）以安装版 DSH rc.6 包解析 dist 的根/core/adapter/integration 导出并跑通真实 preflight。

## 安全与信任边界

- 授权始终由用户在 DSH 外、本机 direnv 侧完成（`direnv allow` 只属于用户）；`.envrc` 内容变更后原生 hash 失效会阻塞后续执行，直到用户重新 allow。DSH 侧没有任何 allow/deny/编辑入口，也不给模型提供 allow/deny 工具。
- 每个启用执行的包装形状为 `direnv exec <canonical-root> <managed-env-shim> <original>`：求值与命令在同一进程树内（sandbox 开启时整体位于 executor/terminal 的 confine 之内）；`DSH_*` 归属在求值后恢复（terminal 路径由 spawn 前的 deferred capture 提供精确快照）；`BASH_ENV`/`ENV`是控制变量例外（post-direnv段与原始程序不可见；Bash外层executor的ambient启动行为见上文）；其余普通环境变量（含 `.envrc` 显式导出的 credential-shaped 变量）遵循原生 direnv 语义。
- 诊断与错误只含 stage、可执行文件路径与退出事实，不打印 stdout/stderr/env/secret；公开 API 不接受、不返回环境快照之外的敏感内容。

## 许可证

MIT，见 [LICENSE](LICENSE)。
