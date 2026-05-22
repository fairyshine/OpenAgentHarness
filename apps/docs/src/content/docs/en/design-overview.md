---
title: "Design Overview"
---

# Design Overview

Navigation hub for the Open Agent Harness design documents.

## Terminology

- [Terminology](./terminology/) -- shared boundaries for `Agent Engine`, `Agent Runtime`, and `Agent Spec`
- [Concept Relationships](./concept-relationships/) -- one map for `Workspace`, `Worker`, `Sandbox`, and `Runtime`

## Three Core Concepts

| Concept | Role | Description |
|---------|------|-------------|
| **Workspace** | Capability boundary | Each workspace declares its own agents, models, tools, skills, actions, and hooks, and uses one consistent directory structure for discovery and execution. |
| **Session** | Context boundary | A continuous conversation or task collaboration, scoped to a workspace. |
| **Run** | Execution boundary | One model inference + tool loop. Runs are serial within a session. |

## Read by Topic

### Architecture and Domain

- [Architecture Overview](./architecture-overview/) -- layers, modules, request flow
- [Domain Model](./domain-model/) -- core objects and relationships
- [Storage Design](./storage-design/) -- PostgreSQL / Redis / SQLite responsibilities

### Workspace Configuration

- [Workspace Overview](./workspace/)
- [Settings](./workspace/settings/) | [Agents](./workspace/agents/) | [Models](./workspace/models/)
- [Skills](./workspace/skills/) | [External Tools](./workspace/mcp/) | [Hooks](./workspace/hooks/)

### Engine

- [Engine Overview](./engine/)
- [Lifecycle](./engine/lifecycle/) | [Context Engine](./engine/context-engine/)
- [Queue and Reliability](./engine/queue-and-reliability/) | [Events and Audit](./engine/events-and-audit/)

### External Interfaces

- [API Reference](./openapi/) | [Schemas Overview](./schemas/)

### Deployment

- [Quick Start](./getting-started/) | [Deploy and Run](./deploy/) | [Server Config](./server-config/)

## Read by Role

### Platform Engineers

1. [Architecture Overview](./architecture-overview/)
2. [Terminology](./terminology/)
3. [Concept Relationships](./concept-relationships/)
4. [Domain Model](./domain-model/)
5. [Workspace Overview](./workspace/)
6. [Engine Overview](./engine/)

### Product / Integration Teams

1. [Quick Start](./getting-started/)
2. [Deploy and Run](./deploy/)
3. [API Reference](./openapi/)
4. [Streaming](./openapi/streaming/)

### Troubleshooting

1. [Deploy and Run](./deploy/)
2. [Lifecycle](./engine/lifecycle/)
3. [Queue and Reliability](./engine/queue-and-reliability/)
4. [Events and Audit](./engine/events-and-audit/)

## Translation Note

Not every page has an English translation yet. When no English page exists, the site falls back to the Chinese source.
