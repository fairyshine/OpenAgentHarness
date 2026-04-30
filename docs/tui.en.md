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

After the local stack is running, connect the TUI to the local API:

```bash
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

The current CLI includes:

```text
oah
  tui
  workspace:list
  workspaces
  catalog:show --workspace <id>
```

Use `workspace:list` / `workspaces` to list visible workspaces, `catalog:show` to inspect a workspace catalog as JSON, and `tui` to enter the interactive terminal interface.

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
