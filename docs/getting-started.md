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

### 第 2 步：启动基础设施

启动 PostgreSQL 和 Redis（开发用 Docker Compose）：

```bash
export OAH_TEST_ROOT=/absolute/path/to/test_oah_server
pnpm local:up
```

### 第 3 步：启动后端

```bash
pnpm local:up
```

本地整套服务会启动 `oah-api`、`oah-controller` 和 `oah-sandbox`。其中 `oah-api` 对外监听 `http://127.0.0.1:8787`，`oah-sandbox` 在本地栈中承载 standalone worker。

### 第 4 步：启动调试控制台

```bash
pnpm dev:web
```

打开 [http://localhost:5174](http://localhost:5174)。

## 验证是否正常

启动成功后检查以下几点：

1. `oah-api`、`oah-controller`、`oah-sandbox` 三个服务都启动成功
2. 浏览器能打开 `http://localhost:5174`
3. 在控制台发送消息，Run 从 `queued` 进入执行状态

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
    Single Workspace 模式下，调试控制台会自动进入唯一的 Workspace。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装依赖 |
| `OAH_TEST_ROOT=/absolute/path pnpm storage:sync` | 同步只读测试数据到 MinIO（默认不含 `source/workspaces`） |
| `OAH_TEST_ROOT=/absolute/path pnpm storage:sync -- --include-workspaces` | 连同 `source/workspaces` 一起同步到 MinIO |
| `OAH_TEST_ROOT=/absolute/path pnpm local:up` | 启动本地整套服务（`oah-api` / `oah-controller` / `oah-sandbox`） |
| `OAH_TEST_ROOT=/absolute/path OAH_SKIP_BUILD=1 pnpm local:up` | 复用本地已有 OAH 镜像，跳过 Docker 构建 |
| `pnpm local:down` | 停止本地整套服务 |
| `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --api-only --config ./server.example.yaml` | 仅启动 `oah-api` |
| `pnpm exec tsx --tsconfig ./apps/controller/tsconfig.json ./apps/controller/src/index.ts -- --config ./server.example.yaml` | 单独启动 `oah-controller` |
| `pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config ./server.example.yaml` | 单独启动 standalone worker（通常跑在 `oah-sandbox`） |
| `pnpm dev:web` | 启动调试控制台 |
| `pnpm build` | 全量构建 |
| `pnpm test` | 运行测试 |
| `mkdocs serve` | 本地预览文档站 |

## 接下来

- [架构总览](./architecture-overview.md) — 理解系统整体结构
- [Workspace 配置](./workspace/README.md) — 配置 Agent、Skill、Tool
- [部署与运行](./deploy.md) — 本地一体 vs 生产拆分部署
- [设计总览](./design-overview.md) — 理解核心设计决策

## 常见故障

### `failed to fetch anonymous token` / `auth.docker.io ... i/o timeout`

这是 Docker daemon 拉取基础镜像时的网络或 DNS 问题，不一定是仓库本身有问题。

- 如果本地已经有 `openagentharness-oah:latest`，可以直接跳过构建：
  ```bash
  OAH_TEST_ROOT=/absolute/path OAH_SKIP_BUILD=1 pnpm local:up
  ```
- 如果必须重新构建，先确认 Docker Desktop 自身能访问 Docker Hub，再重试。

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
