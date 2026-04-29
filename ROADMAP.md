# OAH Controller / Worker Architecture Roadmap

## 1. Purpose

This roadmap captures the current architecture direction after the `controller` naming and control-plane unification work.

It is not only a rename log. It records the design shifts that now define the next stage of OAH:

- `API Server + Worker + Controller` becomes the formal production topology
- `Worker` stays the unified execution role
- `Controller` expands from simple replica scaling into placement and lifecycle governance
- `sandbox` is treated as the worker host environment, not as a replacement runtime role
- sandbox host capabilities should be exposed behind a stable adapter boundary so self-hosted pods and E2B-like backends can both fit
- `workspace ownership` remains the routing and file-access truth boundary

## 2. What Changed Beyond Naming

### 2.1 Control Plane Scope Expanded

Previously the control plane was often framed as a narrow worker-scaling component:

- worker replica scaling
- queue pressure observation
- leader election

The current accepted model is broader:

- workspace placement
- user-affinity aware scheduling
- worker / pod lifecycle governance
- drain / recovery / rebalance
- capacity-aware scaling

So the real change is:

- from `replica scaler`
- to `control plane`

### 2.2 Worker Is Now Clearly the Execution Role

The current architecture explicitly fixes:

- `Worker` is the execution runtime role
- `Worker` can be embedded inside `API Server`
- `Worker` can run standalone in its own pod
- future sandbox pods are only a host/isolation shape for workers

This keeps one execution core across:

- local development
- embedded mode
- split production mode
- future sandbox-backed mode

### 2.3 Sandbox Is No Longer the Primary Domain Term

We are intentionally not redefining the whole system around `sandbox`.

The preferred interpretation is:

- `sandbox` = host environment / isolation boundary
- `worker` = execution role
- `controller` = control plane role

This avoids coupling core architecture to one backend shape too early.

### 2.4 Self-Hosted Sandbox Pod Comes Before Native E2B Adoption

The accepted implementation order is:

- first keep OAH's own sandbox pod shape as the production execution host
- then align the host-facing adapter boundary with the subset of E2B-style lifecycle and file APIs we actually need
- only after that consider a real E2B-backed host adapter

This means:

- we are optimizing for compatibility, not immediate replacement
- we do not want current control-plane, ownership, or OSS semantics to depend on E2B-specific resource models
- the self-hosted sandbox pod remains the reference implementation for worker hosting

### 2.5 Host Compatibility Is An Adapter Concern

The preferred split is:

- `Worker` remains the execution role and business runtime
- `sandbox host` provides process / filesystem / lifecycle isolation
- `Sandbox Host API` is the compatibility boundary

That boundary should cover only what OAH really needs:

- sandbox/session creation and reuse
- workspace mount / materialization
- file read / write / download
- command / process execution
- liveness / readiness / drain / termination

It should not force the rest of OAH to inherit:

- E2B naming as the primary domain language
- E2B-specific persistence assumptions
- per-sandbox truth semantics that conflict with `workspace -> owner worker`

### 2.6 Workspace Ownership Remains the Truth Boundary

The current roadmap keeps:

- `workspace -> owner worker` as routing truth
- active workspace read/write truth on the owner worker `Active Workspace Copy`
- idle flush / eviction returning truth to OSS

This means we are not moving to:

- `owner -> pod` as ownership truth
- shared multi-writer workspace truth
- cross-pod live sync as the main model

### 2.7 Owner Affinity Is a Placement Hint, Not Ownership

`ownerId` is now treated as:

- placement affinity key
- warm-cache reuse hint
- capacity / quota dimension

But not:

- the execution truth key
- a guarantee that one owner maps to exactly one pod

The accepted policy is:

- same-owner workspaces should prefer the same worker / pod
- but may spill to another worker when capacity, disk, drain, or health requires it

### 2.8 Controller Becomes the Future Home of Placement Logic

The long-term split is now:

- `API Server`: ingress, auth context, metadata persistence, owner routing
- `Worker`: execution, materialization, file access, run lifecycle
- `Controller`: placement, lifecycle, capacity, rebalance, scale

This is the main architectural shift beyond terminology.

## 3. Naming End State

The codebase now uses `controller` as the only primary control-plane name:

- `apps/controller/`
- `@oah/controller`
- `OAH_CONTROLLER_*`
- `oah_controller_*`
- `deploy/kubernetes/controller.yaml`
- `deploy/controller-servicemonitor.yaml`
- Helm `controller.*` values

## 4. Target Architecture

### 4.1 Production Topology

- `API Server`
- `Worker`
- `Controller`
- `PostgreSQL`
- `Redis`
- `OSS / Object Storage`

### 4.2 Responsibility Split

`API Server`

- external API
- SSE
- caller context
- metadata persistence
- owner lookup and proxying

