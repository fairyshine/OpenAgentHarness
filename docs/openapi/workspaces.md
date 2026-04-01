# Workspace Module

## 范围

该模块包括：

- workspace 创建
- workspace 查询
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
- `mcpServers`
- `skills`

说明：

- `project` workspace 可通过该接口显式创建
- 未传 `rootPath` 时，服务端默认在 `server.paths.workspace_dir/<normalized-name>` 下创建目录
- 创建顺序必须是：先从 `template_dir` 复制模板，再叠加用户传入的 `AGENTS.md`、MCP 和 skills
- `chat` workspace 更适合由服务端按目录自动发现，不要求调用方逐个创建

### `GET /workspaces/{workspaceId}`

用途：

- 读取 workspace 元数据

返回建议包含：

- `kind`
- `readOnly`
- `historyMirrorEnabled`

### `GET /workspaces/{workspaceId}/catalog`

用途：

- 返回 workspace 中自动发现的能力清单

返回内容包括：

- agents
- models
- actions
- skills
- mcp
- hooks
- nativeTools

对于 `kind=chat` workspace：

- `actions`、`skills`、`mcp`、`hooks`、`nativeTools` 均返回空列表
- `readOnly=true`
- `historyMirrorEnabled=false`

## 设计说明

- catalog 是“发现结果”，不是原始配置文件回显
- catalog 便于客户端快速展示当前 workspace 可用能力
- catalog 中只返回元数据，不返回完整 YAML 内容
- agent 元数据应包含来源标记，便于区分 `platform` 与 `workspace`
- model 元数据中的每一项都对应一个具体模型入口
- model 元数据中的 `provider` 字段对齐 AI SDK provider 标识
- workspace 默认 agent 来自 `.openharness/settings.yaml` 的发现结果，而不是 `POST /workspaces` 请求体
- 服务端配置文件可通过 `paths.chat_dir` 指定一个“对话模式目录”，其下每个直接子目录自动发现为只读 `chat` workspace
