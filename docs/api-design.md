# API Design

本文件只说明 API 层的边界和约束。具体接口定义以 [openapi/openapi.yaml](./openapi/openapi.yaml) 和 `docs/openapi/` 目录下的模块文档为准。

## 接口形态

- HTTP REST API
- SSE 流式事件

## 资源分组

- workspaces
- models
- catalog
- sessions
- messages
- runs
- actions
- events

## 约束

- 对外 HTTP API 位于 `/api/v1`
- 内部脚本模型网关位于 `/internal/v1/models/*`
- 当前 `createApp()` 已支持宿主注入 caller context resolver
- 若宿主显式提供 resolver，则由宿主负责提供 caller context
- 若未提供 resolver，独立 server 会为本地调试流量注入最小 caller context
- 生产接入应由上游网关或外部服务完成认证鉴权，再向运行时透传 caller context
- `workspaceAccess = []` 等授权决策不在 OAH 内部实现
- `/internal/v1/models/*` 是本地通道接口，不面向外部客户端，也不要求 `Authorization` 请求头
- 发送 message 和触发 action run 使用异步语义
- 异步执行入口返回 `202`
- 流式结果通过 SSE 获取
- 最终状态以 run 查询结果和终态事件为准

## API 层职责

- 对接外部认证与访问控制结果
- 校验并消费上游传入的 caller context
- 在宿主应用中校验调用方对 workspace 的访问权限
- 参数校验
- 创建 message / run
- 查询状态
- 管理 SSE 连接

执行、调度、上下文构建和 tool dispatch 由运行时层负责。

## 文档导航

- [openapi/openapi.yaml](./openapi/openapi.yaml)
  - 单文件 OpenAPI 3.1 草案
- [openapi/overview.md](./openapi/overview.md)
  - 总体约束和接口形态
- [openapi/workspaces.md](./openapi/workspaces.md)
  - workspace 与 catalog
- [openapi/models.md](./openapi/models.md)
  - 模型网关
- [openapi/sessions.md](./openapi/sessions.md)
  - session 与 message
- [openapi/runs.md](./openapi/runs.md)
  - run 查询与取消
- [openapi/actions.md](./openapi/actions.md)
  - action 手动触发
- [openapi/streaming.md](./openapi/streaming.md)
  - SSE 事件流
- [openapi/components.md](./openapi/components.md)
  - 通用 schema、参数与错误模型
