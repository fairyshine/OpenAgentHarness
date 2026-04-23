# Open Agent Harness Rust Refine Plan

## 1. Goal

This document proposes a pragmatic mixed TypeScript + Rust architecture for Open Agent Harness.

The goal is not to rewrite the engine in Rust.
The goal is to keep TypeScript as the control plane and orchestration layer, while moving a small number of heavy filesystem and synchronization paths into Rust under `native/`.

This plan assumes:

- the repository remains TypeScript-first
- Rust is introduced only for narrow, measurable hot paths
- the first integration style is a sidecar binary, not an in-process native addon
- the Rust code lives under `native/`

## 2. Why Introduce Rust

The current repository is primarily an orchestration system:

- API routing
- session and run lifecycle management
- model invocation
- Redis and PostgreSQL integration
- sandbox coordination

Those areas are not the best candidates for Rust-first optimization because they spend much of their wall-clock time waiting on:

- LLM network calls
- Redis/PostgreSQL round trips
- subprocesses
- object storage
- remote sandbox operations

The stronger Rust candidates are the parts that are more systems-oriented:

- recursive directory walking
- file fingerprinting
- large numbers of `stat` and `readdir` calls
- local/remote synchronization
- batch upload and download planning
- archive export
- checksum computation

## 3. Design Principles

The design should follow these principles:

- TypeScript remains the source of truth for product logic and orchestration.
- Rust is used only where the input/output boundary is clean.
- Every Rust-backed feature must have a TypeScript fallback.
- The first version must be operable in Docker and local development without special runtime dependencies.
- The protocol between TS and Rust must be explicit and versioned.
- Performance work must be measurable before and after rollout.

In short:

- TS does the orchestration and policy
- Rust does the heavy filesystem and byte-oriented work

## 4. Why `native/`

The Rust code should live under `native/`.

This is not a Rust language requirement, but it is a good fit for this repository because:

- it is easy for TS-first contributors to understand
- it clearly signals "native/system-level components"
- it leaves room for future non-Rust native code if needed
- it avoids implying that Rust is the main package system of the repo

Recommended structure:

```text
native/
  Cargo.toml
  oah-workspace-sync/
    Cargo.toml
    src/
  oah-archive-export/
    Cargo.toml
    src/
packages/
  native-bridge/
    src/
scripts/
  build-native.mjs
```

Where:

- `native/` is a Cargo workspace
- each Rust binary is its own crate
- `packages/native-bridge` is the thin TS wrapper layer

## 5. What Should Stay in TypeScript

These areas should remain in TypeScript:

- HTTP routes and Fastify integration
- session and run orchestration
- prompt composition
- model gateway integration
- business-level error translation
- storage repositories for Redis/PostgreSQL
- feature flags and rollout policy

These modules are logic-heavy and integration-heavy, not primarily CPU hotspots.

## 6. What Should Move to Rust First

### 6.1 First Priority: Workspace Sync

The first Rust component should be:

- `native/oah-workspace-sync`

Its scope:

- walk local directory trees
- compute stable directory fingerprints
- compare local tree vs object-store listing
- produce upload/download/delete plans
- execute sync operations
- preserve mtime metadata
- handle empty directories
- emit structured stats

This targets the heaviest systems-style logic currently centered around:

- `apps/server/src/object-storage.ts`
- `apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts`

### 6.2 Second Priority: Sandbox Seed Upload

After workspace sync is stable, a second binary can handle:

- seed upload planning
- parallel local file reads
- batched remote writes
- upload progress and stats

This can either:

- stay inside `oah-workspace-sync`
- or become `native/oah-sandbox-seed`

The simpler starting point is to keep it in `oah-workspace-sync`.

### 6.3 Third Priority: Archive Export

Once the sync path proves useful, a separate Rust binary can handle:

- daily archive export
- JSON serialization
- checksum generation
- SQLite bundle writing
- retention cleanup

Suggested name:

- `native/oah-archive-export`

This is a good background-job candidate, but not the first target because it affects online latency less directly than workspace materialization and sync.

## 7. Integration Strategy

### 7.1 Use a Sidecar Binary First

The first integration should be a Rust sidecar CLI binary.

Do not begin with:

- Node N-API bindings
- a separate long-running Rust microservice

Reasons:

- simpler rollout
- easier debugging
- cleaner failure isolation
- easier Docker packaging
- easier local development
- easier fallback to TS

The TypeScript layer can invoke the binary using `spawn`, pass structured JSON in, and parse structured JSON out.

### 7.2 Why Not N-API First

N-API may eventually make sense if:

- call frequency is very high
- process startup overhead becomes noticeable
- the protocol is already stable

But it adds early complexity:

- native addon packaging
- ABI concerns
- more difficult debugging
- higher chance of crashing the Node process

For this repo, sidecar first is the safer and faster path.

## 8. Binary and Platform Expectations

Rust binaries are stable and production-friendly, but they are not "compile once and run everywhere" in the literal sense.

Practical constraints:

