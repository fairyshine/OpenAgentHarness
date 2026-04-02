# Workspace Module

## 范围

该模块包括：

- workspace 创建
- workspace 导入
- workspace 查询
- workspace 删除
- workspace catalog 查询
- 只读对话 workspace 批量发现结果

## 接口

### `GET /workspace-templates`

用途：

- 列出 `server.paths.template_dir` 下当前可用的 workspace 模板

返回内容：

- `items[].name`

### `POST /workspaces`

用途：

- 创建一个 workspace 记录
- 绑定项目根目录

请求体核心字段：

- `name`
- `template`
- `executionPolicy`

可选覆盖字段：

- `rootPath`
- `agentsMd`
- `toolServers`
- `skills`

说明：

- `project` workspace 可通过该接口显式创建
- 未传 `rootPath` 时，服务端默认在 `server.paths.workspace_dir/<normalized-name>` 下创建目录
- 创建顺序必须是：先从 `template_dir` 复制模板，再叠加用户传入的 `AGENTS.md`、workspace tools 和 skills
- `chat` workspace 更适合由服务端按目录自动发现，不要求调用方逐个创建
- `paths.chat_dir` 下的目录本身就是可直接使用的只读 workspace，而不是需要再复制一次的模板实例

### `POST /workspaces/import`

用途：

- 将一个已经存在的目录注册为 workspace
- 复用服务端的发现逻辑，而不是从模板创建

请求体核心字段：

- `rootPath`

可选字段：

- `kind`
- `name`
- `externalRef`

说明：

- `kind` 默认为 `project`
- 该接口不会复制模板，只会读取现有目录内容并写入中心 workspace 记录
- 适合把已有 repo 或只读 chat 目录纳入运行时管理

### `GET /workspaces`

用途：

- 分页读取当前可见的 workspace 列表

查询参数：

- `pageSize`
- `cursor`

返回：

- `items[]`
- `nextCursor`

说明：

- 返回结果按创建顺序稳定分页
- `nextCursor` 为空时表示已经到末页

### `GET /workspaces/{workspaceId}`

用途：

- 读取 workspace 元数据

返回建议包含：

- `kind`
- `readOnly`
- `historyMirrorEnabled`

### `DELETE /workspaces/{workspaceId}`

用途：

- 删除 workspace 中心记录
- 对受管 `project` workspace，可额外清理服务端管理目录中的实际文件夹

说明：

- `chat` workspace 主要删除中心记录
- 是否同步删除目录，取决于该 workspace 是否位于服务端受管的 `paths.workspace_dir` 下

### `PATCH /workspaces/{workspaceId}/settings`

用途：

- 更新 workspace 级运行时设置

当前支持：

- `historyMirrorEnabled`

说明：

- 服务端会将开关回写到 `.openharness/settings.yaml`
- `kind=chat` workspace 不支持开启本地 history mirror

### `GET /workspaces/{workspaceId}/history-mirror`

用途：

- 读取当前 workspace 的本地 history mirror 状态

返回建议包含：

- `supported`
- `enabled`
- `state`
- `lastEventId`
- `lastSyncedAt`
- `dbPath`
- `errorMessage`

### `POST /workspaces/{workspaceId}/history-mirror/rebuild`

用途：

- 删除并重建当前 workspace 的本地 `history.db` 镜像

说明：

- 仅 `kind=project` 且 `historyMirrorEnabled=true` 时可用
- 该操作只影响本地镜像，不影响 PostgreSQL 中心事实源
- 返回重建后的最新 mirror 状态

### `GET /workspaces/{workspaceId}/catalog`

用途：

- 返回 workspace 中自动发现的能力清单

返回内容包括：

- agents
- models
- actions
- skills
- tools
- hooks
- nativeTools

对于 `kind=chat` workspace：

- `actions`、`skills`、`tools`、`hooks`、`nativeTools` 均返回空列表
- `readOnly=true`
- `historyMirrorEnabled=false`

## 设计说明

- catalog 是“发现结果”，不是原始配置文件回显
- catalog 便于客户端快速展示当前 workspace 可用能力
- catalog 中只返回元数据，不返回完整 YAML 内容
- action 元数据当前可带 `retryPolicy`，用于表达是否适合作为未来自动恢复的候选项
- agent 元数据应包含来源标记，便于区分 `platform` 与 `workspace`
- model 元数据中的每一项都对应一个具体模型入口
- model 元数据中的 `provider` 字段对齐 AI SDK provider 标识
- workspace 默认 agent 来自 `.openharness/settings.yaml` 的发现结果，而不是 `POST /workspaces` 请求体
- 服务端配置文件可通过 `paths.chat_dir` 指定一个“对话模式目录”，其下每个直接子目录自动发现为只读 `chat` workspace
- 这些目录既可以被当作预置对话模式来管理，也会直接作为可进入的 workspace 暴露给调用方
