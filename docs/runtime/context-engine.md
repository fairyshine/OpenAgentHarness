# Context Engine

## 输入

- workspace 元数据与 settings
- session 历史消息
- 平台内建 agent 定义 + workspace agent 定义
- 服务端 `paths.model_dir` 平台模型清单 + workspace 模型清单
- `AGENTS.md` 原文
- `.openharness` 声明式配置
- `settings.skill_dirs` 额外 skill 根目录

说明：服务端 `paths.tool_dir` / `paths.skill_dir` 仅作为蓝图导入源，不直接进入运行时上下文。运行时统一从 `workspace_dir` 加载 workspace，不再区分额外的只读对话目录。

## 输出

- 系统 prompt
- Runtime Messages（内部事实来源）→ Model Messages（模型上下文视图）→ AI SDK Messages（最终请求结构）
- 模型参数与 model entry 解析结果
- Tool 列表、运行策略、hook 管道

详细消息分层见 [message-projections.md](./message-projections.md)。

运行时不再区分额外的只读对话 workspace 形态；actions/skills/tools/hooks 是否生效由 workspace 自身声明决定。

## 上下文装配顺序

1. 按 `system_prompt.compose.order` 组装静态 system prompt 段
2. session 历史消息
3. 若发生 agent 切换，在最新 user message 附加 `<system_reminder>`
4. 当前消息输入

静态 system prompt 默认顺序：base → llm_optimized → agent prompt → actions catalog → `AGENTS.md` 原文 → skills catalog。若 `include_environment=true`，追加 environment 摘要。

`AGENTS.md` 始终注入全文，不摘要、不裁剪。

## Agent 选择规则

- 优先使用 run / session 显式指定的 agent
- 否则使用 `settings.yaml` 的 `default_agent`
- 两者都没有则返回配置错误

可见 catalog = 平台内建 agent + `.openharness/agents/*.md`。同名时 workspace agent 覆盖 platform agent。API 参数只能选择当前可见 catalog 中存在的 agent/model。

## `<system_reminder>` 注入规则

- 创建 session 时显式指定 agent：不注入
- run 内 `agent.switch` 导致 `effective_agent_name` 改变：注入
- 用户手动更新 session agent 后首条消息进入新 agent：注入
- 同一 agent 连续执行：不重复注入
