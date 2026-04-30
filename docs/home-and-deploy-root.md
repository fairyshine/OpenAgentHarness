# OAH Home 与 Deploy Root

本文档约定本地 daemon、Docker Compose、Kubernetes / Helm 之间如何共享同一套平台资产，同时保留各自的运行时状态与部署配置。

## 目标

OAH 需要同时支持三种使用方式：

- 本地单用户 daemon：使用 SQLite、embedded worker 和本机磁盘。
- 本地 split stack：使用 Docker Compose、PostgreSQL、Redis、MinIO 和 standalone sandbox。
- 集群部署：使用 Kubernetes / Helm、外部 PostgreSQL、Redis 和对象存储。

三者应共享 models、runtimes、tools、skills 等平台资产，但不能共享进程状态、SQLite 数据、PID/token、日志或容器/K8S 生成配置。

## OAH 与 OAP 的关系

本地个人版不应成为一套独立协议。它应被定义为 `OAP`（Open Agent Harness Personal）：一个 OAH-compatible 的个人部署 profile。

```text
WebUI     ┐
TUI       ├── OAH API ── OAH enterprise server
Desktop   ┘          └── OAP local daemon
```

这意味着：

- `OAH enterprise server` 和 `OAP local daemon` 都暴露同一套 API / SSE。
- WebUI、TUI、Desktop 都只是 client，可以连接本地 daemon，也可以连接远端企业服务。
- Desktop 不是 OAP 专属；连接 OAP local daemon 时才显示本地 daemon supervisor、local logs、本地模型/工具/技能管理等增强能力。
- `OAP` 默认使用 `OAH_HOME`、SQLite、本地磁盘、embedded worker 和 `config/daemon.yaml`。
- `OAH` 企业部署默认使用 `OAH_DEPLOY_ROOT`、PostgreSQL、Redis、对象存储、controller、standalone worker 和 Compose / K8S profile。
- 从 OAP 迁移到 OAH 的主要动作应是迁移 assets、workspace/session 数据和配置 profile，而不是改客户端或协议。

客户端连接后应通过 `GET /api/v1/system/profile` 判断当前服务形态。OAP local daemon 应返回 `edition=personal`、`runtimeMode=daemon`，并声明 `localDaemonControl`、`localWorkspacePaths` 等本地能力；OAH enterprise server 应返回 `edition=enterprise`，并关闭这些个人本地专属 capabilities。

## 目录语义

### `OAH_HOME`

`OAH_HOME` 是本机用户级根目录，默认建议为：

```text
~/.openagentharness
```

它是 local daemon 的 home，也可以作为本机默认的 `OAH_DEPLOY_ROOT`。推荐布局：

```text
~/.openagentharness/
  models/
  runtimes/
  tools/
  skills/
  workspaces/
  config/
    daemon.yaml
    server.docker.yaml
    kubernetes.server.yaml
  state/
  logs/
  run/
  .oah-local/
```

其中：

- `models/`、`runtimes/`、`tools/`、`skills/`、`workspaces/` 是可发布、可同步、可迁移的平台资产。
- `config/` 是本地与集群 profile 配置。
- `config/server.docker.yaml` 是 Docker Compose / `OAH_DEPLOY_ROOT` 入口；旧的根目录 `server.docker.yaml` 仍兼容。
- `state/` 只放本地 runtime 私有状态，例如 SQLite shadow、archive、materialization cache。
- `logs/`、`run/` 只属于 local daemon。
- `.oah-local/` 只放 compose 生成配置和 fingerprint。

### `OAH_DEPLOY_ROOT`

`OAH_DEPLOY_ROOT` 是部署发布根目录，现有脚本会读取：

```text
$OAH_DEPLOY_ROOT/config/server.docker.yaml
$OAH_DEPLOY_ROOT/{models,runtimes,tools,skills,workspaces}
```

为了兼容旧 deploy root，脚本也会 fallback 到：

```text
$OAH_DEPLOY_ROOT/server.docker.yaml
$OAH_DEPLOY_ROOT/source/
```

本地 daemon 可以默认令：

```bash
export OAH_HOME="${OAH_HOME:-$HOME/.openagentharness}"
export OAH_DEPLOY_ROOT="${OAH_DEPLOY_ROOT:-$OAH_HOME}"
```

生产或团队环境仍建议显式指定独立 deploy root，例如：

```bash
export OAH_DEPLOY_ROOT=/srv/oah-deploy-root
```

## 资产目录是互通边界

