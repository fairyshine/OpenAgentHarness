# Overview

This page is the top-level guide into the current design documents.

If you are new to the project, start here before diving into the lower-level specifications.

## Three Core Concepts

- `workspace`: the capability boundary
- `session`: the conversation/context boundary
- `run`: the execution boundary

If you keep those three concepts clear, the runtime, queueing, API, and audit documents become much easier to read.

## Read by Topic

### System Design

- [Architecture Overview](./architecture-overview.md)
- [Domain Model](./domain-model.md)
- [Server Config](./server-config.md)
- [Deploy and Run](./deploy.md)
- [Debug CLI / TUI](./debug-cli-tui.md)

### Workspace Model

- [Workspace Overview](./workspace/README.md)
- [Workspace Spec Index](./workspace-spec.md)
- [Models](./workspace/models.md)
- [Skills](./workspace/skills.md)
- [External Tools (MCP-backed)](./workspace/mcp.md)
- [Hooks](./workspace/hooks.md)

### Runtime

- [Runtime Overview](./runtime/README.md)
- [Runtime Design](./runtime-design.md)
- [Lifecycle](./runtime/lifecycle.md)
- [Context Engine](./runtime/context-engine.md)
- [Queue and Reliability](./runtime/queue-and-reliability.md)
- [Events and Audit](./runtime/events-and-audit.md)

### External Interfaces

- [API Design](./api-design.md)
- [OpenAPI Overview](./openapi/README.md)
- [Schemas Overview](./schemas/README.md)

## Read by Role

### Platform Engineers

1. [Architecture Overview](./architecture-overview.md)
2. [Workspace Overview](./workspace/README.md)
3. [Runtime Overview](./runtime/README.md)
4. [API Design](./api-design.md)

### Product or Integration Teams

1. [Quick Start](./getting-started.md)
2. [Deploy and Run](./deploy.md)
3. [OpenAPI Overview](./openapi/README.md)
4. [Streaming](./openapi/streaming.md)

### Troubleshooting

1. [Deploy and Run](./deploy.md)
2. [Lifecycle](./runtime/lifecycle.md)
3. [Queue and Reliability](./runtime/queue-and-reliability.md)
4. [Events and Audit](./runtime/events-and-audit.md)

## Translation Note

Not every deep design page is translated yet. When no English page exists, the English site currently falls back to the Chinese source page.