`Worker`

- engine-core execution
- session-serial boundaries
- workspace materialization
- local file access
- idle flush / eviction
- run recovery closure

`Controller`

- worker placement policy
- owner affinity policy
- health / drain aware scaling
- rebalance and recovery decisions

`Sandbox Host API`

- worker host lifecycle abstraction
- self-hosted sandbox pod reference implementation
- future E2B-compatible adapter boundary
- no change to worker execution semantics

## 5. Delivery Phases

### Phase A: Naming And Topology Unification

- rename formal package/runtime identity to `controller`
- update logs, manifests, chart resource names, and docs
- remove legacy control-plane path and file names
- remove legacy control-plane aliases

Status:

- done

### Phase B: Placement-Aware Controller

- move controller narrative from replica scaler to placement control plane
- define worker selection inputs:
  - owner affinity
  - workspace ownership
  - current worker health
  - capacity
  - drain state
- keep actual execution in workers

Status:

- done

Implemented so far:

- controller snapshots now expose first-class placement summaries rather than only replica counts
- controller now distinguishes placement ownership on healthy / late / missing workers
- controller scale-down is blocked while placement ownership is still unstable
- controller now emits placement policy signals covering:
  - unassigned workspaces
  - missing / late / draining owner workers
  - owners spanning multiple workers
  - workers whose placement ref-load exceeds the soft slots-per-pod capacity
- controller can now surface `placement_attention` even when replica count stays steady, so placement governance is no longer invisible behind scale-only reasons
- controller snapshots now also emit structured placement recommendations such as:
  - assign unassigned workspaces
  - recover missing owners
  - reassign late owners
  - finish draining owners
  - consolidate owner affinity
  - rebalance workers above soft placement capacity
- placement recommendations now include representative workspace / worker / owner samples so the control plane output can feed concrete rebalance and recovery workflows later
- controller now emits a placement action-plan shape on top of recommendations, including:
  - execution phase (`stabilize` / `handoff` / `optimize`)
  - blocker type
  - next suggested item
  - concrete workspace / worker / owner scopes for follow-up
- controller now also derives machine-actionable placement execution operations from live placement state, rather than stopping at descriptive recommendations
- an optional placement executor can now perform the first safe ownership-handoff actions:
  - release placements that still point to missing owners
  - release placements on draining / stopping owners
  - release idle placements on late owners while skipping still-active workspaces
- controller snapshots and metrics now expose placement execution results (`attempted` / `applied` / `skipped` / `failed`) so remediation is observable
- controller runtime wiring now supports enabling these placement actions explicitly via `OAH_CONTROLLER_PLACEMENT_ACTIONS_ENABLED`
- controller placement execution now also selects concrete target workers using the same core inputs the rest of OAH uses:
  - worker health
  - drain state
  - workspace affinity
  - owner affinity
  - soft-capacity pressure
- placement state can now persist controller handoff hints via `preferredWorkerId`, so reassignment is no longer just "drop ownership and hope"
- unassigned workspaces, late owners, user-affinity splits, and soft-capacity hot spots can now all produce target-worker hints instead of only descriptive recommendations
- Redis worker affinity summaries and storage admin inspection now surface controller-target reasons directly, making placement handoff visible outside the controller loop

### Phase C: Workspace Placement State

- introduce first-class placement state for:
  - `workspaceId`
  - `ownerId`
  - `ownerWorkerId`
  - `ownerBaseUrl`
  - capacity / lifecycle metadata
- keep ownership truth at workspace level

Status:

- done

Implemented so far:

- Redis `workspace placement registry` now exists as a first-class state store, separate from transient workspace ownership leases
- materialized workspace lifecycle now publishes placement state transitions such as `active` / `idle` / `draining` / `evicted`
- workspace creation/import can seed `ownerId` into placement state
- storage admin now exposes workspace placement snapshots for inspection
- worker affinity inspection now derives `same_owner` preference from workspace placement state, so sibling workspaces for the same owner can prefer a warm worker without changing workspace ownership truth
- controller snapshots and metrics now distinguish placements on healthy / late / missing owner workers, and controller scale-down is blocked while placement ownership is still unstable
- workspace placement inspection now supports filtering by `workspaceId`, `ownerId`, `ownerWorkerId`, and `state`, making placement state usable for control-plane debugging and future placement workflows

### Phase D: Sandbox-Backed Worker Hosts

- define a stable sandbox host adapter boundary
- keep self-hosted sandbox pods as the first production backend
- keep worker execution semantics unchanged
- treat sandbox as host environment only

Status:

- done

Implemented so far:

- `engine-core` now carries a first-class `SandboxHost` contract alongside the existing execution / file-access provider seam
- the shared host contract now includes:
  - provider kind (`embedded` / `self_hosted` / `e2b`)
  - workspace command execution
  - workspace file access
  - workspace execution lease acquisition
  - host diagnostics
  - host maintenance / drain / close lifecycle
