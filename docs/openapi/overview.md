# OpenAPI Overview

## 接口形态

- REST 资源接口
- SSE 事件流接口

## 资源分组

- Workspace
- Model Gateway
- Catalog
- Session
- Message
- Run
- Action
- Event Stream

## 统一约束

- 对外 API 位于 `/api/v1`
- 内部脚本模型网关位于 `/internal/v1/models/*`
- 宿主应用可通过 server 注入 caller context resolver 来接管该上下文
- 若未注入 resolver，独立 server 会自动使用最小 caller context 以便本地调试
- `/internal/v1/models/*` 不要求 `Authorization` 请求头，且当前只允许 loopback 访问
- 异步执行入口返回 `202`
- 流式输出统一走 SSE
- 最终执行状态以 run 资源为准

## 关键边界

- `session` 是上下文边界
- `run` 是执行边界
- 同一个 session 内 run 串行
- action 可独立触发，也可挂在 session 下触发
