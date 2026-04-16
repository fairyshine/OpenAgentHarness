# Hooks

Hook 用于运行时扩展和拦截，不对 LLM 直接暴露。参考 Claude Code hooks 机制设计。

## 目录约定

Hook 声明文件位于 `.openharness/hooks/*.yaml`，每个文件定义一个 hook。

| 路径 | 用途 |
| --- | --- |
| `hooks/*.yaml` | Hook 声明入口（唯一） |
| `hooks/scripts/` | 脚本和代码文件 |
| `hooks/prompts/` | Prompt handler 复用的提示词 |
| `hooks/resources/` | 配置片段、资源文件、测试数据 |

!!! warning

    hooks 在统一 workspace 模型下按声明生效，不再区分额外的只读对话形态。

## Hook YAML 结构

```yaml
name: redact-secrets
events:
  - before_model_call
matcher: "platform/openai-default|workspace/openai-default"

handler:
  type: command
  command: node ./.openharness/hooks/scripts/redact-secrets.js

capabilities:
  - rewrite_model_request
```

### 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | Hook 名称，必须唯一 |
| `events` | 是 | 触发事件列表 |
| `matcher` | 否 | 正则过滤，匹配事件查询值 |
| `handler` | 是 | Handler 定义 |
| `capabilities` | 否 | 可操作对象（如 `rewrite_model_request`、`patch_tool_input`） |

## 事件与 Matcher

### 支持的事件

| 事件 | 触发时机 |
| --- | --- |
| `before_context_build` | System prompt 装配前 |
| `after_context_build` | System prompt 装配后 |
| `before_model_call` | LLM 调用前 |
| `after_model_call` | LLM 响应后 |
| `before_tool_dispatch` | Tool 执行前 |
| `after_tool_dispatch` | Tool 执行后 |
| `run_completed` | Run 成功完成 |
| `run_failed` | Run 执行失败 |

### Matcher 匹配目标

`matcher` 使用正则（不是 glob），匹配目标因事件而异：

| 事件 | 匹配目标 |
| --- | --- |
| `before/after_tool_dispatch` | `tool_name` |
| `before/after_model_call` | `model_ref` |
| `run_completed` / `run_failed` | `trigger_type` |
| `before/after_context_build` | 忽略 matcher |

未声明 `matcher` 时匹配该事件下的所有触发。

## Handler 类型

### `command`

```yaml
handler:
  type: command
  command: python ./.openharness/hooks/scripts/check.py
  cwd: ./
  timeout_seconds: 30
  environment:
    MODE: strict
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | 命令字符串 |
| `cwd` | 否 | 工作目录 |
| `timeout_seconds` | 否 | 执行超时 |
| `environment` | 否 | 追加环境变量 |

### `http`

```yaml
handler:
  type: http
  url: https://example.internal/hooks/check
  method: POST
  timeout_seconds: 10
  headers:
    Authorization: Bearer ${secrets.HOOK_TOKEN}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | HTTP endpoint |
| `method` | 否 | 默认 `POST` |
| `headers` | 否 | 请求头 |
| `timeout_seconds` | 否 | 请求超时 |

### `prompt`

```yaml
handler:
  type: prompt
  prompt:
    file: ./.openharness/hooks/prompts/review.md
  model_ref: platform/openai-default
  timeout_seconds: 20
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 支持 `inline` 或 `file` |
| `model_ref` | 否 | Hook 使用的模型入口 |
| `timeout_seconds` | 否 | 执行超时 |

### `agent`

```yaml
handler:
  type: agent
  agent: policy-reviewer
  task:
    inline: |-
      Inspect the invocation and return a structured decision.
  timeout_seconds: 30
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `agent` | 是 | 执行 hook 的 agent 名称 |
| `task` | 是 | 支持 `inline` 或 `file` |
| `timeout_seconds` | 否 | 执行超时 |

## I/O 协议

### 输入

所有 handler 接收同一份 JSON envelope。

**公共字段：**

| 字段 | 说明 |
| --- | --- |
| `workspace_id` | 当前 workspace |
| `session_id` | 当前 session |
| `run_id` | 当前 run |
| `cwd` | 工作目录 |
| `hook_event_name` | 触发事件名 |
| `agent_name` | 配置的 agent 名 |
| `effective_agent_name` | 实际生效的 agent 名 |

**事件附加字段：**

| 事件 | 附加字段 |
| --- | --- |
| `before_model_call` | `model_ref`, `model_request` |
| `after_model_call` | `model_ref`, `model_request`, `model_response` |
| `before_tool_dispatch` | `tool_name`, `tool_input`, `tool_call_id` |
| `after_tool_dispatch` | `tool_name`, `tool_input`, `tool_output`, `tool_call_id` |
| `run_completed` / `run_failed` | `trigger_type`, `run_status` |

**传递方式：** `command` 通过 stdin；`http` 作为 POST body；`prompt`/`agent` 注入上下文。

### 输出

统一输出结构：

```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "Optional warning",
  "decision": "block",
  "reason": "Explanation",
  "hookSpecificOutput": {
    "hookEventName": "before_tool_dispatch",
    "additionalContext": "Extra context",
    "patch": { "tool_input": { "command": "npm run lint" } }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `continue` | 默认 `true`；`false` 终止当前 run |
| `stopReason` | `continue=false` 时的说明 |
| `suppressOutput` | 是否隐藏 hook 原始输出 |
| `systemMessage` | 给操作者的提示 |
| `decision` | 当前仅支持 `"block"` |
| `reason` | Block 原因 |
| `hookSpecificOutput.patch` | 改写对象，仅在 capability 允许时生效 |

Patch 范围：`context`、`model_request`、`model_response`、`tool_input`、`tool_output`。无对应 capability 的 patch 被忽略并记录 warning。

### Handler 返回语义

| Handler | 成功 | 阻断 | 错误 |
| --- | --- | --- | --- |
| `command` | exit 0，stdout JSON 按协议解析 | exit 2，stderr 作为原因 | 其他 exit code，记录后继续 |
| `http` | 2xx + JSON body | -- | 非 2xx / 超时，记录后继续 |
| `prompt` | 返回可解析的统一 JSON | -- | -- |
| `agent` | 返回可解析的统一 JSON | -- | -- |

## 完整示例：拦截危险命令

### `.openharness/hooks/block-dangerous.yaml`

```yaml
name: block-dangerous-commands
events:
  - before_tool_dispatch
matcher: "Bash"

handler:
  type: command
  command: node ./.openharness/hooks/scripts/check-command.js
  timeout_seconds: 5

capabilities:
  - patch_tool_input
```

### `.openharness/hooks/scripts/check-command.js`

```js
const input = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf8"));
const dangerous = ["rm -rf /", "drop table", "format c:"];
const cmd = input.tool_input?.command || "";
const blocked = dangerous.some((d) => cmd.toLowerCase().includes(d));

if (blocked) {
  console.log(JSON.stringify({
    continue: false,
    decision: "block",
    reason: "Command blocked: contains dangerous pattern",
  }));
} else {
  console.log(JSON.stringify({ continue: true }));
}
```
