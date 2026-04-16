# 设计总览

Open Agent Harness 设计文档的导航入口。

## 三个核心概念

| 概念 | 定位 | 说明 |
|------|------|------|
| **Workspace** | 能力边界 | 每个 workspace 声明自己的 agent、model、tool、skill、action、hook，并在同一目录结构内完成能力发现与执行。 |
| **Session** | 上下文边界 | 一段连续的对话或任务协作，绑定在某个 workspace 下。 |
| **Run** | 执行边界 | 一次模型推理 + 工具循环。同一 session 内 run 串行执行。 |

## 按主题阅读

### 架构与领域

- [架构总览](./architecture-overview.md) -- 分层、模块、请求链路
- [领域模型](./domain-model.md) -- 核心对象与关系
- [存储设计](./storage-design.md) -- PostgreSQL / Redis / SQLite 职责划分

### Workspace 配置

- [Workspace 导航](./workspace/README.md)
- [Settings](./workspace/settings.md) | [Agents](./workspace/agents.md) | [Models](./workspace/models.md)
- [Skills](./workspace/skills.md) | [External Tools](./workspace/mcp.md) | [Hooks](./workspace/hooks.md)

### 运行时

- [Runtime 导航](./runtime/README.md)
- [生命周期](./runtime/lifecycle.md) | [上下文引擎](./runtime/context-engine.md)
- [Queue 与可靠性](./runtime/queue-and-reliability.md) | [事件与审计](./runtime/events-and-audit.md)

### 对外接口

- [API 参考](./openapi/README.md) | [Schema 导航](./schemas/README.md)

### 部署

- [快速开始](./getting-started.md) | [部署与运行](./deploy.md) | [服务端配置](./server-config.md)

## 按角色阅读

### 平台开发者

1. [架构总览](./architecture-overview.md)
2. [领域模型](./domain-model.md)
3. [Workspace 导航](./workspace/README.md)
4. [Runtime 导航](./runtime/README.md)

### 接入方 / 产品团队

1. [快速开始](./getting-started.md)
2. [部署与运行](./deploy.md)
3. [API 参考](./openapi/README.md)
4. [Streaming](./openapi/streaming.md)

### 排查问题

1. [部署与运行](./deploy.md)
2. [生命周期](./runtime/lifecycle.md)
3. [Queue 与可靠性](./runtime/queue-and-reliability.md)
4. [事件与审计](./runtime/events-and-audit.md)
