# Projection And Executors

## 注册表

运行时维护独立注册表：`AgentRegistry`、`ModelRegistry`、`ActionRegistry`、`SkillRegistry`、`McpRegistry`、`HookRegistry`、`NativeToolRegistry`。

## Tool Exposure

每次 run 启动时：

1. 解析 agent 配置中的 `model_ref`（指向含 provider/key/url/name 的具体入口）
2. 解析可用 native tools、actions、skills 元数据
3. 解析 `tools/settings.yaml` 和本地 server 目录
4. 投影为模型可消费的 tool definitions

## Agent 注册

Agent 采用 Markdown 目录注册：

- 平台内建 agents 由服务端预注册
- workspace agents 从 `agents/*.md` 读取，文件名为默认名称
- Markdown 正文为 agent 主 prompt，frontmatter 承载结构化字段
- 同名时 workspace agent 覆盖 platform agent

Frontmatter 字段：`mode`、`model`、`description`、`system_reminder`、`tools`、`switch`、`subagents`、`policy`。

### system_reminder 注入

- 统一包装为 `<system_reminder>...</system_reminder>`
- 注入位置：发送给模型的最新 user message
- 触发：`agent.switch` 后下一次模型调用、用户手动切 agent 后首条消息
- 创建 session 时显式选择 agent 默认不注入

### Agent 间控制

| 动作 | 用途 | 约束 |
| --- | --- | --- |
| `agent.switch` | 同 run 内切换 agent | 目标须命中 `switch` allowlist |
| `agent.delegate` | 后台 subagent | 目标须命中 `subagents` allowlist |
| `agent.await` | 等待 subagent 结果 | 支持 `all` / `any` 模式 |

`agent.delegate` 默认上下文：传入 `task` + `handoff_summary`，继承 workspace，子 agent 用自己的 prompt/tools/policy/skills，优先用自己的 model。

执行沉淀：`Run.effective_agent_name`、`Run.switch_count`、`RunStep(agent_switch)`、`RunStep(agent_delegate)`。

## Skill 注册

- 发现阶段读取 `SKILL.md` frontmatter 元数据
- System prompt 只注入 skill catalog 摘要
- 激活通过 `Skill({ name })` 加载完整正文
- 资源文件通过 `Skill({ name, resource_path })` 读取
- 默认扫描 `.openharness/skills/*`，可从 `settings.skill_dirs` 追加
- 同名按 workspace 优先，同层同名冲突报错

Skills（按需加载指令集）与 tools（原子操作能力）保持分层。

## External Tool Servers

- 从 `tools/settings.yaml` 读取 server 定义
- 本地 server 按 `command` 启动，远程 server 通过 `url` 连接
- 公共 tool servers 可由 `paths.tool_dir` 提供给蓝图初始化导入

脚本调用模型推荐通过模型网关，详见 [model-gateway.md](./model-gateway.md)。

## Invocation Routing

模型发出 tool call 后：校验 tool name → 查找来源类型 → 构建 `InvocationContext` → 路由到执行器 → 回收结果回填模型。

## 执行器

### 统一协议

所有能力遵循统一调用协议：`tool_name`、`arguments`、`source_type`、`invocation_context`、`result`。

### 分类

| 执行器 | 职责 |
| --- | --- |
| `NativeToolExecutor` | shell / file 等内建能力 |
| `ActionExecutor` | 命名任务入口（审计边界强，API 可直接触发） |
| `SkillExecutor` | 技能型能力（偏能力封装和执行方法） |
| `McpExecutor` | 外部 tool server 工具 |
