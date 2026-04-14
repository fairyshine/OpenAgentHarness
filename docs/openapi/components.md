# Components

## 通用 Schema

### Workspace

`id`、`externalRef`、`name`、`rootPath`、`executionPolicy`、`status`、`kind`、`readOnly`、`createdAt`、`updatedAt`

### WorkspaceImportRequest

`rootPath`、`kind`、`name`、`externalRef`

### WorkspaceEntry

`path`、`name`、`type`（file / directory）、`sizeBytes`、`mimeType`、`etag`、`updatedAt`、`createdAt`、`readOnly`

### WorkspaceEntryPage

`workspaceId`、`path`、`items[]`、`nextCursor` — 目录直接子项分页

### WorkspaceFileContent

`workspaceId`、`path`、`encoding`、`content`、`truncated`、`sizeBytes`、`mimeType`、`etag`、`updatedAt`、`readOnly`

### WorkspaceDeleteResult

`workspaceId`、`path`、`type`、`deleted`

### PutWorkspaceFileRequest

`path`、`content`、`encoding`、`overwrite`、`ifMatch`（配合 etag 乐观并发）

### MoveWorkspaceEntryRequest

`sourcePath`、`targetPath`、`overwrite`

### Run

`id`、`workspaceId`、`sessionId`、`parentRunId`、`initiatorRef`、`triggerType`、`triggerRef`、`agentName`、`effectiveAgentName`、`switchCount`、`status`、`cancelRequestedAt`、`startedAt`、`heartbeatAt`、`endedAt`、`createdAt`、`errorCode`、`errorMessage`、`metadata`

### ActionCatalogItem

`name`、`description`、`exposeToLlm`、`callableByUser`、`callableByApi`、`retryPolicy`（`safe` = 可安全重试，`manual` = 人工重试）

### ModelProvider

`id`、`packageName`、`description`、`requiresUrl`、`useCases`

## 模型网关对象

### ChatMessage

Role-aware 消息结构（对齐 AI SDK `ModelMessage` JSON-safe 表示）：

| role | content |
| --- | --- |
| `system` | 字符串 |
| `user` | 字符串，或 `text / image / file` parts |
| `assistant` | 字符串，或 `text / file / reasoning / tool-call / tool-result / tool-approval-request` parts |
| `tool` | `tool-result / tool-approval-response` parts 数组 |

### MessagePart 类型

| type | 关键字段 |
| --- | --- |
| `text` | `text` |
| `image` | `image`、`mediaType` |
| `file` | `data`、`mediaType`、`filename` |
| `reasoning` | `text` |
| `tool-call` | `toolCallId`、`toolName`、`input`、`providerExecuted` |
| `tool-result` | `toolCallId`、`toolName`、`output` |
| `tool-approval-request` | `approvalId`、`toolCallId` |
| `tool-approval-response` | `approvalId`、`approved`、`reason` |

### ToolResultOutput

| type | 字段 |
| --- | --- |
| `text` | `value: string` |
| `json` | `value: JSONValue` |
| `execution-denied` | `reason?: string` |
| `error-text` | `value: string` |
| `error-json` | `value: JSONValue` |
| `content` | `value: [...]`（AI SDK content-style） |

### Usage

`inputTokens`、`outputTokens`、`totalTokens`

### ModelGenerateRequest / ModelStreamRequest

`model`、`prompt`、`messages`、`temperature`、`maxTokens`（`prompt` 与 `messages` 至少一个）

### ModelGenerateResponse

`model`、`text`、`finishReason`、`usage`

## 通用参数

`workspaceId`、`sessionId`、`runId`、`actionName`、`pageSize`、`cursor`、`path`、`sortBy`、`sortOrder`、`recursive`、`encoding`、`maxBytes`

## 错误模型

```json
{"error": {"code": "ACTION_NOT_FOUND", "message": "Action code.review was not found", "details": {}}}
```

错误码：`WORKSPACE_NOT_FOUND`、`SESSION_NOT_FOUND`、`RUN_NOT_FOUND`、`AGENT_NOT_FOUND`、`ACTION_NOT_FOUND`、`SKILL_NOT_FOUND`、`MCP_NOT_FOUND`、`HOOK_NOT_FOUND`、`INVALID_CONFIGURATION`、`RUN_CONFLICT`、`RUN_CANCELLED`、`TOOL_TIMEOUT`、`POLICY_DENIED`、`AGENT_SWITCH_DENIED`、`SUBAGENT_DENIED`、`MODEL_NOT_FOUND`、`MODEL_GATEWAY_DISABLED`、`MODEL_GATEWAY_LOCAL_ONLY`
