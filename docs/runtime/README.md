# Runtime Design

运行时需要解决以下问题：

- 将调用方输入转成可执行的 run
- 保证 per-session 串行执行
- 自动发现 workspace 能力并构建上下文
- 将 LLM tool calls 映射到 Action、Skill、MCP、Native Tool
- 统一处理超时、取消、日志、审计和事件流

## 文档导航

- [lifecycle.md](./lifecycle.md)
- [context-engine.md](./context-engine.md)
- [projection-and-executors.md](./projection-and-executors.md)
- [hook-runtime.md](./hook-runtime.md)
- [execution-backend.md](./execution-backend.md)
- [queue-and-reliability.md](./queue-and-reliability.md)
- [events-and-audit.md](./events-and-audit.md)
