# Implementation Roadmap

本文件保留的是“最初的分阶段实施草案”，方便理解为什么代码结构会这样拆分。

如果你要判断“当前已经做到了什么、还缺什么”，请优先看站点内的 [当前进度](./project-roadmap.md)。后者对应仓库持续维护的现状台账；本文件更多用于解释原始实施顺序。

对于 worker 执行层、扩缩容、控制面与商业化治理的后续路线，请看专门维护的文档：

- [Runtime / Worker 执行层成熟化路线图](./runtime/worker-scaling-roadmap.md)

## 1. 当前目标

在可信内网 / 自有环境前提下，交付一个可用的 Agent Runtime 服务，满足：

- 多用户共享一个实例
- 多 workspace 自动发现本地能力
- Agent 可在 workspace 中执行 shell、文件操作、Action、Skill、Tool
- 提供 OpenAPI + SSE
- 具备基础审计、队列、取消和超时能力

补充：

- 上述目标中的大量能力已经落地
- 当前真正尚未补完的重点，主要集中在文档真值同步、heartbeat / worker 恢复、外部 caller context 接入收敛

## 2. 当前范围

### 2.1 包含

- TypeScript + Node.js 服务端骨架
- 调试用 `oah` CLI 基础骨架
- OpenAPI 3.1
- PostgreSQL + Redis 基础设施
- workspace / session / message / run 领域模型
- workspace 根目录 `AGENTS.md` 加载
- `.openharness/settings.yaml` 加载
- `.openharness/` 自动发现与校验
- 服务端配置文件加载
- AgentRegistry / ModelRegistry / ActionRegistry / SkillRegistry / ToolRegistry / HookRegistry
- 平台内建 agent 注册与装配
- LocalWorkspaceBackend
- per-session 串行调度
- SSE 事件流

### 2.2 不包含

- SandboxBackend
- 复杂 action DSL
- 多级 `AGENTS.md` 继承
- 图形化控制台
- 公网多租户零信任安全体系

## 3. 建议实施顺序

### Phase 1: 服务骨架

- 建立 monorepo 或 packages 结构
- 接入 OpenAPI 生成和校验
- 初始化 PostgreSQL 和 Redis
- 建立基础日志和错误处理
- 定义服务端配置文件结构

### Phase 2: 核心领域模型

- 实现 workspace / session / message / run 数据模型
- 提供创建 workspace、session、message、run 的 API
- 实现 run 状态机

### Phase 3: 队列与执行调度

- 实现 Redis session queue 和 session lock
- 实现 Orchestrator worker
- 实现取消、超时和 heartbeat

当前状态：

- `done` session queue / lock 主链路
- `done` 取消
- `done` run / tool timeout
- `done` heartbeat
- `partial` worker 启动恢复当前已支持 stale run fail-closed 回收，但尚未支持自动续跑

### Phase 4: Context Engine 与配置加载

- 实现 workspace 根目录扫描
- 实现服务端 `paths.chat_dir` 扫描
- 实现服务端 `paths.workspace_dir` 扫描
- 解析 `AGENTS.md`
- 加载平台内建 agent 注册表
- 解析 `.openharness/settings.yaml`
- 解析 `.openharness/agents/*.md`
- 解析 agent frontmatter、正文 prompt 与 `system_reminder`
- 实现 platform agent 与 workspace agent 的同名覆盖规则
- 解析 `mode`、`switch`、`subagents` 配置
- 解析 `.openharness/models/*.yaml`
- 解析 `.openharness/actions/*/ACTION.yaml`
- 解析 `.openharness/skills/*/SKILL.md`
- 解析 `settings.skill_dirs` 并扫描额外 skill 目录
- 实现 skill 同层冲突报错、跨层冲突 warning + 覆盖
- 实现 skill catalog 注入与 `Skill` 工具
- 解析 `.openharness/tools/settings.yaml`
- 发现 `.openharness/tools/servers/*`
- 解析 `.openharness/hooks/*.yaml`
- 实现 agent 切换检测，以及在最新 user message 上附加 `<system_reminder>`
- 实现 `agent.switch` 与 `agent.delegate` 的 allowlist 校验
- 实现 `agent.await` 与并发 subagent 调度
- 将 `paths.chat_dir` 下子目录自动注册为 `kind=chat` workspace
- 将 `paths.workspace_dir` 下子目录自动注册为 `kind=project` workspace

当前状态补充：

- `done` platform built-in agent 注册与同名覆盖规则
- `done` native tools 最小集
- `done` agent policy 中 `run_timeout_seconds`、`tool_timeout_seconds`、`parallel_tool_calls`
- `partial` subagent 并发治理仍有后续空间，尤其是恢复与一等父子 run 字段

### Phase 5: 执行器与调用分发

- 实现 LocalWorkspaceBackend
- 实现 NativeToolExecutor
- 实现 ActionExecutor
- 实现 SkillExecutor
- 实现 Tool Executor
- 实现 invocation projection 与 dispatcher

### Phase 6: 流式输出与前端接入协议

- SSE endpoint
- 事件协议
- 增量输出

### Phase 7: 调试 CLI / TUI

- 实现 `oah workspace list`
- 实现 `oah catalog show`
- 实现 `oah session chat`
- 实现 `oah action run`
- 实现 `oah model generate`
- 实现 `oah run inspect`
- 在上述 CLI 能力基础上实现 `oah tui`

### Phase 8: Hook 与治理能力

- Hook runtime
- capability 校验
- tool 审计
- policy deny 基础机制

## 4. 建议代码结构

```text
apps/
  server/
packages/
  api/
  core/
  orchestrator/
  context/
  agents/
  actions/
  skills/
  tools/
  hooks/
  execution/
  storage/
  events/
  sdk/
```

## 5. 技术选型建议

- Web framework：Fastify 或 Hono
- Validation：Zod 或 TypeBox
- OpenAPI：基于 schema 自动生成
- ORM / SQL：Drizzle ORM 或 Kysely
- Queue / Lock：Redis
- Logging：Pino
- Tracing：OpenTelemetry

## 6. 风险点

### 6.1 配置复杂度

如果 YAML DSL 一开始做太强，会拖慢整体交付。建议先坚持单入口 action 模型。

### 6.2 Hook 失控

Hook 如果能力边界过大，会让调试和安全控制都变差。建议当前阶段严格 capability 化。

### 6.3 本地执行风险

当前使用本地 backend，默认前提是可信内网环境。若后续对外开放，需优先补 sandbox backend。

### 6.4 Tool Server 不稳定性

外部 tool server 可能存在延迟、失败或协议兼容性问题，需要：

- 连接健康检查
- 调用超时
- 错误降级

## 7. 后续演进方向

- SandboxBackend
- workspace secrets 管理
- action workflow DSL / matrix / 重试 / loop / DAG 分支
- 多级 `AGENTS.md`
- 更细粒度权限策略
- 历史 run 回放
- 管理后台与配置校验工具

## 8. 交付建议

建议先以“单实例服务 + 单 worker 进程”跑通闭环，再扩展到：

- 多 worker
- 横向扩展
- 更强审计和 tracing

先确保系统抽象边界正确，再追求复杂部署形态。
