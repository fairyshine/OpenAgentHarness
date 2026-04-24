# Server Configuration

Configuration format: YAML. Default filename: `server.yaml`.

---

## Minimal Configuration

```yaml
server:
  host: 0.0.0.0          # Listen address
  port: 8787              # Listen port

storage: {}
  # postgres_url: ${env.DATABASE_URL}   # Optional; falls back to local SQLite shadow storage when omitted
  # redis_url: ${env.REDIS_URL}         # Optional; runs execute inline in the API process when omitted

sandbox:
  provider: embedded                  # embedded | self_hosted | e2b
  # fleet:
  #   min_count: 1
  #   max_count: 32
  #   max_workspaces_per_sandbox: 32
  #   ownerless_pool: shared          # shared | dedicated
  # self_hosted:
  #   base_url: http://oah-sandbox:8787/internal/v1
  # e2b:
  #   base_url: https://api.e2b.dev
  #   api_key: ${env.E2B_API_KEY}

paths:
  workspace_dir: /srv/openharness/workspaces       # Project workspace root
  runtime_state_dir: /srv/openharness/.openharness  # Runtime-private state root
  runtime_dir: /srv/openharness/runtimes        # Workspace runtime directory
  model_dir: /srv/openharness/models               # Platform model directory
  tool_dir: /srv/openharness/tools                 # Platform tool directory
  skill_dir: /srv/openharness/skills               # Platform skill directory

workers:
  embedded:
    min_count: 2                # Minimum worker count in API + embedded worker mode
    max_count: 4                # Upper bound for light local autoscaling
    scale_interval_ms: 1000     # Scaling check interval
    idle_ttl_ms: 30000          # How long surplus workers may stay idle before cleanup
    scale_up_window: 2          # Consecutive high-pressure samples required before scale-up
    scale_down_window: 2        # Consecutive low-pressure samples required before scale-down
    cooldown_ms: 1000           # Minimum cooldown between scaling actions
    reserved_capacity_for_subagent: 1  # Spare capacity reserved for subagent backlog

llm:
  default_model: openai-default   # Default model name (must exist in model_dir)
```

> **info**
> Use `${env.VAR_NAME}` syntax to reference environment variables.

> **tip**
> Neither `storage.postgres_url` nor `storage.redis_url` is mandatory. Omitting PostgreSQL falls back to local SQLite shadow persistence; omitting Redis keeps run execution inline in the current API process.

---

## Configuration Fields

### `server`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | string | `127.0.0.1` | Listen address |
| `port` | number | `8787` | Listen port |

### `storage`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `postgres_url` | string | No | PostgreSQL connection string. Workspaces without `serviceName` use this database directly; once `serviceName` is set, the default database keeps only the workspace/session/run routing index while runtime truth is routed to a sibling derived database name (for example `OAH-acme`). When omitted, OAH falls back to local SQLite shadow persistence. |
| `redis_url` | string | No | Redis connection string. Used for queues, locks, rate limiting, and SSE event fanout. |

> **tip**
> Without PostgreSQL, workspace/session/run persistence falls back to local SQLite shadow state. That is fine for single-node development, but it is not a shared source of truth for multi-instance deployments.

> **tip**
> Without Redis, runs execute in-process on the API server (suitable for local dev). With Redis, multiple worker instances can consume the queue.

### `object_storage`

| Field | Type | Description |
| --- | --- | --- |
| `provider` | string | Currently only `s3`-compatible object storage is supported |
| `bucket` | string | Target bucket |
| `region` | string | Object storage region |
| `endpoint` | string | Optional custom S3/OSS/MinIO endpoint |
| `access_key` | string | Optional access credential |
| `secret_key` | string | Optional access credential |
| `session_token` | string | Optional temporary credential |
| `force_path_style` | boolean | Whether to force path-style URLs |
| `workspace_backing_store.enabled` | boolean | Enables managed workspace object-storage backing. Active workspace writes still flush only on idle / drain / delete |
| `workspace_backing_store.key_prefix` | string | Object-storage key prefix used for workspace backing |
| `mirrors.paths` | string[] | Readonly prefixes mirrored locally. Supports `runtime / model / tool / skill` |
| `mirrors.sync_on_boot` | boolean | Whether mirrored prefixes should be pulled from object storage on startup |
| `mirrors.sync_on_change` | boolean | Whether mirrored readonly prefixes are polled for changes. This does not live-sync active workspace writes |
| `mirrors.poll_interval_ms` | number | Mirror poll interval |
| `mirrors.key_prefixes.*` | object | Object-storage key prefix mapping for each readonly mirrored path |
| `managed_paths` / `key_prefixes.*` / `sync_on_*` | legacy | Backward-compatible legacy fields; prefer `workspace_backing_store` and `mirrors` for new configs. Loading them emits a deprecation warning |

