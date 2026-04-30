# OAP Daemon Roadmap

OAP（Open Agent Harness Personal）是 OAH 的个人部署形态。它面向本地单用户使用，目标是用一个常驻 daemon 提供完整 OAH-compatible API，让 WebUI、TUI 和 Desktop 都能连接同一套本地服务。

## 1. Product Target

最终面向用户的入口应收敛到：

```bash
oah daemon start
oah tui --workspace /path/to/repo
```

更完整的本地工作流：

```bash
oah daemon init
oah daemon start
oah daemon status
oah daemon logs
oah daemon stop

oah tui --workspace /path/to/repo
oah web
oah models list
oah models add ./model.yaml
oah models default openai-default
```

`oah tui --workspace /path/to/repo` 应是个人使用的主入口：

1. 解析 `OAH_HOME`，默认 `~/.openagentharness`。
2. 如果 home 不存在，则从 `template/deploy-root` 初始化。
3. 如果 daemon 未运行，则自动启动或提示启动。
4. 将 `/path/to/repo` 注册为 workspace，或复用已有 workspace 记录。
5. 通过本地 OAH API / SSE 进入 TUI。

## 2. Positioning

OAP 不是 OAH 的 fork，也不是一套新协议。它是 OAH-compatible 的 personal deployment profile。

```text
WebUI       ┐
TUI         ├── OAH API ── OAH enterprise server
Desktop    ┘          └── OAP local daemon
```

OAH 与 OAP 的差异在部署形态，不在客户端协议：

| 维度 | OAH enterprise | OAP personal |
| --- | --- | --- |
| 用户 | 团队、平台、企业部署 | 本地单用户 |
| 进程 | `oah-api` + `oah-controller` + `oah-sandbox` | local daemon，一进程优先 |
| Worker | standalone workers / sandbox fleet | embedded worker |
| 存储 | PostgreSQL + Redis + object storage | SQLite + local disk |
| 配置 | `OAH_DEPLOY_ROOT/config/server.docker.yaml` 或 K8S profile | `OAH_HOME/config/daemon.yaml` |
| 资产 | deploy root 同步 / 发布 | home 下直接读取 |
| 客户端 | WebUI / TUI / Desktop | 同一套 WebUI / TUI / Desktop |

## 3. Deployment Identity And Capabilities

WebUI、TUI、Desktop 都应同时兼容 OAH enterprise server 和 OAP local daemon。为了避免客户端靠端口、URL、配置猜测部署形态，OAH-compatible server 应提供一个稳定的 profile endpoint。

Desktop 不应被定义成 OAP-only client。它是通用 OAH-compatible client；连接 OAP local daemon 时，才根据 profile / capabilities 额外显示 daemon supervisor、local logs、本地模型/工具/技能管理等能力。

建议 API：

```http
GET /api/v1/system/profile
```

建议响应：

```json
{
  "apiCompatibility": "oah/v1",
  "product": "open-agent-harness",
  "edition": "enterprise",
  "runtimeMode": "kubernetes",
  "deploymentKind": "oah",
  "displayName": "OAH enterprise server",
  "capabilities": {
    "localDaemonControl": false,
    "localWorkspacePaths": false,
    "workspaceRegistration": true,
    "storageInspection": true,
    "modelManagement": false,
    "localDaemonSupervisor": false
  }
}
```

OAP local daemon 则应返回：

```json
{
  "apiCompatibility": "oah/v1",
  "product": "open-agent-harness",
  "edition": "personal",
  "runtimeMode": "daemon",
  "deploymentKind": "oap",
  "displayName": "OAP local daemon",
  "capabilities": {
    "localDaemonControl": true,
    "localWorkspacePaths": true,
    "workspaceRegistration": true,
    "storageInspection": true,
    "modelManagement": true,
    "localDaemonSupervisor": true
  }
}
```

客户端使用原则：

- WebUI / TUI / Desktop 连接后先读取 profile。
- UI 明确展示当前连接的是 `OAH enterprise server` 还是 `OAP local daemon`。
- `--workspace /local/path`、daemon logs、local model/tool/skill 管理等只在 `edition=personal` 且 capability 允许时启用。
- 连接远端 OAH 时，不显示 stop daemon、open local logs、register local path 等个人本地专属操作。
- profile 与 capabilities 是客户端行为判断依据，不能只依赖 `localhost`、端口或用户手工选择。

## 4. Single Workspace Mode

`--workspace` single workspace server mode 最初是为了简化服务部署：绕过多 workspace registry，直接让 server 服务一个 repo。

