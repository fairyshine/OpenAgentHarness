# API 参考

HTTP API 基于 REST 资源接口 + SSE 事件流。接口定义以 [openapi.yaml](./openapi.yaml) 为准。

## 统一约束

- 对外 API：`/api/v1`
- 内部模型网关：`/internal/v1/models/*`（仅 loopback，无需 `Authorization`）
- 宿主应用可注入 caller context resolver 接管认证；未注入时使用最小 caller context
- 异步入口（发消息、触发 action）返回 `202`
- 流式输出走 SSE
- 最终执行状态以 run 资源为准

关键边界：`session` = 上下文边界，`run` = 执行边界，同 session 内 run 串行。

## 端点速查

### Workspaces

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/workspace-templates` | 列出模板 |
| GET | `/workspaces` | 列出 workspace |
| POST | `/workspaces` | 创建 workspace |
| POST | `/workspaces/import` | 导入 workspace |
| GET | `/workspaces/{id}` | 获取详情 |
| DELETE | `/workspaces/{id}` | 删除 |
| GET | `/workspaces/{id}/catalog` | 获取能力目录 |

### Sandboxes & Files

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/sandboxes` | 创建或解析 sandbox |
| GET | `/sandboxes/{id}` | 获取 sandbox 元数据 |
| GET | `/sandboxes/{id}/files/entries` | 列出目录条目 |
| GET | `/sandboxes/{id}/files/stat` | 读取文件/目录元数据 |
| DELETE | `/sandboxes/{id}/files/entry` | 删除条目 |
| PATCH | `/sandboxes/{id}/files/move` | 移动/重命名 |
| GET | `/sandboxes/{id}/files/content` | 读取文件 |
| PUT | `/sandboxes/{id}/files/content` | 写入文件 |
| PUT | `/sandboxes/{id}/files/upload` | 上传二进制 |
| GET | `/sandboxes/{id}/files/download` | 下载文件 |
| POST | `/sandboxes/{id}/directories` | 创建目录 |

### Commands

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/sandboxes/{id}/commands/foreground` | 前台执行 shell command |
| POST | `/sandboxes/{id}/commands/process` | 结构化执行 process |
| POST | `/sandboxes/{id}/commands/background` | 启动后台命令 |

### Sessions & Messages

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/workspaces/{id}/sessions` | 列出 session |
| POST | `/workspaces/{id}/sessions` | 创建 session |
| GET | `/sessions/{id}` | 获取详情 |
| GET | `/sessions/{id}/messages` | 列出消息 |
| POST | `/sessions/{id}/messages` | 发送消息（202） |
| GET | `/sessions/{id}/events` | SSE 事件流 |

### Runs

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/runs/{id}` | 获取详情 |
| GET | `/runs/{id}/steps` | 列出步骤 |
| POST | `/runs/{id}/cancel` | 取消（202） |

### Actions

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/workspaces/{id}/actions/{name}/runs` | 触发 action（202） |

### Models (Internal)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/model-providers` | 列出 provider |
| POST | `/internal/v1/models/generate` | 同步生成 |
| POST | `/internal/v1/models/stream` | 流式生成 |

## 模块文档

| 文档 | 内容 |
| --- | --- |
| [openapi.yaml](./openapi.yaml) | OpenAPI 3.1 规范 |
| [workspaces.md](./workspaces.md) | workspace、catalog、模型可见性 |
| [sessions.md](./sessions.md) | session 与 message |
| [runs.md](./runs.md) | run 查询与取消 |
| [actions.md](./actions.md) | action 手动触发 |
| [files.md](./files.md) | sandbox 文件与命令接口 |
| [models.md](./models.md) | 模型网关 |
| [streaming.md](./streaming.md) | SSE 事件流 |
| [components.md](./components.md) | 通用 schema 与错误模型 |

接口定义以 [openapi.yaml](./openapi.yaml) 为准。发消息 + 消费流式结果建议配合看 [sessions](./sessions.md)、[runs](./runs.md)、[streaming](./streaming.md)。
