# Open Agent Harness

中文 | [English](./README.md)

Open Agent Harness 是一个企业级、无 UI 的 Agent Runtime，面向需要同时服务大量用户、会话和任务执行的产品与内部平台。

它不是“统一适配各种 Agent 框架的 API 包装层”，也不是单用户、本地优先的 Agent 小工具，而是一个可部署、可嵌入、可横向扩展的运行时内核：支持 `API / Worker` 拆分、PostgreSQL 事实存储、Redis 队列协调、结构化审计、SSE 事件流，以及基于 workspace 的能力装配。

## 为什么是 Open Agent Harness

- 企业级运行时架构，适合多用户、高并发 Agent 工作负载
- Headless、可嵌入，可作为你自己的 Web、桌面端、CLI、自动化系统或 API Gateway 的后端内核
- workspace-first，自动发现并加载 agent、model、action、skill、external tools、hook
- 支持 `API only + standalone worker` 横向扩展部署
- 面向 LLM 统一投影 tool calling 视图，但在领域层保持 `action`、`skill`、`tool`、native tool 分离
- 原生覆盖 workspace、session、message、run、审计、取消、超时、恢复、事件流等完整生命周期
- 同时支持可执行的 `project` workspace 和只读的 `chat` workspace

## 它是什么

Open Agent Harness 是一个基于 TypeScript + Node.js 的运行时内核，用来在某个 workspace 内运行 Agent 对话与任务执行。

它负责：

- 管理 `workspace`、`session`、`message`、`run` 的生命周期
- 自动发现 workspace 下的 `.openharness/` 配置
- 统一加载平台级和 workspace 级 agent / model
- 执行 shell、本地脚本、`action`、`skill`、`tool`、`hook`
- 通过 REST API 和 SSE 对外提供调用与事件流能力
- 处理队列、可靠性、取消、超时与分布式 worker 协调
- 将 workspace 历史异步镜像到本地 `.openharness/data/history.db`

当前仓库还包含：

- `apps/web`：React 19 调试控制台，方便联调 `workspace / session / message / run / SSE`
- `apps/cli`：CLI / TUI 预留入口

这些只是调试与接入层，不改变本项目“headless runtime”的产品定位。

## 它不是什么

Open Agent Harness 不负责：

- 用户、组织、成员关系、计费、管理后台等 SaaS 产品层能力
- 代码托管、CI/CD、密钥平台
- 面向公网零信任场景的强隔离沙箱
- 一个 UI-first 的聊天产品

更合理的系统边界是：认证鉴权、组织关系、访问策略由上游网关或外部服务负责；Open Agent Harness 只消费调用方上下文，并使用 `subject_ref` 等外部引用做审计、限流和访问判断。

## 架构亮点

- `PostgreSQL`：唯一事实源，保存 session、message、run、tool call、审计数据
- `Redis`：队列、锁、限流计数、短期事件协调
- `.openharness/data/history.db`：异步本地历史镜像，便于备份、迁移和离线查看
- 默认模式：`API + embedded worker`
- 生产推荐：`API only + standalone worker`
- 从第一天开始抽象执行后端，后续可接入沙箱或远程执行器

核心设计原则：

- `Workspace First`
- `Session Serial, System Parallel`
- `Domain Separate, Invocation Unified`
- `Local First, Sandbox Ready`
- `Identity Externalized`
- `Auditable by Default`

## 技术架构示意

```text
客户端 / 上游系统
  Web / Desktop / CLI / 自动化系统 / 内部服务
                  |
                  v
           API Gateway + SSE Streaming
                  |
                  v
          Session Orchestrator / Run Engine
   （负责 session 生命周期、排队、取消、超时、
      恢复、审计记录、事件分发）
                  |
      +-----------+-----------+-----------+-----------+
      |                       |                       |
      v                       v                       v
   Context Engine      Invocation Dispatcher      Hook Runtime
（加载 workspace、      （把 LLM 的 tool call      （生命周期扩展、
 agent/model/action/    映射到 native tool /        拦截器与运行时
 skill/tool 并组装上下文） action / skill / tool）     扩展点）
      |                       |                       |
      +-----------------------+-----------------------+
                              |
                              v
                     Execution Backend 抽象层
             （当前默认本地执行，未来可接入沙箱或远程执行器）
                              |
          +-------------------+-------------------+------------------+
          |                   |                   |                  |
          v                   v                   v                  v
      Native Tools         Actions              Skills          External Tools

数据与协调层
  PostgreSQL  -> session、message、run、audit 的唯一事实源
  Redis       -> 队列、锁、事件扇出、分布式协调
  history.db  -> 每个 workspace 的本地历史镜像，用于备份和离线查看

部署模式
  1. API + embedded worker
  2. API only + standalone worker
```