- the materialization-backed worker host is now the first concrete implementation of that contract
- `api-server` bootstrap now treats sandbox host bindings as a single host surface instead of an ad-hoc group of separate runtime injections
- worker execution semantics remain unchanged:
  - `workspace -> owner worker` is still the truth boundary
  - materialization-backed local copies are still the active read/write truth while mounted on the owner worker
  - drain / idle flush / idle eviction semantics are unchanged

### Phase E: E2B-Compatible Host Adapter

- align the sandbox host API with the E2B subset OAH actually needs
- preserve OAH ownership, routing, and OSS semantics
- keep E2B as an optional backend, not the primary architecture vocabulary

Status:

- done

Implemented so far:

- server bootstrap now accepts an injected sandbox host factory, so non-self-hosted backends can plug in without rewriting runtime bootstrap
- a first `createE2BCompatibleSandboxHost(...)` adapter now exists for bridging an E2B-style remote sandbox service into OAH's `SandboxHost` contract
- that adapter now covers the OAH subset we actually need:
  - execution lease acquisition
  - file-access lease acquisition
  - foreground / process / background command execution
  - file stat / read / readdir / mkdir / write / rm / rename
  - diagnostics / maintain / beginDrain / close lifecycle
- the adapter uses a virtual sandbox path boundary so engine-core and server code can keep using normal workspace path semantics while the backend remains remote
- E2B compatibility remains optional and adapter-scoped:
  - `embedded` remains the local materialization backend
  - `self_hosted` remains the remote self-hosted sandbox backend
  - bootstrap injection is the extension point
  - ownership truth and OSS semantics remain unchanged

### Phase F: Sandbox Fleet Signals

- make sandbox fleet demand a first-class controller concern
- keep worker execution and sandbox hosting as separate layers
- derive sandbox grouping from `ownerId` affinity instead of inventing a new API surface
- prepare for future sandbox autoscaling targets without forcing one backend today

Status:

- in progress

Implemented so far:

- server config now exposes `sandbox.fleet.*` for remote sandbox capacity hints:
  - `min_count`
  - `max_count`
  - `max_workspaces_per_sandbox`
  - `ownerless_pool`
- controller now resolves a first-class `SandboxFleetConfig` from `embedded | self_hosted | e2b`
- controller snapshots now include `sandboxFleet`, which derives:
  - owner-scoped workspace counts
  - ownerless workspace counts
  - logical sandbox demand
  - bounded desired sandbox count
  - whether fleet demand is capped by configured max capacity
- controller metrics now expose sandbox fleet signals so `self_hosted` / `e2b` rollouts can observe real demand before attaching a concrete autoscaling target

Still remaining:

1. add a real sandbox registry / observed active sandbox inventory instead of logical demand only
2. attach `sandboxFleet.desiredSandboxes` to a concrete scaling target for self-hosted sandbox deployments
3. add an E2B-native control path for sandbox lifecycle reuse / warm-pool management

## 6. Completion Audit

Current state:

- `Phase A-E` are implemented at the architecture / contract layer.
- `Phase F` has started with real controller/config/metrics wiring, but does not yet own concrete sandbox scaling actions.
- placement hints already feed real runtime queueing paths via `preferredWorkerId`, not only storage/admin inspection.
- worker ownership, sticky routing, self-hosted default backend, and adapter-scoped E2B compatibility remain intact.

The main remaining follow-up is:

1. Add a production-grade sandbox fleet control path:
   - real remote sandbox inventory / registry
   - self-hosted sandbox autoscaling target
   - native E2B lifecycle adapter behind the same contract

That means this roadmap is largely complete at the contract level, but not fully closed if the goal is "controller-managed sandbox fleet that can switch seamlessly between self_hosted and e2b in production".

## 7. Large-Storage Readiness Roadmap

This section tracks optimization work found during the large data volume deployment review.

Current summary: the split topology is directionally sound, but the deployment skeleton and a few storage paths still assume development or medium-size datasets. Large workspace trees, large files, many object-store keys, high message volume, and long archive retention can currently cause disk pressure, memory spikes, slow drain, slow materialization, and debug/inspection queries that are too expensive for production.

### Phase G: Production Storage Contracts

Status:

- pending

Goals:

1. Make object storage a first-class production requirement in Helm examples and production docs, not an implicit external assumption.
2. Replace the default `worker.workspaceVolume.emptyDir.sizeLimit: 8Gi` production path with explicit PVC or sized ephemeral-storage guidance.
3. Add per-worker and per-workspace disk watermarks so new materializations are refused or redirected before the node fills.
4. Add workspace-level quota fields or policy hooks for maximum active copy size, maximum object count, and maximum single-file size.
5. Document that `docker-compose.local.yml` is a development stack only; its Postgres, Redis, and MinIO defaults are intentionally undersized for large data.

