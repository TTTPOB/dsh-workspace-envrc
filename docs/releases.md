# 构建与交付

本包要求 Node >=24.9、DSH 0.2.2-rc.1、Cordis 4.1.0，并与 overlay 0.4.x 配套交付。Shell/scope 服务接口没有变化；Bash 与 MCP 回归使用独立 native executor 插件和批量 `tools.execute` 接口，不启动 Host。

普通开发依赖以 npm 官方 0.2.2-rc.1 为基线。完整组合仍需 Agent/preset registry 0.2.2-rc.1-fork1 及新 overlay tarball。`.github/release-dependencies.json` 中这些资产的 `source` 保持 `null`，阻止在依赖未就绪时发布。source 锁文件暂以旧 overlay 0.3.0 正式资产引导类型依赖，并 override 其 DSH peers 到新基线；它不能作为升级后组合行为通过的证据。新 overlay 的本地消费验证必须在隔离副本中替换该资产。

取得本地产物后，将包名到 tarball 的映射写入忽略目录下的 JSON，运行 `node .github/scripts/prepare-local.mjs <映射文件>`，在生成的 `.artifacts/local-source` 隔离副本执行 `pnpm typecheck && pnpm test && pnpm release:pack && pnpm verify:consumer`。测试保留 foreground/background Bash、原生 direnv 授权、workspace MCP 及真实 Loader composition；缺少 fork 包时标记**待 fork 包**，不删除测试。

正式交付顺序为 fork DSH 包 → overlay 0.4.0 → envrc 0.4.0。等待 overlay Actions Release 资产后填入正式 URL，并用 pnpm 重新生成可移植锁文件；不得提交本机 `file:` 路径，不覆盖旧 Release。两个插件由 profile 普通 dependencies 安装（`autoInstallPeers: false`），共用插件行按 overlay 后 envrc 的顺序声明。本任务不修改真实 profile 或启停 Host。
