---
title: "Message 与 EngineMessage"
---

# Message 与 EngineMessage

## `Message`: 持久化事实模型

`Message` 定义在 `packages/api-contracts/src/messages.ts`。它是外部 API 和存储层的稳定合同。

它表达：

- `id`: 消息 ID。
- `sessionId`: 属于哪个会话。
- `runId`: 如果消息由某次 run 产生，则关联 run。
- `role`: `system` / `user` / `assistant` / `tool`。
- `content`: 文本或结构化 content parts。
- `metadata`: 附加信息。
- `createdAt`: 持久化时间线。

它适合回答：

- 会话里发生过哪些消息？
- API 应该返回什么历史记录？
- 用户或工具原始输出是什么？

它不适合直接回答：

- 这条 system 消息是普通系统提示，还是 compact summary？
- 这条 assistant 消息是普通文本，还是 tool call？
- 这条 tool result 是否应该被送进模型上下文？
- compact boundary 之后模型应该看到哪些历史？

原因是 `Message` 是稳定事实层。runtime 语义会变化，不能把所有 engine 内部概念都硬塞进 API 合同里。

## `EngineMessage`: runtime 语义模型

`EngineMessage` 定义在 `packages/engine-core/src/engine/engine-messages.ts`。它是 Engine 内部真正操作的消息语义层。

核心结构：

```ts
export interface EngineMessage {
  id: string;
  sessionId: string;
  runId?: string;
  role: "system" | "user" | "assistant" | "tool";
  origin?: Message["origin"];
  mode?: Message["mode"];
  kind: EngineMessageKind;
  content: Message["content"];
  createdAt: string;
  metadata?: EngineMessageMetadata;
}
```

`EngineMessage` 相比 `Message` 最关键的新增字段是 `kind`。

`role` 只说明消息在聊天协议里的角色。`kind` 说明消息在 OAH runtime 里的语义。例如：

| `role` | 可能的 `kind` | 含义 |
| --- | --- | --- |
| `system` | `system_note` | 普通 runtime/system note |
| `system` | `compact_boundary` | compact 边界标记 |
| `system` | `compact_summary` | compact 后承接旧历史的摘要 |
| `user` | `user_input` | 用户输入 |
| `assistant` | `assistant_text` | assistant 普通文本 |
| `assistant` | `assistant_reasoning` | assistant reasoning 内容 |
| `assistant` | `tool_call` | assistant 发起工具调用 |
| `assistant` | `tool_approval_request` | assistant 请求工具审批 |
| `tool` | `tool_result` | 工具结果 |
| `tool` | `tool_approval_response` | 工具审批响应 |
| 任意 | `task_notification` | 任务通知 |
| `system` | `runtime_reminder` | runtime 注入提醒 |
| `system` | `handoff_summary` | agent handoff 摘要 |
| `system` | `agent_switch_note` | agent 切换说明 |

一句话：

```txt
role 是协议角色，kind 是 runtime 语义。
```

## `runtime_messages`: EngineMessage 的持久化快照

`runtime_messages` 是存储表，不是新的业务类型。SQLite schema 中它大致是：

```sql
create table if not exists runtime_messages (
  id text primary key,
  session_id text not null,
  run_id text,
  created_at text not null,
  payload text not null
)
```

其中 `payload` 是序列化后的 `EngineMessage` JSON。

关系可以这样记：

```txt
EngineMessage      代码中的 runtime 语义对象
runtime_messages   数据库中保存 EngineMessage 快照的表
```

为什么需要这张表：

- 避免每次都从 `messages + session events` 重新构建 runtime 消息。
- 给 archive/export/debug 提供稳定的 runtime 消息快照。
- 让 runtime message 的读取和普通 API message 读取解耦。

如果 `runtime_messages` 为空，当前实现会回退到从 `messages` 和 `session events` 重新构建 `EngineMessage[]`。

## Message 如何提升为 EngineMessage

入口在 `toEngineMessage()` 和 `buildSessionEngineMessages()`。

最简单的提升规则：

| Persisted `Message` | Engine `kind` |
| --- | --- |
| `metadata.runtimeKind` 是合法 kind | 直接使用 `metadata.runtimeKind` |
| `mode === "task-notification"` | `task_notification` |
| `role === "system"` | `system_note` |
| `role === "user"` | `user_input` |
| `role === "assistant"` 且 content 有 `tool-call` | `tool_call` |
| `role === "assistant"` 且 content 有 `tool-approval-request` | `tool_approval_request` |
| `role === "assistant"` 且 content 有 `reasoning` | `assistant_reasoning` |
| `role === "assistant"` 其他情况 | `assistant_text` |
| `role === "tool"` 且 content 有 `tool-approval-response` | `tool_approval_response` |
| `role === "tool"` 其他情况 | `tool_result` |

`metadata.runtimeKind` 是持久化层到 runtime 层的桥。例如 compact artifact 落库时仍是普通 `Message`，但 metadata 会说明它应该被解释成 `compact_boundary` 或 `compact_summary`。

示例：

```ts
const message = {
  id: "msg_compact_summary",
  sessionId: "sess_1",
  role: "system",
  content: "Earlier conversation summary...",
  metadata: {
    runtimeKind: "compact_summary",
    summaryForBoundaryId: "msg_compact_boundary"
  },
  createdAt: "2026-05-15T10:00:00.000Z"
};
```

提升后：

```ts
const engineMessage = {
  id: "msg_compact_summary",
  sessionId: "sess_1",
  role: "system",
  kind: "compact_summary",
  content: "Earlier conversation summary...",
  metadata: {
    runtimeKind: "compact_summary",
    summaryForBoundaryId: "msg_compact_boundary"
  },
  createdAt: "2026-05-15T10:00:00.000Z"
};
```

## SessionEvent 如何影响 EngineMessage

`EngineMessage` 不只是对 `Message` 做一层字段映射。`buildSessionEngineMessages()` 还会结合 session events。

当前会影响 runtime message 的事件包括：

- `run.queued`
- `message.delta`
- `message.completed`
- `run.completed`
- `run.failed`
- `run.cancelled`

最重要的场景是 streamed assistant output。

当一个 assistant message 在 streaming 过程中被多个 `message.delta` 更新时，runtime 可能把它切成多个 segment：

```txt
msg_assistant
  -> msg_assistant:segment:1
  -> msg_assistant:segment:2
```

这些 segment 仍然是 `EngineMessage`，但 `metadata.extra` 会记录：

- `sourceMessageId`
- `segmentIndex`
- `startCursor`
- `endCursor`

这样做的目的：

- runtime 可以保留被中断、恢复、分段输出的真实过程。
- projection 可以基于更细粒度的 runtime 片段工作。
- debug 可以反查 segment 来自哪条原始持久化消息和哪些事件游标。

## 同步与读取路径

`EngineMessageSyncService` 管理 runtime message 的同步和读取。

同步路径：

```txt
messageRepository.listBySessionId(sessionId)
  + sessionEventStore.listSince(sessionId)
  -> buildSessionEngineMessages()
  -> engineMessageRepository.replaceBySessionId()
  -> runtime_messages
```

读取路径：

```txt
loadSessionEngineMessages(sessionId)
  -> 如果 runtime_messages 有快照，直接返回
  -> 否则 buildEngineMessagesForSession()
```

这意味着 `runtime_messages` 是快照缓存，但不是唯一真相。真正的事实来源仍然是 `messages + session events`。