Implementation notes:

- Helm should expose storage-class, requested capacity, access mode, and optional PVC creation for worker workspace cache.
- Worker readiness should surface local disk pressure and materialization failure count.
- Controller placement should eventually treat disk pressure as a first-class capacity signal.

### Phase H: Object Storage Sync Scalability

Status:

- pending

Risks to address:

1. `listEntries` currently materializes and sorts all objects under a prefix.
2. `getObject`, `putObject`, and tar bundle paths use whole-object `Buffer` flows in TypeScript fallback paths.
3. Manifest and bundle handling can grow large for huge workspaces or many small files.
4. Drain and idle flush can be blocked by slow full-tree diff, full-prefix listing, or large bundle upload.

Goals:

1. Stream S3 downloads/uploads instead of buffering whole objects.
2. Use multipart upload for large files and large bundles.
3. Stream bundle creation/extraction where possible; avoid `readFile(bundlePath)` for large archives.
4. Add paged object listing and paged diff planning, so huge prefixes do not need to be resident in memory.
5. Split sync manifests by shard or prefix for large workspaces.
6. Add configurable per-operation timeouts, retry budgets, and byte/object-count limits.
7. Add metrics for materialization bytes, object counts, list pages, flush duration, and drain-blocking syncs.

### Phase I: Postgres Growth And Archive Lifecycle

Status:

- pending

Risks to address:

1. Archive rows currently store full deleted workspace/session trees as large JSONB payloads.
2. Deletion archive construction can load all sessions, runs, messages, steps, tool calls, hooks, and artifacts into memory.
3. Archive export exists as a utility class, but production bootstrap does not currently run it as an enabled background lifecycle.
4. `history_events`, `session_events`, and recovery metadata can grow without clear production retention defaults.

Goals:

1. Move archive payloads to object storage or exported SQLite bundles by default, leaving only compact index rows in Postgres.
2. Stream archive construction instead of building one large in-memory object.
3. Wire `WorkspaceArchiveExporter` into production bootstrap behind explicit config.
4. Add retention config for exported archive rows, `history_events`, `session_events`, and old completed runs where product policy allows it.
5. Add partial indexes for recovery inspection paths, especially `metadata->'recovery'->>'state'`.
6. Add production guidance for partitioning high-volume tables by time or workspace/service scope.

### Phase J: Storage Admin Safety

Status:

- in progress

Risks to address:

1. Storage overview currently runs broad `count(*)` queries across all inspected Postgres tables.
2. Recovery summaries scan JSON recovery metadata in `runs`.
3. Table browsing can use `row_to_json(table)::text ilike`, which is intentionally expensive.
4. Redis overview previously used broad `KEYS` calls for session queue/lock/event keys.

Goals:

1. Replace Redis overview `KEYS` calls with bounded `SCAN`.
2. Add explicit caps and `truncated` signals for Redis overview arrays.
3. Make expensive Postgres counts optional, cached, or approximate for production.
4. Require filters or an explicit opt-in for full-row text search on large tables.
5. Prefer keyset pagination over offset pagination for deep table browsing.
6. Keep storage admin routes debug/operator-facing, not part of the hot user path.

Progress:

- bounded Redis overview scanning implemented for session queue, lock, and event keys
- Redis overview responses now expose truncation flags when the configured scan cap is reached

### Phase K: Production Observability And SLOs

Status:

- pending

Goals:

1. Add alerts for worker workspace disk pressure, object-store sync failure rate, drain flush duration, and materialization latency.
2. Add Postgres table and index bloat monitoring guidance.
3. Add Redis memory, AOF rewrite, key count, and queue depth alerts.
4. Add object-storage request count, error rate, latency, and throttling metrics.
5. Extend rollout checklist with large-workspace, high-message-volume, and drain-under-load tests.

### Phase L: Deployment Hardening For Large Data

Status:

- pending

Goals:

1. Add production values examples with explicit object storage, PVC capacity, and resource sizing.
2. Document managed Postgres / Redis / object storage as the recommended production path.
3. Add backup and restore runbooks for Postgres, Redis queue state, object storage prefixes, and archive exports.
4. Add lifecycle policies for workspace backing-store prefixes, archive exports, and old readonly mirrors.
5. Add a capacity planning doc covering active workspace cache size, object count, session/message growth, archive retention, worker drain timing, and expected sync bandwidth.

## 8. Non-Goals Right Now

- replacing `worker` with `sandbox` as the primary runtime term
- moving ownership truth from workspace to user
- introducing multi-writer live workspace sync between pods
- removing embedded worker mode
- rebuilding OAH directly around the full E2B resource model
- forcing a breaking config migration in one step
