# Deploy and Run

## Deployment Modes

| Mode | Processes | Dependencies | When to use |
| --- | --- | --- | --- |
| **API + Worker combined** | 1 `server` | PostgreSQL; Redis optional | Local dev, PoC, single-node |
| **API + Worker split** | 1 `server --api-only` + N `worker` | PostgreSQL + Redis | Production, independent scaling |
| **Single Workspace** | 1 `server --workspace <path>` | PostgreSQL; Redis optional | Serving one repo or one chat space |

> **tip**
> Not sure which to pick? Start with combined mode. You can split later without code changes.

---

## Local Development

Three terminals, simplest path:

```bash
# Terminal 1 — Full local stack (PostgreSQL + Redis + MinIO + OAH)
export OAH_TEST_ROOT=/absolute/path/to/test_oah_server
pnpm local:up

# Terminal 3 — Frontend
pnpm dev:web
```

Frontend default address: `http://localhost:5174`

> **info**
> Run `pnpm install` before the first start.

---

## Split Deployment

For production or production-like environments. Requires Redis.

```bash
# Terminal 1 — Local infrastructure
docker compose -f docker-compose.local.yml up -d postgres redis minio

# Terminal 2 — API only (no embedded worker)
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config ./server.example.yaml --api-only

# Terminal 3 — Worker (can run multiple instances)
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config ./server.example.yaml

# Terminal 4 — Frontend
pnpm dev:web
```

The API process handles HTTP requests only. Worker processes consume the Redis queue, execute runs, and sync the history mirror.

---

## Single Workspace Mode

Skip the multi-workspace directory structure and point directly at one workspace:

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

Optional flags:

| Flag | Description |
| --- | --- |
| `--workspace-kind project\|chat` | Workspace type, defaults to `project` |
| `--tool-dir <path>` | Platform tool directory |
| `--skill-dir <path>` | Platform skill directory |
| `--host <addr>` | Listen address, defaults to `127.0.0.1` |
| `--port <num>` | Listen port, defaults to `8787` |

> **warning**
> In single workspace mode, workspace management endpoints (`POST /workspaces`, `DELETE /workspaces/:id`, etc.) are disabled.

---

## Startup Verification

After starting the server, verify status with these endpoints:

| Endpoint | Purpose | Expected response |
| --- | --- | --- |
| `GET /healthz` | Liveness check | `{ "status": "ok" }` |
| `GET /readyz` | Readiness check (includes dependencies) | `{ "status": "ready" }`, returns 503 if not ready |

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

Additional checks:

- Server logs print the active runtime mode (`API + embedded worker` / `API only` / `standalone worker`)
- After sending a message, the run progresses past `queued`
- In split mode, worker logs show queue consumption

---

## Environment Variables

| Variable | Description | Example |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://oah:oah@127.0.0.1:5432/open_agent_harness` |
| `REDIS_URL` | Redis connection string | `redis://127.0.0.1:6379` |
| `OAH_WEB_PROXY_TARGET` | Frontend proxy target (when backend is not at the default address) | `http://127.0.0.1:8787` |

Reference environment variables in `server.yaml` with `${env.DATABASE_URL}` syntax.

When using containers started by `docker-compose.local.yml`, the default connection strings are:

```yaml
storage:
  postgres_url: postgres://oah:oah@127.0.0.1:5432/open_agent_harness
  redis_url: redis://127.0.0.1:6379
```
