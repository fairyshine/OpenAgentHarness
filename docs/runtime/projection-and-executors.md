# Projection And Executors

## 独立注册表

运行时分别维护：

- `AgentRegistry`
- `ModelRegistry`
- `ActionRegistry`
- `SkillRegistry`
- `McpRegistry`
- `HookRegistry`
- `NativeToolRegistry`

## Tool Exposure

在每次 run 启动时：

1. 根据 agent 配置解析 `model_ref`
2. 根据 agent 配置解析可用的 native tools
3. 解析可用的 actions 元数据
4. 解析可用的 skills 元数据
5. 解析 `tools/settings.yaml` 和本地 server 目录
6. 将上述能力投影为模型可消费的 tool definitions

`model_ref` 解析规则：

- `model_ref` 指向一个具体模型入口
- 该入口已经包含 `provider`、`key`、`url`、`name`
- agent 不再覆盖入口中的模型名

Agent 采用 Markdown 目录注册：

- 平台内建 agents 由服务端预注册
- workspace agents 从 `agents/*.md` 读取
- 文件名作为 workspace agent 的默认名称
- frontmatter 承载少量结构化字段
- Markdown 正文作为 agent 主 prompt
- `system_reminder` 为可选字段，用于 agent 切换后的首轮输入中注入额外提示
- 若同名，workspace agent 覆盖 platform agent

frontmatter 建议字段：

- `mode`
- `model`
- `description`
- `system_reminder`
- `tools`
- `switch`
- `subagents`
- `policy`

`system_reminder` 注入建议：

- 运行时统一包装为 `<system_reminder>...</system_reminder>`
- 可叠加平台内建提醒和 agent 自定义提醒
- 注入位置应是发送给模型的最新一条 user message，而不是 system prompt
- 触发场景包括同一 run 内 `AgentSwitch` 之后的下一次模型调用，以及用户手动切换 session agent 后的下一条 user message
- 创建 session 时显式选择 agent 默认不注入

agent 间控制建议：

- `agent.switch`
  - 用于同一 run 内切换到另一个 agent
  - 目标 agent 必须命中当前 agent 的 `switch` allowlist
- `agent.delegate`
  - 用于调用后台 subagent
  - 目标 agent 必须命中当前 agent 的 `subagents` allowlist
- `agent.await`
  - 用于等待一个或多个后台 subagent 结果
- `mode`
  - 用于标记某个 agent 是 `primary`、`subagent` 还是 `all`

`agent.delegate` 默认上下文规则：

- 传入 `task`
- 传入最小 `handoff_summary`
- 继承当前 `workspace`
- 子 agent 使用自己的 prompt / tools / policy / skills catalog
- 子 agent 优先使用自己的 `model`，没有才继承父 agent 当前模型
- 不继承父 agent 已激活的 skills 状态

`agent.await` 建议语义：

- 支持等待单个 child run
- 支持等待多个 child runs
- 多个 child runs 可支持 `all` 或 `any` 两种等待模式
- 回流给父 agent 的是结构化结果摘要，而不是子会话完整历史

执行结果建议沉淀为：

- `Run.effective_agent_name`
- `Run.switch_count`
- `RunStep(step_type=agent_switch)`
- `RunStep(step_type=agent_delegate)`

Skill 采用按需加载：

- 发现阶段优先读取 `SKILL.md` frontmatter 中的元数据
- 若无 frontmatter，则从目录名和正文中推断基础元数据
- system prompt 中只注入 skill catalog：名称、描述和可用性摘要
- 激活阶段通过 `Skill` 工具加载完整 `SKILL.md` 正文
- 读取 skill 资源文件时，继续通过 `Skill` 并附带 `resource_path`
- `scripts/`、`references/`、`assets/` 中的内容仅在需要时加载
- 默认扫描 `.openharness/skills/*`
- 服务端公共 skill 先从 `paths.skill_dir` 加载
- 可从 `settings.skill_dirs` 追加额外 skill 根目录
- 跨层同名冲突记录 warning 并按优先级覆盖，同层冲突直接报错

`Skill` 建议语义：

- `Skill({ name })`
  - 返回 `<skill_content>`，包含 skill 正文和资源列表
- `Skill({ name, resource_path })`
  - 返回 `<skill_resource>`，读取 skill 目录下某个具体资源文件

这样 skills 与 tools 保持分层：

- tools
  - 原子操作能力
- skills
  - 按需加载的指令集和资源包

External tool servers 采用集中式注册：

- 从 `tools/settings.yaml` 读取 server 定义
- 本地 server 按字符串形式的 `command` 启动
- 远程 server 通过 `url` 连接

Action 采用目录式注册：

- 从 `actions/*/ACTION.yaml` 读取 action 定义
- action 入口统一使用 `command`
- `command` 为字符串
- shell 命令和本地脚本都通过 `command` 表达

公共 tool servers 建议由服务端 `paths.tool_dir` 统一加载。

它们的语义是：

- 不属于 native tool
- 不属于 workspace 私有 action / skill / tool
- 属于服务端提供的公共 external tool 能力

脚本若需要调用服务端预设模型，建议不要直接访问第三方 provider。

推荐通过模型网关调用：

- `POST /internal/v1/models/generate`
- `POST /internal/v1/models/stream`

运行时可向 action / script 注入：

- `OPENHARNESS_MODEL_SOCKET`
- `OPENHARNESS_DEFAULT_MODEL`

详细设计见 [model-gateway.md](./model-gateway.md)。

## Invocation Routing

模型发出 tool call 后：

1. 校验 tool name 是否存在
2. 查找其真实来源类型
3. 构建统一 `InvocationContext`
4. 路由到对应执行器
5. 回收结构化结果并作为 tool message 回填模型

## 执行器模型

### 统一调用协议

无论能力来源如何，内部都遵循统一的调用协议：

- `tool_name`
- `arguments`
- `source_type`
- `invocation_context`
- `result`

### 分类型执行器

- `NativeToolExecutor`
  - 执行 shell / file 等内建能力
- `ActionExecutor`
  - 执行命名任务入口
- `SkillExecutor`
  - 执行技能型能力
- `McpExecutor`
  - 调用外部 tool server 对应工具

### Action 与 Skill 的区别

Action：

- 偏命名任务入口
- 审计边界更强
- 更容易被调用方和 API 直接触发

Skill：

- 偏能力封装
- 更强调某类工作的执行方法
- 仍可被直接暴露给 LLM 调用
