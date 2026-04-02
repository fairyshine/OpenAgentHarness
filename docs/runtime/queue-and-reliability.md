# Queue And Reliability

## 队列与并发

默认部署建议：

- `server` 默认以 `API + embedded worker` 模式运行，优先保证单机可用性
- 需要拆分部署时，再使用 `server --api-only` + 独立 `worker`

### 队列原则

- 一个 session 一条逻辑队列
- 一个 session 同时只有一个 worker 持锁执行
- 不同 session 的 run 可以并发

### 当前实现状态

- `done` 同 session 串行执行
- `done` 默认 `server` 进程可直接以 embedded worker 模式执行 run
- `done` Redis 可用时走队列 / 锁；未配置 Redis 时可退回本地 in-process 执行
- `partial` 分布式可靠性目前覆盖“单 session 串行 + 取消 + 超时 + run heartbeat + stale run fail-closed recovery”
- `done` heartbeat 落库
- `partial` worker 启动时会扫描 heartbeat 过期的 `running` / `waiting_tool` run，并将其回收为失败态

### 建议做法

- Redis list 或 stream 保存 session 队列
- Redis lock 控制 session 执行权
- PostgreSQL 记录 run 最终状态
- `history.db` 通过异步 mirror sync 写入，不进入主调度链路

### 为什么不用单纯数据库锁

只用 PostgreSQL 也能做，但会在以下方面更笨重：

- 高频调度效率低
- 分布式 worker 扩展不自然
- 实时队列可观测性差

## 取消、超时与失败恢复

### 取消

- 调用方可通过 API 取消 run
- worker / 运行时会检查取消标记
- 对 shell 子进程发送终止信号
- 对外部 tool 调用和子流程做 best-effort cancellation

### 超时

需要区分：

- `done` run 总超时
- `partial` 单次模型调用超时目前主要体现在 hook `prompt` / `agent` 包装层；主模型流仍以 run 总超时为主
- `done` 单次工具调用超时
- `done` hook `command` / `http` / `prompt` / `agent` 超时不会阻断 run，但会显式发出通知事件

### 恢复

- `done` 当前已实现基于 heartbeat 的启动恢复扫描
- `done` worker 启动时会扫描 PostgreSQL 中长时间未 heartbeat 的活跃 run
- `done` 当前恢复策略是保守的 fail-closed：将 stale run 标记为 `failed`
- `missing` 还没有自动重新排队 / 续跑

## 本地历史镜像可靠性

### 同步原则

- PostgreSQL 是唯一事实源
- `.openharness/data/history.db` 是单向异步镜像
- 镜像同步失败不影响 run 执行和队列推进

### 建议做法

- 中心库在写入业务记录时，同事务追加 history event
- 独立 syncer 按 `workspace_id + event_id` 拉取增量
- 本地 SQLite 采用幂等 upsert
- 成功后推进本地同步游标

### 恢复

- syncer 重启后从本地 `last_event_id` 继续同步
- 本地镜像缺失时可从头回放
- 本地镜像损坏时可删除并重建

### 故障边界

- 中心库故障会影响在线请求
- Redis 故障会影响调度
- 本地镜像故障只影响备份和离线检视，不影响在线执行

## 当前边界总结

- 如果你在评估“今天能否依赖它做生产执行”，当前已经具备取消、run/tool 超时、hook 非阻断超时通知
- 如果你在评估“worker 崩掉后 run 会不会永远卡住”，当前答案已经不是了；stale run 会在后续 worker 启动时被回收为失败态
- 如果你在评估“worker 崩掉后 run 能否自动续跑”，答案仍然不能，当前仍需要外部编排或人工重试
