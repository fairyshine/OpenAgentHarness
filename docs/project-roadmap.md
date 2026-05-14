# 当前进度

## 相关文档

- [架构总览](./architecture-overview.md) -- 产品与架构边界
- [快速开始](./getting-started.md) / [部署与运行](./deploy.md) -- 启动与部署
- [实施路线](./implementation-roadmap.md) -- 历史设计顺序
- [Engine / Worker 执行层成熟化路线图](./engine/worker-scaling-roadmap.md) -- worker、扩缩容与控制面后续实现计划
- [Rust 热路径优化总结](./engine/rust-hot-paths.md) -- native workspace sync 的决策边界与后续测量重点

## 当前重点

- 维持运行时真值边界，保持实现、设计和 OpenAPI 描述一致
- 继续加固 OAP 发布安装路径：release tarball / registry install、clean-install smoke、runtime assets 与 WebUI assets 打包检查
- 按需评估更积极的恢复策略（自动重新入队 / 续跑），当前仅 fail-closed recovery
- 已明确延期的能力保持为候选项：Unix socket 模型运行时、`action_run` / `artifact` 一等化

## OAP 发布剩余项

OAP（Open Agent Harness Personal）仍沿用同一套 OAH-compatible API。个人本地部署的主线是 `oah daemon`、SQLite/local disk profile、embedded worker、WebUI/TUI/Desktop 通用客户端。

近期只保留这些发布工程待办：

- Desktop 分发加固：macOS signing / notarization、自动更新、daemon supervisor 面板、endpoint profile switcher、安装包 smoke
- 包发布工程：决定哪些 `@oah/*` 包解除 `private`，明确 npm / registry 发布顺序与版本同步策略
- 发布前 gate：clean-install smoke、pack tarball 内容检查、runtime assets / WebUI assets / server entrypoint 检查
- 供应链增强：包签名、SBOM、release provenance

## 仓库路线图

仓库根目录不再单独维护 `ROADMAP.md` 或阶段性长文档。

当前进度与后续方向以本站点内文档为准：

- 本页负责描述当前状态与近期重点
- [实施路线](./implementation-roadmap.md) 保留历史实施顺序
- [Engine / Worker 执行层成熟化路线图](./engine/worker-scaling-roadmap.md) 继续承载 worker / 扩缩容 / 控制面相关专题演进
- [Rust 热路径优化总结](./engine/rust-hot-paths.md) 承载 native workspace sync 的阶段结论，根目录不再保留完整实验日志
