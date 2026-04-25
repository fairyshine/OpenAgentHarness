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
- in-process ustar bundle writer for filtered/in-memory sync bundles
- in-process ustar bundle extractor for in-memory sync bundle hydration
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

- TS `bundle-primary` cold push: about `417-509ms`
- native persistent cold push: about `45ms` with the Rust ustar writer, or about `97ms` with it disabled
- native persistent warm push: about `6-8ms`
- native persistent materialize: about `78-96ms` with the Rust ustar extractor, or about `127ms` with it disabled
- native persistent pull: about `77-78ms` with the Rust ustar extractor, or about `113ms` with it disabled

Current native bundle split on this sample:

- Rust ustar writer enabled: `bundle-build ~11ms`, `bundle-upload ~24ms`, `command-total ~44ms`
- Rust ustar writer disabled / external tar path: `bundle-build ~55ms`, `bundle-upload ~34ms`, `command-total ~96ms`
- Rust ustar extractor enabled: native persistent materialize `78-96ms`, pull `77-78ms`
- Rust ustar extractor disabled / `tar::Archive` path: native persistent materialize `127ms`, pull `113ms`
- transport mode: `memory`

Latest local proof after this stage:

- TS sidecar cold push: `1797ms`, `1027` requests
- TS `bundle-primary` cold push: `383ms`, `2` requests
- native persistent cold push: `50ms`, `2` requests
- native persistent warm push: `6ms`, `1` request
- native persistent materialize: `84ms`, `1` request
- native persistent pull: `77ms`, `1` request
- native persistent push phase split: `scan=2ms`, `bundle-build=11ms`, `bundle-upload=30ms`, `command-total=48ms`
- native persistent materialize split: `bundle-get=1ms`, `bundle-body-read=2ms`, `bundle-extract=75ms`, `fingerprint=3ms`, `command-total=83ms`
- native persistent materialize extract micro-split: `extract-create=42839us`, `extract-write=5236us`, `extract-mtime=11467us`, `extract-mkdir=778us`, `extract-target-check=0us`, `extract-files=1024`
- native persistent pull split: `bundle-get=1ms`, `bundle-body-read=2ms`, `bundle-extract=69ms`, `fingerprint=3ms`, `command-total=77ms`
- native persistent pull extract micro-split: `extract-create=41644us`, `extract-write=5367us`, `extract-mtime=6692us`, `extract-mkdir=676us`, `extract-target-check=0us`, `extract-files=1024`
- explicit writer-off control: native persistent cold push `97ms`, with `bundle-build=55ms` and `command-total=96ms`
- explicit extractor-off control: native persistent materialize `127ms`, pull `113ms`

### Mainline prepared-seed and Docker-limited proof

Synthetic `1024 files x 4 KiB`, local host:

- initializer seed prepare cold: TS `970ms`, native oneshot `418ms`, native persistent `526ms`
- initializer seed prepare warm: TS `360ms`, native oneshot `137ms`, native persistent `126ms`
- native direct sandbox-http cold sync: oneshot `365ms`, persistent `281ms`
- native direct sandbox-http warm sync: oneshot `168ms`, persistent `141ms`

Synthetic `1024 files x 4 KiB`, Docker-limited container with `--cpus=2 --memory=1g`:

- initializer seed prepare cold: TS `451ms`, native oneshot `299ms`, native persistent `315ms`
- initializer seed prepare warm: TS `86ms`, native oneshot `38ms`, native persistent `35ms`
- native direct sandbox-http cold sync: oneshot `344ms`, persistent `346ms`
- native direct sandbox-http warm sync: oneshot `202ms`, persistent `173ms`

Real runtime from `OAH_DEPLOY_ROOT=/Users/wumengsong/Code/test_oah_server`, runtime `compact-hook-e2e-runtime`:

- initializer seed prepare cold: TS `144ms`, native oneshot `31.5ms`, native persistent `140ms`
- initializer seed prepare warm: TS `22.5ms`, native oneshot `11.7ms`, native persistent `6.5ms`
- native direct sandbox-http cold sync: oneshot `22.2ms`, persistent `7.1ms`
- native direct sandbox-http warm sync: oneshot `11.3ms`, persistent `2.8ms`

The persistent cold number on small real runtimes can be distorted by first worker startup. The steady-state and larger synthetic cases still favor persistent mode; oneshot remains useful as a fallback and as a debugging/control mode, not as the preferred hot path.

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

