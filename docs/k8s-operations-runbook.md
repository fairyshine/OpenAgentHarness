# Kubernetes Operations Runbook

这份 runbook 用来处理 OAH 在 Kubernetes 上最常见的几类运行异常。

配套文档：

- [K8S 路线图](/Users/wumengsong/Code/OpenAgentHarness/ROADMAP_K8S.md)
- [部署文档](/Users/wumengsong/Code/OpenAgentHarness/docs/deploy.md)
- [Kubernetes Rollout Checklist](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-rollout-checklist.md)
- [Helm Chart README](/Users/wumengsong/Code/OpenAgentHarness/deploy/charts/open-agent-harness/README.md)

建议排障时优先确认：

- 当前 release 名称
- 当前 namespace
- 当前使用的是哪套 values
- 最近一次 chart 升级或镜像变更时间

## 1. Controller 无 Leader

现象：

- `oah_controller_leader` 持续为 `0`
- `OAHControllerNoLeader` 告警触发
- `/snapshot` 中所有 controller 实例都显示 `leader=false`

优先检查：

- controller Pod 是否都 ready
- `workers.controller.leader_election.kubernetes.*` 是否正确
- controller RBAC 是否具备 `leases get/create/patch`
- ServiceAccount 是否挂载了 in-cluster token

建议命令：

```bash
kubectl -n <namespace> get pods -l app.kubernetes.io/component=controller
kubectl -n <namespace> logs deploy/<controller-deployment> --tail=200
kubectl -n <namespace> get lease
kubectl -n <namespace> describe lease <lease-name>
kubectl -n <namespace> auth can-i get leases --as=system:serviceaccount:<namespace>:<service-account>
kubectl -n <namespace> auth can-i patch leases --as=system:serviceaccount:<namespace>:<service-account>
```

常见原因：

- Lease namespace / name 配置错
- controller RBAC 不足
- Pod 无法访问 Kubernetes API
- strict egress 打开后，没有放行 Kubernetes API

恢复动作：

- 先修正 RBAC 或 egress 到 Kubernetes API 的放行
- 再重启 controller Deployment
- 确认至少一个实例重新拿到 `leader=true`

## 2. Scale Target 持续 Error

现象：

- `oah_controller_scale_target_phase_error` 持续为 `1`
- `OAHControllerScaleTargetError` 告警触发
- `/snapshot.controller.scaleTarget.reasonCode` 为 `selector_no_match`、`forbidden`、`timeout` 等

优先检查：

- `scale_target.kubernetes.label_selector` 是否只命中一个 Deployment
- controller 是否有 `deployments get/list` 与 `deployments/scale get/patch`
- strict egress 是否放行了 Kubernetes API

建议命令：

```bash
kubectl -n <namespace> get deploy -l '<label-selector>'
kubectl -n <namespace> auth can-i get deployments --as=system:serviceaccount:<namespace>:<service-account>
kubectl -n <namespace> auth can-i patch deployments/scale --as=system:serviceaccount:<namespace>:<service-account>
kubectl -n <namespace> logs deploy/<controller-deployment> --tail=200
curl http://<controller-pod-ip>:8788/snapshot
```

常见原因：

- selector 0 命中或多命中
- target Deployment 名称变化但 values 未同步
- RBAC 不足
- API server 超时 / 网络抖动

恢复动作：

- 优先修正 selector 或 RBAC
- 若是网络问题，先回滚 strict egress 变更或放通 API
- 观察 `scaleTarget.phase` 从 `error` 恢复为 `accepted/progressing/ready`

## 3. Worker Rollout Stuck

现象：

- `oah_controller_scale_target_phase_progressing` 长时间为 `1`
- `desired_replicas > scale_target_ready_replicas`
- `OAHControllerWorkerRolloutStuck` 告警触发

优先检查：

- worker Pod 是否创建成功但未 ready
- `readinessProbe` 是否连续失败
- workspace volume、Redis、Postgres、对象存储是否可达

建议命令：

```bash
kubectl -n <namespace> get pods -l app.kubernetes.io/component=sandbox -o wide
kubectl -n <namespace> describe pod <worker-pod>
kubectl -n <namespace> logs <worker-pod> --tail=200
kubectl -n <namespace> get events --sort-by=.lastTimestamp | tail -n 50
```

常见原因：

- readiness 探针失败
- strict egress 打开后，Redis / Postgres / 对象存储 / 模型网关未放行
- PVC 或 `emptyDir` 容量问题
- 新镜像启动失败

