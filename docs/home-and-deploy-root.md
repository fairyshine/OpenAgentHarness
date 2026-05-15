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

它是 local daemon 的 home、release 安装根目录，也是本机默认的 deploy root。推荐布局：

```text
~/.openagentharness/
  bin/
    oah
  current -> versions/<version>
  versions/
    <version>/
      bin/oah
      lib/
      node/
      native/
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

- `bin/` 是稳定命令入口，通常只放 `oah` shim。
- `versions/` 保存 release tarball 展开的程序文件；`current` 指向当前版本，`oah update` / `oah rollback` 只切换这一层。
- `models/`、`runtimes/`、`tools/`、`skills/`、`workspaces/` 是可发布、可同步、可迁移的平台资产。
- `config/` 是本地与集群 profile 配置。
- `config/server.docker.yaml` 是 Docker Compose / `OAH_DEPLOY_ROOT` 入口；旧的根目录 `server.docker.yaml` 仍兼容。
- `state/` 只放本地 runtime 私有状态，例如 SQLite shadow、archive、materialization cache。
- `logs/`、`run/` 只属于 local daemon；启用 `OAH_LOCAL_API_AUTH=1` 时，`run/token` 会作为可选的本地 API bearer token，非 public API 路由会校验它。
- `.oah-local/` 只放 compose 生成配置和 fingerprint。

### `OAH_DEPLOY_ROOT`

`OAH_DEPLOY_ROOT` 是可选的部署发布根目录覆盖项。未设置时，`local:up`、`storage:sync` 和相关 benchmark 默认使用 `OAH_HOME`，再 fallback 到 `~/.openagentharness`。设置后，现有脚本会读取：

```text
$OAH_DEPLOY_ROOT/config/server.docker.yaml
$OAH_DEPLOY_ROOT/{models,runtimes,tools,skills,workspaces}
```

为了兼容旧 deploy root，脚本也会 fallback 到：

```text
$OAH_DEPLOY_ROOT/server.docker.yaml
$OAH_DEPLOY_ROOT/source/
```

本地 daemon / OAP 场景通常只需要：

```bash
export OAH_HOME="${OAH_HOME:-$HOME/.openagentharness}"
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

storage:
  sqlite:
    project_db_location: shadow

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

CLI 的 daemon lifecycle 命令按下面约定实现：

```bash
oah daemon init
oah daemon start
oah daemon status
oah daemon stop
oah daemon restart
oah daemon logs
oah daemon state
oah daemon maintenance --dry-run
oah version
oah update
oah rollback

oah tui
oah tui --workspace /path/to/repo
oah tui --runtime vibe-coding
oah web
oah models list
oah models add ./model.yaml
oah models default openai-default
oah runtimes list
oah tools list
oah tools enable docs-search
oah skills list
oah skills enable summarize
oah workspace:list --missing
oah workspace repair <workspace-id> --workspace /new/path/to/repo
oah workspace migrate-history --workspace /path/to/repo --dry-run
```

发布包安装时，`scripts/install.sh` 会把 release tarball 展开到 `OAH_HOME/versions/<version>`，再把 `OAH_HOME/current` 指向该版本，并写入 `OAH_HOME/bin/oah` 稳定 shim。`oah update` 下载新的 GitHub Release tarball、校验 `.sha256`、安装到新的 `versions/<version>` 并切换 `current`；`oah rollback` 可以切回已有版本。`config/`、`state/`、`logs/`、`models/`、`tools/`、`skills/` 和 `workspaces/` 不属于程序版本目录，升级时不应被覆盖。

`oah daemon init` 会从 CLI 包内置的 deploy-root assets 初始化 `OAH_HOME`，其中包含默认的 `config/daemon.yaml`、`server.docker.yaml`、runtimes、models、tools、skills 目录样例。源码 checkout 中同一命令优先使用仓库里的 `template/deploy-root`，因此开发模式和 packaged install 模式共享同一套目录语义。

这些本地资产命令默认读写 `OAH_HOME`。`models add` 会校验 model YAML schema 后复制到 `OAH_HOME/models`，`models default` 只修改 `config/daemon.yaml` 的 `llm.default_model`。`tools list` 和 `skills list` 读取的是 `OAH_HOME/tools` / `OAH_HOME/skills` 全局 catalog；`tools enable <name>` 和 `skills enable <name>` 才会把选中的能力写入当前 repo 的 `.openharness/tools` / `.openharness/skills`。需要作用到其他 repo 时使用 `--workspace /path/to/repo`，预览写入用 `--dry-run`，覆盖已有 workspace asset 用 `--overwrite`。

