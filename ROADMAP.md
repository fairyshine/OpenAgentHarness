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
- `done` 存储主模式已收敛为双模
  - 配置 PostgreSQL 时，连接失败直接报错，不再静默退回内存
  - 未配置 PostgreSQL 时，运行时数据改为落到每个 workspace 的 SQLite `history.db`
- `done` workspace 同步已改为启动期 + 后台 watcher，不再在请求链路里临时同步
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
- `deferred` `RuntimeService` 继续按方案 B 拆分为 `WorkspaceService` / `SessionRunService` / `RuntimeExecutionEngine`
  - 当前先保持现有行为稳定
  - 后续再评估是否进一步进入更激进的方案 C
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

## 全局规划

接下来的 roadmap 以“全局主线”组织，而不是把不同主题混成一条线性待办。

核心目标只有两条：

- 保持 OAH 作为 headless runtime 的业务真值稳定，不因为扩功能而让边界变模糊
- 把执行层从“当前可用”推进到“适合 Kubernetes 生产部署”的形态

为此，后续工作按两条主线并行推进：

- `Track A` 运行时语义与领域模型
- `Track B` 执行层、部署形态与 worker 控制面

所有后续实现都遵循同一原则：

- 先收敛边界，再增加复杂度
- 先保证安全和可解释性，再追求更强恢复和更高吞吐
- 文档必须跟随实现，不再长期维持“文档领先代码”的未来态描述

## 全局架构方向

下面这些已经属于收口决策，而不是开放问题。

### 产品与部署边界

- OAH 仍然是 runtime，不负责用户系统、组织体系、审批流和权限模型
- 生产环境以 Kubernetes 为前提，长期推荐形态是拆分式部署，而不是单 Pod 全量打包
- 推荐的生产工作负载为：
  - `oah-api-server`
  - `oah-worker`
  - `oah-worker-controller`
- 单 Pod 内同时运行 `api-server + worker + controller` 继续保留为开发 / PoC / 最小化部署能力，但不作为正式生产推荐路径
- `history mirror sync` 不再属于后续主线规划，也不再作为 worker 的职责

### API Server 与 Embedded Worker

- `api-server` 必须保留通过 `embedded worker` 独立完成最小业务闭环的能力
- 这个能力主要服务于本地开发、单机部署、调试、PoC 和故障兜底
- 生产 split 模式下，`api-server` 应默认以 `api-only` 角色工作
- 生产环境中，`api-server` 的 `embedded worker` 不应作为主要执行池

### Worker 体系方向

- `embedded worker` 与 `standalone worker` 继续并存
- 两者不是两套独立产品，而是同一套 worker runtime 的两种 host mode
- `packages/runtime-core` 继续作为业务执行内核，负责 `processQueuedRun`、`recoverStaleRuns`、run 状态机、agent coordination、tool execution 等业务语义
- 后续应补出一层宿主无关的 worker lifecycle 抽象，但这首先是逻辑边界提炼任务，不强制等同于立即新建 package
- `worker` 的系统定位不再只是“队列消费者”，而是“执行宿主”
- 一个 `worker pod` 可以承载多个逻辑执行槽位 `execution slot`
- 一个 slot 在任意时刻只处理一个 session / run，但一个 worker pod 可以并发处理多个 run，包括 subagent child session

### Workspace Materialization 方向

- 生产环境下，worker 需要把多个 workspace 的内容通过挂载和从 OSS materialize 到容器本地后再执行
- 因此 worker 需要同时承担执行职责和环境职责：
  - 消费 queue、执行 run、上报 heartbeat、参与 drain
  - 拉取 / 复用 / 清理 workspace 本地副本
