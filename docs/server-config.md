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

paths:
  workspace_dir: /srv/openharness/workspaces       # project workspace 根目录
  chat_dir: /srv/openharness/chat-workspaces       # chat workspace 根目录
  template_dir: /srv/openharness/templates         # workspace 模板目录
  model_dir: /srv/openharness/models               # 平台模型目录
  tool_dir: /srv/openharness/tools                 # 公共 tool 目录
  skill_dir: /srv/openharness/skills               # 公共 skill 目录
  archive_dir: /srv/openharness/archives           # 导出的归档 SQLite 存储目录（可选）

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
| `postgres_url` | string | 是 | PostgreSQL 连接串，唯一事实源 |
| `redis_url` | string | 否 | Redis 连接串，用于队列、锁、限流、SSE 事件分发 |

> **tip**
> 不配置 Redis 时，Run 会在 API 进程内直接执行（适合本地开发）。配置 Redis 后支持多实例 Worker 消费队列。

### `paths`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_dir` | string | project workspace 根目录 |
| `chat_dir` | string | chat workspace 根目录 |
| `template_dir` | string | workspace 模板目录 |
| `model_dir` | string | 平台模型定义目录 |
| `tool_dir` | string | 公共 MCP tool server 定义目录 |
| `skill_dir` | string | 公共 skill 目录 |
| `archive_dir` | string | 导出的归档 SQLite 目录；省略时默认使用 `<workspace_dir>/.openharness/archives` |

### `llm`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `default_model` | string | 默认模型名，须存在于 `model_dir` 中，运行时解析为 `platform/<name>` |

---

## 目录说明

### `workspace_dir`

每个直接子目录视为一个 `project` workspace。仅扫描一级子目录。

### `chat_dir`

每个直接子目录视为一个只读 `chat` workspace。这些目录本身即可用的对话空间，不需要从模板创建。

### `template_dir`

存放 workspace 模板。通过 `POST /workspaces` 创建新 workspace 时，从此目录选择模板作为初始化源。运行时不会把模板当作活跃 workspace 加载。

### `model_dir`

扫描目录下的 `*.yaml` 文件。文件格式与 workspace 内 `.openharness/models/*.yaml` 一致。加载后以 `platform/<name>` 进入模型目录。

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
> `tool_dir` 和 `skill_dir` 的内容主要在模板初始化时导入。workspace 运行时默认只使用自身 `.openharness` 目录中声明的能力。

### `archive_dir`

用于存放历史归档导出的 SQLite 文件，文件名按归档日期生成，例如 `2026-04-08.sqlite`。

每个归档文件旁边还会生成同名校验文件，例如 `2026-04-08.sqlite.sha256`，方便长期备份和完整性校验。

服务启动后的归档巡检会检查这个目录中的残留 `.tmp` 文件、缺失校验文件的归档、孤立的 `.sha256` 文件，以及不符合 `YYYY-MM-DD.sqlite` 规范的文件名，并输出告警日志，但不会自动删除正式归档文件。

如果不配置，默认路径为 `<workspace_dir>/.openharness/archives`。

---

## 运行模式

| 模式 | 启动方式 | 说明 |
| --- | --- | --- |
| API + embedded worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml` | 默认模式，一个进程包含 API 和 Worker |
| API only | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config server.yaml --api-only` | 只启动 API，需配合独立 Worker |
| Standalone worker | `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config server.yaml` | 独立 Worker，消费 Redis 队列 |

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
| `OAH_EMBEDDED_WORKER_READY_SESSIONS_PER_WORKER` | `1` | 每个 worker 目标承载的可调度 session 数 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_COOLDOWN_MS` | `1000` | 扩容冷却时间 |
| `OAH_EMBEDDED_WORKER_SCALE_DOWN_COOLDOWN_MS` | `15000` | 缩容冷却时间 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_SAMPLE_SIZE` | `2` | 触发扩容前需要连续满足压力条件的采样次数 |
| `OAH_EMBEDDED_WORKER_SCALE_DOWN_SAMPLE_SIZE` | `3` | 触发缩容前需要连续满足压力条件的采样次数 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_BUSY_RATIO_PERCENT` | `75` | 当 busy ratio 超过该阈值时，可联动老化压力触发额外扩容 |
| `OAH_EMBEDDED_WORKER_SCALE_UP_MAX_READY_AGE_MS` | `2000` | 最老可调度 session 等待时长超过该阈值时，允许触发老化扩容 |

### 其他运行期参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OAH_HISTORY_EVENT_RETENTION_DAYS` | `7` | Postgres 模式下历史事件保留天数 |
| `OAH_RUNTIME_DEBUG` | 未设置 | 设置后向标准输出镜像 runtime debug 日志 |

---

## Schema

JSON Schema：[schemas/server-config.schema.json](./schemas/server-config.schema.json)
