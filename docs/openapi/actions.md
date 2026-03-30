# Action Module

## 范围

该模块包括手动触发 action run 的接口。

## 接口

### `POST /workspaces/{workspaceId}/actions/{actionName}/runs`

用途：

- 在指定 workspace 中直接触发某个 action

请求字段：

- `sessionId`
  - 可选
  - 如果提供，则将 action run 挂接到现有 session
- `agentName`
  - 可选
  - 用于将本次 action run 绑定到某个 agent 上下文，便于审计和后续会话衔接
- `input`
  - action 输入对象

返回：

- `runId`
- `status=queued`
- `actionName`
- `sessionId`

## 设计说明

- action 既可由 LLM 触发，也可由用户/API 直接触发
- 手动触发 action 仍统一落入 run 模型，便于审计和事件流复用
