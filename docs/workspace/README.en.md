# Workspace

The workspace is the primary capability boundary. When a user opens a project, the runtime auto-discovers all capabilities from the project root -- no global configuration required.

## Workspace Kind

There is one standard workspace shape. A workspace declares agents, models, actions, skills, tools, and hooks in one consistent directory structure, and the runtime discovers and executes them uniformly.

## Directory Structure

Full structure:

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

Minimal viable structure:

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

## Auto-Discovery

The runtime scans these paths at run startup:

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Project description, injected into system prompt |
| `.openharness/settings.yaml` | Main config entry point |
| `.openharness/agents/*.md` | Agent definitions |
| `.openharness/models/*.yaml` | Model entries |
| `.openharness/actions/*/ACTION.yaml` | Action definitions |
| `.openharness/skills/*/SKILL.md` | Skill definitions |
| `.openharness/tools/settings.yaml` | MCP tool server registry |
| `.openharness/tools/servers/*` | Local tool server code |
| `.openharness/hooks/*.yaml` | Hook definitions |

!!! info

    `.openharness/data/` is a runtime-managed directory and is not part of capability discovery. `history.db` only stores local runtime data and is not a cross-process sync mechanism.

**Merge rules:**

- Platform built-in agents and workspace agents merge into a visible catalog; workspace wins on name conflict
- Platform and workspace model entries merge (no override)
- Agents must reference models via explicit `model_ref`
- Explicit parameters can only select from the current catalog, not extend it
- If no `default_agent` is declared and the caller does not specify one, a config error is returned

## FAQ

**Why is `.openharness/data/` excluded from config parsing?**

It is a runtime-managed directory. `history.db` is only a local runtime data file, not an external source-of-truth interface.