- macOS binaries do not run directly on Linux
- Windows binaries do not run directly on Linux or macOS
- `x86_64` binaries do not run directly on `arm64`
- Linux builds may differ depending on `glibc` vs `musl`

For Open Agent Harness, the expected deployment target is largely:

- Linux containers

So the main production target should be:

- `x86_64-unknown-linux-musl`
- `aarch64-unknown-linux-musl`

And local development can additionally support:

- `x86_64-apple-darwin`
- `aarch64-apple-darwin`

This is a good fit for Docker.

## 9. Docker Strategy

Rust is a very good fit for Docker.

Recommended production approach:

- build Rust binaries in a builder stage
- copy the resulting binary into the final runtime image
- keep the runtime image minimal

Recommended direction:

- prefer `musl` builds for Linux containers when feasible
- keep the TS runtime and the Rust binary in the same container at first

This keeps operations simple:

- one deployment artifact
- one process tree to reason about
- no extra network hop

## 10. Protocol Between TypeScript and Rust

The contract between TS and Rust should be explicit, versioned, and JSON-based.

Use:

- command-line subcommands for the operation
- JSON on stdin for input
- JSON on stdout for success result
- JSON on stderr or stdout for structured error objects

### 10.1 Example CLI Shape

```bash
oah-workspace-sync version
oah-workspace-sync fingerprint
oah-workspace-sync sync-local-to-remote
oah-workspace-sync sync-remote-to-local
oah-workspace-sync plan-seed-upload
```

### 10.2 Example Request

```json
{
  "localDir": "/workspace",
  "remotePrefix": "workspace/foo",
  "excludeRelativePaths": [
    ".openharness/state",
    ".openharness/__materialized__"
  ],
  "preserveMtime": true,
  "concurrency": 16
}
```

### 10.3 Example Success Response

```json
{
  "ok": true,
  "protocolVersion": 1,
  "stats": {
    "uploadedFileCount": 123,
    "deletedRemoteCount": 4,
    "createdEmptyDirectoryCount": 2,
    "localFingerprint": "abc123"
  }
}
```

### 10.4 Example Error Response

```json
{
  "ok": false,
  "protocolVersion": 1,
  "code": "s3_access_denied",
  "message": "Failed to upload object",
  "details": {
    "key": "workspace/foo/bar.txt"
  }
}
```

## 11. TypeScript Bridge Layer

Add a new package:

- `packages/native-bridge`

Its responsibilities should be intentionally small:

- resolve the correct binary path for the current platform
- run the binary
- encode request JSON
- parse response JSON
- enforce timeouts
- map native errors into TS `AppError` or internal error types
- decide whether to use native or TS fallback based on feature flags

It should not duplicate business logic.

Suggested files:

```text
packages/native-bridge/
  src/index.ts
  src/resolve-binary.ts
  src/run-native.ts
  src/workspace-sync.ts
  src/types.ts
```

## 12. Feature Flags and Fallback

Every Rust path must be guarded by a feature flag.

Suggested environment variables:

- `OAH_NATIVE_WORKSPACE_SYNC=1`
- `OAH_NATIVE_ARCHIVE_EXPORT=1`

Rollout behavior:

- default off at first
- when enabled, TS tries native path
- if native execution fails, log the failure and optionally fall back to TS

Suggested fallback policy:

- production default: fall back to TS for recoverable failures
- test/benchmark mode: fail hard so issues are visible

This avoids turning performance optimization into an availability risk.

## 13. Observability Requirements

Before rollout, add metrics and logs for both implementations.

Suggested metrics:

- `native_workspace_sync_invocations_total`
- `native_workspace_sync_failures_total`
- `native_workspace_sync_fallback_total`
- `native_workspace_sync_duration_ms`
- `native_workspace_sync_files_uploaded_total`
- `native_workspace_sync_files_downloaded_total`
- `native_workspace_sync_bytes_uploaded_total`
- `native_workspace_sync_bytes_downloaded_total`

Suggested structured log fields:

- `implementation`: `ts` or `rust`
- `operation`
- `workspaceId`
- `remotePrefix`
- `durationMs`
- `fileCount`
- `byteCount`
- `fallback`
- `errorCode`

These are needed to prove whether the change is worth keeping.

## 14. Benchmarking Plan

Before implementing Rust, establish baselines.

Measure at minimum:

- local directory scan time
- fingerprint computation time
- sync local to remote time
- sync remote to local time
- workspace first materialization time
- sandbox seed upload time
- memory usage during large syncs

Test datasets should include:

- many small files
- fewer large files
- deep directory nesting
- mixed file changes with deletions
- workspaces with `.openharness` state excluded

Do not judge success by intuition alone.

## 15. First Replacement Targets

The first TS paths to integrate with native execution should be:

- directory snapshot and fingerprint creation
- remote-to-local sync
- local-to-remote sync
- seed upload planning

Those map naturally to existing code in:

- `apps/server/src/object-storage.ts`
- `apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts`

