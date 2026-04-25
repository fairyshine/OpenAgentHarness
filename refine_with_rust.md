# Open Agent Harness Rust Refinement

## Goal

Use Rust to improve the hottest local-system paths in a measurable way, especially for Docker and self-hosted runtime workloads:

- workspace sync
- workspace materialization
- sandbox seed upload
- directory scan / fingerprint / diff planning

TypeScript remains the control plane.
Rust is used only where it clearly reduces latency, CPU, memory, I/O, or object-store request count.

## Architecture Decision

This phase confirms the long-term shape:

- Rust code lives under `native/`
- integration stays sidecar-binary first
- TypeScript keeps orchestration and fallback responsibility
- Rust owns the filesystem-heavy execution path when benchmarks justify it

This is not a rewrite-the-server-in-Rust plan.
It is a targeted hot-path acceleration plan.

## Mainline Scope

The primary optimization line is now:

1. workspace sync
2. workspace materialization
3. seed upload and prepared-seed reuse

Archive export remains supported, but it is no longer the strategy-defining path.

## What This Phase Has Established

### 1. Native workspace sync is real and integrated

`native/oah-workspace-sync` now covers:

- local scan
- fingerprint computation
- local-to-remote sync
- remote-to-local sync
- seed-related planning
- persistent worker mode
- bridge integration back into the TS runtime path

### 2. The TS fallback path is no longer a weak fallback

The TS path has been tightened so that non-native execution still benefits from the same general sync model:

- manifest-based sync state
- `bundle-primary` layout
- trusted managed-prefix fast path
- fingerprint reuse after sync
- reduced redundant `HEAD` / `GET` probes and local rescans

### 3. Native is now on the real hot path

The main runtime path now prefers native persistent sync by configuration:

- `OAH_NATIVE_WORKSPACE_SYNC=1`
- `OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT=1`
- `OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT=primary`
- `OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES=1`

This matters because the performance work is no longer trapped behind a manual opt-in microbenchmark path.

## What Has Been Improved

### Object-store-backed workspace sync

Rust and TS now both support:

- sync manifest reuse
- bundle-backed push / pull / materialize
- lower object-store request count
- lower Node-side memory pressure

Rust additionally now has:

- persistent worker reuse
- explicit worker `ready` handshake
- process-wide worker-pool sharing
- bootstrap-time worker prewarm
- `tar`-first bundle creation
- root-tar fast path
- temp-file-backed bundle path
- in-memory bundle path for smaller bundles
- request-count reporting
- sync phase timing reporting
- bridge timing reporting
- worker timing reporting

### Seed upload and initializer path

The mainline seed path now avoids a lot of avoidable work:

- prepared seed reuse
- archive fast path for self-hosted initialization
- archive warming during prepare-seed
- reused archive eligibility metrics
- unchanged-file upload skipping
- stale remote entry cleanup
- fewer redundant `mkdir` and `stat` calls

## Measured Result

### Small sample: `96 files x 4 KiB`

Current shape:

- TS `bundle-primary` cold push: about `58-69ms`
- native persistent cold push: about `30-37ms`
- native persistent warm push: about `3-4ms`
- native persistent materialize: about `14-18ms`
- native persistent pull: about `14-16ms`

Current native bundle split on this sample:

- `bundle-build ~10ms`
- `bundle-upload ~11-12ms`
- transport mode: `memory`

### Larger sample: `1024 files x 4 KiB`

Current shape:

- TS `bundle-primary` cold push: about `444-509ms`
- native persistent cold push: about `95-115ms`
- native persistent warm push: about `6-8ms`
- native persistent materialize: about `106-149ms`
- native persistent pull: about `105-125ms`

Current native bundle split on this sample:

- `bundle-build ~54-62ms`
- `bundle-upload ~30-43ms`
- transport mode now varies based on threshold policy, but the dominant remaining cost is build rather than body preparation

Latest local proof after this stage:

