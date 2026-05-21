# Runtime 配置文件详解

Runtime 目录里的配置文件最终都会进入 workspace。下面按加载顺序和职责拆开说明。

## 总览

| 文件或目录 | 必填 | 作用 |
| --- | --- | --- |
| `AGENTS.md` | 否 | 初始化到 workspace 根目录的项目说明或团队约定 |
| `.openharness/settings.yaml` | 建议 | 默认 agent、模型别名、engine 开关、导入项 |
| `.openharness/prompts.yaml` | 否 | workspace 级 system prompt 片段与拼装顺序 |
| `.openharness/agents/*.md` | 是 | agent 行为定义 |
| `.openharness/models/*.yaml` | 否 | workspace 级模型入口 |
| `.openharness/actions/*/ACTION.yaml` | 否 | 可被 LLM、用户或 API 调用的固定任务入口 |
| `.openharness/skills/*/SKILL.md` | 否 | workspace 本地 skills |
| `.openharness/tools/settings.yaml` | 否 | MCP tool server 注册表 |
| `.openharness/hooks/*.yaml` | 否 | 运行时 hook |

## `AGENTS.md`

`AGENTS.md` 是给 agent 看的项目说明，不是结构化配置。Runtime 里的 `AGENTS.md` 会被复制到 workspace 根目录；如果创建 workspace 时 API 也传了 `agentsMd`，OAH 会把后者追加到现有 `AGENTS.md` 后面。

适合写：

- 团队编码规范
- 项目目录约定
- 常用构建、测试、部署命令
- 安全、数据、审查注意事项

不适合写：

- agent 权限
- tool allowlist
- hook 逻辑
- 密钥

## `.openharness/settings.yaml`

`settings.yaml` 是 runtime 的主入口。

```yaml
default_agent: build

models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    max_tokens: 4096
  planner:
    ref: platform/openai-default
    temperature: 0.1

imports:
  tools:
    - docs-server
  skills:
    - repo-reader

engine:
  compact:
    enabled: true
  session_memory:
    enabled: false
  workspace_memory:
    enabled: true
    write_policy: confirm-suggested
```

### `default_agent`

默认主 agent。它必须能在当前 workspace catalog 中解析到，并且不应该是纯 `mode: subagent`。

### `models`

模型别名表。Agent 推荐写：

```yaml
model: default
```

而不是直接到处写：

```yaml
model: platform/openai-default
```

这样切换模型、温度和 token 上限时，只需要改 `settings.yaml`。

`models.<alias>` 可以是字符串：

```yaml
models:
  default: platform/openai-default
```

也可以是对象：

```yaml
models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    top_p: 0.9
    max_tokens: 4096
```

`ref` 必须是 `platform/<name>` 或 `workspace/<name>`。

### `imports`

`imports` 只在 runtime 初始化 workspace 时生效。

```yaml
imports:
  tools:
    - docs-server
  skills:
    - repo-reader
```

- `tools` 从服务端 `paths.tool_dir` 导入到 `.openharness/tools/`
- `skills` 从服务端 `paths.skill_dir` 导入到 `.openharness/skills/`
- 导入后 workspace 持有自己的副本，后续运行不再直接读取平台目录
- 引用不存在的 tool 或 skill 时，workspace 初始化失败

### `engine`

```yaml
engine:
  compact:
    enabled: true
  session_memory:
    enabled: false
  workspace_memory:
    enabled: true
    write_policy: confirm-suggested
```

| 字段 | 说明 |
| --- | --- |
| `compact.enabled` | 是否启用自动上下文 compact。默认开启 |
| `session_memory.enabled` | 是否启用 session 级记忆 |
| `workspace_memory.enabled` | 是否启用 `.openharness/memory/` 持久记忆 |
| `workspace_memory.write_policy` | 写入策略：`explicit-only`、`confirm-suggested`、`auto-extract` |

## `.openharness/prompts.yaml`

`prompts.yaml` 负责 workspace 级静态 prompt 组合。

```yaml
base:
  inline: |-
    You are running inside the team coding runtime.
    Prefer small, verified code changes.

llm_optimized:
  providers:
    openai:
      inline: |-
        Keep tool arguments concise and avoid long speculative prose.
  models:
    planner:
      inline: |-
        Produce decision-complete plans before implementation.

compose:
  order:
    - base
    - llm_optimized
    - agent
    - agent_switches
    - subagents
    - project_agents_md
    - skills
    - actions
    - environment
  include_environment: true
```

### Prompt source

`base` 和 `llm_optimized` 的值支持 `inline` 或 `file` 二选一：

```yaml
base:
  file: ./.openharness/prompts/base.md
```

`file` 路径相对 workspace 根目录解析。

### `llm_optimized`

用于给不同 provider 或模型别名追加提示词。

优先级：

1. `llm_optimized.models.<alias>`
2. `llm_optimized.providers.<provider>`

### `compose.order`

可用段名：

- `base`
- `llm_optimized`
- `agent`
- `actions`
- `project_agents_md`
- `skills`
- `agent_switches`
- `subagents`
- `environment`

`system_reminder` 不在这里配置，它是 agent 切换时动态注入的提醒。

