# Open Agent Harness

<div class="hero" markdown>
### 无头 Agent 运行时内核

用 Markdown 定义 Agent 逻辑，按场景切换，多 Workspace 并行执行。你做产品界面，它做后端运行时。

[快速开始](./getting-started.md){ .md-button .md-button--primary }
[架构总览](./architecture-overview.md){ .md-button }

</div>

## 它是什么

Open Agent Harness 是一个可部署的 Agent 后端运行时。它管理 Workspace 的生命周期、Agent 执行循环、工具调用和状态持久化。它不提供产品界面——你接自己的前端，它负责把 Agent 跑起来。

## 核心能力

- **多 Workspace 并行** — PostgreSQL 持久化 + Redis 队列调度，支撑大量 Workspace 同时运行
- **声明式 Agent 配置** — 用 YAML frontmatter 的 Markdown 文件定义 Agent，热加载生效
- **能力自由组合** — agent / skill / action / tool / hook / context 按 Workspace 独立配置
- **统一 Workspace 结构** — 同一套目录结构承载对话、工具调用和执行能力
- **REST + SSE API** — 全部能力通过 `/api/v1` 暴露，前端无关
- **灵活部署** — 本地一体运行或 API + Worker 拆分部署

## 快速开始

```bash
pnpm install                                        # 安装依赖
export OAH_TEST_ROOT=/absolute/path/to/test_oah_server
pnpm local:up                                       # 启动 PostgreSQL + Redis + MinIO + OAH，并自动同步一次
pnpm dev:web                                        # 启动调试控制台
```

启动后访问：

- :material-monitor-dashboard: **调试控制台** — [http://localhost:5174](http://localhost:5174)
- :material-api: **后端 API** — [http://localhost:8787](http://localhost:8787)

[:octicons-arrow-right-24: 完整指南](./getting-started.md){ .md-button .md-button--primary }

## 从这里开始

<div class="grid cards" markdown>

-   :material-rocket-launch:{ .lg .middle } **快速开始**

    ---

    安装、启动、验证，5 分钟跑起来

    [:octicons-arrow-right-24: 开始](./getting-started.md)

-   :material-layers-outline:{ .lg .middle } **架构总览**

    ---

    分层设计、核心模块、请求链路

    [:octicons-arrow-right-24: 查看](./architecture-overview.md)

-   :material-folder-cog-outline:{ .lg .middle } **Workspace 配置**

    ---

    Agent、Model、Skill、Action、Hook 定义

    [:octicons-arrow-right-24: 配置](./workspace/README.md)

-   :material-server-outline:{ .lg .middle } **部署与运行**

    ---

    本地开发、分离部署、单 Workspace 模式

    [:octicons-arrow-right-24: 部署](./deploy.md)

</div>