### 2. Bundle build cost moved from an external-tar floor to a small Rust loop

The direct ustar writer changed the larger sample substantially:

- `bundleBodyPrepareMs` is effectively near zero in the current native path
- `bundle-build` dropped from about `55ms` to about `11ms` on `1024 files x 4 KiB`
- the remaining cold push cost is now mostly upload and object-store/request overhead
- the external tar path should remain as a compatibility fallback for edge cases such as paths outside the simple ustar envelope

### 3. Bundle extraction now has the same measured native fast path

The in-memory hydration path now tries a constrained ustar extractor before falling back to `tar::Archive`:

- it handles safe ustar regular files and directories
- it rejects complex/unsafe paths and unsupported entry types back to the existing tar path
- it preserves mtime and non-default executable/permission modes where they matter
- it can be disabled with `OAH_NATIVE_WORKSPACE_SYNC_RUST_BUNDLE_EXTRACTOR=0` for controls and rollback

Measured result on `1024 files x 4 KiB`:

- native persistent materialize improved from `127ms` to the `78-96ms` range in same-stage runs
- native persistent pull improved from `113ms` to about `78ms`
- remote-to-local phase timings now expose `bundle-get`, body read, extractor kind, bundle bytes, fingerprint, and command total
- the Rust ustar extractor now exposes microsecond counters for mkdir, directory replacement, file create, file write, mtime restore, chmod, and extracted entry counts
- mtime restore now uses the open file handle instead of a second path lookup where the file has just been created
- empty-root bundle hydration now skips per-file target replacement checks; the benchmark records `extract-target-check=0us` on the materialize/pull fast path
- the latest split shows file creation as the largest remaining extract sub-cost: about `40-51ms` for `1024` files, versus about `6-8.5ms` for mtime restore and about `5-6.5ms` for file writes

### 4. Small and large bundle cases should not be treated the same

The benchmarks show a useful split:

- small bundles clearly benefit from the in-memory path
- larger bundles now benefit from the Rust writer when they are still within the in-memory source-byte threshold
- very large bundles still need separate tempfile/streaming measurements before changing thresholds again

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

- keep reducing upload and remaining materialize cost now that build and in-memory extract both have native fast paths
- investigate whether extractor file creation can be reduced by a streaming/tempfile strategy, directory-level batching, or a different materialization shape; S3 get/read is not the bottleneck on the current sample
- keep oneshot documented and tested as fallback-only unless future measurements show a reason to optimize it
- continue improving prepared-seed reuse and seed upload efficiency
- add broader Docker CPU/memory constrained proof against real runtime mixes, not only the synthetic `1024 x 4 KiB` fixture
- keep TS fallback semantically aligned with native behavior
- keep reducing native Rust file size by extracting low-coupling modules first; avoid large behavioral rewrites while performance work is still active

## Next Phase Entry Point

This phase completed the next pass through this order:

1. Docker-limited runtime/workspace create measurement
2. native `bundle-build` reduction below the previous `~54ms` larger-sample floor
3. oneshot overhead decision
4. prepared-seed cold/warm measurement using both synthetic and real `OAH_DEPLOY_ROOT` runtime inputs

The next phase should continue from:

1. reduce native bundle upload cost after the Rust writer/extractor shift
2. measure real runtime mixes from `OAH_DEPLOY_ROOT`, especially runtimes larger than the current small local samples
3. move runtime/tool/skill copy and merge into a native command only if those real-runtime measurements show copy/setup cost dominating
4. keep improving Docker benchmark ergonomics so constrained measurements stay cheap enough to run regularly

Structural cleanup now has a safe order:

1. keep `native/oah-archive-export` schema/SQL definitions outside `main.rs` - done in `native/oah-archive-export/src/schema.rs`
2. split `native/oah-workspace-sync` path normalization and ignore/exclude rules into a small `path_rules` module - done in `native/oah-workspace-sync/src/path_rules.rs`
3. split `native/oah-workspace-sync` tar/ustar bundle writer, extractor, and in-memory bundle environment controls into a `sync_bundle` module - done in `native/oah-workspace-sync/src/sync_bundle.rs`
4. split `native/oah-workspace-sync` sandbox HTTP config/client/listing/prune rules into `sandbox_http.rs` - done in `native/oah-workspace-sync/src/sandbox_http.rs`
5. split `native/oah-workspace-sync` local filesystem stat/remove/ensure/cleanup helpers into `local_fs.rs` - done in `native/oah-workspace-sync/src/local_fs.rs`
6. split `native/oah-archive-export` export-root inspection and checksum helpers into `inspection.rs` - done in `native/oah-archive-export/src/inspection.rs`
7. split `native/oah-archive-export` SQLite write pragmas, row insertion, and JSON field helpers into `rows.rs` - done in `native/oah-archive-export/src/rows.rs`
8. split `native/oah-workspace-sync` local snapshot scanning and fingerprinting into `snapshot.rs` - done in `native/oah-workspace-sync/src/snapshot.rs`
9. split `native/oah-workspace-sync` sync manifest document conversion helpers into `manifest.rs` - done in `native/oah-workspace-sync/src/manifest.rs`
10. split `native/oah-workspace-sync` upload/download/seed planning helpers into `plan.rs` - done in `native/oah-workspace-sync/src/plan.rs`
11. split `native/oah-workspace-sync` sync bundle policy/config/cache helpers into `bundle_policy.rs` - done in `native/oah-workspace-sync/src/bundle_policy.rs`
12. split `native/oah-workspace-sync` object-store config, counters, manifest I/O, and plain file upload/download helpers into `object_store.rs` - done in `native/oah-workspace-sync/src/object_store.rs`
13. split `native/oah-workspace-sync` seed archive construction into `seed_archive.rs` - done in `native/oah-workspace-sync/src/seed_archive.rs`
14. split `native/oah-workspace-sync` CLI/worker protocol, JSON I/O, and request/response DTOs into `protocol.rs` - done in `native/oah-workspace-sync/src/protocol.rs`
15. split `native/oah-workspace-sync` sync bundle upload/delete/hydrate orchestration into `bundle_transfer.rs` - done in `native/oah-workspace-sync/src/bundle_transfer.rs`
16. split `native/oah-workspace-sync` repeated upload/download/info-check/concurrency operations into `sync_operations.rs` - done in `native/oah-workspace-sync/src/sync_operations.rs`
17. split `native/oah-workspace-sync` sandbox HTTP sync orchestration into `sandbox_sync.rs` - done in `native/oah-workspace-sync/src/sandbox_sync.rs`
18. split `native/oah-workspace-sync` object-store sync state machines into `object_sync.rs` - done in `native/oah-workspace-sync/src/object_sync.rs`
19. split `native/oah-workspace-sync` unit tests out of `main.rs` into `tests.rs` - done in `native/oah-workspace-sync/src/tests.rs`
20. next split helper modules internally if any newly extracted file grows past a clear responsibility boundary

## Repository Scan: Rust Candidate Map

This repository already has the right Rust boundary: native binaries under `native/`, called from TypeScript through `@oah/native-bridge` or a server-side bridge module.
The next candidates should keep that boundary and extend the existing worker/sidecar style instead of introducing Rust into request routing or domain orchestration.

### Tier 1: Extend existing Rust work first

These are the highest-confidence candidates because they are already on the Docker/self-hosted hot path and already have native integration points.

