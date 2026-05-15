# 模型输入与 UI 展示

## ModelMessage 如何变成 ChatMessage

`projectToModel()` 只决定“给模型看什么”。它不负责最终 SDK 格式。

下一步由 `ModelMessageSerializer.toAiSdkMessages()` 完成：

```txt
ModelMessage[]
  -> ModelMessageSerializer.toAiSdkMessages()
  -> ChatMessage[]
```

主要规则：

| ModelMessage | ChatMessage 转换 |
| --- | --- |
| `role === "system"` 且 content 不是 string | 提取文本，变成 system string |
| `role !== "user"` | 调用 `contentToPromptMessage(role, content)` |
| `role === "user"` | 先校验/归一化 user content，再补充 workspace file attachments |

用户消息有一个额外能力：如果文本里引用 workspace 文件，serializer 会尝试把文件以内联 attachment 的形式补进 user content。

限制包括：

- 每条消息最多内联 4 个 workspace attachments。
- 单个 attachment 最大 5 MB。
- 图片可以隐式引用。
- 非图片文件通常需要显式 `@path/to/file.ext` 引用。

注意边界：

```txt
projectToModel()     决定消息是否进入模型、是否被 compact/truncate
toAiSdkMessages()    决定这些消息如何表示成 provider-neutral ChatMessage
provider adapter     决定最终 SDK/request 格式
```

不要把 compact、prune、semantic filtering 放进 serializer。

## 模型上下文构建完整链路

模型执行前，`ModelInputBuilder.buildModelContextMessages()` 组装上下文。简化流程：

```txt
EngineMessage[]
  -> EngineMessageProjector.projectToModel()
  -> ModelMessage[]
  -> ModelMessageSerializer.toAiSdkMessages()
  -> ChatMessage[]
  -> before_context_build hooks
  -> static prompt messages
  -> optional agent system reminder
  -> after_context_build hooks
  -> collapse leading system messages
  -> final ChatMessage[]
```

所以最终发给 LLM 的消息不仅来自历史 projection，还会叠加：

- agent/static system prompt
- context hooks
- system reminder
- leading system message collapse

这也是为什么 `EngineMessage` 不应该直接等于“最终发给模型的消息”。

## Web UI 当前如何展示用户消息

需要特别说明：当前 Web conversation feed 主要不是直接消费 `projectToTranscript()` 的结果。

Web 当前主要链路是：

```txt
messages API 返回的 Message[]
  + deferred SessionEvent[]
  + live streaming messages
  -> buildRuntimeViewModel()
  -> buildProjectedMessageFeed()
  -> ConversationFeed
```

也就是说，用户界面展示层目前有两条相关路径：

| 路径 | 数据来源 | 用途 |
| --- | --- | --- |
| 服务端 transcript projection | `EngineMessage[] -> TranscriptMessage[] -> Message[]` | 服务层 transcript 查询、runtime 语义回放 |
| Web conversation feed | `Message[] + events + live messages` | 当前 Web 聊天窗口展示 |

长期看，这两条路径可以逐步收敛，让 Web 也更多消费 transcript projection。但当前阅读代码时要知道它们是并存的。

## Web conversation feed 的实现细节

当前 Web 展示层的关键函数是 `buildRuntimeViewModel()` 和 `buildProjectedMessageFeed()`。

输入包括：

- 已加载的 `Message[]`
- 仍在前端保留的 `deferredEvents`
- live streaming message records
- queued message ids
- run steps

`buildRuntimeViewModel()` 先过滤掉：

- 当前 session 之外的消息
- 仍在 queued 状态、不应该进入 feed 的消息

然后把 live streaming records 转成临时 `Message`：

```txt
live message record
  -> buildMessageRecord()
  -> id: live:${persistedMessageId ?? liveMessageKey}
```

### buildProjectedMessageFeed()

`buildProjectedMessageFeed()` 做几件事：

1. 按 runId 把 deferred events 分组。
2. 合并 persisted messages 和 live messages。
3. 按 runId 把消息分组。
4. 对每个 run 调用 `projectRunConversation()`。
5. 计算 run 的展示锚点时间。
6. 按展示锚点排序整个 feed。
7. 每个 run 只展开一次，避免重复插入同一 run 的投影结果。

展示锚点时间由 `resolveRunDisplayAnchorTimestamp()` 计算。它会在 run execution timestamp 和 earliest message timestamp 之间取合适位置，让 run 产物在 UI 里更接近它实际开始执行的位置。

### projectRunConversation()

`projectRunConversation()` 是前端 UI 的局部投影器，目标是让 streaming assistant 文本和工具消息在 conversation feed 中看起来更自然。

它的规则和 `buildSessionEngineMessages()` 类似，但输出仍然是 API `Message` 形状，而不是 `EngineMessage`。

核心逻辑：

1. 如果没有 run messages 或没有 events，直接返回原 messages。
2. 收集带有 `message.delta` 的 message id。
3. 遇到 `message.delta` 时，为该 message 创建或追加 active segment。
4. 遇到 `message.completed` 时：
   - 先 flush 其他 active segment。
   - 如果完成的是 streamed assistant text message，就 flush 当前 segment。
   - 否则直接放入 completed message。
5. 遇到 run terminal event 时，flush 所有 active segment。
6. 最后把 fallback messages 按时间插回 projected messages。

生成的 segment message 形如：

```ts
{
  id: `segment:${messageId}:${segmentIndex}`,
  role: "assistant",
  content: activeSegment.content,
  createdAt: activeSegment.createdAt
}
```

这和 runtime `EngineMessage` segment 的目的类似：展示 streaming 输出时，不把所有内容都压成一条最终消息。

## 服务端 transcript projection 与 Web feed 的差异

