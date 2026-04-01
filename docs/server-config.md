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
  models_dir: /srv/openharness/models
  mcp_dir: /srv/openharness/mcp
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

## `paths`

用途：

- 定义服务端使用到的各类目录

建议结构：

```yaml
paths:
  workspace_dir: /srv/openharness/workspaces
  chat_dir: /srv/openharness/chat-workspaces
  template_dir: /srv/openharness/templates
  models_dir: /srv/openharness/models
  mcp_dir: /srv/openharness/mcp
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

- 存放各种只读 `chat` workspace

规则：

- 每个直接子目录视为一个 `chat` workspace
- 仅扫描直接子目录，不递归更深层级
- 子目录内按 `chat` workspace 规则读取

### `paths.template_dir`

用途：

- 存放开发者预设的 workspace 模板

规则：

- 模板只用于初始化生成 workspace 文件
- `POST /workspaces` 创建新 workspace 时，必须从这里选择一个模板作为初始化源
- 初始化顺序应为：先复制模板，再追加用户传入的 `AGENTS.md`、workspace MCP 和 workspace skills
- 运行时不会直接把模板目录当作活跃 workspace 加载

### `paths.models_dir`

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

### `paths.mcp_dir`

用途：

- 存放服务端提供的公共 MCP server 定义

说明：

- 建议目录结构与 workspace `.openharness/mcp` 保持一致
- 例如包含 `settings.yaml` 与 `servers/*`
- 这些 MCP 不属于 native tool，也不属于 workspace 私有 MCP
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
- 该模型必须存在于 `paths.models_dir`
- 运行时真正对外使用时，会解析为 `platform/openai-default`

## 自动发现规则

服务端启动后建议执行以下扫描：

1. 扫描 `paths.workspace_dir`
2. 扫描 `paths.chat_dir`
3. 扫描 `paths.template_dir`
4. 扫描 `paths.models_dir`
5. 扫描 `paths.mcp_dir`
6. 扫描 `paths.skill_dir`

建议原则：

- `workspace_dir` 与 `chat_dir` 负责发现 workspace
- `template_dir` 只负责初始化模板
- `models_dir`、`mcp_dir`、`skill_dir` 负责发现平台公共能力

## 与 workspace 配置的关系

- 服务端配置负责：
  - workspace 根目录
  - chat 根目录
  - template 目录
  - 平台模型目录
  - 公共 MCP 目录
  - 公共 skill 目录
  - 默认模型
- workspace 配置负责：
  - 项目自身的 agent、model、action、skill、mcp、hook

进入某个 workspace 时：

- `paths.models_dir` 中的平台模型与 workspace 模型合并
- `paths.skill_dir` 中的公共 skill 与 workspace skill 合并
- `paths.mcp_dir` 中的公共 MCP 与 workspace MCP 合并，再与 native tool / action / skill 一起参与能力投影
- workspace 同名定义优先级高于服务端公共定义

## Schema

服务端配置对应 schema：

- [schemas/server-config.schema.json](./schemas/server-config.schema.json)
