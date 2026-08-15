# dsh-workspace-envrc

> English version: [docs/README.en.md](docs/README.en.md)

DSH 树外插件：把本机原生 direnv 环境应用到显式归属于 Agent/workspace 的 Bash 执行与持久终端。插件把「发现、`.envrc` 求值、授权 hash、allow/deny、stdlib、环境变更」全部委托给已安装的 `direnv` 可执行文件——绝不解析或 source `.envrc`、绝不维护授权数据库、绝不调用 `direnv allow`、绝不修改 Harness 进程的 `process.env`。

目标 DSH：`0.1.0-rc.6`。运行时 peer 包括 `@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-scope` / `@deepseek-ai/dsh-shell` / `@deepseek-ai/dsh-sandbox` / `@deepseek-ai/dsh-subprocess` / `@deepseek-ai/dsh-terminal` / `@deepseek-ai/dsh-timeout` 0.1.0-rc.6 与 `dsh-workspace-overlay` ^0.1.0；`@deepseek-ai/schemastery` 按实际身份策略作为普通依赖（与 DSH 各包及兄弟仓库 `dsh-workspace-overlay` 的声明方式一致）。版本均与安装版一致。

## 当前状态（Block A provider core + Block B Bash adapter + Block C terminal adapter）

本仓库按 [docs/implementation-plan.md](docs/implementation-plan.md) 分块实现。**Block A（package 骨架与 `workspaceEnvrc` provider core）、Block B（可逆 Bash adapter）与 Block C（持久终端 adapter）已完成**；Block D（真实 direnv allow/deny 验证与发布审计）留待后续块。

