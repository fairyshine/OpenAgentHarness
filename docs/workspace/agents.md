# Agents

## AGENTS.md 角色

`AGENTS.md` 不是结构化执行配置，而是给 Agent 看的项目说明文档。

若在 prompt 组装中启用 `project_agents_md`，运行时应始终注入根目录 `AGENTS.md` 的原文全文，不做摘要、裁剪或额外预处理。

建议承载：

- 项目目标
- 目录结构说明
- 编码规范
- 构建和测试命令
- 常见注意事项
- 推荐工作流程

不建议承载：

- 严格依赖其解析的结构化 DSL
- 复杂权限配置
- 可执行流程定义

## Agent Markdown 规范

Agent 用于定义一个协作主体的行为、模型和可访问能力。

参考 [OpenCode Agents](https://opencode.ai/docs/zh-cn/agents/) 的设计，agent 采用 Markdown 文件管理：

- 服务端可预置一组平台内建 agent
- workspace 中的 Markdown 文件用于定义 workspace agent
- 文件名表示 workspace agent 名
- YAML frontmatter 承载结构化配置
- Markdown 正文承载主 system prompt
- 额外支持 `system_reminder` 字段，用于 agent 激活或切换时注入专门的提醒段
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
    - shell.exec
    - file.read
    - file.write
    - file.list
  actions:
    - code.review
    - test.run
  skills:
    - repo.explorer
    - docs.reader
  mcp:
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
  - 可选；定义 agent 激活或切换时的提醒段内容
- `tools`
  - 可选；声明该 agent 可见的 native tools、actions、skills、mcp
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

## `model` 字段

建议结构：

```yaml
model:
  model_ref: platform/openai-default
  temperature: 0.2
```

字段说明：

- `model_ref`
  - 指向一个具体模型入口的 canonical ref
- `temperature`
- `max_tokens`

`model` 是 frontmatter 中唯一建议必填的结构化字段。

## `tools` 字段

建议结构：

```yaml
tools:
  native:
    - shell.exec
    - file.read
  actions:
    - code.review
  skills:
    - repo.explorer
  mcp:
    - docs-server
```

字段说明：

- `native`
  - 允许该 agent 使用的内建工具
- `actions`
  - 允许该 agent 调用的 action 名称列表
- `skills`
  - 允许该 agent 调用的 skill 名称列表
- `mcp`
  - 允许该 agent 使用的 MCP server 名称列表

规则：

- `tools` 整体可选
- 未声明的子字段按空列表处理
- 保持 `native`、`actions`、`skills`、`mcp` 分开，不合并成统一 registry 名称
- `tools` 只表达 allowlist，不承载执行逻辑

## `switch` 字段

建议结构：

```yaml
switch:
  - plan
  - build
```

字段说明：

- 列表中的每一项都是可切换的目标 agent 名
- 目标 agent 通常应为 `mode: primary` 或 `mode: all`

规则：

- `switch` 整体可选
- 未声明时默认不允许 agent 主动切换
- 仅表达 allowlist，不表达切换条件
- 运行时在执行 `agent.switch` 前，必须校验目标 agent 是否在该列表中

## `subagents` 字段

建议结构：

```yaml
subagents:
  - repo-explorer
  - code-reviewer
```

字段说明：

- 列表中的每一项都是该 agent 允许调用的 subagent 名
- 目标 agent 通常应为 `mode: subagent` 或 `mode: all`

规则：

- `subagents` 整体可选
- 未声明时默认不允许 agent 主动调用 subagent
- 运行时在执行 `agent.delegate` 或等价 task tool 前，必须校验目标 agent 是否在该列表中
- `subagents` 表达的是 delegation allowlist，不影响用户手动选择 agent

## `policy` 字段

建议结构：

```yaml
policy:
  max_steps: 40
  run_timeout_seconds: 1800
  tool_timeout_seconds: 120
```

建议先只保留少量限制型字段：

- `max_steps`
- `run_timeout_seconds`
- `tool_timeout_seconds`
- `parallel_tool_calls`
- `max_concurrent_subagents`

其中：

- `max_concurrent_subagents`
  - 可选；限制当前 run 同时活跃的 subagent 数量
  - 未声明时默认无上限
  - 只统计 `queued` 或 `running` 的 child runs

不建议在 `policy` 中加入复杂路由、重试、流程控制或条件表达式。

## 正文 prompt 规则

- Markdown 正文是该 agent 的主 system prompt
- 运行时会保留正文文本内容，不要求解析特定标题结构
- 可以使用多段文本、标题、列表等 Markdown 组织 prompt
- 若正文为空，则视为 agent 定义不完整

## `system_reminder` 规则

`system_reminder` 用于对齐 OpenCode 切换 agent 时的提醒语义。

运行时在以下场景注入该段：

- 创建 session 时显式选择了某个 agent
- 同一 session 内从 agent A 切换到 agent B

注入形式建议为：

```text
<system_reminder>
{标准切换提示 + agent.system_reminder}
</system_reminder>
```

规则：

- `system_reminder` 是可选字段
- 运行时负责包裹 `<system_reminder>` 标签
- 该段默认只在 agent 激活或切换时注入，不在每轮对话重复注入
- 适合放角色切换提醒、边界说明、交接要求、工具偏好等内容
- 不建议把完整主 prompt 重复写入 `system_reminder`
