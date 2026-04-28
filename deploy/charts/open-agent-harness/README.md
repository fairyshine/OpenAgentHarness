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
- [strict-egress.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/strict-egress.values.yaml)
- [prod-hardening.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml)
- [Compose To Kubernetes Reuse Matrix](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-compose-reuse-matrix.md)
- [Kubernetes Rollout Checklist](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-rollout-checklist.md)
- [Kubernetes Operations Runbook](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-operations-runbook.md)

渲染或安装示例：

```bash
helm template oah ./deploy/charts/open-agent-harness \
  -f ./deploy/charts/open-agent-harness/examples/staging.values.yaml

helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  -f ./deploy/charts/open-agent-harness/examples/prod.values.yaml

helm upgrade --install oah ./deploy/charts/open-agent-harness \
  --namespace open-agent-harness \
  --create-namespace \
  -f ./deploy/charts/open-agent-harness/examples/prod.values.yaml \
  -f ./deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml
```

完成渲染和部署后，建议再按这两份文档收尾：

- [Kubernetes Rollout Checklist](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-rollout-checklist.md)
- [Kubernetes Operations Runbook](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-operations-runbook.md)

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
- `worker.drain.timeoutMs`
- `worker.drain.timeoutStrategy`
- `worker.drain.preStop.enabled`
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
- `prometheusRule.enabled`
- `grafanaDashboard.enabled`
- `networkPolicy.enabled`
- `networkPolicy.apiServer.egress.enabled`
- `networkPolicy.worker.egress.enabled`
- `networkPolicy.controller.egress.enabled`

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
  - worker drain / `terminationGracePeriodSeconds` 已显式对齐
  - controller rollout 显式使用 `maxUnavailable: 0`
  - 已开启 `PrometheusRule`、Grafana dashboard ConfigMap、controller/worker ingress `NetworkPolicy`
- `prod.values.yaml`
  - 更偏正式生产的起点
  - 更高副本数、更严格的 `DoNotSchedule` spread 策略、PVC workspace volume、IRSA/Workload Identity 注解占位
  - worker drain / `terminationGracePeriodSeconds` 已显式对齐
  - controller rollout 显式使用 `maxUnavailable: 0`
  - 已开启 `PrometheusRule`、Grafana dashboard ConfigMap、controller/worker ingress `NetworkPolicy`
- `strict-egress.values.yaml`
  - 严格出口白名单的起步 overlay
  - 演示 DNS、Kubernetes API、Redis、Postgres、对象存储、模型运行时的显式放行
  - 其中 CIDR / pod label 只是示例，使用前需要替换成真实环境值
- `prod-hardening.values.yaml`
  - 面向生产环境的 hardening overlay
  - 在 `prod.values.yaml` 基础上叠加监控、Grafana dashboard、strict egress
  - 适合作为正式环境前的最后一层整理

## 配置说明

- 默认会创建一个 ConfigMap，并把 `config.serverYaml` 渲染为 `/etc/oah/server.yaml`
- 默认 `config.serverYaml` 使用 `sandbox.provider=self_hosted`，并通过 `oah-sandbox-internal` headless service 访问 sandbox 内 worker
- 默认 sandbox fleet 保留 `warm_empty_count: 1` 个空 sandbox；无 `ownerId` 的 workspace 会先复用 CPU 和内存均低于 `0.8` 的已有 sandbox，任一资源超过阈值后再使用空 sandbox
- 默认 active workspace copy 空闲 `900000ms` 后进入 flush / evict 维护流程
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
- workspace 卷只挂在 sandbox worker 上；`oah-api` 默认不挂载 workspace volume，避免 API Pod 累积 active workspace 的本地目录
- 当 `worker.workspaceVolume.type=persistentVolumeClaim` 时，需要设置：
  - `worker.workspaceVolume.persistentVolumeClaim.claimName`
- worker 现在默认会把 K8S `preStop` hook 对齐到本地 drain 控制入口：
  - `worker.drain.preStop.enabled=true`
  - `worker.drain.timeoutMs` 控制 worker drain 超时
  - `worker.drain.timeoutStrategy` 控制 drain 超时后的 run recovery 策略
  - `worker.terminationGracePeriodSeconds` 应大于 `worker.drain.timeoutMs / 1000`
- controller 默认 rollout 现在也建议使用：
  - `controller.strategy.maxUnavailable=0`
  - `controller.strategy.maxSurge=1`
  这样在多副本控制面下不会因为滚动发布主动把 leader election 面降到 0 个 ready 实例
- 可选监控与隔离基线：
  - `serviceMonitor.enabled=true` 为 controller 暴露 Prometheus Operator `ServiceMonitor`
  - `prometheusRule.enabled=true` 生成 controller leader / scale-target / rollout / scale-down-blocked 告警
  - `grafanaDashboard.enabled=true` 生成带 sidecar label 的 Grafana dashboard ConfigMap
  - `networkPolicy.enabled=true` 为 controller / worker 收紧 ingress 面
- 当前 chart 的 `networkPolicy` 默认只收紧 ingress，不默认限制 egress：
  - 这是为了避免把 Redis、PostgreSQL、对象存储、外部模型运行时等依赖错误拦住
  - 如果后续要做更严格的 egress 白名单，建议从 [strict-egress.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/strict-egress.values.yaml) 起步，再按集群环境改写
- strict egress 的推荐理解方式：
  - 先开启 `networkPolicy.<component>.egress.enabled=true`
  - 再按组件决定是否放行 `kubernetesApi / redis / postgres / objectStorage / modelGateway`
  - 最后在 `networkPolicy.egress.dependencies.*` 里补 peer selector 或 CIDR
- `apiServer.serviceAnnotations` / `worker.serviceAnnotations` / `controller.service.annotations` 可用于补充 LB / scrape / mesh 侧 annotations
- `controller.serviceAccount.annotations` 可用于 IRSA / Workload Identity 等集群集成
- worker 的 `OAH_INTERNAL_BASE_URL` 会自动按 release 名称和 namespace 生成 headless service DNS
- controller 默认使用 release 级 label selector，只会缩放当前 release 对应的 sandbox Deployment
