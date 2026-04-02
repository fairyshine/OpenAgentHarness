# Model Gateway

## 目标

让 workspace 内的 action、本地脚本和命令行程序可以方便调用服务端预设的大模型，而不需要自己管理 provider SDK 或 API Key。

设计目标：

- 复用服务端 `paths.model_dir` 中的平台模型
- 支持 `curl` 直接调用
- 支持一个简单 CLI 调用
- 与 `vercel/ai` 的 AI SDK 兼容
- 保持统一审计与限流

## 核心思路

不要让 action 脚本直接拿平台 provider 配置去调用第三方模型。

推荐做法是：

1. 服务端统一加载平台模型目录
2. 服务端通过 AI SDK 根据服务端模型名解析出实际模型
3. 脚本通过 OpenAgentHarness 的内部模型网关接口请求模型生成
4. 服务端返回文本结果或流式结果

这样带来的好处：

- 脚本不需要知道 OpenAI、OpenRouter 或其他 provider 的差异
- 平台密钥不需要暴露给 workspace 脚本
- 审计记录统一落在 OpenAgentHarness 内
- 可以对 action / script 调模型做统一限流

## 调用形态

建议支持两种调用形态：

- `curl`
- `oah model` CLI

两者最终都调用同一个内部模型网关接口。

## HTTP 接口

建议提供两类接口：

- `POST /internal/v1/models/generate`
- `POST /internal/v1/models/stream`

用途：

- `generate`
  - 返回一次性完整结果
- `stream`
  - 返回 SSE 流式结果

请求核心字段：

- `model`
- `messages` 或 `prompt`
- `temperature`
- `maxTokens`

规则：

- `model` 直接取服务端模型名，例如 `openai-default`
- 仅允许访问服务端 `paths.model_dir` 中已注册的平台模型
- 若未传 `model`，则优先使用当前运行时注入的默认模型名
- 该接口是内部接口，不要求 token 认证
- 不对外暴露到公网入口

## 内部暴露方式

为了支持免鉴权调用，模型网关只通过本地通道暴露。

当前实现：

- `done` `127.0.0.1` / `::1` loopback HTTP
- `missing` Unix Domain Socket

因此当前的真值边界是：

- 不挂在公开 API Gateway 入口下
- 不依赖外部 `Authorization` 请求头鉴权
- 仅供本机 action、脚本和 CLI 调用
- 若请求不来自 loopback 地址，服务端直接拒绝

后续仍可继续收敛为 Unix Socket，但那不是当前默认实现。

长期原则：

- 不挂在公开 API Gateway 入口下
- 不依赖外部 `Authorization` 请求头鉴权
- 仅供本机 action、脚本和 CLI 调用
- 如果未来切到 Unix Socket，主要收益会是：

- 不需要额外 token
- 不会直接暴露给远程客户端
- `curl` 和 CLI 都容易支持

## CLI 设计

建议提供一个轻量 CLI：

- `oah model generate`
- `oah model stream`

示例：

```bash
oah model generate \
  --model "$OPENHARNESS_DEFAULT_MODEL" \
  --prompt "Summarize the repository"
```

```bash
oah model stream \
  --model "openai-default" \
  --message user:"Explain this changelog"
```

CLI 行为：

- 读取运行时注入的环境变量
- 调用 OpenAgentHarness 模型网关接口
- 将结果直接输出到 stdout

## curl 设计

### 一次性生成

```bash
curl -sS \
  -X POST "http://127.0.0.1:8787/internal/v1/models/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$OPENHARNESS_DEFAULT_MODEL"'",
    "prompt": "Summarize the repository"
  }'
```

### 流式生成

```bash
curl -N \
  -X POST "http://127.0.0.1:8787/internal/v1/models/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$OPENHARNESS_DEFAULT_MODEL"'",
    "messages": [
      { "role": "user", "content": "Summarize the repository" }
    ]
  }'
```

## 运行时环境变量注入

当前实现里，action 执行环境已经稳定注入的变量主要是：

- `OPENHARNESS_DEFAULT_MODEL`
- `OPENHARNESS_WORKSPACE_ROOT`
- `OPENHARNESS_RUN_ID`
- `OPENHARNESS_ACTION_NAME`

说明：

- `OPENHARNESS_DEFAULT_MODEL`
  - 当前默认服务端模型名
- `OPENHARNESS_WORKSPACE_ROOT`
  - 当前 workspace 根目录
- `OPENHARNESS_RUN_ID`
  - 当前 action 所属 run id

当前还没有自动注入模型网关地址变量；action / 脚本若要调用内部模型网关，仍需由宿主侧约定 loopback 地址，或后续再补专用环境变量。

## 模型选择规则

内部模型网关只面向服务端预设模型。

因此：

- 请求参数直接使用 `model`
- 值直接是服务端模型名，例如 `openai-default`
- 不再要求脚本传 `platform/...` 形式的 `modelRef`
- 也不支持从这个接口直接访问 workspace 私有模型

## 与 AI SDK 的关系

AI SDK 主要放在服务端使用。

服务端内部流程建议为：

1. 根据 `model` 从 `paths.model_dir` 中解析服务端模型入口
2. 将模型入口转换成 AI SDK 的 language model
3. 调用：
   - `generateText`
   - `streamText`
4. 将结果包装为统一 HTTP 返回

内部可以实现一个类似接口：

```ts
export interface ModelGateway {
  generate(req: ModelGenerateRequest, ctx: ModelGatewayContext): Promise<ModelGenerateResult>
  stream(req: ModelStreamRequest, ctx: ModelGatewayContext): Promise<ReadableStream>
}
```

## action 中的典型使用方式

### shell action

```yaml
name: review.summary
description: Summarize the current repository

expose:
  to_llm: true
  callable_by_user: true

entry:
  type: shell
  command: |
    curl -sS \
      --unix-socket "$OPENHARNESS_MODEL_SOCKET" \
      -X POST "http://localhost/internal/v1/models/generate" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$OPENHARNESS_DEFAULT_MODEL\",\"prompt\":\"Summarize the repository\"}"
```

### js action

```ts
const res = await fetch('http://localhost/internal/v1/models/generate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: process.env.OPENHARNESS_DEFAULT_MODEL,
    prompt: 'Summarize the repository',
  }),
});
```

## 边界

- `chat` workspace 不支持 action，因此不会用到这套脚本调用模型能力
- `project` workspace 的 action / script 可以调用这套能力
- 该能力主要面向脚本与工具，不替代 session/run 主对话接口

## 审计

模型网关调用建议单独记录：

- `workspace_id`
- `run_id`
- `subject_ref`
- `model`
- `caller_type`
- `duration_ms`
- `status`

`caller_type` 建议支持：

- `session`
- `action`
- `hook`
- `script`
