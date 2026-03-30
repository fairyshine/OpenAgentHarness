# Events And Audit

## 事件流

### SSE 适用场景

- 浏览器或轻量客户端监听 session/run 输出
- 实现简单，适合单向流式推送

### 建议事件类型

- `run.queued`
- `run.started`
- `run.progress`
- `message.delta`
- `agent.switch.requested`
- `agent.switched`
- `agent.delegate.started`
- `agent.delegate.completed`
- `agent.delegate.failed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `run.completed`
- `run.failed`
- `run.cancelled`

## 结构化日志与审计

所有关键节点都需要产生日志和审计记录：

- API 请求入口
- run 状态变更
- model call
- tool call
- action run
- hook run
- backend shell 执行

日志中至少要包含：

- `subject_ref`
- `workspace_id`
- `session_id`
- `run_id`
- `agent_name`
- `effective_agent_name`
- `tool_name`
- `duration_ms`
- `status`
