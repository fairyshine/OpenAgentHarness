# 服务端配置

配置文件格式：YAML，默认文件名 `server.yaml`。

---

## 最小配置

```yaml
server:
  host: 0.0.0.0          # 监听地址
  port: 8787              # 监听端口

storage: {}
  # postgres_url: ${env.DATABASE_URL}   # 可选；省略时回退到本地 SQLite shadow 存储
  # redis_url: ${env.REDIS_URL}         # 可选；省略时 run 在 API 进程内直接执行

sandbox:
  provider: embedded                  # embedded | self_hosted | e2b
  # fleet:
  #   min_count: 1
  #   max_count: 32
  #   warm_empty_count: 1
  #   resource_cpu_pressure_threshold: 0.8
  #   resource_memory_pressure_threshold: 0.8
  #   max_workspaces_per_sandbox: 32
  #   ownerless_pool: shared          # shared | dedicated
  # self_hosted:
  #   base_url: http://oah-sandbox:8787/internal/v1
  # e2b:
  #   base_url: https://api.e2b.dev
  #   api_key: ${env.E2B_API_KEY}

paths:
  workspace_dir: /srv/openharness/workspaces       # project workspace 根目录
  runtime_state_dir: /srv/openharness/.openharness  # 运行时私有状态目录
  runtime_dir: /srv/openharness/runtimes        # workspace runtime 目录
  model_dir: /srv/openharness/models               # 平台模型目录
  tool_dir: /srv/openharness/tools                 # 公共 tool 目录
  skill_dir: /srv/openharness/skills               # 公共 skill 目录

workers:
  embedded:
    min_count: 2                # API + embedded worker 模式下的最小 worker 数
    max_count: 4                # backlog 增长时允许自动扩到的上限
    scale_interval_ms: 1000     # 扩缩容检查周期
    idle_ttl_ms: 30000          # 多余 worker 空闲多久后回收
    scale_up_window: 2          # 连续多少个周期都高压后才扩容
    scale_down_window: 2        # 连续多少个周期都空闲后才缩容
    cooldown_ms: 1000           # 两次扩缩容动作之间的最短冷却时间
    reserved_capacity_for_subagent: 1  # 为子代理任务保留的最小空闲容量

llm:
  default_model: openai-default   # 默认模型名（须存在于 model_dir）
```

> **info**
> 支持 `${env.VAR_NAME}` 语法引用环境变量。

> **tip**
> `storage.postgres_url` 和 `storage.redis_url` 都不是强制项。省略 PostgreSQL 时会使用本地 SQLite shadow 存储；省略 Redis 时，run 会在当前 API 进程内串行执行。

---

## 配置字段

### `server`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `host` | string | `127.0.0.1` | 监听地址 |
| `port` | number | `8787` | 监听端口 |

### `storage`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `postgres_url` | string | 否 | PostgreSQL 连接串；未指定 `serviceName` 的 workspace 会直接使用该库，指定 `serviceName` 后默认库只保留 workspace/session/run 索引，业务真值会路由到同前缀的派生库（如 `OAH-acme`）。省略时回退到本地 SQLite shadow 存储 |
| `redis_url` | string | 否 | Redis 连接串，用于队列、锁、限流、SSE 事件分发 |

> **tip**
> 不配置 PostgreSQL 时，workspace/session/run 的持久化会回退到本地 SQLite shadow；适合单机开发，不适合作为多实例共享事实源。

> **tip**
> 不配置 Redis 时，Run 会在 API 进程内直接执行（适合本地开发）。配置 Redis 后支持多实例 Worker 消费队列。

### `object_storage`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 当前仅支持 `s3` 兼容对象存储 |
| `bucket` | string | 目标 bucket |
| `region` | string | 对象存储 region |
| `endpoint` | string | 可选，自定义 S3/OSS/MinIO endpoint |
| `access_key` | string | 可选，访问凭证 |
| `secret_key` | string | 可选，访问凭证 |
| `session_token` | string | 可选，临时凭证 |
| `force_path_style` | boolean | 是否强制 path-style URL |
| `workspace_backing_store.enabled` | boolean | 是否启用受管 workspace 的对象存储 backing store；启用后 active workspace 只在 idle / drain / delete 时 flush 回对象存储 |
| `workspace_backing_store.key_prefix` | string | workspace backing store 对应的对象存储 key prefix |
| `mirrors.paths` | string[] | 只读镜像前缀列表，支持 `runtime / model / tool / skill` |
| `mirrors.sync_on_boot` | boolean | 是否在启动时把 mirrors 管理的前缀从对象存储拉到本地 |
| `mirrors.sync_on_change` | boolean | 是否轮询同步 mirrors 管理的只读前缀。不会对 active workspace 做实时回写 |
| `mirrors.poll_interval_ms` | number | mirrors 轮询周期 |
| `mirrors.key_prefixes.*` | object | 各只读镜像前缀对应的对象存储 key prefix |
| `managed_paths` / `key_prefixes.*` / `sync_on_*` | legacy | 兼容旧配置；建议迁移到 `workspace_backing_store` 和 `mirrors`，加载时会发出弃用告警 |

