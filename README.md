# dsh-workspace-envrc

> English version: [docs/README.en.md](docs/README.en.md)

DSH 树外独立 bundle：把本机原生 direnv 环境应用到显式归属于 Agent/workspace 的 Bash 执行（foreground 与 background）与持久终端创建。插件把「发现、`.envrc` 求值、授权 hash、allow/deny、stdlib、环境变更」全部委托给已安装的 `direnv` 可执行文件——它绝不解析或 source `.envrc`、绝不维护授权数据库、绝不调用 `direnv allow`/`permit`/`grant`/`edit`、绝不使用 `direnv export`、不 watch 也不缓存任何 `.envrc`、绝不修改 Harness 进程的 `process.env`，并且不向模型暴露任何 allow/deny 工具。授权始终由用户在 DSH 之外的终端里用 `direnv allow <exact .envrc>` 完成。

目标 DSH：`0.1.0-rc.6`。运行时 peer 包括 `@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-scope` / `@deepseek-ai/dsh-shell` / `@deepseek-ai/dsh-sandbox` / `@deepseek-ai/dsh-subprocess` / `@deepseek-ai/dsh-terminal` / `@deepseek-ai/dsh-timeout` 0.1.0-rc.6 与 `dsh-workspace-overlay` ^0.1.0；`@deepseek-ai/schemastery` 按实际身份策略作为普通依赖（与 DSH 各包及兄弟仓库 `dsh-workspace-overlay` 的声明方式一致）。版本均与安装版一致。

## 当前状态

全部能力已实现并有测试覆盖：`workspaceEnvrc` provider core、可逆 Bash adapter、持久终端 adapter、集成行，以及两条真实组合测试路径（真实 `direnv` 的 allow/deny/内容变更状态机、真实 Cordis Loader 组合内置 dist 的 provider/integration 行）。实现计划 [docs/implementation-plan.md](docs/implementation-plan.md) 状态为 **implemented**，完成标准已达成（除最终 GitHub 发布，见该文件 §10）。本 README 描述当前实现事实，不再按历史 Block 分期叙述。

## 依赖与安装

- 本 bundle 是独立仓库，依赖 `dsh-workspace-overlay` bundle：`workspaceCordis`（canonical workspace 身份与 scope 映射）与公开的 `dsh-workspace-overlay/method-wrapper`（可逆方法装饰）。
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
- **DSH 最终环境捕获**：backend 在 confine 之后才构造最终 `SubprocessTerminalSpawnSpec.env`（`DSH_SESSION_ID`/`DSH_PTY_SESSION_ID` 此时尚不可见），因此外层 capture shim 在 direnv 之前从**自身进程环境**枚举 `${!DSH_@}`（即 subprocess provider 合并后的最终环境），再 `exec <direnv> exec <canonical>` + post-direnv 恢复 shim（删除 direnv 后所有 `DSH_*`、恢复 captured exact snapshot、exec 原 argv）。
- **新 terminal 快照**：环境在 spawn 时冻结；**已运行 terminal 不变**——adapter dispose 不杀进程、不重启，in-flight 创建不被 kill；只有新 terminal 重新 direnv。
- 交互式 `cd` hook **不仿真**：终端内目录变化由用户 shell 自己的 direnv hook 处理。

## 环境安全

- 普通环境变量（包括被允许的 `.envrc` 显式导出的 credential-shaped 变量）遵循原生 direnv 语义：一旦用户 allow，这些变量进入该进程环境，**模型可读取**（这是用户原生 `direnv allow` 的刻意后果）。
- `DSH_*` 归属：direnv 求值后 shim 删除环境里全部 `DSH_*`，只恢复本次请求的精确 managed 快照（terminal 路径由 deferred capture 在 direnv 之前从 spawn 进程环境捕获精确快照）。managed name 严格 `DSH_[A-Z0-9_]+` 且 value 为 string；value 全部走 argv，不拼进脚本。
- **`BASH_ENV`/`ENV` 是明确例外**：`env -u BASH_ENV -u ENV` 把这两个控制变量从整个 chain 移除，shim 与原始程序都不可见——direnv（或环境）即使设置它们也不会生效。普通 direnv shell（用户交互 shell 的 direnv hook）不会移除这两个变量，因此这是本 chain 与普通 direnv shell 的文档化差异。
- **preflight 只 version/shell，无 `.envrc`**：激活只运行 `direnv version` 与 `env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c 'exit 0'`，不用 `shell: true`，不执行、不读取任何 workspace `.envrc`，不改 `process.env`；失败消息只含 stage 与 executable/path，不含子进程 stdout/stderr/env/secret。
- 诊断与错误不打印 stdout/stderr/env/secret；公开 API 不接受、不返回环境快照之外的敏感内容。

## 失败与生命周期边界

- **激活失败**：direnv 缺失/不可用、shim shell 非法、或 preflight 超时 → provider 激活即失败，任何 adapter 都不安装。
- **blocked/denied/内容变更**：原程序不运行，原生错误原样到达调用方；Agent、workspace lease、插件全部存活。
- **HMR/dispose**：还原确切的先前 method descriptor（幂等；后装 wrapper 不会被先装者的 dispose 移除，完全还原按逆安装序 dispose）；已启动进程保留其环境与进程属主，不因 decorator 卸载被杀。
- **overlay 先于本插件卸载**：后续 Agent 查找无映射 → 原样透传，或按普通 workspace 生命周期失败；没有缓存的 workspace 路径比映射活得更久。
- **并发**：不同 workspace 的 Agent / 终端创建各自独立 direnv 求值，互不串扰。
- **不覆盖**：Workspace MCP、global MCP、LSP、subagent providers 与 generic `ctx.subprocess.spawn()` 明确不在范围（完整非目标清单见 [docs/implementation-plan.md](docs/implementation-plan.md) §8）。**Windows 不支持**（激活即失败）。
- **no watcher / no auto restart**：本 bundle 不 watch 任何文件（包括 `.envrc`——内容变更由原生 direnv 在下次执行时按 hash 拒绝）；`.envrc` 变化后不自动重启后台 job 或已运行 terminal。