- TS sidecar cold push: `1292ms`, `1027` requests
- TS `bundle-primary` cold push: `444ms`, `2` requests
- native persistent cold push: `95ms`, `2` requests
- native persistent warm push: `6ms`, `1` request
- native persistent materialize: `106ms`, `1` request
- native persistent pull: `110ms`, `1` request
- native persistent push phase split: `scan=2ms`, `bundle-build=54ms`, `bundle-upload=33ms`, `command-total=94ms`

## What We Learned In This Phase

### 1. The old cold-path cliff was not object-store work

The first major cold-path loss came from worker readiness and bridge overhead, not from the sync algorithm itself.

That problem is now addressed by:

- explicit `ready` handshake
- global worker-pool sharing
- early worker prewarm

Net result:

- `poolInit` is no longer dominating first real sync work
- `receiveDelay` is no longer the main bottleneck
- cold persistent push now spends most of its time inside the actual Rust sync command

### 2. Bundle body preparation is no longer the main issue

The additional fields introduced in this phase showed:

- `bundleBodyPrepareMs` is effectively near zero in the current native path
- the remaining larger cost is usually `bundle-build`
- `bundle-upload` still matters, but it is no longer the first thing to chase on larger samples

### 3. Small and large bundle cases should not be treated the same

The benchmarks show a useful split:

- small bundles clearly benefit from the in-memory path
- larger bundles need more careful treatment and should be judged by measured build/upload breakdown, not by one transport rule applied everywhere

## Current Conclusion

At the end of this phase, Rust is no longer just "promising".
It is already the better implementation on the main workspace lifecycle path.

That conclusion is justified because native persistent now improves:

- cold push
- warm push
- materialize
- pull
- request count
- Node RSS under filesystem-heavy/object-store-heavy workloads

## What Remains Unfinished

The remaining mainline work is now narrower and more concrete:

- keep reducing bundle build cost on larger workspaces, now from a `~54ms` baseline on the `1024 files x 4 KiB` sample
- reduce remaining command-body overhead in native sync where it still shows up under oneshot mode
- continue improving prepared-seed reuse and seed upload efficiency
- add more Docker CPU/memory constrained proof beyond local compose startup and object-storage microbenchmarks
- keep TS fallback semantically aligned with native behavior

## Next Phase Entry Point

This phase completed the first pass through this order:

1. optimize larger-workspace `bundle-build`
2. revisit larger-workspace `bundle-upload` after remeasurement
3. extend the same discipline to seed archive / prepared-seed reuse
4. rerun local Docker proof before broadening rollout claims

The next phase should continue from:

1. add Docker-limited runtime/workspace create measurements, not only local object-storage sync measurements
2. profile native `bundle-build` below the current `~54ms` larger-sample floor
3. reduce native oneshot client-create/command overhead, or keep oneshot clearly documented as fallback-only
4. expand prepared-seed cold/warm measurements with real runtimes from `OAH_DEPLOY_ROOT`

## Repository Scan: Rust Candidate Map

This repository already has the right Rust boundary: native binaries under `native/`, called from TypeScript through `@oah/native-bridge` or a server-side bridge module.
The next candidates should keep that boundary and extend the existing worker/sidecar style instead of introducing Rust into request routing or domain orchestration.

### Tier 1: Extend existing Rust work first

These are the highest-confidence candidates because they are already on the Docker/self-hosted hot path and already have native integration points.

1. `native/oah-workspace-sync`: larger-workspace bundle construction
   - Current hotspot: `bundle-build` is now the dominant native cost on the larger sample.
   - Code surface: `native/oah-workspace-sync/src/main.rs`, `apps/server/src/object-storage.ts`, `packages/native-bridge/src/workspace-sync.ts`.
   - Rust opportunity: reduce tar assembly cost, avoid unnecessary sorted full-list construction where possible, preserve metadata in one pass, and keep using the persistent worker.
   - Current pass: in-memory root bundle thresholds are now native-configurable and default high enough to cover the `1024 files x 4 KiB` benchmark class without forcing tempfile I/O.
   - Current pass: bundle creation now uses a hybrid tar strategy. Clean snapshots keep the faster root-tar path; snapshots with ignored runtime junk switch to a snapshot-list tar path so `.DS_Store`, `__pycache__`, `.pyc`, SQLite sidecars, and internal sync files do not leak into bundles.
   - Expected win: lower cold push and materialize latency under Docker CPU limits.