- workspace materialization 应按 `workspace + version/snapshot` 建模，而不是按单次 run 建模
- 同一个 worker pod 内多个 slot 访问同一 workspace 版本时，应优先复用同一份本地 materialized 副本，避免重复从 OSS 拷贝
- 需要显式处理并发 materialization、缓存复用、回收策略和失败重试，避免多个 run 同时竞争同一份本地目录
- OSS 作为持久化真值；worker 本地副本是带租约的可写工作副本
- 需要引入 `workspace lease / owner worker / lastActivityAt / dirty` 等状态
- 同一个 workspace 在被某个 worker 租约持有期间，后续 run 应优先调度到该 owner worker；这首先是 locality/sticky dispatch 优化，在存在本地写入时也会影响一致性
- 同一个 workspace 的 child session 若使用相同 workspace，应优先复用同 pod 的本地副本，不要求必须同 slot
- 同步回 OSS 的时机不按“每个 run 结束立即回写”设计，而按 `dirty + idle flush + eviction + drain` 设计
- 当 workspace 一段时间没有新的活动时，应先 flush 回 OSS，再释放租约并清理本地副本
- 这里的“活动”不只包含前端请求，还包含 run、child session、API 文件操作和 agent/tool 引发的本地写入
- 用户通过 API 直接操作 workspace 文件时，若该 workspace 正被 worker 持有，应优先把写请求路由到 owner worker，而不是绕过本地副本直接改 OSS

### Worker 控制面方向

- worker 副本数由 OAH 自己决策
- Kubernetes 负责 Pod 生命周期、调度、重建与漂移修复
- OAH `worker-controller` 负责读取执行层状态、计算目标副本数，并直接改写目标 workload 的 `replicas`
- 同一个 worker workload 不应同时由 OAH controller 和 HPA / KEDA 共同决定副本数
- controller 的抽象应按 `worker pool -> desiredReplicas` 设计，即使第一版只先落一个 pool
- controller 的容量模型不应只看 worker pod 数，还应看每个 pod 的 slot 容量、busy slot、idle slot 和 workspace materialization 压力
- controller 负责容量与副本数，不负责把单个 run 精确分配到某个 pod
- run 到具体 worker 的选择，先按轻量的 `workspace affinity / sticky dispatch` 实现，不提前演化成中心化 scheduler

## 主线规划

### Track A: 运行时语义与领域模型

这条主线关注的是“系统做什么”和“哪些行为是安全的”。

#### A1. 自动恢复 / 自动重试的幂等边界

- 先定义哪些 action / tool / 执行路径允许安全重试
- 先明确哪些副作用必须避免重复执行
- 在规则没有写清之前，不直接实现自动续跑

当前判断：

- 当前 fail-closed recovery 是安全的
- 自动重新入队 / 自动续跑属于可靠性增强项，不是近期默认必做项

#### A2. 执行域模型的后续扩展

- 若后续要增强审计、后台任务管理或前端可观测性，优先评估 `action_run`
- `artifact` 放在 `action_run` 之后再评估
- 这两项都不应为了“模型看起来完整”而提前升格

#### A3. 文档真值与接口同步

- 每次新增能力都同步更新 OpenAPI 与对应设计文档
- 每次系统边界调整都同步更新 `ROADMAP.md`
- 文档描述必须跟随真实实现，而不是长期领先代码
- 与 `history mirror sync` 相关的设计和实现说明不再进入后续增强范围

#### A4. Internal model gateway 的后续收敛

- 当前 loopback-only 已满足内部调用边界
- 只有当性能、隔离或部署需求证明 loopback HTTP 不够用时，再评估 Unix socket

### Track B: 执行层、部署形态与 Worker 控制面

这条主线关注的是“系统怎么跑”“怎么部署”“怎么扩缩容”。

#### B1. 统一 Worker Runtime

目标：

- 明确 `embedded` 与 `standalone` 只是 host mode，不再允许行为语义漂移
- 提炼统一的 worker lifecycle 接口和状态模型
- 统一 queued run 处理、recover、cancel、timeout、heartbeat、drain 的调用路径
- 把 `worker pod`、`execution slot`、session 串行语义之间的关系定义清楚

要求：

- `apps/server/src/bootstrap.ts` 逐步退回装配层
- worker 内部策略不再继续堆在 `bootstrap` 中

#### B2. 收敛 Redis 执行层适配器

目标：

- `packages/storage-redis` 只保留 Redis queue、session lock、worker registry、pressure inspection 等基础设施职责
- 避免把业务执行语义和 Redis 数据结构细节继续耦合在同一个大类里
- 合并现有两条执行层分支能力，而不是二选一：
  - subagent priority / reserved capacity / ready queue wait time
  - worker registry / lease / global worker visibility

