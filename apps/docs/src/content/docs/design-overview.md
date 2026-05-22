---
title: "设计总览"
---

# 设计总览

Open Agent Harness 设计文档的导航入口。

## 术语约定

- [术语约定](./terminology/) -- `Agent Engine`、`Agent Runtime`、`Agent Spec` 的边界与命名规则
- [概念关系](./concept-relationships/) -- `Workspace`、`Worker`、`Sandbox`、`Runtime` 的层级关系图

## 三个核心概念

| 概念 | 定位 | 说明 |
|------|------|------|
| **Workspace** | 能力边界 | 每个 workspace 声明自己的 agent、model、tool、skill、action、hook，并在同一目录结构内完成能力发现与执行。 |
| **Session** | 上下文边界 | 一段连续的对话或任务协作，绑定在某个 workspace 下。 |
| **Run** | 执行边界 | 一次模型推理 + 工具循环。同一 session 内 run 串行执行。 |

## 按主题阅读

### 架构与领域

- [架构总览](./architecture-overview/) -- 分层、模块、请求链路
- [领域模型](./domain-model/) -- 核心对象与关系
- [存储设计](./storage-design/) -- PostgreSQL / Redis / SQLite 职责划分

### Workspace 配置

- [Workspace 导航](./workspace/)
- [Settings](./workspace/settings/) | [Agents](./workspace/agents/) | [Models](./workspace/models/)
- [Skills](./workspace/skills/) | [External Tools](./workspace/mcp/) | [Hooks](./workspace/hooks/)

### Engine

- [Engine 导航](./engine/)
- [生命周期](./engine/lifecycle/) | [上下文引擎](./engine/context-engine/)
- [Queue 与可靠性](./engine/queue-and-reliability/) | [事件与审计](./engine/events-and-audit/)

### 对外接口

- [API 参考](./openapi/) | [Schema 导航](./schemas/)

### 部署

- [快速开始](./getting-started/) | [部署与运行](./deploy/) | [服务端配置](./server-config/)

## 按角色阅读

### 平台开发者

1. [架构总览](./architecture-overview/)
2. [术语约定](./terminology/)
3. [概念关系](./concept-relationships/)
4. [领域模型](./domain-model/)
5. [Workspace 导航](./workspace/)
6. [Engine 导航](./engine/)

### 接入方 / 产品团队

1. [快速开始](./getting-started/)
2. [部署与运行](./deploy/)
3. [API 参考](./openapi/)
4. [Streaming](./openapi/streaming/)

### 排查问题

1. [部署与运行](./deploy/)
2. [生命周期](./engine/lifecycle/)
3. [Queue 与可靠性](./engine/queue-and-reliability/)
4. [事件与审计](./engine/events-and-audit/)