> **tip**
> `runtime / model / tool / skill` in `mirrors.paths` are still mirrored through `ObjectStorageMirrorController` on boot and on change polling.

> **tip**
> `workspace_backing_store` only controls managed workspace `externalRef` / backing-store semantics. Active workspace writes do not flush on every change; they flush through the workspace materialization idle / drain lifecycle.

### `sandbox`

| Field | Type | Description |
| --- | --- | --- |
| `provider` | string | Sandbox provider. Supports `embedded`, `self_hosted`, and `e2b`. Defaults to `embedded`. `embedded` means the worker is hosted inside `oah-api`; `self_hosted / e2b` mean a standalone worker runs inside a real sandbox. |
| `fleet.min_count` | number | Minimum sandbox count the controller should maintain for self-hosted / e2b providers. Defaults to `1` for remote providers and `0` for embedded. |
| `fleet.max_count` | number | Maximum sandbox count the controller may target. Defaults to `64`. |
| `fleet.max_workspaces_per_sandbox` | number | Capacity limit for how many workspaces a single real sandbox should carry. Defaults to `32`. |
| `fleet.ownerless_pool` | string | How workspaces without `ownerId` are grouped into sandboxes. `shared` uses a shared pool; `dedicated` gives each workspace its own sandbox. |
| `self_hosted.base_url` | string | Required when `provider=self_hosted`. Base `/internal/v1` URL exposed by the sandbox-resident standalone worker. |
| `self_hosted.headers` | object | Optional static headers attached to remote self-hosted sandbox requests. |
| `e2b.base_url` | string | Optional when `provider=e2b`. Overrides the native E2B API base URL; legacy `/internal/v1`-style URLs are normalized automatically. |
| `e2b.api_key` | string | Optional. When set, OAH sends it as `Authorization: Bearer <key>` on e2b requests. |
| `e2b.domain` | string | Optional. Overrides the E2B sandbox domain. |
| `e2b.template` | string | Optional. Selects the E2B template used when creating sandboxes. |
| `e2b.timeout_ms` | number | Optional. Timeout for sandbox create / resolve operations. |
| `e2b.request_timeout_ms` | number | Optional. Timeout for individual E2B HTTP requests. |
| `e2b.headers` | object | Optional static headers attached to e2b requests. |

> **tip**
> OAH keeps the external `/sandboxes` API stable. Switching `sandbox.provider` changes only the server-side sandbox backend wiring; the Web app, OpenAPI clients, and runtime callers do not need to change their request shape.

