# Storage Design

## 1. 存储目标与分层

系统需要可靠持久化、高并发调度、审计追踪、SSE 实时事件和 workspace 本地运行时数据留存。采用三层存储：

| 层 | 职责 |
|----|------|
| **PostgreSQL** | 系统事实库，可靠落盘、可查询、可审计 |
| **Redis** | 运行时状态、队列、锁、限流，不承载不可恢复的业务真相 |
| **SQLite** (`history.db`) | workspace 本地运行时数据、观测与恢复辅助 |

未配置 PostgreSQL 时，运行时数据直接落到每个 workspace 自己的 `history.db`。

### AI SDK 对齐原则

- `messages` 表直接对应 AI SDK message 结构
- `run_steps` 中的 `model_call` 直接保存 AI SDK 风格的模型请求/响应快照
- OAH 自有结构（`run` / `tool_calls` / `hook_runs` / `session_events`）承担运行控制与审计
- 写库时尽量以模型链路需要的格式持久化，避免调用前临时转换

### 身份边界

系统不维护用户、组织或认证凭证。只持久化最小化外部引用：`subject_ref` / `auth_context` / `external_ref`。

## 2. 真值分层

### A. 会话真值层

核心表：`messages`

- 保存 session 的长期对话历史，作为继续对话时最接近 AI SDK `messages` 的事实来源
- `role` 与 AI SDK 兼容，`content` 直接保存为 AI SDK 兼容内容
- `tool-call` / `tool-result` 通过 message parts 持久化，不拆散到额外字段

### B. 模型调用快照层

核心表：`run_steps` 中的 `model_call`

- 保存发给模型的 prompt/messages 快照和对应返回（toolCalls / toolResults / usage / provider metadata）
- 能直接回答"这次到底给 LLM 发了什么"

### C. 审计与运维层

核心表：`runs` / `tool_calls` / `hook_runs` / `session_events` / `history_events` / `artifacts`

- 记录运行状态、工具执行、hook 行为、事件流与恢复辅助数据
- 不反向定义会话消息语义

## 3. PostgreSQL 表结构

### workspace

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `external_ref` | text | 外部系统引用 |
| `name` | text | |
| `root_path` | text | |
| `execution_policy` | text | |
| `status` | text | |
| `metadata` | jsonb | |
| `created_at` / `updated_at` | timestamp | |

索引：`(root_path)`, `(external_ref)`, `(status, updated_at desc)`

### session

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `workspace_id` | fk | |
| `subject_ref` | text | 外部主体引用 |
| `agent_name` | text | 创建时绑定的 agent |
| `active_agent_name` | text | 当前 primary agent |
| `title` | text | |
| `status` | text | |
| `last_run_at` | timestamp | |
| `auth_context` | jsonb | |
| `created_at` / `updated_at` | timestamp | |

索引：`(workspace_id, created_at desc)`, `(subject_ref, created_at desc)`, `(status, updated_at desc)`

### message

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `session_id` | fk | |
| `run_id` | fk | 可为空 |
| `role` | text | `user` / `assistant` / `tool` / `system` |
| `content` | jsonb | AI SDK 兼容：纯文本或 parts 数组 |
| `metadata` | jsonb | |
| `created_at` | timestamp | |

索引：`(session_id, created_at)`, `(run_id, created_at)`

assistant 的 tool call 与 tool result 都通过 content parts 持久化，不单独维护 `tool_name` / `tool_call_id` 列。

### run

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `workspace_id` / `session_id` | fk | session_id 可为空（独立 action run） |
| `parent_run_id` | fk | subagent / background run |
| `trigger_type` | text | `message` / `manual_action` / `api_action` / `hook` / `system` |
| `trigger_ref` / `initiator_ref` | text | |
| `agent_name` / `effective_agent_name` | text | 初始 agent / 当前生效 agent |
| `switch_count` | int | agent 切换计数 |
| `status` | text | |
| `cancel_requested_at` | timestamp | |
| `started_at` / `ended_at` / `heartbeat_at` | timestamp | |
| `error_code` / `error_message` | text | |
| `metadata` | jsonb | |
| `created_at` | timestamp | |

索引：`(session_id, created_at desc)`, `(workspace_id, created_at desc)`, `(initiator_ref, created_at desc)`, `(status, heartbeat_at)`

### run_step

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `run_id` | fk | |
| `seq` | int | 步骤序号 |
| `step_type` | text | |
| `name` / `agent_name` | text | |
| `status` | text | |
| `input` / `output` | jsonb | `model_call` 时按 AI SDK 语义组织（见下文） |
| `started_at` / `ended_at` | timestamp | |

索引：`(run_id, seq)`

`model_call` 的 input/output 结构：

- `input.request` -- AI SDK request 快照（`model` / `canonicalModelRef` / `provider` / `temperature` / `maxTokens` / `messages`）
- `input.runtime` -- OAH 补充信息（`messageCount` / `activeToolNames` / `engineTools` / `toolServers`）
- `output.response` -- AI SDK response 快照（`text` / `content` / `reasoning` / `toolCalls` / `toolResults` / `usage` / `finishReason` / `providerMetadata`）
- `output.runtime` -- OAH 统计信息（`toolCallsCount` / `toolResultsCount`）