有了 OAP 后，这条路线不再作为主要产品路径继续推进。新的简化模型是：

```bash
oah daemon start
oah tui --workspace /path/to/repo
```

迁移原则：

- `--workspace` server mode 保留为短期开发/测试兼容入口。
- README 和用户文档逐步从 single workspace mode 转向 OAP daemon。
- 新功能优先落到 daemon + workspace registry 路径，不再优先增强 single workspace server mode。
- 等 OAP workspace 注册、SQLite shadow storage、TUI 自动连接成熟后，将 single workspace mode 标记为 deprecated。

## 5. Directory Contract

OAP 默认使用：

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

约定：

- `OAH_HOME` 默认是 `~/.openagentharness`。
- 本机个人使用时，`OAH_DEPLOY_ROOT` 可以默认等于 `OAH_HOME`。
- `models/`、`runtimes/`、`tools/`、`skills/`、`workspaces/` 是 OAH / OAP 可互通的平台资产。
- `state/` 存 SQLite、workspace shadow、archive、materialization cache 等本地私有状态。
- `logs/` 和 `run/` 属于 daemon 生命周期，不参与 deploy root 发布。
- `config/daemon.yaml` 是 OAP 的源配置。
- `config/server.docker.yaml` 和 `config/kubernetes.server.yaml` 保留为从个人环境迁移到 Compose / K8S 的 profile。

## 6. Runtime Model

OAP daemon 默认应是：

- API server + embedded worker in one process
- no PostgreSQL
- no Redis
- no object storage
- no standalone sandbox fleet
- local disk execution by default
- SQLite for sessions, runs, messages, queues, registry metadata, and local history

它仍然应复用 OAH 的核心模块：

- API routes
- SSE event stream
- workspace registry
- engine-core
- model runtime
- tool / skill loading
- runtime import / initialization
- storage abstraction

OAP 不应该引入另一套 client SDK 或另一套 TUI 协议。

## 7. Roadmap Phases

Status values:

- `done`: 已完成或足够稳定，不再作为 OAP active work 跟踪
- `in progress`: 已有基础，仍需继续实现
- `planned`: 方向明确，但尚未开始

### Phase 0: Home / Deploy Root Alignment

Status: in progress

Objective: 让 `OAH_HOME` 与 `OAH_DEPLOY_ROOT` 共享一套扁平资产结构，并保留多 deployment profile。

Completed:

- `template/deploy-root` 已扁平化为 `models/`、`runtimes/`、`tools/`、`skills/`、`workspaces/`。
- `config/server.docker.yaml` 已成为 Compose 默认 profile。
- `config/daemon.yaml` 已作为 local daemon profile 模板。
- `config/kubernetes.server.yaml` 已作为 K8S / Helm profile 模板。
- sync scripts 已优先识别扁平 root，并 fallback 到 legacy `source/`。
- `docs/home-and-deploy-root.md` 已记录目录契约。

Next:

- 提供 `oah daemon init` 或等价 bootstrap helper，初始化 `OAH_HOME`。
- 初始化时避免覆盖用户已有 config、models、runtimes、tools、skills。
- 为 `OAH_HOME` 写入版本标记，支持后续迁移。

Completion target:

- 空机器上执行 `oah daemon init` 后，`~/.openagentharness` 可直接启动 daemon。

### Phase 1: Deployment Identity API

Status: planned

Objective: 让每个 OAH-compatible server 明确自报当前是 OAH enterprise server 还是 OAP local daemon，并暴露客户端可用能力。

Required endpoint:

```http
GET /api/v1/system/profile
```

Required fields:

- `apiCompatibility`: API compatibility string, initially `oah/v1`
- `product`: product family, initially `open-agent-harness`
- `edition`: `enterprise` or `personal`
- `runtimeMode`: `daemon`, `embedded`, `compose`, `kubernetes`, or `split`
- `deploymentKind`: `oah` or `oap`
- `displayName`: short user-facing label
- `capabilities`: feature flags for client behavior

Initial capability flags:

- `localDaemonControl`
- `localWorkspacePaths`
- `workspaceRegistration`
- `storageInspection`
- `modelManagement`
- `localDaemonSupervisor`

Completion target:

- WebUI、TUI、Desktop 都能通过同一个 endpoint 判断当前连接目标。
- 客户端不再用 URL、端口或是否 localhost 来推断 OAH/OAP。

### Phase 2: Daemon Lifecycle CLI

