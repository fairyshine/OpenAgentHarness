# Agents

Workspace 中有两种 agent 相关文件，面向不同角色：

| 文件 | 面向谁 | 作用 |
| --- | --- | --- |
| `AGENTS.md`（workspace 根目录） | **用户** | 项目说明文档，告诉 agent 这个项目是做什么的、怎么用 |
| `.openharness/agents/*.md` | **开发者** | Agent 行为定义，配置角色、模型、工具权限、切换规则 |

---

## AGENTS.md — 用户编写的项目说明

`AGENTS.md` 放在 workspace 根目录，是一份给 agent 看的**项目上下文文档**。它不控制 agent 行为，只提供背景信息。

运行时会将 `AGENTS.md` 全文注入 system prompt（不做摘要或裁剪），让 agent 理解当前项目的情况。

**应该写什么：**

- 项目目标和背景
- 目录结构说明
- 编码规范和约定
- 构建、测试、部署命令
- 常见注意事项

**不应该写什么：**

- 结构化的配置 DSL
- 权限规则
- 可执行的流程定义

!!! tip

    把 `AGENTS.md` 当成"给新同事的项目介绍文档"来写，而不是配置文件。

---

## `.openharness/agents/*.md` — 开发者定义的 Agent 行为

Agent 定义存放在 `.openharness/agents/*.md`，使用 Markdown + YAML frontmatter。这些文件由**开发者**编写，控制 agent 的具体行为：

- 文件名即 agent 名（如 `builder.md` -> agent 名 `builder`）
- YAML frontmatter 承载结构化配置
- Markdown 正文即主 system prompt
- 若与平台内建 agent 同名，workspace agent 覆盖

### 基础示例

```md
---
mode: primary
description: Implement requested changes in the current workspace
model: default
system_reminder: |
  You are now acting as the builder agent.
  Focus on making concrete code changes in the current workspace.
tools:
  native:
    - Bash
    - Read
    - Write
    - Edit
    - Glob
    - Grep
    - WebFetch
    - TodoWrite
  actions:
    - code.review
    - test.run
  skills:
    - repo.explorer
    - docs.reader
  external:
    - docs-server
switch:
  - plan
subagents:
  - repo-explorer
  - code-reviewer
policy:
  max_steps: 40
  run_timeout_seconds: 1800
  tool_timeout_seconds: 120
---

# Builder

You are a pragmatic software engineering agent.
Prefer making concrete progress in the current workspace.
```

### Frontmatter 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `mode` | 否 | `primary`、`subagent`、`all`，默认 `primary` |
| `description` | 否 | Agent 简短说明 |
| `model` | 建议 | 模型别名或直接模型引用 |
| `system_reminder` | 否 | Agent 切换后的提醒段 |
| `tools` | 否 | 可见的 native tools、actions、skills、external tools |
| `switch` | 否 | 允许切换到的其他 agent 列表 |
| `subagents` | 否 | 允许调用的 subagent 列表 |
| `policy` | 否 | 步数、超时、并发限制 |

**`mode` 语义：**

| 值 | 说明 |
| --- | --- |
| `primary` | 可作为 session 主 agent 或 `switch` 目标 |
| `subagent` | 主要作为 delegation 目标，不建议直接 switch |
| `all` | 同时可作为主 agent 和 subagent，谨慎使用 |

不放进 frontmatter 的字段：`name`（与文件名重复）、`context`（运行时装配）、`hooks`（运行时扩展）。

### 正文规则

- Markdown 正文是主 system prompt，运行时原样保留
- 正文为空视为定义不完整
- 支持中文和其他 Unicode 字符
- Native tool 使用 Title Case：`Bash`、`Read`、`TodoWrite`

## 控制字段详解

### `model`

```yaml
model: default
```

| 字段 | 说明 |
| --- | --- |
| `model` | 指向 `settings.yaml -> models` 中声明的模型别名；也兼容直接写具体 `model_ref` |

运行时会在加载阶段把 `model` 解析成具体 `model_ref`。温度、`top_p`、`max_tokens` 等模型参数推荐统一配置在 `settings.yaml -> models.<alias>` 下。旧写法 `model: { alias: ... }`、`model_ref` 以及 frontmatter 中的遗留模型参数仍可兼容读取。

`model` 是 frontmatter 中唯一建议必填的结构化字段。

### `tools`

