# 运行时设计

Runtime 将调用方请求转为可追踪、可恢复、可审计的 run 执行过程。

核心职责：输入 → 队列 → 上下文构建 → LLM loop → tool dispatch → 结果输出。

## 按目标阅读

### 主链路

1. [lifecycle.md](./lifecycle.md) — run 生命周期与状态流转
2. [context-engine.md](./context-engine.md) — 上下文装配
3. [message-projections.md](./message-projections.md) — 消息分层与投影
4. [projection-and-executors.md](./projection-and-executors.md) — 能力注册与执行器

### 可靠性与治理

1. [queue-and-reliability.md](./queue-and-reliability.md) — 队列、锁与故障恢复
2. [worker-control-plane.md](./worker-control-plane.md) — worker 调度、扩缩容与恢复控制面
3. [events-and-audit.md](./events-and-audit.md) — SSE 事件流与审计
4. [hook-runtime.md](./hook-runtime.md) — Hook 系统

### 执行环境

1. [execution-backend.md](./execution-backend.md) — 执行后端抽象
2. [model-gateway.md](./model-gateway.md) — 内部模型网关
