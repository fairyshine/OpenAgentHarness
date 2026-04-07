# Server Config

服务端配置建议尽量保持简单，先解决“服务怎么跑起来”。

建议只保留四组核心配置：

- `server`
- `storage`
- `paths`
- `llm`

建议使用 YAML，文件名可约定为：

- `server.yaml`

## 最小示例

```yaml
server:
  host: 0.0.0.0
  port: 8787

storage:
  postgres_url: ${env.DATABASE_URL}
  redis_url: ${env.REDIS_URL}

paths:
  workspace_dir: /srv/openharness/workspaces
  chat_dir: /srv/openharness/chat-workspaces
  template_dir: /srv/openharness/templates
  model_dir: /srv/openharness/models
  tool_dir: /srv/openharness/tools
  skill_dir: /srv/openharness/skills

llm:
  default_model: openai-default
```

## 顶层结构

- `server`
- `storage`
- `paths`
- `llm`

## 命名约定

- `*_dir`
  - 表示一个目录
- `*_model`
  - 表示一个模型名称，而不是完整引用

## `server`

用途：

- 定义服务监听地址

建议结构：

```yaml
server:
  host: 0.0.0.0
  port: 8787
```

字段说明：

- `host`
  - 服务监听地址
- `port`
  - 服务监听端口

## `storage`

用途：

- 定义中心数据库与 Redis

建议结构：

```yaml
storage:
  postgres_url: ${env.DATABASE_URL}
  redis_url: ${env.REDIS_URL}
```

字段说明：

- `postgres_url`
  - PostgreSQL 连接串
- `redis_url`
  - Redis 连接串

说明：

- PostgreSQL 是唯一事实源
- Redis 负责队列、锁、限流和短期事件缓存
- 当前实现中，PostgreSQL 已用于中心持久化；Redis 已接入 session run queue、session lock 和 session 事件实时分发，便于多实例执行与 SSE 扇出

## 本地开发启动

如果你本地配置的是：

- `postgres_url: postgres://...@127.0.0.1:5432/...`
- `redis_url: redis://127.0.0.1:6379`

那么就需要先在本地启动 PostgreSQL 和 Redis，或者改成你已有的远端实例连接串。

仓库已提供：

- `docker-compose.dev.yml`
- `pnpm infra:up`
- `pnpm infra:down`
- `pnpm dev:server`
- `pnpm dev:worker`

对应本地默认连接串可写为：

```yaml
storage:
  postgres_url: postgres://oah:oah@127.0.0.1:5432/open_agent_harness
  redis_url: redis://127.0.0.1:6379
```

推荐本地联调方式：

- 最省事：`pnpm dev:server -- --config ./server.example.yaml`
- 需要前端时再加：`pnpm dev:web`

如果你只想把单个 workspace 直接作为后端服务运行，也可以不走多 workspace 目录配置，而是直接使用 CLI：

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

说明：

- 该模式会直接发现并注册这一个 workspace
- 更接近单仓库、单后端的 `opencode` 风格
- `GET /workspace-templates`、`POST /workspaces`、`POST /workspaces/import`、`DELETE /workspaces/:id` 等 workspace 管理接口会被禁用

如果你想模拟生产拆分部署，则推荐：

- 一个 API 进程：`pnpm dev:server -- --config ./server.example.yaml --api-only`
- 一个 worker 进程：`pnpm dev:worker -- --config ./server.example.yaml`
- 一个前端进程：`pnpm dev:web`

## 运行模式

当前服务端支持三种运行模式：

- `API + embedded worker`
  - `server` 默认模式
  - 用于本地开发、PoC、单机部署和小规模自托管
  - 如果配置了 Redis，embedded worker 会消费 Redis run queue
  - 如果没有配置 Redis，run 会在 API 进程内直接执行
- `API only`
  - 使用 `--api-only` 或 `--no-worker`
  - 适合将 API 与 worker 分离部署
  - 如果配置了 Redis，需要单独启动 `standalone worker`
  - 如果没有配置 Redis，当前仍会保留本地 in-process 执行语义，并由 API 进程执行 history mirror sync
- `standalone worker`
  - 使用独立 worker 进程启动
  - 适合生产环境横向扩展和资源隔离
  - 当前主要负责消费 Redis run queue，并执行 history mirror sync

推荐部署策略：

- 开发 / 单机：默认 `server`
- 生产 / 分布式：`server --api-only` + 独立 `worker`

