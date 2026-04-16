# Blueprints

这里提供一类可直接复制的 workspace blueprint 样例：

- `workspace/`
  - 标准 workspace blueprint
  - 包含最小可用的 `AGENTS.md`、`settings.yaml`、agent 与 model 配置

建议使用方式：

1. 复制对应目录到你的 `paths.blueprint_dir`
2. 按需修改 `AGENTS.md`
3. 修改 `.openharness/settings.yaml` 中的默认 agent 和 system prompt
4. 修改 `.openharness/models/openai.yaml` 中的模型入口与环境变量引用

说明：

- blueprint 只用于初始化文件，不会被运行时直接当作活跃 workspace 加载
