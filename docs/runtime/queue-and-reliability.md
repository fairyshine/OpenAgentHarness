# Queue And Reliability

## 队列与并发

默认部署：`oah-api` 以 `API + embedded worker` 模式运行。需拆分时使用 `oah-api --api-only` + `oah-controller` + 承载 standalone worker 的 `oah-sandbox`。

### 队列原则

- 一个 session 一条逻辑队列
- 一个 session 同时只有一个 worker 持锁执行
- 不同 session 可并发
- 一个 worker pool 内的每个 `execution slot` 在任意时刻也只会持有一个 session；当前实现里 slot 与本地 worker 实例一一对应

### 当前实现

| 能力 | 状态 |
| --- | --- |
| 同 session 串行执行 | done |
| embedded worker 模式 | done |
| Redis 队列/锁（无 Redis 时退回 in-process） | done |
| heartbeat 落库 | done |
| 分布式可靠性（串行 + 取消 + 超时 + heartbeat + stale run 回收） | done |
| 启动时扫描 heartbeat 过期 run 并回收 | done |
| stale run 按策略自动重新排队 | partial |
| embedded worker 弹性扩缩容 | done |
| 全局 worker 负载感知 | partial |

### 建议做法

- Redis list / stream 保存 session 队列
- Redis lock 控制 session 执行权
- PostgreSQL 记录 run 最终状态
- `history.db` 只作为本地 SQLite 数据文件，不参与主调度链路

为什么不用单纯数据库锁：高频调度效率低、分布式扩展不自然、实时队列可观测性差。

## Worker 调度

### 当前模型

- Redis ready queue 只负责暴露“有哪些 session 可调度”，实际 run 仍然保存在每个 session 的逻辑队列中
- 一个 session 在任意时刻只能被一个 worker 持锁处理
- worker 抢锁失败时，会在 session 队列仍有待执行 run 的前提下把 session 重新放回 ready queue
- worker 启动时会先执行 stale run 恢复，再进入消费循环

### Worker 状态机

| 状态 | 含义 |
| --- | --- |
| `starting` | worker 启动中，尚未进入稳定拉取循环 |
| `idle` | worker 空闲，可继续 claim session |
| `busy` | worker 已持有 session 锁并在执行 run |
| `stopping` | worker 正在退出，不再领取新工作 |

### Pool 扩缩容

当前 `RedisRunWorkerPool` 是“本地弹性池 + 全局注册表感知”的模型，不是中心化调度器。

扩缩容决策会综合以下信号：

- `readySessionCount`：当前真正可调度的 session 数
- `readyQueueDepth`：ready queue 原始深度
- `uniqueReadySessionCount`：ready queue 去重后的 session 数
- `subagentReadySessionCount` / `subagentReadyQueueDepth`：subagent 优先级的可调度 session 数与原始 ready 深度
- `lockedReadySessionCount`：ready queue 中仍被锁住、暂时不可调度的 session 数
- `staleReadySessionCount`：ready queue 中已无待执行 run 的脏 session 数
- `oldestSchedulableReadyAgeMs`：最老可调度 session 在 ready queue 中等待的时长
- `busyWorkers` / `idleWorkers`：本地 worker 状态
- `slotCapacity` / `busySlots` / `idleSlots`：本地 execution slot 容量与占用
- `globalActiveWorkers` / `globalBusyWorkers`：从 worker registry 观察到的全局健康 worker 负载
- `remoteActiveWorkers` / `remoteBusyWorkers`：远端实例负载，用于避免本机在多实例场景下过度扩容

这些指标现在会统一进入 worker pool health snapshot / recent decisions，方便后续继续接 reserved capacity、workspace affinity 和 controller 决策。

为了让后续 sticky dispatch / controller 直接复用，当前 health snapshot 还会额外给出一组派生解释字段：

- `availableIdleCapacity`
- `readySessionsPerActiveWorker`
- `subagentReserveTarget`
- `subagentReserveDeficit`

扩容触发主要依赖三类压力：

- 队列压力：`ceil(readySessionCount / readySessionsPerCapacityUnit)`
- 饱和压力：`ceil((readySessionCount + busyWorkers) / readySessionsPerCapacityUnit)`
- subagent 保底容量：当存在 `subagentReadySessionCount > 0` 时，至少满足 `busyWorkers + reservedSubagentCapacity`
- 老化压力：当 busy ratio 超过阈值，且最老可调度 session 等待时间超过阈值时，额外建议增加一个 worker

