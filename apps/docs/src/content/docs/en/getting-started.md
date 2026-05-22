---
title: "Quick Start"
---

# Quick Start

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 24+ |
| pnpm | 10+ |
| Docker + docker compose | Latest stable |

## Installation and Startup

### Shortest Path After Install: Local Daemon

If the `oah` command is already installed, first start does not require manually copying the template. When `~/.openagentharness/config/daemon.yaml` is missing, `oah daemon start` seeds `OAH_HOME` from the bundled template:

```text
~/.openagentharness/
  config/daemon.yaml
  runtimes/
  models/openai-default.yaml
  tools/
  skills/
  workspaces/
```

Add your model API key, then start the daemon:

```bash
export OPENAI_API_KEY=sk-...
oah daemon start
oah tui
```

To initialize the directory without starting the daemon, run:

```bash
oah daemon init
```

Initialization only fills missing files; it does not overwrite an existing `config/daemon.yaml`, runtime, or model config. Source checkouts use `template/deploy-root`; release installs use the deploy-root assets bundled into the CLI package.

### Step 1: Install dependencies

```bash
pnpm install
```

### Step 2: Start the full local stack

```bash
export OPENAI_API_KEY=sk-...
pnpm local:up
```

For local development, you can set only `OAH_HOME`, or set no environment variable at all; `pnpm local:up` defaults to `OAH_HOME`, then `~/.openagentharness`, and uses the template's `config/server.docker.yaml`, `runtimes`, `models`, and related assets. Use an explicit `OAH_DEPLOY_ROOT` mainly when a team/deployment asset root should be managed separately:

```bash
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
```

This single command starts the full local stack: `PostgreSQL`, `Redis`, `MinIO`, `oah-api`, `oah-controller`, `oah-compose-scaler`, and `oah-sandbox`. `oah-api` listens on `http://127.0.0.1:8787`, `oah-sandbox` hosts the standalone worker in the local topology, `oah-compose-scaler` applies controller-driven `oah-sandbox` replica changes, and the startup flow also runs one storage sync automatically.

The local default uses `oah-sandbox + OSS/MinIO workspace_backing_store` for active workspace copies. `oah-api` does not mount a persistent workspace volume, so recycled workspaces do not accumulate as local directory shells in the API container.

### Step 3: Start the WebUI

```bash
pnpm dev:web
```

Open [http://localhost:5174](http://localhost:5174).

If you prefer to stay in the terminal, start the TUI instead:

```bash
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

The TUI connects to the same `oah-api` and lets you select a workspace, enter a session, send messages, and watch streaming output.

## Verify It Works

After startup, check:

1. `oah-api`, `oah-controller`, `oah-compose-scaler`, and `oah-sandbox` all start successfully
2. Browser opens `http://localhost:5174`
3. Or the TUI can connect to `http://127.0.0.1:8787` and list workspaces
4. Send a message in the WebUI or TUI. The run should move from `queued` to executing.
5. While a run is still active, sending another message should place it into the server-side queue surfaced above the input box through `/api/v1/sessions/{sessionId}/queue`. Use the `Guide` button to call `/api/v1/runs/{runId}/guide` if you want to interrupt the active run immediately.

> **tip**
    If the backend is not at the default address, set the proxy target:
    ```bash
    OAH_WEB_PROXY_TARGET=http://127.0.0.1:8787 pnpm dev:web
    ```

## Legacy Single Workspace Mode

This mode is kept for old scripts and internal tests. For personal local use, prefer the OAP daemon, then run `oah tui` or `oah tui --runtime vibe-coding` from inside the repo.

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

Optional flags: `--tool-dir`, `--skill-dir`, `--host`, `--port`

> **info**
    In single workspace mode, the WebUI enters the workspace automatically.

## Common Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm storage:sync` | Sync readonly data from the deploy root to MinIO (does not include `workspaces` by default) |
| `pnpm storage:sync -- --include-workspaces` | Also sync `workspaces` to MinIO |
| `pnpm local:up` | Start the full local stack (`oah-api` / `oah-controller` / `oah-compose-scaler` / `oah-sandbox`) |
| `OAH_SKIP_BUILD=1 pnpm local:up` | Reuse an already-built local OAH image and skip Docker build |
| `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1 pnpm local:up` | Keep the MinIO/rclone object-storage simulation, but resync readonly sources only when they changed |
| `OAH_LOCAL_SKIP_READONLY_VOLUME_RECREATE=1 pnpm local:up` | Reuse existing rclone readonly volumes when Docker/rclone has not restarted and you only need a fast service restart |
| `pnpm local:down` | Stop the full local stack |
| `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --api-only --config ./server.example.yaml` | Start `oah-api` only |
| `pnpm exec tsx --tsconfig ./apps/controller/tsconfig.json ./apps/controller/src/index.ts -- --config ./server.example.yaml` | Start `oah-controller` only |
| `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config ./server.example.yaml` | Start a standalone worker (typically inside `oah-sandbox`) |
| `pnpm dev:web` | Start WebUI |
| `pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui` | Start TUI |
| `pnpm build` | Full build |
| `pnpm test` | Run tests |
| `pnpm dev:docs` | Preview docs locally |

## Next Steps

- [Architecture Overview](./architecture-overview/) — Understand the system structure
- [Workspace Guide](./workspace/) — Configure agents, skills, and tools
- [Deploy and Run](./deploy/) — Unified local vs split production deployment
- [TUI](./tui/) — Use the terminal client
- [Design Overview](./design-overview/) — Core design decisions

## Local Object Storage Startup Tuning

`local:up` keeps the production-like shape by default: it syncs readonly deploy-root sources to MinIO, then mounts them into containers through rclone Docker volumes. For repeated local runs:

- `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1` skips `pnpm storage:sync` when readonly source file names, sizes, and mtimes are unchanged. Runtime reads still go through object storage.
- `OAH_LOCAL_SKIP_READONLY_VOLUME_RECREATE=1` keeps the existing rclone readonly volumes. Use it only when Docker Desktop and the rclone plugin have not restarted and you do not need to recover from plugin path drift.
- `OAH_LOCAL_SKIP_REDIS_FLUSH=1` preserves Redis coordination state. The default reset is safer for repeatable local tests.
- `OAH_MINIO_GOMEMLIMIT` / `OAH_MINIO_GOMAXPROCS` tune the local MinIO Go runtime defaults. They default to `128MiB` and `1` while preserving the MinIO + rclone object-storage simulation path.
- `OAH_API_NODE_OPTIONS` / `OAH_CONTROLLER_NODE_OPTIONS` / `OAH_SANDBOX_NODE_OPTIONS` override the local OAH Node process V8 heap defaults. The defaults encourage idle heaps to settle earlier; raise them for production-like load tests or large jobs.
- `OAH_POSTGRES_SHARED_BUFFERS` / `OAH_POSTGRES_MAX_CONNECTIONS` / `OAH_REDIS_HEALTHCHECK_INTERVAL` and related Compose variables can override the local database and healthcheck defaults.