## Workspace 模型

Open Agent Harness 支持两种 workspace：

- `project`：常规项目 workspace，可启用工具、执行和本地历史镜像
- `chat`：只读普通对话 workspace，只包含静态 prompt、agent、model；`paths.chat_dir` 下的目录本身就是可直接使用的 workspace，也可以作为可复用的预置模式

目录结构示例：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    data/
      history.db
    agents/
      builder.md
    models/
      openai.yaml
    actions/
      test-run/
        ACTION.yaml
    skills/
      repo-explorer/
        SKILL.md
    tools/
      settings.yaml
      servers/
        docs-server/
    hooks/
      redact-secrets.yaml
```

可直接复制的模板见 [templates/README.md](./templates/README.md)：

- `templates/workspace`
- `templates/chat-workspace`

## 快速开始

安装依赖：

```bash
pnpm install
```

启动本地 PostgreSQL 和 Redis：

```bash
pnpm infra:up
```

构建并测试：

```bash
pnpm build
pnpm test
pnpm test:dist
```

启动默认后端：

```bash
pnpm dev:server -- --config ./server.example.yaml
```

如果你想直接把一个 workspace 作为专属后端启动，也可以这样运行：

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

启动独立 worker：

```bash
pnpm dev:worker -- --config ./server.example.yaml
```

启动调试 Web 控制台：

```bash
pnpm dev:web
```

示例配置文件：

```yaml
server:
  host: 127.0.0.1
  port: 8787

storage:
  # postgres_url: ${env.DATABASE_URL}
  # redis_url: ${env.REDIS_URL}

paths:
  workspace_dir: ./tmp/workspaces
  chat_dir: ./tmp/chat-workspaces
  template_dir: ./tmp/templates
  model_dir: ./tests/fixtures/models
  tool_dir: ./tmp/tools
  skill_dir: ./tmp/skills

llm:
  default_model: openai-default
```

## 运行模式

### `API + embedded worker`

- 默认模式
- 适合本地开发、PoC、单机自托管
- 配置了 Redis 时，embedded worker 会消费 Redis 队列
- 未配置 Redis 时，run 会在当前进程内执行

### `API only`

- 通过 `--api-only` 或 `--no-worker` 显式启用
- 适合生产环境拆分部署
- 配置 Redis 时，需搭配独立 worker

### `standalone worker`

- 独立 worker 进程
- 消费 Redis run queue
- 执行 queued run 和 history mirror sync
- 适合横向扩展和资源隔离

### `single workspace`

- 通过 `--workspace` 启用
- 启动时只注册并服务一个 workspace
- 适合围绕单个 repo 或单个只读 chat workspace 提供后端服务
- 仍然复用同一套 HTTP API 和 runtime 内核
- 会禁用 workspace template 列表、workspace 创建/导入、workspace 删除等管理接口

## 文档入口

- [docs/README.md](./docs/README.md)
- [docs/deploy.md](./docs/deploy.md)
- [docs/architecture-overview.md](./docs/architecture-overview.md)
- [docs/workspace/README.md](./docs/workspace/README.md)
- [docs/runtime/README.md](./docs/runtime/README.md)
- [docs/openapi/README.md](./docs/openapi/README.md)

## 常用开发命令

```bash
pnpm install
pnpm infra:up
pnpm build
pnpm test
pnpm test:dist
pnpm dev:server
pnpm dev:worker
pnpm dev:web
```
