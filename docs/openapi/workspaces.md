# Workspace Module

## 接口

### `GET /workspace-templates`

列出 `server.paths.template_dir` 下可用模板。返回 `items[].name`。

### `POST /workspaces`

创建 workspace 并绑定项目目录。

请求字段：`name`、`template`、`executionPolicy`。可选：`rootPath`、`agentsMd`、`toolServers`、`skills`。

未传 `rootPath` 时默认在 `paths.workspace_dir/<normalized-name>` 下创建。创建顺序：先复制模板，再叠加用户配置。`chat` workspace 由服务端按目录自动发现。

### `POST /workspaces/import`

将已有目录注册为 workspace，不复制模板。

请求字段：`rootPath`。可选：`kind`（默认 `project`）、`name`、`externalRef`。

### `GET /workspaces`

分页读取 workspace 列表。参数：`pageSize`、`cursor`。返回 `items[]`、`nextCursor`。

### `GET /workspaces/{workspaceId}`

读取元数据，包含 `kind`、`readOnly`、`executionPolicy`、`status`。

### `DELETE /workspaces/{workspaceId}`

删除中心记录。受管目录（`paths.workspace_dir` 下）可额外清理文件夹。

### `GET /workspaces/{workspaceId}/catalog`

返回自动发现的能力清单：agents、models、actions、skills、tools、hooks、nativeTools。

`kind=chat` 时 actions/skills/tools/hooks/nativeTools 均为空。

## 设计说明

- catalog 是发现结果，不是配置回显，只返回元数据
- agent 元数据含来源标记（`platform` / `workspace`）
- model 元数据每项对应具体入口，`provider` 对齐 AI SDK provider 标识
- `paths.chat_dir` 下子目录自动发现为只读 `chat` workspace
