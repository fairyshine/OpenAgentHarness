---
title: "API 参考"
---

# API 参考

HTTP API 基于 REST 资源接口 + SSE 事件流。接口定义以 [openapi.yaml](./openapi.yaml) 为准。

## 统一约束

- 对外 API：`/api/v1`
- 内部模型运行时：`/internal/v1/models/*`（仅 loopback，无需 `Authorization`）
- 宿主应用可注入 caller context resolver 接管认证；未注入时使用最小 caller context
- 异步入口（发消息、触发 action）返回 `202`
- 流式输出走 SSE
- 最终执行状态以 run 资源为准
- session 发消息默认不会打断当前活跃 run；只有显式传 `runningRunBehavior: "interrupt"` 才会先取消当前 run
- session 后续消息队列是服务端资源；可通过 `GET /sessions/{id}/queue` 读取，并通过 `POST /runs/{id}/guide` 将已排队消息提升为打断模式

关键边界：`session` = 上下文边界，`run` = 执行边界，同 session 内 run 串行。

文件与命令接口刻意保持 [E2B](https://github.com/e2b-dev/E2B) 风格的 sandbox 语义: 路由位于 `/sandboxes`，sandbox 内根目录暴露为 `/workspace`。这是稳定接口约定，不是临时兼容层。`/workspaces` API 仍然保留，用于 workspace metadata、catalog 与 lifecycle。

## 端点速查

### Workspaces

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/workspaces` | 列出 workspace |
| POST | `/workspaces` | 创建 workspace |
| POST | `/workspaces/import` | 导入 workspace |
| POST | `/local/workspaces/register` | 注册本机 workspace 路径 |
| POST | `/local/workspaces/{id}/repair` | 修复本机 workspace 路径绑定 |
| GET | `/workspaces/{id}` | 获取详情 |
| DELETE | `/workspaces/{id}` | 删除 |
| GET | `/workspaces/{id}/catalog` | 获取能力目录 |
| GET | `/workspaces/{id}/memory/status` | 获取 workspace memory 状态 |
| GET | `/workspaces/{id}/memory` | 列出 workspace memory index |
| GET | `/workspaces/{id}/memory/search` | 搜索 workspace memory |
| GET | `/workspaces/{id}/memory/read` | 读取 workspace memory 文件片段 |
| GET | `/workspaces/{id}/memory/proposals` | 列出 memory proposals |
| POST | `/workspaces/{id}/memory/proposals/apply` | 应用 memory proposal |
| POST | `/workspaces/{id}/memory/proposals/reject` | 拒绝 memory proposal |

### Assets

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/assets/runtimes` | 列出 runtime 资产 |
| POST | `/assets/runtimes/upload` | 上传 runtime zip |
| PUT | `/assets/runtimes/{name}` | 覆盖更新 runtime |
| DELETE | `/assets/runtimes/{name}` | 删除 runtime |
| GET | `/assets/models` | 列出平台 model 资产 |
| POST | `/assets/models/upload` | 上传平台 model YAML |
| PUT | `/assets/models/{name}` | 覆盖更新平台 model |
| DELETE | `/assets/models/{name}` | 删除平台 model |
| GET | `/assets/tools` | 列出平台 tool 资产 |
| POST | `/assets/tools/upload` | 上传平台 tool 定义 |
| PUT | `/assets/tools/{name}` | 覆盖更新平台 tool |
| DELETE | `/assets/tools/{name}` | 删除平台 tool |
| GET | `/assets/skills` | 列出平台 skill 资产 |
| POST | `/assets/skills/upload` | 上传平台 skill |
| PUT | `/assets/skills/{name}` | 覆盖更新平台 skill |
| DELETE | `/assets/skills/{name}` | 删除平台 skill |

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
| GET | `/sessions/{id}/snapshot` | 获取控制台初始化快照 |
| PATCH | `/sessions/{id}` | 更新会话设置 |
| DELETE | `/sessions/{id}` | 删除会话 |
| GET | `/sessions/{id}/children` | 列出直接子 session / subagent session |
| GET | `/sessions/{id}/messages` | 列出消息 |
| POST | `/sessions/{id}/messages` | 发送消息（202） |
| GET | `/sessions/{id}/messages/{messageId}` | 获取单条消息 |
| GET | `/sessions/{id}/messages/{messageId}/context` | 获取锚点消息上下文 |
| GET | `/sessions/{id}/queue` | 读取服务端后续消息队列 |
| GET | `/sessions/{id}/runs` | 列出当前 session 的 runs |
| GET | `/sessions/{id}/terminals/{terminalId}` | 读取 session terminal 输出 |
| POST | `/sessions/{id}/terminals/{terminalId}/input` | 写入 session terminal 输入 |
| POST | `/sessions/{id}/compact` | 手动 compact |
| GET | `/sessions/{id}/events` | SSE 事件流 |

### Runs

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/runs/{id}` | 获取详情 |
| GET | `/runs/{id}/steps` | 列出步骤 |
| POST | `/runs/{id}/cancel` | 取消（202） |
| POST | `/runs/{id}/guide` | 将已排队消息提升为引导（202） |
| POST | `/runs/{id}/requeue` | 手动重新入队 recovery run |
| POST | `/runs/requeue` | 批量重新入队 recovery runs |

### Actions

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/workspaces/{id}/actions/{name}/runs` | 触发 action（202） |

### Models (Internal)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/model-providers` | 列出 provider |
| GET | `/platform-models` | 列出平台模型 |
| POST | `/platform-models/refresh` | 刷新平台模型 |
| POST | `/platform-models/refresh/distributed` | 分布式刷新平台模型 |
| GET | `/platform-models/events` | 平台模型 SSE 更新 |
| POST | `/internal/v1/models/generate` | 同步生成 |
| POST | `/internal/v1/models/stream` | 流式生成 |

### Storage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/storage/overview` | 存储总览 |
| GET | `/storage/postgres/tables/{table}` | 检查 PostgreSQL 表 |
| GET | `/storage/redis/keys` | 扫描 Redis keys |
| GET | `/storage/redis/key` | 读取 Redis key |
| DELETE | `/storage/redis/key` | 删除 Redis key |
| POST | `/storage/redis/keys/delete` | 批量删除 Redis keys |
| GET | `/storage/redis/worker-affinity` | 检查 worker affinity |
| GET | `/storage/redis/workspace-placements` | 列出 workspace placements |
| POST | `/storage/redis/session-queue/clear` | 清理 session queue |
| POST | `/storage/redis/session-lock/release` | 释放 session lock |

## 模块文档

| 文档 | 内容 |
| --- | --- |
| [openapi.yaml](./openapi.yaml) | OpenAPI 3.1 规范 |
| [workspaces.md](./workspaces/) | workspace、catalog、模型可见性 |
| [assets.md](./assets/) | 平台 runtime、model、tool、skill 资产管理 |
| [sessions.md](./sessions/) | session 与 message |
| [runs.md](./runs/) | run 查询与取消 |
| [actions.md](./actions/) | action 手动触发 |
| [files.md](./files/) | sandbox 文件与命令接口 |
| [storage.md](./storage/) | 存储检查与维护接口 |
| [models.md](./models/) | 模型运行时 |
| [streaming.md](./streaming/) | SSE 事件流 |
| [components.md](./components/) | 通用 schema 与错误模型 |

接口定义以 [openapi.yaml](./openapi.yaml) 为准。发消息 + 消费流式结果建议配合看 [sessions](./sessions/)、[runs](./runs/)、[streaming](./streaming/)。