1. `native/oah-workspace-sync`: larger-workspace bundle construction
   - Current hotspot: `bundle-build` was the dominant native cost on the larger sample; after the Rust ustar writer it is no longer the floor for the `1024 files x 4 KiB` case.
   - Code surface: `native/oah-workspace-sync/src/main.rs`, `apps/server/src/object-storage.ts`, `packages/native-bridge/src/workspace-sync.ts`.
   - Rust opportunity: reduce tar assembly cost, avoid unnecessary sorted full-list construction where possible, preserve metadata in one pass, and keep using the persistent worker.
   - Current pass: in-memory root bundle thresholds are now native-configurable and default high enough to cover the `1024 files x 4 KiB` benchmark class without forcing tempfile I/O.
   - Current pass: bundle creation now uses a hybrid tar strategy. Clean snapshots keep the faster root-tar path; snapshots with ignored runtime junk switch to a snapshot-list tar path so `.DS_Store`, `__pycache__`, `.pyc`, SQLite sidecars, and internal sync files do not leak into bundles.
   - Current pass: filtered/in-memory sync bundles now use a native ustar writer by default, with `OAH_NATIVE_WORKSPACE_SYNC_RUST_BUNDLE_WRITER=0` available as an external-tar control/fallback.
   - Current pass: native snapshots now remember when `collect_snapshot` has already produced relative-path order, so fingerprinting and the Rust ustar writer can skip duplicate sorts on the main collected-snapshot path.
   - Current cleanup: sync bundle tar/ustar writing, tar subprocess fallback, in-memory bundle thresholds, and ustar byte extraction now live in `native/oah-workspace-sync/src/sync_bundle.rs`, leaving `main.rs` focused on command handling and sync orchestration.
   - Current cleanup: sandbox HTTP client/listing/prune helpers now live in `native/oah-workspace-sync/src/sandbox_http.rs`, and local filesystem cleanup/materialization helpers live in `native/oah-workspace-sync/src/local_fs.rs`.
   - Current cleanup: local snapshot scanning/fingerprinting now lives in `native/oah-workspace-sync/src/snapshot.rs`, sync manifest conversion in `native/oah-workspace-sync/src/manifest.rs`, and upload/download/seed planning in `native/oah-workspace-sync/src/plan.rs`.
   - Current cleanup: sync bundle policy/config lives in `native/oah-workspace-sync/src/bundle_policy.rs`, object-store helpers in `native/oah-workspace-sync/src/object_store.rs`, seed archive construction in `native/oah-workspace-sync/src/seed_archive.rs`, CLI/worker protocol handling in `native/oah-workspace-sync/src/protocol.rs`, bundle upload/delete/hydrate orchestration in `native/oah-workspace-sync/src/bundle_transfer.rs`, repeated sync operations in `native/oah-workspace-sync/src/sync_operations.rs`, sandbox HTTP sync orchestration in `native/oah-workspace-sync/src/sandbox_sync.rs`, object-store sync state machines in `native/oah-workspace-sync/src/object_sync.rs`, and unit tests in `native/oah-workspace-sync/src/tests.rs`.
   - Measured win: larger-sample `bundle-build` dropped from about `55ms` to about `11ms`; native persistent cold push dropped from about `97ms` to about `45ms` in the writer-on/off control.
   - Next win: upload/materialize cost and very-large tempfile/streaming behavior.

2. `native/oah-workspace-sync`: object-store bundle extraction and local cleanup
   - Current TS fallback still shells out to `tar` and then prunes empty directories.
   - Code surface: `maybeHydrateFromObjectStorageBundle`, `syncRemotePrefixToLocal`, and `pruneEmptyDirectories` in `apps/server/src/object-storage.ts`.
   - Rust opportunity: make extract, mtime restore, empty-directory handling, and post-sync cleanup one native operation.
   - Current pass: native local-to-remote sync now prunes empty directories itself, so the TS native wrapper no longer performs a second recursive cleanup walk.
   - Current pass: native remote-to-local hydration now extracts smaller and medium sync bundles from memory when the remote `content-length` is under `OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_EXTRACT_MAX_BYTES` instead of always writing a temporary bundle file first.
   - Current pass: in-memory hydration now uses a constrained native ustar extractor by default, with `OAH_NATIVE_WORKSPACE_SYNC_RUST_BUNDLE_EXTRACTOR=0` available as a fallback/control.
   - Current pass: remote-to-local phase timings now include extractor details and microsecond sub-counters for file creation, writes, mtime restoration, chmod, mkdir, replacement, and entry counts.
   - Current pass: Rust ustar extraction restores file mtime through the open file handle, avoiding a second path lookup for newly created files.
   - Current pass: empty-root bundle hydration skips per-file target replacement checks, while incremental/non-empty hydration keeps the compatibility check.
   - Measured win: native persistent materialize dropped from `127ms` to the `78-96ms` range; pull dropped from `113ms` to about `78ms` on `1024 files x 4 KiB`.
   - Current bottleneck: file creation dominates the remaining extractor cost at roughly `40-51ms` per `1024` files; mtime restore is now about `6-8.5ms`, writes about `5-6.5ms`, and bundle download/read is only `3-4ms`.
   - Next win: reduce local file creation/materialization cost or change the materialization shape; do not spend the next pass on S3 download for this sample.

