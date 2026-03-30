# Storage Design

## 1. 存储目标

系统需要同时满足：

- 可靠持久化
- 高并发调度
- 审计与追踪
- SSE 的实时事件支撑

因此当前建议采用：

- PostgreSQL 作为系统事实库
- Redis 作为运行时状态、队列和锁的辅助层

## 2. 边界说明

本系统不维护用户、组织、成员关系和认证凭证。

这些信息由外部服务管理，运行时只在需要时持久化最小化的外部主体引用，例如：

- `subject_ref`
- `auth_context`
- `external_ref`

## 3. PostgreSQL 职责

PostgreSQL 存放必须可靠落盘、可查询、可审计的数据：

- workspace
- session
- message
- run
- run_step
- tool_call
- action_run
- hook_run
- artifact

## 4. 建议表结构

### 4.1 workspace

字段：

- `id`
- `external_ref`
- `name`
- `root_path`
- `execution_policy`
- `status`
- `metadata jsonb`
- `created_at`
- `updated_at`

索引建议：

- `(root_path)`
- `(external_ref)`
- `(status, updated_at desc)`

### 4.2 session

字段：

- `id`
- `workspace_id`
- `subject_ref`
- `agent_name`
- `active_agent_name`
- `title`
- `status`
- `last_run_at`
- `auth_context jsonb`
- `created_at`
- `updated_at`

索引建议：

- `(workspace_id, created_at desc)`
- `(subject_ref, created_at desc)`
- `(status, updated_at desc)`

### 4.3 message

字段：

- `id`
- `session_id`
- `run_id`
- `role`
- `content`
- `tool_name`
- `tool_call_id`
- `metadata jsonb`
- `created_at`

索引建议：

- `(session_id, created_at)`
- `(run_id, created_at)`

### 4.4 run

字段：

- `id`
- `workspace_id`
- `session_id`
- `trigger_type`
- `trigger_ref`
- `initiator_ref`
- `agent_name`
- `effective_agent_name`
- `switch_count`
- `status`
- `cancel_requested_at`
- `started_at`
- `ended_at`
- `heartbeat_at`
- `error_code`
- `error_message`
- `metadata jsonb`
- `created_at`

索引建议：

- `(session_id, created_at desc)`
- `(workspace_id, created_at desc)`
- `(initiator_ref, created_at desc)`
- `(status, heartbeat_at)`

说明：

- `session_id` 可为空，用于直接触发且未绑定会话的 action run
- `initiator_ref` 来自外部 caller context
- `effective_agent_name` 用于记录 run 内当前生效的 agent
- `switch_count` 用于审计和策略限制

### 4.5 run_step

字段：

- `id`
- `run_id`
- `seq`
- `step_type`
- `name`
- `agent_name`
- `status`
- `input jsonb`
- `output jsonb`
- `started_at`
- `ended_at`

### 4.6 tool_call

字段：

- `id`
- `run_id`
- `step_id`
- `source_type`
- `tool_name`
- `request jsonb`
- `response jsonb`
- `status`
- `duration_ms`
- `started_at`
- `ended_at`

说明：

- `source_type` 可取 `native`、`action`、`skill`、`mcp`

### 4.7 action_run

字段：

- `id`
- `run_id`
- `action_name`
- `caller_type`
- `input jsonb`
- `output jsonb`
- `status`
- `started_at`
- `ended_at`

### 4.8 hook_run

字段：

- `id`
- `run_id`
- `hook_name`
- `event_name`
- `capabilities jsonb`
- `patch jsonb`
- `status`
- `started_at`
- `ended_at`
- `error_message`

### 4.9 artifact

字段：

- `id`
- `run_id`
- `type`
- `path`
- `content_ref`
- `metadata jsonb`
- `created_at`

## 5. Redis 职责

Redis 负责高频、短生命周期、性能敏感的数据：

- session 队列
- 分布式锁
- 限流计数
- 短期事件缓存
- worker 协调信息

## 6. 建议 Redis Key 设计

### 6.1 Session Queue

- `oah:session:{sessionId}:queue`

用途：

- 存该 session 的待执行 run id 列表

### 6.2 Session Lock

- `oah:session:{sessionId}:lock`

用途：

- 保证同一个 session 同时只有一个 worker 在执行

### 6.3 Global Run Queue

- `oah:runs:ready`

用途：

- 保存准备调度的 run id 或 session id

### 6.4 Event Buffer

- `oah:session:{sessionId}:events`

用途：

- 短期缓存最近事件，便于 SSE 重连恢复

### 6.5 Rate Limit

- `oah:workspace:{workspaceId}:rate`
- `oah:subject:{subjectRef}:rate`

### 6.6 Concurrency

- `oah:workspace:{workspaceId}:active_runs`
- `oah:subject:{subjectRef}:active_runs`

## 7. 持久化与缓存的边界

建议原则：

- PostgreSQL 是最终事实来源
- Redis 中的内容随时可重建
- 不要只在 Redis 中保存关键业务状态

例如：

- `run.status` 必须落 PostgreSQL
- `session 当前是否被 worker 占有` 可以只存在 Redis

## 8. 恢复策略

worker 启动后，需执行恢复流程：

1. 扫描 PostgreSQL 中长时间 `running` 且无 heartbeat 的 run
2. 根据恢复策略标记为 `failed` 或重新入队
3. 清理失效 Redis lock
4. 重建必要的 ready queue

## 9. 审计策略

至少记录以下审计内容：

- 哪个外部调用主体在什么 workspace 触发了 run
- 使用了哪个 agent
- run 中途是否切换过 agent、切换到了谁
- 是否调用了 subagent、对应子 run 是什么
- 调用了哪些 tool
- tool 来源类型是什么
- 何时失败、何时取消、何时超时
- Hook 对请求做了哪些改写

## 10. 日志与可观测性

建议引入结构化日志字段：

- `subject_ref`
- `workspace_id`
- `session_id`
- `run_id`
- `agent_name`
- `effective_agent_name`
- `parent_run_id`
- `tool_call_id`
- `action_name`
- `hook_name`
- `status`
- `duration_ms`
- `request_id`

并预留接入 tracing 的空间，例如 OpenTelemetry。