| 维度 | 服务端 transcript projection | Web conversation feed |
| --- | --- | --- |
| 输入 | `EngineMessage[]` | `Message[] + SessionEvent[] + live records` |
| 输出 | `TranscriptMessage[]`，再转 `Message[]` | 直接输出 UI 用 `Message[]` |
| 语义来源 | `EngineMessage.kind` | API message role/content + events |
| 是否理解 compact kind | 是 | 主要通过普通 message metadata/content 展示 |
| 是否处理 live streaming | 依赖同步后的 events/runtime messages | 是，直接合并 live records |
| 主要用途 | runtime 语义回放、服务层查询 | 当前 Web 聊天窗口 |

## 端到端例子

假设用户说：

```txt
帮我看看 src/auth.ts 为什么登录失败，并修一下。
```

模型调用 `Read(src/auth.ts)`，工具返回一个很长的文件内容。之后发生 compact。

### 1. 持久化 Message

```ts
[
  {
    id: "m1",
    sessionId: "s1",
    role: "user",
    content: "帮我看看 src/auth.ts 为什么登录失败，并修一下。",
    createdAt: "2026-05-15T10:00:00.000Z"
  },
  {
    id: "m2",
    sessionId: "s1",
    runId: "r1",
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Read",
        input: { file_path: "src/auth.ts" }
      }
    ],
    createdAt: "2026-05-15T10:00:01.000Z"
  },
  {
    id: "m3",
    sessionId: "s1",
    runId: "r1",
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "Read",
        output: { type: "text", value: "...very long file content..." }
      }
    ],
    metadata: { compactedAt: "2026-05-15T10:05:00.000Z" },
    createdAt: "2026-05-15T10:00:02.000Z"
  },
  {
    id: "m4",
    sessionId: "s1",
    role: "system",
    content: "Conversation compacted",
    metadata: {
      runtimeKind: "compact_boundary",
      extra: { compactThroughMessageId: "m3" }
    },
    createdAt: "2026-05-15T10:05:00.000Z"
  },
  {
    id: "m5",
    sessionId: "s1",
    role: "system",
    content: "The user asked to debug login in src/auth.ts. The file was read before compact.",
    metadata: {
      runtimeKind: "compact_summary",
      summaryForBoundaryId: "m4"
    },
    createdAt: "2026-05-15T10:05:01.000Z"
  },
  {
    id: "m6",
    sessionId: "s1",
    runId: "r2",
    role: "assistant",
    content: "我会继续从 compact 后的上下文定位问题。",
    createdAt: "2026-05-15T10:06:00.000Z"
  }
]
```

### 2. EngineMessage

提升后，runtime 看到的是：

```ts
[
  { id: "m1", role: "user", kind: "user_input", content: "帮我看看 src/auth.ts 为什么登录失败，并修一下。" },
  { id: "m2", role: "assistant", kind: "tool_call", content: [{ type: "tool-call", toolCallId: "call_1" }] },
  { id: "m3", role: "tool", kind: "tool_result", metadata: { compactedAt: "2026-05-15T10:05:00.000Z" } },
  { id: "m4", role: "system", kind: "compact_boundary" },
  { id: "m5", role: "system", kind: "compact_summary" },
  { id: "m6", role: "assistant", kind: "assistant_text", content: "我会继续从 compact 后的上下文定位问题。" }
]
```

### 3. Transcript projection

Transcript 默认保留可显示历史：

```ts
[
  { view: "transcript", semanticType: "user_input", sourceMessageIds: ["m1"] },
  { view: "transcript", semanticType: "tool_call", sourceMessageIds: ["m2"] },
  { view: "transcript", semanticType: "tool_result", sourceMessageIds: ["m3"] },
  { view: "transcript", semanticType: "compact_boundary", sourceMessageIds: ["m4"] },
  { view: "transcript", semanticType: "compact_summary", sourceMessageIds: ["m5"] },
  { view: "transcript", semanticType: "assistant_text", sourceMessageIds: ["m6"] }
]
```

如果某条消息设置了 `metadata.visibleInTranscript === false`，它会从 transcript 中隐藏。

### 4. Model projection

因为存在 compact boundary，并且 boundary 指向 `m3`，模型不会再看到 `m1` 到 `m4` 的原始历史，而是看到 summary 和新消息：

```ts
[
  {
    view: "model",
    role: "system",
    semanticType: "compact_summary",
    sourceMessageIds: ["m5"],
    content: "The user asked to debug login in src/auth.ts. The file was read before compact."
  },
  {
    view: "model",
    role: "assistant",
    semanticType: "assistant_text",
    sourceMessageIds: ["m6"],
    content: "我会继续从 compact 后的上下文定位问题。"
  }
]
```

如果没有 compact boundary，但 `m3` 已经有 `metadata.compactedAt`，则 model projection 会保留 tool result 的位置，但把内容替换为 stub：

```ts
{
  view: "model",
  role: "tool",
  semanticType: "tool_result",
  sourceMessageIds: ["m3"],
  metadata: {
    compacted: true,
    notes: ["tool result compacted for model context"]
  },
  content: [
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "Read",
      output: {
        type: "text",
        value: "[Old tool result content cleared]"
      }
    }
  ]
}
```

### 5. ChatMessage

`ModelMessageSerializer` 再把 model projection 变成 provider-neutral `ChatMessage[]`：

```ts
[
  {
    role: "system",
    content: "The user asked to debug login in src/auth.ts. The file was read before compact."
  },
  {
    role: "assistant",
    content: "我会继续从 compact 后的上下文定位问题。"
  }
]
```

之后 hooks/static prompts/system reminder/provider adapter 继续处理，最终才是发给 LLM 的 request。

