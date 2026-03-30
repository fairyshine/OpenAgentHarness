# Open Agent Harness

基于 https://github.com/vercel/ai 的 大模型 Agent Harness系统/运行时。

它只是一个服务端应用，没有UI，支持大量用户并发使用/多个workspace。

具体设计可以参考 https://opencode.ai/docs/zh-cn 文档 和 https://github.com/fairyshine/OpenBunny 的AI服务层 和 https://github.com/openclaw/openclaw 。



这个服务，支持开发者：

- 编写各种agent模式（vibe coding常用的build,plan；learning常用的plan,learn,eval）
- 编写各种agent actions，执行具体设定好的一系列固定程序（类似github actions）
- 写各种hooks，在会话的各个阶段执行对应命令

这个服务，支持用户：

- 在一个workspace文件夹下和llm agent对话
- 在workspace目录下执行系统shell命令
- 调用MCP工具
- 使用SKills技能
- 支持自定义项目级别AGENTS.md

