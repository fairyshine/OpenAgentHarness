# Model Runtime Module

面向 workspace action、脚本和 `oah model` CLI 的内部模型调用接口。

## 接口

### `GET /model-providers`

返回已支持的 provider 类型。字段：`id`、`packageName`、`description`、`requiresUrl`、`useCases`。

### `POST /internal/v1/models/generate`

一次性生成。请求：`model`、`prompt`、`messages`、`temperature`、`maxTokens`。返回：`model`、`text`、`finishReason`、`usage`。

```json
// 请求
{"model": "openai-default", "prompt": "Summarize the repository"}
// 响应
{"model": "openai-default", "text": "This repository implements ...", "finishReason": "stop",
 "usage": {"inputTokens": 120, "outputTokens": 48, "totalTokens": 168}}
```

### `POST /internal/v1/models/stream`

流式生成，返回 `text/event-stream`。事件：`response.started`、`text.delta`、`response.completed`、`response.failed`。

```text
event: response.started
data: {"model":"openai-default"}

event: text.delta
data: {"delta":"This repository "}

event: response.completed
data: {"model":"openai-default","finishReason":"stop"}
```

## 设计说明

- 模型运行时，不是 session 对话接口，不维护对话历史
- 仅面向服务端预设模型，使用服务端模型名（如 `openai-default`）
- 内部 loopback 接口，无需 token 认证，后续可收敛为 Unix Socket
- `messages` 按 AI SDK `ModelMessage[]` 校验后转 provider 请求
