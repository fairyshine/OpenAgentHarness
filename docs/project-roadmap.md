# 当前进度

## 相关文档

- [架构总览](./architecture-overview.md) -- 产品与架构边界
- [快速开始](./getting-started.md) / [部署与运行](./deploy.md) -- 启动与部署
- [实施路线](./implementation-roadmap.md) -- 历史设计顺序
- [Runtime / Worker 执行层成熟化路线图](./runtime/worker-scaling-roadmap.md) -- worker、扩缩容与控制面后续实现计划

## 当前重点

- 维持运行时真值边界，保持实现、设计和 OpenAPI 描述一致
- 按需评估更积极的恢复策略（自动重新入队 / 续跑），当前仅 fail-closed recovery
- 已明确延期的能力保持为候选项：Unix socket 模型网关、`action_run` / `artifact` 一等化

## 仓库路线图

- [ROADMAP.md](https://github.com/fairyshine/OpenAgentHarness/blob/master/ROADMAP.md)
