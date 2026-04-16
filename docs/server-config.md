# 服务端配置

配置文件格式：YAML，默认文件名 `server.yaml`。

---

## 最小配置

```yaml
server:
  host: 0.0.0.0          # 监听地址
  port: 8787              # 监听端口

storage:
  postgres_url: ${env.DATABASE_URL}   # PostgreSQL 连接串
  redis_url: ${env.REDIS_URL}         # Redis 连接串（可选）

sandbox:
  provider: embedded                  # embedded | self_hosted | e2b
  # fleet:
  #   min_count: 1
  #   max_count: 32
  #   max_workspaces_per_sandbox: 32
  #   ownerless_pool: shared          # shared | dedicated
  # self_hosted:
  #   base_url: http://oah-sandbox:8787/internal/v1
  # e2b:
  #   base_url: https://api.e2b.dev
  #   api_key: ${env.E2B_API_KEY}

paths:
  workspace_dir: /srv/openharness/workspaces       # project workspace 根目录
  blueprint_dir: /srv/openharness/blueprints        # workspace blueprint 目录
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
| `postgres_url` | string | 是 | PostgreSQL 连接串；未指定 `serviceName` 的 workspace 会直接使用该库，指定 `serviceName` 后默认库只保留 workspace/session/run 索引，业务真值会路由到同前缀的派生库（如 `OAH-acme`） |
| `redis_url` | string | 否 | Redis 连接串，用于队列、锁、限流、SSE 事件分发 |

> **tip**
> 不配置 Redis 时，Run 会在 API 进程内直接执行（适合本地开发）。配置 Redis 后支持多实例 Worker 消费队列。

### `sandbox`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | sandbox provider，支持 `embedded`、`self_hosted` 和 `e2b`。默认 `embedded`。`embedded` 表示 worker 直接内嵌在 `oah-api`；`self_hosted / e2b` 表示 standalone worker 运行在真实 sandbox 内 |
| `fleet.min_count` | number | self-hosted / e2b 模式下 controller 保持的最小 sandbox 数。默认远端 provider 为 `1`，embedded 为 `0` |
| `fleet.max_count` | number | controller 允许的最大 sandbox 数；默认 `64` |
| `fleet.max_workspaces_per_sandbox` | number | 单个真实 sandbox 内允许承载的 workspace 上限；默认 `32` |
| `fleet.ownerless_pool` | string | 无 `ownerId` 的 workspace 如何落入 sandbox。`shared` 表示共享池，`dedicated` 表示每个 workspace 独立 sandbox |
| `self_hosted.base_url` | string | `provider=self_hosted` 时必填。指向 self-hosted sandbox 内 standalone worker 暴露的 `/internal/v1` 根地址 |
| `self_hosted.headers` | object | 可选。附加到远端 self-hosted sandbox 请求的固定请求头 |
| `e2b.base_url` | string | `provider=e2b` 时可选。用于覆盖原生 E2B API 地址；若填写旧的 `/internal/v1` 兼容地址，OAH 也会自动归一化 |
| `e2b.api_key` | string | 可选。配置后会以 `Authorization: Bearer <key>` 形式附加到 e2b 请求 |
| `e2b.headers` | object | 可选。附加到 e2b 请求的固定请求头 |

> **tip**
> OAH 对外仍保持统一的 `/sandboxes` API。切换 `sandbox.provider` 时，Web、OpenAPI 与上层 runtime 调用方式不变，差异只存在于服务端的 sandbox backend 配置。

> **tip**
> `self_hosted` 和 `e2b` 的共同语义是：`oah-api` 不直接执行业务 run，而是把 workspace 路由到真实 sandbox；standalone worker 在 sandbox 内部持有活跃 workspace、本地文件状态和命令执行上下文。

> **tip**
> 当前 controller 已经开始把 sandbox fleet 视为一等调度对象：同一 `ownerId` 会优先复用同一真实 sandbox；未提供 `ownerId` 的 workspace 默认进入共享池。`fleet.*` 负责描述这层容量边界，后续可继续接到真实的 sandbox autoscaling target。

### `paths`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_dir` | string | project workspace 根目录 |
| `blueprint_dir` | string | workspace blueprint 目录 |
| `model_dir` | string | 平台模型定义目录 |
| `tool_dir` | string | 公共 MCP tool server 定义目录 |
| `skill_dir` | string | 公共 skill 目录 |

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
| `standalone.min_replicas` | number | controller 允许的最小 sandbox 副本数；默认 `1` |
| `standalone.max_replicas` | number | controller 允许的最大 sandbox 副本数；默认等于 `min_replicas` |
| `standalone.ready_sessions_per_capacity_unit` | number | controller 按执行容量单元估算 ready queue 压力时使用的目标密度；默认 `1` |
| `standalone.reserved_capacity_for_subagent` | number | 预留给 subagent backlog 的最小执行容量；默认 `1` |
| `standalone.slots_per_pod` | number | legacy 兼容字段。当前 controller 不再按这个静态值计算 sandbox 副本数，而是使用 worker 实时上报的容量聚合结果 |

> **tip**
> 当前 controller 的职责边界已经固定为“只管理 sandbox fleet”。sandbox 内 worker 要开几个线程、几个 slot、是否多进程，都由 worker 自己决定并通过 registry 上报容量；controller 只消费这些观测值来决定 sandbox 副本数与放置策略。

---

## 目录说明

### `workspace_dir`

每个直接子目录视为一个 `project` workspace。仅扫描一级子目录。

### `blueprint_dir`

存放 workspace blueprint。通过 `POST /workspaces` 创建新 workspace 时，从此目录选择 blueprint 作为初始化源。运行时不会把 blueprint 当作活跃 workspace 加载。

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

公共 MCP tool server 定义。目录结构建议与 workspace `.openharness/tools` 保持一致（`settings.yaml` + `servers/*`）。由服务端统一加载，作为平台级能力参与 catalog 组装。

### `skill_dir`

公共 skill 定义。与 workspace `.openharness/skills` 合并组成可见 skill 集合。同名 skill 中 workspace 级优先。

> **warning**
> `tool_dir` 和 `skill_dir` 的内容主要在蓝图初始化时导入。workspace 运行时默认只使用自身 `.openharness` 目录中声明的能力。

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

> **tip**
> 当配置了 Redis 队列且使用 `API + embedded worker` 模式时，服务默认会至少启动 `2` 个 embedded worker，并根据 `ready queue` 相对当前空闲 worker 的缺口做轻量扩容；扩缩容还会经过 `scale_up_window` / `scale_down_window` 连续判定和 `cooldown_ms` 冷却控制。若出现 `subagent` backlog，则会优先补足 `reserved_capacity_for_subagent`，减少父 run 等待 child run 时被普通 backlog 挤压的风险。

---

## Schema

JSON Schema：[schemas/server-config.schema.json](./schemas/server-config.schema.json)
