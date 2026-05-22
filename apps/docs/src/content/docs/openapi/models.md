---
title: "Model Runtime Module"
---

# Model Runtime Module

面向 workspace action、脚本和 `oah model` CLI 的内部模型调用接口。

## 接口

### `GET /model-providers`

返回已支持的 provider 类型。字段：`id`、`packageName`、`description`、`requiresUrl`、`useCases`。

### `GET /platform-models`

列出平台已发现的模型入口。返回 `items[]`，每项包含 provider、model id、显示名、能力与发现来源等元数据。

### `POST /platform-models/refresh`

同步刷新当前 API server 可见的 platform model snapshot。

内部 worker / loopback 场景也可调用 `POST /internal/v1/platform-models/refresh`，语义相同。

### `POST /platform-models/refresh/distributed`

触发分布式 platform model 刷新，适用于有多个 worker / placement 的部署。

### `GET /platform-models/events`

订阅 platform model snapshot 的 SSE 更新。连接建立后先发送 `platform-models.snapshot`，之后模型列表变化时发送 `platform-models.updated`。

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
