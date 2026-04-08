<h1 align="center">Open Agent Harness</h1>

<p align="center">
  Headless、workspace-first 的 Agent Runtime，面向构建 Agent 产品、企业内部 AI 平台和嵌入式 Copilot 的团队。
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./docs/getting-started.md">快速开始</a> · <a href="./docs/README.md">文档</a>
</p>

---

## 它是什么？

Open Agent Harness 是一个**可部署的后端运行时**，负责承载 Agent 对话和任务执行。你保留自己的前端、认证体系和产品体验——runtime 负责底下的一切。

**你做自己的 Agent 产品，我们提供可复用的 runtime。**

> 不是开箱即用的聊天产品，不是身份系统，也不是 SaaS 控制平面。
> 它是这些产品背后那个可编程的运行时内核。

## Web 控制台

项目自带一个调试用 Web 控制台：

<p align="center">
  <img src="assets/web-console-screenshot.png" width="820" alt="Web 控制台截图" />
</p>

控制台提供：
- **对话视图**：流式输出、tool call 折叠展示、run 追踪
- **Inspector**：查看模型侧消息、工具列表、run 步骤和运行时 trace
- **Storage 工作台**：PostgreSQL 和 Redis 数据查看，支持结构化 `messages.content` 检视

## 架构概览

运行时分为清晰的层次：

| 层次 | 职责 |
| --- | --- |
| **API Gateway** | OpenAPI 入口、参数校验、访问控制、SSE 流式事件 |
| **Session Orchestrator** | Run 创建、session 串行调度、取消、超时、失败恢复 |
| **Context Engine** | 在 run 开始时装配 prompt、历史消息、agent 配置和能力目录 |
| **LLM Loop + Dispatcher** | 模型推理、tool calling、路由与结果回填 |
| **Execution Backend** | 本地目录级执行（可替换为容器/VM/远程沙箱） |
| **Storage** | PostgreSQL（事实源）+ Redis（队列、锁、SSE）+ 本地历史镜像 |

## Workspace-First 设计

**Workspace** 是核心定制边界。一套 runtime 可以同时承载多个 workspace，每个 workspace 可以自带：

- Agent 和 prompt 策略
- Skills、actions、tools
- Hooks 和生命周期策略
- 模型配置
- Tool servers（本地或远程）

两个 workspace 即使跑在同一个 runtime 上，也可以为不同团队、仓库或产品场景表现出完全不同的行为。

| Workspace 类型 | 说明 |
| --- | --- |
| **`project`** | 可写、可执行——启用 shell、action、skill、tool、hook |
| **`chat`** | 只读对话模式——不修改文件、不启用执行型工具 |

## 能力模型

每个能力层彼此分离，你可以按 workspace 灵活组合：

| 能力 | 作用 |
| --- | --- |
| `agent` | 定义角色、行为方式和权限边界 |
| `primary agent` / `subagent` | 主角色协作和受控 delegation |
| `tool` | 给 agent 暴露内建或外部执行能力 |
| `skill` | 封装一类任务的方法和经验 |
| `action` | 暴露稳定、可复用、可触发的命名任务 |
| `hook` | 在运行时关键事件上增加治理、检查或扩展逻辑 |
| `context` | 控制 prompt 和 workspace 指令如何组合进模型上下文 |

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动基础设施（PostgreSQL + Redis）
pnpm infra:up

# 启动后端服务
pnpm dev:server -- --config ./server.example.yaml

# 启动 Web 控制台（另一个终端）
pnpm dev:web
```

**本地地址：**

| 服务 | 地址 |
| --- | --- |
| Web 控制台 | `http://localhost:5174` |
| 后端 API | `http://127.0.0.1:8787` |

### 单 Workspace 模式

围绕单个 workspace 启动专属后端：

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

### 常用命令

```bash
pnpm build          # 构建所有包
pnpm test           # 运行测试
pnpm dev:worker -- --config ./server.example.yaml  # 启动 worker
```

## 适用场景

**很适合：**
- 构建企业内部 AI 平台或 Agent 产品——开发者定义 agent 工作逻辑，用户根据场景切换不同 agent，共用同一套 runtime
- 需要一个后端同时服务多个 workspace
- 希望保留自己的前端、认证体系和产品体验，复用共享 runtime
- 需要比固定 Agent UI 或本地 agent loop 更强的控制力

**不太适合：**
- 只想要一个开箱即用的聊天界面
- 只需要一个很小的单用户本地脚本
- 暂时不需要 workspace 隔离和运行时生命周期管理

## 典型场景

| 场景 | 为什么适合 |
| --- | --- |
| 企业内部研发 Copilot | 不同仓库/团队共享 runtime，各自配置不同 agent |
| 多 Agent 产品 | 开发者定义 agent 逻辑，用户按场景切换，共用一套 runtime |
| 现有产品中的嵌入式 Copilot | Runtime 保持 headless，放在现有产品后面 |
| 单 repo 专属后端 | `single workspace` 模式直接聚焦部署 |

## 文档导航

| 文档 | 说明 |
| --- | --- |
| [快速开始](./docs/getting-started.md) | 环境搭建和第一步 |
| [设计概览](./docs/design-overview.md) | 设计原则和系统架构 |
| [Workspace 指南](./docs/workspace/README.md) | Workspace 配置和能力定义 |
| [运行时内部](./docs/runtime/README.md) | 运行时生命周期和 Context Engine |
| [API 参考](./docs/openapi/README.md) | OpenAPI 规范和接口说明 |
| [模板](./templates/README.md) | Workspace 模板使用方法 |
