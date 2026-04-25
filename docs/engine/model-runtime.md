# Model Runtime

## 目标

让 workspace 内的 action、脚本和 CLI 可以调用服务端预设模型，无需管理 provider SDK 或 API Key。

设计目标：复用 `paths.model_dir` 平台模型、支持 curl 和 CLI 调用、与 AI SDK 兼容、统一审计与限流。

## 核心思路

脚本不直接调用第三方模型 provider。服务端统一加载模型目录 → 通过 AI SDK 解析模型 → 脚本通过内部模型运行时请求 → 服务端返回结果。

收益：脚本无需关心 provider 差异、密钥不暴露、审计统一、可限流。

## HTTP 接口

| 接口 | 用途 |
| --- | --- |
| `POST /internal/v1/models/generate` | 一次性完整结果 |
| `POST /internal/v1/models/stream` | SSE 流式结果 |

请求核心字段：`model`、`messages` 或 `prompt`、`temperature`、`maxTokens`。

规则：

- `model` 为服务端模型名（如 `openai-default`），仅允许已注册平台模型
- 未传 `model` 时使用运行时默认模型
- 内部接口，不要求 token 认证，不对外暴露

## 暴露方式

当前通过 `127.0.0.1` / `::1` loopback HTTP 暴露，非 loopback 请求直接拒绝。后续可收敛为 Unix Domain Socket。

## CLI

```bash
oah model generate --model "$OPENHARNESS_DEFAULT_MODEL" --prompt "Summarize the repository"
oah model stream --model "openai-default" --message user:"Explain this changelog"
```

CLI 读取运行时环境变量，调用内部模型运行时，输出到 stdout。

## curl 示例

### 一次性生成

```bash
curl -sS -X POST "http://127.0.0.1:8787/internal/v1/models/generate" \
  -H "Content-Type: application/json" \
  -d '{"model": "'"$OPENHARNESS_DEFAULT_MODEL"'", "prompt": "Summarize the repository"}'
```

### 流式生成

```bash
curl -N -X POST "http://127.0.0.1:8787/internal/v1/models/stream" \
  -H "Content-Type: application/json" \
  -d '{"model": "'"$OPENHARNESS_DEFAULT_MODEL"'",
       "messages": [{"role": "user", "content": "Summarize the repository"}]}'
```

### 带工具结果

```json
{
  "model": "openai-default",
  "messages": [
    { "role": "user", "content": "Run the tool" },
    { "role": "assistant", "content": [
        { "type": "tool-call", "toolCallId": "call_1", "toolName": "Bash", "input": { "command": "pwd" } }
    ]},
    { "role": "tool", "content": [
        { "type": "tool-result", "toolCallId": "call_1", "toolName": "Bash",
          "output": { "type": "text", "value": "/tmp/demo" } }
    ]}
  ]
}
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENHARNESS_DEFAULT_MODEL` | 当前默认服务端模型名 |
| `OPENHARNESS_WORKSPACE_ROOT` | 当前 workspace 根目录 |
| `OPENHARNESS_RUN_ID` | 当前 action 所属 run ID |
| `OPENHARNESS_ACTION_NAME` | 当前 action 名称 |

模型运行时地址变量尚未自动注入，脚本需约定 loopback 地址。

## 服务端内部流程

```ts
export interface ModelRuntime {
  generate(req: ModelGenerateRequest, ctx: ModelRuntimeContext): Promise<ModelGenerateResult>
  stream(req: ModelStreamRequest, ctx: ModelRuntimeContext): Promise<ReadableStream>
}
```

1. 从 `paths.model_dir` 解析模型入口
2. 转换为 AI SDK language model
3. 调用 `generateText` / `streamText`
4. 包装为统一 HTTP 返回

## Action 使用示例

### Shell action

```yaml
name: review.summary
entry:
  type: shell
  command: |
    curl -sS --unix-socket "$OPENHARNESS_MODEL_SOCKET" \
      -X POST "http://localhost/internal/v1/models/generate" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$OPENHARNESS_DEFAULT_MODEL\",\"prompt\":\"Summarize the repository\"}"
```

### JS action

```ts
const res = await fetch('http://localhost/internal/v1/models/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: process.env.OPENHARNESS_DEFAULT_MODEL, prompt: 'Summarize the repository' }),
});
```

## 边界

- 所有 workspace 都可按配置暴露 action，此能力由运行时统一处理
- `project` workspace 的 action/script 可调用
- 面向脚本与工具，不替代 session/run 主对话接口

## 审计

每次调用记录：`workspace_id`、`run_id`、`subject_ref`、`model`、`caller_type`（session / action / hook / script）、`duration_ms`、`status`。
