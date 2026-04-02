# Runtime Design

运行时需要解决以下问题：

- 将调用方输入转成可执行的 run
- 保证 per-session 串行执行
- 自动发现 workspace 能力并构建上下文
- 将 LLM tool calls 映射到 Action、Skill、External Tool、Native Tool
- 统一处理超时、取消、日志、审计和事件流
- 将中心历史异步同步到 workspace 下的 `.openharness/data/history.db`

## 先用一句话理解 runtime

Runtime 负责把“调用方发来的一次请求”变成“一个可追踪、可恢复、可审计的 run 执行过程”。

如果你在看代码，这部分通常对应 orchestrator、context engine、tool dispatch、queue 和 audit 这些模块。

## 建议先看哪几页

### 想看主链路

1. [lifecycle.md](./lifecycle.md)
2. [context-engine.md](./context-engine.md)
3. [projection-and-executors.md](./projection-and-executors.md)

### 想看可靠性和治理

1. [queue-and-reliability.md](./queue-and-reliability.md)
2. [events-and-audit.md](./events-and-audit.md)
3. [hook-runtime.md](./hook-runtime.md)

### 想看执行环境

1. [execution-backend.md](./execution-backend.md)
2. [model-gateway.md](./model-gateway.md)

## 文档导航

- [lifecycle.md](./lifecycle.md)
- [context-engine.md](./context-engine.md)
- [projection-and-executors.md](./projection-and-executors.md)
- [model-gateway.md](./model-gateway.md)
- [hook-runtime.md](./hook-runtime.md)
- [execution-backend.md](./execution-backend.md)
- [queue-and-reliability.md](./queue-and-reliability.md)
- [events-and-audit.md](./events-and-audit.md)
