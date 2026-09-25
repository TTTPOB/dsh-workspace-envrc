# 构建与交付

个人 Web 发行组合直接依赖 overlay `0.2.0` 与本包 `0.2.0`，按 overlay 后 envrc 的顺序声明插件行。首次构建和交付由 DSH 主 pipeline 负责；本库不在 push、PR 或 tag 上独立发布，不修改日用 profile 或 Host。

开发和 CI 须先准备新 Agent、preset registry `fork1` 与 overlay `0.2.0` 构建产物。以官方 DSH `0.1.7-rc.2` 作为普通开发依赖基线，在隔离工作树对三项注入 tarball overrides 后执行 `pnpm install --no-frozen-lockfile`、聚焦类型检查、Bash/MCP 测试、`tsc` 构建和 `pnpm pack`。overlay `0.2.0` 未发布，无法解析可移植开发锁，因此本库不提交旧锁或绝对本机 `file:` 路径；缺少构建输入就停止，不回退到旧 overlay API。

最终安装闭包的 lockfile 由 DSH 集成环境拥有。验证构建后 ESM 入口实际解析到相同 Cordis/Agent 身份，并在隔离 Host 检查 Bash、stdio MCP 和配置 reload；日用 Host 的发布与切换不在本包任务范围内。
