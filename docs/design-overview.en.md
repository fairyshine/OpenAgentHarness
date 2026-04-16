# Design Overview

Navigation hub for the Open Agent Harness design documents.

## Three Core Concepts

| Concept | Role | Description |
|---------|------|-------------|
| **Workspace** | Capability boundary | Each workspace declares its own agents, models, tools, skills, actions, and hooks, and uses one consistent directory structure for discovery and execution. |
| **Session** | Context boundary | A continuous conversation or task collaboration, scoped to a workspace. |
| **Run** | Execution boundary | One model inference + tool loop. Runs are serial within a session. |

## Read by Topic

### Architecture and Domain

- [Architecture Overview](./architecture-overview.en.md) -- layers, modules, request flow
- [Domain Model](./domain-model.md) -- core objects and relationships
- [Storage Design](./storage-design.md) -- PostgreSQL / Redis / SQLite responsibilities

### Workspace Configuration

- [Workspace Overview](./workspace/README.md)
- [Settings](./workspace/settings.md) | [Agents](./workspace/agents.md) | [Models](./workspace/models.md)
- [Skills](./workspace/skills.md) | [External Tools](./workspace/mcp.md) | [Hooks](./workspace/hooks.md)

### Runtime

- [Runtime Overview](./runtime/README.md)
- [Lifecycle](./runtime/lifecycle.md) | [Context Engine](./runtime/context-engine.md)
- [Queue and Reliability](./runtime/queue-and-reliability.md) | [Events and Audit](./runtime/events-and-audit.md)

### External Interfaces

- [API Reference](./openapi/README.md) | [Schemas Overview](./schemas/README.md)

### Deployment

- [Quick Start](./getting-started.md) | [Deploy and Run](./deploy.md) | [Server Config](./server-config.md)

## Read by Role

### Platform Engineers

1. [Architecture Overview](./architecture-overview.en.md)
2. [Domain Model](./domain-model.md)
3. [Workspace Overview](./workspace/README.md)
4. [Runtime Overview](./runtime/README.md)

### Product / Integration Teams

1. [Quick Start](./getting-started.md)
2. [Deploy and Run](./deploy.md)
3. [API Reference](./openapi/README.md)
4. [Streaming](./openapi/streaming.md)

### Troubleshooting

1. [Deploy and Run](./deploy.md)
2. [Lifecycle](./runtime/lifecycle.md)
3. [Queue and Reliability](./runtime/queue-and-reliability.md)
4. [Events and Audit](./runtime/events-and-audit.md)

## Translation Note

Not every page has an English translation yet. When no English page exists, the site falls back to the Chinese source.
