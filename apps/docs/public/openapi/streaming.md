# Streaming Module

## 接口

### `GET /sessions/{sessionId}/events`

订阅 session 流式事件。可选按 `runId` 过滤，可通过 `cursor` 恢复。返回 `text/event-stream`。

## 事件类型

`run.queued`、`run.started`、`message.delta`、`message.completed`、`agent.switch.requested`、`agent.switched`、`agent.delegate.started`、`agent.delegate.completed`、`agent.delegate.failed`、`hook.notice`、`tool.started`、`tool.completed`、`tool.failed`、`run.completed`、`run.failed`、`run.cancelled`

## 事件格式示例

```text
event: tool.completed
data: {"runId":"run_123","callId":"tc_001","toolName":"code.review","sourceType":"action"}

event: agent.switched
data: {"runId":"run_123","fromAgent":"plan","toAgent":"build","switchCount":1}

event: agent.delegate.started
data: {"runId":"run_123","agentName":"builder","targetAgent":"repo-explorer","childRunId":"run_456"}

event: hook.notice
data: {"runId":"run_123","hookName":"rewrite-request","eventName":"before_model_call","errorCode":"hook_execution_failed","errorMessage":"Prompt hook timed out after 1000ms."}
```

## 客户端规则

- 长连接接收事件
- 断线后携带 `cursor` 重连
- 终态以 `run.completed` / `run.failed` / `run.cancelled` 为准
