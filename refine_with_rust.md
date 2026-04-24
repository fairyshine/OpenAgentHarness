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
- persistent-worker groundwork now exists in the native bridge and Rust binary; it is now enabled by default in the Docker runtime images and `docker-compose.local.yml`, while non-Docker usage still remains opt-in
- the default TS materialization path now reuses the sync-produced local fingerprint when available, which removes one extra full local directory scan after remote-to-local materialization
- sandbox-backed workspace initialization now uploads directly from the cached prepared seed root instead of copying each seed into a per-request staging directory first
- the default TS sandbox seed upload path now skips file writes when the remote workspace file already matches local size and mtime
- the default TS sandbox seed upload path now also prunes stale or type-mismatched remote entries before upload, so repeated seed operations behave more like a real mirror
- the native self-hosted sandbox upload path now also skips uploads for unchanged remote files by checking sandbox file stat before sending bytes
- the native self-hosted sandbox upload path now also prunes stale or type-mismatched remote entries, bringing its mirror semantics much closer to the TS path
- native seed-upload path building now preserves absolute sandbox roots like `/workspace/...`, fixing a correctness issue that could otherwise misplace uploads
- the experimental persistent native workspace-sync worker now covers more hot commands beyond the two original sync calls, including fingerprint / plan / seed-upload-related commands
- the mainline benchmark script `scripts/bench-workspace-mainline.ts` now covers both native-direct sync primitives and end-to-end sandbox-backed initializer seed preparation
- prepared seed cache key generation now uses native `fingerprint-batch` for the runtime/tool/skill directory set instead of issuing four separate native fingerprint calls
- native sandbox HTTP sync now reuses `files/entries` metadata (`sizeBytes` / `updatedAt`) to avoid some follow-up per-file `stat` calls and to skip redundant directory-create requests when the remote tree is already present
- native sandbox HTTP sync now only issues explicit sandbox `mkdir` for the root path and true empty directories; non-empty parent directories are left to file-upload parent creation
- a container-oriented benchmark entrypoint now exists at `scripts/bench-workspace-mainline-docker.sh` so the same benchmark can be run under explicit Docker CPU and memory limits
- Docker runtime images and local compose now default to `OAH_NATIVE_WORKSPACE_SYNC=1` and `OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT=1`, so the main container path actually exercises the native implementation without extra manual configuration
- the mainline benchmark now also reports average sandbox HTTP request counts per scenario, broken out by `createSandbox`, `stat`, `entries`, `mkdir`, `upload`, and `delete`
- the TS fallback seed-upload path now also reuses remote listing metadata (`sizeBytes` / `updatedAt`) to avoid per-file `stat` probes when sandbox listings already prove file state
- the TS fallback seed-upload path now only issues explicit non-root `mkdir` for leaf empty directories on `self_hosted` sandboxes, relying on HTTP upload parent creation for non-empty directory trees
- self-hosted sandbox seed initialization now has an archive fast path in the TS control plane: it can package the prepared seed into a single local tar, upload once, and extract once inside the sandbox
- the prepared-seed cache now also reuses that local seed tar on repeated initialization, so warm self-hosted seed prep no longer rebuilds the same archive every time
- object-store workspace flush now also reuses the `localFingerprint` returned by sync instead of rescanning the whole local tree after a successful push, extending the earlier "reuse sync fingerprint" pattern from materialization into the flush path
- native object-store remote-to-local sync now also returns `localFingerprint`, so native-backed materialization can reuse the sync result instead of immediately rescanning the materialized tree
- object-store sync now maintains a remote sync manifest for file `mtime` and size, letting both TS and native push/pull paths replace many per-file `HeadObject` probes with a single manifest read on repeated syncs
- object-store sync now also supports an aggressive tar-bundle sidecar cache: push can write `.oah-sync-bundle.tar`, and cold pull/materialization can hydrate from that bundle before normal sync reconciliation

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
- keep harvesting wins on the default TS path too, especially anywhere we can remove redundant scan or diff work without waiting for native-default readiness
- reducing duplicated local copy work in the TS seed path is already paying off and should continue alongside native-path work
- repeated seed upload now has a safe incremental fast path on the TS side for unchanged files, which reduces remote write amplification even before native-default rollout
- repeated seed upload on the TS path now also cleans stale remote entries, reducing workspace drift across repeated sandbox preparation
- the same unchanged-file skip now exists in the native self-hosted upload path, so both default TS and native seed flows benefit from lower remote write churn
- native self-hosted seed upload now also cleans stale/type-mismatched remote entries, reducing drift between TS fallback behavior and native behavior
- persistent worker reuse is now valuable on a wider set of native workspace-sync commands, and the Docker/container path now enables it by default so those savings can show up in real deployments instead of only in opt-in tests
- the benchmark script now compares `ts`, `native oneshot`, and `native persistent` on repeated sandbox seed preparation through the real `createSandboxBackedWorkspaceInitializer(...)` path, not just isolated native calls
- bridge-side binary resolution now prefers fresh local build outputs under `.native-target/` and `native/target/` before `native/bin/`, because `native/bin/` is a distribution artifact and can drift from the currently tested build
- prepared seed cache key generation now batches native fingerprinting for the four main input directories, removing repeated per-directory native bridge calls from the warm initializer path
- `fingerprint-batch` now also routes through the persistent native worker path, so repeated cache-key generation no longer pays one-shot process startup in persistent mode
- native sandbox HTTP sync now consumes listing metadata from `files/entries` so it can avoid extra remote `stat` probes for many unchanged files and avoid redundant `mkdir` calls for directories that already exist
- native sandbox HTTP sync now limits explicit `mkdir` calls to the root path plus true empty directories, which reduces directory-create chatter on the hot upload path
- the self-hosted initializer now short-circuits that per-file upload shape with the archive fast path: on the same local sample (`--files 96 --size-bytes 4096 --iterations 2 --seed-sync-repeats 2`), initializer seed preparation now averages just `5` sandbox HTTP requests per run for `ts`, `native oneshot`, and `native persistent`
- the current request shape for that initializer path is now effectively fixed at `1 createSandbox + 1 stat + 1 mkdir + 1 upload + 1 foregroundCommand`
- after switching the archive path to plain `tar` and caching the built archive alongside the prepared seed, warm initializer latency on that sample now lands around `71ms` for `ts`, `59ms` for `native oneshot`, and `62ms` for `native persistent`
- on that same sample, cold initializer latency is still meaningfully higher because it includes prepared workspace construction and first archive build, landing around `272ms` for `ts`, `149ms` for `native oneshot`, and `142ms` for `native persistent`
- this means the biggest initializer win is now proven: request count is no longer dominated by per-file upload churn, and warm repeated sandbox preparation benefits directly from prepared-seed archive reuse
- on that same sample, the native-direct micro path still shows clear wins for persistent mode on fingerprint and planning, and a smaller but still positive gain on sandbox HTTP sync
- because Docker runtime images now default to native persistent mode, these gains are positioned on the actual main deployment path rather than only behind a manual env toggle
- the object-store-backed materialization path now also avoids one redundant full local fingerprint scan after flush, which directly reduces local filesystem walk / hash work on dirty workspace eviction and close paths
- the native object-store materialization path now also avoids the extra post-sync local fingerprint scan, bringing the same "sync computes the fingerprint once" behavior to both TS and native-backed restore flows
- repeated object-store sync now has a new aggressive fast path: when the remote sync manifest is present, unchanged files can often skip per-file metadata probes entirely on both push and pull, which should reduce request count and object-store round trips on warm sync workloads
- cold object-store materialization and pull now also have a bundle-first fast path available, which trades one larger object download plus local tar extraction for many small object fetches on larger workspace restores

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
- general sync/materialization still pays too much per-file upload cost once we leave the self-hosted initializer archive fast path
- seed upload cold-start still pays for the first archive build, even though warm repeated initialization now reuses the archive
- prepared workspace reuse can be pushed harder
- Docker-heavy cases still need broader benchmark proof before we call the rollout universally proven, even though the main Docker runtime path now defaults to native persistent mode
- we now have a Docker benchmark entrypoint, but it still needs a successful end-to-end run in an environment that can pull base images reliably before it becomes part of the normal proof path

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
- run the new Docker-oriented benchmark profile regularly so we can measure whether the local initializer wins still hold once filesystem virtualization and container resource limits are in play