3. `native/oah-workspace-sync`: seed archive build/upload path
   - Current path already uses native planning; seed archive construction now prefers a native `build-seed-archive` command and falls back to the previous TS `tar` spawn.
   - Code surface: `apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts`.
   - Rust opportunity: keep folding archive creation and archive-based upload/extract into the existing persistent native worker path for self-hosted sandboxes.
   - Current pass: native seed archive build now uses the same snapshot-list tar strategy as sync bundles, with an in-process Rust tar fallback.
   - Current pass: `scripts/bench-workspace-mainline.ts` can now benchmark a real runtime via `OAH_DEPLOY_ROOT` plus `OAH_BENCH_MAINLINE_RUNTIME_NAME`, or an explicit `OAH_BENCH_MAINLINE_RUNTIME_SOURCE_DIR`.
   - Measured win: synthetic Docker-limited prepared-seed warm prepare improved from TS `86ms` to native persistent `35ms`; real `compact-hook-e2e-runtime` warm prepare improved from TS `22.5ms` to native persistent `6.5ms`.
   - Expected next win: faster cold workspace creation and lower peak memory when prepared seeds contain many small files.

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
   - Current cleanup: SQLite schema and insert statement definitions now live in `native/oah-archive-export/src/schema.rs`, trimming `main.rs` and keeping storage layout changes localized.
   - Current cleanup: export-root inspection and checksum helpers now live in `native/oah-archive-export/src/inspection.rs`, separate from SQLite row writing.
   - Current cleanup: SQLite write pragmas, row insertion, and JSON field extraction now live in `native/oah-archive-export/src/rows.rs`, so streaming protocol code stays separate from row serialization.
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

5. Model runtime, MCP tools, SSE streaming, and Fastify routes
   - Code surface: `packages/model-runtime`, `apps/server/src/http`, `apps/web`.
   - Why not now: these are protocol orchestration paths with external model/network latency.
   - Rust would add integration complexity without a clear CPU/FS bottleneck.

## Local Docker Proof Points

The local compose path now matters because it defaults to native workspace sync on API and sandbox workers while keeping small Node heaps:

- API: `NODE_OPTIONS=--max-old-space-size=320`
- sandbox worker: `NODE_OPTIONS=--max-old-space-size=224`
- native sync enabled by default through `OAH_NATIVE_WORKSPACE_SYNC=1`
- persistent native worker enabled by default through `OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT=1`

The compose proof uses the same shape as:

```bash
OAH_DEPLOY_ROOT=/Users/wumengsong/Code/test_oah_server pnpm local:up
```

The remaining compose-oriented measurements to add are:

- first `local:up` after readonly volume recreation
- second `local:up` with `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1`
- object-store-backed workspace materialize, mutate, idle flush, and rematerialize
- API and sandbox RSS during large runtime/workspace sync

Current Docker proof status:

- `OAH_DEPLOY_ROOT=/Users/wumengsong/Code/test_oah_server pnpm local:up` rebuilt the local images and exercised the native binaries in API/sandbox images.
- That first proof exposed a Dockerfile packaging bug where Cargo's cached dummy native build could be copied into the runtime image. The Dockerfile now cleans package artifacts after copying real native sources, while preserving dependency cache reuse.
- The packaged API image now returns a valid `/app/native/oah-workspace-sync version` response, and worker `serve` responds to a `version` request.
- A second run with `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1` detected unchanged readonly sources and skipped `pnpm storage:sync`.
- The local stack reached healthy/running state for Postgres, Redis, MinIO, API, sandbox worker, controller, and compose scaler.
- `scripts/bench-workspace-mainline-docker.sh` now builds its native Linux binary through a Rust Alpine builder stage instead of installing Rust with `curl rustup` inside the Node image, copies `docs/` for initializer schema reads, and forwards benchmark env vars into the constrained container.
- Docker-limited prepared-seed measurement for `1024 files x 4 KiB` now exists: native persistent warm prepare `35ms` versus TS `86ms`; native oneshot remains a useful control but is not the preferred hot path.
- Real-runtime prepared-seed measurement from `OAH_DEPLOY_ROOT` now exists for `compact-hook-e2e-runtime`: native persistent warm prepare `6.5ms` versus TS `22.5ms`.

Do not broaden Rust scope until these Docker-constrained measurements keep showing the same pattern on larger real runtime mixes.

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
The correct next move is to keep drilling into upload, materialize, and runtime-copy costs now that the larger-sample bundle-build floor has moved from external tar to the in-process Rust writer.