- `ctx.workspaceEnvrc`（`WorkspaceEnvrc extends Service`，默认导出，`static inject = ['agents', 'workspaceCordis']`）。
- 严格 Config（schema + 语义校验）：`executable`（默认 `direnv`，非空、无 NUL，可为 PATH 命令或绝对路径）、`shimShell`（默认 `/bin/bash`，必须绝对路径）、`enableBash`/`enableTerminal`（默认 `true`）、`versionCheckTimeoutMs`（默认 `5000`，正整数且 ≤ `MAX_TIMER_DELAY_MS`）。只读 getter `bashEnabled`/`terminalEnabled` 供 adapter 读取，不暴露可变 config。
- 有界激活 preflight（`[Service.init]` 内严格 await，init 完成前 service 不 ready）：`direnv version` 与 `<shimShell> --noprofile --norc -c 'exit 0'`，不用 `shell: true`，不执行/读取任何 workspace `.envrc`，不改 `process.env`；失败消息只含 stage 与 executable/path，不含子进程 stdout/stderr/env/secret；child 在 timeout/abort/init rollback 时一律 reap（`done` 必然被 await，无 unhandled）。V1 仅 POSIX，Windows 激活即失败。第三个构造函数参数是可注入的 preflight spawn seam（确定性测试用，不进 Config schema）。
- Agent→workspace 解析：以 `scopeOf(agent.ctx)` 为起点沿 `scopeParentOf` 上行，逐 key 询问 `workspaceCordis.workspaceForScope`，首个命中即 canonical root（覆盖 agent→preset→workspace 链）；未 scoped / 无映射返回 `undefined`；不使用 `session.header.cwd`、不猜 cwd、不 import overlay 的私有 coordinator。
- 纯 wrapper core（`dsh-workspace-envrc/core`）：`direnv exec <canonical-workspace> <managed-env-shim> <original argv>`；managed shim 在 direnv 之后以 `env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c SCRIPT label count name value... original argv` 运行，SCRIPT 删除全部 `${!DSH_@}`、只恢复请求的精确 managed DSH_* 快照、再 `exec` 原程序；value 全部走 argv 不拼进脚本；managed name 严格 `DSH_[A-Z0-9_]+` 且 value 为 string。`wrapCommand` 生成 POSIX 安全 command（全部动态 argv 单引号 quote，正确处理 `'` 与 newline、拒绝 NUL），只替换 `request.command`，workdir/env/dshEnv 等一律保留。workspace 固定 canonical root，不做 per-command workdir 的嵌套 `.envrc` 选择。
- **Block B：Bash adapter（`dsh-workspace-envrc/bash-adapter`）**。`installWorkspaceEnvrcBashAdapter(ctx)` 用公开的 `dsh-workspace-overlay/method-wrapper` 在 concrete `ctx.shell` provider target 上可逆装饰 `resolve`，返回幂等 dispose handle（还原确切的前置 descriptor；double-install 时先装者的 dispose 不会移除后装者，完全还原需按逆安装序 dispose）。每次 resolve：`bashEnabled` 为 false→透传；`ctx.agents.currentInitiator()` 不存在（agentless/直接 Shell 调用）→透传；`workspaceEnvrc.workspaceForAgent(agent)` 无映射→透传；有映射→只把 `request.command` 替换为 `wrapCommand(canonical, command, request.dshEnv ?? {})`，其余字段（workdir/timeout/stdoutMaxBytes/signal/stdin/env/dshEnv/sandboxPolicy）引用与值原样保留，调用方 request 对象不被修改。`Reflect.apply(original, receiver, ...)` 保留 trace receiver（original 的 `this.ctx` 仍是调用方上下文）。workspace 只来自 Agent 的 scope 映射，绝不从 workdir/session cwd 猜测。`currentInitiator()` 若因 agents service dispose 而抛，按 Cordis 依赖卸载时序原样传播、不吞。
- **Block C：terminal adapter（`dsh-workspace-envrc/terminal-adapter`）**。`installWorkspaceEnvrcTerminalAdapter(ctx)` 用公开 method-wrapper 在 concrete provider target 上可逆装饰三个 public method，返回幂等 dispose handle（逆安装序还原确切 descriptor：subprocess → sandbox → terminals；double-install 的 successor 语义与 Bash adapter 相同）。每次显式 `ctx.terminals.spawn(owner, request, signal)`：
  - `terminalEnabled` 为 false、owner 缺失、`workspaceForAgent(owner)` 无映射 → 原样 delegate（不建立 context）；
  - 否则用一个 operation-local `AsyncLocalStorage` context `{owner, canonical, wrapped}` 包住整个未发布创建链（跨 returned Promise），并发 owner 互不串扰；
  - `ctx.sandbox.confine`（terminal-bash 的 argv commit seam）：operation 激活且未 wrapped 时，把 incoming argv 换成 `wrapDeferredArgv(canonical, argv)` 后调用 original 并确认 wrapped —— sandbox 外层包住整个 direnv 链，`.envrc` 求值留在 confinement 内；wrapper/confine 抛错原样传播；
  - `ctx.subprocess.spawnTerminal`：operation 激活且未 wrapped（danger-full-access 或不调用 confine 的 backend）时只替换 `spec.argv` 为 deferred wrapper，其余 `env`/`cwd`/`rows`/`cols`/`graceMs`/`signal` 引用原样；已 wrapped 绝不 double wrap；spawn 链之外直接调用一律原样。
  - **Deferred managed-env capture**：backend 在 `confine` 之后才构造最终 `SubprocessTerminalSpawnSpec.env`（`DSH_SESSION_ID`/`DSH_PTY_SESSION_ID` 此时尚不可见），因此包装形状是 `env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c CAPTURE ...originalArgv`：outer shim 在 direnv 之前从**自身进程环境**枚举 `${!DSH_@}` 存成 Bash array（即 subprocess provider 合并后的最终环境），再 `exec <direnv> exec <canonicalWorkspace>` + 现有 post-direnv 恢复 shim（删除 direnv 后所有 `DSH_*`、恢复 captured exact snapshot、exec 原 argv）。所有动态输入走 argv（NUL/empty 校验），不用 `process.env`、不写 temp、不解析 `.envrc`；`BASH_ENV`/`ENV` 作为控制变量从整个 chain 移除（原始程序也不可见）。安装要求 `ctx.sandbox` 存在（integration inject 强制），避免 optional late provider 把 direnv 包在 sandbox 外。
  - 终端 cwd 保持 backend resolved；环境在 spawn 时冻结——已运行的 terminal 不受 adapter dispose 影响，也不重启；interactive `cd` hook 不仿真；只有新 terminal 重新 direnv。
