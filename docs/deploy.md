# 部署与运行

## 部署模式概览

| 模式 | 进程 | 依赖 | 适用场景 |
| --- | --- | --- | --- |
| **API + Worker 一体** | 1 个 `server` | PostgreSQL，Redis 可选 | 本地开发、PoC、单机部署 |
| **API + Controller + Sandbox 分离** | 1 个 `server --api-only` + 1 个 `controller` + N 个 sandbox-hosted `worker` | PostgreSQL + Redis | 生产环境、需要独立控制面与 sandbox 扩缩容 |
| **单 Workspace** | 1 个 `server --workspace <path>` | PostgreSQL，Redis 可选 | 只服务一个仓库 |

> **tip**
> 不确定选哪个？先用「一体模式」跑通，后续随时可以切到分离部署。

## 层级关系

部署时建议始终按下面这条关系理解：

- `workspace` 是项目与能力边界
- `worker` 是执行角色
- `sandbox` 是 worker 的宿主环境

在 split 部署里，通常不是“一个 workspace 对应一个进程”，而是“一个 sandbox 内的 standalone worker 按容量承载一个或多个活跃 workspace”。

---

## 本地开发

三个终端，最简路径：

```bash
# 终端 1 — 本地整套服务（PostgreSQL + Redis + MinIO + oah-api + oah-controller + oah-compose-scaler + oah-sandbox）
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
pnpm local:up

# 终端 3 — WebUI
pnpm dev:web

# 可选 — 终端 TUI
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

WebUI 默认地址：`http://localhost:5174`

TUI 连接同一个本地 API：`http://127.0.0.1:8787`

> **info**
> 首次运行前先执行 `pnpm install` 安装依赖。

> **info**
> 本地 split stack 默认让 active workspace copy 落在 `oah-sandbox`，并通过对象存储 backing store flush 回 OSS/MinIO。`oah-api` 只负责 API 入口和路由，不再挂载持久 workspace volume。

---

## 分离部署

适用于模拟生产或真实生产环境。需要 Redis。

```bash
# 终端 1 — 本地基础设施
docker compose -f docker-compose.local.yml up -d postgres redis minio

# 终端 2 — API（oah-api，不内嵌 Worker）
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config ./server.example.yaml --api-only

# 终端 3 — Controller（oah-controller）
pnpm exec tsx --tsconfig ./apps/controller/tsconfig.json ./apps/controller/src/index.ts -- --config ./server.example.yaml

# 终端 4 — Standalone worker（通常跑在 oah-sandbox，可启动多个实例）
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config ./server.example.yaml

# 终端 5 — WebUI
pnpm dev:web

# 可选 — 终端 TUI
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

`oah-api` 只负责 HTTP 请求与 owner 路由；`oah-controller` 负责控制面；standalone worker 通常运行在 `oah-sandbox` 或 E2B sandbox 内，消费 Redis 队列并执行 Run。

WebUI 和 TUI 都只通过 `oah-api` 访问系统能力；TUI 更适合在服务器或本地 shell 内快速切换 workspace/session、查看流式输出。

### Kubernetes Split 部署

仓库现在提供了一套最小可运行的 K8S split deployment 骨架：

- [`Dockerfile`](/Users/wumengsong/Code/OpenAgentHarness/Dockerfile)
- [`.github/workflows/publish-image.yml`](/Users/wumengsong/Code/OpenAgentHarness/.github/workflows/publish-image.yml)
- [`deploy/kubernetes/kustomization.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/kustomization.yaml)
- [`deploy/charts/open-agent-harness/Chart.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/Chart.yaml)
- [`deploy/charts/open-agent-harness/values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/values.yaml)
- [`deploy/charts/open-agent-harness/README.md`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/README.md)
- [`deploy/charts/open-agent-harness/examples/dev.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/dev.values.yaml)
- [`deploy/charts/open-agent-harness/examples/staging.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/staging.values.yaml)
- [`deploy/charts/open-agent-harness/examples/prod.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod.values.yaml)
- [`deploy/charts/open-agent-harness/examples/strict-egress.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/strict-egress.values.yaml)
- [`deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml)
- [`docs/k8s-rollout-checklist.md`](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-rollout-checklist.md)
- [`docs/k8s-operations-runbook.md`](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-operations-runbook.md)
- [`docs/k8s-compose-reuse-matrix.md`](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-compose-reuse-matrix.md)
- [`deploy/kubernetes/api-server.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/api-server.yaml)
- [`deploy/kubernetes/worker.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/worker.yaml)
- [`deploy/kubernetes/controller.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller.yaml)
- [`deploy/kubernetes/controller-servicemonitor.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller-servicemonitor.example.yaml)
- [`deploy/kubernetes/networkpolicy.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/networkpolicy.example.yaml)
- [`deploy/kubernetes/networkpolicy.strict-egress.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/networkpolicy.strict-egress.example.yaml)
- [`deploy/kustomization.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kustomization.yaml)
- [`deploy/controller-servicemonitor.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/controller-servicemonitor.yaml)
- [`deploy/controller-prometheusrule.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/controller-prometheusrule.yaml)
- [`docs/production-readiness.md`](/Users/wumengsong/Code/OpenAgentHarness/docs/production-readiness.md)
- [`deploy/kubernetes/controller-rbac.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller-rbac.yaml)
- [`deploy/kubernetes/configmap.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/configmap.example.yaml)