#### B3. 引入 Workspace Materialization 与缓存层

目标：

- 为 worker 增加 workspace materialization 能力，使其可从 OSS 或挂载源准备本地执行目录
- 明确本地副本的 key、版本、目录结构、锁和回收策略
- 明确同一 worker pod 内 slot 之间如何共享 workspace 副本
- 把 materialization 生命周期与 worker lifecycle、drain、Pod 退出行为对齐
- 明确 workspace 从本地副本同步回 OSS 的时机和状态机
- 明确 worker 本地副本、OSS 真值和 API 文件操作之间的一致性规则

要求：

- materialization 必须具备并发保护，避免同一 workspace 版本被重复拉取
- materialization 失败需要可诊断，并能安全失败闭合
- 本地缓存回收不能破坏正在执行的 run
- 必须引入 `workspace lease`，避免多个 worker 同时把同一个可写副本当作活动真值
- 必须区分 `clean` 与 `dirty` 副本，并记录 `lastActivityAt`
- idle flush、drain flush、eviction flush 都需要明确可观测状态和失败处理
- API 文件写入不能绕过 owner worker 直接破坏本地副本一致性

#### B4. 固化生产部署形态

目标：

- 新增或补全 standalone worker 入口
- 让 `api-server`、`worker`、`worker-controller` 成为清晰分离的部署单元
- 保持 `api-server` 仍然可通过 embedded worker 单独闭环，但不让该路径主导生产执行流量
- 让 worker 部署显式包含 workspace materialization 所需的卷、挂载点和本地缓存目录

#### B5. 引入 OAH 自管的 Worker Controller

目标：

- `worker-controller` 只做控制面，不执行 run
- 它负责读取 backlog、等待时长、worker heartbeat、busy/idle/stale worker、busy/idle slot、subagent backlog、workspace materialization 压力等信号
- 它负责计算 `desiredReplicas`
- 它通过 Kubernetes API 改写目标 worker workload 的副本数

控制面要求：

- 支持 cooldown
- 支持 hysteresis
- 支持 min / max replicas
- 支持 leader election
- 记录 scale reason
- 支持把 `workspace locality`、owner worker 热度和 materialization 成本作为扩容参考信号，但不承担中心化 run placement

#### B6. 完成优雅缩容和生产可观测性

目标：

- worker 接收 `SIGTERM` 后进入 `draining`
- draining worker 不再 claim 新任务，也不再开始新的 workspace materialization
- 正在执行的 run 尽量跑完，或在超时后安全回队 / fail-closed
- 输出结构化扩缩容事件、drain 事件、slot 使用情况、materialization 事件和 controller 决策原因
- 对仍被租约持有且 `dirty` 的 workspace，在缩容前完成 flush 或失败闭合处理

约束：

- 在 drain contract 和 graceful shutdown 没有完成前，不应让 controller 自动缩容
- 如果 controller 提前落地，第一阶段最多只允许扩容，不允许自动缩容

## 近期实施顺序

下面的顺序以“全局规划”为主，而不是只反映某一个子系统。

### Phase 1: 收敛执行层边界

- 提炼统一 worker runtime 的逻辑边界
- 明确 embedded / standalone 的共享语义
- 明确 `worker pod`、`execution slot`、session 串行语义的关系
- 让 `bootstrap` 逐步回到装配层
- 开始拆出 Redis adapter 与业务执行语义的边界

交付标准：

- `embedded worker` 与 `standalone worker` 的主执行语义一致
- slot 级并发模型和 session 级串行边界清晰
- `bootstrap` 不再继续增长 worker 内部策略复杂度

当前落点：

- `done` 统一 worker runtime control 已接入 `apps/server` 装配层
- `done` `embedded worker` / `standalone worker` 已共用一套 slot / session 串行语义
- `done` Redis pool snapshot 已显式暴露 local slots、busy/idle slots 与 session 串行边界
- `partial` `bootstrap` 已开始回退到装配层，但 standalone worker 独立入口仍在 Phase 4 完成

