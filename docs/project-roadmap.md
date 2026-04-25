# 当前进度

## 相关文档

- [架构总览](./architecture-overview.md) -- 产品与架构边界
- [快速开始](./getting-started.md) / [部署与运行](./deploy.md) -- 启动与部署
- [实施路线](./implementation-roadmap.md) -- 历史设计顺序
- [Engine / Worker 执行层成熟化路线图](./engine/worker-scaling-roadmap.md) -- worker、扩缩容与控制面后续实现计划

## 当前重点

- 维持运行时真值边界，保持实现、设计和 OpenAPI 描述一致
- 按需评估更积极的恢复策略（自动重新入队 / 续跑），当前仅 fail-closed recovery
- 已明确延期的能力保持为候选项：Unix socket 模型运行时、`action_run` / `artifact` 一等化

## 仓库路线图

仓库根目录不再单独维护 `ROADMAP.md`。

当前进度与后续方向以本站点内文档为准：

- 本页负责描述当前状态与近期重点
- [实施路线](./implementation-roadmap.md) 保留历史实施顺序
- [Engine / Worker 执行层成熟化路线图](./engine/worker-scaling-roadmap.md) 继续承载 worker / 扩缩容 / 控制面相关专题演进
