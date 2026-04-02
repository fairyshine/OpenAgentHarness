# Storage Design

## 1. 存储目标

系统需要同时满足：

- 可靠持久化
- 高并发调度
- 审计与追踪
- SSE 的实时事件支撑
- workspace 历史记录的本地留存与可迁移备份

因此采用三层存储职责划分：

- PostgreSQL 作为系统事实库
- Redis 作为运行时状态、队列和锁的辅助层
- `.openharness/data/history.db` 作为 workspace 历史镜像库

## 2. 边界说明

本系统不维护用户、组织、成员关系和认证凭证。

这些信息由外部服务管理，运行时只在需要时持久化最小化的外部主体引用，例如：

- `subject_ref`
- `auth_context`
- `external_ref`

## 3. 存储职责总览

### 3.1 PostgreSQL

PostgreSQL 存放必须可靠落盘、可查询、可审计的数据，并作为唯一事实源。

### 3.2 Redis

Redis 负责高频、短生命周期、性能敏感的数据，不承载不可恢复的业务真相。

### 3.3 Workspace History Mirror

每个 workspace 下保留一个本地历史镜像文件：

- 路径：`.openharness/data/history.db`
- 形态：SQLite
- 角色：异步镜像、备份、副本、便携导出入口

它的边界必须明确：

- 不参与在线事务主路径
- 不是中心库的并列主库
- 不接受来自 runtime 的反向写入
- 不承担队列、锁、调度或权限判断职责

## 4. PostgreSQL 职责

PostgreSQL 存放以下核心实体：

- workspace
- session
- message
- run
- run_step
- tool_call
- action_run
- hook_run
- artifact
- history_event

其中前九类用于在线查询与审计，`history_event` 用于驱动 workspace 本地历史镜像同步。

### 当前实现备注

- `done` 当前主链路已经稳定落到 `workspace`、`session`、`message`、`run`、`run_step`、`tool_call`
- `done` hook 审计已落地，但并不意味着已经引入独立的一等 `hook_run` 资源接口
- `partial` `history_event` / 本地镜像链路已存在，worker 启动恢复也已有保守闭环，但自动续跑仍在后续范围
- `done` `heartbeat_at` 已进入当前 run 持久化模型
- `done` `parent_run_id` 已进入当前 run 持久化模型
- `missing` `action_run` 尚未作为近期一等实体收口
- `missing` `artifact` 尚未作为近期一等实体收口
- `partial` 基于 `heartbeat_at` 的恢复流程已支持 stale run fail-closed 回收，但尚未支持自动重新入队

## 5. 建议表结构

### 5.1 workspace

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

### 5.2 session

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

### 5.3 message

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

### 5.4 run

字段：

- `id`
- `workspace_id`
- `session_id`
- `parent_run_id`
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
- `parent_run_id` 用于记录 subagent/background run 关系，当前已作为一等字段落库

### 5.5 run_step

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

索引建议：

- `(run_id, seq)`

### 5.6 tool_call

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

索引建议：

- `(run_id, started_at)`
- `(source_type, tool_name, started_at desc)`

说明：

- `source_type` 可取 `native`、`action`、`skill`、`tool`

### 5.7 action_run

当前状态：`planned`

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

### 5.8 hook_run

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

### 5.9 artifact

当前状态：`planned`

字段：

- `id`
- `run_id`
- `type`
- `path`
- `content_ref`
- `metadata jsonb`
- `created_at`

### 5.10 history_event

用途：

- 为 `.openharness/data/history.db` 提供统一的增量同步事件流
- 避免镜像同步直接扫描多张业务表

字段：

- `id`
- `workspace_id`
- `entity_type`
- `entity_id`
- `op`
- `payload jsonb`
- `occurred_at`

索引建议：

- `(workspace_id, id)`
- `(workspace_id, occurred_at desc)`

说明：

- `id` 必须单调递增，可作为每个 workspace 的同步游标
- `op` 建议支持 `upsert`、`delete`、`replace`
- `payload` 保存镜像库需要写入的结构化行数据
- 业务写入与 `history_event` 追加应放在同一事务中，确保镜像源事件不丢失

## 6. Redis 职责

Redis 负责高频、短生命周期、性能敏感的数据：

- session 队列
- 分布式锁
- 限流计数
- 短期事件缓存
- worker 协调信息

## 7. 建议 Redis Key 设计

### 7.1 Session Queue

- `oah:session:{sessionId}:queue`

用途：

- 存该 session 的待执行 run id 列表

### 7.2 Session Lock

- `oah:session:{sessionId}:lock`

用途：

- 保证同一个 session 同时只有一个 worker 在执行

### 7.3 Global Run Queue

- `oah:runs:ready`

用途：

- 保存准备调度的 run id 或 session id

### 7.4 Event Buffer

- `oah:session:{sessionId}:events`

用途：

- 短期缓存最近事件，便于 SSE 重连恢复