恢复动作：

- 先定位是探针失败、依赖不可达还是镜像异常
- 如为 strict egress 误拦，先回滚 overlay 或补放行
- 必要时回滚 chart / 镜像版本

## 4. Worker Drain 超时

现象：

- worker 进入 draining 后长时间不退出
- Pod 长时间处于 `Terminating`
- 日志中出现 drain timeout recovery

优先检查：

- `worker.drain.timeoutMs`
- `worker.terminationGracePeriodSeconds`
- `worker.drain.timeoutStrategy`
- 当前是否存在长时间运行的 run / workspace flush

建议命令：

```bash
kubectl -n <namespace> logs <worker-pod> --tail=200
kubectl -n <namespace> describe pod <worker-pod>
curl http://<worker-pod-ip>:8787/healthz
curl http://<worker-pod-ip>:8787/readyz
```

常见原因：

- `terminationGracePeriodSeconds` 小于 drain timeout
- `preStop` 已触发，但 run 本身无法正常结束
- workspace flush / object storage 回写过慢

恢复动作：

- 短期先确认 recovery 策略是否符合预期
- 中期调大 `terminationGracePeriodSeconds`
- 如 object storage 慢导致 drain 卡住，优先检查出口网络与存储侧性能

## 5. Scale-Down 一直被阻塞

现象：

- `oah_controller_scale_down_allowed=0`
- `oah_controller_scale_down_blocked_replicas > 0`
- `OAHControllerScaleDownBlocked` 告警持续触发

优先检查：

- `/snapshot.controller.scaleDownGate`
- worker 是否仍在 draining
- workspace materialization 是否还有 blocker / failure
- placement 是否还引用 late / missing worker

建议命令：

```bash
curl http://<controller-pod-ip>:8788/snapshot
kubectl -n <namespace> logs deploy/<controller-deployment> --tail=200
kubectl -n <namespace> logs <worker-pod> --tail=200
```

常见原因：

- worker 正在 drain
- object-store materialization 尚未 flush 完
- placement 仍引用 late / missing owner worker

恢复动作：

- 先确认是不是健康的保护性阻塞
- 如果只是 drain 未收敛，优先等它自然结束
- 如果是 placement 长时间不收敛，再检查 worker registry 与 Redis 状态

## 6. Strict Egress 打开后组件不可用

现象：

- rollout 后多个组件同时 not ready
- 日志出现 Redis / Postgres / S3 / model gateway 连接失败
- DNS 解析失败

优先检查：

- 当前是否叠加了 `strict-egress.values.yaml` 或 `prod-hardening.values.yaml`
- `networkPolicy.egress.dependencies.*` 中的 peer selector / CIDR 是否已替换成真实值

建议命令：

```bash
kubectl -n <namespace> get networkpolicy
kubectl -n <namespace> describe networkpolicy <name>
kubectl -n <namespace> logs <pod> --tail=200
```

建议处理顺序：

1. 先确认 DNS 是否放行
2. 再确认 Redis / Postgres
3. 再确认 Kubernetes API
4. 最后确认对象存储 / 模型网关

恢复动作：

- 最快的恢复方式是回滚 strict egress overlay
- 然后按依赖逐项补 peer selector / CIDR，再重新启用

## 7. Chart 升级后出现回归

现象：

- 升级后一切资源都存在，但行为回归
- controller 指标异常
- worker drain 或 scale target 行为和升级前不一致

优先检查：

- 本次升级的 values diff
- 镜像 tag diff
- `helm get values` 和 `helm get manifest`

建议命令：

```bash
helm -n <namespace> history <release>
helm -n <namespace> get values <release> -a
helm -n <namespace> get manifest <release>
kubectl -n <namespace> rollout status deploy/<deployment>
```

恢复动作：

- 如果问题范围大，先回滚 release
- 回滚后按 [Kubernetes Rollout Checklist](/Users/wumengsong/Code/OpenAgentHarness/docs/k8s-rollout-checklist.md) 重新验证

## 8. 推荐排障顺序

遇到 K8S 运行异常时，建议按下面顺序排：

1. 先看 controller 是否有 leader
2. 再看 scale target 是否处于 `error`
3. 再看 worker rollout 是否 stuck
4. 再看 worker drain / scale-down gate
5. 最后看 strict egress / NetworkPolicy 是否误拦

这个顺序的好处是：

- 先判断是不是控制面失效
- 再判断是不是平台调用失效
- 最后才判断执行面和网络面细节
