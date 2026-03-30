# Workspace Spec

workspace 是能力发现的主边界。用户打开一个项目后，平台应尽可能从项目根目录自动发现完整能力，而不是要求用户先去平台后台做大量全局配置。

当前约束：

- 只读取 workspace 根目录的 `AGENTS.md`
- 声明式配置放在 workspace 根目录 `.openharness/` 下
- 除 LLM API Key 外，不要求用户额外提供全局设置

## 目录结构

建议的 workspace 结构：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    agents/
      planner.md
      builder.md
      reviewer.md
    models/
      GPT.yaml
      Kimi-K25.yaml
    actions/
      code-review/
        ACTION.yaml
      run-tests/
        ACTION.yaml
    skills/
      repo-explorer/
        SKILL.md
        scripts/
        references/
      doc-reader/
        SKILL.md
    mcp/
      settings.yaml
      servers/
        docs-server/
        browser/
    hooks/
      redact-secrets.yaml
      policy-guard.yaml
      scripts/
      prompts/
      resources/
```

## 自动发现规则

系统在 run 启动时检查：

- `AGENTS.md`
- `.openharness/settings.yaml`
- `.openharness/agents/*.md`
- `.openharness/models/*.yaml`
- `.openharness/actions/*/ACTION.yaml`
- `.openharness/skills/*/SKILL.md`
- `.openharness/mcp/settings.yaml`
- `.openharness/mcp/servers/*`
- `.openharness/hooks/*.yaml`

运行时使用三类输入：

1. 平台内建 agent / model
2. workspace 当前文件声明
3. 当前 API / session / run 的显式参数

规则：

- 平台模板只用于初始化生成 workspace 文件，不参与运行时 merge
- 运行时只读取 workspace 当前文件，不读取模板源
- 平台内建 agent 与 workspace agent 一起组成当前 workspace 的可见 agent catalog
- 若平台内建 agent 与 workspace agent 同名，则 workspace agent 覆盖 platform agent
- 平台级与 workspace 级模型入口不互相覆盖，而是合并成当前 workspace 的 model catalog
- 模型入口解析优先使用显式 `model_ref`
- 显式参数只允许选择当前可见 catalog 中已有能力，或在未来支持时收窄权限边界，不允许扩展该 catalog 之外的能力
- 当前不做多级目录合并
- 当前不做子目录 override
- 如果 workspace 未声明 `default_agent`，且调用方也未显式指定 agent，则应返回配置错误

## 文档导航

- [settings.md](./settings.md)
- [agents.md](./agents.md)
- [models.md](./models.md)
- [actions.md](./actions.md)
- [skills.md](./skills.md)
- [mcp.md](./mcp.md)
- [hooks.md](./hooks.md)
- [loading-and-validation.md](./loading-and-validation.md)
