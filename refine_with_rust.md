# Open Agent Harness Rust Refinement

## Goal

Use Rust to improve the hot paths that dominate real runtime cost, especially in Docker and self-hosted execution:

- workspace sync
- workspace materialization
- sandbox seed upload
- directory scan / fingerprint / diff planning

TypeScript remains the control plane.
Rust is used only where it gives measurable gains in latency, CPU, memory, I/O, or object-store request count.

## Core Strategy

- keep Rust code under `native/`
- keep a TypeScript fallback for every native path
- optimize the most common runtime path first, not the broadest rewrite
- measure every step with benchmarks before expanding scope

## Mainline Focus

The main optimization line is now:

1. workspace sync
2. workspace materialization
3. sandbox seed upload and prepared-seed reuse

Archive export is still supported, but it is no longer the primary driver of the Rust strategy.

## Current Rust Status

### 1. Native workspace sync is established

`native/oah-workspace-sync` already covers:

- local scan
- fingerprint computation
- local-to-remote sync
- remote-to-local sync
- seed-related planning
- persistent worker mode
- TypeScript bridge integration

### 2. TypeScript fallback has been tightened

The TS path has been pushed closer to the native shape so that fallback mode is still efficient:

- manifest-based sync state
- `bundle-primary` layout
- trusted managed-prefix fast path
- fingerprint reuse after sync
- fewer redundant `HEAD` / `GET` / local rescans

### 3. Native is now actually used on the hot path

Docker and local runtime defaults now enable the main native path:

- `OAH_NATIVE_WORKSPACE_SYNC=1`
- `OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT=1`
- `OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT=primary`
- `OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES=1`

## What Has Already Improved

### Object-store sync

Rust and TS now both support:

- sync manifest reuse
- bundle-backed push / pull / materialize
- lower object-store request count
- lower Node memory pressure

Rust additionally now has:

- persistent worker reuse
- temp-file-backed bundle streaming
- in-memory root-tar fast path for small and medium bundles
- `tar`-first bundle creation
- root-tar fast path now skips building and sorting full file/directory lists when excludes are empty
- request-count reporting
- phase timing reporting
- bridge timing reporting
- worker timing reporting

### Seed upload and workspace initialization

The mainline initializer path now avoids a lot of redundant work:

- prepared seed reuse
- archive fast path for self-hosted sandbox initialization
- archive warming during prepare-seed
- reuse of archive eligibility metrics
- skip unchanged uploads
- clean stale remote entries
- fewer redundant `mkdir` and `stat` calls

## Latest Measured Result

On the current `96 files x 4 KiB` object-storage benchmark:

- TypeScript sidecar:
  cold push `99` requests / about `359ms`
- TypeScript `bundle-primary`:
  cold push `2` requests / about `69ms`
- native persistent:
  cold push `2` requests / about `37ms`
  warm push `1` request / about `3ms`
  materialize `1 GET` / about `15ms`
  pull `1 GET` / about `15ms`

On a larger `1024 files x 4 KiB` object-storage benchmark:

- TypeScript `bundle-primary`:
  cold push about `419ms`
- native persistent:
  cold push about `99ms`
  warm push about `8ms`
  materialize about `119ms`
  pull about `112ms`

This is an important milestone:

- native persistent is no longer only better on warm paths
- native persistent cold push now beats TS `bundle-primary` on the same benchmark path
- native persistent also keeps a strong advantage as file count grows
- after the latest in-memory bundle path, larger-workspace cold push improved again and bundle build/upload both moved down

## Why The Cold Push Improved

The main cold-path bottleneck was not object-store work itself.
It was persistent worker readiness and bridge overhead.

That has now been addressed with:

- explicit worker `ready` handshake
- process-wide worker-pool sharing through `globalThis`
- bootstrap-time worker prewarm

The latest timing breakdown shows:

- `poolInit=0ms`
- `receiveDelay=0ms`
- cold persistent push now spends almost all remaining time inside the real Rust sync command

## Current Position

Rust is now clearly justified on the main workspace path because it already improves:

- cold push
- warm push
- materialize
- pull
- Node RSS on heavy filesystem/object-store workloads

The repo should continue using TS for:

- HTTP / Fastify routing
- orchestration
- model and storage business logic
- rollout and compatibility behavior

The repo should continue using Rust for:

- recursive scan
- fingerprinting
- diff planning
- bundle build/upload/download
- filesystem-heavy sync/materialization execution

## What Still Needs Work

The main remaining work is no longer bridge readiness.
It is command-body optimization and broader proof:

- improve bundle build/upload on larger workspaces
- reduce remaining scan / manifest overhead
- keep improving seed upload and prepared-seed reuse
- validate the same gains under Docker CPU and memory limits
- keep semantics aligned with TS fallback

## Next Steps

### Priority 1. Deepen workspace sync

- optimize larger-workspace bundle build and upload time
- reduce remaining command-body overhead in native sync
- keep pushing request count, CPU, and I/O down on object-store-backed workspaces

### Priority 2. Deepen materialization and seed upload

- reuse more fingerprints and prepared artifacts
- reduce repeated upload/copy work
- keep shrinking sandbox initialization latency and request volume

### Priority 3. Expand Docker proof

- rerun the mainline benchmark under Docker resource limits
- confirm that native persistent remains better on real runtime startup paths

## Rollout Guidance

Current recommendation:

- prefer native persistent workspace sync on Docker and self-hosted runtime paths
- keep TS fallback enabled as the compatibility path
- continue expanding Rust only where benchmarks continue to confirm real wins

## Bottom Line

Rust is no longer just an experiment in this repository.
It is now delivering measurable wins on the main workspace lifecycle path.

The right next move is not to widen Rust usage everywhere.
The right next move is to keep concentrating Rust on the hottest workspace path until larger Docker workloads show the same consistent advantage.
