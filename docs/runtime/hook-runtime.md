# Hook Runtime

## Hook 类型

- Lifecycle Hook
  - 观测系统事件
- Interceptor Hook
  - 改写请求和执行逻辑

handler 类型建议支持：

- `command`
  - 执行 workspace 内的 shell 命令或脚本
- `http`
  - 发送 HTTP 请求到外部服务
- `prompt`
  - 使用 prompt 型 handler 生成结构化判断或 patch
- `agent`
  - 调用一个指定 agent 执行 hook 检查或生成决策

配置与协议建议参考 Claude Code 的 hooks 设计：

- hook 声明使用 YAML
- 可选 `matcher` 用于按事件查询值做正则过滤
- `command` 通过 stdin 接收 JSON，并通过 exit code + stdout/stderr 返回结果
- `http` 通过 POST body 接收相同 JSON，并通过 HTTP status + body 返回结果
- `prompt` 与 `agent` 在运行时内部也应遵循同一份结构化输入输出协议

## 建议事件点

- `before_context_build`
- `after_context_build`
- `before_model_call`
- `after_model_call`
- `before_tool_dispatch`
- `after_tool_dispatch`
- `run_completed`
- `run_failed`

matcher 建议语义：

- `before_tool_dispatch`、`after_tool_dispatch`
  - matcher 匹配 `tool_name`
- `before_model_call`、`after_model_call`
  - matcher 匹配 `model_ref`
- `before_context_build`、`after_context_build`
  - 默认不支持 matcher
- `run_completed`、`run_failed`
  - matcher 可匹配 `trigger_type`

## 统一输入协议建议

- 所有 handler 都接收同一份 JSON envelope
- 公共字段至少包括：
  - `workspace_id`
  - `session_id`
  - `run_id`
  - `cwd`
  - `hook_event_name`
  - `agent_name`
  - `effective_agent_name`
- 事件附加字段按事件类型补充，例如：
  - `model_ref`
  - `tool_name`
  - `tool_input`
  - `tool_output`
  - `trigger_type`

## 统一输出协议建议

- 参考 Claude Code，统一采用：
  - 顶层通用控制字段
  - 顶层 `decision` / `reason`
  - `hookSpecificOutput`
- 通用字段建议包括：
  - `continue`
  - `stopReason`
  - `suppressOutput`
  - `systemMessage`
- 对允许改写的事件，具体 patch 放入 `hookSpecificOutput`
- patch 的可用范围必须受 `capabilities` 限制

## handler 返回语义建议

- `command`
  - exit code `0` 表示成功，若 stdout 为 JSON 则按统一输出协议解析
  - exit code `2` 表示阻断当前事件，stderr 作为阻断原因
  - 其他 exit code 视为非阻断错误，记录日志后继续
- `http`
  - `2xx` + 空 body 表示成功且无输出
  - `2xx` + JSON body 按统一输出协议解析
  - 非 `2xx` 或超时视为非阻断错误，记录日志后继续
- `prompt`
  - 运行时负责将输入 envelope 注入 prompt，并要求返回统一 JSON
- `agent`
  - 运行时负责把输入 envelope 作为任务上下文交给指定 agent，并要求返回统一 JSON

## 当前限制

- Hook 不允许直接操作底层数据库事务
- Hook 改写能力必须显式声明 capability
- Hook 默认只作用于当前 run 上下文
- `.openharness/hooks/` 除 `*.yaml` 外，也允许放置脚本、子目录、prompt 文件和其他静态资源
