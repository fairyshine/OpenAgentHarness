# Workspace

Workspace 是能力发现的主边界。用户打开项目后，运行时从项目根目录自动发现全部能力，无需全局配置。

## Workspace 类型

当前只保留一种标准 workspace 形态：在同一目录结构内声明 agents、models、actions、skills、tools、hooks，并由运行时统一发现与执行。

## 目录结构

完整结构：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    data/
      history.db
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
    tools/
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

最小可用结构：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    agents/
      builder.md
    models/
      openai.yaml
```

## 自动发现规则

运行时在 run 启动时扫描以下路径：

| 路径 | 用途 |
| --- | --- |
| `AGENTS.md` | 项目说明文档，注入 system prompt |
| `.openharness/settings.yaml` | 总配置入口 |
| `.openharness/agents/*.md` | Agent 定义 |
| `.openharness/models/*.yaml` | 模型入口 |
| `.openharness/actions/*/ACTION.yaml` | Action 定义 |
| `.openharness/skills/*/SKILL.md` | Skill 定义 |
| `.openharness/tools/settings.yaml` | MCP tool server 注册 |
| `.openharness/tools/servers/*` | 本地 tool server 代码 |
| `.openharness/hooks/*.yaml` | Hook 定义 |

!!! info

    `.openharness/data/` 是运行时托管目录，不参与能力定义解析。`history.db` 只承载本地运行时数据，不是跨进程同步机制。

**合并规则：**

- 平台内建 agent 与 workspace agent 合并成可见 catalog；同名时 workspace 覆盖平台
- 平台级与 workspace 级模型入口合并，不互相覆盖
- Agent 必须通过显式 `model_ref` 引用模型
- 显式参数只能选择当前 catalog 中的已有能力，不能扩展
- 若未声明 `default_agent` 且调用方也未指定 agent，返回配置错误

## FAQ

**为什么 `.openharness/data/` 不参与配置解析？**

它是运行时托管目录。`history.db` 只是本地运行时数据文件，不是对外真值接口。