Recommended migration sequence:

1. implement native fingerprint and local scan
2. integrate behind a feature flag
3. implement native sync-local-to-remote
4. implement native sync-remote-to-local
5. integrate sandbox seed upload planning and execution

## 16. Suggested Rust Crate Layout

### 16.1 `native/Cargo.toml`

This should define a Cargo workspace for all native components.

Example shape:

```toml
[workspace]
members = [
  "oah-workspace-sync",
  "oah-archive-export"
]
resolver = "2"
```

### 16.2 `native/oah-workspace-sync`

Suggested modules:

```text
src/
  main.rs
  cli.rs
  protocol.rs
  fs/
    walk.rs
    fingerprint.rs
    filters.rs
  sync/
    local_to_remote.rs
    remote_to_local.rs
    plan.rs
  s3/
    client.rs
    metadata.rs
  errors.rs
```

### 16.3 `native/oah-archive-export`

Suggested modules:

```text
src/
  main.rs
  cli.rs
  protocol.rs
  export/
    sqlite_bundle.rs
    checksum.rs
    retention.rs
  errors.rs
```

## 17. Recommended Rust Libraries

Suggested crates:

- `clap` for CLI parsing
- `serde` and `serde_json` for protocol types
- `tokio` for async orchestration
- `walkdir` or `ignore` for filesystem walking
- `sha1` and `sha2` for hashing
- `aws-sdk-s3` for object store operations
- `thiserror` for error typing
- `anyhow` for top-level command error handling

The stack should stay boring and mainstream.

## 18. CI and Release Plan

CI should do the following:

- run `cargo fmt --check`
- run `cargo clippy`
- run `cargo test`
- build release binaries for supported targets
- attach built binaries to CI artifacts or release artifacts

For local developer convenience:

- keep `cargo build` working inside `native/`
- add a root script such as `pnpm native:build`
- make the TS bridge able to find either:
  - checked-in local dev binary path
  - CI-produced artifact path

Suggested root scripts:

```json
{
  "scripts": {
    "native:build": "node ./scripts/build-native.mjs",
    "native:check": "cd native && cargo check",
    "native:test": "cd native && cargo test"
  }
}
```

## 19. Runtime Compatibility Rules

The TS bridge should enforce:

- binary exists
- binary is executable
- reported `protocolVersion` matches expected version

If any check fails:

- log a warning
- use the TS fallback when allowed

This avoids silent protocol drift.

## 20. Security and Operational Constraints

The native binaries must follow the same operational boundaries as the TS implementation:

- respect workspace root constraints
- respect excluded paths
- avoid deleting outside the intended root
- preserve current semantics for `.openharness` state exclusions
- surface errors with enough context for auditability

The Rust layer must not become a second policy engine.
It should only execute the requested operation within TS-defined rules.

## 21. Risks

The main risks are not Rust language stability.
They are engineering and operations risks:

- more complex build pipeline
- cross-platform binary distribution
- drift between TS and Rust behavior
- harder debugging across process boundaries
- accidental semantic mismatch in sync rules
- developer onboarding cost

These risks are manageable if the scope is narrow and the protocol is explicit.

## 22. Non-Goals

This plan does not propose:

- rewriting the model gateway in Rust
- rewriting Fastify or the HTTP layer
- moving the orchestration engine into Rust
- replacing Redis/PostgreSQL repositories with Rust implementations
- introducing a mandatory external Rust service

Those changes would be much higher cost and are not justified by the expected performance profile of this repository.

## 23. Implementation Phases

### Phase 0: Measurement

- add baseline metrics around current TS sync/materialization paths
- define benchmark datasets
- document current p50/p95 timings

### Phase 1: Native Scaffold

- add `native/` Cargo workspace
- add `native/oah-workspace-sync`
- add `packages/native-bridge`
- add root scripts for build/check/test

### Phase 2: Fingerprint and Scan

- implement native local directory walk
- implement native fingerprint command
- integrate behind `OAH_NATIVE_WORKSPACE_SYNC`
- compare results against TS implementation

### Phase 3: Local-to-Remote Sync

- implement native sync planning
- implement uploads, deletions, directory handling
- validate semantics and metrics

### Phase 4: Remote-to-Local Sync

- implement remote listing reconciliation
- preserve mtime semantics
- validate path exclusion behavior

### Phase 5: Sandbox Seed Support

- reuse native scan and upload planning for seed upload
- integrate with workspace initializer behind flag

### Phase 6: Archive Export

- add `native/oah-archive-export`
- move archive bundle writing and checksum work if benchmarks justify it

## 24. Recommendation

The recommended approach for Open Agent Harness is:

- use `native/` as the home for Rust code
- start with a sidecar CLI binary
- target workspace sync and materialization first
- keep TypeScript as the orchestration and policy layer
- build for Linux Docker as the primary production target
- keep feature-flagged TS fallbacks until native behavior is proven

This gives the repository the likely benefits of Rust where they matter most, without paying the cost of a broad multi-language rewrite.
