<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-readme-dark.png" />
    <img src="assets/logo-readme.png" width="180" alt="Open Agent Harness Logo" />
  </picture>
</p>

<h1 align="center">Open Agent Harness</h1>

<p align="center">
  面向企业内部 AI 平台、Agent 产品和嵌入式 Copilot 场景的 headless、workspace-first Agent Engine。
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./docs/getting-started.md">快速开始</a> · <a href="./docs/README.md">文档</a>
</p>

---

## 它是什么

Open Agent Harness（OAH）是一个面向 Agent 系统的后端运行时引擎。

你可以保留自己的产品表层能力，比如聊天 UI、认证、租户模型、业务流程和产品体验；OAH 负责底下这一层执行引擎：

- workspace 加载与能力发现
- session 与 run 编排
- 模型与工具循环执行
- sandbox 与文件/命令访问接口
- 队列、流式事件、恢复与审计
- 本地和拆分部署拓扑

它不是开箱即用的 SaaS 应用，也不是一个面向终端用户打磨完成的聊天产品。
它更像是你可以拿来构建这些产品的可编程运行时内核。

## 当前状态

这个仓库现在已经不只是架构草图，当前已经包含：

- 一套可运行的 HTTP API，覆盖 workspaces、sessions、runs、actions、sandboxes、models、storage inspection 和 SSE streaming
- 明确的多进程拓扑，包括 `oah-api`、`oah-controller` 和承载 standalone worker 的 sandbox
- 一个用于调试和排障的 Web 控制台
- 针对 agents、models、skills、tools、actions、hooks、prompts 和项目说明的 workspace 自动发现机制
- 自带 deploy-root 模板、starter runtimes 和对象存储同步流程
- 本地 Docker Compose 启动方式，以及 Kubernetes / Helm 的 split deployment 骨架

如果你正在评估 OAH 能否作为 Agent Engine 基座，当前仓库已经足够拿来跑通、观察和扩展。

## 可以用它构建什么

当你需要一套可复用的 Agent 后端去承载多个项目或团队时，OAH 会比较合适：

- 带 repo 定制 agent 和 tools 的工程 Copilot
- 多 Agent 产品，共享同一套 runtime substrate
- 嵌入到现有产品里的 Copilot 或 Agent 能力
- 面向单个仓库或单个租户的专属后端
- 希望掌控运行时而不是只包一层聊天界面的平台型团队

## 核心模型

系统围绕四个核心概念展开：

| 概念 | 边界 | 含义 |
| --- | --- | --- |
| `sandbox` | 执行宿主边界 | 定义承载 workspace 的宿主环境，以及文件/命令执行实际落在哪里 |
| `workspace` | 能力边界 | 定义这个执行环境中的 agents、models、skills、tools、actions、hooks 和 prompts |
| `session` | 上下文边界 | 一个 workspace 内持续存在的对话或协作线程 |
| `run` | 执行边界 | 一次进入队列并执行的模型/工具循环 |

这让 OAH 的工作模型保持清晰：

- sandbox 定义系统“在哪里执行”
- workspace 定义系统在这个宿主边界内“能做什么”
- session 定义持续上下文
- run 在同一 session 内串行执行

## 已经可用的能力

### Runtime 与 API

- Workspace CRUD，以及 runtime/blueprint 导入和 catalog 查看
- Session 创建、消息分页读取、异步消息入队
- Run 查询、步骤级审计、取消、排队 run 的 `guide` 提升，以及手动 `requeue`
- 手动 session compaction，并持久化 `compact_boundary` 与 `compact_summary`
- 面向 run 和 session 更新的 SSE 流式事件
- 以 `/workspace` 为根的 sandbox 兼容文件与命令 API

### Workspace 能力系统

OAH 现在已经把 workspace 作为一组可组合的能力包来理解：

- `AGENTS.md` 项目说明
- `.openharness/agents/*.md`
- `.openharness/models/*.yaml`
- `.openharness/actions/*/ACTION.yaml`
- `.openharness/skills/*/SKILL.md`
- `.openharness/tools/settings.yaml` 以及本地/远程 MCP servers
- `.openharness/hooks/*.yaml`
- `.openharness/prompts.yaml` 和 `.openharness/settings.yaml`

这意味着真正的定制边界是 workspace，而不是全局进程配置。

### 运维与调试

- 支持流式对话视图的 debug web console
- UI 中可见的服务端 follow-up queue，以及显式 `Guide` 打断流程
- 用于查看 messages、run steps、system prompt、provider calls、catalog snapshot 和 records 的 inspector 面板
- 面向 PostgreSQL 和 Redis 的 storage workbench，支持 `messages.content` 检视以及手动队列/恢复操作
- health/readiness 接口，以及 controller 的 metrics/snapshot 面板

## Web 控制台

仓库自带一个用于开发和调试的 Web 控制台：

<p align="center">
  <img src="assets/web-console-screenshot.png" width="820" alt="Web 控制台截图" />
</p>

它的设计重点是运行时可观测性，而不只是聊天：

- 对话流式输出与 run 跟踪
- 输入框上方展示排队中的后续消息
- run step 和 tool call 检视
- 原始 message / run / session 记录查看
- PostgreSQL 与 Redis 的存储排障

## 架构速览

| 层次 | 职责 |
| --- | --- |
| API server | OpenAPI 入口、参数校验、调用方上下文、SSE、路由 |
| Session/run orchestration | session 内串行调度、取消、超时、恢复 |
| Context engine | prompt 装配、agent/model 解析、能力暴露 |
| LLM loop + dispatch | 模型调用、工具调用、agent 切换、subagent delegation |
| Worker execution | active workspace copy、文件访问、命令执行、sandbox 生命周期 |
| Control plane | placement 信号、worker 生命周期、扩缩容与 ownership 治理 |
| Storage | PostgreSQL 真值、Redis 队列/锁/事件分发、本地运行时状态 |

