# JSON Schemas

这里保存 OpenAgentHarness 配置文件的 JSON Schema。

其中既包括：

- workspace 内 `.openharness/` 目录下的声明式配置
- 服务端部署级配置文件

## 文件

- [settings.schema.json](./settings.schema.json)
- [models.schema.json](./models.schema.json)
- [action.schema.json](./action.schema.json)
- [mcp-settings.schema.json](./mcp-settings.schema.json)
- [hook.schema.json](./hook.schema.json)
- [server-config.schema.json](./server-config.schema.json)

## 说明

- 这些 schema 以 JSON Schema 2020-12 为基准
- 实际配置文件可以是 YAML，运行时先解析 YAML，再按对应 JSON Schema 校验
- `agent` 不走本地 JSON Schema，而是采用 Markdown + frontmatter + 正文 prompt 规范
- `settings` 使用 `settings.yaml` 管理 workspace 默认 agent 和公共 system prompt
- `settings` 也可声明额外 skill 目录
- `skill` 不走本地 YAML schema，而是采用目录式 `SKILL.md` 规范
- `tool` 采用 `tools/settings.yaml` + `tools/servers/*`
- `server-config` 用于校验服务端部署级 `server.yaml`
- schema 目标是约束当前 DSL，而不是一次性覆盖未来所有扩展

## 当前约束

- Action 是单入口命名任务，不是 workflow DSL
- Action 目录遵循 `actions/*/ACTION.yaml` 规范
- Action entry 使用字符串形式的 `command`
- Workspace 总配置遵循 `.openharness/settings.yaml` 规范
- Agent 目录遵循 `agents/*.md` 规范，文件名即 agent 名
- Skill 目录遵循 Agent Skills 的 `SKILL.md` 规范
- Hook 采用 `hooks/*.yaml` 声明，支持 Claude Code 风格的 `matcher` 与统一 JSON 输入输出协议
- Model entries 支持平台级引用与 workspace 级声明
- Tool server 采用集中式 `settings.yaml` 注册，本地 server 与远程 server 并存
- 本地 tool server 使用字符串形式的 `command` 启动
