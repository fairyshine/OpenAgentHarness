# API Reference

The HTTP API is built on REST resource endpoints + SSE event streams. The [openapi.yaml](./openapi.yaml) file is the authoritative interface definition.

## Conventions

- Public API: `/api/v1`
- Internal model gateway: `/internal/v1/models/*` (loopback only, no `Authorization`)
- Host can inject a caller context resolver; without one, standalone server uses minimal caller context
- Async entry points (send message, trigger action) return `202`
- Streaming uses SSE
- Final execution status determined by the run resource
- Sending a session message is non-interrupting by default; pass `runningRunBehavior: "interrupt"` if you want the new message to cancel the current active run first
- The follow-up message queue is a server-side resource. Read it with `GET /sessions/{id}/queue`, and promote an already queued message with `POST /runs/{id}/guide`

Key boundaries: `session` = context boundary, `run` = execution boundary, runs within a session are serial.

File and command endpoints intentionally keep [E2B](https://github.com/e2b-dev/E2B)-style sandbox semantics: routes live under `/sandboxes`, and sandbox roots are exposed as `/workspace`. This is a stable interface contract, not a temporary compatibility layer. The `/workspaces` API still remains for workspace metadata, catalog, and lifecycle concerns.

## Start Here

- Overall API shape: endpoint tables below
- Concrete schema: [openapi.yaml](./openapi.yaml)
- Message sending + execution: read [sessions.md](./sessions.md), [runs.md](./runs.md), [streaming.md](./streaming.md) together
- File management: [files.md](./files.md)

## Module Documentation

| Document | Content |
| --- | --- |
| [openapi.yaml](./openapi.yaml) | OpenAPI 3.1 specification |
| [workspaces.md](./workspaces.md) | Workspace, catalog, model visibility |
| [sessions.md](./sessions.md) | Sessions and messages |
| [runs.md](./runs.md) | Run lookup, cancellation, and queued-run guide |
| [actions.md](./actions.md) | Manual action triggering |
| [files.md](./files.md) | Sandbox file management and commands |
| [models.md](./models.md) | Model gateway |
| [streaming.md](./streaming.md) | SSE event streaming |
| [components.md](./components.md) | Shared schemas and error models |

The OpenAPI file is the interface source of truth. The Markdown pages explain intent, boundaries, and behavior.