Status: planned

Objective: 把当前开发期命令：

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --config "$OAH_HOME/config/daemon.yaml"
```

收敛成：

```bash
oah daemon start
```

Required commands:

- `oah daemon init`
- `oah daemon start`
- `oah daemon status`
- `oah daemon stop`
- `oah daemon restart`
- `oah daemon logs`

Daemon lifecycle requirements:

- PID file under `OAH_HOME/run/daemon.pid`
- local API token under `OAH_HOME/run/token` or equivalent secure local credential
- stdout/stderr logs under `OAH_HOME/logs/`
- health check against `http://127.0.0.1:8787`
- stale PID detection
- port conflict detection and actionable error output
- graceful shutdown before force kill

Completion target:

- 用户不需要知道 `tsx`、`apps/server/src/index.ts`、`--config` 或 repo-internal package layout。

### Phase 3: Workspace Registration

Status: planned

Objective: 用 daemon-managed workspace registry 替代 single workspace server mode。

Target command:

```bash
oah tui --workspace /path/to/repo
```

Expected behavior:

- 规范化 repo path。
- 如果 workspace 不存在，则创建 workspace record。
- 如果 workspace 已存在，则复用原有 workspace id、sessions 和 settings。
- 对外部 repo workspace，不要求复制到 `OAH_HOME/workspaces`。
- 对受管 workspace，可以放在 `OAH_HOME/workspaces`。
- TUI 默认连接本地 daemon，也可通过 `--base-url` 连接远端 OAH。
- 如果连接的是 OAH enterprise server，`--workspace /local/path` 应拒绝或提示切换到 OAP local daemon，除非 server profile 显式声明支持 local path registration。

Open design questions:

- 外部 repo workspace 的 `externalRef` 格式是否需要稳定为 `local:path:<abs-path>`。
- workspace name 默认用 repo basename，还是从 git remote / package metadata 推导。
- 如果同一路径被移动或重命名，是否提供 `oah workspace repair`。

Completion target:

- `oah tui --workspace /path/to/repo` 不再需要启动一个专属 server 进程。

### Phase 4: SQLite Shadow Storage

Status: planned

Objective: OAP 的会话、run、message 和 history 默认留在 `OAH_HOME/state`，避免污染用户 repo。

Current gap:

- `@oah/storage-sqlite` 当前对普通可写 project workspace 会优先写入 `<workspace>/.openharness/data/history.db`。
- OAP 更希望外部 repo workspace 的会话数据默认写入 home shadow storage。

Proposed config:

```yaml
storage:
  sqlite:
    project_db_location: shadow
```

or:

```yaml
storage:
  sqlite:
    force_shadow: true
```

Expected storage layout:

```text
~/.openagentharness/state/
  oap.sqlite
  workspaces/
    <workspace-id>/
      history.db
      materialization/
      archive/
```

Completion target:

- 打开任意外部 repo 后，OAP 不会默认生成 repo-local `.openharness/data/history.db`。
- 用户明确选择 workspace-local storage 时，才写入 repo-local `.openharness/data/history.db`。

### Phase 5: Local Config And Asset Management

Status: planned

Objective: 让个人用户可以通过 CLI 管理模型、tools、skills 和默认 runtime，而不是手改 YAML。

Target commands:

```bash
oah models list
oah models add ./model.yaml
oah models default openai-default
oah runtimes list
oah tools list
oah skills list
```

Requirements:

- 修改 `OAH_HOME/models`、`tools`、`skills` 下的资产。
- 校验 YAML schema。
- 修改 `config/daemon.yaml` 中的 `llm.default_model`。
- 不影响 `config/server.docker.yaml` / `config/kubernetes.server.yaml`，除非用户显式同步 profile。

Completion target:

- OAP 用户能在不理解 deploy root 内部细节的情况下完成基本模型和能力配置。

### Phase 6: WebUI And TUI Client Defaults

Status: planned

Objective: 客户端默认面向 OAP 本地 daemon，但仍可连接远端 OAH enterprise server。

Shared client requirements:

- 连接后先读取 `GET /api/v1/system/profile`。
- 明确展示当前环境：`OAP local daemon` 或 `OAH enterprise server`。
- 根据 `capabilities` 控制 UI、命令和错误提示。

TUI requirements:

- `oah tui --workspace /path/to/repo` 默认连接本地 daemon。
- 如果 daemon 未运行，提示启动或自动启动。
- 支持 `--base-url` 覆盖到远端 OAH，并根据 profile 禁用个人本地专属行为。
- 支持 `--token` 或读取 local daemon token。
- workspace 创建 / 复用失败时给出明确修复建议。

