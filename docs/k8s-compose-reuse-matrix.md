# Compose To Kubernetes Reuse Matrix

这份对照表用来回答一个实际问题：

“我们之前在 Docker Compose 下做的大量优化，K8S 这边到底复用了多少，还有哪些要单独补？”

结论先说：

- 镜像层优化：大部分天然复用
- 进程层优化：大部分可复用，但需要把 env / 启动入口显式带到 K8S
- 编排层优化：不能直接复用，需要用 K8S 语义单独实现

## 1. 已直接复用

这些优化落在镜像或容器内部，本质上 Compose 和 K8S 运行的是同一份镜像，因此天然共享。

| 优化项 | Compose | K8S | 状态 |
| --- | --- | --- | --- |
| Alpine 化 base image | 使用同一生产镜像 | 使用同一生产镜像 | 已直接复用 |
| 多阶段构建 | `Dockerfile` 生效 | `Dockerfile` 生效 | 已直接复用 |
| runtime / controller / worker 镜像分目标裁剪 | Compose build target 使用 | K8S 使用同一发布镜像族 | 已直接复用 |
| Node 二进制裁剪 | 镜像内生效 | 镜像内生效 | 已直接复用 |
| native workspace sync 二进制裁剪 | 镜像内生效 | 镜像内生效 | 已直接复用 |
| 按角色拆包 | `api-runtime` / `worker-runtime` / `controller-runtime` | 同上 | 已直接复用 |
| docs/schema 最小化拷贝 | 镜像内生效 | 镜像内生效 | 已直接复用 |
| `oah-api` / `oah-controller` / `oah-sandbox` 职责拆分 | Compose 三个核心容器，另有本地 `oah-compose-scaler` 执行 Docker Compose 扩缩容 | K8S 三 Deployment，扩缩容直接走 `Deployment /scale` | 已直接复用核心职责 |
| worker drain 基础逻辑 | 容器内实现 | K8S `preStop` 调用同一逻辑 | 已直接复用 |

## 2. 已补齐到 K8S

这些优化虽然在 Compose 下先跑通了，但 K8S 之前没有完全显式接上；现在已经补齐。

| 优化项 | Compose 状态 | K8S 现在状态 | 备注 |
| --- | --- | --- | --- |
| 镜像启动命令路径 | `node dist/index.js` / `dist/worker.js` / `dist/index.js` | 已改成相同路径 | 之前 K8S 清单还写着旧路径 |
| `NODE_OPTIONS` 内存上限 | api/controller/worker 已设置 | chart 与 raw manifest 已补齐 | 现在 K8S 显式继承 |
| `OAH_ALLOW_PRIVATE_INTERNAL_ROUTES` | worker 已启用 | worker chart/raw 已补齐 | 保障跨 Pod internal surface |
| `OAH_ALLOW_PRIVATE_INTERNAL_MODEL_ROUTES` | api 已启用 | api chart/raw 已补齐 | 保障 private model/internal 路由 |
| `OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES` | api/worker 已启用 | api/worker chart/raw 已补齐 | 继承 Compose 下对象存储优化 |
| worker `preStop -> drain` | Compose 主要靠进程退出 | K8S chart/raw 已接 `preStop` | K8S 更完整 |
| controller `maxUnavailable=0` | Compose 不涉及 | K8S 已显式设置 | 属于 K8S 专属补强 |

## 3. 需要 K8S 单独实现

这些能力不属于“容器内部优化”，而是编排层语义，所以不能直接从 Compose 平移。

| 能力 | Compose 侧 | K8S 侧 |
| --- | --- | --- |
| 扩缩容执行 | `docker compose up --scale` / `compose-scaler` | `Deployment /scale` + controller target |
| leader election | 不需要或很弱 | Lease API |
| rollout / availability | `depends_on` / compose restart | readiness / liveness / rollout strategy / PDB |
| 服务发现 | compose service name | Service / headless Service / DNS |
| 持久卷 | named volume / bind mount | PVC / emptyDir / object storage |
| 网络隔离 | compose network | NetworkPolicy / strict egress |
| 监控接入 | 偏本地 | ServiceMonitor / PrometheusRule / dashboard |
| 最小权限 | docker socket / local trust | RBAC / ServiceAccount |

## 4. 当前仍然不一模一样的地方

即使已经补齐，Compose 和 K8S 仍然不会完全一样，这属于正常现象。

- Compose 里的 `depends_on` 在 K8S 不会直接存在
- Compose 的 volume 驱动和宿主机路径技巧不会原样进入 K8S
- Compose 的 `compose-scaler` 不会在 K8S 继续沿用
- K8S 额外需要：
  - `ServiceMonitor`
  - `PrometheusRule`
  - `NetworkPolicy`
  - strict egress
  - rollout checklist
  - operations runbook

## 5. 当前结论

如果按“我们之前做的优化到底有没有浪费”来判断，答案是：

- 最值钱的优化已经复用过去了
  - 镜像瘦身
  - 进程拆分
  - 常驻内存收缩
  - 按需加载
  - worker drain 逻辑
- K8S 之前主要缺的是“显式接线”
  - 启动命令路径
  - Node 内存上限
  - internal route 相关 env
  - object storage 相关优化 env
- 现在这些关键漏项已经补齐

所以目前可以把这件事理解成：

- Compose 下做的容器层优化，K8S 已经基本吃到
- K8S 额外补的是编排层和运维层能力，而不是重复造轮子
