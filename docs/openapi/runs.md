# Run Module

## 接口

### `GET /runs/{runId}`

查询 run 状态。关键字段：`parentRunId`、`triggerType`、`status`、`agentName`、`effectiveAgentName`、`switchCount`、`heartbeatAt`、`errorCode`、`errorMessage`。

### `POST /runs/{runId}/cancel`

请求取消 run。返回 `runId`、`status=cancellation_requested`。

取消是异步操作，最终结果以后续 run 状态和 SSE 事件为准。

### `POST /runs/{runId}/guide`

把一个已经位于服务端 session 队列中的 run 提升为队首，并请求中断当前活跃 run。

返回 `runId`、`status=interrupt_requested`。

适用场景：

- 用户消息已经通过默认 `queue` 模式进入队列
- 之后又决定“不等了”，希望优先切到这条消息

典型流程：

1. 先用 `GET /sessions/{sessionId}/queue` 找到目标 `runId`
2. 再调用 `POST /runs/{runId}/guide`

### `GET /runs/{runId}/steps`

查询步骤级审计：`model_call`、`tool_call`、`agent_switch`、`agent_delegate`、`hook`。返回 `items`、`nextCursor`。

## 状态

`queued` → `running` → `waiting_tool` → `completed` / `failed` / `cancelled` / `timed_out`

## 设计说明

- run 内允许 `agent.switch`（切换 agent）和 `agent.delegate`（创建 subagent）
- child run 通过 `parentRunId` 关联父 run
- worker 异常退出时，后续 worker 基于 `heartbeatAt` 回收 stale run 为失败态