- **Block B：集成行（`dsh-workspace-envrc/integration-plugin`）**。函数插件（命名导出 `name`/`inject`/`apply`，无 default），`inject = ['agents', 'shell', 'sandbox', 'subprocess', 'terminals', 'workspaceEnvrc']`；`ctx.effect` 先装 Bash adapter 再装 terminal adapter，fiber dispose 时逆序（terminal 先、Bash 后）dispose（HMR 安全）；terminal adapter 安装失败时回滚已装的 Bash adapter（adapter 内部同样回滚自己的部分安装）。`cordis.patch.yml` 含 `workspace-envrc` provider 行与唯一一个 `workspace-envrc-integration` 行，不新增重复 row。`enableBash: false`/`enableTerminal: false` 时对应 adapter 可安装但永远 transparent。

**执行语义（已由测试证明）**：

- foreground 与 `run_in_background` 两条真实路径都走同一个 resolve wrapper：后台路径中 `jobs.start` 的 run starter（同步）在继承的 initiator 上下文里调用 `ctx.shell.resolve`，仍然拿到发起调用的精确 Agent 及其 canonical workspace，而不是碰巧的 workdir。
- 两个 Agent/两个 workspace 并发时各自拿到自己的 workspace 环境，互不串扰；agent→preset→workspace 链解析到 workspace root。
- agentless / 直接 `ctx.shell.resolve()` 一律原样透传，即使 `workdir` 落在某个 workspace 内也不猜测。
- 原生 direnv 语义：blocked/denied/`.envrc` 变更未重新 allow 时，原生 direnv 拒绝执行，其原始 stderr/exit status 到达 Bash/terminal 调用方；无 `.envrc` 时以继承环境正常执行。**真实 allow/deny 行为属于 Block D**，当前测试用 fake executable shim 只证明执行链本身。
- `DSH_*` 归属：direnv 求值后 shim 删除环境里全部 `DSH_*`，只恢复本次请求的 managed 快照（terminal 路径由 deferred capture shim 在 direnv 之前从 spawn 进程环境捕获精确快照）。**shim 控制变量**：`BASH_ENV` 与 `ENV` 由 `env -u BASH_ENV -u ENV` 为 shim 及其 exec 链整体剥离——因此原始程序也看不到 direnv（或环境）设置的这两个变量；除此之外的 ordinary variables（含 credential-shaped 变量）遵循原生 direnv 语义。当前 V1 不重构成 native shim，此事实即当前实现事实。
- **terminal 路径**（真实 TerminalSessionService + terminal-bash 组合验证）：confined 模式下 `sandbox.confine` 收到的 input 以 deferred envrc wrapper 开头，最终 `spawnTerminal` argv 以 sandbox runner 开头且整个 direnv 链在其内部（恰好一次，无 double wrap）；danger-full-access 不调用 confine，final argv 直接是 deferred wrapper；terminal cwd 保持 backend resolved（request cwd 或 policy workspaceRoot）；final spec 的 `env`/`cwd`/`rows`/`cols`/`graceMs`/`signal` 引用原样；`DSH_SESSION_ID`/`DSH_PTY_SESSION_ID` 在 env 中保留。owner 的 canonical workspace 与 terminal cwd 无关（exact owner workspace，绝不从 cwd 猜测）。并发创建两个 workspace 的 terminal 各自独立 direnv。child-level 真实执行证明 deferred capture/restore、direnv 伪造/新增 DSH 被清除、blocked direnv 原样失败。
- **后台已运行 terminal 环境冻结**：adapter dispose 不杀进程、不重启；新 terminal 重新 direnv；dispose 期间 in-flight 创建不被 kill。

