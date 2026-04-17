# Split Deployment Skeleton

本文描述当前代码基线下的 split deployment 骨架，也就是把 `oah-api` 与 `oah-sandbox` 拆成独立进程/Pod 时，仓库内各入口的真实职责。

本文档中的正式控制面术语统一使用 `Controller`。当前主要保留的是少量 legacy env var / metric / chart values 兼容项，而不是新的主命名。

## 角色

- `apps/server`
  - `oah-api` 入口
  - 可运行在 `api_only` 或 `api_embedded_worker` 模式
  - 在 split 部署里，建议使用 `--api-only`，作为最小化 API 面
- `apps/worker`
  - standalone worker 入口，通常运行在 `oah-sandbox` 内
  - 复用 `apps/server` 里的共享 runtime 装配逻辑
  - 只暴露 internal-only HTTP surface 和健康探针
- `controller`
  - `oah-controller` 独立控制面入口
  - 当前负责读取 Redis queue / worker registry 并计算 `desiredReplicas`
  - 当前已可通过可插拔 `scale target` 把目标副本数 reconcile 到 Kubernetes `Deployment /scale`
  - 当前已支持通过 `label_selector` 自动发现要缩放的 `oah-sandbox` Deployment
  - 当前已可通过 Kubernetes Lease 完成 leader election，仅由 leader 实例执行 reconcile
  - 当前已通过 worker `/healthz` 动态 gating 控制自动缩容
  - 当前已暴露 `/healthz`、`/readyz`、`/snapshot`、`/metrics` observability 面

## 启动方式

仓库根目录当前提供了更清晰的 split-mode 脚本：

- `pnpm dev:server`
  - 启动 `oah-api`
  - 默认走 `api_only`
- `pnpm dev:worker`
  - 启动 standalone worker，供 `oah-sandbox` 使用
- `pnpm start:server`
  - 以构建产物启动 `oah-api`
  - 默认走 `api_only`
- `pnpm start:worker`
  - 以构建产物启动 standalone worker

保留兼容入口：

- `apps/server/src/index.ts`
  - `oah-api` 可执行入口
- `apps/server/src/worker.ts`
  - standalone worker 可执行入口
- `apps/server/src/runtime-entry.ts`
  - 当前共享的 `oah-api` / standalone worker 装配入口

## Worker 约束

standalone worker 当前默认承担这些职责：

- 消费 Redis queued runs
- materialize object-storage workspace 到本地缓存目录
- 通过 workspace ownership lease 发布 `ownerWorkerId`
- 当配置了 `OAH_INTERNAL_BASE_URL` 时，发布 `ownerBaseUrl`
- 承接来自 API server 的 owner-worker 文件代理

当前 worker 不负责：

- worker 副本数决策
- leader election
- history mirror sync

## 目录与环境

worker Pod 侧至少需要保证这些目录可用：

- `paths.workspace_dir`
  - managed live workspace 根目录
- `paths.runtime_state_dir`
  - worker 运行时私有状态根目录
  - 放置 sqlite shadow state、archives 和遗留 materialization 状态

当 workspace externalRef 指向对象存储时，还需要：

- `object_storage.*` 配置
- 供 worker 本地缓存和 flush 使用的可写临时盘

推荐显式配置：

- `OAH_INTERNAL_BASE_URL`
  - 用于发布 worker 可达的 internal base url
  - API server 会据此把 workspace 文件请求 proxy 到 owner worker

## 当前边界

当前 split skeleton 已经具备：

- `oah-api` 与 standalone worker 的独立 app 包边界
- owner-worker 文件代理
- worker internal-only HTTP surface
- `controller` 的 Kubernetes leader election + `Deployment /scale` reconcile
- `controller` 的独立 Service 与基础 metrics/health observability 面
- `controller` 的 Prometheus Operator `ServiceMonitor` 示例清单
- `deploy/` 根目录下的 Prometheus Operator kustomization，可直接 `kubectl apply -k ./deploy` 启用 `ServiceMonitor`
- `deploy/kubernetes` 下的最小 Deployment / Service / RBAC 骨架
- `deploy/charts/open-agent-harness` 下的最小 Helm chart，可统一管理 split deployment、RBAC、ConfigMap 与可选 `ServiceMonitor`
- Helm chart 当前也已支持 existing ConfigMap、`oah-sandbox` PVC workspace volume，以及 per-component resources / securityContext / envFrom / scheduling 参数
- Helm chart 当前还已支持 `PodDisruptionBudget`、`topologySpreadConstraints`、`priorityClassName` 与 `oah-api` Ingress
- chart 当前也已附带 `dev / staging / prod` 三套 values 样例，作为多环境起步基线
- 仓库根目录下的生产 `Dockerfile` 与 GHCR 发布 workflow
- GHCR workflow 当前也已补上 `sbom/provenance` 与 Cosign keyless signing
- Deployment rollout 策略现在已经显式写入 manifests，而不是依赖 K8S 默认值
- worker runtime 收到退出信号后的基础 drain 生命周期
- workspace materialization 在 drain 期间的 idle flush / eviction 收敛

当前仍未完成：

- 若还要继续深化，主要会是更细粒度的组织内部多环境 values/overlay 约定，而不是平台能力缺口
