# 术语约定

本文档定义仓库内统一使用的核心命名，避免 `runtime` 同时指“执行系统”和“被执行对象”。

一句话版本：

`Agent Engine runs an Agent Runtime and extends it with Agent Spec.`

如果你想看这些概念怎么放到同一张系统图里，再继续读：

- [concept-relationships.md](./concept-relationships.md)

## 核心定义

| 术语 | 定位 | 说明 |
| --- | --- | --- |
| `Agent Engine` | 执行系统 | 负责加载、调度、执行、恢复、审计，以及对外提供 API / SSE。 |
| `Agent Runtime` | 主运行对象 | 负责承载一套可运行的 agent / action / hook 等定义。旧称 `blueprint`。 |
| `Agent Spec` | 用户扩展层 | 用户基于 runtime / workspace baseline 额外叠加的说明与资源，主要包括 `AGENTS.md`、`MEMORY.md`，以及额外加载的 `model` / `tool` / `skill`。 |

## 产品与发行层命名

下面这组缩写用于描述 OAH 作为基础设施体系的层级，不替代上面的 Engine / Runtime / Spec 运行时术语：

| 缩写 | 名称 | 边界 |
| --- | --- | --- |
| `OAR` | Open Agent Runtime | 面向开发者的可发布 runtime 包层。一个 OAR 可以被放入 `runtimes/`，用于初始化 workspace。 |
| `OAS` | Open Agent Spec | 面向实际用户的 Spec 层。特指用户基于 OAR / runtime 叠加到 workspace 上的配置与导入资源，例如 `AGENTS.md`、`MEMORY.md`、用户导入的 `tool` / `skill` / `model`。 |
| `OAH` | Open Agent Harness | 企业/平台部署形态。默认面向 Compose / K8S、PostgreSQL、Redis、对象存储、控制面和 sandbox fleet。 |
| `OAP` | Open Agent Harness Personal | 个人部署形态。默认面向 local daemon、SQLite、本地磁盘、embedded worker 和单用户 workspace。 |

推荐记法：

```text
OAR packages what developers publish.
OAS extends a runtime-backed workspace with what the user brings.
OAH deploys it for teams and platforms.
OAP deploys it for one local user.
```

`OAH` 与 `OAP` 都应保持同一套 API / SSE 兼容性。WebUI、TUI 和 Desktop 连接的是 API endpoint，而不是某个固定部署形态。

注意：`OAS` 不是 OpenAPI、REST/SSE contract 或 JSON Schema 的统称；这些属于 API / config schema。`OAS` 对齐的是 `Agent Spec`，也就是用户额外带来的 workspace 级配置与资源。

作者边界上，`OAR` 更多面向开发者：开发者设计、测试和发布 runtime。`OAS` 更多面向实际用户：用户在 OAR 初始化出来的 workspace 或已有 runtime baseline 上导入工具、技能、模型入口、项目说明和记忆。

客户端边界上，WebUI、TUI、Desktop 应连接 OAH-compatible API，并通过 server profile / capabilities 判断当前是 OAH enterprise server 还是 OAP local daemon。

## 边界口诀

- `Engine`：how it runs
- `Runtime`：what runs
- `Spec`：what the user adds

## 什么属于 Runtime

下面这些概念属于 `Runtime`，不再单独命名为某种 `spec`：

- agent 定义
- action 定义
- hook 定义
- runtime 自带的能力组合与默认行为
- `runtimes/` 下可被用来初始化 workspace 的运行单元

推荐说法：

- `agent runtime`
- `hook runtime`
- `runtime definition`

不推荐说法：

- `agent spec`
- `hook spec`
- `runtime spec`

## 什么属于 Spec

`Spec` 不是整个 runtime 结构，而是用户附加在 runtime 之上的扩展层。当前主要包括：

- 项目根目录的 `AGENTS.md`
- 项目根目录的 `MEMORY.md`
- 通过配置额外加载的 `model`
- 通过配置额外加载的 `tool`
- 通过配置额外加载的 `skill`

判断标准很简单：

- 如果它描述“用户另外补充了什么”，更接近 `Spec`
- 如果它描述“系统本身实际跑的对象是什么”，更接近 `Runtime`

## 例子

| 场景 | 正确称呼 |
| --- | --- |
| 执行 run、管理队列、写事件日志 | `Engine` |
| 一个用于初始化 workspace 的目录模板 | `Runtime` |
| 项目里的 `AGENTS.md` | `Spec` |
| 用户通过设置额外挂载一组 skills | `Spec` |
| agent / action / hook 的主体定义 | `Runtime` |

## 避免歧义的命名规则

当语义是在说“执行过程”而不是“主运行对象”时，优先使用这些词：

- `engine`
- `run`
- `session`
- `execution`
- `engine state`

因此：

- 用 `EngineLogger`，不要再用执行语义的 `RuntimeLogger`
- 用 `engine.log`，不要把执行日志命名成 `runtime.log`
- 用 `engine state paths`，不要把 engine 的内部状态路径继续叫成泛化的 runtime paths

## 推荐总述

在仓库文档、代码注释、UI 文案里，优先使用下面这句作为总述：

`Agent Engine runs an Agent Runtime and extends it with Agent Spec.`
