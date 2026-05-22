---
title: "Hook Runtime"
---

# Hook Runtime

## Hook 类型

- **Lifecycle Hook** — 观测系统事件
- **Interceptor Hook** — 改写请求和执行逻辑

Handler 类型：`command`（shell 脚本）、`http`（HTTP 请求）、`prompt`（prompt 型判断）、`agent`（agent 执行决策）。

配置使用 YAML，可选 `matcher` 按事件值做正则过滤。

## 事件点

### 当前已支持的 Hook 事件

| 事件 | matcher 匹配 | 执行位置 |
| --- | --- | --- |
| `before_context_compact` | 不支持 matcher | compact 阈值判定通过后、compact summary 模型调用之前 |
| `after_context_compact` | 不支持 matcher | compact boundary / summary 生成之后、写入消息存储之前 |
| `before_context_build` | 不支持 matcher | 自动 compact 完成之后，静态 system prompt 拼装之前 |
| `after_context_build` | 不支持 matcher | 静态 prompt 和 history 装配完成之后 |
| `before_model_call` | `model_ref` | 最终模型请求发出之前 |
| `after_model_call` | `model_ref` | 模型完整响应返回之后 |
| `before_tool_dispatch` | `tool_name` | tool executor 分发之前 |
| `after_tool_dispatch` | `tool_name` | tool 返回之后、结果回填模型之前 |
| `run_completed` | `trigger_type` | run 成功完成之后 |
| `run_failed` | `trigger_type` | run 失败或超时之后 |

### 上下文阶段的完整顺序

1. `before_context_compact`
2. 生成 compact summary
3. `after_context_compact`
4. `before_context_build`
5. 静态 prompt / history / reminder 装配
6. `after_context_build`
7. `before_model_call`

如果无需 compact，则跳过前 3 步。

## 输入协议

所有 handler 接收同一份 JSON envelope。公共字段：`workspace_id`、`session_id`、`run_id`、`cwd`、`hook_event_name`、`agent_name`、`effective_agent_name`。事件附加字段按类型补充：

- `before_context_compact`: `context.messages` 与 compact 元数据（`contextWindowTokens`、`compactThresholdTokens`、`estimatedInputTokens`、`estimatedPostCompactTokens`、`summarizedMessageCount`、`configuredRecentGroupCount`、`keepRecentGroupCount`、`compactThroughMessageId?`）
- `after_context_compact`: `summaryText`、`boundaryMessage`、`summaryMessage` 与同一组 compact 元数据
- `before_context_build` / `after_context_build`: `context.messages`
- `before_model_call` / `after_model_call`: `model_ref`、`model_request`、`model_response`
- `before_tool_dispatch` / `after_tool_dispatch`: `tool_name`、`tool_input`、`tool_output`
- `run_completed` / `run_failed`: `trigger_type`

## 输出协议

统一采用：

- 通用控制字段：`continue`、`stopReason`、`suppressOutput`、`systemMessage`
- 顶层 `decision` / `reason`
- 允许改写的事件将 patch 放入 `hookSpecificOutput`，受 `capabilities` 限制

## Handler 返回语义

| Handler | 成功 | 阻断 | 错误 |
| --- | --- | --- | --- |
| `command` | exit 0（stdout JSON 按输出协议解析） | exit 2（stderr 为原因） | 其他 exit code，记录日志继续 |
| `http` | 2xx + JSON body | — | 非 2xx / 超时，记录日志继续 |
| `prompt` | 运行时注入 envelope，要求返回统一 JSON | — | — |
| `agent` | 运行时将 envelope 作为任务上下文交给指定 agent | — | — |

## 限制

- Hook 不允许直接操作数据库事务
- 改写能力须显式声明 capability
- 默认只作用于当前 run 上下文
- `.openharness/hooks/` 可放置 `*.yaml`、脚本、prompt 文件和其他静态资源
