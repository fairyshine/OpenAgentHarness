# Agents

There are two types of agent-related files in a workspace, aimed at different roles:

| File | Audience | Purpose |
| --- | --- | --- |
| `AGENTS.md` (workspace root) | **Users** | Project description — tells agents what this project is about |
| `.openharness/agents/*.md` | **Developers** | Agent behavior definitions — configures roles, models, tool permissions, switching rules |

---

## AGENTS.md — User-Authored Project Description

`AGENTS.md` lives at the workspace root. It is a **project context document** for agents. It does not control agent behavior — it provides background information.

The runtime injects the full text of `AGENTS.md` into the system prompt (no summarization or trimming), so agents understand the current project.

**What to write:**

- Project goals and background
- Directory structure
- Coding conventions
- Build, test, and deploy commands
- Common pitfalls

**What not to write:**

- Structured config DSLs
- Permission rules
- Executable process definitions

!!! tip

    Think of `AGENTS.md` as "an onboarding doc for a new teammate," not a config file.

---

## `.openharness/agents/*.md` — Developer-Defined Agent Behavior

Agents are defined in `.openharness/agents/*.md` using Markdown with YAML frontmatter. These files are authored by **developers** and control how each agent behaves:

- Filename is the agent name (e.g., `builder.md` -> agent name `builder`)
- YAML frontmatter carries structured config
- Markdown body is the main system prompt
- If a workspace agent shares a name with a platform built-in agent, the workspace agent wins

### Basic Example

```md
---
mode: primary
description: Implement requested changes in the current workspace
model: default
system_reminder: |
  You are now acting as the builder agent.
  Focus on making concrete code changes.
tools:
  native:
    - Bash
    - Read
    - Write
    - Edit
    - Glob
    - Grep
  actions:
    - code.review
  skills:
    - repo.explorer
  external:
    - docs-server
switch:
  - plan
subagents:
  - code-reviewer
policy:
  max_steps: 40
  run_timeout_seconds: 1800
---

# Builder

You are a pragmatic software engineering agent.
Prefer making concrete progress in the current workspace.
```

### Frontmatter Fields

| Field | Required | Description |
| --- | --- | --- |
| `mode` | No | `primary`, `subagent`, or `all`. Default: `primary` |
| `description` | No | Short description of the agent |
| `model` | Recommended | Model alias or direct model reference |
| `system_reminder` | No | Reminder injected after agent switch |
| `tools` | No | Allowlist of native tools, actions, skills, external tools |
| `switch` | No | Agents this agent can switch to within a run |
| `subagents` | No | Agents this agent can delegate to |
| `policy` | No | Step limits, timeouts, concurrency constraints |

**`mode` semantics:**

| Value | Description |
| --- | --- |
| `primary` | Can be the session's main agent or a switch target |
| `subagent` | Primarily a delegation target; not recommended as a switch target |
| `all` | Can serve as both primary and subagent (use with caution) |

Fields not placed in frontmatter: `name` (redundant with filename), `context` (runtime-assembled), `hooks` (runtime extension).

### Body Rules

- The Markdown body is the main system prompt; the runtime preserves it as-is
- An empty body is treated as an incomplete definition
- Supports Chinese and other Unicode characters
- Native tools use Title Case: `Bash`, `Read`, `TodoWrite`

## Control Fields

### `model`

```yaml
model: default
```

| Field | Description |
| --- | --- |
| `model` | Alias declared in `settings.yaml -> models`; direct `model_ref` is also accepted for compatibility |

The runtime resolves `model` to a concrete `model_ref` during load. Model parameters such as `temperature`, `top_p`, and `max_tokens` should be configured under `settings.yaml -> models.<alias>`. Legacy `model: { alias: ... }`, `model_ref`, and frontmatter-level model params are still accepted for compatibility.

`model` is the only recommended-required structured field in frontmatter.

### `tools`

