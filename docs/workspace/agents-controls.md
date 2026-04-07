# Agent Fields And Control

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
    - Bash
    - Read
  actions:
    - code.review
  skills:
    - repo.explorer
  external:
    - docs-server
```

字段说明：

- `native`
  - 允许该 agent 使用的内建工具
- `actions`
  - 允许该 agent 调用的 action 名称列表
- `skills`
  - 允许该 agent 调用的 skill 名称列表
- `external`
  - 允许该 agent 使用的外部 tool server 名称列表

规则：

- `tools` 整体可选
- 未声明的子字段按空列表处理
- 保持 `native`、`actions`、`skills`、`external` 分开，不合并成统一 registry 名称
- `tools` 只表达 allowlist，不承载执行逻辑
- `kind=chat` workspace 中，即使声明了 `tools`，运行时也必须按空集合处理

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
- 若 `kind=chat` workspace 禁用了所有控制型 tool，则 agent 不能在 run 中主动切换

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
- `kind=chat` workspace 中默认禁用 subagent delegation

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

## `system_reminder` 规则

`system_reminder` 用于对齐 OpenCode 切换 agent 时的提醒语义。

运行时在以下场景注入该段：

- 同一 run 内通过 `AgentSwitch` 从 agent A 切换到 agent B
- 用户手动更新 session 的 `activeAgentName` 后，下一条 user message 首次进入新 agent

注入形式建议为：

```text
<system_reminder>
{标准切换提示 + agent.system_reminder}
</system_reminder>
```

规则：

- `system_reminder` 是可选字段
- 运行时负责包裹 `<system_reminder>` 标签
- 注入位置是发送给模型的最新一条 user message，而不是 system prompt
- 创建 session 时即使显式选择了 agent，默认也不注入该段
- 该段默认只在切换后的首轮注入一次，不在每轮对话重复注入
- 适合放角色切换提醒、边界说明、交接要求、工具偏好等内容
- 不建议把完整主 prompt 重复写入 `system_reminder`
