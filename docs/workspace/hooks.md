# Hooks

## 目标

Hook 用于运行时扩展和拦截，不对 LLM 直接暴露。

继续采用 `.openharness/hooks/*.yaml` 作为 hook 声明入口，但允许在 `hooks/` 目录下放置额外脚本、代码文件、prompt 文件和资源子目录。

## 示例

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

HTTP 示例：

```yaml
name: policy-webhook
events:
  - before_tool_dispatch
matcher: "shell.exec|mcp__.*"

handler:
  type: http
  url: https://example.internal/hooks/policy
  headers:
    Authorization: Bearer ${secrets.HOOK_TOKEN}
  timeout_seconds: 10

capabilities:
  - rewrite_tool_request
```

Prompt 示例：

```yaml
name: summarize-model-output
events:
  - after_model_call
matcher: "platform/openai-default"

handler:
  type: prompt
  prompt:
    file: ./.openharness/hooks/prompts/summarize-output.md
  model_ref: platform/openai-default

capabilities:
  - rewrite_model_response
```

Agent 示例：

```yaml
name: policy-agent-review
events:
  - before_tool_dispatch
matcher: "shell.exec"

handler:
  type: agent
  agent: policy-reviewer
  task:
    inline: |-
      Review the pending tool invocation and decide whether a patch is required.

capabilities:
  - rewrite_tool_request
```

## 顶层字段

- `name`
- `events`
- `matcher`
- `handler`
- `capabilities`

## `matcher` 字段

`matcher` 参考 Claude Code 的 hooks 机制，使用正则字符串按事件查询值过滤 hook 是否触发。

规则：

- 可选；未声明时表示匹配该事件下的所有触发
- 使用正则字符串，而不是 glob
- 不同事件的匹配目标不同：
  - `before_tool_dispatch`、`after_tool_dispatch`
    - 匹配 `tool_name`
  - `before_model_call`、`after_model_call`
    - 匹配 `model_ref`
  - `run_completed`、`run_failed`
    - 可匹配 `trigger_type`
  - `before_context_build`、`after_context_build`
    - 默认忽略 `matcher`

示例：

```yaml
matcher: "shell.exec|mcp__docs__search"
```

```yaml
matcher: "platform/openai-default|workspace/中文模型"
```

## `handler` 字段

建议支持四种 handler：

- `command`
  - 通过命令字符串执行脚本、解释器或本地程序
- `http`
  - 通过 HTTP 请求调用外部服务
- `prompt`
  - 通过 prompt + model 生成结构化结果
- `agent`
  - 调用指定 agent 生成结构化结果

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

字段说明：

- `command`
  - 必填；命令字符串
- `cwd`
  - 可选；工作目录
- `timeout_seconds`
  - 可选；执行超时
- `environment`
  - 可选；追加环境变量

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

字段说明：

- `url`
  - 必填；HTTP endpoint
- `method`
  - 可选；默认 `POST`
- `headers`
  - 可选；请求头
- `timeout_seconds`
  - 可选；请求超时

### `prompt`

```yaml
handler:
  type: prompt
  prompt:
    file: ./.openharness/hooks/prompts/review.md
  model_ref: platform/openai-default
  timeout_seconds: 20
```

字段说明：

- `prompt`
  - 必填；支持 `inline` 或 `file`
- `model_ref`
  - 可选；指定 hook 使用的模型入口
- `timeout_seconds`
  - 可选；执行超时

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

字段说明：

- `agent`
  - 必填；指定执行 hook 的 agent 名称
- `task`
  - 必填；支持 `inline` 或 `file`
- `timeout_seconds`
  - 可选；执行超时

## 输入与输出协议

整体参考 Claude Code 的 hook I/O 形式，但事件名和 patch 能力对齐 Open Agent Harness。

### 输入

所有 handler 都接收同一份 JSON envelope。

公共字段建议至少包括：

- `workspace_id`
- `session_id`
- `run_id`
- `cwd`
- `hook_event_name`
- `agent_name`
- `effective_agent_name`

事件附加字段按事件类型补充，例如：

- `before_model_call`
  - `model_ref`
  - `model_request`
- `after_model_call`
  - `model_ref`
  - `model_request`
  - `model_response`
- `before_tool_dispatch`
  - `tool_name`
  - `tool_input`
  - `tool_call_id`
- `after_tool_dispatch`
  - `tool_name`
  - `tool_input`
  - `tool_output`
  - `tool_call_id`
- `run_completed` / `run_failed`
  - `trigger_type`
  - `run_status`

各 handler 的传递方式：

- `command`
  - JSON 通过 stdin 传入
- `http`
  - JSON 作为 POST body 传入
- `prompt`
  - 运行时将该 JSON envelope 注入 prompt 上下文
- `agent`
  - 运行时将该 JSON envelope 注入 agent task 上下文

### 输出

统一输出对象建议采用 Claude Code 风格：

```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "Optional warning for operator",
  "decision": "block",
  "reason": "Explanation for the block",
  "hookSpecificOutput": {
    "hookEventName": "before_tool_dispatch",
    "additionalContext": "Optional extra context",
    "patch": {
      "tool_input": {
        "command": "npm run lint"
      }
    }
  }
}
```

字段说明：

- `continue`
  - 默认 `true`
  - `false` 时终止当前 run 继续执行
- `stopReason`
  - 当 `continue=false` 时给用户或调用方看的说明
- `suppressOutput`
  - 是否隐藏 hook 原始输出
- `systemMessage`
  - 给操作者的提示信息
- `decision`
  - 当前建议只支持 `"block"`
- `reason`
  - 对 `decision=block` 的说明
- `hookSpecificOutput`
  - 事件级结构化输出
- `hookSpecificOutput.additionalContext`
  - 注入到后续上下文的补充信息
- `hookSpecificOutput.patch`
  - 改写对象，仅在 capability 允许时生效

patch 范围建议为：

- `context`
- `model_request`
- `model_response`
- `tool_input`
- `tool_output`

规则：

- `patch` 只能改写 `capabilities` 允许的对象
- 不具备对应 capability 的 patch 字段必须被忽略并记录 warning
- `decision=block` 与 `patch` 可同时存在，但通常以 block 优先

### 不同 handler 的返回语义

- `command`
  - exit code `0`：成功；若 stdout 为 JSON，则按上面的统一输出协议解析
  - exit code `2`：阻断当前事件；stderr 作为失败原因
  - 其他 exit code：非阻断错误；记录后继续
- `http`
  - `2xx` + 空 body：成功且无额外输出
  - `2xx` + JSON body：按统一输出协议解析
  - 非 `2xx` / 超时：非阻断错误；记录后继续
- `prompt`
  - 必须返回可解析的统一 JSON
- `agent`
  - 必须返回可解析的统一 JSON

## 目录约定

`hooks/` 目录除 `*.yaml` 外，建议支持：

- `scripts/`
  - hook 调用的脚本和代码文件
- `prompts/`
  - prompt handler 或 agent handler 复用的提示词文件
- `resources/`
  - 配置片段、模板、测试数据和其他静态资源

规则：

- `hooks/*.yaml` 仍是唯一的 hook 声明入口
- 额外文件和子目录仅作为 hook 运行时依赖资源，不单独注册为 hook
- `file` 路径相对 workspace 根目录解析

## 当前建议限制

- 只允许声明少量 capability
- 只能操作当前 run 的上下文对象
- hook 输出必须是运行时可解释的结构化结果
- `agent` 型 hook 默认不允许继续递归触发新的 hook agent 链路，避免失控
