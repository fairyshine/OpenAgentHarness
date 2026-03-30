# Open Agent Harness

Open Agent Harness 是一个基于 TypeScript + Node.js 的 headless Agent Runtime，用来在某个 workspace 内装配 Agent、Model、Action、Skill、MCP、Hook，并通过 OpenAPI + SSE 对外提供对话、任务执行和事件流能力。

它的定位不是聊天产品，也不是带账号体系的一体化平台，而是一个可嵌入、可横向扩展、适合自有环境部署的运行时内核。

## 核心定位

- 纯服务端运行时，无 UI
- workspace-first，打开项目即可发现本地能力，并可直接使用平台内建 agent
- 支持大量并发 session / run，适合多实例分布式部署
- 对 LLM 暴露统一的 tool calling 视图，但在领域层保持 `action`、`skill`、`mcp` 分离
- 通过 REST API 发起请求，通过 SSE 接收流式事件

## 负责什么

- 管理 workspace、session、message、run 的生命周期
- 发现并加载 workspace 下的 `.openharness/` 配置
- 统一接入平台级和 workspace 级 agent / model
- 执行 shell、本地脚本、Action、Skill、MCP、Hook
- 提供审计、日志、取消、超时、恢复和事件流

## 不负责什么

- 用户、组织、成员关系、登录态管理
- 管理后台、计费、UI 产品层
- 通用代码托管、CI/CD、密钥平台
- 面向公网零信任场景的强隔离沙箱

更合适的边界是：用户系统、认证鉴权、组织关系由外部服务或 API Gateway 管理；Open Agent Harness 只消费调用方身份上下文，并把 `subject_ref` 这类外部引用用于审计、限流和访问判断。这样系统边界更清晰，也更适合独立扩容和分布式部署。

## Workspace 结构

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
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

## 文档入口

- [docs/README.md](docs/README.md)
- [docs/architecture-overview.md](docs/architecture-overview.md)
- [docs/workspace-spec.md](docs/workspace-spec.md)
- [docs/workspace/README.md](docs/workspace/README.md)
- [docs/runtime/README.md](docs/runtime/README.md)
- [docs/openapi/README.md](docs/openapi/README.md)
