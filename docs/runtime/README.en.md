# Runtime Overview

The runtime is responsible for turning an incoming request into a traceable, recoverable, auditable run.

## What the Runtime Has to Solve

- transform caller input into executable runs
- enforce per-session serialization
- discover workspace capabilities and build context
- map model tool calls to Actions, Skills, external tools, and native tools
- handle timeout, cancellation, logging, audit, and streaming
- sync central history into `.openharness/data/history.db`

## Read by Goal

### Main execution flow

1. [Lifecycle](./lifecycle.md)
2. [Context Engine](./context-engine.md)
3. [Projection and Executors](./projection-and-executors.md)

### Reliability and governance

1. [Queue and Reliability](./queue-and-reliability.md)
2. [Events and Audit](./events-and-audit.md)
3. [Hook Runtime](./hook-runtime.md)

### Execution environment

1. [Execution Backend](./execution-backend.md)
2. [Model Gateway](./model-gateway.md)

## Translation Note

This page is translated. Some lower-level runtime design pages may still fall back to Chinese.
