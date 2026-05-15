# Projection 实现细节

Projection Layer 的输入是：

```ts
EngineMessage[]
```

输出是某个消费目标需要的视图：

```ts
ProjectionResult<TranscriptMessage | ModelMessage | CompactMessage | DebugMessage>
```

核心类型定义在 `packages/engine-core/src/engine/message-projections.ts`：

```ts
export type ProjectionView = "transcript" | "model" | "compact" | "debug" | "export";

export interface ProjectedMessageBase {
  view: ProjectionView;
  role: Message["role"];
  mode?: Message["mode"];
  semanticType: string;
  sourceMessageIds: string[];
  content: Message["content"];
  metadata?: {
    hiddenFromTranscript?: boolean;
    hiddenFromModel?: boolean;
    truncated?: boolean;
    compacted?: boolean;
    notes?: string[];
  };
}
```

这里的 `semanticType` 基本来自 `EngineMessage.kind`。`sourceMessageIds` 用来追踪投影消息来自哪些 runtime 消息。

当前实现提供：

| 方法 | 输出 | 用途 |
| --- | --- | --- |
| `projectToTranscript()` | `TranscriptMessage[]` | 服务层 transcript 查询使用 |
| `projectToModel()` | `ModelMessage[]` | 构造 LLM 上下文 |
| `projectToCompact()` | `CompactMessage[]` | compact 逻辑使用 |
| `projectToDebug()` | `DebugMessage[]` | 调试排查使用 |

`ProjectionView` 中有 `export` 这个枚举值，但当前没有实现 `projectToExport()` 方法，它是预留方向。

## ProjectionContext

Projection 的行为由 `ProjectionContext` 控制：

```ts
export interface ProjectionContext {
  sessionId: string;
  activeAgentName: string;
  modelRef?: string;
  provider?: string;
  includeReasoning?: boolean;
  includeToolResults?: boolean;
  toolResultSoftLimitChars?: number;
  applyCompactBoundary?: boolean;
  injectRuntimeReminder?: boolean;
}
```

常用字段含义：

| 字段 | 影响 |
| --- | --- |
| `includeReasoning` | 是否把 `assistant_reasoning` 放入 model projection |
| `includeToolResults` | 是否把 `tool_result` 放入 model projection |
| `toolResultSoftLimitChars` | 超长文本 tool result 在 model projection 中截断 |
| `applyCompactBoundary` | 是否应用最近的 compact boundary |
| `injectRuntimeReminder` | 是否在 model projection 末尾注入 runtime reminder |

## 公共投影结构

除了 `projectToModel()` 的特殊处理，projection 的基础结构来自 `projectGenericMessage()`：

```ts
{
  view,
  role: engineMessage.role,
  mode: engineMessage.mode,
  semanticType: engineMessage.kind,
  sourceMessageIds: [engineMessage.id],
  content: engineMessage.content
}
```

这几个字段的含义：

| 字段 | 含义 |
| --- | --- |
| `view` | 当前投影视图，例如 `model` 或 `transcript` |
| `role` | 继续沿用消息协议角色 |
| `mode` | 保留 task notification 等 message mode |
| `semanticType` | 保留 runtime 语义，通常等于 `EngineMessage.kind` |
| `sourceMessageIds` | 记录这个投影项来自哪些 runtime message |
| `content` | 默认沿用 runtime message 的 content |

## `projectToTranscript()`

目标：给服务层 transcript 查询一条稳定的“可回放消息视图”。

实现规则：

1. 遍历完整 `EngineMessage[]`。
2. 过滤掉 `metadata.visibleInTranscript === false` 的消息。
3. 对其他消息调用 `projectGenericMessage(message, "transcript")`。
4. diagnostics 中记录被隐藏的 message id。
5. 不做 compact boundary 裁剪。
6. 不做 tool result 截断。
7. 不注入 runtime reminder。

伪代码：

```ts
const messages = engineMessages
  .filter((message) => message.metadata?.visibleInTranscript !== false)
  .map((message) => projectGenericMessage(message, "transcript"));

const diagnostics = {
  hiddenMessageIds: engineMessages
    .filter((message) => message.metadata?.visibleInTranscript === false)
    .map((message) => message.id),
  truncatedMessageIds: [],
  injectedNotes: []
};
```

服务层再通过 `#toTranscriptMessage()` 把 `TranscriptMessage` 转回 API 可返回的 `Message` 形状，并补充 metadata：

- `projectedView`
- `projectedSemanticType`
- `projectedSourceMessageIds`
- `projectionMetadata`

