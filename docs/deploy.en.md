# Deploy and Run

## Deployment Modes

| Mode | Processes | Dependencies | When to use |
| --- | --- | --- | --- |
| **API + Worker combined** | 1 `server` | PostgreSQL; Redis optional | Local dev, PoC, single-node |
| **API + Controller + Sandbox split** | 1 `server --api-only` + 1 `controller` + N sandbox-hosted `worker` | PostgreSQL + Redis | Production, sandbox scaling, dedicated control plane |
| **Single Workspace** | 1 `server --workspace <path>` | PostgreSQL; Redis optional | Serving one repo |

> **tip**
> Not sure which to pick? Start with combined mode. You can split later without code changes.

---

## Local Development

Three terminals, simplest path:

```bash
# Terminal 1 — Full local stack (PostgreSQL + Redis + MinIO + oah-api + oah-controller + oah-sandbox)
export OAH_DEPLOY_ROOT=/absolute/path/to/test_oah_server
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

# Terminal 2 — API only (`oah-api`)
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config ./server.example.yaml --api-only

# Terminal 3 — Controller (`oah-controller`)
pnpm exec tsx --tsconfig ./apps/controller/tsconfig.json ./apps/controller/src/index.ts -- --config ./server.example.yaml

# Terminal 4 — Standalone worker (typically hosted inside `oah-sandbox`, can run multiple instances)
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config ./server.example.yaml

# Terminal 5 — Frontend
pnpm dev:web
```

`oah-api` handles HTTP ingress and owner routing. `oah-controller` handles the control plane. Standalone workers typically run inside `oah-sandbox` or E2B sandboxes, consume the Redis queue, and execute runs.

### Kubernetes Split Deployment

The repository now includes a minimal Kubernetes split-deployment skeleton:

- [`Dockerfile`](/Users/wumengsong/Code/OpenAgentHarness/Dockerfile)
- [`.github/workflows/publish-image.yml`](/Users/wumengsong/Code/OpenAgentHarness/.github/workflows/publish-image.yml)
- [`deploy/kubernetes/kustomization.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/kustomization.yaml)
- [`deploy/charts/open-agent-harness/Chart.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/Chart.yaml)
- [`deploy/charts/open-agent-harness/values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/values.yaml)
- [`deploy/charts/open-agent-harness/README.md`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/README.md)
- [`deploy/charts/open-agent-harness/examples/dev.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/dev.values.yaml)
- [`deploy/charts/open-agent-harness/examples/staging.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/staging.values.yaml)
- [`deploy/charts/open-agent-harness/examples/prod.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod.values.yaml)
- [`deploy/kubernetes/api-server.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/api-server.yaml)
- [`deploy/kubernetes/worker.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/worker.yaml)
- [`deploy/kubernetes/controller.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller.yaml)
- [`deploy/kubernetes/controller-servicemonitor.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller-servicemonitor.example.yaml)
- [`deploy/kustomization.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kustomization.yaml)
- [`deploy/controller-servicemonitor.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/controller-servicemonitor.yaml)
- [`deploy/kubernetes/controller-rbac.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller-rbac.yaml)
- [`deploy/kubernetes/configmap.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/configmap.example.yaml)

Apply them in order:

```bash
kubectl apply -f ./deploy/kubernetes/namespace.yaml
kubectl apply -f ./deploy/kubernetes/configmap.example.yaml
kubectl apply -f ./deploy/kubernetes/controller-rbac.yaml
kubectl apply -f ./deploy/kubernetes/api-server.yaml
kubectl apply -f ./deploy/kubernetes/worker.yaml
kubectl apply -f ./deploy/kubernetes/controller.yaml
```

Or install the same split-deployment skeleton via Helm:

```bash
helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  --set image.repository=ghcr.io/open-agent-harness/open-agent-harness \
  --set image.tag=latest
```

If you do not want to assemble values from scratch, you can also start from a shipped environment example:

```bash
helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  -f ./deploy/charts/open-agent-harness/examples/staging.values.yaml
```

The repository now also includes a minimal GHCR publishing path for production images:

```bash
git push origin master
```

Notes:

- [`.github/workflows/publish-image.yml`](/Users/wumengsong/Code/OpenAgentHarness/.github/workflows/publish-image.yml) builds the production [`Dockerfile`](/Users/wumengsong/Code/OpenAgentHarness/Dockerfile) on `master` and `v*` tags
- By default it publishes to `ghcr.io/<repo-owner>/open-agent-harness`
- If you need a different package path, set the GitHub repository variable `OAH_IMAGE_NAME`
- If you want to match the repository's shipped example manifests/chart defaults, set `OAH_IMAGE_NAME=open-agent-harness/open-agent-harness`

This baseline already includes:

- Separate Deployments for `oah-api`, `oah-sandbox`, and `oah-controller`
- A dedicated ClusterIP Service for `controller` exposing `/healthz`, `/readyz`, `/snapshot`, and `/metrics`
- Kubernetes Lease based leader election for `controller`
- Replica reconciliation through the `Deployment /scale` subresource for `oah-sandbox`, with optional target discovery via `label_selector`
- `controller-rbac.yaml` now includes the `leases`, `deployments`, and `deployments/scale` permissions needed for leader election, label-selector discovery, and replica reconciliation
- Automatic scale-down is now enabled when safety conditions are met; the real scale-down guardrail comes from controller health probes against standalone worker `/healthz`
- Standalone workers now enter a drain phase on shutdown so readiness drops before the current run is allowed to finish
- Drain now also flushes and evicts idle workspace copies and blocks new object-store materialization from starting
- All three Deployments now declare explicit rollout strategy settings; `oah-api` / `oah-sandbox` use `maxUnavailable: 0`, and `oah-sandbox` keeps a longer `terminationGracePeriodSeconds` window so drain has time to converge
- The `controller` Service ships with basic `prometheus.io/*` scrape annotations; fuller ServiceMonitor / Prometheus Operator integration is still better handled in production overlays or Helm charts
- The repository also ships [`controller-servicemonitor.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller-servicemonitor.example.yaml) as a Prometheus Operator example; it is intentionally not included in the default `kustomization.yaml`
- The repository now also ships a directly usable Prometheus Operator kustomization:
  [`deploy/kustomization.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kustomization.yaml)
  It layers [`deploy/controller-servicemonitor.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/controller-servicemonitor.yaml) on top of the base `deploy/kubernetes` skeleton, so Prometheus Operator users can enable the `controller` `ServiceMonitor` with `kubectl apply -k ./deploy`
- The repository now also ships a minimal Helm chart so the split deployment, RBAC, ConfigMap, and optional `ServiceMonitor` can be managed together by Helm
- The Helm chart now also supports existing ConfigMaps, PVC-backed workspace volumes for `oah-sandbox`, and per-component resources / securityContext / envFrom / scheduling settings
- The Helm chart now also supports `PodDisruptionBudget`, `topologySpreadConstraints`, `priorityClassName`, and direct `oah-api` Ingress generation
- The chart directory now also ships `dev / staging / prod` values examples, so teams can start from environment-specific presets instead of building everything from scratch
- The repository now also ships a production `Dockerfile` and minimal GHCR publishing workflow, so the K8S manifests/chart are no longer assuming some external image pipeline already exists
- The GHCR workflow now also emits `sbom/provenance` and performs Cosign keyless signing

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
| `OAH_DOCKER_HOST_ALIAS` | Hostname used from containers to reach host-local services | `host.docker.internal` |

Reference environment variables in `server.yaml` with `${env.DATABASE_URL}` syntax.

If OAH itself runs inside Docker while an HTTP MCP server runs on the host machine:

- MCP configs may still use `http://127.0.0.1:PORT/...` or `http://localhost:PORT/...`
- OAH rewrites those loopback URLs to a host-reachable address inside the container
- the default alias is `host.docker.internal`
- override it with `OAH_DOCKER_HOST_ALIAS` when needed

The local `docker-compose.local.yml` already injects `host.docker.internal:host-gateway` for `oah-api`, `oah-controller`, and `oah-sandbox`, so the default alias also works on Linux in the local stack.

When using containers started by `docker-compose.local.yml`, the default connection strings are:

```yaml
storage:
  postgres_url: postgres://oah:oah@127.0.0.1:5432/open_agent_harness
  redis_url: redis://127.0.0.1:6379
```
