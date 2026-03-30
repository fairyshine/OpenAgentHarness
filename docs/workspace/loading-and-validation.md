# Loading And Validation

## 运行时加载规则

### 缓存策略

- workspace 配置在首次访问时加载
- 文件变更可通过 mtime 或 hash 触发缓存失效
- 运行时可维护基于 workspace 的内存缓存

### 失败策略

- YAML 语法错误时，标记该定义加载失败
- 单个定义失败不应导致整个 workspace 不可用
- Agent 启动时若引用不存在的 action / skill / mcp / hook，则该 run 失败并返回明确错误

## 配置校验

建议在加载时进行：

- Agent Markdown frontmatter 解析校验
- YAML 解析校验
- JSON Schema 校验
- 引用存在性校验
- 名称唯一性校验
- tool 暴露名称冲突校验

对应 schema 文件：

- `settings` -> [../schemas/settings.schema.json](../schemas/settings.schema.json)
- `models` -> [../schemas/models.schema.json](../schemas/models.schema.json)
- `action` -> [../schemas/action.schema.json](../schemas/action.schema.json)
- `mcp settings` -> [../schemas/mcp-settings.schema.json](../schemas/mcp-settings.schema.json)
- `hook` -> [../schemas/hook.schema.json](../schemas/hook.schema.json)

说明：

- `agent` 不使用本地 JSON Schema 强约束
- 运行时主要校验 frontmatter 可解析性、`model.model_ref` 存在性、`tools` 引用存在性和文件名一致性
