# Open Agent Harness

Open Agent Harness 是一个基于 TypeScript + Node.js 的 headless Agent Runtime，用来在某个 workspace 内装配 Agent、Model、Action、Skill、MCP、Hook，并通过 OpenAPI + SSE 对外提供对话、任务执行和事件流能力。

它的定位不是聊天产品，也不是带账号体系的一体化平台，而是一个可嵌入、可横向扩展、适合自有环境部署的运行时内核。

## 核心定位

- 纯服务端运行时，无 UI
- workspace-first，打开项目即可发现本地能力，并可直接使用平台内建 agent
- 支持大量并发 session / run，适合多实例分布式部署
- 对 LLM 暴露统一的 tool calling 视图，但在领域层保持 `action`、`skill`、`mcp` 分离
- 通过 REST API 发起请求，通过 SSE 接收流式事件
- 同时支持常规项目 workspace 和只读普通对话 workspace

调试形态上，仓库现在额外包含：

- `apps/web`：React 19 调试控制台，优先用于联调 `workspace / session / message / run / SSE`
- `apps/cli`：CLI / TUI 预留入口，当前先保留最小占位

它们都不改变本项目“headless runtime”的产品定位。

## 负责什么

- 管理 workspace、session、message、run 的生命周期
- 发现并加载 workspace 下的 `.openharness/` 配置
- 统一接入平台级和 workspace 级 agent / model
- 执行 shell、本地脚本、Action、Skill、MCP、Hook
- 提供审计、日志、取消、超时、恢复和事件流

补充：

- 只读普通对话 workspace 可作为“对话模式包”使用
- 这类 workspace 只提供 prompt、agent、model 等静态定义，不提供 shell 或其他执行型工具

## 不负责什么

- 用户、组织、成员关系、登录态管理
- 管理后台、计费、UI 产品层
- 通用代码托管、CI/CD、密钥平台
- 面向公网零信任场景的强隔离沙箱

更合适的边界是：用户系统、认证鉴权、组织关系由外部服务或 API Gateway 管理；Open Agent Harness 只消费调用方身份上下文，并把 `subject_ref` 这类外部引用用于审计、限流和访问判断。这样系统边界更清晰，也更适合独立扩容和分布式部署。

## Workspace 结构

可直接复制的样例见 [templates/README.md](templates/README.md)：

- `templates/workspace`：常规 `project` workspace 模板
- `templates/chat-workspace`：只读 `chat` workspace 模板

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
    mcp/
      settings.yaml
      servers/
        docs-server/
    hooks/
      redact-secrets.yaml
```

其中：

- 服务端可提供一组平台内建 Agent，可直接使用
- `agents/*.md` 定义 workspace 自定义 Agent，文件名即 agent 名；同名时覆盖平台内建 Agent
- `settings.yaml` 定义 workspace 的默认 agent、公共 system prompt 与拼装顺序
- `settings.yaml` 也可追加额外的 skills 搜索目录，例如 `.codex/skills`
- `models/` 定义可直接引用的模型入口
- `actions/*/ACTION.yaml` 定义固定任务入口
- `skills/*/SKILL.md` 定义技能目录
- `mcp/settings.yaml` 定义 MCP server 连接方式
- `hooks/` 定义运行时扩展点，并可放置 hook 使用的脚本、提示词和其他资源目录
- `.openharness/data/history.db` 是该 workspace 的本地历史镜像库，由中心数据库异步同步生成

另外支持一种只读普通对话 workspace：

- 服务端配置文件可通过 `paths.chat_dir` 指定一个目录，其下每个直接子目录都会被发现为一个 `chat` workspace
- `chat` workspace 仍可使用 `AGENTS.md`、`settings.yaml`、`agents/*.md`、`models/*.yaml`
- `chat` workspace 不允许修改目录内容，不允许执行 shell / action / skill / mcp / hook
- `chat` workspace 的会话历史仅保存在中心数据库，不会在该目录下创建 `.openharness/data/history.db`

## 存储角色

- `PostgreSQL`：唯一事实源，保存 session、message、run、tool call、审计记录等核心数据
- `Redis`：保存队列、锁、限流计数和短期事件缓存
- `.openharness/data/history.db`：保存 workspace 历史的本地镜像副本，便于备份、迁移和离线检视

这里的关键边界是：本地 `history.db` 不是主库，不参与在线调度和一致性判断，也不会反向写回中心数据库。这样既能保留分布式部署的灵活性，也能让每个 workspace 自带一份历史副本。

## 文档入口

- [docs/README.md](docs/README.md)
- [docs/architecture-overview.md](docs/architecture-overview.md)
- [docs/workspace-spec.md](docs/workspace-spec.md)
- [docs/workspace/README.md](docs/workspace/README.md)
- [docs/runtime/README.md](docs/runtime/README.md)
- [docs/openapi/README.md](docs/openapi/README.md)

## 开发命令

```bash
pnpm install
pnpm build
pnpm test
pnpm dev:web
```

说明：

- `pnpm build` 会先构建后端 TypeScript 项目，再构建 `apps/web`
- `pnpm dev:web` 默认把 `/api`、`/internal`、`/healthz` 代理到 `http://127.0.0.1:8787`
- 如果后端不在默认端口，可设置环境变量 `OAH_WEB_PROXY_TARGET=http://127.0.0.1:PORT`