> **tip**
> `mirrors.paths` 里的 `runtime / model / tool / skill` 仍由 `ObjectStorageMirrorController` 做启动同步和变更轮询。

> **tip**
> `workspace_backing_store` 只负责受管 workspace 的 `externalRef` / backing store 语义。active workspace 的本地改动不会按 `mirrors.sync_on_change` 实时回写，而是走 workspace materialization 的 idle / drain flush。

### `sandbox`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | sandbox provider，支持 `embedded`、`self_hosted` 和 `e2b`。默认 `embedded`。`embedded` 表示 worker 直接内嵌在 `oah-api`；`self_hosted / e2b` 表示 standalone worker 运行在真实 sandbox 内 |
| `fleet.min_count` | number | self-hosted / e2b 模式下 controller 保持的最小 sandbox 数。默认远端 provider 为 `1`，embedded 为 `0` |
| `fleet.max_count` | number | controller 允许的最大 sandbox 数；默认 `64` |
| `fleet.warm_empty_count` | number | 额外保持的空 sandbox 数，用于让新 workspace 随时快速绑定。远端 provider 默认 `1`，embedded 默认 `0` |
| `fleet.resource_cpu_pressure_threshold` | number | sandbox 资源压力阈值；CPU load ratio 超过该值时会优先把新 ownerless workspace 放到空 sandbox。默认 `0.8` |
| `fleet.resource_memory_pressure_threshold` | number | sandbox 内存压力阈值；memory used ratio 超过该值时会优先把新 ownerless workspace 放到空 sandbox。默认 `0.8` |
| `fleet.max_workspaces_per_sandbox` | number | 单个真实 sandbox 内允许承载的 workspace 上限；默认 `32` |
| `fleet.ownerless_pool` | string | 无 `ownerId` 的 workspace 如何落入 sandbox。`shared` 表示共享池，`dedicated` 表示每个 workspace 独立 sandbox |
| `self_hosted.base_url` | string | `provider=self_hosted` 时必填。指向 self-hosted sandbox 内 standalone worker 暴露的 `/internal/v1` 根地址 |
| `self_hosted.headers` | object | 可选。附加到远端 self-hosted sandbox 请求的固定请求头 |
| `e2b.base_url` | string | `provider=e2b` 时可选。用于覆盖原生 E2B API 地址；若填写旧的 `/internal/v1` 兼容地址，OAH 也会自动归一化 |
| `e2b.api_key` | string | 可选。配置后会以 `Authorization: Bearer <key>` 形式附加到 e2b 请求 |
| `e2b.domain` | string | 可选。覆盖 E2B sandbox domain |
| `e2b.template` | string | 可选。指定创建 sandbox 时使用的 E2B template |
| `e2b.timeout_ms` | number | 可选。创建 / 解析 sandbox 的超时时间 |
| `e2b.request_timeout_ms` | number | 可选。单次 E2B HTTP 请求超时时间 |
| `e2b.headers` | object | 可选。附加到 e2b 请求的固定请求头 |

> **tip**
> OAH 对外仍保持统一的 `/sandboxes` API。切换 `sandbox.provider` 时，Web、OpenAPI 与上层 runtime 调用方式不变，差异只存在于服务端的 sandbox backend 配置。

