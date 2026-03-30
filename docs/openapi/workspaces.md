# Workspace Module

## 范围

该模块包括：

- workspace 创建
- workspace 查询
- workspace catalog 查询

## 接口

### `POST /workspaces`

用途：

- 创建一个 workspace 记录
- 绑定项目根目录

请求体核心字段：

- `name`
- `rootPath`
- `executionPolicy`

### `GET /workspaces/{workspaceId}`

用途：

- 读取 workspace 元数据

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

## 设计说明

- catalog 是“发现结果”，不是原始配置文件回显
- catalog 便于客户端快速展示当前 workspace 可用能力
- catalog 中只返回元数据，不返回完整 YAML 内容
- agent 元数据应包含来源标记，便于区分 `platform` 与 `workspace`
- model 元数据中的每一项都对应一个具体模型入口
- model 元数据中的 `provider` 字段对齐 AI SDK provider 标识
- workspace 默认 agent 来自 `.openharness/settings.yaml` 的发现结果，而不是 `POST /workspaces` 请求体
