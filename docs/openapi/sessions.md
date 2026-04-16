# Session And Message Module

## 接口

### `POST /workspaces/{workspaceId}/sessions`

创建新 session。可选：`title`、`agentName`（须在当前 catalog 中）。

### `GET /workspaces/{workspaceId}/sessions`

分页读取 session 列表。参数：`pageSize`、`cursor`。仅返回当前 workspace 的会话。

### `GET /sessions/{sessionId}`

获取会话元数据。

### `GET /sessions/{sessionId}/messages`

分页读取历史消息。参数：`pageSize`、`cursor`。

`Message.content` 采用 AI SDK 风格 role-aware 结构：

- `system` — 字符串
- `user` — 字符串，或 `text / image / file` parts
- `assistant` — 字符串，或 `text / reasoning / tool-call / tool-result` 等 parts
- `tool` — `tool-result / tool-approval-response` parts 数组

`tool-result.output` 为 `ToolResultOutput` 结构（如 `{ "type": "text", "value": "..." }`）。

### `POST /sessions/{sessionId}/messages`

写入用户消息，创建 run 并入队。返回 `messageId`、`runId`、`status=queued`。

## 设计说明

- 消息创建是异步语义，需结合 `GET /runs/{runId}` 和 SSE 获取进度
- 同 session 可连续写入多条消息，形成串行 run 队列
- runtime 按 AI SDK 兼容结构持久化消息（含 tool-call / tool-result）
- session 维护 `activeAgentName`，run 内 `agent.switch` 后可同步更新
- session/message/run 统一保存到中心库，本地 `history.db` 仅作为运行时数据文件
