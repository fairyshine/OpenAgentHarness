# Worker 执行层成熟化路线图

本文档用于持续维护 `embedded worker` / `standalone worker` / Redis run queue 这一整套执行层的演进方案。

目标不是只让 worker “能跑”，而是逐步升级为适合商业化部署的高成熟度执行系统：可扩展、可观测、可治理、可解释。

## 目标

高成熟度版本需要同时满足以下要求：

- 不因单 worker、父子 run、瞬时 backlog 出现结构性死锁
- 在高并发下保持稳定，不因短时突发出现扩缩容抖动
- 能解释为什么扩容、为什么没扩容、为什么缩容
- 能通过健康检查和指标快速定位瓶颈
- 能从单进程 embedded pool 平滑升级到多进程 / 多实例 worker
- 能支持商业化场景下的优先级、配额、隔离和 SLA

## 设计原则

### 1. 安全优先于吞吐

先保证不会卡死、不会重复执行、不会失控扩容，再追求更高吞吐。

### 2. 热备优先于极致节流

默认保留最小热备 worker，保证 `SubAgent`、父子 run、交互型请求不会因为冷启动或单 worker 被饿死。

### 3. 以等待时间而不是纯队列长度驱动

成熟策略不应只看 `ready queue length`，而应优先关注：

- `queue_wait_ms`
- `busy_workers / total_workers`
- `idle capacity`
- `subagent reserve`
- `tenant quota`

### 4. 统一控制面

embedded worker pool 和 standalone worker 最终都应进入同一套 worker registry、lease、health、autoscaling 决策模型。

## 目标架构

建议将执行层逐步拆分为四层：

### Execution Plane

负责真正执行 run：

- `RedisRunWorker`
- `RedisRunWorkerPool`
- 未来的 standalone worker process

### Scheduling Plane

负责决定“谁先跑、谁后跑、给谁留容量”：

- session queue
- priority queue
- subagent reserve
- tenant quota

### Control Plane

负责决定“扩不扩、缩不缩、谁健康、谁失联”：

- worker registry
- worker lease / heartbeat
- scaling policy
- cooldown / hysteresis

### Observability Plane

负责解释系统当前状态：

- health report
- metrics
- scale events
- queue lag / wait time
- stuck run / stale run diagnostics

## 当前状态

截至目前，已经落地：

- Redis run queue + session lock
- `API + embedded worker` 模式下默认至少 `2` 个 worker
- 进程内 `RedisRunWorkerPool`
- 基于 backlog 和空闲容量缺口的轻量扩容
- 基于 idle TTL 的慢缩容
- `scale_up_window` / `scale_down_window` / `cooldown_ms`
- 仅在状态变化时输出 pool 日志
- pool stats 接入 health report

当前仍属于 `V1 基础可用版`，距离商业化成熟版本还缺：

- `queue_wait_ms` 驱动扩容
- `subagent reserve`
- `worker registry + lease`
- 多优先级队列
- tenant quota / fairness
- 统一指标与告警

## 分阶段实施

## Phase A: 生产可用强化版

目标：在现有 embedded pool 基础上，把“稳定性”和“可解释性”补齐。

### A1. 等待时长驱动扩容

新增指标：

- `queue_wait_ms_p50`
- `queue_wait_ms_p95`
- `oldest_ready_age_ms`

策略：

- backlog 作为辅助信号
- `queue_wait_ms` 作为主信号
- 当等待时间持续超过目标阈值时扩容

交付标准：

- health report 能看到最近等待时长
- scale log 能说明是 `backlog` 还是 `wait_time` 触发

### A2. SubAgent 保底容量

目标：即使高负载下，也保留一部分容量供 child run 使用，避免父 run 同步等待 child run 时饿死。

建议：

- 新增 `reserved_capacity_for_subagent`
- 或为 subagent 引入独立的高优先级 ready queue

交付标准：

- 单机 embedded 模式下，父 run 等待 child run 时不会被普通 backlog 长时间阻塞

### A3. Stuck Run / Stuck Session 诊断

补充：

- 长时间 `waiting_tool` / `queued` 检测
- session lock 持有过久检测
- 自动输出诊断原因

交付标准：

- 通过 health/admin 接口可直接看到异常 session / run

## Phase B: 控制面升级版

目标：从“单进程 worker pool”升级为“统一 worker 控制面”。

### B1. Worker Registry

为每个 worker 注册：

- worker id
- process kind
- capabilities
- last heartbeat
- current load
- status

### B2. Worker Lease / Heartbeat

让 embedded worker 和 standalone worker 都以相同方式续约。

交付标准：

- worker 失联可被明确识别
- control plane 可区分“队列没活”和“worker 不健康”

### B3. 统一扩缩容策略

把现有 pool 内部策略逐步上提为统一 policy：

- desired workers
- cooldown
- hysteresis
- emergency recovery

## Phase C: 商业化治理版

目标：支持不同任务类型和不同客户负载的治理。

### C1. 优先级队列

建议拆分：

- interactive run
- subagent run
- background run

交付标准：

- 高优先级请求不被后台任务长期阻塞

### C2. Tenant Quota / Fairness

能力包括：

- 每租户并发上限
- 每租户队列积压上限
- burst 配额
- 公平调度

### C3. 成本控制

包括：

- 最大 worker 上限
- 最大并发 run 上限
- 降级策略
- 压力保护

## Phase D: 平台化与外部扩缩容

目标：让系统可以从进程内 pool 平滑演进到容器 / 多实例 worker 集群。

### D1. 进程外 worker

独立 worker process 与 embedded worker 共用同一调度协议。

### D2. 外部 Autoscaler

例如基于 Redis lag / queue wait time 驱动实例级扩缩容。

### D3. 运营与告警

沉淀：

- dashboard
- SLO
- alert rules
- scale event timeline

## 推荐实施顺序

建议按以下顺序推进，不建议跳步：

1. `queue_wait_ms + oldest_ready_age_ms`
2. `last_scale_reason + scale metrics`
3. `reserved_capacity_for_subagent`
4. `stuck run / stuck session diagnostics`
5. `worker registry + lease`
6. `priority queue`
7. `tenant quota / fairness`
8. `external autoscaler`

## 近期执行清单

下一轮按以下顺序落代码：

- [x] 为 ready queue 补充等待时长指标
- [x] 在 pool stats / health report 中暴露等待时长
- [x] 扩缩容日志增加 `reason`
- [x] 实现 `reserved_capacity_for_subagent`
- [x] 增加 stuck run / stuck session 检测

## 相关代码落点

- `packages/storage-redis/src/index.ts`
- `apps/server/src/bootstrap.ts`
- `packages/config/src/index.ts`
- `docs/schemas/server-config.schema.json`
- `tests/storage-redis.test.ts`
- `tests/bootstrap-single-workspace.test.ts`

## 相关文档

- [Queue 与可靠性](./queue-and-reliability.md)
- [运行时导航](./README.md)
- [实施路线](../implementation-roadmap.md)