Web requirements:

- `oah web` 可以打开本地 WebUI。
- WebUI 默认读本地 daemon endpoint。
- 仍支持手动配置远端 OAH endpoint。
- 连接远端 OAH 时不显示 local daemon control。

Completion target:

- 个人用户主要记住两个命令：`oah daemon start` 与 `oah tui --workspace .`。

### Phase 7: Desktop App

Status: planned

Objective: Electron 桌面端作为通用 OAH-compatible client。它既能连接远端 OAH enterprise server，也能连接 OAP local daemon；连接 OAP 时，可以额外承担 local daemon supervisor 职责。

Desktop responsibilities:

- 配置和切换 OAH-compatible API endpoint。
- 读取 server profile，并展示当前连接的是 OAH enterprise server 还是 OAP local daemon。
- 管理 endpoint token。
- 提供模型、tools、skills、workspace 和 session 的 GUI。
- 内嵌或打开 WebUI。
- 连接 OAP local daemon 时，检查 / 初始化 `OAH_HOME`。
- 连接 OAP local daemon 时，启停 local daemon、查看日志、管理本地 endpoint 和 token。
- 根据 server profile 判断是否显示 local daemon supervisor 功能。

Non-goals:

- 不 fork OAH API。
- 不在 Electron renderer 内直接跑 engine。
- 不绕过 daemon 直接读写 session DB。
- 连接远端 OAH 时，不显示本地 daemon stop/restart/logs。

Completion target:

- Desktop、TUI、WebUI 连接同一套 OAH-compatible API；连接 OAP 时共享同一个 local daemon。

### Phase 8: Migration And Deprecation

Status: planned

Objective: 从 single workspace mode 平滑迁移到 OAP daemon。

Steps:

1. README 将 single workspace mode 移入 legacy / compatibility。
2. CLI 对 `--workspace` server mode 输出迁移提示。
3. 提供迁移脚本，把 repo-local `.openharness/data/history.db` 导入 `OAH_HOME/state`。
4. 测试覆盖 `oah tui --workspace` 的 create/reuse/session resume。
5. 正式标记 single workspace server mode deprecated。

Completion target:

- 简化部署的正式答案只有 OAP daemon；single workspace mode 只保留给内部测试或兼容旧脚本。

## 8. Near-Term Implementation Order

建议按这个顺序推进：

1. `GET /api/v1/system/profile` 与 deployment capabilities
2. `oah daemon init/start/status/stop/logs`
3. `OAH_HOME` bootstrap 与 daemon profile resolver
4. local daemon token、PID、logs、health check
5. `oah tui --workspace` 参数与 workspace register/reuse
6. SQLite shadow storage config
7. README 中将 single workspace mode 标记为 legacy
8. `oah models` / `oah runtimes` / `oah tools` / `oah skills`
9. `oah web`
10. Electron desktop client and local daemon supervisor
11. single workspace migration / deprecation

## 9. Acceptance Scenarios

### Fresh local user

```bash
oah daemon start
oah models add ./openai-default.yaml
oah tui --workspace ~/Code/my-repo
```

Expected:

- `~/.openagentharness` is initialized.
- daemon is running on `127.0.0.1:8787`.
- `/api/v1/system/profile` reports `edition=personal` and `runtimeMode=daemon`.
- workspace is registered.
- session data is stored under `OAH_HOME/state`.
- repo is not polluted by default.

### Existing OAH developer

```bash
export OAH_DEPLOY_ROOT=/Users/me/Code/test_oah_server
pnpm local:up
```

Expected:

- Compose path continues to work.
- `/api/v1/system/profile` reports an OAH enterprise-compatible profile.
- `config/server.docker.yaml` remains the source profile.
- flat deploy root assets sync to MinIO.

### Hybrid user

```bash
export OAH_HOME=~/.openagentharness
export OAH_DEPLOY_ROOT=$OAH_HOME
oah daemon start
```

Expected:

- personal daemon reads local assets directly.
- the same home can later be used as a deploy root source for Compose / K8S profiles.

## 10. Non-Goals

- OAP should not replace OAH enterprise deployment.
- OAP should not require Docker, PostgreSQL, Redis, MinIO, or Kubernetes.
- OAP should not introduce a new API protocol.
- OAP should not make Electron the runtime boundary.
- OAP should not continue single workspace mode as the primary simplification story.
