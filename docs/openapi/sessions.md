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

请求体：

- `content`：用户输入文本
- `metadata`：可选消息元数据
- `runningRunBehavior`：可选，`queue` 或 `interrupt`

行为语义：

- 默认行为等价于 `runningRunBehavior = "queue"`
- 如果当前 session 已有活跃 run，新消息不会打断当前 run，而是继续创建新的 queued run，等待前一个 run 结束后串行执行
- 仅当显式传入 `runningRunBehavior = "interrupt"` 时，runtime 才会先请求取消当前活跃 run，再把新消息作为下一轮执行
- Web 控制台里的普通发送对应默认排队；“引导”按钮对应显式 `interrupt`

### `GET /sessions/{sessionId}/queue`

读取当前 session 的服务端后续消息队列。返回有序 `items`：

- `runId`：排队 run 的可寻址资源 ID
- `messageId`：对应用户消息 ID
- `content`：用户输入文本
- `createdAt`：进入服务端队列的时间
- `position`：当前队列顺序（从 1 开始）

## 设计说明

- 消息创建是异步语义，需结合 `GET /runs/{runId}` 和 SSE 获取进度
- 同 session 可连续写入多条消息，形成串行 run 队列
- 后续消息队列现在是服务端可寻址资源；前端只负责读取 `/sessions/{sessionId}/queue` 并调用相关 API，不再维护本地排队状态
- API 默认是“排队而不是打断”；只有显式 `runningRunBehavior = "interrupt"` 才会中断当前活跃 run
- 对已经进入队列的消息，如果要转成“打断当前 run 的引导模式”，请调用 `POST /runs/{runId}/guide`
- runtime 按 AI SDK 兼容结构持久化消息（含 tool-call / tool-result）
- session 维护 `activeAgentName`，run 内 `agent.switch` 后可同步更新
- session/message/run 统一保存到中心库，本地 `history.db` 仅作为运行时数据文件
