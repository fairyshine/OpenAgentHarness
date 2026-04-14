# Events And Audit

## SSE 事件流

客户端通过 `GET /sessions/{id}/events` 监听 session 实时输出，单向流式推送。

### 事件类型

| 事件 | 触发时机 | 关键字段 |
| --- | --- | --- |
| `run.queued` | run 入队 | `runId` |
| `run.started` | run 开始执行 | `runId`, `agentName` |
| `run.progress` | 进度更新 | `runId`, `step` |
| `message.delta` | 流式文本增量 | `runId`, `content` |
| `agent.switch.requested` | 请求切换 agent | `runId`, `fromAgent`, `toAgent` |
| `agent.switched` | 切换完成 | `runId`, `agentName` |
| `agent.delegate.started` | subagent 开始 | `runId`, `childRunId`, `agentName` |
| `agent.delegate.completed` | subagent 完成 | `runId`, `childRunId` |
| `agent.delegate.failed` | subagent 失败 | `runId`, `childRunId`, `error` |
| `tool.started` | tool 开始 | `runId`, `toolName`, `toolCallId` |
| `tool.completed` | tool 成功 | `runId`, `toolName`, `toolCallId` |
| `tool.failed` | tool 失败 | `runId`, `toolName`, `error` |
| `run.completed` | 正常完成 | `runId` |
| `run.failed` | 执行失败 | `runId`, `errorCode` |
| `run.cancelled` | 被取消 | `runId` |

### 事件格式示例

```json
{ "event": "message.delta",
  "data": { "sessionId": "ses_abc", "runId": "run_123", "content": "让我先看看这个文件" } }
```

```json
{ "event": "tool.completed",
  "data": { "sessionId": "ses_abc", "runId": "run_123", "toolName": "Read", "toolCallId": "tc_456", "durationMs": 42 } }
```

```json
{ "event": "run.completed",
  "data": { "sessionId": "ses_abc", "runId": "run_123", "agentName": "builder", "switchCount": 1, "durationMs": 15420 } }
```

### 客户端消费建议

- `cursor` 支持断线重连
- `message.delta` 需客户端拼接完整文本
- 监听 `run.completed` / `run.failed` / `run.cancelled` 判断结束
- 不依赖事件顺序推断状态，以 `GET /runs/{id}` 为准

## 结构化日志与审计

### 审计范围

| 节点 | 内容 |
| --- | --- |
| API 请求入口 | 方法、路径、caller context |
| run 状态变更 | queued → running → completed 等 |
| model call | model_ref、token 用量、延迟 |
| tool call | tool_name、执行状态、耗时 |
| action run | action 名、输入、结果 |
| hook run | hook 名、事件、决策 |
| backend shell | 命令、exit code、耗时 |
| workspace local state | 当前 worker 上的本地状态与诊断信息 |

### 日志字段

| 字段 | 说明 |
| --- | --- |
| `subject_ref` | 调用方标识 |
| `workspace_id` / `session_id` / `run_id` | 关联标识 |
| `agent_name` / `effective_agent_name` | agent 标识 |
| `tool_name` | tool 名称 |
| `duration_ms` | 耗时 |
| `status` | 结果状态 |

### 存储

- 审计记录持久化在 PostgreSQL（`tool_calls`、`hook_runs` 等表）
- 结构化日志输出到 stdout，可对接外部系统
- SSE 事件写入 `session_events` 表，支持回放和断线重连