### Phase 2: 统一 Redis 执行层能力

- 合并 queue、registry、pool stats、diagnostics、priority、reserved capacity、wait-time signals 等现有分支能力
- 为 slot 容量、slot 占用和 subagent 压力定义统一观测口径
- 统一 health report 输出
- 统一测试基线

交付标准：

- Redis 执行层的对外结构稳定
- health report 能同时解释局部 worker 状态和全局执行压力

当前落点：

- `done` subagent priority、reserved capacity、ready wait time、worker registry 已合并到同一套 Redis 执行层
- `done` queue pressure、global worker load、recent decisions、health/readiness contract 已统一
- `done` slot / lease 现已暴露当前 `session`、`run`、`workspace` 上下文
- `done` 已补出纯读模型的 worker affinity summary，为后续 sticky dispatch / owner worker 路由准备输入
- `next` 下一步进入 Phase 3 前，优先把这套 affinity 读模型接到 workspace lease / materialization 设计上，而不是直接引入中心化调度器

### Phase 3: 引入 Workspace Materialization

- 为 standalone worker 补齐从 OSS / 挂载源准备 workspace 的能力
- 增加 workspace 本地缓存、并发保护和回收策略
- 明确 worker pod 内多个 slot 对 workspace 副本的共享方式
- 明确 `workspace lease / owner worker / dirty / lastActivityAt`
- 明确 idle flush、eviction、drain flush 的触发时机
- 明确 API 文件写如何路由到 owner worker

交付标准：

- worker 可以稳定准备多个 workspace 的本地执行目录
- 不会因为并发 run / child session 重复拉取同一 workspace 版本
- workspace 空闲后可以安全 flush 回 OSS 并回收本地副本
- API 文件写不会绕过本地活动副本造成状态分叉

当前落点：

- `started` 已新增 workspace materialization manager 基础组件
- `done` 对象存储来源的 workspace 副本现在具备进程内并发复用能力
- `done` 本地副本已具备 `dirty` 标记、idle flush、idle eviction 和 close flush 语义
- `done` queued run 执行现在已经通过 execution workspace lease 切换到 materialized 本地副本目录
- `done` 无 `externalRef` 的 workspace 当前可先走本地目录直通，便于保持开发模式兼容
- `partial` 当前 dirty 判定先走保守策略：可写 project run 结束时默认把 lease 作为 `dirty` 释放
- `next` 下一步优先把 API 文件写与 owner worker / execution lease 对齐，并继续细化 dirty 判定，避免长期依赖保守 flush

### Phase 4: 固化生产部署骨架

- 补全 `apps/worker`
- 让 `api-server` / `worker` / `worker-controller` 的角色、启动方式和部署清单更清晰
- 明确生产 split 模式下 `api-server` 默认 `api-only`
- 明确 worker 所需卷、挂载、临时目录和缓存目录

交付标准：

- 生产部署骨架清晰
- 开发闭环能力与生产执行形态不再混淆

### Phase 5: 引入 Worker Controller

- 新增 `worker-controller`
- 先按 `worker pool -> desiredReplicas` 抽象设计
- 第一版优先解决扩容、leader election、cooldown、scale reason
- controller 决策口径同时考虑 pod 数和 slot 容量
- 后续补入 workspace affinity / sticky dispatch 所需的观测信号，但不升级为中心化 scheduler

交付标准：

- OAH 可以在 K8S 中独立决定 worker 副本数
- 同一 worker workload 不再同时受多个 autoscaler 控制

### Phase 6: 完成自动缩容与优雅下线

- 完成 draining、graceful shutdown、缩容保护和回队/失败收敛语义
- 让 controller 安全开启自动缩容
- 补齐结构化 scale/drain/materialization diagnostics

交付标准：

- 缩容不再依赖“直接杀 Pod”
- 生产排障时可以解释“为什么扩容、为什么没扩容、为什么缩容”

### Phase 7: 回到领域增强项

- 只在幂等边界明确后，再评估自动重新入队 / 自动续跑
- 视真实需求再决定 `action_run` / `artifact`
- 只有 loopback HTTP 真成为问题后，再评估 Unix socket

