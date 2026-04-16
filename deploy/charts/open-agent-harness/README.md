# Open Agent Harness Helm Chart

这个 chart 提供当前 split deployment 骨架的 Helm 入口，覆盖：

- `oah-api`
- `oah-sandbox`
- `oah-controller`
- `controller` 所需的 ServiceAccount / RBAC
- `server.yaml` ConfigMap
- 可选的 Prometheus Operator `ServiceMonitor`

## 安装

```bash
kubectl create namespace open-agent-harness

helm install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --set image.repository=ghcr.io/open-agent-harness/open-agent-harness \
  --set image.tag=latest
```

如果要启用 Prometheus Operator `ServiceMonitor`：

```bash
helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --set serviceMonitor.enabled=true
```

## 环境样例

仓库当前还提供了三套可直接参考的 values 样例：

- [dev.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/dev.values.yaml)
- [staging.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/staging.values.yaml)
- [prod.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod.values.yaml)

渲染或安装示例：

```bash
helm template oah ./deploy/charts/open-agent-harness \
  -f ./deploy/charts/open-agent-harness/examples/staging.values.yaml

helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  -f ./deploy/charts/open-agent-harness/examples/prod.values.yaml
```

## 常用 values

- `image.repository`
- `image.tag`
- `config.serverYaml`
- `config.create`
- `config.nameOverride`
- `apiServer.replicaCount`
- `apiServer.resources`
- `worker.replicaCount`
- `worker.workspaceVolume.type`
- `worker.workspaceVolume.persistentVolumeClaim.claimName`
- `worker.resources`
- `controller.replicaCount`
- `controller.resources`
- `apiServer.ingress.enabled`
- `apiServer.podDisruptionBudget.enabled`
- `worker.podDisruptionBudget.enabled`
- `controller.podDisruptionBudget.enabled`
- `apiServer.topologySpreadConstraints`
- `worker.topologySpreadConstraints`
- `controller.topologySpreadConstraints`
- `serviceMonitor.enabled`

> 兼容说明
>
> Helm values 目前仍保留 `worker.*` 作为配置 key，但渲染出来的运行时资源名和组件标签已经统一到 `sandbox`，对应 `oah-sandbox` 这层部署形态。

## 样例定位

- `dev.values.yaml`
  - 本地集群 / 轻量共享环境
  - `emptyDir` workspace cache
  - 最小副本数与较轻资源
- `staging.values.yaml`
  - 接近生产的演练环境
  - 已开启 Ingress、PDB、topology spread、PVC workspace volume、ServiceMonitor
- `prod.values.yaml`
  - 更偏正式生产的起点
  - 更高副本数、更严格的 `DoNotSchedule` spread 策略、PVC workspace volume、IRSA/Workload Identity 注解占位

## 配置说明

- 默认会创建一个 ConfigMap，并把 `config.serverYaml` 渲染为 `/etc/oah/server.yaml`
- 如需复用外部已有 ConfigMap，可设置：
  - `config.create=false`
  - `config.nameOverride=<existing-configmap-name>`
- 三个组件都支持：
  - `podSecurityContext`
  - `securityContext`
  - `resources`
  - `priorityClassName`
  - `topologySpreadConstraints`
  - `nodeSelector`
  - `tolerations`
  - `affinity`
  - `extraEnv`
  - `envFrom`
  - `extraVolumes`
  - `extraVolumeMounts`
- 三个组件都可以单独开启 `PodDisruptionBudget`
- `apiServer.ingress` 可直接暴露 API server，而不必额外手写 Ingress 清单
- worker 的 workspace 卷现在支持两种模式：
  - `worker.workspaceVolume.type=emptyDir`
  - `worker.workspaceVolume.type=persistentVolumeClaim`
- 当 `worker.workspaceVolume.type=persistentVolumeClaim` 时，需要设置：
  - `worker.workspaceVolume.persistentVolumeClaim.claimName`
- `apiServer.serviceAnnotations` / `worker.serviceAnnotations` / `controller.service.annotations` 可用于补充 LB / scrape / mesh 侧 annotations
- `controller.serviceAccount.annotations` 可用于 IRSA / Workload Identity 等集群集成
- worker 的 `OAH_INTERNAL_BASE_URL` 会自动按 release 名称和 namespace 生成 headless service DNS
- controller 默认使用 release 级 label selector，只会缩放当前 release 对应的 sandbox Deployment
