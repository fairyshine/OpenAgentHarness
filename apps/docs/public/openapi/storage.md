# Storage Inspection Module

Storage inspection APIs are operator-facing endpoints for debugging the backing PostgreSQL / Redis state. They are only available when the server profile advertises storage inspection support.

## 接口

### `GET /storage/overview`

读取 PostgreSQL / Redis 总览。可选参数：`serviceName`。

### `GET /storage/postgres/tables/{table}`

分页读取允许检查的 PostgreSQL 表。参数：

- `limit`、`offset`、`cursor`
- `serviceName`
- `q`、`searchMode=full_row`
- `includeRowCount`
- `workspaceId`、`sessionId`、`runId`
- `status`、`errorCode`、`recoveryState`

支持的 `table`：`workspaces`、`sessions`、`runs`、`messages`、`run_steps`、`session_events`、`session_current_state`、`tool_calls`、`hook_runs`、`artifacts`、`history_events`、`archives`。

### `GET /storage/redis/keys`

扫描 Redis keys。参数：`pattern`、`cursor`、`pageSize`。

### `GET /storage/redis/key`

读取单个 Redis key。参数：`key`。

### `DELETE /storage/redis/key`

删除单个 Redis key。参数：`key`。

### `POST /storage/redis/keys/delete`

批量删除 Redis keys。请求体：`keys`。

### `GET /storage/redis/worker-affinity`

检查 worker affinity 计算结果。参数：`sessionId`、`workspaceId`、`ownerId`、`ownerWorkerId`。

### `GET /storage/redis/workspace-placements`

列出 workspace placement 状态。参数：`workspaceId`、`ownerId`、`ownerWorkerId`、`state`。

### `POST /storage/redis/session-queue/clear`

维护接口：清理指定 session queue key。请求体：`key`。

### `POST /storage/redis/session-lock/release`

维护接口：释放指定 session lock key。请求体：`key`。