使用方式：

```bash
kubectl apply -f ./deploy/kubernetes/namespace.yaml
kubectl apply -f ./deploy/kubernetes/configmap.example.yaml
kubectl apply -f ./deploy/kubernetes/controller-rbac.yaml
kubectl apply -f ./deploy/kubernetes/api-server.yaml
kubectl apply -f ./deploy/kubernetes/worker.yaml
kubectl apply -f ./deploy/kubernetes/controller.yaml
```

或者直接走 Helm chart：

```bash
helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  --set image.repository=ghcr.io/open-agent-harness/open-agent-harness \
  --set image.tag=latest
```

如果不想从零拼 values，也可以直接从内置环境样例起步：

```bash
helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  -f ./deploy/charts/open-agent-harness/examples/staging.values.yaml
```

如果已经进入 production-like 演练阶段，建议直接叠这层 hardening overlay：

```bash
helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  -f ./deploy/charts/open-agent-harness/examples/prod.values.yaml \
  -f ./deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml
```

如果要把 K8S 相关材料按使用顺序看，建议走这条线：

1. [ROADMAP_K8S.md](/Users/wumengsong/Code/OpenAgentHarness/ROADMAP_K8S.md)
2. [deploy.md](/Users/wumengsong/Code/OpenAgentHarness/docs/deploy.md)
3. [deploy/charts/open-agent-harness/README.md](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/README.md)
4. [prod-hardening.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml)
5. [k8s-compose-reuse-matrix.md](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-compose-reuse-matrix.md)
6. [k8s-rollout-checklist.md](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-rollout-checklist.md)
7. [k8s-operations-runbook.md](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-operations-runbook.md)

如果要发布正式镜像，仓库现在也提供了一条最小 GHCR 发布链路：

```bash
git push origin master
```

说明：

- [`.github/workflows/publish-image.yml`](/Users/wumengsong/Code/OpenAgentHarness/.github/workflows/publish-image.yml) 会在 `master` 和 `v*` tag 上构建生产 [`Dockerfile`](/Users/wumengsong/Code/OpenAgentHarness/Dockerfile)
- 默认发布到 `ghcr.io/<repo-owner>/open-agent-harness`
- 如需改成别的包名，可在 GitHub 仓库变量里设置 `OAH_IMAGE_NAME`
- 如果要与仓库当前示例 manifests/chart 默认值保持一致，可把 `OAH_IMAGE_NAME` 设为 `open-agent-harness/open-agent-harness`

当前这套骨架已经包含：

