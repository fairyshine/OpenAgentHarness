---
title: "Prompts"
---

# Prompts

`.openharness/prompts.yaml` 用于存放 workspace 级 prompt 配置。

它承载原先 `settings.yaml` 里的 `system_prompt` 内容，但现在独立出来，便于把“运行设置”和“提示词文本”分开维护。

## 完整示例

```yaml
base:
  inline: |-
    You are Open Agent Harness running inside the current workspace.
    Prefer workspace-local configuration and tools.

llm_optimized:
  providers:
    openai:
      inline: |-
        Be concise, tool-oriented, and explicit about assumptions.
  models:
    default:
      inline: |-
        Prefer short, direct tool call arguments.

compose:
  order:
    - base
    - llm_optimized
    - agent
    - actions
    - project_agents_md
    - skills
  include_environment: false
```

## 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `base` | 否 | Workspace 级基础提示词 |
| `llm_optimized` | 否 | 面向 provider 或模型别名的优化提示词 |
| `compose` | 否 | 静态 system prompt 段的拼装顺序 |

## `base`

支持 `inline` 或 `file` 二选一：

```yaml
base:
  inline: |-
    You are Open Agent Harness.
```

```yaml
base:
  file: ./.openharness/prompts/base.md
```

`file` 路径相对 workspace 根目录解析。

## `llm_optimized`

可按 provider 或模型别名注入补充提示词：

```yaml
llm_optimized:
  providers:
    openai:
      inline: Be concise and tool-oriented.
  models:
    default:
      file: ./.openharness/prompts/openai-default.md
```

| 规则 | 说明 |
| --- | --- |
| 优先级 | `models` 精确匹配 > `providers` |
| Provider key | AI SDK provider 标识 |
| Model key | `settings.yaml -> models` 中声明的别名；加载时会解析成具体 `model_ref` |

## `compose`

```yaml
compose:
  order:
    - base
    - llm_optimized
    - agent
    - agent_switches
    - subagents
    - project_agents_md
    - skills
    - actions
    - environment
  include_environment: true
```

可用段名：

- `base`
- `llm_optimized`
- `agent`
- `actions`
- `project_agents_md`
- `skills`
- `agent_switches`
- `subagents`
- `environment`

| 规则 | 说明 |
| --- | --- |
| `system_reminder` | 不在这里配置，由运行时动态注入 |
| `actions` | 当前 agent 无可见 actions 时自动跳过 |
| `project_agents_md` | 根目录无 `AGENTS.md` 时自动跳过 |
| `skills` | 当前 agent 无可见 skills 时自动跳过 |
| `include_environment` | 是否追加运行环境摘要，默认 `false` |

> **note**

    为兼容旧配置，运行时仍可读取 `settings.yaml` 里的旧 `system_prompt` 字段；但新配置推荐统一使用 `.openharness/prompts.yaml`。
