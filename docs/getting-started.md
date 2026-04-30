# 快速开始

## 环境要求

| 工具 | 版本 |
| --- | --- |
| Node.js | 24+ |
| pnpm | 10+ |
| Docker + docker compose | 最新稳定版 |

## 安装与启动

### 第 1 步：安装依赖

```bash
pnpm install
```

### 第 2 步：启动本地整套服务

```bash
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
# 在 $OAH_DEPLOY_ROOT/models/ 下添加至少一个模型 YAML
pnpm local:up
```

这条命令会一次性启动本地整套 stack：`PostgreSQL`、`Redis`、`MinIO`、`oah-api`、`oah-controller`、`oah-compose-scaler`、`oah-sandbox`。其中 `oah-api` 对外监听 `http://127.0.0.1:8787`，`oah-sandbox` 在本地栈中承载 standalone worker，`oah-compose-scaler` 负责按 controller 目标副本数动态扩缩 `oah-sandbox`，并会在启动阶段自动执行一次 storage sync。

本地默认使用 `oah-sandbox + OSS/MinIO workspace_backing_store` 承载 active workspace copy。`oah-api` 不挂载持久 workspace volume，避免 API 容器累积已回收 workspace 的本地目录壳。

### 第 3 步：启动 WebUI

```bash
pnpm dev:web
```

