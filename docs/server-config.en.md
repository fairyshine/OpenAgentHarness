# Server Configuration

Configuration format: YAML. Default filename: `server.yaml`.

---

## Minimal Configuration

```yaml
server:
  host: 0.0.0.0          # Listen address
  port: 8787              # Listen port

storage:
  postgres_url: ${env.DATABASE_URL}   # PostgreSQL connection string
  redis_url: ${env.REDIS_URL}         # Redis connection string (optional)

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

llm:
  default_model: openai-default   # Default model name (must exist in model_dir)
```

> **info**
> Use `${env.VAR_NAME}` syntax to reference environment variables.

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
| `postgres_url` | string | Yes | PostgreSQL connection string. Workspaces without `serviceName` use this database directly; once `serviceName` is set, the default database keeps only the workspace/session/run routing index while runtime truth is routed to a sibling derived database name (for example `OAH-acme`). |
| `redis_url` | string | No | Redis connection string. Used for queues, locks, rate limiting, and SSE event fanout. |

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
| `e2b.headers` | object | Optional static headers attached to e2b requests. |

> **tip**
> OAH keeps the external `/sandboxes` API stable. Switching `sandbox.provider` changes only the server-side sandbox backend wiring; the Web app, OpenAPI clients, and runtime callers do not need to change their request shape.

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
| `tool_dir` | string | Platform MCP tool server definition directory |
| `skill_dir` | string | Platform skill directory |

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

Platform-level MCP tool server definitions. Directory structure should match workspace `.openharness/tools` (`settings.yaml` + `servers/*`). Loaded by the server and assembled into the platform capability catalog.

> **tip**
> When OAH runs inside Docker, HTTP MCP servers configured with `http://127.0.0.1:...` or `http://localhost:...` are rewritten at runtime to a host-reachable alias. The default alias is `host.docker.internal`. Override it with `OAH_DOCKER_HOST_ALIAS` if needed.

### `skill_dir`

Platform-level skill definitions. Merged with workspace `.openharness/skills` to form the visible skill set. Workspace-level skills take precedence over platform skills with the same name.

> **warning**
> Contents of `tool_dir` and `skill_dir` are primarily imported during runtime initialization. At runtime, workspaces use only capabilities declared in their own `.openharness` directory.

---

## Runtime Modes

| Mode | Command | Description |
| --- | --- | --- |
| API + embedded worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml` | Smallest deployment. One `oah-api` process directly hosts the embedded worker. |
| API only | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml --api-only` | Starts `oah-api` only. Typically paired with `oah-controller` and `oah-sandbox`. |
| Standalone worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config server.yaml` | Standalone worker, typically running inside a self-hosted or E2B sandbox. |

---

## Environment Variable Overrides

In addition to YAML config, the server also reads a few runtime environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `OAH_DOCKER_HOST_ALIAS` | `host.docker.internal` | Host alias used when OAH runs inside Docker and an HTTP MCP server is configured with a loopback URL such as `127.0.0.1` or `localhost` |

> **tip**
> `OAH_DOCKER_HOST_ALIAS` is mainly for the case where containerized OAH needs to reach an HTTP MCP server running on the host machine. The local `docker-compose.local.yml` already injects `host.docker.internal:host-gateway`, so the default works in most setups.

---

## Schema

JSON Schema: [schemas/server-config.schema.json](./schemas/server-config.schema.json)
