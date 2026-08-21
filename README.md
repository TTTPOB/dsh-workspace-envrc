# dsh-workspace-envrc

> English version: [docs/README.en.md](docs/README.en.md)

DSH 树外 bundle：把本机原生 direnv 环境应用到显式归属于 Agent/workspace 的 Bash 执行（foreground 与 background）和本地 stdio workspace MCP 行。插件把 `.envrc` 发现、求值、授权 hash、allow/deny、stdlib 与环境变更全部委托给已安装的 `direnv` 可执行文件；它不解析或 source `.envrc`，不维护授权数据库，不调用 `direnv allow`/`permit`/`grant`/`edit`，不使用 `direnv export`，不 watch 或缓存 `.envrc`，不修改 Harness 的 `process.env`，也不向模型暴露 allow/deny 工具。

目标 DSH 为 `0.1.0-rc.6`。本 bundle 依赖 `dsh-workspace-overlay` 提供 canonical workspace scope、workspace-aware MCP manager 与可逆 method wrapper。

## 安装

先安装 overlay，再安装本 bundle；系统必须已经安装 `direnv`：

```sh
dsh plugin --profile web add /path/to/dsh-workspace-overlay
dsh plugin --profile web add /path/to/dsh-workspace-envrc
dsh --profile web --dump-config
```

本 bundle 的 `cordis.patch.yml` 只增加 `workspace-envrc` provider 和 `workspace-envrc-integration` 两行，不修改 overlay 或官方 DSH 行。激活 preflight 会运行 `direnv version` 和一个受限 shim 探针，但不会读取 workspace `.envrc`。

卸载：

```sh
dsh plugin --profile web remove dsh-workspace-envrc
```

## 原生 direnv 语义

- workspace 只来自发起 Agent 的 scope ancestry：从 `scopeOf(agent.ctx)` 沿 `scopeParentOf` 上行，取 `workspaceCordis.workspaceForScope` 的首个命中；不从 command workdir 或 `session.header.cwd` 猜测。
- `direnv exec <canonical-workspace>` 只选择环境，原程序 cwd 保持调用方解析值。
- 无 `.envrc` 时原生 direnv 透传继承环境；未 allow、deny 或内容变化导致 hash 失效时，原生 direnv 拒绝执行，原程序不会运行。
- 授权只能由用户在 DSH 外执行 `direnv allow <exact .envrc>`；本插件没有授权入口。
- `.envrc` 允许后导出的普通变量遵循原生 direnv 语义。Harness 管理的 `DSH_*` 在 direnv 后按执行路径的显式 snapshot 恢复，workspace MCP 使用空 snapshot 并清除可能伪造的 `DSH_*`。
- `BASH_ENV` 和 `ENV` 从受管理 shim 与原程序环境中移除，避免允许后的环境改变恢复步骤。

## Bash

集成插件可逆装饰 `ctx.shell.resolve`。仅当调用存在当前 initiator Agent，并且该 Agent 映射到 canonical workspace 时，插件才把 `request.command` 替换为：

```text
exec direnv exec <canonical-workspace> <managed-env-shim> <original-command>
```

`workdir`、timeout、stdout cap、signal、stdin、普通 env、`dshEnv` 和 sandbox policy 保持原值。Foreground 与 `run_in_background` 都在各自新进程启动时冻结环境；agentless 或未映射调用原样透传。

## Workspace MCP

集成插件可逆装饰 `ctx.workspaceMcp.activate`。只有映射到 canonical workspace 的本地 stdio MCP 行会被包装；global、HTTP、foreign scope 和格式错误的行原样交给 manager。包装只改写 `command`/`args`，不改变 cwd、显式 env、重连、启动失败策略或 tool timeout。

当前 overlay MCP stdio transport 没有 sandbox/confine seam，因此 MCP 子进程和 `.envrc` 求值使用 transport 的宿主进程权限。这是已知边界，不宣称与 Bash sandbox 等价。

## 不支持 persistent shell

本 bundle 不支持 persistent shell 或 terminal creation。DSH 把 `terminals` 挂载在 preset 私有 isolated realm 中，而本 bundle 是 Host profile layer；为此引入 preset augmentation 会依赖尚未稳定的内部挂载 API，当前使用场景也不需要该能力。决策与重新考虑条件见 [ADR 0001](docs/adr/0001-no-persistent-shell.md)。

## 配置

```ts
interface WorkspaceEnvrcConfig {
  executable: string
  shimShell: string
  enableBash: boolean
  enableWorkspaceMcp: boolean
  versionCheckTimeoutMs: number
}
```

默认值：

```yaml
executable: direnv
shimShell: /bin/bash
enableBash: true
enableWorkspaceMcp: true
versionCheckTimeoutMs: 5000
```

## 安全边界

- 不读取、记录或打印完整 env snapshot、`.envrc` 内容、stdout/stderr 或 secret。
- 不修改 Host `process.env`；不同 workspace 的执行按 Agent scope 解析，不共享 mutable workspace 状态。
- 所有命令通过 argv/`spawn`/现有 DSH service seam 执行，不使用 `shell: true` 拼接 workspace 路径。
- fiber dispose 会按 MCP → Bash 的逆安装顺序恢复 method descriptor；失败的 MCP 安装会回滚已安装的 Bash adapter。

## 许可证

MIT，见 [LICENSE](LICENSE)。
