# Open Agent Harness Design Docs

本文档集用于沉淀 Open Agent Harness 的当前架构设计。

如果你是在浏览源码仓库，这页更像"设计文档总索引"；如果你是在文档站里阅读，建议优先从 [首页](./index.md) 或 [设计总览](./design-overview.md) 进入。

## 核心约束

- 服务形态：TypeScript + Node.js 的 headless Agent Engine
- 接口形态：REST + SSE
- 客户端入口：WebUI、TUI、Desktop 都只消费现有 API / SSE，并通过 server profile 适配 OAH / OAP
- 部署假设：可信内网 / 自有环境
- 身份边界：用户、组织、鉴权由外部服务管理，Engine 只消费 caller context
- 执行边界：workspace 是能力发现边界，session 是上下文边界，run 是执行边界
- Runtime 来源：`runtime_dir` 下的 runtimes 仅用于初始化 workspace；运行中的能力来自平台内建能力与 workspace 当前文件声明
- 模型接入：平台级与 workspace 级双层 model entries，底层 `provider` 字段对齐 AI SDK
- 消息模型：session / model 调用统一采用 AI SDK 风格消息内容，`content` 可为文本或 message parts
- 存储边界：PostgreSQL 是中心事实源；workspace 下 `.openharness/data/history.db` 仅作为本地 engine 状态数据文件
- 服务端配置：可通过独立配置文件声明 workspace 根目录、runtime 根目录、模型目录等 engine 级选项

## 文档索引

- [architecture-overview.md](./architecture-overview.md) — 总体目标、系统边界、分层架构和关键决策
- [terminology.md](./terminology.md) — Engine / Runtime / Spec 的统一边界
- [concept-relationships.md](./concept-relationships.md) — Workspace / Worker / Sandbox / Runtime 的层级关系图
- [domain-model.md](./domain-model.md) — 领域对象、注册表和能力边界
- [server-config.md](./server-config.md) — 服务端配置文件与运行模式
- [deploy.md](./deploy.md) — 本地启动、联调、embedded worker 与拆分部署方式
- [home-and-deploy-root.md](./home-and-deploy-root.md) — `OAH_HOME`、`OAH_DEPLOY_ROOT`、local daemon 与部署 profile 的目录契约
- [tui.md](./tui.md) — TUI 的定位、入口和边界；`oah` 命令与 TUI 是同一终端入口的两种模式
- [k8s-compose-reuse-matrix.md](./k8s-compose-reuse-matrix.md) — Compose 优化到 K8S 的复用对照
- [k8s-rollout-checklist.md](./k8s-rollout-checklist.md) — K8S staging / production 上线检查清单
- [k8s-operations-runbook.md](./k8s-operations-runbook.md) — K8S 常见异常的排障与恢复手册
- [workspace/README.md](./workspace/README.md) — `.openharness/` 目录规范与配置详解
- [engine/README.md](./engine/README.md) — Engine 生命周期、上下文、执行、队列与事件
- [openapi/README.md](./openapi/README.md) — API 参考与 OpenAPI 3.1 规范
- [storage-design.md](./storage-design.md) — PostgreSQL、Redis、workspace 本地数据、审计与恢复策略
- [schemas/README.md](./schemas/README.md) — workspace 配置文件的 JSON Schema

## 按目标快速跳转

- 想先把系统跑起来：看 [deploy.md](./deploy.md)
- 想统一本地 daemon、Compose 和 K8S 的目录结构：看 [home-and-deploy-root.md](./home-and-deploy-root.md)
- 想理解 OAH / OAP / OAR / OAS 的产品与配置层级：看 [architecture-overview.md](./architecture-overview.md) 和 [terminology.md](./terminology.md)
- 想在终端里使用 workspace/session：看 [tui.md](./tui.md)
- 想确认 Compose 优化是否继承到 K8S：看 [k8s-compose-reuse-matrix.md](./k8s-compose-reuse-matrix.md)
- 想做 K8S 上线检查：看 [k8s-rollout-checklist.md](./k8s-rollout-checklist.md)
- 想做 K8S 故障排查：看 [k8s-operations-runbook.md](./k8s-operations-runbook.md)
- 想理解系统边界：看 [architecture-overview.md](./architecture-overview.md)
- 想先对齐命名：看 [terminology.md](./terminology.md)
- 想先搞清概念层级：看 [concept-relationships.md](./concept-relationships.md)
- 想配置 workspace：看 [workspace/README.md](./workspace/README.md)
- 想理解执行链路：看 [engine/README.md](./engine/README.md)
- 想对接 API / SSE：看 [openapi/README.md](./openapi/README.md)

## 推荐阅读顺序

1. [architecture-overview.md](./architecture-overview.md)
2. [terminology.md](./terminology.md)
3. [concept-relationships.md](./concept-relationships.md)
4. [domain-model.md](./domain-model.md)
5. [server-config.md](./server-config.md)
6. [workspace/README.md](./workspace/README.md)
7. [engine/README.md](./engine/README.md)
8. [openapi/README.md](./openapi/README.md)
9. [storage-design.md](./storage-design.md)
