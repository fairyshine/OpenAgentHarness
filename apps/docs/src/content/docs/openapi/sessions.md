---
title: "Session And Message Module"
---

# Session And Message Module

## 接口

### `POST /workspaces/{workspaceId}/sessions`

创建新 session。可选：`title`、`agentName`（须在当前 catalog 中）。

### `GET /workspaces/{workspaceId}/sessions`

分页读取 session 列表。参数：`pageSize`、`cursor`。仅返回当前 workspace 的会话。

### `GET /sessions/{sessionId}`

获取会话元数据。

### `GET /sessions/{sessionId}/snapshot`

一次性读取会话首屏快照，供 Web / 外部控制台初始化使用。返回：

- `session`：会话元数据
- `messages`：最近的 transcript 视图消息页
- `runs`：当前选中 run 或最近 run 列表
- `selectedRunId` / `selectedRunSteps`：传入 `selectedRunId` 且属于当前 session 时返回
- `queue`：当前服务端后续消息队列

参数：

- `selectedRunId`：可选。请求在快照里选中某个 run，并返回其步骤页。

### `PATCH /sessions/{sessionId}`

更新会话可变设置。请求体至少包含一个字段：

- `title`：会话标题
- `activeAgentName`：当前活跃 agent 名称
- `modelRef`：当前会话模型引用；传 `null` 表示清除覆盖
- `workspaceMemory`：workspace memory 覆盖；传 `null` 表示清除覆盖

### `DELETE /sessions/{sessionId}`

删除会话记录及其关联运行时数据。成功返回 `204`。

### `GET /sessions/{sessionId}/children`

分页读取当前 session 的直接子 session，主要用于查看 subagent 会话。参数：`pageSize`、`cursor`。

返回 `SessionPage`，每个子 session 会带 `parentSessionId`。子 session 的消息和 runs 仍然通过现有接口读取：

- `GET /sessions/{childSessionId}/messages`
- `GET /sessions/{childSessionId}/runs`

### `GET /sessions/{sessionId}/messages`

分页读取历史消息。参数：`pageSize`、`cursor`、`direction`、`view`。

- `direction=forward`：从最旧消息向后翻页
- `direction=backward`：从最新消息向前翻页，适合聊天窗口“加载更早消息”
- `cursor` 是 opaque keyset cursor，不再是 offset
- `view=stored`：返回持久化原始 `Message`，这是默认值
- `view=transcript`：返回经过 transcript projection 映射后的 API `Message`

`view=transcript` 会走 `EngineMessage[] -> projectToTranscript() -> TranscriptMessage[] -> Message[]`。返回的 `Message.metadata` 会补充 projection 追踪字段：

- `projectedView`
- `projectedSemanticType`
- `projectedSourceMessageIds`
- `projectionMetadata`

当前公开消息列表 API 只支持 `stored` 和 `transcript` 两种视图；`model`、`compact`、`debug` projection 是 engine 内部消费侧视图，不通过此接口直接返回。

`Message.content` 采用 AI SDK 风格 role-aware 结构：

- `system` — 字符串
- `user` — 字符串，或 `text / image / file` parts
- `assistant` — 字符串，或 `text / reasoning / tool-call / tool-result` 等 parts
- `tool` — `tool-result / tool-approval-response` parts 数组

`tool-result.output` 为 `ToolResultOutput` 结构（如 `{ "type": "text", "value": "..." }`）。

### `GET /sessions/{sessionId}/messages/{messageId}`

按 `messageId` 读取当前 session 下的单条消息。若消息不存在，或不属于该 session，返回 404。

### `GET /sessions/{sessionId}/messages/{messageId}/context`

按锚点消息读取上下文窗口。参数：

- `before`：返回锚点之前的消息数，默认 `20`
- `after`：返回锚点之后的消息数，默认 `20`

返回字段：

- `anchor`：锚点消息本身
- `before`：锚点之前的消息，按时间正序返回
- `after`：锚点之后的消息，按时间正序返回
- `hasMoreBefore` / `hasMoreAfter`：锚点两侧是否还有未返回消息

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

### `GET /sessions/{sessionId}/runs`

分页读取当前 session 下的 runs。参数：`pageSize`、`cursor`。返回 `RunPage`。

### `GET /sessions/{sessionId}/terminals/{terminalId}`

读取某个 session terminal 的输出快照。参数：

- `maxBytes`：可选，返回输出的最大字节数，范围 `1024` 到 `1048576`，默认 `262144`

返回字段包括 `status`、`outputPath`、`output`、`encoding`、`truncated`、`inputWritable`、`terminalKind`、`pid`、`command`、`exitCode`、`signal`、`createdAt`、`updatedAt`、`endedAt`。

### `POST /sessions/{sessionId}/terminals/{terminalId}/input`

向可写 session terminal 写入输入。请求体：

- `input`：要写入的文本
- `appendNewline`：可选，是否追加换行

返回 `sessionId`、`terminalId`、`status`、`inputWritten=true`、`appendNewline`、`inputWritable`、`updatedAt`。

### `POST /sessions/{sessionId}/compact`

手动触发当前 session 的一次 compact。该接口同步执行，返回本次 compact 对应的 `runId` 与结果摘要。

请求体：

- `instructions`：可选。额外的摘要要求，只作用于这次手动 compact，例如“重点保留未完成事项和 blocker”

返回字段：

- `runId`：本次手动 compact 对应的 system run
- `status`：固定为 `completed`
- `compacted`：是否真的写入了 `compact_boundary` / `compact_summary`
- `reason`：若未发生 compact，返回跳过原因（当前为 `insufficient_history` 或 `summary_empty`）
- `boundaryMessageId` / `summaryMessageId`：若 compact 成功，返回生成的 system message ID
- `summarizedMessageCount`：本次被摘要的消息数

限制：

- 若当前 session 仍有活跃 run，或存在排队中的 follow-up run，请求会返回冲突错误，不会并发执行 compact
- 即使 workspace 配置了 `compact.enabled: false`，手动 compact 依然允许执行；该开关只影响自动 compact

## 设计说明

- 消息创建是异步语义，需结合 `GET /runs/{runId}` 和 SSE 获取进度
- 同 session 可连续写入多条消息，形成串行 run 队列
- 后续消息队列现在是服务端可寻址资源；前端只负责读取 `/sessions/{sessionId}/queue` 并调用相关 API，不再维护本地排队状态
- API 默认是“排队而不是打断”；只有显式 `runningRunBehavior = "interrupt"` 才会中断当前活跃 run
- 对已经进入队列的消息，如果要转成“打断当前 run 的引导模式”，请调用 `POST /runs/{runId}/guide`
- 手动 compact 会创建一个独立的 `system` run，并写入 `compact_boundary` / `compact_summary` 消息；不会伪装成普通 user message
- runtime 按 AI SDK 兼容结构持久化消息（含 tool-call / tool-result）
- session 维护 `activeAgentName`，run 内 `agent.switch` 后可同步更新
- session/message/run 统一保存到中心库，本地 `history.db` 仅作为运行时数据文件
- 长会话消息列表现在走存储层真分页，不再先全量加载后在内存里 slice
