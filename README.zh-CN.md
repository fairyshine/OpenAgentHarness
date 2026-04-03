# Open Agent Harness

中文 | [English](./README.md)

Open Agent Harness 是一个 headless、workspace-first 的 Agent Runtime，面向正在构建 Agent 产品、企业内部 AI 平台和嵌入式 Copilot 的团队。

它主要解决的是 Agent 产品里最容易迅速变复杂的那部分后端问题：如何同时服务很多 workspace、session 和 run，同时又保留足够高的灵活度、治理能力和可嵌入性。

## 一句话理解

你做自己的 Agent 产品，我们提供可复用的 runtime。

## 快速认识它

| 问题 | 回答 |
| --- | --- |
| 它是什么？ | 一个可部署的 Agent 后端运行时，用来承载对话和任务执行。 |
| 适合谁？ | 正在做内部 AI 平台、面向团队的 Agent 产品，或嵌入式 Copilot 的团队。 |
| 核心思路是什么？ | 让每个 workspace 自带自己的 agents、prompts、skills、actions、hooks 和 tools，同时共用同一套 runtime 内核。 |
| 它不是什么？ | 不是开箱即用的聊天产品，也不是身份系统或 SaaS 控制平面。 |

## 为什么是 Open Agent Harness

- Headless、可嵌入，适合放在你自己的 Web、桌面端、CLI、自动化系统或 API Gateway 后面
- 以 workspace 为核心定制边界，而不是一套固定的全局 agent 配置
- 同时支持可执行的 `project` workspace 和只读的 `chat` workspace
- 把 `agent`、`skill`、`action`、`tool`、`hook`、context 这些能力层分开设计
- 同一套 runtime 既能服务单 workspace，也能服务多 workspace 平台场景

## 这个项目最有特色的地方

| 维度 | Open Agent Harness 更强调 |
| --- | --- |
| 产品边界 | 可嵌入你自己产品的后端 runtime 内核 |
| 定制方式 | 以 workspace 为单位做能力组合，而不是固定流程 |
| 能力设计 | 角色、方法、任务、工具、hook、context 分层清晰 |
| 平台集成 | 更适合集成进现有身份、权限和产品体系 |
| 部署路径 | 本地易启动，生产也容易拆分部署 |

## 高自由度的能力模型

Open Agent Harness 的优势不只是“支持很多概念”，而是这些概念彼此分层明确，所以你可以按 workspace 灵活组合。

| 能力 | 作用 |
| --- | --- |
| `agent` | 定义角色、行为方式和权限边界 |
| `primary agent` / `subagent` | 同时支持主角色协作和受控 delegation |
| `tool` | 给 agent 暴露内建能力或外部工具能力 |
| `skill` | 封装一类任务的方法和经验 |
| `action` | 暴露稳定、可复用、可触发的命名任务 |
| `hook` | 在运行时关键事件上增加治理、检查或扩展逻辑 |
| `context` | 控制 prompt 和 workspace 指令如何组合进模型上下文 |

这会带来很强的定制自由度：

- 不同 workspace 可以拥有完全不同的 agent 组合和 prompt 策略。
- 不同 agent 可以看到不同的 tools、actions、skills 和 subagents。
- skill 适合沉淀方法，action 适合承载稳定任务，hook 适合放治理和扩展逻辑。
- context 也可以按 workspace 编排，而不是被写死在应用代码里。

## 以 Workspace 为定制边界

workspace 是 Open Agent Harness 最重要的定制边界。一套 runtime 可以同时承载很多 workspace，而每个 workspace 都可以带上自己的：

- agents
- prompts 和公共指令
- skills
- actions
- hooks
- models
- tool servers

这意味着两个 workspace 即使跑在同一个 runtime 上，也可以为不同团队、仓库或产品场景表现出完全不同的行为。

## 什么时候特别适合用它

Open Agent Harness 很适合这些场景：

- 你在做企业内部 AI 平台，或面向团队的 Agent 产品
- 你需要一个后端同时服务很多 workspace
- 你希望保留自己的前端、认证体系和产品体验
- 你需要比固定 Agent UI 或本地 agent loop 更强的控制力

它不太适合这些场景：

- 你只想要一个开箱即用的聊天界面
- 你只需要一个很小的单用户本地脚本
- 你暂时不需要 workspace 隔离和运行时生命周期管理

## 典型使用场景

| 场景 | 为什么适合 |
| --- | --- |
| 企业内部研发 Copilot | 不同仓库或团队可以共享 runtime，但拥有不同 agent 配置 |
| 面向团队的 Agent 产品 | 你保留自己的产品体验和治理逻辑，runtime 复用出来 |
| 现有产品中的嵌入式 Copilot | Runtime 保持 headless，适合放在现有产品后面 |
| 围绕单个 repo 或聊天预置的专属后端 | `single workspace` 模式可以直接聚焦部署 |

## 快速开始

```bash
pnpm install
pnpm infra:up
pnpm dev:server -- --config ./server.example.yaml
pnpm dev:web
```

常用本地地址：

- 调试 Web 控制台：`http://localhost:5174`
- 默认后端地址：`http://127.0.0.1:8787`

常用命令：

```bash
pnpm build
pnpm test
pnpm dev:worker -- --config ./server.example.yaml
```

如果你想围绕单个 workspace 启动专属后端：

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

## 文档入口

- [docs/README.md](./docs/README.md)
- [docs/getting-started.md](./docs/getting-started.md)
- [docs/deploy.md](./docs/deploy.md)
- [docs/architecture-overview.md](./docs/architecture-overview.md)
- [docs/workspace/README.md](./docs/workspace/README.md)
- [templates/README.md](./templates/README.md)