扁平资产目录是唯一建议跨本地、compose、K8S 共享的目录：

| 目录 | 本地 daemon | Compose / MinIO | K8S / 对象存储 |
| --- | --- | --- | --- |
| `models` | 直接作为 `paths.model_dir` | 同步到 `model/` prefix | 同步到 `model/` prefix |
| `runtimes` | 直接作为 `paths.runtime_dir` | 同步到 `runtime/` prefix | 同步到 `runtime/` prefix |
| `tools` | 直接作为 `paths.tool_dir` | 同步到 `tool/` prefix | 同步到 `tool/` prefix |
| `skills` | 直接作为 `paths.skill_dir` | 同步到 `skill/` prefix | 同步到 `skill/` prefix |
| `workspaces` | 可作为受管 workspace 源 | 默认不同步，按需 opt-in | 仅在明确启用 workspace backing 时同步 |

`state/`、`logs/`、`run/`、`.oah-local/` 不应被 `storage:sync` 发布，也不应进入 Helm chart 或 K8S ConfigMap。

旧版 `source/models`、`source/runtimes`、`source/tools`、`source/skills`、`source/workspaces` 仍被识别为 legacy layout。

## 配置 Profile

### Local Daemon

local daemon 使用 `config/daemon.yaml`，默认形态是：

```yaml
server:
  host: 127.0.0.1
  port: 8787

storage: {}

sandbox:
  provider: embedded

paths:
  workspace_dir: ../workspaces
  runtime_state_dir: ../state
  runtime_dir: ../runtimes
  model_dir: ../models
  tool_dir: ../tools
  skill_dir: ../skills

workers:
  embedded:
    min_count: 1
    max_count: 2

llm:
  default_model: openai-default
```

该配置相对 `config/daemon.yaml` 解析路径，因此复制到任意 `OAH_HOME/config/daemon.yaml` 后仍能指向同一个 home。

### Docker Compose

Compose 使用 `config/server.docker.yaml` 作为输入。`scripts/local-stack.mjs` 会基于它生成：

```text
.oah-local/api.generated.yaml
.oah-local/controller.generated.yaml
.oah-local/sandbox.generated.yaml
```

这些是运行时产物，不是用户要长期编辑的源配置。

旧的根目录 `server.docker.yaml` 仍可被读取；新建 home / deploy root 默认使用 `config/server.docker.yaml`。

### Kubernetes / Helm

K8S profile 可以放在：

```text
config/kubernetes.server.yaml
```

它表示 ConfigMap 中最终的 `server.yaml` 内容。Helm chart 仍通过 `config.serverYaml` 接收该内容；后续可以增加命令把这个 profile 渲染进 values 或 ConfigMap。

## 建议的命令语义

未来 CLI 可以按下面约定实现：

```bash
oah daemon start
oah daemon status
oah daemon stop
oah daemon logs

oah tui --workspace /path/to/repo
oah models list
oah models add ./model.yaml
oah models default openai-default
```

`oah tui --workspace /path/to/repo` 应：

1. 解析 `OAH_HOME`，缺省为 `~/.openagentharness`。
2. 如果 home 不存在，用 `template/deploy-root` 初始化。
3. 如果 daemon 未运行，使用 `config/daemon.yaml` 启动。
4. 注册或打开传入 workspace。
5. 通过 daemon API 进入 TUI。

## 当前缺口

`@oah/storage-sqlite` 当前对普通可写 project workspace 会优先写入：

```text
<workspace>/.openharness/data/history.db
```

桌面 / daemon 形态通常更希望会话历史始终留在 `OAH_HOME/state`，避免污染用户 repo。建议后续补一个配置开关：

```yaml
storage:
  sqlite:
    project_db_location: shadow
```

或：

```yaml
storage:
  sqlite:
    force_shadow: true
```

在该能力落地前，daemon 可以先把受管 workspace 放在 `OAH_HOME/workspaces`；对外部 repo workspace，要明确告知会生成 repo-local `.openharness/data/history.db`。

## 兼容原则

- 新建 root 使用扁平资产目录和 `config/server.docker.yaml`。
- 旧的 `OAH_DEPLOY_ROOT/source/*` 与根目录 `server.docker.yaml` 保持兼容。
- Local daemon 不读取 `.oah-local/*.generated.yaml`。
- Compose/K8S 不读取 `state/`、`logs/`、`run/`。
- K8S/Helm 的最终配置仍是标准 `server.yaml`，只是源 profile 可以存放在 deploy root 的 `config/` 下。