- `oah-api`、`oah-sandbox`、`oah-controller` 三个独立 Deployment
- `oah-api` 不需要挂载 workspace volume；`oah-sandbox` 才承载 writable active workspace copy，推荐配合对象存储 backing store 做 idle / drain flush
- `controller` 额外暴露一个 ClusterIP Service，提供 `/healthz`、`/readyz`、`/snapshot`、`/metrics`
- `controller` 使用 Kubernetes Lease 做 leader election
- `controller` 通过 `Deployment /scale` 子资源改写 `oah-sandbox` 副本数，并已支持通过 `label_selector` 自动发现目标 Deployment
- `server.yaml` 示例已把 `sandbox.provider` 设为 `self_hosted`，并通过 `oah-sandbox-internal` headless service 路由到 sandbox 内 worker
- 默认 sandbox fleet 保留 `warm_empty_count: 1` 个空 sandbox；ownerless workspace 会先复用 CPU、内存和磁盘均低于阈值的已有 sandbox，任一资源超过阈值后才落到空 sandbox
- `controller-rbac.yaml` 当前已包含 `leases`、`deployments` 和 `deployments/scale` 所需权限，能够覆盖 leader election、label selector 发现和副本数改写
- 默认已经允许在安全前提满足时自动缩容；真正的缩容护栏由 controller 对 standalone worker `/healthz` 的动态探测决定
- standalone worker 收到退出信号后会先进入 drain，使 readiness 先摘除，再等待当前 run 自然结束
- drain 开始时会优先 flush + evict 空闲 workspace 副本，并阻止新的 object-store materialization 启动
- 三个 Deployment 现在都显式声明了 rollout 策略；`oah-api` / `oah-sandbox` 使用 `maxUnavailable: 0`，`oah-sandbox` 还额外保留更长的 `terminationGracePeriodSeconds` 用于 drain 收敛
- `controller` Service 默认带 `prometheus.io/*` annotations，便于最小化接入 scrape；更完整的 ServiceMonitor/Prometheus Operator 对接仍建议在生产 overlays/Helm 中补充
- 仓库额外提供 [`controller-servicemonitor.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/controller-servicemonitor.example.yaml) 作为 Prometheus Operator 接入示例，默认不纳入 `kustomization.yaml`
- 现在也提供一个可直接使用的 Prometheus Operator kustomization：
  [`deploy/kustomization.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kustomization.yaml)
  它会在基础 `deploy/kubernetes` 骨架之上额外包含 [`deploy/controller-servicemonitor.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/controller-servicemonitor.yaml) 和 [`deploy/controller-prometheusrule.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/controller-prometheusrule.yaml)，可直接通过 `kubectl apply -k ./deploy` 启用 `controller` 的 `ServiceMonitor` 与基础告警规则
- 现在也提供了最小 Helm chart，可把 split deployment、RBAC、ConfigMap 和可选 `ServiceMonitor` 一起交给 Helm 管理
- chart 现在还可选生成：
  - `PrometheusRule`
  - Grafana dashboard ConfigMap
  - controller / worker / api ingress `NetworkPolicy`
- Helm chart 当前还已支持复用已有 ConfigMap、为 `oah-sandbox` 切换到现有 PVC、以及给三个组件分别配置 resources / securityContext / envFrom / scheduling
- 生产环境应启用对象存储 backing store，并显式配置 `worker.workspaceVolume`、`ephemeral-storage`、`worker.diskReadiness.threshold` 和 `worker.workspacePolicy.*`；完整检查项见 [`docs/production-readiness.md`](/Users/wumengsong/Code/OpenAgentHarness/docs/production-readiness.md)
- Helm chart 现在还支持 `PodDisruptionBudget`、`topologySpreadConstraints`、`priorityClassName`、`NetworkPolicy`，并可直接为 `oah-api` 生成 Ingress
- chart 目录下现在还已附带 `dev / staging / prod` 三套 values 样例，便于按环境起步而不是手写所有参数
- 现在也提供了生产 `Dockerfile` 与最小 GHCR 发布 workflow，K8S manifests/chart 不再只是假定“外部已有镜像”
- GHCR workflow 现在还会产出 `sbom/provenance`，并通过 Cosign 做 keyless signing

当前建议额外遵循这几条 K8S 部署契约：

- `oah-controller` 多副本时，必须开启 `leader_election.type=kubernetes`
- `oah-controller` 的 `scale_target.kubernetes.label_selector` 必须只命中当前 release 的 `oah-sandbox` Deployment
- `oah-sandbox` 的 `terminationGracePeriodSeconds` 要大于 worker drain 超时
- `oah-sandbox` 需要在 `preStop` 里先触发本地 drain，再等待短暂缓冲时间，让 `/readyz` 先摘除
- `controller` 对 scale target 的观测应区分：
  - 请求已接受
  - rollout 进行中
  - rollout 已 ready
  - 平台调用失败

