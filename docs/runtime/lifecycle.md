# Run Lifecycle

## 主要阶段

1. 接收请求
2. 持久化 message
3. 创建 run
4. 入 session 队列
5. 获取 session 锁
6. 构建上下文
7. 执行 hook
8. 启动 LLM loop
9. 分发 tool call
10. 汇总结果并输出
11. 更新 run 状态
12. 发布 SSE 事件

## 状态流转

建议的 `run.status`：

- `queued`
- `running`
- `waiting_tool`
- `completed`
- `failed`
- `cancelled`
- `timed_out`

## Agent Control Flow

同一 run 内允许出现两类 agent 控制动作：

- `agent.switch`
  - 在当前 run 内切换 `effective_agent_name`
- `agent.delegate`
  - 在后台创建子 session / 子 run 调用 subagent

建议约束：

- `agent.switch` 不创建新的主 run
- `agent.delegate` 创建新的子执行单元，但当前主 run 可继续或等待结果
- 两者都必须经过 orchestrator 校验 allowlist 和 policy
- `agent.delegate` 默认异步后台执行
- 同一父 run 可同时发起多个 subagent 任务
- 若未配置 `policy.max_concurrent_subagents`，默认不限制并发数量
- subagent 默认不得继续调用 `agent.delegate`