```yaml
tools:
  native:
    - Bash
    - Read
  actions:
    - code.review
  skills:
    - repo.explorer
  external:
    - docs-server
```

| Sub-field | Description |
| --- | --- |
| `native` | Built-in tools |
| `actions` | Workspace actions |
| `skills` | Workspace skills |
| `external` | MCP tool servers |

- `native` must be explicitly declared; omitted `native` exposes no built-in tools
- Omitted `external`, `actions`, and `skills` inherit the default capabilities discovered in the current workspace
- An explicit empty array disables that capability class, for example `external: []` does not fall back to default MCP servers
- Expresses an allowlist only, not execution logic
- Parsed uniformly from the workspace declaration

### `switch`

```yaml
switch:
  - plan
  - build
```

- Each entry is a target agent name; target should be `mode: primary` or `mode: all`
- Without `switch`, the agent cannot initiate switches
- The runtime validates targets against this list before executing `agent.switch`

### `subagents`

```yaml
subagents:
  - repo-explorer
  - code-reviewer
```

- Each entry is a subagent this agent can delegate to; target should be `mode: subagent` or `mode: all`
- Without `subagents`, the agent cannot delegate
- The runtime validates targets before executing `agent.delegate`
- Availability is determined by workspace declarations and runtime configuration

### `policy`

```yaml
policy:
  max_steps: 40
  run_timeout_seconds: 1800
  tool_timeout_seconds: 120
  parallel_tool_calls: true
  max_concurrent_subagents: 3
```

| Field | Description |
| --- | --- |
| `max_steps` | Maximum reasoning steps |
| `run_timeout_seconds` | Total run timeout |
| `tool_timeout_seconds` | Per-tool execution timeout |
| `parallel_tool_calls` | Whether to allow parallel tool calls |
| `max_concurrent_subagents` | Maximum concurrent subagents |

Do not add complex routing, retry logic, or conditional expressions to `policy`.

### `system_reminder`

A reminder segment injected when switching agents.

**Injection triggers:**

- `AgentSwitch` within the same run
- First message after the user manually updates `activeAgentName`

**Injection format:**

```text
<system_reminder>
{standard switch prompt + agent.system_reminder}
</system_reminder>
```

| Rule | Details |
| --- | --- |
| Location | Latest user message, not the system prompt |
| Frequency | Once after switch; not repeated on subsequent turns |
| On session creation | Not injected |
| Content suggestions | Role switch reminders, boundary notes, tool preferences |

## Example: Three-Agent Collaboration

### `.openharness/agents/plan.md`

```md
---
mode: primary
description: Analyze tasks and create implementation plans
model: default
tools:
  native:
    - Read
    - Glob
    - Grep
switch:
  - build
---

# Planner

Analyze the user's request, explore the codebase,
and produce a clear implementation plan. When ready,
switch to the builder agent.
```

### `.openharness/agents/build.md`

```md
---
mode: primary
description: Implement changes in the workspace
model: default
tools:
  native:
    - Bash
    - Read
    - Write
    - Edit
    - Glob
    - Grep
switch:
  - plan
subagents:
  - reviewer
policy:
  max_steps: 40
---

# Builder

Make concrete code changes based on the plan.
When done, delegate to the reviewer for a code review.
```

### `.openharness/agents/reviewer.md`

```md
---
mode: subagent
description: Review code changes
model: default
tools:
  native:
    - Read
    - Glob
    - Grep
---

# Reviewer

Review recent changes for bugs, style issues,
and missing edge cases. Return a structured review.
```

### Collaboration Flow

1. User sends a message; session uses `plan` agent by default
2. Planner analyzes the request and creates a plan
3. Planner switches to `build` via `agent.switch`
4. Builder implements code changes
5. Builder delegates to `reviewer` via `agent.delegate`
6. Reviewer reviews code in a child session and returns findings
7. Builder applies fixes if needed and completes the run
