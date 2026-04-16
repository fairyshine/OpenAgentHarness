# Settings

`.openharness/settings.yaml` is the main configuration entry point for a workspace.

## Minimal Config

```yaml
default_agent: build
```

This designates the `build` agent as the default primary agent. Everything else is optional.

## Full Example

```yaml
default_agent: build
skill_dirs:
  - ./.codex/skills

system_prompt:
  base:
    inline: |-
      You are Open Agent Harness running inside the current workspace.
      Prefer workspace-local configuration and tools.

  llm_optimized:
    providers:
      openai:
        inline: |-
          Be concise, tool-oriented, and explicit about assumptions.
      anthropic:
        file: ./.openharness/prompts/anthropic.md
    models:
      platform/openai-default:
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
| `default_agent` | No | Default primary agent. Must exist and not be a pure `subagent` |
| `skill_dirs` | No | Additional skill search directories |
| `blueprint` | No | Records which blueprint the workspace was initialized from |
| `imports` | No | Tools/skills to import during blueprint initialization |
| `system_prompt` | No | Workspace-level system prompt configuration |

!!! tip

    Workspaces use one shared structure. Actions and tools become available according to the workspace declaration and runtime capabilities.

## `skill_dirs`

```yaml
skill_dirs:
  - ./.codex/skills
  - ./.shared/skills
```

| Rule | Details |
| --- | --- |
| Default directory | `.openharness/skills/*` is always scanned |
| Additive | `skill_dirs` adds directories; does not replace the default |
| Path resolution | Relative to workspace root |
| Priority | `.openharness/skills/*` > `skill_dirs` in declaration order |
| Cross-tier name conflict | Warning logged, higher priority wins |
| Same-tier name conflict | Config error, loading fails |

## `system_prompt`

Controls how the system prompt is assembled.

### `base`

Workspace-level base prompt. Supports `inline` or `file` (mutually exclusive):

```yaml
base:
  inline: |-
    You are Open Agent Harness.
```

```yaml
base:
  file: ./.openharness/prompts/base.md
```

File paths resolve relative to the workspace root. Recommended extensions: `.md` or `.txt`.

### `llm_optimized`

Provider- or model-specific prompt optimizations:

```yaml
llm_optimized:
  providers:
    openai:
      inline: |-
        Be concise and tool-oriented.
  models:
    platform/openai-default:
      file: ./.openharness/prompts/openai-default.md
```

| Rule | Details |
| --- | --- |
| Priority | `models` exact match > `providers` |
| Provider key | AI SDK provider identifier |
| Model key | Full `model_ref` |

### `compose`

Controls the assembly order of static system prompt segments:

```yaml
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

Available segments: `base`, `llm_optimized`, `agent`, `actions`, `project_agents_md`, `skills`

| Rule | Details |
| --- | --- |
| `system_reminder` | Not configured here; injected dynamically by the runtime |
| `actions` | Auto-skipped if the current agent has no visible actions |
| `project_agents_md` | Auto-skipped if `AGENTS.md` does not exist |
| `skills` | Auto-skipped if the current agent has no visible skills |
| `include_environment` | Whether to append a runtime environment summary (default: `false`) |

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

Only used during blueprint initialization. After import, the workspace uses its local copy and no longer depends on the platform directory. Referencing a nonexistent tool or skill causes initialization to fail.