## `paths`

用途：

- 定义服务端使用到的各类目录

建议结构：

```yaml
paths:
  workspace_dir: /srv/openharness/workspaces
  chat_dir: /srv/openharness/chat-workspaces
  template_dir: /srv/openharness/templates
  model_dir: /srv/openharness/models
  tool_dir: /srv/openharness/tools
  skill_dir: /srv/openharness/skills
```

### `paths.workspace_dir`

用途：

- 存放各种常规 `project` workspace 项目

规则：

- 每个直接子目录视为一个 `project` workspace
- 仅扫描直接子目录，不递归更深层级
- 子目录内按普通 workspace 规则读取

### `paths.chat_dir`

用途：

- 存放各种预置的只读 `chat` workspace

规则：

- 每个直接子目录视为一个 `chat` workspace
- 仅扫描直接子目录，不递归更深层级
- 子目录内按 `chat` workspace 规则读取
- 这些目录本身就是直接可用的只读对话空间，不会像 `template_dir` 那样先复制再创建
- 因为它们不可修改，所以也可以被视为一组可复用的对话模式预设

### `paths.template_dir`

用途：

- 存放开发者预设的 workspace 模板

规则：

- 模板只用于初始化生成 workspace 文件
- `POST /workspaces` 创建新 workspace 时，必须从这里选择一个模板作为初始化源
- 初始化顺序应为：先复制模板，再追加用户传入的 `AGENTS.md`、workspace tools 和 workspace skills
- 运行时不会直接把模板目录当作活跃 workspace 加载

### `paths.model_dir`

用途：

- 存放服务默认提供的各种模型

规则：

- 仅扫描该目录下的 `*.yaml`
- 文件内容结构与 workspace `.openharness/models/*.yaml` 完全一致
- 这些模型在运行时以 `platform/<name>` 的形式进入可见 model catalog

单个文件示例：

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5
```

### `paths.tool_dir`

用途：

- 存放服务端提供的公共 external tool server 定义

说明：

- 建议目录结构与 workspace `.openharness/tools` 保持一致
- 例如包含 `settings.yaml` 与 `servers/*`
- 这些 external tools 不属于 native tool，也不属于 workspace 私有 tool server
- 它们由服务端统一加载，并按平台级公共能力参与可见 catalog 组装
- workspace 内可按策略选择是否暴露给 agent

### `paths.skill_dir`

用途：

- 存放服务端提供的公共 skill

说明：

- 这些 skill 与 workspace `.openharness/skills` 一起构成可见 skill 集合
- workspace 同名 skill 优先级高于服务端公共 skill

## `llm`

用途：

- 定义服务默认使用的模型

建议结构：

```yaml
llm:
  default_model: openai-default
```

字段说明：

- `default_model`
  - 服务端默认模型名

规则：

- 这里直接写模型名，例如 `openai-default`
- 该模型必须存在于 `paths.model_dir`
- 运行时真正对外使用时，会解析为 `platform/openai-default`

## 自动发现规则

服务端启动后建议执行以下扫描：

1. 扫描 `paths.workspace_dir`
2. 扫描 `paths.chat_dir`
3. 扫描 `paths.template_dir`
4. 扫描 `paths.model_dir`
5. 扫描 `paths.tool_dir`
6. 扫描 `paths.skill_dir`

建议原则：

- `workspace_dir` 与 `chat_dir` 负责发现 workspace
- `template_dir` 只负责初始化模板
- `model_dir`、`tool_dir`、`skill_dir` 负责发现平台公共能力

## 与 workspace 配置的关系

- 服务端配置负责：
  - workspace 根目录
  - chat 根目录
  - template 目录
  - 平台模型目录
  - 公共 tool 目录
  - 公共 skill 目录
  - 默认模型
- workspace 配置负责：
  - 项目自身的 agent、model、action、skill、tool、hook

进入某个 workspace 时：

- `paths.model_dir` 中的平台模型与 workspace 模型合并
- `paths.skill_dir` 不会直接并入 workspace 运行时；它主要作为模板初始化时的 skill 导入源
- `paths.tool_dir` 不会直接并入 workspace 运行时；它主要作为模板初始化时的 tool 导入源
- workspace 运行时默认只使用自身 `.openharness` 和 `settings.skill_dirs` 中声明的能力

## Schema

服务端配置对应 schema：

- [schemas/server-config.schema.json](./schemas/server-config.schema.json)
