# Kubernetes Rollout Checklist

这份清单用于把 OAH 从“chart 能渲染”推进到“staging / production 能稳定上线”。

建议把它和下面这些材料一起看：

- [部署文档](/Users/wumengsong/Code/OpenAgentHarness/docs/deploy.md)
- [K8S 路线图](/Users/wumengsong/Code/OpenAgentHarness/ROADMAP_K8S.md)
- [Helm Chart README](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/README.md)
- [prod.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod.values.yaml)
- [prod-hardening.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml)

## 1. Before Staging

- 镜像已经从当前仓库构建并推送，tag 明确，不使用临时本地镜像名。
- `server.yaml` 或对应 ConfigMap 已明确：
  - `storage.postgres_url`
  - `storage.redis_url`
  - `workers.controller.leader_election.kubernetes.*`
  - `workers.controller.scale_target.kubernetes.*`
- `scale_target.kubernetes.label_selector` 只会命中当前 release 的 `oah-sandbox` Deployment。
- `oah-controller` 的 ServiceAccount / RBAC 已应用，并确认具备：
  - `leases get/create/patch`
  - `deployments get/list`
  - `deployments/scale get/patch`
- `worker.drain.timeoutMs < worker.terminationGracePeriodSeconds * 1000`。
- `worker` 的 `preStop` 已开启，确保 Pod 终止前先进入 draining。
- `PodDisruptionBudget`、`topologySpreadConstraints`、`priorityClassName` 已按目标环境设置。
- Helm values 或 raw manifests 已通过渲染检查：
  - `helm template ...`
  - 或 `kubectl apply --dry-run=server ...`

## 2. Staging Rollout

- 先用 `staging.values.yaml` 起步，再按环境差异叠加覆盖文件。
- 部署后确认 3 个组件都 ready：
  - `oah-api`
  - `oah-controller`
  - `oah-sandbox`
- `oah-controller` 的 `/snapshot` 确认：
  - `leaderElection.leader=true` 至少存在一个实例
  - `scaleTarget.kind=kubernetes`
  - `scaleTarget.phase` 不处于长期 `error`
- `oah-sandbox` 的 `/readyz` 在正常状态下返回 `200`，触发 drain 后会转 `503`。
- 通过 Web 或 API 实测一轮最小工作流：
  - workspace 能加载
  - run 能从 `queued` 推进到执行
  - worker registry 有活跃实例
- 实测一轮扩容：
  - 提高压力后 `desiredReplicas` 增长
  - `scaleTarget.phase` 能经历 `accepted/progressing/ready`
  - 新 Pod ready 后 `readyReplicas` 跟上
- 实测一轮缩容：
  - worker 先进入 draining
  - `/readyz` 先摘除
  - 活跃 run 不被粗暴打断
- 实测一轮 controller failover：
  - 当前 leader 下线后，其他副本接管
  - `leader_election_changes` 增长
  - 不出现明显重复扩缩容抖动

## 3. Observability Check

- 已接入 `ServiceMonitor`。
- 已接入 `PrometheusRule`。
- 已导入 Grafana dashboard ConfigMap 或 sidecar 已自动加载。
- 核心指标可见：
  - `oah_controller_leader`
  - `oah_controller_desired_replicas`
  - `oah_controller_active_replicas`
  - `oah_controller_scale_target_phase_*`
  - `oah_controller_scale_target_ready_replicas`
  - `oah_controller_scale_down_blocked_replicas`
- 告警规则已在 Prometheus 中可见：
  - `OAHControllerNoLeader`
  - `OAHControllerScaleTargetError`
  - `OAHControllerWorkerRolloutStuck`
  - `OAHControllerScaleDownBlocked`

## 4. Network Hardening Check

- 如果只做 ingress 收口：
  - `networkPolicy.enabled=true`
  - Prometheus 抓取 `controller` 的规则仍然可达
- 如果启用 strict egress：
  - 先从 [strict-egress.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/strict-egress.values.yaml) 或 [prod-hardening.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml) 起步
  - 再替换：
    - Kubernetes API CIDR
    - Redis Pod labels
    - Postgres Pod labels
    - 对象存储 CIDR / egress gateway
    - 模型网关 CIDR / egress gateway
- 启用 strict egress 后逐项验证：
  - DNS 解析正常
  - controller 仍能访问 Kubernetes API
  - API / worker 仍能访问 Redis / Postgres
  - worker 仍能访问对象存储
  - API / worker 仍能访问模型网关

## 5. Production Readiness

- 使用 `prod.values.yaml` 作为基础，再叠加 [prod-hardening.values.yaml](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/examples/prod-hardening.values.yaml)。
- 所有 placeholder 都已被真实环境值替换：
  - Ingress host
  - IRSA / Workload Identity annotation
  - PVC 名称
  - Prometheus release label
  - Kube API CIDR
  - 对象存储 / 模型网关网段
- 滚动发布策略确认：
  - `apiServer.strategy.maxUnavailable=0`
  - `worker.strategy.maxUnavailable=0`
  - `controller.strategy.maxUnavailable=0`
- 至少完成一次真实的：
  - 扩容演练
  - 缩容演练
  - worker drain 演练
  - controller failover 演练
  - chart 升级与回滚演练
- 已确认对象存储、数据库、模型出口的访问路径和网络白名单不会被 NetworkPolicy 误拦。
- 已确认告警能真正触发并被通知链路接收，而不只是规则存在。

## 6. Release Gate

满足下面这些条件再推进正式上线：

- Helm 渲染成功，且变更清单已审阅。
- 所有 Deployment 都能稳定达到 ready。
- controller 在 rollout 后仍保持单 leader 运行。
- scale target 最近没有持续 `error`。
- worker drain 行为与 `terminationGracePeriodSeconds` 一致。
- `PrometheusRule` 和 dashboard 已加载。
- strict egress 若已开启，所有关键依赖都完成连通性验证。
- staging 至少稳定运行一轮业务回归周期。
