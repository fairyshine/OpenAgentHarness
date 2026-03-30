# Open Agent Harness Design Docs

本文档集用于沉淀 Open Agent Harness 的当前架构设计。

## 核心约束

- 服务形态：TypeScript + Node.js 的 headless Agent Runtime
- 接口形态：REST + SSE
- 部署假设：可信内网 / 自有环境
- 身份边界：用户、组织、鉴权由外部服务管理，运行时只消费 caller context
- 执行边界：workspace 是能力发现边界，session 是上下文边界，run 是执行边界
- 运行时来源：平台内建 agent / model 与 workspace 当前文件声明；平台模板仅用于初始化生成文件
- 模型接入：平台级与 workspace 级双层 model entries，底层 `provider` 字段对齐 AI SDK

## 文档索引

- [architecture-overview.md](./architecture-overview.md)
  - 总体目标、系统边界、分层架构和关键决策
- [domain-model.md](./domain-model.md)
  - 领域对象、注册表和能力边界
- [workspace-spec.md](./workspace-spec.md)
  - workspace 规范导航页
- [workspace/README.md](./workspace/README.md)
  - `.openharness/` 目录规范与 YAML DSL 详细拆分文档
- [api-design.md](./api-design.md)
  - API 约束与 OpenAPI 文档导航
- [runtime-design.md](./runtime-design.md)
  - runtime 设计导航页
- [runtime/README.md](./runtime/README.md)
  - 运行时生命周期、上下文、执行、队列与事件的详细拆分文档
- [openapi/README.md](./openapi/README.md)
  - OpenAPI 3.1 草案与模块化接口说明
- [storage-design.md](./storage-design.md)
  - PostgreSQL、Redis、审计与恢复策略
- [implementation-roadmap.md](./implementation-roadmap.md)
  - 实施顺序、风险与后续演进
- [schemas/README.md](./schemas/README.md)
  - workspace 配置文件的 JSON Schema

## 推荐阅读顺序

1. [architecture-overview.md](./architecture-overview.md)
2. [domain-model.md](./domain-model.md)
3. [workspace/README.md](./workspace/README.md)
4. [runtime/README.md](./runtime/README.md)
5. [api-design.md](./api-design.md)
6. [storage-design.md](./storage-design.md)
