---
title: "Production Storage Readiness"
---

# Production Storage Readiness

This checklist is the production baseline for large workspace deployments. The core rule is simple: keep `oah-api` stateless and thin; put workspace materialization, object-store sync, and cache pressure on restartable `oah-sandbox` workers.

## Required Storage

- PostgreSQL is the source of truth for metadata, runs, sessions, workspace records, archive metadata, and retention bookkeeping.
- Redis is required for distributed run queues, worker leases, placement pressure, and controller scaling signals.
- S3-compatible object storage is required for production managed workspaces. Configure `object_storage.workspace_backing_store.enabled=true` and a dedicated `key_prefix`.
- Worker workspace/cache storage must be explicitly sized. Use either a PVC per worker pool or an `emptyDir.sizeLimit` plus `ephemeral-storage` requests/limits.

In Helm production values, set:

```yaml
objectStorage:
  enabled: true
  bucket: oah-prod-workspaces
  region: us-east-1
  workspaceBackingStore:
    enabled: true
    keyPrefix: workspaces

worker:
  resources:
    requests:
      ephemeral-storage: 32Gi
    limits:
      ephemeral-storage: 64Gi
  workspaceVolume:
    type: persistentVolumeClaim
    persistentVolumeClaim:
      claimName: oah-prod-workspaces
  diskReadiness:
    threshold: "0.92"
  workspacePolicy:
    maxObjects: "200000"
    maxBytes: "214748364800"
    maxFileBytes: "5368709120"
```

`OAH_OBJECT_STORAGE_SYNC_MAX_OBJECTS`, `OAH_OBJECT_STORAGE_SYNC_MAX_BYTES`, and `OAH_OBJECT_STORAGE_SYNC_MAX_FILE_BYTES` are enforced before worker uploads local workspace copies. Oversized workspaces fail fast instead of growing the Node heap during sync.

## Worker Disk Watermarks

Workers expose disk pressure through two paths:

- worker leases report disk usage from `OAH_WORKER_DISK_METRICS_PATH`, which the Helm chart points at the worker workspace volume
- `/readyz` returns `503` with `reason=worker_disk_pressure` when local worker paths exceed `OAH_WORKER_DISK_READINESS_THRESHOLD`

Set the readiness threshold below the kubelet eviction point. A practical starting point is `0.90` to `0.92` for PVC-backed workers and `0.85` to `0.90` for small `emptyDir` caches.

## Alerts

Enable the Helm `prometheusRule` or apply `deploy/controller-prometheusrule.yaml`. Production alerting should cover:

- worker resource pressure: `OAHWorkerDiskPressure`
- slow workspace materialization/sync: `OAHWorkspaceMaterializationSlow`
- object-store timeout/throttle rate: `OAHObjectStorageSyncFailureRate`
- object-store latency: `OAHObjectStorageLatencyHigh`
- Redis ready queue backlog: `OAHRedisReadyQueueDepthHigh`
- Redis memory pressure from redis-exporter: `OAHRedisMemoryHigh`
- PostgreSQL table bloat from postgres-exporter: `OAHPostgresBloatHigh`
- controller leader/rollout/drain gates: existing controller alerts

## Backup

Back up these stores on the same schedule and keep restore points aligned:

- PostgreSQL: `pg_dump` or managed PITR for the OAH database
- Redis: RDB/AOF snapshot if queue recovery across Redis loss is required
- Object storage: bucket versioning or prefix replication for workspace backing prefixes
- Archive payload root: if using Postgres archive external payload files, back up `runtime_state_dir/archive-payloads` with the database snapshot
- Archive exports: copy `runtime_state_dir/archives` when exports are used for offline recovery

## Restore

1. Restore PostgreSQL first.
2. Restore object-storage workspace prefixes before admitting workers.
3. Restore `archive-payloads` to the same configured `runtime_state_dir` if archive rows reference external payload files.
4. Restore Redis only when preserving already queued work is required; otherwise start Redis empty and let stale-run recovery requeue from PostgreSQL.
5. Start controllers, then workers, then API. Keep API up but avoid creating new workspaces until worker `/readyz` is healthy.
6. Run a smoke test that creates a managed workspace, materializes it on a worker, flushes it to object storage, and reloads it on a fresh worker.
