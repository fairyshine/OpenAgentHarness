# Session And Message Module

## 范围

该模块包括：

- session 创建
- session 查询
- message 列表
- message 创建

## 接口

### `POST /workspaces/{workspaceId}/sessions`

用途：

- 在指定 workspace 下创建新会话

可选字段：

- `title`
- `agentName`

说明：

- `agentName` 可指向当前 workspace 可见 catalog 中的 platform agent 或 workspace agent

### `GET /sessions/{sessionId}`

用途：

- 获取会话元数据

### `GET /sessions/{sessionId}/messages`

用途：

- 分页读取历史消息

查询参数：

- `pageSize`
- `cursor`

### `POST /sessions/{sessionId}/messages`

用途：

- 写入一条用户消息
- 创建 run
- 将 run 放入 session 队列

返回：

- `messageId`
- `runId`
- `status=queued`

## 设计说明

- message 创建是异步语义，不同步返回最终结果
- 客户端需结合 `GET /runs/{runId}` 和 SSE 获取执行进度
- 同一 session 可连续写入多条 message，它们会形成串行 run 队列
- session 会维护 `activeAgentName`，作为后续默认 primary agent
- 若 run 内发生 `agent.switch`，session 的 `activeAgentName` 可在 run 完成后同步更新
