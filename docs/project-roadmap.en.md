# Project Roadmap

## Related Docs

- [Architecture Overview](./architecture-overview.en.md) -- product and system boundaries
- [Quick Start](./getting-started.md) / [Deploy and Run](./deploy.md) -- startup and deployment
- [Implementation Roadmap](./implementation-roadmap.md) -- historical phased plan
- [Rust Hot Paths](./engine/rust-hot-paths.md) -- decision boundaries and next measurement focus for native workspace sync

## Current Focus

- Keep runtime truth boundaries consistent across implementation, design docs, and OpenAPI spec
- Keep hardening the OAP release/install path: release tarball / registry install, clean-install smoke, runtime assets and WebUI asset packaging checks
- Evaluate more aggressive recovery strategies (auto-requeue / resume) as needed; currently fail-closed only
- Deferred capabilities remain candidates, not commitments: Unix socket model runtime, first-class `action_run` / `artifact`

## Remaining OAP Release Work

OAP (Open Agent Harness Personal) still exposes the same OAH-compatible API. The local personal deployment path is `oah daemon`, a SQLite/local-disk profile, embedded workers, and shared WebUI/TUI/Desktop clients.

Only these release-engineering items remain tracked here:

- Desktop distribution hardening: macOS signing / notarization, auto-update, daemon supervisor panel, endpoint profile switcher, installer smoke tests
- Package publishing: decide which `@oah/*` packages stop being `private`, define npm / registry publishing order and version sync rules
- Pre-release gates: clean-install smoke, packed tarball content checks, runtime assets / WebUI assets / server entrypoint checks
- Supply-chain hardening: package signing, SBOM, release provenance

## Repository Roadmap

The repository root no longer maintains separate `ROADMAP.md` files or long phase notes.

Current status and forward direction now live in the docs site:

- This page tracks the current state and near-term focus
- [Implementation Roadmap](./implementation-roadmap.md) keeps the historical implementation order
- [Runtime / Worker execution-layer roadmap](./engine/worker-scaling-roadmap.md) continues to hold worker / scaling / control-plane specific evolution notes
- [Rust Hot Paths](./engine/rust-hot-paths.md) carries the native workspace sync phase conclusion; the full experiment log is no longer kept at the repository root
