# 发布与依赖维护

推送 `v*` tag 触发 [Release workflow](../.github/workflows/release.yml)。Tag 必须等于 `v` 加 `package.json.version`。main、PR 与手工运行只验证，不发布。Actions 使用 Node 24、manifest 固定的 pnpm 和系统 direnv，执行冻结 lockfile 安装、typecheck、test（含清空 dist 后 build）和 pack，成功后创建带 `.tgz` 与 `SHA256SUMS` 的 Release。同名 Release 不覆盖，修复使用新版本。

envrc 的开发依赖固定到已发布 overlay tarball，不依赖相邻 checkout。升级 overlay 时先发布 overlay，再更新此包的开发 URL、peer 范围和 lockfile。共享 DSH/Cordis 依赖采用 peer + 固定开发基线；升级 Host 后按实际子包版本验证，RC 范围不会自动包含其它版本号上的预发布版。

本地验证：`pnpm install && pnpm typecheck && pnpm test && pnpm release:pack`。测试使用临时目录和隔离的 direnv 授权状态。发布前更新版本与安装示例，提交后推送 main 和 `v<version>` tag。安装使用固定 Release 下载 URL，不使用 `latest/download`，也不在安装时构建源码。

日常 profile 通过安装版 `dsh plugin --profile web add <Release URL>` reconciliation。必须检查 manifest、lockfile、实际模块解析、bundle 顺序与 `dsh --profile web --dump-config`；overlay 在 envrc 前。重启 Host 后验证新建会话。版本号相同的独立模块仍可能产生不同 Symbol/WeakMap，因此必须共享实际模块实例。

切换到 Release 并完成验证后，`pnpm clean` 删除本地 dist；再次开发时 `pnpm build` 恢复。pnpm store/cache 保持用户级默认位置。