当前明确的生产方向是拆分拓扑：

- `oah-api` 负责入口与编排
- `oah-controller` 负责控制面逻辑
- standalone workers 运行在 `oah-sandbox` 或兼容的 sandbox backend 中

## 仓库结构

```text
apps/
  server/       # API server、worker 入口、bootstrap、HTTP routes
  controller/   # 控制面进程
  worker/       # worker 包装层
  web/          # debug console
  cli/          # CLI 入口
packages/
  engine-core/      # 运行时编排与内建工具层
  api-contracts/    # zod schema 和共享 API 类型
  model-gateway/    # 模型提供方抽象
  storage-*         # postgres / redis / sqlite / memory 存储实现
  config/           # workspace 与 server 配置加载
template/
  deploy-root/      # starter OAH_DEPLOY_ROOT，包含 runtimes/models/tools/skills 结构
docs/
  ...               # 架构、workspace、engine、部署、OpenAPI 文档
```

## 快速开始

### 前置要求

- Node.js `24+`
- `pnpm` `10+`
- Docker + Docker Compose

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备 deploy root

```bash
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
```

然后至少在下面目录中放入一个平台模型 YAML：

```text
$OAH_DEPLOY_ROOT/source/models/
```

对于仓库自带的 starter runtimes，默认期望的平台模型名是：

```text
openai-default
```

### 3. 启动本地整套服务

```bash
pnpm local:up
```

这会启动：

- PostgreSQL
- Redis
- MinIO
- `oah-api`
- `oah-controller`
- `oah-sandbox`

启动过程中还会自动执行一次 storage sync。

### 4. 启动 Web 控制台

```bash
pnpm dev:web
```

本地默认地址：

| 服务 | 地址 |
| --- | --- |
| Web Console | `http://localhost:5174` |
| API | `http://127.0.0.1:8787` |
| Sandbox worker host | `http://127.0.0.1:8788` |
| Controller metrics | `http://127.0.0.1:8789` |
| MinIO Console | `http://127.0.0.1:9001` |

## 其他运行方式

### 单 Workspace 模式

如果你只想直接服务一个 repo，而不走多 workspace 管理路径，可以这样启动：

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

### 拆分进程部署

如果是生产或类生产环境，推荐拆成：

- `oah-api` 作为 API 入口
- `oah-controller` 作为控制面
- 在 `oah-sandbox` 内承载 standalone workers

仓库当前已经自带：

- `docker-compose.local.yml`
- `deploy/kubernetes/` 下的 Kubernetes manifests
- `deploy/charts/open-agent-harness/` 下的 Helm chart
- 生产用 `Dockerfile`
- GitHub Actions 镜像发布工作流

## Starter Runtime 模板

deploy-root 模板目前内置两个 starter runtimes：

- `micro-learning`
  - 用于短教学闭环，包含 `learn`、`plan`、`eval`、`research` agents
- `vibe-coding`
  - 面向编码流程，包含 `build`、`plan`、`general`、`explore` agents

它们是新 workspace 的初始化模板，不是运行时的 active workspace copy 本体。

## 常用命令

```bash
pnpm build
pnpm test
pnpm dev:web
OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root pnpm storage:sync
OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root pnpm storage:sync -- --include-workspaces
OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root pnpm local:up
pnpm local:down
```

## 文档导航

| 文档 | 说明 |
| --- | --- |
| [快速开始](./docs/getting-started.md) | 本地启动与初次验证 |
| [架构总览](./docs/architecture-overview.md) | 系统边界与主要层次 |
| [Workspace 指南](./docs/workspace/README.md) | Workspace 结构与能力发现 |
| [Engine 概览](./docs/engine/README.md) | 运行时生命周期、context engine 与执行流程 |
| [API 参考](./docs/openapi/README.md) | REST + SSE 接口说明 |
| [部署说明](./docs/deploy.md) | 本地、拆分部署与 Kubernetes 路径 |
| [Deploy Root Template](./template/deploy-root/README.md) | `OAH_DEPLOY_ROOT` 模板结构 |

## 未来愿景

长期来看，我们希望 OAH 成为一套面向严肃 Agent 系统的开放运行时内核，而不是停留在 demo 栈。

当前已经比较明确的方向包括：

- 成为可以承载多种产品表层的稳定 agent-engine backend
- 持续增强控制面在 placement、warm capacity、恢复和 drain 上的能力
- 抽象出更清晰的 sandbox host 边界，让自托管 sandbox 和 E2B-like backend 共享同一套契约
- 让 runtimes、skills、tools 和 models 的 workspace 打包与分发能力更成熟
- 让 compaction、恢复、action execution 和 audit trails 这些运行时语义更一等公民

之所以强调这些，是因为 Agent 产品真正困难的部分，通常并不是聊天框本身，而是底层的运行时纪律：执行边界、可重复性、可追踪性、workspace 隔离，以及可运维性。OAH 正在朝这个方向打磨。

## 适合谁使用

**适合**

- 构建企业内部 AI 平台或嵌入式 Copilot 的团队
- 希望保留自己前端和认证体系的产品团队
- 需要 workspace 隔离和可观测执行过程的工程团队
- 希望从单机 local agent 演进到 split deployment 的平台团队

**不太适合**

- 你只想要一个开箱即用的聊天 UI
- 你只需要一个很小的本地脚本
- 你并不需要 workspace 边界、队列或运行时生命周期管理