打开 [http://localhost:5174](http://localhost:5174)。

如果你希望留在终端内操作，可以改用 TUI：

```bash
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

TUI 会连接同一个 `oah-api`，用于选择 workspace、进入 session、发送消息并查看流式输出。

## 验证是否正常

启动成功后检查以下几点：

1. `oah-api`、`oah-controller`、`oah-compose-scaler`、`oah-sandbox` 都启动成功
2. 浏览器能打开 `http://localhost:5174`
3. 或者 TUI 能连接 `http://127.0.0.1:8787` 并列出 workspace
4. 在 WebUI 或 TUI 里发送消息，Run 从 `queued` 进入执行状态
5. 如果当前 Run 还在执行，再发一条消息会先通过服务端 `/api/v1/sessions/{sessionId}/queue` 出现在输入框上方的队列里；如果希望立即打断当前 Run，可以点击 `引导`，底层会调用 `/api/v1/runs/{runId}/guide`

!!! tip
    如果后端地址不是默认值，启动前端时指定代理目标：
    ```bash
    OAH_WEB_PROXY_TARGET=http://127.0.0.1:8787 pnpm dev:web
    ```

## Single Workspace 模式

只服务一个 Workspace 时，跳过配置文件，直接指定路径：

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

可选参数：`--tool-dir`、`--skill-dir`、`--host`、`--port`

!!! info
    Single Workspace 模式下，WebUI 会自动进入唯一的 Workspace。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装依赖 |
| `OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root pnpm storage:sync` | 把部署根目录里的只读数据同步到 MinIO（默认不含 `workspaces`） |
| `OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root pnpm storage:sync -- --include-workspaces` | 连同 `workspaces` 一起同步到 MinIO |
| `OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root pnpm local:up` | 启动本地整套服务（`oah-api` / `oah-controller` / `oah-compose-scaler` / `oah-sandbox`） |
| `OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root OAH_SKIP_BUILD=1 pnpm local:up` | 复用本地已有 OAH 镜像，跳过 Docker 构建 |
| `OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1 pnpm local:up` | 仍通过 MinIO/rclone 模拟对象存储部署，但只在只读源目录变化时重新同步 |
| `OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root OAH_LOCAL_SKIP_READONLY_VOLUME_RECREATE=1 pnpm local:up` | 保留已有 rclone 只读卷，适合 Docker/rclone 插件未重启且只想快速重启服务 |
| `pnpm local:down` | 停止本地整套服务 |
| `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --api-only --config ./server.example.yaml` | 仅启动 `oah-api` |
| `pnpm exec tsx --tsconfig ./apps/controller/tsconfig.json ./apps/controller/src/index.ts -- --config ./server.example.yaml` | 单独启动 `oah-controller` |
| `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config ./server.example.yaml` | 单独启动 standalone worker（通常跑在 `oah-sandbox`） |
| `pnpm dev:web` | 启动 WebUI |
| `pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui` | 启动 TUI |
| `pnpm build` | 全量构建 |
| `pnpm test` | 运行测试 |
| `mkdocs serve` | 本地预览文档站 |

## 接下来

- [架构总览](./architecture-overview.md) — 理解系统整体结构
- [Workspace 配置](./workspace/README.md) — 配置 Agent、Skill、Tool
- [部署与运行](./deploy.md) — 本地一体 vs 生产拆分部署
- [TUI](./tui.md) — 了解终端入口
- [设计总览](./design-overview.md) — 理解核心设计决策

## 常见故障

### `failed to fetch anonymous token` / `auth.docker.io ... i/o timeout`

这是 Docker daemon 拉取基础镜像时的网络或 DNS 问题，不一定是仓库本身有问题。

- 如果本地已经有 `openagentharness-oah:latest`，可以直接跳过构建：
  ```bash
  OAH_DEPLOY_ROOT=/absolute/path OAH_SKIP_BUILD=1 pnpm local:up
  ```
- 旧版本本地环境如果已经缓存的是 `openagentharness-oah-api` / `openagentharness-oah-controller` / `openagentharness-oah-sandbox`，`local:up` 现在也会自动识别并回退到 `--no-build`
- 如果必须重新构建，先确认 Docker Desktop 自身能访问 Docker Hub，再重试。

### 本地对象存储模拟的启动优化

`local:up` 默认保持生产形态：把 deploy root 的只读源目录同步到 MinIO，并通过 rclone Docker volume 挂载到容器内。重复启动时可以按场景降低固定开销：

- `OAH_LOCAL_SYNC_ON_CHANGE_ONLY=1`：只读源目录的文件清单、大小或 mtime 没变时跳过 `pnpm storage:sync`，对象存储仍然是运行时读取来源。
- `OAH_LOCAL_SKIP_READONLY_VOLUME_RECREATE=1`：不重建 rclone 只读卷。仅在 Docker Desktop 和 rclone 插件没有重启、且你不需要修复插件 path drift 时使用。
- `OAH_LOCAL_SKIP_REDIS_FLUSH=1`：保留 Redis 协调状态。通常排查队列/调度残留时才用；默认会清空以避免旧本地状态影响测试。
- `OAH_MINIO_GOMEMLIMIT` / `OAH_MINIO_GOMAXPROCS`：调整本地 MinIO 的 Go 运行时资源默认值。默认分别是 `128MiB` 和 `1`，仍然保留 MinIO + rclone 的对象存储模拟路径。
- `OAH_API_NODE_OPTIONS` / `OAH_CONTROLLER_NODE_OPTIONS` / `OAH_SANDBOX_NODE_OPTIONS`：覆盖本地 OAH Node 进程的默认 V8 heap 参数。默认值会让空闲堆更早收敛，生产压测或大任务可以按需调高。
- `OAH_POSTGRES_SHARED_BUFFERS` / `OAH_POSTGRES_MAX_CONNECTIONS` / `OAH_REDIS_HEALTHCHECK_INTERVAL` 等 Compose 环境变量可继续覆盖本地数据库和健康检查默认值。

### `VolumeDriver.Get ... context deadline exceeded`

这通常表示 `rclone` Docker volume 插件卡住了。一个明显信号是 `docker volume ls` 或 `docker volume inspect <name>` 也会长时间无响应。

按顺序尝试：

```bash
docker plugin disable -f rclone:latest
docker plugin enable rclone:latest
```

如果上面也卡住，重启 Docker Desktop。仍然不行时重新安装插件：

```bash
docker plugin rm -f rclone:latest
docker run --rm --privileged -v /var/lib/docker-plugins/rclone/config:/config -v /var/lib/docker-plugins/rclone/cache:/cache alpine:3.20 sh -lc 'mkdir -p /config /cache'
docker plugin install rclone/docker-volume-rclone:arm64 --grant-all-permissions --alias rclone
```