### tool_call

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `run_id` / `step_id` | fk | |
| `source_type` | text | `native` / `action` / `skill` / `tool` |
| `tool_name` | text | |
| `request` / `response` | jsonb | |
| `status` | text | |
| `duration_ms` | int | |
| `started_at` / `ended_at` | timestamp | |

索引：`(run_id, started_at)`, `(source_type, tool_name, started_at desc)`

### hook_run

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `run_id` | fk | |
| `hook_name` / `event_name` | text | |
| `capabilities` / `patch` | jsonb | |
| `status` | text | |
| `started_at` / `ended_at` | timestamp | |
| `error_message` | text | |

### action_run (planned)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `run_id` | fk | |
| `action_name` / `caller_type` | text | |
| `input` / `output` | jsonb | |
| `status` | text | |
| `started_at` / `ended_at` | timestamp | |

### artifact (planned)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | pk | |
| `run_id` | fk | |
| `type` / `path` / `content_ref` | text | |
| `metadata` | jsonb | |
| `created_at` | timestamp | |

### history_event

用于保存 workspace 级别的变更历史，服务于审计、迁移和后续离线处理。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 单调递增事件序号 |
| `workspace_id` | fk | |
| `entity_type` / `entity_id` | text | |
| `op` | text | `upsert` / `delete` / `replace` |
| `payload` | jsonb | 事件对应的结构化快照 |
| `occurred_at` | timestamp | |

索引：`(workspace_id, id)`, `(workspace_id, occurred_at desc)`

业务写入与 `history_event` 追加放在同一事务中，确保审计事件和中心事实源一致。

## 4. Redis 职责

Redis 负责高频、短生命周期、性能敏感的数据，内容随时可重建。

### Key 设计

| Key | 用途 |
|-----|------|
| `oah:session:{sessionId}:queue` | session 待执行 run id 列表 |
| `oah:session:{sessionId}:lock` | 保证同 session 同时只有一个 worker 执行 |
| `oah:runs:ready` | 全局就绪 run 调度队列 |
| `oah:session:{sessionId}:events` | 短期事件缓存，SSE 重连恢复 |
| `oah:workspace:{workspaceId}:rate` | workspace 限流 |
| `oah:subject:{subjectRef}:rate` | 主体限流 |
| `oah:workspace:{workspaceId}:active_runs` | workspace 并发控制 |
| `oah:subject:{subjectRef}:active_runs` | 主体并发控制 |

## 5. Workspace Local SQLite

### 目标

`.openharness/data/history.db` 提供 workspace 本地运行时数据文件，可用于本机观测、恢复辅助和目录级迁移时的随行数据。

- 仅对 `kind=project` workspace 生效
- 所有 workspace 的本地运行时数据统一落在 `.openharness/data/history.db`
- SQLite 主存储模式下，不再维护额外的只读对话专用 shadow 目录语义

### 核心原则

- 配置 PostgreSQL 时，PostgreSQL 是事实源
- 未配置 PostgreSQL 时，workspace 本地 SQLite 直接承担主存储
- 本地 SQLite 不再承担跨进程 history mirror sync
- 本地 SQLite 故障不应阻塞中心存储与在线调度

### 使用边界

- `history.db` 是当前执行节点的本地数据文件
- 它可以承载本地 SQLite 主存储，或作为 project workspace 的本地状态文件
- 多 worker / 多 Pod 场景下，不依赖它做跨实例同步

## 6. 恢复策略

### Worker 恢复

1. 扫描 PostgreSQL 中长时间 `running` 且无 heartbeat 的 run
2. 根据策略标记为 `failed` 或重新入队
3. 清理失效 Redis lock
4. 重建 ready queue

### 本地 SQLite 恢复

1. 检测本地 `history.db` 是否存在且可打开
2. 若损坏，仅影响当前节点本地数据；中心事实源仍在 PostgreSQL
3. 需要时由当前节点重新初始化本地文件

### 故障影响

| 故障 | 影响 |
|------|------|
| PostgreSQL 不可用 | 在线请求受影响 |
| Redis 不可用 | 调度与实时能力受影响，可恢复 |
| `history.db` 故障 | 不影响主请求，只影响当前节点本地状态 |

## 7. 审计与可观测性

至少记录：谁在哪个 workspace 触发了 run、使用了哪个 agent、是否切换 agent、是否调用 subagent、调用了哪些 tool（来源类型）、失败/取消/超时时间、hook 改写内容。

建议结构化日志字段：`subject_ref` / `workspace_id` / `session_id` / `run_id` / `agent_name` / `effective_agent_name` / `parent_run_id` / `tool_call_id` / `action_name` / `hook_name` / `history_event_id` / `status` / `duration_ms` / `request_id`。

预留 OpenTelemetry tracing 接入空间。
