# Loading and Validation

## 加载规则

### 缓存

- Workspace 配置在首次访问时加载
- 文件变更通过 mtime 或 hash 触发缓存失效
- 运行时维护基于 workspace 的内存缓存

### 运行时托管目录

`.openharness/data/` 是运行时托管资源，不参与能力定义加载：

| 路径 | 说明 |
| --- | --- |
| `.openharness/data/` | 运行时数据目录 |
| `.openharness/data/history.db` | 本地 SQLite 运行时数据文件 |

- 首次需要时由 runtime 自动创建
- 缺失或损坏不影响 workspace 配置加载

### 失败策略

| 场景 | 行为 |
| --- | --- |
| YAML 语法错误 | 标记该定义加载失败 |
| 单个定义失败 | 不影响整个 workspace |
| Agent 引用不存在的能力 | 该 run 失败并返回明确错误 |
| `history.db` 不可用 | 不影响配置加载 |

## 配置校验

加载时执行以下校验：

| 校验项 | 说明 |
| --- | --- |
| Frontmatter 解析 | Agent Markdown frontmatter 可解析性 |
| YAML 解析 | 所有 YAML 文件语法正确 |
| JSON Schema | 按对应 schema 校验结构 |
| 引用存在性 | model_ref、action、skill、tool 引用目标存在 |
| 名称唯一性 | 同层级内名称不重复 |
| 工具名冲突 | 暴露名称不冲突 |

Schema 文件：

| 类型 | Schema |
| --- | --- |
| settings | [settings.schema.json](../schemas/settings.schema.json) |
| models | [models.schema.json](../schemas/models.schema.json) |
| action | [action.schema.json](../schemas/action.schema.json) |
| MCP tools | [mcp-settings.schema.json](../schemas/mcp-settings.schema.json) |
| hook | [hook.schema.json](../schemas/hook.schema.json) |

Agent 不使用 JSON Schema 强约束，运行时校验 frontmatter 可解析性、`model.model_ref` 存在性、`tools` 引用存在性。

## 常见加载错误

### YAML 语法错误

```
Error: Failed to parse .openharness/hooks/block-cmd.yaml: unexpected token
```

原因：缩进不正确或使用了 tab。用 YAML linter 检查，确保一致使用空格。

### Agent model_ref 不存在

```
Error: Agent "builder" references model "workspace/gpt-5" which does not exist
```

检查 `.openharness/models/*.yaml` 是否定义了对应模型，或使用 `platform/` 前缀引用平台模型。

### Skill 同层名称冲突

```
Error: Duplicate skill name "repo-explorer" found in .openharness/skills/
```

同一 skill 根目录下出现同名目录。重命名其中一个确保唯一。

### Tool server 启动失败

```
Warning: MCP server "docs-server" failed to start: ENOENT node ./servers/docs-server/index.js
```

检查 `.openharness/tools/settings.yaml` 中 command 路径是否正确，确保文件存在且有执行权限。
