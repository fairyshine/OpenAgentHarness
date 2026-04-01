# Run Module

## 范围

该模块包括：

- run 查询
- run steps 查询
- run 取消

## 接口

### `GET /runs/{runId}`

用途：

- 查询 run 当前状态
- 获取失败信息、时间戳和元数据

关键字段：

- `triggerType`
- `status`
- `agentName`
- `effectiveAgentName`
- `switchCount`
- `errorCode`
- `errorMessage`

### `POST /runs/{runId}/cancel`

用途：

- 请求取消正在排队或运行中的 run

返回：

- `runId`
- `status=cancellation_requested`

### `GET /runs/{runId}/steps`

用途：

- 查询当前 run 的步骤级审计投影
- 观察 `model_call`、`tool_call`、`agent_switch`、`agent_delegate`、`hook` 等控制流

返回：

- `items`
- `nextCursor`

## 状态约定

- `queued`
- `running`
- `waiting_tool`
- `completed`
- `failed`
- `cancelled`
- `timed_out`

## 设计说明

- 取消是异步操作，返回值只表示“已请求取消”
- 最终取消是否成功，以后续 run 状态和 SSE 事件为准
- run 内允许通过 `agent.switch` 切换 `effectiveAgentName`
- run 内允许通过 `agent.delegate` 创建后台 subagent 执行