转换时还会按 `role` 校验 content：

| Transcript role | 转换规则 |
| --- | --- |
| `system` | 如果 content 不是 string，提取文本 |
| `user` | 如果 content 符合 user content schema，保留；否则提取文本 |
| `assistant` | 如果 content 符合 assistant content schema，保留；否则提取文本 |
| `tool` | 如果 content 符合 tool content schema，保留；否则返回空数组 |

这条链路是：

```txt
EngineMessage[]
  -> projectToTranscript()
  -> TranscriptMessage[]
  -> Message[]
  -> transcript query result
```

## `projectToModel()`

这是最关键的 projection。

目标：从完整 runtime 历史中构造“这一轮 LLM 应该看到的消息”。

主流程：

```txt
EngineMessage[]
  -> 应用 compact boundary
  -> 去掉重复 composite tool call
  -> hoist transient memory context notes
  -> 过滤不允许进模型的消息
  -> 按 kind 做特殊处理
  -> 可选注入 runtime reminder
  -> ModelMessage[]
```

### Step 1: 应用 compact boundary

默认 `applyCompactBoundary !== false`，所以 model projection 会应用最近的 `compact_boundary`。

实现函数是 `applyLatestCompactBoundary()`。它有三个关键 helper：

| Helper | 作用 |
| --- | --- |
| `findLatestCompactBoundaryIndex()` | 从后往前找到最新的 `compact_boundary` |
| `readCompactThroughMessageId()` | 从 boundary 的 `metadata.extra.compactThroughMessageId` 读取裁剪终点 |
| `findSummaryForBoundary()` | 找到 `compact_summary`，匹配 `summaryForBoundaryId` 或 `compactBoundaryId` |

具体规则：

1. 没有 `compact_boundary` 时，原样返回。
2. 找到最新 boundary 后，如果没有 `compactThroughMessageId`，保留 boundary 之后的消息。
3. 如果有 `compactThroughMessageId` 但找不到对应消息，也保留 boundary 之后的消息。
4. 如果找到 `compactThroughMessageId`，保留这个消息之后的 recent messages。
5. 如果有对应 `compact_summary`，把 summary 放到 recent messages 前面。
6. `compact_boundary` 本身不会进入模型。
7. summary 自己不会在 recent messages 中重复出现。

直觉上：

```txt
旧历史 A, B, C, compact_boundary, compact_summary, 新历史 D, E

模型看到：
compact_summary, D, E
```

如果 boundary 明确说 compact through C：

```txt
A, B, C, boundary(extra.compactThroughMessageId=C), summary, D, E

模型看到：
summary, D, E
```

### Step 2: 去掉重复 composite tool call

实现函数是 `removeDuplicateCompositeToolCallMessages()`。

它先收集两类 ID：

- canonical tool call ids: 来自纯 tool call assistant message。
- tool result ids: 来自 tool result message。

然后过滤 assistant composite message。过滤条件是：

1. 当前消息不是纯 tool call message。
2. 当前消息是 assistant message。
3. content 是数组。
4. content 内的某个 tool call id 同时出现在 canonical tool call ids 和 tool result ids 中。

简化理解：

```txt
assistant: [text, tool-call call_1]
assistant: [tool-call call_1]
tool:      [tool-result call_1]

模型上下文保留纯 tool-call 版本，去掉重复 composite 版本。
```

这样可以避免 provider 看到同一个 tool call 出现两次。

### Step 3: 提前放置 transient memory notes

实现函数是 `hoistTransientMemoryContextNotes()`。

它识别临时 memory context note 的条件：

- `role === "system"`
- `kind === "system_note"`
- `metadata.synthetic === true`
- `metadata.eligibleForModelContext === true`
- `metadata.tags` 包含 `session-memory` 或 `workspace-memory`

重排规则：

```txt
leading system messages
  + transient memory notes
  + remaining messages
```

也就是说，memory notes 会被放在已有 leading system messages 后面、普通对话前面。

这么做的原因是：session/workspace memory 对模型上下文很重要，应该尽早出现，而不是被埋在普通历史中。

### Step 4: 过滤不进入模型的消息

判断函数是：

```ts
function isEligibleForModelContext(message: EngineMessage): boolean {
  return message.metadata?.eligibleForModelContext !== false;
}
```

只要 `eligibleForModelContext === false`，这条消息不会进入 `ModelMessage[]`，它的 ID 会进入 diagnostics 的 `hiddenMessageIds`。

常见例子：