Success bar:

- native sync must match or beat TS on meaningful end-to-end Docker workloads
- RSS savings must come without obvious latency regression

### Priority 2. Deepen Materialization And Seed Upload

Treat this as the second half of the same runtime path.

Next work:

- reduce repeated fingerprint work during workspace preparation
- extend the new "sync returns local fingerprint" pattern to more mainline restore / seed / initializer flows where we still rescan immediately after sync
- strengthen prepared seed cache usage
- keep removing duplicated local staging/copy work from seed upload paths
- avoid unnecessary upload/copy of unchanged files that still remain outside the current seed fast path
- push more seed planning into Rust
- decide whether the current TS/native cleanup semantics should grow from seed-root mirroring into broader remote diffing rules only if that remains safe for workspace initialization semantics
- keep stabilizing the broader persistent-worker command set before considering any larger rollout
- optimize sandbox HTTP upload path where Rust already has enough context to help
- use the new local benchmark as a guardrail while we add a Docker-scale benchmark and decide whether persistent native workspace sync is strong enough to become the preferred path for self-hosted sandbox seed preparation
- consider pushing more remote tree information into a single sandbox listing pass if the current `files/entries` metadata still leaves too many fallback `stat` requests on large unchanged trees
- now that request-count instrumentation exists, use it to focus on the remaining real bottlenecks: upload volume, prepared-seed reuse quality, and any still-unnecessary directory-create traffic

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