2. `native/oah-workspace-sync`: object-store bundle extraction and local cleanup
   - Current TS fallback still shells out to `tar` and then prunes empty directories.
   - Code surface: `maybeHydrateFromObjectStorageBundle`, `syncRemotePrefixToLocal`, and `pruneEmptyDirectories` in `apps/server/src/object-storage.ts`.
   - Rust opportunity: make extract, mtime restore, empty-directory handling, and post-sync cleanup one native operation.
   - Current pass: native local-to-remote sync now prunes empty directories itself, so the TS native wrapper no longer performs a second recursive cleanup walk.
   - Current pass: native remote-to-local hydration now extracts smaller and medium sync bundles from memory when the remote `content-length` is under `OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_EXTRACT_MAX_BYTES` instead of always writing a temporary bundle file first.
   - Expected win: less process spawning, fewer local filesystem walks, and lower Node RSS during materialization.

3. `native/oah-workspace-sync`: seed archive build/upload path
   - Current path already uses native planning; seed archive construction now prefers a native `build-seed-archive` command and falls back to the previous TS `tar` spawn.
   - Code surface: `apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts`.
   - Rust opportunity: keep folding archive creation and archive-based upload/extract into the existing persistent native worker path for self-hosted sandboxes.
   - Current pass: native seed archive build now uses the same snapshot-list tar strategy as sync bundles, with an in-process Rust tar fallback.
   - Expected win: faster cold workspace creation and lower peak memory when prepared seeds contain many small files.

4. `scripts/local-stack.mjs`: readonly deploy-source fingerprint and storage sync planning
   - Local deployment uses `OAH_DEPLOY_ROOT` and scans `source/runtimes`, `source/models`, `source/tools`, `source/skills`, and `source/archives` before `pnpm storage:sync`.
   - Code surface: `appendDirectoryFingerprint`, `readonlyObjectStorageSourceFingerprint`, and `syncReadonlyObjectStorageSources` in `scripts/local-stack.mjs`.
   - Rust opportunity: reuse the native directory scanner/fingerprint command for this deploy-root scan.
   - Current pass: `local:up` now prefers native `fingerprint-batch` for readonly deploy-source fingerprinting when the workspace-sync binary is available, with automatic JS fallback.
   - Expected win: faster `pnpm local:up` on large local deploy roots, especially when `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1`.

### Tier 2: Good candidates after Tier 1 is stable

These are useful, but should wait until the main workspace path is proven under Docker constraints.

1. Runtime initialization and imported tool/skill copying
   - Code surface: `initializeWorkspaceFromRuntime`, `importEngineTools`, and `importRuntimeSkills` in `packages/config/src/runtimes.ts`.
   - Current behavior: Node recursively copies runtime, tools, and skills with several separate passes.
   - Rust opportunity: copy tree, merge file metadata, and return a structured changed-file summary in one native command.
   - Expected win: faster prepare-seed and workspace creation when runtimes contain many files.

2. Archive export worker refinement
   - Code surface: `native/oah-archive-export`, `apps/server/src/native-archive-export.ts`, and `apps/server/src/workspace-archive-export.ts`.
   - Current state: Rust already writes SQLite bundles/checksums and supports persistent streaming.
   - Rust opportunity: improve batching/transaction shape, add timing counters, and keep row serialization streaming all the way from TS to Rust.
   - Expected win: lower archive export CPU and memory, but this is background work rather than the main latency path.

3. Storage admin archive-directory inspection
   - Code surface: `summarizeArchiveExportDirectory` in `apps/server/src/storage-admin.ts`.
   - Current behavior: TS scans archive export roots and stats bundles.
   - Rust opportunity: reuse `oah-archive-export inspect-export-root` plus byte totals/latest date.
   - Expected win: only visible when archive directories become large, so this is a nice cleanup rather than a mainline target.

### Tier 3: Only consider with new benchmark evidence

These areas are plausible but not yet obvious Rust wins.

