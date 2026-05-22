---
title: "Runtime 配置总览"
---

# Runtime 配置总览

Runtime 配置是一组会被复制到 workspace 并在执行时参与能力发现的文件。你可以在 `paths.runtime_dir/<runtime>` 模板里编写这些文件；创建 workspace 后，它们会进入项目根目录并成为该 workspace 的 agent、model、tool、skill、hook 等能力定义。

## Runtime 配置不是 Sandbox

Runtime 配置描述“这个项目有哪些能力、默认怎么运行”；sandbox 描述“这些能力最终在哪个宿主里执行”。这两个概念很容易混，但边界不同：

| 概念 | 边界 | 说明 |
| --- | --- | --- |
| `Runtime 配置` | 逻辑 / 项目 / 能力边界 | 描述 agent 正在处理哪个项目，以及该项目声明了哪些 agent、model、tool、skill、hook |
| `Sandbox` | 执行宿主边界 | 描述这些能力最终在哪个本地文件系统与进程环境里执行 |

因此：

- runtime 配置负责定义“是什么项目、有哪些能力”
- `sandbox` 负责定义“在哪个宿主里执行”
- 活跃 workspace 会被 materialize 成 owner worker 持有的 `Active Workspace Copy`
- 在 `embedded` 模式下，这个副本通常就是本机目录
- 在 `self_hosted / e2b` 模式下，这个副本通常位于远端 sandbox 内

## 配置形态

当前只保留一种标准配置形态：在同一目录结构内声明 agents、models、actions、skills、tools、hooks，并由运行时统一发现与执行。

## 目录结构

完整结构：

```text
runtime-or-workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    prompts.yaml
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
runtime-or-workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    prompts.yaml
    agents/
      builder.md
    models/
      openai.yaml
```

## 自动发现规则

runtime 模板创建 workspace 后，或 workspace 被加载和刷新时，运行时会解析以下路径；run 执行时使用的是已经解析好的能力定义与活跃副本：

| 路径 | 用途 |
| --- | --- |
| `AGENTS.md` | 项目说明文档，注入 system prompt |
| `.openharness/settings.yaml` | 总配置入口 |
| `.openharness/prompts.yaml` | Runtime prompt 配置 |
| `.openharness/agents/*.md` | Agent 定义 |
| `.openharness/models/*.yaml` | 模型入口 |
| `.openharness/actions/*/ACTION.yaml` | Action 定义 |
| `.openharness/skills/*/SKILL.md` | Skill 定义 |
| `.openharness/tools/settings.yaml` | MCP tool server 注册 |
| `.openharness/tools/servers/*` | 本地 tool server 代码 |
| `.openharness/hooks/*.yaml` | Hook 定义 |

> **info**

    `.openharness/data/` 是运行时托管目录，不参与能力定义解析。`history.db` 只承载本地运行时数据，不是跨进程同步机制。

> **info**

    `AGENTS.md`、`.openharness/agents`、`.openharness/models` 等描述的是 runtime 配置本身，不描述 sandbox。即使 workspace 被 materialize 到别的宿主中执行，这些定义仍然属于同一套能力定义。

**合并规则：**

- 平台内建 agent 与 workspace agent 合并成可见 catalog；同名时 workspace 覆盖平台
- 平台级与 workspace 级模型入口合并，不互相覆盖
- skills、tools、actions、hooks 以当前 workspace 副本中的 `.openharness/` 声明为准；服务端 `paths.skill_dir` / `paths.tool_dir` 主要作为 runtime 初始化导入源，不会直接绕过 workspace 本地声明进入可见能力集
- Agent 推荐通过 `settings.models` 中的别名引用模型
- 显式参数只能选择当前 catalog 中的已有能力，不能扩展
- 若未声明 `default_agent` 且调用方也未指定 agent，返回配置错误

## FAQ

**为什么 `.openharness/data/` 不参与配置解析？**

它是运行时托管目录。`history.db` 只是本地运行时数据文件，不是对外真值接口。

**为什么文件 API 用 sandbox，而不是直接用 workspace？**

因为文件读写和命令执行总是针对“当前活跃执行副本”进行，而这个副本属于某个 sandbox。workspace 负责项目身份和能力发现；sandbox 负责文件系统与进程上下文。