```yaml
tools:
  native:
    - Bash
    - Read
  actions:
    - code.review
  skills:
    - repo.explorer
  external:
    - docs-server
```

| 子字段 | 说明 |
| --- | --- |
| `native` | 内建工具 |
| `actions` | Workspace actions |
| `skills` | Workspace skills |
| `external` | MCP tool servers |

- `native` 必须显式声明才启用；未声明时不暴露任何内建工具
- `external`、`actions`、`skills` 未声明时继承当前 workspace 已发现的默认能力集
- 显式空数组表示关闭该类能力，例如 `external: []` 不会回退到默认 MCP servers
- 仅表达 allowlist，不承载执行逻辑
- 所有 workspace 统一按声明内容解析

### `switch`

```yaml
switch:
  - plan
  - build
```

- 每项为可切换的目标 agent 名，目标应为 `mode: primary` 或 `mode: all`
- 未声明时不允许主动切换
- 仅表达 allowlist，运行时在执行 `agent.switch` 前校验

### `subagents`

```yaml
subagents:
  - repo-explorer
  - code-reviewer
```

- 每项为可 delegate 的 subagent 名，目标应为 `mode: subagent` 或 `mode: all`
- 未声明时不允许 delegate
- 运行时在执行 `agent.delegate` 前校验
- 是否可用由 workspace 当前声明与运行时配置共同决定

### `policy`

```yaml
policy:
  max_steps: 40
  run_timeout_seconds: 1800
  tool_timeout_seconds: 120
  parallel_tool_calls: true
  max_concurrent_subagents: 3
```

| 字段 | 说明 |
| --- | --- |
| `max_steps` | 最大推理步数 |
| `run_timeout_seconds` | Run 总超时 |
| `tool_timeout_seconds` | 单次 tool 执行超时 |
| `parallel_tool_calls` | 是否允许并行 tool call |
| `max_concurrent_subagents` | 最大并发 subagent 数 |

不在 `policy` 中加入复杂路由、重试或条件表达式。

### `system_reminder`

Agent 切换时注入的提醒段。

**注入时机：**

- 同一 run 内通过 `AgentSwitch` 切换
- 用户手动更新 `activeAgentName` 后的首条消息

**注入形式：**

```text
<system_reminder>
{标准切换提示 + agent.system_reminder}
</system_reminder>
```

| 规则 | 说明 |
| --- | --- |
| 位置 | 最新 user message，不是 system prompt |
| 频次 | 切换后首轮注入一次，不重复 |
| 创建 session 时 | 不注入 |
| 内容建议 | 角色切换提醒、边界说明、工具偏好 |

## 完整示例：三 Agent 协作

### `.openharness/agents/plan.md`

```md
---
mode: primary
description: Analyze tasks and create implementation plans
model: default
tools:
  native:
    - Read
    - Glob
    - Grep
switch:
  - build
---

# Planner

You are a planning agent. Analyze the user's request, explore the codebase,
and produce a clear implementation plan. When the plan is ready, switch to
the builder agent with a summary of what needs to be done.
```

### `.openharness/agents/build.md`

```md
---
mode: primary
description: Implement changes in the workspace
model: default
system_reminder: |
  You are now the builder. Follow the plan from the planner.
tools:
  native:
    - Bash
    - Read
    - Write
    - Edit
    - Glob
    - Grep
switch:
  - plan
subagents:
  - reviewer
policy:
  max_steps: 40
  tool_timeout_seconds: 120
---

# Builder

You are a pragmatic software engineering agent. Make concrete code changes
based on the plan. When implementation is complete, delegate to the reviewer
for a code review.
```

### `.openharness/agents/reviewer.md`

```md
---
mode: subagent
description: Review code changes for quality and correctness
model: default
tools:
  native:
    - Read
    - Glob
    - Grep
---

# Reviewer

You are a code review agent. Read the recent changes, check for bugs,
style issues, and missing edge cases. Return a structured review with
findings and suggestions.
```

### 协作流程

1. 用户发消息，session 默认使用 `plan` agent
2. Planner 分析需求、探索代码、产出计划
3. Planner 通过 `agent.switch` 切换到 `build`
4. Builder 按计划实现代码变更
5. Builder 通过 `agent.delegate` 调用 `reviewer`
6. Reviewer 在子 session 中审查代码，返回结果
7. Builder 收到审查结果，必要时修复后完成 run