### 7.5 Rate Limit

- `oah:workspace:{workspaceId}:rate`
- `oah:subject:{subjectRef}:rate`

### 7.6 Concurrency

- `oah:workspace:{workspaceId}:active_runs`
- `oah:subject:{subjectRef}:active_runs`

## 8. Workspace History Mirror 设计

### 8.1 目标

`.openharness/data/history.db` 用于提供：

- workspace 内的本地历史备份
- 脱离中心服务时的离线检视能力
- 项目目录级迁移、归档、打包时的历史随行副本

范围约束：

- 该镜像机制默认面向 `kind=project` workspace
- `kind=chat` workspace 不在本地目录内保存历史数据库

### 8.2 核心原则

- 中心 PostgreSQL 是唯一事实源
- 本地 SQLite 是单向镜像，不是主库
- 镜像同步允许短暂延迟，采用最终一致
- 镜像失败不得阻塞在线请求
- 镜像库损坏后可以完全重建

### 8.3 路径与所有权

- 路径固定为 `.openharness/data/history.db`
- `.openharness/data/` 由 runtime 托管
- 运行时可自动创建该目录和数据库文件
- 调用方可读取此库，但不应由业务逻辑直接写入
- `kind=chat` workspace 不创建该目录和数据库文件

### 8.4 建议镜像范围

建议镜像以下表的 workspace 子集：

- `session`
- `message`
- `run`
- `run_step`
- `tool_call`
- `action_run`
- `hook_run`
- `artifact`

额外维护本地同步状态表：

- `mirror_state`

`mirror_state` 建议字段：

- `workspace_id`
- `last_event_id`
- `last_synced_at`
- `status`
- `error_message`

说明：

- 本地镜像不必完整复制中心库中的 `workspace` 主表
- 若需要便捷展示，可在本地额外放一个轻量 `workspace_meta` 快照表

## 9. 同步模型

### 9.1 写入路径

在线请求路径只写中心库：

1. runtime 将业务记录写入 PostgreSQL
2. 同一事务内追加 `history_event`
3. 事务提交后，由异步 syncer 消费增量事件
4. syncer 将变更幂等写入 `.openharness/data/history.db`
5. 更新本地 `mirror_state.last_event_id`

### 9.2 同步粒度

建议以 `workspace_id + history_event.id` 为最小同步游标。

这样有几个好处：

- 不需要分别维护多张表的游标
- 支持 append 和 update 混合场景
- 支持未来的 delete / redact 事件
- 重试时更容易做到幂等

### 9.3 同步语义

- 默认批量拉取，如每批 100 到 1000 条事件
- 本地写入采用 upsert
- 事件重复投递时必须安全重放
- `delete` 或 `replace` 事件由 syncer 显式处理

## 10. 持久化与缓存的边界

建议原则：

- PostgreSQL 是最终事实来源
- Redis 中的内容随时可重建
- 本地 `history.db` 也是可重建副本
- 不要只在 Redis 或本地镜像中保存关键业务状态

例如：

- `run.status` 必须落 PostgreSQL
- `session 当前是否被 worker 占有` 可以只存在 Redis
- `history.db` 中的 `run` 记录只能视为中心库的延迟副本

## 11. 恢复与重建策略

### 11.1 Worker 恢复

worker 启动后，需执行恢复流程：

1. 扫描 PostgreSQL 中长时间 `running` 且无 heartbeat 的 run
2. 根据恢复策略标记为 `failed` 或重新入队
3. 清理失效 Redis lock
4. 重建必要的 ready queue

### 11.2 Mirror 恢复

镜像同步器恢复时：

1. 读取 `.openharness/data/history.db` 中的 `mirror_state.last_event_id`
2. 从 PostgreSQL `history_event` 继续拉取后续事件
3. 若本地文件缺失，则从头回放该 workspace 的事件流
4. 若本地文件损坏，可删除后全量重建

### 11.3 故障影响

- PostgreSQL 不可用：在线请求受影响
- Redis 不可用：调度与实时能力受影响，但理论上可恢复
- `history.db` 或 syncer 故障：不影响主请求执行，只影响本地镜像新鲜度

补充说明：

- `kind=chat` workspace 不涉及本地镜像故障域，其会话历史仅存在中心库

## 12. 审计策略

至少记录以下审计内容：

- 哪个外部调用主体在什么 workspace 触发了 run
- 使用了哪个 agent
- run 中途是否切换过 agent、切换到了谁
- 是否调用了 subagent、对应子 run 是什么
- 调用了哪些 tool
- tool 来源类型是什么
- 何时失败、何时取消、何时超时
- Hook 对请求做了哪些改写
- 历史镜像当前是否落后、最近同步到哪个事件

## 13. 日志与可观测性

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
- `history_event_id`
- `mirror_last_event_id`
- `status`
- `duration_ms`
- `request_id`

并预留接入 tracing 的空间，例如 OpenTelemetry。