repo 移动或重命名后，`oah workspace:list --missing` 可以筛出 registry 中 rootPath 已不存在的本地记录；`oah workspace repair <workspace-id> --workspace /new/path/to/repo` 会把旧 workspace id 重新绑定到新的真实路径。修复会保留原 workspace id，因此 OAP shadow storage 中已有的 session、run、message 历史仍然归属于同一个 workspace；记录中的 `externalRef` 会更新为 `local:path:<resolved-path>`。

早期 repo-local 历史可以用 `oah workspace migrate-history` 迁移。命令会复制 `repo/.openharness/data/history.db` 到 `OAH_HOME/state/data/workspace-state/<workspace-id>/history.db`，并同时复制存在的 `history.db-wal` / `history.db-shm`。迁移不会删除或修改原始 repo-local 数据库；`--dry-run` 只预览，目标 shadow 数据库已存在时默认拒绝，使用 `--overwrite` 时会先备份旧 shadow 数据库并写入 `history.migration.json` 记录。

`oah tui` 应：

1. 解析 `OAH_HOME`，缺省为 `~/.openagentharness`。
2. 如果 home 不存在，用 `template/deploy-root` 初始化。
3. 如果 daemon 未运行，使用 `config/daemon.yaml` 启动。
4. 没有显式 `--workspace` 且没有显式 `--base-url` 时，将当前目录作为本地 workspace。
5. 如果传入 `--runtime <name>` 且 workspace 目录没有 `.openharness/`，先用 runtime 模板 bootstrap；已有 `.openharness/` 时保持现有 OAS 配置。
6. 注册或打开传入 workspace。
7. 通过 daemon API 进入 TUI，并默认恢复该 workspace 最近 session；无 session 时自动创建，`--new-session` 可显式新建。
8. 如发现早期 repo-local `.openharness/data/history.db`，提示可使用 `oah workspace migrate-history --dry-run` 检查迁移。

`oah web` 会优先使用已经构建好的 WebUI static bundle，并在同一进程内代理 `/api`、`/internal`、`/healthz`、`/readyz` 到当前 OAH-compatible API endpoint。源码 checkout 中如果找不到 WebUI dist，则回退到 `@oah/web` 的 Vite dev server。

`oah daemon state` 用于查看 `OAH_HOME/state` 的磁盘占用，包括按 workspace 汇总的 shadow SQLite history 与 materialization cache。`oah daemon maintenance` 会对本地 shadow SQLite 数据库执行 checkpoint / vacuum；默认检测到 daemon 正在运行时拒绝执行，避免影响活跃 run，需要人工确认时再使用 `--force`。`oah workspace cleanup <workspace-id>` 默认只清理指定 workspace 的可重建 materialized/cache 状态，不删除 session / run / event history；预览使用 `--dry-run`。如需删除该 workspace 的历史，先用 `--include-history --dry-run` 预览，再用 `--include-history` 并输入 workspace id 二次确认。

## SQLite Shadow Storage

OAP daemon 默认让普通可写 project workspace 的运行时历史写入 `OAH_HOME/state` 下的 shadow storage：

```text
~/.openagentharness/state/data/workspace-state/<workspace-id>/history.db
```

这样打开外部 repo 时不会默认生成 repo-local `.openharness/data/history.db`。配置项是：

```yaml
storage:
  sqlite:
    project_db_location: shadow
```

需要兼容旧的 workspace-local history 时，可以显式设置为 `workspace`。

推荐迁移方式是保持默认 `shadow`，然后执行：

```bash
oah workspace migrate-history --workspace /path/to/repo --dry-run
oah workspace migrate-history --workspace /path/to/repo
```

如果 repo 已经移动且旧 workspace id 需要保留，先执行 `workspace repair`，再把旧 id 传给迁移命令：

```bash
oah workspace repair <workspace-id> --workspace /new/path/to/repo
oah workspace migrate-history <workspace-id> --workspace /new/path/to/repo
```

## 兼容原则

- 新建 root 使用扁平资产目录和 `config/server.docker.yaml`。
- 旧的 `OAH_DEPLOY_ROOT/source/*` 与根目录 `server.docker.yaml` 保持兼容。
- Local daemon 不读取 `.oah-local/*.generated.yaml`。
- Compose/K8S 不读取 `state/`、`logs/`、`run/`。
- K8S/Helm 的最终配置仍是标准 `server.yaml`，只是源 profile 可以存放在 deploy root 的 `config/` 下。
