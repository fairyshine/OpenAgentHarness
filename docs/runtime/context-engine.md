# Context Engine

## 输入

- workspace 元数据
- workspace settings
- session 历史消息
- 平台内建 agent 定义
- 当前 agent 定义
- 服务端 `paths.model_dir` 中的平台模型入口清单
- 服务端 `paths.tool_dir` 中的公共 external tool 定义
- 服务端 `paths.skill_dir` 中的公共 skill 定义
- workspace 级模型入口清单
- `AGENTS.md`
- `.openharness` 目录中的声明式配置
- `settings.skill_dirs` 解析出的额外 skill roots

说明：

- 运行时会同时读取服务端公共能力目录与当前 workspace 文件
- 平台模板仅用于初始化 workspace，不参与运行时加载或 merge
- `paths.chat_dir` 下的只读对话空间不属于“先复制后使用”的模板；它们会被直接发现并按 workspace 加载
- `kind=chat` workspace 仍沿用同一套加载入口，但只装配只读对话所需的静态配置

## 输出

- 系统 prompt
- 对话历史
- 模型参数与 model entry 解析结果
- 允许暴露给 LLM 的 tools 列表
- 运行策略
- hook 管道

`kind=chat` workspace 的额外约束：

- 只读取 `AGENTS.md`、`.openharness/settings.yaml`、`.openharness/agents/*.md`、`.openharness/models/*.yaml`
- 不装配 `actions`、`skills`、`tools`、`hooks`
- 输出的 tool 列表固定为空
- 不生成执行 backend 所需的运行环境摘要

## 上下文装配顺序

建议顺序：

1. 按 `system_prompt.compose.order` 组装静态 system prompt 段
2. session 历史消息
3. agent 激活或切换时的 `<system_reminder>`
4. 当前消息输入

静态 system prompt 的默认顺序为：

1. workspace `system_prompt.base`
2. workspace `system_prompt.llm_optimized`
3. agent 主 prompt
4. actions catalog
5. `AGENTS.md` 项目说明原文
6. skills catalog

若 `include_environment=true`，运行时会在上述静态段之后追加 environment 摘要；默认不追加。

`AGENTS.md` 注入规则：

- 启用时始终注入根目录 `AGENTS.md` 的原文全文
- 不做摘要
- 不做长度裁剪
- 不做结构化预处理

## agent 选择规则

- 若 run / session 显式指定了 agent，则优先使用显式值
- 否则使用 `.openharness/settings.yaml` 中的 `default_agent`
- 若两者都没有，则返回配置错误
- `default_agent` 可指向当前可见 catalog 中的 platform agent 或 workspace agent

agent 可见性与覆盖规则：

- 当前 workspace 的可见 agent catalog = 平台内建 agent + `.openharness/agents/*.md`
- 若平台内建 agent 与 workspace agent 同名，则 workspace agent 覆盖 platform agent
- session / run 显式参数只能选择当前可见 catalog 中存在的 agent

覆盖规则：

- workspace 当前文件是 workspace 层唯一的声明式事实来源
- API / session / run 的显式参数只允许选择当前可见 catalog 中已有的 agent、model 或能力
- 未来若支持临时 override，也只允许收窄权限和可见能力，不允许扩展当前可见 catalog 之外的能力

其中 `<system_reminder>` 的触发规则建议为：

- session 创建时显式指定 agent
- 当前 run 的 `agent_name` 与上一轮 active agent 不同
- 同一 agent 连续执行时默认不重复注入
- run 内发生 `agent.switch`，且 `effective_agent_name` 改变

补充说明：

- `kind=chat` workspace 仍可通过 API 或 session 显式选择不同 agent
- 但由于没有工具控制面，默认不支持 run 中途由模型主动切换 agent
