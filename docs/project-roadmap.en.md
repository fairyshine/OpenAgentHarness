# Project Roadmap

## Related Docs

- [Architecture Overview](./architecture-overview.en.md) -- product and system boundaries
- [Quick Start](./getting-started.md) / [Deploy and Run](./deploy.md) -- startup and deployment
- [Implementation Roadmap](./implementation-roadmap.md) -- historical phased plan

## Current Focus

- Keep runtime truth boundaries consistent across implementation, design docs, and OpenAPI spec
- Evaluate more aggressive recovery strategies (auto-requeue / resume) as needed; currently fail-closed only
- Deferred capabilities remain candidates, not commitments: Unix socket model runtime, first-class `action_run` / `artifact`

## Repository Roadmap

The repository root no longer maintains a separate `ROADMAP.md`.

Current status and forward direction now live in the docs site:

- This page tracks the current state and near-term focus
- [Implementation Roadmap](./implementation-roadmap.md) keeps the historical implementation order
- [Runtime / Worker execution-layer roadmap](./engine/worker-scaling-roadmap.md) continues to hold worker / scaling / control-plane specific evolution notes