## Config

`workspaceEnvrc` provider 行的 schema（schema + 语义校验，实现在 `dsh-workspace-envrc/core`）：

| 字段 | 默认 | 约束 |
|---|---|---|
| `executable` | `direnv` | 非空、无 NUL；PATH 命令或绝对路径 |
| `shimShell` | `/bin/bash` | 绝对路径、无 NUL |
| `enableBash` | `true` | boolean；false 时 Bash adapter 可安装但永远透明 |
| `enableTerminal` | `true` | boolean；false 时 terminal adapter 可安装但永远透明 |
| `versionCheckTimeoutMs` | `5000` | 正整数且 ≤ `MAX_TIMER_DELAY_MS` |

只读 getter `bashEnabled`/`terminalEnabled` 供 adapter 读取，不暴露可变 config。第三个构造函数参数是可注入的 preflight spawn seam（确定性测试用，不进 Config schema）。

## API 与 exports

- 根导出 `dsh-workspace-envrc`（`dist/provider.js`，默认导出 `WorkspaceEnvrc extends Service`）：`workspaceForAgent(agent)`、`wrapArgv(canonicalWorkspace, originalArgv, dshEnv?)`、`wrapCommand(canonicalWorkspace, originalCommand, dshEnv?)`、`wrapDeferredArgv(canonicalWorkspace, originalArgv)`（终端的 deferred capture 链），只读 `bashEnabled`/`terminalEnabled`。
- `dsh-workspace-envrc/core`：`defaultConfig`、`assertWorkspaceEnvrcConfig`、`managedEnvPairs`、`buildManagedEnvShimArgv`、`buildExecArgv`、`buildDeferredManagedExecArgv`、`DEFERRED_ENV_CAPTURE_SCRIPT`、`DEFERRED_ENV_SHIM_LABEL`、`shq`、`wrapCommand`、`resolveAgentWorkspace`、`runPreflight`、`assertPosixPlatform`、`PreflightError` 与相关类型；均为无框架纯函数。
- `dsh-workspace-envrc/bash-adapter`：`installWorkspaceEnvrcBashAdapter(ctx)` 与 `WorkspaceEnvrcBashAdapterHandle`。
- `dsh-workspace-envrc/terminal-adapter`：`installWorkspaceEnvrcTerminalAdapter(ctx)` 与 `WorkspaceEnvrcTerminalAdapterHandle`（operation-local ALS 上下文为内部实现）。
- `dsh-workspace-envrc/integration-plugin`：`name`/`inject`/`Config`/`apply`（函数插件，无 default）。
- `dsh-workspace-envrc/cordis.patch.yml`：bundle patch（两行，见「依赖与安装」）。

## 开发

```sh
pnpm install        # repo-local store（.npmrc）
pnpm test           # vitest 全量（先 build dist）
pnpm typecheck      # src + tests 严格类型检查
pnpm build          # tsc -> dist
```

测试从不读取、不写入真实用户 direnv 授权状态：`tests/direnv-native.spec.ts` 用真实 `direnv` 驱动完整 allow/deny/内容变更状态机与 deferred terminal wrapper，授权状态全部落在仓库内隔离的 `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`HOME`（`.artifacts/` 下，gitignored）；shim 脚本与 wrapped command 用真实子进程在隔离显式环境中验证（不改 `process.env`）；后台路径用真实 AgentRegistry + ToolRuntime + tool-bash + jobs provider 验证；终端路径用真实 TerminalSessionService + terminal-bash + SandboxPolicyService 验证；`tests/loader-composition.spec.ts` 用真实 Cordis Loader 读取 test `cordis.yml`，组合内置 dist 的 provider/integration 行与真实 DSH services/overlay 依赖。

## 安全与信任边界

- 授权始终由用户在 DSH 外、本机 direnv 侧完成（`direnv allow` 只属于用户）；`.envrc` 内容变更后原生 hash 失效会阻塞后续执行，直到用户重新 allow。DSH 侧没有任何 allow/deny/编辑入口，也不给模型提供 allow/deny 工具。
- 每个启用执行的包装形状为 `direnv exec <canonical-root> <managed-env-shim> <original>`：求值与命令在同一进程树内（sandbox 开启时整体位于 executor/terminal 的 confine 之内）；`DSH_*` 归属在求值后恢复（terminal 路径由 spawn 前的 deferred capture 提供精确快照）；`BASH_ENV`/`ENV` 是控制变量例外（整条 chain 移除，原始程序也不可见）；其余普通环境变量（含 `.envrc` 显式导出的 credential-shaped 变量）遵循原生 direnv 语义。
- 诊断与错误只含 stage、可执行文件路径与退出事实，不打印 stdout/stderr/env/secret；公开 API 不接受、不返回环境快照之外的敏感内容。

## 许可证

MIT，见 [LICENSE](LICENSE)。
