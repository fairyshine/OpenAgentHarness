# Engine 设计

Agent Engine 将调用方请求转为可追踪、可恢复、可审计的 run 执行过程。

这里的 `Engine` 指执行与编排系统；`Runtime`、`Spec` 的边界见 [../terminology.md](../terminology.md)。

核心职责：输入 → 队列 → 上下文构建 → LLM loop → tool dispatch → 结果输出。

## 按目标阅读

### 主链路

1. [lifecycle.md](./lifecycle.md) — run 生命周期与状态流转
2. [context-engine.md](./context-engine.md) — 上下文装配
3. [message-projections.md](./message-projections.md) — `Message / EngineMessage / ChatMessage` 分层、projection、compact 语义
4. [projection-and-executors.md](./projection-and-executors.md) — 能力注册与执行器

### 可靠性与治理

1. [queue-and-reliability.md](./queue-and-reliability.md) — 队列、锁与故障恢复
2. [worker-control-plane.md](./worker-control-plane.md) — worker 调度、扩缩容与恢复控制面
3. [events-and-audit.md](./events-and-audit.md) — SSE 事件流与审计
4. [hook-runtime.md](./hook-runtime.md) — Hook 系统
5. [worker-scaling-roadmap.md](./worker-scaling-roadmap.md) — worker 执行层成熟化路线图

### 执行环境

1. [execution-backend.md](./execution-backend.md) — 执行后端抽象
2. [model-runtime.md](./model-runtime.md) — 内部模型运行时