> **tip**
> The `/sandboxes` surface, the `/workspace` root, and sandbox-scoped file / command semantics are intentionally kept this way to stay compatible with [E2B](https://github.com/e2b-dev/E2B). Treat them as a deliberate contract, not as a temporary legacy shim that should default back to `/workspaces`. The `/workspaces` API itself still remains in place for workspace metadata, catalog, and lifecycle concerns.

> **tip**
> `self_hosted` and `e2b` share the same execution semantics: `oah-api` routes workspaces into a real sandbox, while the standalone worker inside that sandbox owns the live workspace copy, local file state, and command execution context.

> **tip**
> The controller now treats sandbox fleet demand as a first-class signal: the same `ownerId` prefers the same real sandbox, while ownerless workspaces fall into a shared pool by default. `fleet.*` defines that capacity boundary and is the contract we can later wire into real sandbox autoscaling targets.

> **tip**
> Starting with the current version, `createSession` asynchronously prewarms the target workspace after the session is created. With a remote sandbox provider, that eagerly binds the workspace to a sandbox; with workspace materialization enabled, it also prepares the active workspace copy ahead of the first user message. Combined with the remote-provider default `fleet.min_count = 1`, this removes most first-message cold-start latency, although very large first-time materializations can still dominate.

> **tip**
> `sandbox` is a host-layer concept, not a project-layer concept. One sandbox may carry multiple active workspaces. It answers “where does the worker run?”, while a workspace answers “which project and capability set is being executed?”

### `paths`

| Field | Type | Description |
| --- | --- | --- |
| `workspace_dir` | string | Project workspace root directory |
| `runtime_state_dir` | string | Runtime-private state root for SQLite shadow data, archive exports, and legacy materialization state. Defaults to `dirname(workspace_dir)/.openharness` |
| `runtime_dir` | string | Workspace runtime directory |
| `model_dir` | string | Platform model definition directory |
| `tool_dir` | string | Platform tool source directory, primarily used for runtime imports and shared single-workspace sources |
| `skill_dir` | string | Platform skill source directory, primarily used for runtime imports and shared single-workspace sources |

### `workspace`

| Field | Type | Description |
| --- | --- | --- |
| `materialization.idle_ttl_ms` | number | How long an active workspace copy may stay idle before flush / cleanup is considered. Default `1800000`. |
| `materialization.maintenance_interval_ms` | number | Background maintenance interval for workspace materialization. Default `5000`. |

> **tip**
> `workspace.materialization` primarily affects object-storage backing stores, remote sandboxes, and active workspace-copy lifecycle timing. It does not change the declarative workspace capability model.

### `llm`

| Field | Type | Description |
| --- | --- | --- |
| `default_model` | string | Default model name. Must exist in `model_dir`. Resolved to `platform/<name>` at runtime. |

### `workers`

| Field | Type | Description |
| --- | --- | --- |
| `embedded.min_count` | number | Minimum always-on worker count in `API + embedded worker` mode. |
| `embedded.max_count` | number | Maximum embedded worker count under queue pressure. |
| `embedded.scale_interval_ms` | number | Rebalance interval for the embedded worker pool. |
| `embedded.idle_ttl_ms` | number | How long surplus embedded workers may stay idle before cleanup. |
| `embedded.scale_up_window` | number | Consecutive high-pressure samples required before scaling up. |
| `embedded.scale_down_window` | number | Consecutive low-pressure samples required before scaling down. |
| `embedded.cooldown_ms` | number | Cooldown between embedded worker scaling actions. |
| `embedded.reserved_capacity_for_subagent` | number | Minimum spare embedded capacity reserved for subagent backlog. |
| `standalone.min_replicas` | number | Minimum sandbox replicas the controller may keep for standalone workers. Set `0` to allow scale-to-zero when idle. |
| `standalone.max_replicas` | number | Maximum sandbox replicas the controller may target for standalone workers. |
| `standalone.ready_sessions_per_capacity_unit` | number | Queue-density target used by the controller when translating observed worker capacity into sandbox replica demand. |
| `standalone.reserved_capacity_for_subagent` | number | Minimum observed execution capacity reserved for subagent backlog. |
| `standalone.slots_per_pod` | number | Legacy compatibility field. The controller no longer uses this static value to size sandbox replicas and instead relies on worker-reported observed capacity. |
| `controller.scale_interval_ms` | number | How often the controller samples backlog / worker-registry state and recomputes desired replicas. |
| `controller.scale_up_window` | number | Consecutive high-pressure samples required before scaling up. |
| `controller.scale_down_window` | number | Consecutive low-pressure samples required before scaling down. |
| `controller.cooldown_ms` | number | Cooldown between controller scaling actions. |
| `controller.scale_up_busy_ratio_threshold` | number | Busy-ratio threshold in the range `0..1` that may trigger extra scale-up. |
| `controller.scale_up_max_ready_age_ms` | number | Allows scale-up when the oldest schedulable ready session exceeds this age. |
| `controller.leader_election.type` | string | Leader-election type for the controller. Supports `noop` and `kubernetes`. |
| `controller.leader_election.kubernetes.*` | object | Kubernetes lease settings such as namespace, lease name, API URL, token file, CA file, skip TLS verify, and identity. |
| `controller.scale_target.type` | string | Scale-target backend. Supports `noop`, `kubernetes`, and `docker_compose`. |
| `controller.scale_target.allow_scale_down` | boolean | Whether the controller may actively scale down replicas. |
| `controller.scale_target.kubernetes.*` | object | Kubernetes Deployment `/scale` target settings such as namespace, deployment, label selector, API URL, token file, CA file, and skip TLS verify. |
| `controller.scale_target.docker_compose.*` | object | Local Docker Compose scaling settings such as compose file, project name, service, command, plus optional remote executor endpoint, auth token, and timeout. |

> **tip**
> The controller boundary is now explicitly sandbox-only. How many threads, slots, or processes run inside a sandbox is owned by the worker runtime itself; the controller only consumes the observed capacity those workers publish and turns it into sandbox replica and placement decisions.

---

## Directory Reference

### Path and Layer Boundaries

| Object | Role | Active execution location |
| --- | --- | --- |
| `workspace_dir` | workspace source / managed root | Not always |
| `runtime_state_dir` | engine-private state root | No |
| `runtime_dir` | initialization source for new workspaces | No |
| `Active Workspace Copy` | active execution copy of a workspace | Yes |

Read them like this:

- `workspace_dir` answers “which workspaces exist”
- `runtime_dir` answers “how a new workspace is initialized”
- `sandbox` answers “where the current run executes”
- `runtime_state_dir` answers “where engine-private state lives”

### `workspace_dir`

Each direct subdirectory is treated as one `project` workspace. Only first-level subdirectories are scanned. This directory should hold workspace source roots only and should not be relied on as an engine-internal state root.

In `embedded` mode, active execution often happens directly against the local workspace. In `self_hosted / e2b`, the active execution copy is usually materialized into the owner sandbox, so `workspace_dir` behaves more like a managed source root than the final execution location.

### `runtime_state_dir`

Stores runtime-private state, including:

- SQLite shadow `history.db`
- Archive export output
- Legacy object-store materialization state

The default is `dirname(workspace_dir)/.openharness`, which keeps the live workspace root separate from internal runtime state. If you want this state to survive container restarts, mount it to durable writable storage explicitly.

### `runtime_dir`

Stores workspace runtimes. When creating a new workspace via `POST /workspaces`, a runtime from this directory is used as the initialization source. Runtimes are never loaded as active workspaces at runtime.

`runtime_dir` does not participate in run execution and never holds the active execution copy of a workspace. It only answers “how do we initialize a workspace?”, not “where is it currently running?”

### `model_dir`

Recursively scans `*.yaml` files in the directory. File format matches workspace `.openharness/models/*.yaml`. Loaded models appear as `platform/<name>` in the model catalog.

Example (`model_dir/openai-default.yaml`):

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5
```

### `tool_dir`

Platform-level tool source directory. Its structure should match workspace `.openharness/tools` (`settings.yaml` + `servers/*`). In the current implementation it is primarily used as the import source for runtime `imports.tools`, and as a shared source in single-workspace mode.

> **tip**
> When OAH runs inside Docker, HTTP MCP servers configured with `http://127.0.0.1:...` or `http://localhost:...` are rewritten at runtime to a host-reachable alias. The default alias is `host.docker.internal`. Override it with `OAH_DOCKER_HOST_ALIAS` if needed.

### `skill_dir`

Platform-level skill source directory. In the current implementation it is primarily used as the import source for runtime `imports.skills`, and as a shared source in single-workspace mode.

> **warning**
> Contents of `tool_dir` and `skill_dir` are primarily imported during runtime initialization. At runtime, workspaces use only capabilities declared in their own `.openharness` directory, plus any content already copied into that workspace during initialization.

---

## Runtime Modes

| Mode | Command | Description |
| --- | --- | --- |
| API + embedded worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml` | Smallest deployment. One `oah-api` process directly hosts the embedded worker. |
| API only | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml --api-only` | Starts `oah-api` only. Typically paired with `oah-controller` and `oah-sandbox`. |
| Standalone worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config server.yaml` | Standalone worker, typically running inside a self-hosted or E2B sandbox. |

---

## Environment Variable Overrides

In addition to YAML config, the server also reads a set of runtime environment variables for recovery, worker-pool behavior, and diagnostics.

### Stale Run Recovery

| Variable | Default | Description |
| --- | --- | --- |
| `OAH_STALE_RUN_RECOVERY_STRATEGY` | `requeue_running` with Redis, otherwise `fail` | Stale-run recovery strategy. Supports `fail`, `requeue_running`, and `requeue_all`. |
| `OAH_STALE_RUN_RECOVERY_MAX_ATTEMPTS` | `1` | Maximum number of automatic requeue attempts per run. |

### Embedded Worker Pool

| Variable | Default | Description |
| --- | --- | --- |
| `OAH_EMBEDDED_WORKER_MIN` | `2` with Redis, otherwise `1` | Minimum embedded worker instances; standalone worker processes always keep at least `1`. |
| `OAH_EMBEDDED_WORKER_MAX` | Same as `OAH_EMBEDDED_WORKER_MIN` | Maximum embedded worker instances. |
| `OAH_EMBEDDED_WORKER_SCALE_INTERVAL_MS` | `5000` | Embedded worker pool rebalance interval. |
| `OAH_EMBEDDED_WORKER_READY_SESSIONS_PER_CAPACITY_UNIT` | `1` | Target ready-session density per observed execution-capacity unit. |
| `OAH_EMBEDDED_WORKER_SCALE_UP_COOLDOWN_MS` | `1000` | Scale-up cooldown. |
| `OAH_EMBEDDED_WORKER_SCALE_DOWN_COOLDOWN_MS` | `15000` | Scale-down cooldown. |
| `OAH_EMBEDDED_WORKER_SCALE_UP_SAMPLE_SIZE` | `2` | Consecutive high-pressure samples required before scaling up. |
| `OAH_EMBEDDED_WORKER_SCALE_DOWN_SAMPLE_SIZE` | `3` | Consecutive low-pressure samples required before scaling down. |
| `OAH_EMBEDDED_WORKER_SCALE_UP_BUSY_RATIO_PERCENT` | `75` | Busy-ratio threshold that may unlock extra scale-up when combined with queue age. |
| `OAH_EMBEDDED_WORKER_SCALE_UP_MAX_READY_AGE_MS` | `2000` | Allows age-driven scale-up once the oldest schedulable session waits longer than this. |
| `OAH_EMBEDDED_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT` | `1` | Extra spare capacity reserved when subagent backlog appears; may be set to `0`. |

### Other Runtime Parameters

| Variable | Default | Description |
| --- | --- | --- |
| `OAH_HISTORY_EVENT_RETENTION_DAYS` | `7` | Retention window for historical events in PostgreSQL mode. |
| `OAH_RUNTIME_DEBUG` | unset | Mirrors runtime debug logs to stdout when set. |
| `OAH_DOCKER_HOST_ALIAS` | `host.docker.internal` | Host alias used when OAH runs inside Docker and an HTTP MCP server is configured with a loopback URL such as `127.0.0.1` or `localhost`. |

> **tip**
> With Redis plus `API + embedded worker`, OAH defaults to at least `2` embedded workers and performs lightweight scaling based on the gap between ready queue pressure and available worker capacity. `scale_up_window`, `scale_down_window`, and `cooldown_ms` still gate each action. If subagent backlog appears, the pool first tries to restore `reserved_capacity_for_subagent` so parent runs are less likely to be starved by normal backlog.

> **tip**
> `OAH_DOCKER_HOST_ALIAS` is mainly for the case where containerized OAH needs to reach an HTTP MCP server running on the host machine. The local `docker-compose.local.yml` already injects `host.docker.internal:host-gateway`, so the default works in most setups.

---

## Schema

JSON Schema: [schemas/server-config.schema.json](./schemas/server-config.schema.json)
