# Agent Definition

Agent 用于定义一个协作主体的行为、模型和可访问能力。

参考 [OpenCode Agents](https://opencode.ai/docs/zh-cn/agents/) 的设计，agent 采用 Markdown 文件管理：

- 服务端可预置一组平台内建 agent
- workspace 中的 Markdown 文件用于定义 workspace agent
- 文件名表示 workspace agent 名
- YAML frontmatter 承载结构化配置
- Markdown 正文承载主 system prompt
- 额外支持 `system_reminder` 字段，用于 agent 切换后的首轮输入中注入专门的提醒段
- frontmatter 只保留少量高价值字段，避免 agent 重新演化成复杂 DSL
- 额外支持 agent 间切换和 subagent 调用的显式 allowlist
- 若与平台内建 agent 同名，则 workspace agent 覆盖该内建 agent

## 示例

```md
---
mode: primary
description: Implement requested changes in the current workspace
model:
  model_ref: platform/openai-default
  temperature: 0.2
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
    - WebSearch
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

## 关键字段

- `mode`
- `description`
- `model`
- `system_reminder`
- `tools`
- `switch`
- `subagents`
- `policy`
- Markdown 正文

说明：

- workspace agent 名默认取文件名，例如 `builder.md` -> `builder`
- frontmatter 与正文都应支持中文和其他 Unicode 字符
- Markdown 正文即该 agent 的主 system prompt
- `name` 不建议重复出现在 frontmatter 中，文件名就是单一事实来源
- native tool 使用 Title Case 命名，如 `Bash`、`Read`、`TodoWrite`

## frontmatter 字段

推荐结构：

```yaml
mode: primary
description: Implement requested changes in the current workspace
model:
  model_ref: platform/openai-default
  temperature: 0.2
system_reminder: |
  You are now acting as the builder agent.
tools:
  actions:
    - code.review
    - test.run
switch:
  - plan
subagents:
  - repo-explorer
```

字段说明：

- `mode`
  - 可选；`primary`、`subagent`、`all`，默认 `primary`
- `description`
  - agent 的简短说明
- `model`
  - 指定模型入口和推理参数
- `system_reminder`
  - 可选；定义 agent 切换后的提醒段内容
- `tools`
  - 可选；声明该 agent 可见的 native tools、actions、skills、external tools
- `switch`
  - 可选；声明该 agent 在当前 run 内允许切换到的其他 agent 名称列表
- `subagents`
  - 可选；声明该 agent 允许调用的 subagent 名称列表
- `policy`
  - 可选；声明步数、超时、并发等运行限制

当前建议只保留以上字段。

关于 `mode` 的约定：

- `primary`
  - 可作为 session 的当前主 agent，也可作为 `switch` 的目标
- `subagent`
  - 主要作为 `subagents` 调用目标，不建议直接作为 `switch` 目标
- `all`
  - 同时可作为主 agent 和 subagent 使用，但应谨慎使用

以下内容不建议放进 agent frontmatter：

- `name`
  - 会与文件名重复
- `context`
  - 当前由运行时按固定规则装配
- `hooks`
  - 属于运行时扩展，不属于 agent 角色定义

## 正文 prompt 规则

- Markdown 正文是该 agent 的主 system prompt
- 运行时会保留正文文本内容，不要求解析特定标题结构
- 可以使用多段文本、标题、列表等 Markdown 组织 prompt
- 若正文为空，则视为 agent 定义不完整