- `compact_boundary` 本身通常设置为 `eligibleForModelContext: false`。
- 某些系统事件、UI hint、内部审计消息不应该进入模型。

### Step 5: 按 kind 构造 ModelMessage

核心函数是 `buildModelMessage()`。

规则表：

| EngineMessage kind | 行为 | diagnostics |
| --- | --- | --- |
| `compact_boundary` | 不生成 `ModelMessage` | `hiddenMessageIds` |
| `assistant_reasoning` 且 `includeReasoning === false` | 不生成 `ModelMessage` | `hiddenMessageIds` |
| `tool_result` 且 `includeToolResults === false` | 不生成 `ModelMessage` | `hiddenMessageIds` |
| `tool_result` 且 `metadata.compactedAt` 存在 | 生成 tool result stub | `truncatedMessageIds` |
| `tool_result` 超过 `toolResultSoftLimitChars` | 截断文本输出 | `truncatedMessageIds` |
| 其他消息 | 生成普通 `ModelMessage` | 无 |

普通 `ModelMessage` 结构：

```ts
{
  view: "model",
  role: engineMessage.role,
  semanticType: engineMessage.kind,
  sourceMessageIds: [engineMessage.id],
  content: engineMessage.content,
  mode: engineMessage.mode
}
```

#### compacted tool result stub

如果 tool result 已被 compact：

```ts
engineMessage.kind === "tool_result" && engineMessage.metadata?.compactedAt
```

projection 不会把原始长内容送进模型，而是替换成：

```ts
toolResultContent({
  toolCallId: toolResultPart.toolCallId,
  toolName: toolResultPart.toolName,
  output: "[Old tool result content cleared]"
})
```

同时设置：

```ts
metadata: {
  compacted: true,
  notes: ["tool result compacted for model context"]
}
```

#### soft-limit truncation

如果配置了 `toolResultSoftLimitChars`，且 tool result 是文本或错误文本，并超过该长度：

```ts
output.value.slice(0, toolResultSoftLimitChars) + "..."
```

同时设置：

```ts
metadata: {
  truncated: true,
  notes: [`tool result truncated to ${toolResultSoftLimitChars} chars`]
}
```

### Step 6: 注入 runtime reminder

如果 `injectRuntimeReminder === true`，projection 末尾会追加一条 synthetic system message：

```txt
Continue from the current task state. Re-read files or rerun tools if prior outputs were compacted.
```

结构：

```ts
{
  view: "model",
  role: "system",
  semanticType: "runtime_reminder",
  sourceMessageIds: [],
  content: "Continue from the current task state. Re-read files or rerun tools if prior outputs were compacted."
}
```

`sourceMessageIds` 是空数组，因为它不是从某条持久化消息来的。

### Step 7: diagnostics

`projectToModel()` 返回：

