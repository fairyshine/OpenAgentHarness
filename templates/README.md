# Templates

这里提供两类可直接复制的 workspace 样例：

- `workspace/`
  - 常规 `project` workspace 模板
  - 包含最小可用的 `AGENTS.md`、`settings.yaml`、agent 与 model 配置
- `chat-workspace/`
  - 只读 `chat` workspace 模板
  - 仅包含普通对话所需的静态配置

建议使用方式：

1. 复制对应目录到你的 `paths.workspace_dir` 或 `paths.chat_dir`
2. 按需修改 `AGENTS.md`
3. 修改 `.openharness/settings.yaml` 中的默认 agent 和 system prompt
4. 修改 `.openharness/models/openai.yaml` 中的模型入口与环境变量引用

说明：

- 模板只用于初始化文件，不会被运行时直接当作活跃 workspace 加载
- `chat-workspace` 是否按 `kind=chat` 运行，由服务端注册目录决定，而不是模板目录名决定
