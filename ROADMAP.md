# Open Agent Harness Roadmap

本文件不再维护“全量愿望清单”，而是只记录四类信息：

- 当前仓库状态下的实现真值
- 已经收口的高优先级事项
- 明确延期的候选演进项
- 后续更推荐的开发顺序

## 主结论

- 当前仓库已经具备一个可运行、可扩展、边界相对清晰的 headless agent runtime。
- 设计文档中的近期核心能力已经大体落地，不再属于“大量功能缺失”的阶段。
- 后续剩余工作主要是少数明确延期的演进项，而不是必须立刻补齐的通用 P0 / P1 缺口。
- `ROADMAP.md` 的职责不再是罗列“还没做的所有东西”，而是记录当前真值、延期项和下一阶段顺序。

## 当前仓库状态

结合 [docs/architecture-overview.md](./docs/architecture-overview.md)、[docs/api-design.md](./docs/api-design.md)、[docs/runtime/queue-and-reliability.md](./docs/runtime/queue-and-reliability.md)、[docs/storage-design.md](./docs/storage-design.md) 和当前代码，可以把现状概括为：

- `done` `workspace / session / message / run` 主链路已稳定
- `done` SSE 事件流、run step 审计、tool call 审计已可用
- `done` native tools 最小集已落地，并受 workspace root 边界约束
- `done` platform built-in agent registry 与覆盖规则已落地
- `done` `parentRunId`、`heartbeatAt` 与 stale run fail-closed recovery 已落地
- `done` host-injected caller context 接入点已存在；standalone server 默认注入最小 caller context，本地调试不再依赖额外 token 鉴别
- `done` internal model gateway 已按 loopback-only 收敛
- `partial` 文档整体已大幅对齐，但仍需要保持“实现变更即同步文档”的纪律

## 状态分层

### 已实现

- `done` 运行时策略补齐
  - `run_timeout_seconds`
  - `tool_timeout_seconds`
  - `parallel_tool_calls`
- `done` hook `command` / `http` / `prompt` / `agent` 的超时与失败通知已落地
  - hook 失败不会阻断 run
  - 但会显式发出超时或失败事件
- `done` platform agent 注入式 registry、同名覆盖规则、catalog `source` 已落地
- `done` native tools 最小集已落地
  - `shell.exec`
  - `file.read`
  - `file.write`
  - `file.list`
- `done` external caller context resolver 已落地；未注入 resolver 时 standalone server 会提供最小 caller context
- `done` `parentRunId`、`heartbeatAt` 已成为当前 run 模型的一等字段
- `done` worker 启动时 stale `running` / `waiting_tool` run 的 fail-closed 回收已落地
- `done` internal model gateway 当前真值是 loopback-only，而不是公网 API 能力

### 部分实现，但不是当前最高优先级

- `partial` 分布式恢复当前采取保守策略
  - stale run 会回收为 `failed`
  - 还没有自动重新入队 / 自动续跑
- `partial` 单次模型调用超时还没有形成独立、完整的通用恢复语义
  - 当前主模型链路仍主要受 run 总超时约束
- `partial` 文档已大体对齐当前实现
  - 但后续仍需持续同步 OpenAPI 与设计页，避免再次漂移

### 明确延期的候选项

- `deferred` 自动重新入队 / 自动续跑
- `deferred` `action_run` 升格为一等实体
- `deferred` `artifact` 升格为一等实体
- `deferred` internal model gateway 改为 Unix socket
- `deferred` Sandbox backend、workflow DSL、workspace secrets 等长期项继续保留为未来方向，不进入近期承诺

## 边界固定项

OAH 是 runtime，不是 IAM / auth / approval system。

当前不做，后续也不纳入 OAH 范围：

- 用户登录
- 用户系统、组织与成员关系
- workspace 授权判定
- `workspaceAccess = []` 的授权解释
- 审批流 / 人工审核机制
- 角色权限模型

OAH 当前只负责：

- 消费外部宿主服务传入的 caller context
- 在该前提下执行 runtime、调度、审计与事件流

需要特别区分：

- 不做“鉴权 / 审批”，不等于不做“审计”
- run / tool / hook / step 的结构化记录仍然是 OAH 的系统内能力，不应被移除或弱化

## 下一阶段建议

结合当前实现状态，下一阶段更推荐做“稳态增强”，而不是继续引入更多新名词。

### 1. 先定义自动恢复 / 自动重试的幂等边界

- 先明确哪些 action / tool / 执行路径允许安全重试
- 先明确哪些副作用必须避免重复执行
- 在规则没有写清之前，不建议直接实现自动续跑

原因：

- 当前 fail-closed recovery 是安全的
- 直接自动续跑会引入重复写文件、重复外部调用、重复任务执行等副作用风险

### 2. 再评估自动重新入队 / 自动续跑

- 只有在幂等与副作用边界明确后，再评估是否继续做自动恢复
- 这一步应被视为“可靠性增强项目”，而不是默认必做项

### 3. 然后优先考虑 `action_run`

- 如果后续要增强审计、后台任务管理或前端可观测性，优先考虑把 `action_run` 升格为一等实体
- 相比之下，`action_run` 比 `artifact` 更贴近当前执行主链路

### 4. `artifact` 放在 `action_run` 之后

- 只有在产物模型、存储策略、展示需求已经明确后，再考虑把 `artifact` 升格
- 在此之前，避免为了数据模型完整性而过早扩展实体

### 5. Unix socket 只在 loopback HTTP 真的成为问题后再做

- 当前 loopback-only 已经满足本地内部调用边界
- 只有当性能、隔离或部署需求证明 loopback HTTP 不够用时，再考虑 Unix socket

### 6. 文档策略改为“跟随实现”

- 每次新增能力时，同步更新对应 OpenAPI 与设计文档
- 每次调整系统边界时，同步更新 `ROADMAP.md`
- 不再把设计文档写成明显领先于实现的未来态承诺

## 推荐开发顺序

如果从当前状态继续开发，推荐按下面顺序推进：

1. 定义哪些 action / tool / 执行路径允许自动恢复或自动重试
2. 只在规则明确后，再评估自动重新入队 / 自动续跑
3. 优先决定是否把 `action_run` 升格为一等实体
4. 视真实产品需求决定是否升格 `artifact`
5. 只有 loopback HTTP 真成瓶颈时，再把 internal model gateway 收到 Unix socket
6. 所有后续实现都同步更新 OpenAPI 与对应设计文档

## 当前不建议优先做的事

- 不建议在没有幂等语义前提下直接做自动续跑
- 不建议为了“技术上更完整”立即切到 Unix socket
- 不建议把授权判定、审批流或权限模型拉回 OAH 内部
- 不建议为了数据模型完整性而过早把所有候选实体都升格

## 已确认决策

- hook `prompt` / `agent` 超时后，run 继续，但必须显式告知 hook 超时或失败
- workspace 访问授权由外部服务 / API Gateway 负责，不在 Open Agent Harness 内实现
- OAH 后续不做用户鉴权、权限审核、审批机制
- 平台内建 agent 第一版采用代码内建 registry，由服务启动时自动注入
- native tools 按 `shell.exec`、`file.read`、`file.write`、`file.list` 全量最小集推进
- internal model gateway 近期先收敛为 loopback-only，不立即切 Unix socket
- `action_run` / `artifact` 暂不升格为近期正式实体
