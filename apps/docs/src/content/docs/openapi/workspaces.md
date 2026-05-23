---
title: "Workspace Module"
---

# Workspace Module

## 接口

### `GET /runtimes`

列出 `server.paths.runtime_dir` 下可用 workspace runtime。返回 `items[].name`。新客户端应优先使用统一资产接口 `GET /assets/runtimes`。

### `POST /runtimes/upload`

兼容接口：上传一个 `.zip` 包作为新的 workspace runtime。新客户端应使用 `POST /assets/runtimes/upload`。请求参数：

- Query: `name`、`overwrite`
- Body: `application/octet-stream`

### `PUT /runtimes/{runtimeName}`

兼容接口：覆盖更新一个已有 workspace runtime。新客户端应使用 `PUT /assets/runtimes/{name}`。Body: `application/octet-stream`。该接口要求目标 runtime 已存在。

### `DELETE /runtimes/{runtimeName}`

兼容接口：删除一个已有 runtime。新客户端应使用 `DELETE /assets/runtimes/{name}`。

### Legacy runtime aliases

`/blueprints`、`/blueprints/upload`、`/blueprints/{runtimeName}` 是 runtime API rename 期间保留的兼容别名，行为分别等同于 `/runtimes`、`/runtimes/upload`、`/runtimes/{runtimeName}`。新客户端应使用 `/assets/runtimes*`。

### `POST /workspaces`

创建 workspace 并绑定项目目录。

请求字段：`name`、`runtime`、`executionPolicy`。可选：`rootPath`、`ownerId`、`serviceName`、`agentsMd`、`toolServers`、`skills`。

- `ownerId`：用于 sandbox 亲和调度，让同 owner 的 workspace 尽量落到同一 sandbox；未提供时进入 ownerless 共享池，并按 sandbox CPU / memory / disk 负载决定复用已有 sandbox 还是使用预留空 sandbox
- `serviceName`：用于服务级 PostgreSQL 路由；未传时全部数据都落在 `postgres_url` 指向的默认库，传入后 workspace/session/run 的索引会保留在默认库，业务真值会路由到同前缀的派生库（例如基础库为 `OAH` 时，`serviceName=acme` 会落到 `OAH-acme`）

未传 `rootPath` 时默认在 `paths.workspace_dir/<normalized-name>` 下创建。创建顺序：先复制 runtime，再叠加用户配置。

### `POST /workspaces/import`

将已有目录注册为 workspace，不复制 runtime 内容。

请求字段：`rootPath`。可选：`kind`（默认 `project`）、`name`、`externalRef`、`ownerId`、`serviceName`。

`serviceName` 设计为 workspace 级归属字段，创建后不建议变更。

### `POST /local/workspaces/register`

OAP personal local daemon 专用接口。将本机已有目录注册为 workspace，必要时可通过 `runtime` 在目录没有 `.openharness/` 时 bootstrap OAS 配置。

请求字段：`rootPath`。可选：`name`、`runtime`、`ownerId`、`serviceName`。

### `POST /local/workspaces/{workspaceId}/repair`

OAP personal local daemon 专用接口。repo 移动或重命名后，用新的 `rootPath` 重新绑定已有 workspace id，避免创建新的 workspace 历史。

请求字段：`rootPath`。可选：`name`。修复后记录的 `externalRef` 更新为 `local:path:<resolved-path>`，原 workspace id 保持不变。

### `GET /workspaces`

分页读取 workspace 列表。参数：`pageSize`、`cursor`。返回 `items[]`、`nextCursor`。

### `GET /workspaces/{workspaceId}`

读取元数据，包含 `kind`、`readOnly`、`executionPolicy`、`status`。

### `DELETE /workspaces/{workspaceId}`

删除中心记录。split / self-hosted 部署下会先路由到 owner worker 清理 live `Active Workspace Copy`，再删除中心记录；受管目录（`paths.workspace_dir` 下）和运行时 shadow 状态也会一并清理。

### `GET /workspaces/{workspaceId}/catalog`

返回自动发现的能力清单：agents、models、actions、skills、tools、hooks、nativeTools。

`kind` 当前固定为 `project`，catalog 由 workspace 自身声明决定。

### Workspace Memory API

以下接口只在当前 server 支持 workspace memory 且 workspace owner 可达时可用：

- `GET /workspaces/{workspaceId}/memory/status`：读取 memory 根目录、索引、文件数量、待处理 proposal 等状态
- `GET /workspaces/{workspaceId}/memory`：列出 memory index
- `GET /workspaces/{workspaceId}/memory/search`：搜索 memory。参数：`query`、`corpus`（`all / index / topics / sessions / daily / dreams`）、`maxResults`
- `GET /workspaces/{workspaceId}/memory/read`：读取 memory 文件片段。参数：`path`、`from`、`lines`
- `GET /workspaces/{workspaceId}/memory/proposals`：列出待确认的 memory proposals
- `POST /workspaces/{workspaceId}/memory/proposals/apply`：应用 proposal。请求体：`path`
- `POST /workspaces/{workspaceId}/memory/proposals/reject`：拒绝 proposal。请求体：`path`、可选 `reason`

### Workspace-Scoped File API

这些接口用于 local / owner worker 可达场景下直接操作 workspace 文件，与 sandbox 文件 API 的请求字段保持一致：

- `GET /workspaces/{workspaceId}/entries`
- `GET /workspaces/{workspaceId}/files/content`
- `PUT /workspaces/{workspaceId}/files/content`
- `PUT /workspaces/{workspaceId}/files/upload`
- `GET /workspaces/{workspaceId}/files/download`
- `POST /workspaces/{workspaceId}/directories`
- `DELETE /workspaces/{workspaceId}/entries`
- `PATCH /workspaces/{workspaceId}/entries/move`

## 与 Sandbox API 的关系

- `/workspaces` 负责 workspace 的创建、导入、删除、catalog 和元数据
- `/sandboxes` 负责活跃执行副本的文件、目录和命令操作
- 当你需要“这个项目有哪些能力、属于谁、当前状态是什么”时，用 workspace API
- 当你需要“当前执行副本里有哪些文件、执行一个命令、读取一个路径”时，用 sandbox API

这里刻意保持和 [E2B](https://github.com/e2b-dev/E2B) 一致的分层语义: `/workspaces` 表示项目身份与目录，`/sandboxes` 表示执行副本，副本内根路径统一暴露为 `/workspace`。这不是过渡期命名。`/workspaces` API 仍然需要保留，但职责限定在 metadata、catalog 和 lifecycle；文件接口不建议重新并回 `/workspaces`。

## 设计说明

- catalog 是发现结果，不是配置回显，只返回元数据
- agent 元数据含来源标记（`platform` / `workspace`）
- model 元数据每项对应具体入口，`provider` 对齐 AI SDK provider 标识