**尚未接线**：Block D（真实 direnv allow/deny 验证、发布审计）。Workspace MCP、global MCP、LSP、subagent providers 与 generic subprocess 仍明确不在范围（见 [docs/implementation-plan.md](docs/implementation-plan.md) §8）。当前 bundle 可独立加载。

## API

- `WorkspaceEnvrc`（根导出，默认导出）：`workspaceForAgent(agent)`、`wrapArgv(canonicalWorkspace, originalArgv, dshEnv?)`、`wrapCommand(canonicalWorkspace, originalCommand, dshEnv?)`、`wrapDeferredArgv(canonicalWorkspace, originalArgv)`（Block C 的 deferred capture 链），只读 getter `bashEnabled`/`terminalEnabled`。
- `dsh-workspace-envrc/core`：`defaultConfig`、`assertWorkspaceEnvrcConfig`、`managedEnvPairs`、`buildManagedEnvShimArgv`、`buildExecArgv`、`buildDeferredManagedExecArgv`、`DEFERRED_ENV_CAPTURE_SCRIPT`、`DEFERRED_ENV_SHIM_LABEL`、`shq`、`wrapCommand`、`resolveAgentWorkspace`、`runPreflight`、`assertPosixPlatform`、`PreflightError` 与相关类型；均为无框架纯函数，公开 API 不暴露任何 secret 或环境快照。
- `dsh-workspace-envrc/bash-adapter`：`installWorkspaceEnvrcBashAdapter(ctx)` 与 `WorkspaceEnvrcBashAdapterHandle`。
- `dsh-workspace-envrc/terminal-adapter`：`installWorkspaceEnvrcTerminalAdapter(ctx)` 与 `WorkspaceEnvrcTerminalAdapterHandle`（operation-local ALS 上下文封装，内部实现）。
- `dsh-workspace-envrc/integration-plugin`：`name`/`inject`/`Config`/`apply`（函数插件，无 default）。

## 开发

```sh
pnpm install        # repo-local store（.npmrc）
pnpm test           # vitest 全量
pnpm typecheck      # src + tests 严格类型检查
pnpm build          # tsc -> dist
```

测试不读取也不写入真实用户 direnv 授权状态（不调用真实 `direnv allow`，不执行 workspace `.envrc`）；shim 脚本与 wrapped command 用真实子进程在隔离显式环境中验证（不改 `process.env`）；后台路径用真实 AgentRegistry + ToolRuntime + tool-bash + jobs provider 验证（仅 `ctx.shell` provider 为记录型 stub）。

## 安全与信任边界

- 授权始终由用户在本机 direnv 侧完成（`direnv allow` 只属于用户）；`.envrc` 内容变更后 hash 失效会阻塞后续执行，直到用户重新 allow。DSH 侧没有任何 allow/deny/编辑入口。
- 每个启用执行的包装形状为 `direnv exec <canonical-root> <managed-env-shim> <original>`：求值与命令在同一进程树内（sandbox 开启时整体位于 executor/terminal 的 confine 之内）；`DSH_*` 归属在求值后恢复（terminal 路径由 spawn 前的 deferred capture 提供精确快照），`BASH_ENV`/`ENV` 是控制变量例外（整条 chain 移除，原始程序也不可见），其余普通环境变量（含 `.envrc` 显式导出的 credential-shaped 变量）遵循原生 direnv 语义。
- 诊断与错误只含 stage、可执行文件路径与退出事实，不打印 stdout/stderr/env/secret；公开 API 不接受、不返回任何环境快照之外的敏感内容。

## 许可证

MIT，见 [LICENSE](LICENSE)。
