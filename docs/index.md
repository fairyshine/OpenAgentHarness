# Open Agent Harness

<div class="hero" markdown>
### 无头 Agent Engine

用 Markdown 定义 Agent Runtime，按场景切换，多 Workspace 并行执行。你做产品界面，它做后端 Engine。

[快速开始](./getting-started.md){ .md-button .md-button--primary }
[架构总览](./architecture-overview.md){ .md-button }

</div>

## 它是什么

Open Agent Harness 是一个可部署的 Agent Engine。它运行 Agent Runtime，并通过 Agent Spec 扩展运行行为。它管理 workspace 生命周期、agent 执行循环、工具调用和状态持久化，但不提供产品界面。

客户端形态收敛为 WebUI、TUI 和 Desktop。当前仓库自带 WebUI 与 TUI：WebUI 适合在浏览器内查看会话、运行状态、trace 与存储状态，TUI 则适合在 shell 里直接选择 workspace、进入 session、观察流式输出；Desktop 后续也应连接同一套 OAH-compatible API。

## 核心能力

- **多 Workspace 并行** — PostgreSQL 持久化 + Redis 队列调度，支撑大量 Workspace 同时运行
- **声明式 Runtime 组织** — 用 Markdown 和 YAML 组织 agent/runtime 能力，热加载生效
- **能力自由组合** — agent / skill / action / tool / hook / context 按 Workspace 独立配置
- **统一 Workspace 结构** — 同一套目录结构承载对话、工具调用和执行能力
- **REST + SSE API** — 全部能力通过 `/api/v1` 暴露，前端无关
- **TUI** — 通过同一套 API / SSE 在终端内操作 workspace 与 session
- **灵活部署** — 最小化时可用 `oah-api` 内嵌 worker，拆分时使用 `oah-api + oah-controller + oah-sandbox`

## 快速开始

```bash
pnpm install                                        # 安装依赖
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
pnpm local:up                                       # 启动 PostgreSQL + Redis + MinIO + oah-api + oah-controller + oah-sandbox，并自动同步一次
pnpm dev:web                                        # 启动 WebUI
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui # 启动终端 TUI
```

启动后访问：

- :material-monitor-dashboard: **WebUI** — [http://localhost:5174](http://localhost:5174)
- :material-console: **终端 TUI** — `pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui`
- :material-api: **oah-api** — [http://localhost:8787](http://localhost:8787)

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

-   :material-tag-outline:{ .lg .middle } **术语约定**

    ---

    Engine、Runtime、Spec 的统一边界

    [:octicons-arrow-right-24: 查看](./terminology.md)

-   :material-folder-cog-outline:{ .lg .middle } **Workspace 配置**

    ---

    Agent、Model、Skill、Action、Hook 定义

    [:octicons-arrow-right-24: 配置](./workspace/README.md)

-   :material-server-outline:{ .lg .middle } **部署与运行**

    ---

    本地开发、分离部署、单 Workspace 模式

    [:octicons-arrow-right-24: 部署](./deploy.md)

-   :material-console:{ .lg .middle } **TUI**

    ---

    在终端内操作 workspace、session、catalog 和流式输出

    [:octicons-arrow-right-24: 查看](./tui.md)

-   :material-shield-check-outline:{ .lg .middle } **K8S 上线清单**

    ---

    staging 验证、production readiness、release gate

    [:octicons-arrow-right-24: 检查](./k8s-rollout-checklist.md)

-   :material-stethoscope:{ .lg .middle } **K8S 运维 Runbook**

    ---

    leader、rollout、drain、strict egress 等故障排查

    [:octicons-arrow-right-24: 排障](./k8s-operations-runbook.md)

</div>
