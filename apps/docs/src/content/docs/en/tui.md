---
title: "TUI Client"
---

# TUI Client

## Positioning

OpenAgentHarness is still a headless runtime and does not ship a formal product UI.

The repository includes a lightweight `oah` terminal client. CLI commands and `tui` are two modes of the same entry point:

- CLI commands: scriptable, one-shot query commands.
- TUI mode: real-time observation and interactive operation.

It is meant to be:

- a TUI client
- a local development tool
- an operations and observation tool

It is not:

- a polished terminal product
- an end-user chat client
- a management UI

## Current Entry Point

By default, the TUI connects to the local OAP daemon. If the daemon is not running yet, it attempts to start it first:

```bash
cd /path/to/repo
pnpm dev:cli -- tui
pnpm dev:cli -- tui --runtime vibe-coding
pnpm dev:cli -- tui --new-session
pnpm dev:cli -- tui --resume-last
```

When `--base-url` is omitted, `oah tui` registers or reuses the current directory as a local workspace. `--runtime <name>` only bootstraps the repo when `.openharness/` is absent; existing OAS config is left untouched.

After entering a workspace, the TUI resumes the most recent session by default; if the workspace has no sessions, it creates one automatically. Use `--new-session` to explicitly start fresh, or `--resume-last` to explicitly resume the latest conversation. The session picker shows the latest run state such as `queued`, `running`, or `completed` so it is clear whether to wait, resume, or create a new session.

When connecting to a remote or enterprise OAH server, pass `--base-url` explicitly:

```bash
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

The current CLI includes:

```text
oah
  version
  update [version]
  rollback [version]
  daemon init|start|status|stop|restart|logs|state|maintenance
  web
  models list|add|default
  runtimes list
  tools list
  skills list
  tui [--workspace <path>] [--runtime <name>] [--new-session|--resume-last]
  workspace:list
  workspaces
  workspace:list --missing
  workspace repair <workspace-id> [--workspace <path>]
  workspaces repair <workspace-id> [--workspace <path>]
  workspaces:repair <workspace-id> [--workspace <path>]
  workspace cleanup <workspace-id> [--dry-run] [--force] [--include-history] [--yes]
  workspaces cleanup <workspace-id> [--dry-run] [--force] [--include-history] [--yes]
  workspaces:cleanup <workspace-id> [--dry-run] [--force] [--include-history] [--yes]
  workspace migrate-history [workspace-id] [--workspace <path>] [--dry-run] [--overwrite]
  workspaces migrate-history [workspace-id] [--workspace <path>] [--dry-run] [--overwrite]
  catalog:show --workspace <id>
  tools enable <name> [--workspace <path>] [--dry-run] [--overwrite]
  skills enable <name> [--workspace <path>] [--dry-run] [--overwrite]
```

Use `version` to inspect the CLI and local release installation, `update` to download a GitHub Release tarball and switch `OAH_HOME/current`, and `rollback` to switch back to an installed version. Use `workspace:list` / `workspaces` to list visible workspaces, `workspace:list --missing` to filter local records whose root path no longer exists, `workspace repair <workspace-id> --workspace /new/path` to rebind a moved repo, and `workspace cleanup <workspace-id>` to remove cleanup-safe materialized/cache state without deleting history. To delete that workspace's session/run/event history, preview with `--include-history --dry-run`, then rerun with `--include-history` and type the workspace id to confirm. `workspace migrate-history` copies early repo-local `.openharness/data/history.db` into OAP shadow storage, `catalog:show` inspects a workspace catalog as JSON, and `tui` enters the interactive terminal interface. When connected to an OAP local daemon, `oah tui` registers or reuses the current directory by default, and `--workspace /path/to/repo` can point it at a different repo. `web` starts the WebUI against the same OAH-compatible API. The `models`, `runtimes`, `tools`, and `skills` commands manage or inspect local assets under `OAH_HOME`; tools and skills remain a global catalog until `tools enable` / `skills enable` writes them into a repo's `.openharness` directory. WebUI and TUI then show the workspace catalog that is actually enabled for that repo.

## Why TUI

Compared with a product web UI, a TUI fits the current system especially well:

- it matches the headless-runtime positioning
- it works naturally from a repository, server shell, or local terminal
- it can reuse the existing HTTP and SSE APIs
- it is convenient for working with actions, model runtime behavior, hooks, runs, and streaming output

## Shape

The terminal client has one binary entry point:

- `oah`

The modes are:

- CLI commands
  - scriptable, one-shot query commands
- TUI mode
  - real-time observation and interactive operation

## Relationship To The System

The `oah` terminal client consumes existing capabilities and does not introduce a parallel runtime.

It mainly depends on:

- external OpenAPI endpoints
- SSE streams
- internal model runtime endpoints where explicitly needed
- server-side catalog discovery results

Principles:

- reuse HTTP / SSE APIs whenever possible
- keep terminal UI state separate from backend contracts
- keep the main TUI centered on the current workspace and current session

## Boundaries

The `oah` terminal client does not own:

- user management
- multi-tenant administration
- permission management
- long-term chat product experience

It only owns:

- usage
- verification
- observation
- operations

## Roadmap

Recommended next steps:

1. Stabilize `workspace:list`, `catalog:show`, and `oah tui`
2. Add non-interactive `session inspect`, `run inspect`, and `model generate`
3. Strengthen TUI views for run timelines, tool calls, prompt composition, and catalog inspection
4. Add deeper troubleshooting views for hooks, subagents, and action environment summaries
