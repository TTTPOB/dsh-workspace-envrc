# dsh-workspace-envrc

> English version: [docs/README.en.md](docs/README.en.md)

DSH 树外插件：把本机原生 direnv 环境应用到显式归属于 Agent/workspace 的 Bash 执行与持久终端。插件把「发现、`.envrc` 求值、授权 hash、allow/deny、stdlib、环境变更」全部委托给已安装的 `direnv` 可执行文件——绝不解析或 source `.envrc`、绝不维护授权数据库、绝不调用 `direnv allow`、绝不修改 Harness 进程的 `process.env`。

目标 DSH：`0.1.0-rc.6`。运行时 peer 包括 `@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-scope` / `@deepseek-ai/dsh-timeout` 0.1.0-rc.6 与 `dsh-workspace-overlay` ^0.1.0；`@deepseek-ai/schemastery` 按实际身份策略作为普通依赖（与 DSH 各包及兄弟仓库 `dsh-workspace-overlay` 的声明方式一致）。版本均与安装版一致。

## 当前状态（Block A：provider core）

本仓库按 [docs/implementation-plan.md](docs/implementation-plan.md) 分块实现。**当前仅完成 Block A**：独立 package 骨架与 `workspaceEnvrc` provider core。

- `ctx.workspaceEnvrc`（`WorkspaceEnvrc extends Service`，默认导出，`static inject = ['agents', 'workspaceCordis']`）。
- 严格 Config（schema + 语义校验）：`executable`（默认 `direnv`，非空、无 NUL，可为 PATH 命令或绝对路径）、`shimShell`（默认 `/bin/bash`，必须绝对路径）、`enableBash`/`enableTerminal`（默认 `true`）、`versionCheckTimeoutMs`（默认 `5000`，正整数且 ≤ `MAX_TIMER_DELAY_MS`）。
- 有界激活 preflight（`[Service.init]` 内严格 await，init 完成前 service 不 ready）：`direnv version` 与 `<shimShell> --noprofile --norc -c 'exit 0'`，不用 `shell: true`，不执行/读取任何 workspace `.envrc`，不改 `process.env`；失败消息只含 stage 与 executable/path，不含子进程 stdout/stderr/env/secret；child 在 timeout/abort/init rollback 时一律 reap（`done` 必然被 await，无 unhandled）。V1 仅 POSIX，Windows 激活即失败。第三个构造函数参数是可注入的 preflight spawn seam（确定性测试用，不进 Config schema）。
- Agent→workspace 解析：以 `scopeOf(agent.ctx)` 为起点沿 `scopeParentOf` 上行，逐 key 询问 `workspaceCordis.workspaceForScope`，首个命中即 canonical root（覆盖 agent→preset→workspace 链）；未 scoped / 无映射返回 `undefined`；不使用 `session.header.cwd`、不猜 cwd、不 import overlay 的私有 coordinator。
- 纯 wrapper core（`dsh-workspace-envrc/core`）：`direnv exec <canonical-workspace> <managed-env-shim> <original argv>`；managed shim 在 direnv 之后以 `env -u BASH_ENV -u ENV <shimShell> --noprofile --norc -c SCRIPT label count name value... original argv` 运行，SCRIPT 删除全部 `${!DSH_@}`、只恢复请求的精确 managed DSH_* 快照、再 `exec` 原程序；value 全部走 argv 不拼进脚本；managed name 严格 `DSH_[A-Z0-9_]+` 且 value 为 string；普通环境变量由 direnv 原生处理、core 不触碰。`wrapCommand` 生成 POSIX 安全 command（全部动态 argv 单引号 quote，正确处理 `'` 与 newline、拒绝 NUL），只替换 `request.command`，workdir/env/dshEnv 等一律保留。workspace 固定 canonical root，不做 per-command workdir 的嵌套 `.envrc` 选择。

**尚未接线**：Block B（可逆 Bash adapter，装饰 `ctx.shell.resolve`）与 Block C（持久终端 adapter）均未实现——当前 provider 不会包裹任何执行。`cordis.patch.yml` 只含 `workspace-envrc` provider 行（显式完整 Config），集成行留待后续块；当前 bundle 可独立加载。

## API

- `WorkspaceEnvrc`（根导出，默认导出）：`workspaceForAgent(agent)`、`wrapArgv(canonicalWorkspace, originalArgv, dshEnv?)`、`wrapCommand(canonicalWorkspace, originalCommand, dshEnv?)`。
- `dsh-workspace-envrc/core`：`defaultConfig`、`assertWorkspaceEnvrcConfig`、`managedEnvPairs`、`buildManagedEnvShimArgv`、`buildExecArgv`、`shq`、`wrapCommand`、`resolveAgentWorkspace`、`runPreflight`、`assertPosixPlatform`、`PreflightError` 与相关类型；均为无框架纯函数，公开 API 不暴露任何 secret 或环境快照。

## 开发

```sh
pnpm install        # repo-local store（.npmrc）
pnpm test           # vitest 全量
pnpm typecheck      # src + tests 严格类型检查
pnpm build          # tsc -> dist
```

测试不读取也不写入真实用户 direnv 授权状态（不调用真实 `direnv allow`，不执行 workspace `.envrc`）；shim 脚本用真实子进程在隔离纯环境中验证。

## 安全与信任边界

- 授权始终由用户在本机 direnv 侧完成（`direnv allow` 只属于用户）；`.envrc` 内容变更后 hash 失效会阻塞后续执行，直到用户重新 allow。DSH 侧没有任何 allow/deny/编辑入口。
- 每个启用执行的包装形状为 `direnv exec <canonical-root> <managed-env-shim> <original>`：求值与命令在同一进程树内；`DSH_*` 归属在求值后恢复，普通环境变量（含 `.envrc` 显式导出的 credential-shaped 变量）遵循原生 direnv 语义。
- 诊断与错误只含 stage、可执行文件路径与退出事实，不打印 stdout/stderr/env/secret；公开 API 不接受、不返回任何环境快照之外的敏感内容。

## 许可证

MIT，见 [LICENSE](LICENSE)。