## `.openharness/agents/*.md`

Agent 文件使用 Markdown + YAML frontmatter。文件名就是 agent 名。

```md
---
mode: primary
description: Build and verify scoped code changes
model: default
system_reminder: |
  You are now acting as build.
tools:
  native:
    - Bash
    - Read
    - Edit
    - Grep
    - TodoWrite
  actions:
    - test.run
  skills:
    - repo-reader
  external:
    - docs-server
switch:
  - plan
subagents:
  - explore
policy:
  max_steps: 40
  run_timeout_seconds: 1800
  tool_timeout_seconds: 180
  parallel_tool_calls: true
  max_concurrent_subagents: 3
---

# Build

You are the default implementation agent.
```

### 常用 frontmatter 字段

| 字段 | 说明 |
| --- | --- |
| `mode` | `primary`、`subagent`、`all`，默认 `primary` |
| `description` | catalog 中展示的简短说明 |
| `model` | 模型别名或直接 `model_ref` |
| `system_reminder` | 切换到该 agent 时追加的提醒 |
| `tools.native` | 内建工具 allowlist |
| `tools.actions` | 可调用 actions |
| `tools.skills` | 可用 skills |
| `tools.external` | 可用 MCP servers |
| `switch` | 可切换到的 primary agents |
| `subagents` | 可委派的 subagents |
| `policy` | 步数、超时、并发限制 |

`native` 工具必须显式声明才会暴露。`actions`、`skills`、`external` 未声明时会使用 workspace 可见的默认能力集；如果写成空数组，则表示显式关闭。

## `.openharness/models/*.yaml`

模型入口可以放在服务端 `paths.model_dir`，也可以放进 runtime 的 `.openharness/models/`。

```yaml
openrouter-main:
  provider: openai-compatible
  key: ${env.OPENROUTER_API_KEY}
  url: https://openrouter.ai/api/v1
  name: openai/gpt-5
```

在 `settings.yaml` 中引用：

```yaml
models:
  default:
    ref: workspace/openrouter-main
```

如果 runtime 是团队共享模板，通常推荐把密钥留在环境变量或服务端平台模型中，不要把明文 key 写进 runtime。

## `.openharness/actions/*/ACTION.yaml`

Action 是固定任务入口，适合把“测试、构建、检查、发布预检”这类可重复命令标准化。

```yaml
name: test.run
description: Run project tests

expose:
  to_llm: true
  callable_by_user: true
  callable_by_api: true

recovery:
  retry_policy: manual

input_schema:
  type: object
  properties:
    watch:
      type: boolean
  additionalProperties: false

entry:
  command: npm test
  timeout_seconds: 300
```

Action 不提供 workflow DSL。复杂逻辑应放进脚本，再由 `entry.command` 调用。

## `.openharness/tools/settings.yaml`

MCP tool server 注册表。

```yaml
docs-server:
  command: node ./servers/docs-server/index.js
  enabled: true
  environment:
    DOCS_TOKEN: ${env.DOCS_TOKEN}
  timeout: 30000
  expose:
    tool_prefix: mcp.docs
    include:
      - search
      - fetch

remote-browser:
  url: https://example.com/mcp
  headers:
    Authorization: Bearer ${env.BROWSER_TOKEN}
  enabled: true
```

每个 server 必须声明 `command` 或 `url`，不能同时声明。

## `.openharness/skills/*/SKILL.md`

Skill 是一组面向 agent 的局部说明和资源。最小结构：

```text
.openharness/skills/
  repo-reader/
    SKILL.md
```

适合把某类任务的固定工作流、局部术语、脚本位置、模板资源封装起来。Agent 通过 `tools.skills` 控制可见范围。

## `.openharness/hooks/*.yaml`

Hook 用于运行时拦截和扩展，不直接暴露给 LLM。

```yaml
name: redact-secrets
events:
  - before_model_call
matcher: "platform/openai-default"

handler:
  type: command
  command: node ./.openharness/hooks/scripts/redact-secrets.js

capabilities:
  - rewrite_model_request
```

常见用途：

- 模型调用前脱敏
- tool 调用前策略检查
- run 完成后写审计日志
- compact 前后提取指标

## 加载与校验

加载阶段会做这些检查：

- `settings.yaml`、`prompts.yaml`、`ACTION.yaml`、hook、MCP settings 必须符合 schema
- 默认 agent 必须能解析
- agent 引用的模型别名、switch 目标、subagent 目标需要存在
- runtime `imports` 引用的公共 tool/skill 必须存在
- 已有 workspace 应用 runtime 时，不覆盖既有 `.openharness/`

排查问题时优先看：

1. `GET /api/v1/workspaces/{workspaceId}/catalog`
2. `GET /api/v1/sessions/{sessionId}/events`
3. 服务端启动日志中的 schema validation 错误

## 示例 Runtime

仓库模板里自带两个 runtime：

- `template/deploy-root/runtimes/vibe-coding`
- `template/deploy-root/runtimes/micro-learning`

它们分别展示了 coding workflow 和教学 workflow 的 agent 拆分、prompt 组合与 policy 配置方式。