```ts
{
  hiddenMessageIds: string[];
  truncatedMessageIds: string[];
  appliedCompactBoundaryId?: string;
  injectedNotes: string[];
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `hiddenMessageIds` | 被 projection 过滤掉的 engine message |
| `truncatedMessageIds` | 被 stub 或截断的 engine message |
| `appliedCompactBoundaryId` | 应用的最新 compact boundary |
| `injectedNotes` | projection 注入了哪些 synthetic note |

## `projectToCompact()`

`projectToCompact()` 当前复用 `projectToModel()`：

```ts
const modelProjection = this.projectToModel(engineMessages, {
  ...context,
  injectRuntimeReminder: false
});
```

然后把 view 改成 `compact`：

```ts
messages: modelProjection.messages.map((message) => ({
  ...message,
  view: "compact"
}))
```

含义：

- compact 逻辑总结的不是裸历史。
- compact 总结的是“按模型上下文规则处理后的历史”。
- 但 compact 不需要额外注入 runtime reminder。
- compact 继承 model projection 的 boundary、tool result pruning、reasoning/tool-result inclusion 策略。

### ContextCompactionService 如何使用 Compact projection

`ContextCompactionService` 会调用：

```ts
projectToCompact(compactionSourceMessages, {
  applyCompactBoundary: true,
  includeReasoning: true,
  includeToolResults: true,
  toolResultSoftLimitChars: 4000
})
```

然后做以下步骤：

1. 估算 compact projection 的 token usage。
2. 同时估算实际 model context 的 token usage。
3. 根据模型 metadata 读取 context window 和 compact threshold。
4. 如果没到阈值，跳过自动 compact。
5. 把 `CompactMessage[]` 按 group 切分。
6. 保留最近 N 组。
7. 旧组转成 `ChatMessage[]`，发给模型生成 summary。
8. 写入 `compact_boundary` 和 `compact_summary` 两条 system `Message`。
9. 触发 engine message sync，让新 artifact 进入 `EngineMessage[]`。

### compact 分组规则

`groupMessagesForCompaction()` 使用 `readCompactionGroupKey()` 给每条 `CompactMessage` 找 group key：

| 来源 | group key |
| --- | --- |
| source metadata 有 `modelCallStepSeq` | `step:${modelCallStepSeq}` |
| source kind 是 `user_input` | `user:${source.id}` |
| source kind 是 `compact_summary` | `summary:${source.id}` |
| source 有 `runId` | `run:${runId}:${kind}:${id}` |
| 其他 | `message:${id}` |

相邻消息 key 不同就切新组。

这个设计让 compact 不只是按单条消息截断，而是尽量按用户输入、模型调用步骤、run 产物等语义组来保留最近上下文。

### compact artifact

compact 成功后会写入两条 system message。

`compact_boundary`：

```ts
{
  role: "system",
  content: "Conversation compacted",
  metadata: {
    runtimeKind: "compact_boundary",
    source: "engine",
    eligibleForModelContext: false,
    extra: {
      compactedBy: "auto" | "manual",
      contextWindowTokens,
      compactThresholdTokens,
      estimatedInputTokens,
      estimatedPostCompactTokens,
      summarizedMessageCount,
      configuredRecentGroupCount,
      keepRecentGroupCount,
      compactThroughMessageId
    }
  }
}
```

`compact_summary`：

```ts
{
  role: "system",
  content: summaryText,
  metadata: {
    runtimeKind: "compact_summary",
    source: "engine",
    compactBoundaryId: boundaryMessage.id,
    summaryForBoundaryId: boundaryMessage.id,
    eligibleForModelContext: true,
    extra: {
      compactedBy: "auto" | "manual",
      contextWindowTokens,
      compactThresholdTokens,
      estimatedInputTokens,
      estimatedPostCompactTokens,
      summarizedMessageCount,
      configuredRecentGroupCount,
      keepRecentGroupCount,
      compactThroughMessageId
    }
  }
}
```

后续 `projectToModel()` 会通过 `summaryForBoundaryId` 或 `compactBoundaryId` 找到这个 summary，并用它承接被裁剪的旧历史。

## `projectToDebug()`

`projectToDebug()` 基本保留所有 `EngineMessage`，并把重要状态写进 projection metadata：

| EngineMessage 状态 | Debug metadata |
| --- | --- |
| `eligibleForModelContext === false` | `hiddenFromModel: true` |
| `visibleInTranscript === false` | `hiddenFromTranscript: true` |
| `compactedAt` 存在 | `compacted: true` |

它不做：

- compact boundary 裁剪
- tool result truncation
- runtime reminder injection
- transcript visibility filtering

适合回答：

- 这条消息为什么没进模型？
- 这条消息为什么 transcript 不显示？
- 哪些 tool result 已经被 compact？
- projection 前完整 runtime 消息长什么样？

## 对比表

| 行为 | Transcript | Model | Compact | Debug |
| --- | --- | --- | --- | --- |
| 输入 | `EngineMessage[]` | `EngineMessage[]` | `EngineMessage[]` | `EngineMessage[]` |
| 应用 compact boundary | 否 | 默认是 | 默认是 | 否 |
| 过滤 `visibleInTranscript === false` | 是 | 否 | 否 | 否 |
| 过滤 `eligibleForModelContext === false` | 否 | 是 | 是 | 否 |
| 隐藏 `compact_boundary` | 否，除非 transcript metadata 隐藏 | 是 | 是 | 否 |
| 使用 `compact_summary` 承接旧上下文 | 否 | 是 | 是 | 否 |
| tool result compact stub | 否 | 是 | 是 | 否 |
| tool result soft limit | 否 | 可选 | compact service 中启用 4000 chars | 否 |
| reasoning 过滤 | 否 | 可选 | 可选，当前 compact service 启用 | 否 |
| tool result 过滤 | 否 | 可选 | 可选，当前 compact service 启用 | 否 |
| runtime reminder 注入 | 否 | 可选 | 强制关闭 | 否 |
| diagnostics hidden ids | transcript-hidden ids | model-hidden ids | 继承 model | 空 |
| diagnostics truncated ids | 空 | stub/truncated ids | 继承 model | 空 |