> **tip**
> 这里保留 `/sandboxes` API、`/workspace` 根路径，以及 sandbox-scoped 文件/命令语义，是为了和 [E2B](https://github.com/e2b-dev/E2B) 的接口约定保持兼容而特意设计的。不要把它理解成暂时性的历史兼容层，也不要默认把文件接口改回 `/workspaces`。`/workspaces` API 本身仍然需要保留，继续负责 workspace metadata、catalog 和 lifecycle。

> **tip**
> `self_hosted` 和 `e2b` 的共同语义是：`oah-api` 不直接执行业务 run，而是把 workspace 路由到真实 sandbox；standalone worker 在 sandbox 内部持有活跃 workspace、本地文件状态和命令执行上下文。

> **tip**
> 当前 controller 已经开始把 sandbox fleet 视为一等调度对象：同一 `ownerId` 会优先复用同一真实 sandbox；未提供 `ownerId` 的 workspace 默认进入共享池。ownerless workspace 会先复用 CPU 和内存都未压线的已有 sandbox；任一资源超过阈值后，才使用 `warm_empty_count` 额外保留的空 sandbox。

> **tip**
> 从当前版本开始，`createSession` 成功后会异步预热对应 workspace：如果配置了远端 sandbox，会提前触发 sandbox 绑定；如果启用了 workspace materialization，也会提前拿到 active workspace copy。配合远端 provider 默认的 `fleet.warm_empty_count = 1`，可以显著缩短首条消息的冷启动等待，但首次 materialization 很重时仍会受到 workspace 体积影响。

> **tip**
> 这里的 `sandbox` 是宿主层，不是项目层。一个 sandbox 可以承载多个活跃 workspace，本质上表示“worker 在哪里运行”；workspace 则表示“agent 正在处理哪个项目与能力集合”。

### `paths`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_dir` | string | project workspace 根目录 |
| `runtime_state_dir` | string | 运行时私有状态目录；用于 SQLite shadow 数据、归档导出和遗留 materialization 状态。默认是 `dirname(workspace_dir)/.openharness` |
| `runtime_dir` | string | workspace runtime 目录 |
| `model_dir` | string | 平台模型定义目录 |
| `tool_dir` | string | 平台级 tool 源目录，主要用于 runtime 初始化导入与单 workspace 模式下的共享来源 |
| `skill_dir` | string | 平台级 skill 源目录，主要用于 runtime 初始化导入与单 workspace 模式下的共享来源 |

### `workspace`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `materialization.idle_ttl_ms` | number | Active Workspace Copy 空闲多久后触发 flush / 回收。默认 `900000` |
| `materialization.maintenance_interval_ms` | number | workspace materialization 后台维护周期。默认 `5000` |

> **tip**
> `workspace.materialization` 主要影响对象存储 backing store、远端 sandbox 和 active workspace copy 的空闲维护节奏；不改变 workspace 的声明式能力模型。

### `llm`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `default_model` | string | 默认模型名，须存在于 `model_dir` 中，运行时解析为 `platform/<name>` |

### `workers`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `embedded.min_count` | number | `API + embedded worker` 模式下常驻的最小 worker 数。配置 Redis 队列时默认至少为 `2` |
| `embedded.max_count` | number | 队列压力高于当前空闲容量时，embedded worker 自动扩到的上限；默认 `4` |
| `embedded.scale_interval_ms` | number | 检查 ready queue / idle worker 并调整 worker 数的周期；默认 `1000` |
| `embedded.idle_ttl_ms` | number | 超出 `min_count` 的 worker 空闲多久后被回收；默认 `30000` |
| `embedded.scale_up_window` | number | 连续多少个检查周期都确认有压力后才扩容；默认 `2` |
| `embedded.scale_down_window` | number | 连续多少个检查周期都确认可回收后才缩容；默认 `2` |
| `embedded.cooldown_ms` | number | 两次扩缩容动作之间的冷却时间；默认等于 `scale_interval_ms` |
| `embedded.reserved_capacity_for_subagent` | number | 当 `subagent` backlog 出现时，希望额外保留的最小空闲 worker 容量；默认 `1` |
| `standalone.min_replicas` | number | controller 允许的最小 sandbox 副本数；可设为 `0` 以允许空闲时缩到零。默认 `1` |
| `standalone.max_replicas` | number | controller 允许的最大 sandbox 副本数；默认等于 `min_replicas` |
| `standalone.ready_sessions_per_capacity_unit` | number | controller 按执行容量单元估算 ready queue 压力时使用的目标密度；默认 `1` |
| `standalone.reserved_capacity_for_subagent` | number | 预留给 subagent backlog 的最小执行容量；默认 `1` |
| `standalone.slots_per_pod` | number | legacy 兼容字段。当前 controller 不再按这个静态值计算 sandbox 副本数，而是使用 worker 实时上报的容量聚合结果 |
| `controller.scale_interval_ms` | number | controller 观测 backlog / worker registry 并重新计算目标副本数的周期 |
| `controller.scale_up_window` | number | 连续多少个高压采样周期后才扩容 |
| `controller.scale_down_window` | number | 连续多少个低压采样周期后才缩容 |
| `controller.cooldown_ms` | number | 两次 controller 扩缩容动作之间的冷却时间 |
| `controller.scale_up_busy_ratio_threshold` | number | 允许用 busy ratio 触发扩容的阈值，范围 `0..1` |
| `controller.scale_up_max_ready_age_ms` | number | 最老可调度 session 等待时长超过该阈值时，可触发老化扩容 |
| `controller.leader_election.type` | string | controller leader election 类型，支持 `noop`、`kubernetes` |
| `controller.leader_election.kubernetes.*` | object | Kubernetes lease 配置，包括 namespace、lease_name、api_url、token_file、ca_file、skip_tls_verify、identity 等 |
| `controller.scale_target.type` | string | scale target 类型，支持 `noop`、`kubernetes`、`docker_compose` |
| `controller.scale_target.allow_scale_down` | boolean | 是否允许 controller 主动缩容 |
| `controller.scale_target.kubernetes.*` | object | Kubernetes Deployment `/scale` 配置，包括 namespace、deployment、label_selector、api_url、token_file、ca_file、skip_tls_verify |
| `controller.scale_target.docker_compose.*` | object | 本地 Docker Compose 缩放配置，包括 compose_file、project_name、service、command，以及可选的远端执行器 endpoint、auth_token、timeout_ms |

> **tip**
> 当前 controller 的职责边界已经固定为“只管理 sandbox fleet”。sandbox 内 worker 要开几个线程、几个 slot、是否多进程，都由 worker 自己决定并通过 registry 上报容量；controller 只消费这些观测值来决定 sandbox 副本数与放置策略。

### Kubernetes 契约

如果后续部署到 Kubernetes，建议把下面这组字段当成正式契约来理解，而不是“示例值”：

#### `workers.controller.leader_election.kubernetes.*`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `namespace` | 是 | Lease 所在 namespace |
| `lease_name` | 是 | leader election 使用的 Lease 名称 |
| `api_url` | 否 | Kubernetes API 地址；省略时优先使用 in-cluster `KUBERNETES_SERVICE_*` |
| `token_file` | 否 | ServiceAccount token 路径；默认 `/var/run/secrets/kubernetes.io/serviceaccount/token` |
| `ca_file` | 否 | Kubernetes CA 证书路径；默认 `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` |
| `skip_tls_verify` | 否 | 仅用于开发调试；生产不建议开启 |
| `lease_duration_ms` | 否 | leader lease 持有时长 |
| `renew_interval_ms` | 否 | leader 实例续约周期 |
| `retry_interval_ms` | 否 | 非 leader / 失败重试周期 |
| `identity` | 否 | 显式 leader identity；默认优先取 `HOSTNAME` |

约束：

- `lease_duration_ms` 应显著大于 `renew_interval_ms`
- `renew_interval_ms` 应大于或等于 `retry_interval_ms`
- 若 controller 计划跑多副本，这组参数必须按环境调优，而不是直接复用本地默认值

#### `workers.controller.scale_target.kubernetes.*`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `namespace` | 是 | 目标 workload 所在 namespace |
| `deployment` | 条件必填 | 显式指定要缩放的 Deployment 名称 |
| `label_selector` | 条件必填 | 用 selector 自动发现目标 Deployment；与 `deployment` 二选一即可 |
| `api_url` | 否 | Kubernetes API 地址；省略时优先使用 in-cluster `KUBERNETES_SERVICE_*` |
| `token_file` | 否 | ServiceAccount token 路径 |
| `ca_file` | 否 | Kubernetes CA 证书路径 |
| `skip_tls_verify` | 否 | 仅用于开发调试；生产不建议开启 |

约束：

- `deployment` 与 `label_selector` 至少要有一个
- 若使用 `label_selector`，它必须稳定且只能命中一个 worker Deployment
- 当前 target 仍以 `Deployment` 为正式目标模型；后续若扩到 `StatefulSet`，会单独扩展配置结构

环境变量覆盖关系：

- `OAH_CONTROLLER_LEADER_ELECTION_TYPE`
- `OAH_CONTROLLER_LEASE_NAMESPACE`
- `OAH_CONTROLLER_LEASE_NAME`
- `OAH_CONTROLLER_LEASE_API_URL`
- `OAH_CONTROLLER_LEASE_TOKEN_FILE`
- `OAH_CONTROLLER_LEASE_CA_FILE`
- `OAH_CONTROLLER_LEASE_SKIP_TLS_VERIFY`
- `OAH_CONTROLLER_LEASE_DURATION_MS`
- `OAH_CONTROLLER_LEASE_RENEW_INTERVAL_MS`
- `OAH_CONTROLLER_LEASE_RETRY_INTERVAL_MS`
- `OAH_CONTROLLER_LEASE_IDENTITY`
- `OAH_CONTROLLER_TARGET_TYPE`
- `OAH_CONTROLLER_TARGET_NAMESPACE`
- `OAH_CONTROLLER_TARGET_DEPLOYMENT`
- `OAH_CONTROLLER_TARGET_LABEL_SELECTOR`
- `OAH_CONTROLLER_KUBE_API_URL`
- `OAH_CONTROLLER_KUBE_TOKEN_FILE`
- `OAH_CONTROLLER_KUBE_CA_FILE`
- `OAH_CONTROLLER_KUBE_SKIP_TLS_VERIFY`

运行时语义：

- controller 计算 `desiredReplicas`
- `scale_target.kubernetes` 负责把目标值 patch 到 `Deployment /scale`
- 最新 reconcile 结果会区分：
  - 目标已接受但 rollout 仍未收敛
  - rollout 正在进行
  - rollout 已 ready
  - selector / 权限 / API 异常导致的失败

这意味着在 K8S 上，“副本数 patch 成功”不再等同于“容量已经 ready”。

---

## 目录说明

### 路径与层级边界

| 对象 | 作用 | 是否活跃执行位置 |
| --- | --- | --- |
| `workspace_dir` | workspace 源目录 / 受管目录 | 不一定 |
| `runtime_state_dir` | engine 私有状态目录 | 否 |
| `runtime_dir` | 新建 workspace 时的初始化源 | 否 |
| `Active Workspace Copy` | 活跃 workspace 实际执行时使用的那份文件副本 | 是 |

理解方式：

- `workspace_dir` 解决“有哪些 workspace”
- `runtime_dir` 解决“新 workspace 从哪里初始化”
- `sandbox` 解决“当前 run 在哪里执行”
- `runtime_state_dir` 解决“engine 私有状态放哪里”

### `workspace_dir`

每个直接子目录视为一个 `project` workspace。仅扫描一级子目录。这里应只承载 workspace 源目录，不建议再混放 engine 内部状态目录。

在 `embedded` 模式下，活跃执行通常直接发生在本地 workspace 上；在 `self_hosted / e2b` 模式下，活跃执行副本通常会 materialize 到 owner sandbox 内部，因此 `workspace_dir` 更接近“受管源目录”，不必等同于最终执行位置。

### `runtime_state_dir`

用于放置运行时私有状态，包括：

- SQLite shadow `history.db`
- 归档导出目录
- 遗留 object-store materialization 状态目录

默认值为 `dirname(workspace_dir)/.openharness`，这样可以把 live workspace 根与内部状态根拆开；如果你希望这些状态持久化，请显式把它挂到可写持久卷。

### `runtime_dir`

存放 workspace runtime。通过 `POST /workspaces` 创建新 workspace 时，从此目录选择 runtime 作为初始化源。运行时不会把 runtime 当作活跃 workspace 加载。

`runtime_dir` 不参与 run 执行，也不承载活跃 workspace 副本。它只回答“如何初始化一个 workspace”，不回答“当前在哪里运行”。

### `model_dir`

递归扫描目录下的 `*.yaml` 文件。文件格式与 workspace 内 `.openharness/models/*.yaml` 一致。加载后以 `platform/<name>` 进入模型目录。

示例（`model_dir/openai-default.yaml`）：

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5
```

### `tool_dir`

公共 MCP tool 源目录。目录结构建议与 workspace `.openharness/tools` 保持一致（`settings.yaml` + `servers/*`）。当前主要用途是给 runtime 初始化时的 `imports.tools` 提供导入源，以及在单 workspace 模式下提供共享 tool 来源。

> **tip**
> 当 OAH 运行在 Docker 容器内时，HTTP MCP server 若配置为 `http://127.0.0.1:...` 或 `http://localhost:...`，运行时会自动改写为宿主机别名，默认使用 `host.docker.internal`。如需覆盖，可设置 `OAH_DOCKER_HOST_ALIAS`。

### `skill_dir`

公共 skill 源目录。当前主要用途是给 runtime 初始化时的 `imports.skills` 提供导入源，以及在单 workspace 模式下提供共享 skill 来源。

> **warning**
> `tool_dir` 和 `skill_dir` 的内容主要在 runtime 初始化时导入。workspace 运行时默认只使用自身 `.openharness` 目录中声明的能力，以及已经被导入到该 workspace 副本里的内容。

---

## 运行模式

| 模式 | 启动方式 | 说明 |
| --- | --- | --- |
| API + embedded worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml` | 最小化部署；一个 `oah-api` 进程内直接包含 embedded worker |
| API only | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml --api-only` | 只启动 `oah-api`，通常配合 `oah-controller` 与 `oah-sandbox` |
| Standalone worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config server.yaml` | standalone worker，通常运行在 self-hosted / E2B sandbox 中 |

---

## 环境变量覆盖

除 YAML 配置外，服务端还有一组运行期环境变量用于控制恢复、worker 池与调试行为。

### Stale Run 恢复

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OAH_STALE_RUN_RECOVERY_STRATEGY` | Redis 模式下为 `requeue_running`，否则为 `fail` | stale run 恢复策略，可选 `fail`、`requeue_running`、`requeue_all` |
| `OAH_STALE_RUN_RECOVERY_MAX_ATTEMPTS` | `1` | 单个 run 最多允许自动重新排队的次数 |

### Embedded Worker 池

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OAH_EMBEDDED_WORKER_MIN` | Redis 模式下 `2`，否则 `1` | embedded worker 最小实例数；独立 worker 进程固定至少为 `1` |
| `OAH_EMBEDDED_WORKER_MAX` | 等于 `OAH_EMBEDDED_WORKER_MIN` | embedded worker 最大实例数 |
| `OAH_EMBEDDED_WORKER_SCALE_INTERVAL_MS` | `5000` | pool 周期性重平衡间隔 |
| `OAH_EMBEDDED_WORKER_READY_SESSIONS_PER_CAPACITY_UNIT` | `1` | 每个执行容量单元目标承载的可调度 session 数 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_COOLDOWN_MS` | `1000` | 扩容冷却时间 |
| `OAH_EMBEDDED_WORKER_SCALE_DOWN_COOLDOWN_MS` | `15000` | 缩容冷却时间 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_SAMPLE_SIZE` | `2` | 触发扩容前需要连续满足压力条件的采样次数 |
| `OAH_EMBEDDED_WORKER_SCALE_DOWN_SAMPLE_SIZE` | `3` | 触发缩容前需要连续满足压力条件的采样次数 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_BUSY_RATIO_PERCENT` | `75` | 当 busy ratio 超过该阈值时，可联动老化压力触发额外扩容 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_MAX_READY_AGE_MS` | `2000` | 最老可调度 session 等待时长超过该阈值时，允许触发老化扩容 |
| `OAH_EMBEDDED_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT` | `1` | 出现 `subagent` backlog 时，希望额外保留的最小空闲 worker 容量；允许设为 `0` |

### 其他运行期参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OAH_HISTORY_EVENT_RETENTION_DAYS` | `7` | Postgres 模式下历史事件保留天数 |
| `OAH_RUNTIME_DEBUG` | 未设置 | 设置后向标准输出镜像 runtime debug 日志 |
| `OAH_DOCKER_HOST_ALIAS` | `host.docker.internal` | 当服务运行在 Docker 内且 HTTP MCP server 配置为 loopback 地址时，用于替换 `127.0.0.1` / `localhost` 的宿主机别名 |

> **tip**
> 当配置了 Redis 队列且使用 `API + embedded worker` 模式时，服务默认会至少启动 `2` 个 embedded worker，并根据 `ready queue` 相对当前空闲 worker 的缺口做轻量扩容；扩缩容还会经过 `scale_up_window` / `scale_down_window` 连续判定和 `cooldown_ms` 冷却控制。若出现 `subagent` backlog，则会优先补足 `reserved_capacity_for_subagent`，减少父 run 等待 child run 时被普通 backlog 挤压的风险。

> **tip**
> `OAH_DOCKER_HOST_ALIAS` 主要用于“容器中的 OAH 访问宿主机上的 HTTP MCP server”场景。本地 `docker-compose.local.yml` 已默认注入 `host.docker.internal:host-gateway`，因此大多数情况下无需额外配置。

---

## Schema

JSON Schema：[schemas/server-config.schema.json](./schemas/server-config.schema.json)
