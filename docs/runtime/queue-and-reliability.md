# Queue And Reliability

## 队列与并发

### 队列原则

- 一个 session 一条逻辑队列
- 一个 session 同时只有一个 worker 持锁执行
- 不同 session 的 run 可以并发

### 建议做法

- Redis list 或 stream 保存 session 队列
- Redis lock 控制 session 执行权
- PostgreSQL 记录 run 最终状态

### 为什么不用单纯数据库锁

只用 PostgreSQL 也能做，但会在以下方面更笨重：

- 高频调度效率低
- 分布式 worker 扩展不自然
- 实时队列可观测性差

## 取消、超时与失败恢复

### 取消

- 调用方可通过 API 取消 run
- worker 轮询取消标记
- 对 shell 子进程发送终止信号
- 对 MCP 调用和子流程做 best-effort cancellation

### 超时

需要区分：

- run 总超时
- 单次模型调用超时
- 单次工具调用超时

### 恢复

worker 重启后：

- 从 PostgreSQL 扫描 `running` 且长时间未 heartbeat 的 run
- 根据恢复策略标记为 `failed` 或重新排队