1. Runtime upload zip extraction
   - Code surface: `uploadWorkspaceRuntime` in `packages/config/src/runtimes.ts`.
   - Current behavior: `yauzl` reads each zip entry into a Buffer before writing it.
   - Why not now: runtime uploads are less central than prepared seed reuse, workspace sync/materialization, deploy-source sync, and archive/export maintenance.
   - Rust could help later by streaming unzip to disk with path traversal checks, timestamp preservation, and entry-count reporting.

2. Local command execution supervision
   - Code surface: `packages/engine-core/src/workspace/workspace-command-executor.ts`.
   - Why not now: the expensive work is the child process itself; Node mainly supervises stdout/stderr and timeouts.
   - Rust could help only if background-process tracking, streaming logs, cancellation, and resource limits become a measured bottleneck.

3. Redis scheduling and worker placement
   - Code surface: `packages/storage-redis/src/run-queue.ts`, worker registries, lease registries, and placement registries.
   - Why not now: critical queue operations already run inside Redis Lua scripts, so moving the TypeScript caller to Rust would mostly move network I/O wrappers.
   - Better next move: tune Lua scripts and Redis key shape before considering a native scheduler service.

4. Postgres repositories and storage admin table browsing
   - Code surface: `packages/storage-postgres/src/repositories.ts`, `apps/server/src/storage-admin.ts`.
   - Why not now: the database owns most runtime cost; TypeScript mostly maps rows and assembles API responses.
   - Better next move: query/index improvements, pagination, and fewer `row_to_json(... )::text ilike` scans.

5. Model gateway, MCP tools, SSE streaming, and Fastify routes
   - Code surface: `packages/model-gateway`, `apps/server/src/http`, `apps/web`.
   - Why not now: these are protocol orchestration paths with external model/network latency.
   - Rust would add integration complexity without a clear CPU/FS bottleneck.

## Local Docker Proof Points To Add

The local compose path now matters because it defaults to native workspace sync on API and sandbox workers while keeping small Node heaps:

- API: `NODE_OPTIONS=--max-old-space-size=320`
- sandbox worker: `NODE_OPTIONS=--max-old-space-size=224`
- native sync enabled by default through `OAH_NATIVE_WORKSPACE_SYNC=1`
- persistent native worker enabled by default through `OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT=1`

The next proof should use the same shape as:

```bash
OAH_DEPLOY_ROOT=/Users/wumengsong/Code/test_oah_server pnpm local:up
```

Then measure at least:

- first `local:up` after readonly volume recreation
- second `local:up` with `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1`
- workspace create from runtime with prepared seed cache cold/warm
- object-store-backed workspace materialize, mutate, idle flush, and rematerialize
- API and sandbox RSS during large runtime/workspace sync

Current Docker proof status:

- `OAH_DEPLOY_ROOT=/Users/wumengsong/Code/test_oah_server pnpm local:up` rebuilt the local images and exercised the native binaries in API/sandbox images.
- That first proof exposed a Dockerfile packaging bug where Cargo's cached dummy native build could be copied into the runtime image. The Dockerfile now cleans package artifacts after copying real native sources, while preserving dependency cache reuse.
- The packaged API image now returns a valid `/app/native/oah-workspace-sync version` response, and worker `serve` responds to a `version` request.
- A second run with `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1` detected unchanged readonly sources and skipped `pnpm storage:sync`.
- The local stack reached healthy/running state for Postgres, Redis, MinIO, API, sandbox worker, controller, and compose scaler.

Do not broaden Rust scope until these Docker-constrained measurements show the same pattern as the local microbenchmarks.

## Guardrails

Keep these boundaries:

- TS still owns routing, orchestration, and business logic
- Rust stays focused on filesystem-heavy execution
- every native path keeps a TS fallback
- no expansion of Rust scope without measured benefit

## Rollout Guidance

Current recommendation:

- prefer native persistent workspace sync on Docker and self-hosted runtime paths
- keep TS fallback enabled
- continue shipping Rust only where the benchmark story stays clearly positive

## Bottom Line

This phase is complete enough to treat Rust-on-workspace-path as an established direction rather than an experiment.

The correct next move is not wider Rust adoption.
The correct next move is to keep drilling into the same hot path until larger Docker-bound workloads show the same stable advantage end to end.
