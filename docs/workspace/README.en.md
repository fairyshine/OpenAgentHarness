# Workspace Overview

The workspace is the main capability boundary in Open Agent Harness.

When a user opens a project, the runtime should discover as much capability as possible from that project instead of forcing large amounts of global configuration.

## When to Read This Page

- you want to create a new workspace
- you want to understand what belongs in `.openharness/`
- you are debugging why an agent, model, or skill was not loaded

## Workspace Kinds

### `project`

- normal project workspace
- can load the full capability set
- can execute tools
- can keep a local history mirror in `.openharness/data/history.db`

### `chat`

- read-only conversational workspace
- only loads static prompt, agent, and model configuration
- does not execute shell, actions, skills, tools, or hooks
- does not create a local history database

## Minimal Workspace Shape

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

## What Gets Auto-Discovered

At run startup, the runtime looks for:

- `AGENTS.md`
- `.openharness/settings.yaml`
- `.openharness/agents/*.md`
- `.openharness/models/*.yaml`
- `.openharness/actions/*/ACTION.yaml`
- `.openharness/skills/*/SKILL.md`
- `.openharness/tools/settings.yaml`
- `.openharness/tools/servers/*`
- `.openharness/hooks/*.yaml`

## Read Next

1. [Settings](./settings.md)
2. [Agents](./agents.md)
3. [Models](./models.md)
4. [Actions](./actions.md)
5. [Skills](./skills.md)
6. [External Tools (MCP-backed)](./mcp.md)
7. [Hooks](./hooks.md)
8. [Loading and Validation](./loading-and-validation.md)

## Translation Note

This page is translated. Some deeper workspace pages may still fall back to Chinese.
