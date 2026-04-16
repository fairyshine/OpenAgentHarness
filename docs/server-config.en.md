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
  provider: self_hosted               # self_hosted | e2b
  # self_hosted:
  #   base_url: http://oah-sandbox:8787/internal/v1
  # e2b:
  #   base_url: https://sandbox-gateway.example.com/internal/v1
  #   api_key: ${env.E2B_API_KEY}

paths:
  workspace_dir: /srv/openharness/workspaces       # Project workspace root
  blueprint_dir: /srv/openharness/blueprints        # Workspace blueprint directory
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

### `sandbox`

| Field | Type | Description |
| --- | --- | --- |
| `provider` | string | Sandbox provider. Supports `self_hosted` and `e2b`. Defaults to `self_hosted`. |
| `self_hosted.base_url` | string | Optional. Base `/internal/v1` URL for a remote self-hosted sandbox service. When omitted, OAH keeps using the local materialization-backed sandbox. |
| `self_hosted.headers` | object | Optional static headers attached to remote self-hosted sandbox requests. |
| `e2b.base_url` | string | Required when `provider=e2b`. Base `/internal/v1` URL for an E2B-backed sandbox gateway. |
| `e2b.api_key` | string | Optional. When set, OAH sends it as `Authorization: Bearer <key>` on e2b requests. |
| `e2b.headers` | object | Optional static headers attached to e2b requests. |

> **tip**
> OAH keeps the external `/sandboxes` API stable. Switching `sandbox.provider` changes only the server-side sandbox backend wiring; the Web app, OpenAPI clients, and runtime callers do not need to change their request shape.

### `paths`

| Field | Type | Description |
| --- | --- | --- |
| `workspace_dir` | string | Project workspace root directory |
| `blueprint_dir` | string | Workspace blueprint directory |
| `model_dir` | string | Platform model definition directory |
| `tool_dir` | string | Platform MCP tool server definition directory |
| `skill_dir` | string | Platform skill directory |

### `llm`

| Field | Type | Description |
| --- | --- | --- |
| `default_model` | string | Default model name. Must exist in `model_dir`. Resolved to `platform/<name>` at runtime. |

---

## Directory Reference

### `workspace_dir`

Each direct subdirectory is treated as one `project` workspace. Only first-level subdirectories are scanned.

### `blueprint_dir`

Stores workspace blueprints. When creating a new workspace via `POST /workspaces`, a blueprint from this directory is used as the initialization source. Blueprints are never loaded as active workspaces at runtime.

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

### `skill_dir`

Platform-level skill definitions. Merged with workspace `.openharness/skills` to form the visible skill set. Workspace-level skills take precedence over platform skills with the same name.

> **warning**
> Contents of `tool_dir` and `skill_dir` are primarily imported during blueprint initialization. At runtime, workspaces use only capabilities declared in their own `.openharness` directory.

---

## Runtime Modes

| Mode | Command | Description |
| --- | --- | --- |
| API + embedded worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml` | Default. One process runs both API and worker. |
| API only | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml --api-only` | API only. Pair with standalone worker(s). |
| Standalone worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config server.yaml` | Independent worker. Consumes Redis queue. |

---

## Schema

JSON Schema: [schemas/server-config.schema.json](./schemas/server-config.schema.json)
