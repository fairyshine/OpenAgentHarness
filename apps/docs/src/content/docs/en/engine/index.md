---
title: "Engine Overview"
---

# Engine Overview

The engine turns an incoming request into a traceable, recoverable, auditable run.

Core flow: request → queue → context build → LLM loop → tool dispatch → result.

## Read by Goal

### Main execution flow

1. [Lifecycle](./lifecycle/) — Run lifecycle and state transitions
2. [Context Engine](./context-engine/) — Context assembly
3. [Message Projections](./message-projections/) — Message layering and projections
4. [Projection and Executors](./projection-and-executors/) — Capability registry and executors

### Reliability and governance

1. [Queue and Reliability](./queue-and-reliability/) — Queue, locks, and failure recovery
2. [Events and Audit](./events-and-audit/) — SSE events and audit trail
3. [Hook Runtime](./hook-runtime/) — Hook system

### Execution environment

1. [Execution Backend](./execution-backend/) — Execution backend abstraction
2. [Model Runtime](./model-runtime/) — Internal model runtime
3. [Rust Hot Paths](./rust-hot-paths/) — Rust native hot-path boundaries and phase conclusions
