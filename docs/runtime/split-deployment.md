# Split Deployment Skeleton

本文描述当前代码基线下的 split deployment 骨架，也就是把 `api-server` 与 `worker` 拆成独立进程/Pod 时，仓库内各入口的真实职责。

## 角色

- `apps/server`
  - API server 入口
  - 可运行在 `api_only` 或 `api_embedded_worker` 模式
  - 在 split 部署里，建议使用 `--api-only`
- `apps/worker`
  - standalone worker 入口
  - 复用 `apps/server` 里的共享 runtime 装配逻辑
  - 只暴露 internal-only HTTP surface 和健康探针
- `worker-controller`
  - 独立控制面入口
  - 当前负责读取 Redis queue / worker registry 并计算 `desiredReplicas`
  - 当前已可通过可插拔 `scale target` 把目标副本数 reconcile 到 Kubernetes `Deployment /scale`
  - 当前已可通过 Kubernetes Lease 完成 leader election，仅由 leader 实例执行 reconcile
  - 第一版默认保持禁缩容安全语义，避免在 drain contract 完成前自动缩容

## 启动方式

仓库根目录当前提供了更清晰的 split-mode 脚本：

- `pnpm dev:server`
  - 启动 `api-server`
  - 默认走 `api_only`
- `pnpm dev:worker`
  - 启动 standalone worker
- `pnpm start:server`
  - 以构建产物启动 `api-server`
  - 默认走 `api_only`
- `pnpm start:worker`
  - 以构建产物启动 standalone worker

保留兼容入口：

- `apps/server/src/index.ts`
  - API server 可执行入口
- `apps/server/src/worker.ts`
  - 历史 worker 可执行入口
- `apps/server/src/runtime-entry.ts`
  - 当前共享的 server/worker 装配入口

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
  - managed workspace 根目录
  - 也承载 materialization cache 和 sqlite shadow state
- `paths.chat_dir`
- `paths.archive_dir`
  - 如果启用归档导出

当 workspace externalRef 指向对象存储时，还需要：

- `object_storage.*` 配置
- 供 worker 本地缓存和 flush 使用的可写临时盘

推荐显式配置：

- `OAH_INTERNAL_BASE_URL`
  - 用于发布 worker 可达的 internal base url
  - API server 会据此把 workspace 文件请求 proxy 到 owner worker

## 当前边界

当前 split skeleton 已经具备：

- `api-server` 与 `worker` 的独立 app 包边界
- owner-worker 文件代理
- worker internal-only HTTP surface
- `worker-controller` 的 Kubernetes leader election + `Deployment /scale` reconcile
- `deploy/kubernetes` 下的最小 Deployment / Service / RBAC 骨架

当前仍未完成：

- drain / 自动缩容护栏完善 / 更完整的 RBAC 与镜像发布链路
