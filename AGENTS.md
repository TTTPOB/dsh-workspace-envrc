# dsh-workspace-envrc 开发约定

树外 DSH bundle：把本机原生 `direnv` 环境应用到两路——显式归属 Agent/workspace 的 Bash 执行（foreground 与 background），以及本地 stdio workspace MCP 行。本包依赖 `dsh-workspace-overlay` 提供 canonical workspace scope 与 workspace-aware MCP manager。

## 委托边界（本包不做的事）

`.envrc` 的发现、求值、授权 hash、allow/deny、stdlib 与环境变更全部委托给已安装的 `direnv`。本包：

- 不解析、不 source `.envrc`，不维护授权数据库；
- 不调用 `direnv allow`／`permit`／`grant`／`edit`，不使用 `direnv export`；
- 不 watch、不缓存 `.envrc`；
- 不修改 Host 的 `process.env`；
- 不向模型暴露任何 allow/deny 工具。

授权只能由用户在 DSH 之外执行 `direnv allow <exact .envrc>`。

## 语义契约

- workspace 只来自发起 Agent 的 scope ancestry：从 `scopeOf(agent.ctx)` 沿 `scopeParentOf` 上行，取 `workspaceCordis.workspaceForScope` 的首个命中。**不从 command workdir 或 `session.header.cwd` 猜测。**
- `direnv exec <canonical-workspace>` 只选择环境，原程序 cwd 保持调用方解析值。
- 未 allow、被 deny 或内容变化导致 hash 失效时，原生 direnv 拒绝执行，原程序不会运行。
- `DSH_*` 在 direnv 之后按执行路径的显式 snapshot 恢复；workspace MCP 使用空 snapshot 并清除可能伪造的 `DSH_*`。
- 从受管 shim 与原程序环境中移除 `BASH_ENV` 与 `ENV`，避免允许后的环境改变恢复步骤。
- Bash 只可逆装饰 `ctx.shell.resolve`，且仅对存在当前 initiator Agent 并映射到 canonical workspace 的调用生效；agentless 或未映射调用原样透传。`workdir`、timeout、输出上限、signal、stdin、普通 env 与 sandbox policy 保持原值。
- Workspace MCP 只包装映射到 canonical workspace 的本地 stdio 行；global、HTTP、foreign scope 与格式错误的行原样交给 manager。

## 不支持 persistent shell

DSH 把 `terminals` 挂在 preset 私有的 isolated realm，而本包是 Host profile layer。不为此引入 preset augmentation，也不依赖尚未稳定的内部挂载 API。理由与重新考虑条件见 [ADR 0001](docs/adr/0001-no-persistent-shell.md)。

## 安全边界

- 不读取、记录或打印完整 env snapshot、`.envrc` 内容、stdout/stderr 或 secret。
- 不使用 `shell: true`，不拼接 workspace 路径；命令经 argv／`spawn` 或既有 DSH service seam 执行。
- 已知边界：overlay 的 stdio transport 没有 sandbox/confine seam，因此 MCP 子进程与 `.envrc` 求值使用宿主进程权限。**不要宣称这与 Bash sandbox 等价。**
- fiber dispose 按 MCP → Bash 的逆安装顺序恢复 method descriptor；MCP 安装失败要回滚已安装的 Bash adapter。

## 验证

```sh
pnpm typecheck && pnpm test && pnpm verify:consumer
```

`pnpm test` 先 build 再跑 vitest。原生 direnv 测试只操作临时 fixture，不启动 Host。

## 分支与发布

- 长期发布分支为 `main`，位于 TTTPOB remote `origin`（github.com/TTTPOB/dsh-workspace-envrc）；本地长期分支必须跟踪 `origin/main`，不跟踪第三方上游。
- 开发和测试使用独立分支或 worktree。
- 发布前先合并到长期分支并 push，等待分支 CI（`.github/workflows/release.yml`）通过。
- 仅从长期分支上的提交，通过 GitHub Actions Release workflow（`.github/workflows/release.yml`）发布；tag 和 Release 资产不可变，不上传本地构建。
- 本机约 13 GB 内存，本地只跑本仓库相关的 scoped 检查；重型全仓检查交给 CI。