交付标准：

- 领域增强项建立在稳定执行层之上，而不是与执行层演进互相抢优先级

## 近期推荐的代码结构收敛方向

在不强制立即大规模重命名的前提下，推荐逐步收敛到下面的职责划分：

- `packages/runtime-core`
  - 保持业务运行时内核定位
- `worker-core`
  - 先作为逻辑层目标，不要求第一步就物理拆包
  - 承载通用 worker lifecycle 与 host-agnostic runtime
- `workspace-materialization`
  - 先作为逻辑层目标
  - 承载 OSS 拉取、挂载适配、本地缓存、并发保护、lease、flush 和回收语义
- `packages/storage-redis`
  - 只保留 Redis adapter、queue、lock、registry、pressure inspection、slot/pressure 指标读取
- `apps/server`
  - 作为 API server 和 embedded host 装配层
- `apps/worker`
  - 作为 standalone worker 入口
  - 负责装配 worker runtime 与 workspace materialization 能力
- `apps/worker-controller`
  - 作为独立控制面入口

## 当前不建议优先做的事

- 不建议在没有幂等语义前提下直接做自动续跑
- 不建议为了“技术上更完整”立即切到 Unix socket
- 不建议把授权判定、审批流或权限模型拉回 OAH 内部
- 不建议为了数据模型完整性而过早把所有候选实体都升格
- 不建议继续把 `history mirror sync` 作为 worker 或执行层的后续职责推进
- 不建议把生产长期形态继续建立在“单 Pod 同时运行全部组件”之上
- 不建议让 `embedded worker` 和 `standalone worker` 分叉成两套长期独立实现
- 不建议在没有 drain 语义和 leader election 的情况下直接上线自研 autoscaling
- 不建议让 OAH controller 与 HPA / KEDA 同时共同决定同一个 worker workload 的副本数
- 不建议继续把 `worker` 只当作“单 run 队列消费者”来建模
- 不建议把 workspace materialization 按单次 run 临时处理而不做版本、锁和缓存设计
- 不建议把 workspace 同步回 OSS 设计成“每个 run 结束立即回写”
- 不建议在存在活动本地副本时让 API 文件写直接绕过 owner worker 修改 OSS
- 不建议过早把 workspace locality 做成重型中心化 scheduler

## 已确认决策

- hook `prompt` / `agent` 超时后，run 继续，但必须显式告知 hook 超时或失败
- workspace 访问授权由外部服务 / API Gateway 负责，不在 Open Agent Harness 内实现
- OAH 后续不做用户鉴权、权限审核、审批机制
- 平台内建 agent 第一版采用代码内建 registry，由服务启动时自动注入
- native tools 按 `shell.exec`、`file.read`、`file.write`、`file.list` 全量最小集推进
- internal model gateway 近期先收敛为 loopback-only，不立即切 Unix socket
- `action_run` / `artifact` 暂不升格为近期正式实体
- 生产环境主形态采用 Kubernetes 下的拆分式部署，而不是单 Pod 全量打包
- `api-server` 必须保留通过 `embedded worker` 独立完成最小业务闭环的能力
- 生产 split 模式下，`api-server` 默认承担 `api-only` 角色
- `embedded worker` 与 `standalone worker` 继续并存，但必须共用一套底层 worker runtime
- `packages/runtime-core` 继续作为 worker 业务执行内核；后续补出宿主无关的 worker lifecycle 抽象
- `worker` 的系统定位是执行宿主；一个 worker pod 可以承载多个 execution slot，并并发处理多个 run / child session
- 生产 worker 需要具备 workspace materialization、本地缓存和副本复用能力
- OSS 是 workspace 的持久化真值；worker 本地副本是带租约的可写工作副本
- workspace 空闲一段时间后，应 flush 回 OSS、释放租约并清理本地副本
- workspace 被 lease 持有期间，后续 run 和 API 文件写都应优先路由到 owner worker
- `history mirror sync` 不再作为 worker 职责，也不再进入后续主线规划
- worker 副本数由 OAH `worker-controller` 决策，并由它直接调用 Kubernetes API 调整 `replicas`
