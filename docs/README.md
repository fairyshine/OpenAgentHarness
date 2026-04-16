# Open Agent Harness Design Docs

本文档集用于沉淀 Open Agent Harness 的当前架构设计。

如果你是在浏览源码仓库，这页更像"设计文档总索引"；如果你是在文档站里阅读，建议优先从 [首页](./index.md) 或 [设计总览](./design-overview.md) 进入。

## 核心约束

- 服务形态：TypeScript + Node.js 的 headless Agent Runtime
- 接口形态：REST + SSE
- 部署假设：可信内网 / 自有环境
- 身份边界：用户、组织、鉴权由外部服务管理，运行时只消费 caller context
- 执行边界：workspace 是能力发现边界，session 是上下文边界，run 是执行边界
- 运行时来源：平台内建 agent / model 与 workspace 当前文件声明；平台蓝图仅用于初始化生成文件
- 模型接入：平台级与 workspace 级双层 model entries，底层 `provider` 字段对齐 AI SDK
- 消息模型：session / model 调用统一采用 AI SDK 风格消息内容，`content` 可为文本或 message parts
- 存储边界：PostgreSQL 是中心事实源；workspace 下 `.openharness/data/history.db` 仅作为本地运行时数据文件
- 服务端配置：可通过独立配置文件声明 workspace 根目录、蓝图目录、模型目录等运行时级选项

## 文档索引

- [architecture-overview.md](./architecture-overview.md) — 总体目标、系统边界、分层架构和关键决策
- [domain-model.md](./domain-model.md) — 领域对象、注册表和能力边界
- [server-config.md](./server-config.md) — 服务端配置文件与运行模式
- [deploy.md](./deploy.md) — 本地启动、联调、embedded worker 与拆分部署方式
- [workspace/README.md](./workspace/README.md) — `.openharness/` 目录规范与配置详解
- [runtime/README.md](./runtime/README.md) — 运行时生命周期、上下文、执行、队列与事件
- [openapi/README.md](./openapi/README.md) — API 参考与 OpenAPI 3.1 规范
- [storage-design.md](./storage-design.md) — PostgreSQL、Redis、workspace 本地数据、审计与恢复策略
- [schemas/README.md](./schemas/README.md) — workspace 配置文件的 JSON Schema

## 按目标快速跳转

- 想先把系统跑起来：看 [deploy.md](./deploy.md)
- 想理解系统边界：看 [architecture-overview.md](./architecture-overview.md)
- 想配置 workspace：看 [workspace/README.md](./workspace/README.md)
- 想理解执行链路：看 [runtime/README.md](./runtime/README.md)
- 想对接 API / SSE：看 [openapi/README.md](./openapi/README.md)

## 推荐阅读顺序

1. [architecture-overview.md](./architecture-overview.md)
2. [domain-model.md](./domain-model.md)
3. [server-config.md](./server-config.md)
4. [workspace/README.md](./workspace/README.md)
5. [runtime/README.md](./runtime/README.md)
6. [openapi/README.md](./openapi/README.md)
7. [storage-design.md](./storage-design.md)