为了避免抖动，pool 还带有：

- scale up / down sample window
- scale up / down cooldown
- 启动阶段直达建议容量，不受 sample window 阻塞
- 仅在容量或决策确实变化时记录 rebalance 日志

### 当前边界

- 已能感知全局健康 worker 数量，但还不是统一的 central scheduler
- 还不做 tenant / workspace 级公平调度
- 还不做 drain、cordon、rolling restart orchestration
- ready queue 的脏数据会被统计出来，但目前主要用于调度判断与运维观察，尚未形成独立治理面

## 取消、超时与恢复

### 取消

- API 取消 run → worker 检查取消标记 → shell 子进程发终止信号 → 外部调用 best-effort cancellation

### 超时

| 类型 | 状态 |
| --- | --- |
| run 总超时 | done |
| 单次工具调用超时 | done |
| hook 超时（不阻断 run，发通知事件） | done |
| 单次模型调用超时 | partial（hook 层有，主模型流以 run 总超时为主） |

### 恢复

| 能力 | 状态 |
| --- | --- |
| 基于 heartbeat 的启动恢复扫描 | done |
| stale run 标记为 `failed`（fail-closed） | done |
| stale `running` run 自动重新排队 | done |
| stale `waiting_tool` run 自动重新排队 | partial（需显式启用 `requeue_all`） |
| 自动重新排队次数上限 | done |

### 恢复策略

`RuntimeService` 当前支持三种 stale run 恢复策略：

| 策略 | 行为 |
| --- | --- |
| `fail` | 所有 stale active run 直接回收为 `failed` |
| `requeue_running` | 仅 stale `running` run 会重置为 `queued` 并重新入队；`waiting_tool` 仍 fail-closed |
| `requeue_all` | stale `running` / `waiting_tool` 都可重置为 `queued` 并重新入队 |

补充规则：

- 只有配置了 `runQueue` 且 run 仍绑定 `sessionId` 时，才会执行自动重新排队
- 每次恢复会累积 `metadata.recoveryAttempts`，并同步维护结构化的 `metadata.recovery`
- 超过 `maxAttempts` 后不再继续重排队，而是回收到失败态
- 被隔离的 recovery run 可通过管理面执行人工 `manual requeue`
- 管理面已支持批量人工 `manual requeue`，按 run 返回逐项结果
- Storage 页已支持对 `runs` 表按 `status` / `errorCode` / `recoveryState` 过滤，便于直接定位 quarantine run
- Storage 概览会额外汇总 recovery / quarantine 计数、最近隔离时间和主要隔离原因，便于做运维审计
- 自动重排队会清理 `startedAt`、`heartbeatAt`、`endedAt`、取消标记和错误字段，并追加 `run.queued` 事件与 `run.requeued` system step

### 默认策略

- 无 Redis 队列时，默认策略是 `fail`
- 使用 Redis 队列时，server 默认策略是 `requeue_running`

这意味着默认生产 Redis 部署会自动恢复 stale `running` run，但不会无条件续跑 stale `waiting_tool` 场景。

## 本地 SQLite 数据

### 原则

- PostgreSQL 仍是中心事实源
- `.openharness/data/history.db` 仅承载本地运行时数据与工作区级持久化
- 本地 SQLite 不负责跨进程、跨 Pod 的 history mirror sync

### 故障边界

| 故障 | 影响 |
| --- | --- |
| 中心库 | 在线请求 |
| Redis | 调度 |
| 本地 SQLite | 仅影响当前 worker 上的本地状态与排障信息 |

## 当前边界

- 生产执行：已具备取消、run/tool 超时、hook 非阻断超时通知、stale run 启动恢复
- worker 崩溃后 run 长时间卡住：默认不会，后续 worker 启动时会恢复 stale run
- worker 崩溃后 run 自动续跑：部分支持，仅限符合恢复策略且未超过最大尝试次数的 run
- `waiting_tool` 自动续跑仍是高风险路径，默认保持保守
- 当前已有 quarantine 元数据和单条/批量 `manual requeue` 入口，但还没有独立 DLQ 队列与完整批量治理面

## 后续成熟化

worker 执行层的持续演进路线图单独维护在：

- [Worker 执行层成熟化路线图](./worker-scaling-roadmap.md)
