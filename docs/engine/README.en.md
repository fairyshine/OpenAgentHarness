# Engine Overview

The engine turns an incoming request into a traceable, recoverable, auditable run.

Core flow: request → queue → context build → LLM loop → tool dispatch → result.

## Read by Goal

### Main execution flow

1. [Lifecycle](./lifecycle.md) — Run lifecycle and state transitions
2. [Context Engine](./context-engine.md) — Context assembly
3. [Message Projections](./message-projections.md) — Message layering and projections
4. [Projection and Executors](./projection-and-executors.md) — Capability registry and executors

### Reliability and governance

1. [Queue and Reliability](./queue-and-reliability.md) — Queue, locks, and failure recovery
2. [Events and Audit](./events-and-audit.md) — SSE events and audit trail
3. [Hook Runtime](./hook-runtime.md) — Hook system

### Execution environment

1. [Execution Backend](./execution-backend.md) — Execution backend abstraction
2. [Model Runtime](./model-runtime.md) — Internal model runtime
