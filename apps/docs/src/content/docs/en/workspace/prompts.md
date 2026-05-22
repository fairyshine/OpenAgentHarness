---
title: "Prompts"
---

# Prompts

`.openharness/prompts.yaml` stores workspace-level prompt configuration.

It contains what used to live under `system_prompt` in `settings.yaml`, but now lives in its own file so runtime settings and prompt text can be managed separately.

## Full Example

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

## Top-Level Fields

| Field | Required | Description |
| --- | --- | --- |
| `base` | No | Workspace-level base prompt |
| `llm_optimized` | No | Provider- or model-alias-specific prompt additions |
| `compose` | No | Assembly order for static system prompt segments |

## `base`

Supports either `inline` or `file`:

```yaml
base:
  inline: |-
    You are Open Agent Harness.
```

```yaml
base:
  file: ./.openharness/prompts/base.md
```

`file` paths resolve relative to the workspace root.

## `llm_optimized`

Prompt additions can target either providers or model aliases:

```yaml
llm_optimized:
  providers:
    openai:
      inline: Be concise and tool-oriented.
  models:
    default:
      file: ./.openharness/prompts/openai-default.md
```

| Rule | Details |
| --- | --- |
| Priority | `models` exact match > `providers` |
| Provider key | AI SDK provider identifier |
| Model key | Alias declared in `settings.yaml -> models`; resolved to a concrete `model_ref` during load |

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

Available segments:

- `base`
- `llm_optimized`
- `agent`
- `actions`
- `project_agents_md`
- `skills`
- `agent_switches`
- `subagents`
- `environment`

| Rule | Details |
| --- | --- |
| `system_reminder` | Not configured here; injected dynamically by the runtime |
| `actions` | Auto-skipped when the current agent has no visible actions |
| `project_agents_md` | Auto-skipped when `AGENTS.md` is absent |
| `skills` | Auto-skipped when the current agent has no visible skills |
| `include_environment` | Whether to append a runtime environment summary (default: `false`) |

> **note**

    For compatibility, the runtime still accepts legacy `system_prompt` config in `settings.yaml`; new configurations should prefer `.openharness/prompts.yaml`.
