# 设计总览

这页是 MkDocs 站点里的统一导航入口，用来快速带你进入现有的设计文档体系。

如果你更关心“先看什么”，可以直接参考下面的推荐顺序；如果你更关心某一块能力，也可以按主题跳转。

## 建议先建立这 3 个概念

- `workspace`：能力发现边界，决定能看到哪些 agent、model、skill、tool、hook
- `session`：上下文边界，承接一段连续对话或任务协作
- `run`：执行边界，每次模型推理与工具循环都落在 run 上

如果你先把这三个概念分清，后面看 runtime、API、审计和队列设计会顺很多。

## 核心约束

- 服务形态：TypeScript + Node.js 的 headless Agent Runtime
- 接口形态：REST + SSE
- 部署假设：可信内网 / 自有环境
- 身份边界：用户、组织、鉴权由外部服务管理，运行时只消费 caller context
- 执行边界：workspace 是能力发现边界，session 是上下文边界，run 是执行边界
- 存储边界：PostgreSQL 是唯一事实源，workspace 下 `.openharness/data/history.db` 是异步历史镜像

## 按主题阅读

### 总体架构

- [架构总览](./architecture-overview.md)
- [领域模型](./domain-model.md)
- [服务端配置](./server-config.md)
- [部署与运行](./deploy.md)
- [调试 CLI / TUI](./debug-cli-tui.md)

### Workspace 规范

- [Workspace 导航](./workspace/README.md)
- [规范索引](./workspace-spec.md)
- [Models](./workspace/models.md)
- [Skills](./workspace/skills.md)
- [External Tools (MCP-backed)](./workspace/mcp.md)
- [Hooks](./workspace/hooks.md)

### Runtime 设计

- [Runtime 导航](./runtime/README.md)
- [运行时设计](./runtime-design.md)
- [生命周期](./runtime/lifecycle.md)
- [上下文引擎](./runtime/context-engine.md)
- [Queue 与可靠性](./runtime/queue-and-reliability.md)
- [事件与审计](./runtime/events-and-audit.md)

### 对外接口

- [API 设计](./api-design.md)
- [OpenAPI 导航](./openapi/README.md)
- [Schema 导航](./schemas/README.md)

## 按角色阅读

### 如果你是平台开发者

建议优先看：

1. [架构总览](./architecture-overview.md)
2. [Workspace 导航](./workspace/README.md)
3. [Runtime 导航](./runtime/README.md)
4. [API 设计](./api-design.md)

### 如果你是接入方或上层产品团队

建议优先看：

1. [快速开始](./getting-started.md)
2. [部署与运行](./deploy.md)
3. [OpenAPI 导航](./openapi/README.md)
4. [Streaming](./openapi/streaming.md)

### 如果你是第一次排查问题

建议优先看：

1. [部署与运行](./deploy.md)
2. [生命周期](./runtime/lifecycle.md)
3. [Queue 与可靠性](./runtime/queue-and-reliability.md)
4. [事件与审计](./runtime/events-and-audit.md)

## 推荐阅读顺序

1. [首页](./index.md)
2. [快速开始](./getting-started.md)
3. [架构总览](./architecture-overview.md)
4. [部署与运行](./deploy.md)
5. [Workspace 导航](./workspace/README.md)
6. [Runtime 导航](./runtime/README.md)
7. [OpenAPI 导航](./openapi/README.md)