推荐关系：

- `worker.drain.timeoutMs < terminationGracePeriodSeconds * 1000`
- `preStop` 只负责“尽快进入 draining”，不要在 hook 里做长时间阻塞逻辑
- 若 worker 需要在超时后恢复未完成 run，优先使用 `requeue_running` 之类的显式策略，而不是等 K8S 强杀
- 若要收紧 Pod ingress 面，建议从 [`deploy/kubernetes/networkpolicy.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/networkpolicy.example.yaml) 或 chart 的 `networkPolicy.enabled=true` 起步；当前基线默认只收紧 ingress，不默认限制 egress
- 若要进一步收紧出口白名单，建议从 [`deploy/charts/open-agent-harness/examples/strict-egress.values.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/strict-egress.values.yaml) 或 [`deploy/kubernetes/networkpolicy.strict-egress.example.yaml`](/Users/wumengsong/Code/OpenAgentHarness/deploy/kubernetes/networkpolicy.strict-egress.example.yaml) 起步，再替换：
  - Kubernetes API CIDR
  - Redis / Postgres Pod labels
  - 对象存储 / 模型运行时的真实 CIDR 或 egress gateway 网段
- 如果要按上线节奏收口，建议顺序是：
  - `staging.values.yaml`
  - `prod.values.yaml`
  - `prod.values.yaml + prod-hardening.values.yaml`
  - 最后按 [`docs/k8s-rollout-checklist.md`](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-rollout-checklist.md) 做 staging / production gate

---

## 单 Workspace 模式

跳过多 Workspace 目录结构，直接指定一个 workspace 路径：

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--tool-dir <path>` | 公共 tool 目录 |
| `--skill-dir <path>` | 公共 skill 目录 |
| `--host <addr>` | 监听地址，默认 `127.0.0.1` |
| `--port <num>` | 监听端口，默认 `8787` |

> **warning**
> 单 Workspace 模式下，workspace 管理接口（`POST /workspaces`、`DELETE /workspaces/:id` 等）会被禁用。

---

## 启动检查

服务启动后，用以下端点验证状态：

| 端点 | 用途 | 正常响应 |
| --- | --- | --- |
| `GET /healthz` | 进程存活检查 | `{ "status": "ok" }` |
| `GET /readyz` | 就绪检查（含依赖） | `{ "status": "ready" }`，未就绪返回 503 |

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

额外确认项：

- 服务日志中打印了当前运行模式（`API + embedded worker` / `API only` / `standalone worker`）
- 发送消息后 Run 能从 `queued` 推进到执行
- 分离部署时 Worker 日志中有队列消费记录

---

## 环境变量

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 | `postgres://oah:oah@127.0.0.1:5432/open_agent_harness` |
| `REDIS_URL` | Redis 连接串 | `redis://127.0.0.1:6379` |
| `OAH_WEB_PROXY_TARGET` | 前端代理目标（后端地址不是默认时使用） | `http://127.0.0.1:8787` |
| `OAH_DOCKER_HOST_ALIAS` | 容器内访问宿主机服务时使用的主机名 | `host.docker.internal` |

在 `server.yaml` 中通过 `${env.DATABASE_URL}` 语法引用环境变量。

如果 OAH 本身运行在 Docker 容器里，而 HTTP MCP Server 跑在宿主机本地：

- MCP 配置仍可写 `http://127.0.0.1:PORT/...` 或 `http://localhost:PORT/...`
- OAH 会在容器内自动改写为宿主机可访问地址
- 默认使用 `host.docker.internal`
- 如有需要可通过 `OAH_DOCKER_HOST_ALIAS` 覆盖

本地 `docker-compose.local.yml` 已为 `oah-api`、`oah-controller`、`oah-compose-scaler`、`oah-sandbox` 注入 `host.docker.internal:host-gateway`，因此 Linux 环境下也能直接使用该别名。

本地开发使用 `docker-compose.local.yml` 启动的容器时，默认连接串为：

```yaml
storage:
  postgres_url: postgres://oah:oah@127.0.0.1:5432/open_agent_harness
  redis_url: redis://127.0.0.1:6379
```
