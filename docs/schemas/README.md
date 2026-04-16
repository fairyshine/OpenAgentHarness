# JSON Schemas

OpenAgentHarness 配置文件的 JSON Schema（JSON Schema 2020-12）。配置文件为 YAML，运行时解析后按 schema 校验。

## 文件

| Schema | 用途 |
| --- | --- |
| [settings.schema.json](./settings.schema.json) | workspace `settings.yaml`（默认 agent、system prompt、skill dirs、imports） |
| [models.schema.json](./models.schema.json) | 模型入口（平台级 + workspace 级） |
| [action.schema.json](./action.schema.json) | `actions/*/ACTION.yaml` |
| [mcp-settings.schema.json](./mcp-settings.schema.json) | `tools/settings.yaml`（tool server 注册） |
| [hook.schema.json](./hook.schema.json) | `hooks/*.yaml` |
| [server-config.schema.json](./server-config.schema.json) | 服务端 `server.yaml` |

## 约束

- Agent 不走 JSON Schema，采用 `agents/*.md`（Markdown + frontmatter）
- Skill 不走 YAML schema，采用 `SKILL.md` 目录规范
- Action 为单入口命名任务（`command` 字符串），不是 workflow DSL
- Tool server 采用集中式 `settings.yaml`，本地 server 用 `command` 启动
- Hook 支持 `matcher` + 统一 JSON 输入输出协议
