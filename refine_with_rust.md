# Open Agent Harness Rust Refinement

## Goal

Keep TypeScript as the control plane, and use Rust only for the paths that matter most to real runtime cost:

- workspace sync
- workspace materialization
- sandbox seed upload
- directory scan / fingerprint / diff planning

The objective is not to rewrite the server in Rust.
The objective is to reduce Docker CPU, memory, and I/O pressure on the hottest local-system paths while keeping TypeScript in charge of orchestration and fallback behavior.

## Current Direction

- Rust code lives under `native/`
- integration stays sidecar-binary first
- every native path keeps a TypeScript fallback
- only keep pushing Rust where benchmarks justify it

## Priority Order

### Priority 1. Workspace Sync And Materialization

This is now the main line of optimization work.

Why:

- it is much more common than archive export
- it directly affects workspace startup, restore, pull, push, and sandbox preparation
- it is one of the most Docker-sensitive parts of the system
- it spends real time in filesystem walk, hashing, diffing, and object-store transfer planning

Main files today:

- `apps/server/src/object-storage.ts`
- `apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts`

### Priority 2. Seed Upload And Prepared Workspace Reuse

This is part of the same main path, not a side quest.

Why:

- repeated sandbox startup can amplify scan and upload costs
- prepared seed cache quality has direct impact on cold-start and rebuild cost
- reducing unnecessary upload and copy work can save both time and Docker resources

### Priority 3. Archive Export

Archive export remains useful, and Rust already works there, but it is no longer the primary focus.

Why:

- it is a background export path
- it is not the main user-facing or container-hot path
- it should be improved only after the higher-frequency workspace path is stronger

## Current Rust Status

### 1. Workspace Sync

`native/oah-workspace-sync` already exists and is integrated.

Current coverage:

- directory scan
- fingerprint computation
- local-to-remote sync planning and execution
- remote-to-local sync planning and execution
- seed-related planning/integration
- TypeScript bridge and fallback path

Current judgment:

- functionally correct
- valuable for reducing Node-side RSS in larger filesystem-heavy cases
- not yet good enough to become the default execution path
- persistent-worker groundwork now exists in the native bridge and Rust binary, but it remains experimental and is not enabled by default

### 2. Archive Export

`native/oah-archive-export` is implemented and currently the most polished Rust path.

Current coverage:

- sqlite bundle writing
- checksum writing
- export-root inspection
- line-delimited streaming bridge
- persistent native worker
- worker-pool mode
- TypeScript fallback

Current judgment:

- works well
- has a real measured win in backlog export scenarios
- should stay available
- should not drive the overall Rust strategy anymore

## Current Decisions

### Keep In TypeScript

These remain TS-first:

- HTTP and Fastify routing
- session and run orchestration
- model gateway integration
- Redis/Postgres business logic
- feature flags and rollout policy

### Push Deeper Into Rust

These are the important native candidates:

- recursive directory walk
- fingerprint and hashing
- local/remote diff planning
- sync execution on filesystem-heavy paths
- sandbox seed upload planning
- materialization-related file operations

## What Matters Most To Optimize

The highest-value optimization target is:

- end-to-end workspace lifecycle cost inside Docker

That means the most important metrics are:

- workspace materialization latency
- push/pull latency
- seed upload latency
- directory scan and fingerprint cost
- Node RSS and heap growth during sync/materialization
- total file I/O and redundant copy/upload work

Archive export is still worth tracking, but it is now secondary to these runtime paths.

## Current Findings

## Workspace Sync And Materialization

What we know today:

- native sync is operational and semantically correct
- native sync can reduce Node RSS materially on large sync/materialization workloads
- sidecar startup and bridge overhead still make native latency worse than TS in many cases
- this means the current native sync path is promising, but not yet rollout-ready as the default

Practical conclusion:

- keep optimizing this path aggressively
- do not default it yet
- judge success by end-to-end workspace lifecycle wins, not by isolated microbenchmarks

## Archive Export

What we know today:

- native archive export now has a real measured win for multi-date backlog exports
- `OAH_NATIVE_ARCHIVE_EXPORT=auto` is the best current mode
- this is useful evidence that Rust can win in the repo when the boundary is right

Practical conclusion:

- keep it
- maintain it
- do not let it distract from the main optimization path

## Main Problems Still Unsolved

The biggest remaining problems are now on the workspace side:

- sidecar overhead is still too visible in sync/materialization
- scan + diff + execute still pay too much request-boundary cost
- seed upload still has room to eliminate repeated work
- prepared workspace reuse can be pushed harder
- Docker-heavy cases still need better default behavior before native sync can be enabled broadly
- `fingerprint_batch` is currently not stable enough to stay on the critical path, so initializer-side native fingerprinting currently uses per-directory calls instead

Secondary problem:

- archive export still leaves some TS-side materialization overhead on the table, but this is no longer the first thing to chase

## Next Plan

### Priority 1. Deepen Workspace Sync

Focus on the most frequently exercised hot path.

Next work:

- reduce sidecar startup overhead for sync operations
- keep more scan / diff / execute work inside Rust once invoked
- reduce repeated JSON bridge overhead on large directory trees
- improve batching and concurrency for Docker workloads
- keep validating semantics against current TS behavior
- finish stabilizing and benchmarking the persistent worker path before any default rollout

Success bar:

- native sync must match or beat TS on meaningful end-to-end Docker workloads
- RSS savings must come without obvious latency regression

### Priority 2. Deepen Materialization And Seed Upload

Treat this as the second half of the same runtime path.

Next work:

- reduce repeated fingerprint work during workspace preparation
- strengthen prepared seed cache usage
- avoid unnecessary upload/copy of unchanged files
- push more seed planning into Rust
- optimize sandbox HTTP upload path where Rust already has enough context to help

Success bar:

- faster repeated workspace preparation
- fewer redundant file operations
- lower container CPU and disk churn

### Priority 3. Keep Archive Export Stable, Not Primary

Next work:

- keep current archive export tests and benchmark path healthy
- only continue deeper archive-export optimization if it is low-cost or directly helps Docker memory behavior
- avoid spending primary engineering time there while sync/materialization still underperform

Success bar:

- no regression in current native archive-export behavior
- no expansion of scope unless it supports the main runtime goals

## Rollout Guidance

Current recommendation:

- workspace sync:
  - keep opt-in only
- archive export:
  - `OAH_NATIVE_ARCHIVE_EXPORT=auto` is a reasonable selective mode
- all native paths:
  - keep immediate TS fallback

This is still a conservative rollout strategy.
That is intentional.

## Verification Commands

Current checks that still matter:

- `cargo test --manifest-path ./native/Cargo.toml --target-dir ./.native-target -p oah-archive-export`
- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit`
- `pnpm exec vitest run tests/workspace-archive-export.test.ts tests/workspace-archive-export-native.test.ts tests/service-routed-postgres.test.ts`
- workspace sync and materialization benchmarks should become the primary recurring benchmark set from this point forward

## Bottom Line

Rust is already useful in this repository, but the optimization strategy is now explicitly refocused.

Current truth:

- `native/` is established
- archive export is the clearest proven Rust win so far
- the more important path is still workspace sync / materialization / seed upload
- that is where the next round of deep optimization work should go

From here, the right move is not to widen Rust usage blindly.
The right move is to push harder on the most common Docker-heavy workspace path until it produces the same kind of clear win that archive export now shows.
