---
title: "Settings"
---

# Settings

`.openharness/settings.yaml` now holds only core workspace configuration: the default agent, optional model aliases, engine behavior toggles, imports, and extra skill directories.

Prompt configuration has moved to the dedicated [`prompts.yaml`](./prompts/) file.

## Minimal Config

```yaml
default_agent: build
```

## Full Example

```yaml
default_agent: build

models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    max_tokens: 2048
  planner:
    ref: workspace/repo-planner

skill_dirs:
  - ./.codex/skills

imports:
  tools:
    - docs-server
  skills:
    - repo-explorer

engine:
  session_memory:
    enabled: false
  workspace_memory:
    enabled: false
```

## Top-Level Fields

| Field | Required | Description |
| --- | --- | --- |
| `default_agent` | No | Default primary agent. At runtime it must resolve to a visible agent and cannot point to a pure `subagent`-only definition |
| `models` | No | Model alias map that agents can reference; when omitted, agents use the platform default model |
| `skill_dirs` | No | Additional skill search directories |
| `engine` | No | Optional runtime engine behavior toggles. `compact` is built in; `session_memory` and `workspace_memory` represent two different memory layers |
| `runtime` | No | Records which runtime the workspace was initialized from |
| `imports` | No | Tools and skills to import during runtime initialization |

> **tip**

    If a runtime needs stable model selection, prefer having agents reference these aliases via `model: <alias>`. Then switching models only requires editing `settings.yaml`.

## `models`

```yaml
models:
  default: platform/openai-default
  cheap: workspace/repo-model
  tuned:
    ref: platform/openai-default
    temperature: 0.2
    top_p: 0.9
    max_tokens: 2048
```

| Rule | Details |
| --- | --- |
| key | Alias used by agent frontmatter, for example `model: default` |
| value shape | Either a shorthand string such as `platform/<name>` / `workspace/<name>` or an object with `ref` plus optional inference defaults |
| `ref` | Concrete model ref, must be `platform/<name>` or `workspace/<name>` |
| `temperature` / `top_p` / `max_tokens` | Default inference parameters for that model alias |
| resolution time | Resolved when the workspace loads; the runtime still operates on concrete `model_ref`s internally |
| scope | Only affects agents that declare a non-default alias or canonical model ref; agents without an explicit model use the platform default model |

If an agent omits `model`, or declares `model: default` while `models.default` is not defined, the runtime uses the platform default model. Other missing aliases still fail during workspace loading.

Use this file to decide both which concrete model each alias points to and which inference defaults it carries; use agent frontmatter only to choose the alias.

## `engine`

```yaml
engine:
  session_memory:
    enabled: true
  workspace_memory:
    enabled: true
```

| Field | Description |
| --- | --- |
| `compact.enabled` | Enables the automatic compaction behavior. It defaults to on and does not need to be configured explicitly. Only set `compact: { enabled: false }` when you want to disable it |
| `session_memory.enabled` | Enables session-scoped memory used for continuity within the current conversation. It is distinct from workspace-persistent memory |
| `workspace_memory.enabled` | Enables workspace-scoped persistent memory. This maps to the `.openharness/memory/` directory |

## `skill_dirs`

```yaml
skill_dirs:
  - ./.codex/skills
  - ./.shared/skills
```

| Rule | Details |
| --- | --- |
| Default directory | `.openharness/skills/*` is always scanned |
| Additive | `skill_dirs` adds directories; it does not replace the default |
| Path resolution | Relative to the workspace root |
| Priority | `.openharness/skills/*` > `skill_dirs` declaration order |
| Name conflict | First match wins by scan order; later directories with the same skill name are ignored |
| Duplicate inside one root | If one skill root resolves to duplicate names, loading fails |

## `imports`

```yaml
imports:
  tools:
    - docs-server
  skills:
    - repo-explorer
```

| Field | Description |
| --- | --- |
| `tools` | Platform tools to copy into the workspace from `paths.tool_dir` |
| `skills` | Platform skills to copy into the workspace from `paths.skill_dir` |

These are only used during runtime initialization. Imported tools and skills are copied into the workspace's own `.openharness/` tree, and the runtime then works from that `Active Workspace Copy` instead of reading the platform directory live. Referencing a nonexistent tool or skill causes initialization to fail.
