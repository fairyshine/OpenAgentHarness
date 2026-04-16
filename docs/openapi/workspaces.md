# Workspace Module

## 接口

### `GET /blueprints`

列出 `server.paths.blueprint_dir` 下可用 workspace blueprint。返回 `items[].name`。

### `POST /blueprints/upload`

上传一个 `.zip` 包作为新的 workspace blueprint，请求参数：

- Query: `name`、`overwrite`
- Body: `application/octet-stream`

### `DELETE /blueprints/{blueprintName}`

删除一个已有 blueprint。

### `POST /workspaces`

创建 workspace 并绑定项目目录。

请求字段：`name`、`blueprint`、`executionPolicy`。可选：`rootPath`、`ownerId`、`serviceName`、`agentsMd`、`toolServers`、`skills`。

- `ownerId`：用于 sandbox pod 亲和调度，让同 owner 的 workspace 尽量落到同一 sandbox pod
- `serviceName`：用于服务级 PostgreSQL 路由；未传时全部数据都落在 `postgres_url` 指向的默认库，传入后 workspace/session/run 的索引会保留在默认库，业务真值会路由到同前缀的派生库（例如基础库为 `OAH` 时，`serviceName=acme` 会落到 `OAH-acme`）

未传 `rootPath` 时默认在 `paths.workspace_dir/<normalized-name>` 下创建。创建顺序：先复制 blueprint，再叠加用户配置。

### `POST /workspaces/import`

将已有目录注册为 workspace，不复制 blueprint 内容。

请求字段：`rootPath`。可选：`kind`（默认 `project`）、`name`、`externalRef`、`ownerId`、`serviceName`。

`serviceName` 设计为 workspace 级归属字段，创建后不建议变更。

### `GET /workspaces`

分页读取 workspace 列表。参数：`pageSize`、`cursor`。返回 `items[]`、`nextCursor`。

### `GET /workspaces/{workspaceId}`

读取元数据，包含 `kind`、`readOnly`、`executionPolicy`、`status`。

### `DELETE /workspaces/{workspaceId}`

删除中心记录。受管目录（`paths.workspace_dir` 下）可额外清理文件夹。

### `GET /workspaces/{workspaceId}/catalog`

返回自动发现的能力清单：agents、models、actions、skills、tools、hooks、nativeTools。

`kind` 当前固定为 `project`，catalog 由 workspace 自身声明决定。

## 设计说明

- catalog 是发现结果，不是配置回显，只返回元数据
- agent 元数据含来源标记（`platform` / `workspace`）
- model 元数据每项对应具体入口，`provider` 对齐 AI SDK provider 标识
