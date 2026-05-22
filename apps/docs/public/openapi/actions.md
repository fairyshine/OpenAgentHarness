# Action Module

Action 既可由 LLM 在对话中触发，也可由用户或外部系统通过 API 直接触发。

## 接口

### `POST /workspaces/{workspaceId}/actions/{actionName}/runs`

触发 action run。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 否 | 挂接到现有 session |
| `agentName` | 否 | 绑定 agent 上下文 |
| `input` | 否 | 按 ACTION.yaml `input_schema` 定义 |

返回（`202`）：`runId`、`status=queued`、`actionName`、`sessionId`。

### 示例

```bash
curl -X POST http://127.0.0.1:8787/api/v1/workspaces/ws_abc/actions/test.run/runs \
  -H "Content-Type: application/json" \
  -d '{"input": {"watch": false}}'
```

```json
{"runId": "run_789", "status": "queued", "actionName": "test.run", "sessionId": "ses_auto_created"}
```

### 获取结果

- **轮询：** `GET /runs/{runId}` 直到终态
- **流式：** `GET /sessions/{sessionId}/events` 监听 SSE
- **步骤：** `GET /runs/{runId}/steps`

## 设计说明

- 统一落入 run 模型，复用审计和事件流
- 未提供 `sessionId` 时自动创建临时 session
- `input` 按 `input_schema` 做 JSON Schema 校验
- 仅 `expose.callable_by_api: true` 的 action 可通过此接口触发
