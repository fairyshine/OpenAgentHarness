# 部署与运行

## 部署模式概览

| 模式 | 进程 | 依赖 | 适用场景 |
| --- | --- | --- | --- |
| **API + Worker 一体** | 1 个 `server` | PostgreSQL，Redis 可选 | 本地开发、PoC、单机部署 |
| **API + Worker 分离** | 1 个 `server --api-only` + N 个 `worker` | PostgreSQL + Redis | 生产环境、需要独立扩缩容 |
| **单 Workspace** | 1 个 `server --workspace <path>` | PostgreSQL，Redis 可选 | 只服务一个仓库或一个对话空间 |

> **tip**
> 不确定选哪个？先用「一体模式」跑通，后续随时可以切到分离部署。

---

## 本地开发

三个终端，最简路径：

```bash
# 终端 1 — 本地整套服务（PostgreSQL + Redis + MinIO + OAH）
export OAH_TEST_ROOT=/absolute/path/to/test_oah_server
pnpm local:up

# 终端 3 — 前端
pnpm dev:web
```

前端默认地址：`http://localhost:5174`

> **info**
> 首次运行前先执行 `pnpm install` 安装依赖。

---

## 分离部署

适用于模拟生产或真实生产环境。需要 Redis。

```bash
# 终端 1 — 本地基础设施
docker compose -f docker-compose.local.yml up -d postgres redis minio

# 终端 2 — API（不内嵌 Worker）
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- --config ./server.example.yaml --api-only

# 终端 3 — Worker（可启动多个实例）
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/worker.ts -- --config ./server.example.yaml

# 终端 4 — 前端
pnpm dev:web
```

API 进程只负责 HTTP 请求。Worker 进程消费 Redis 队列、执行 Run、同步 history mirror。

---

## 单 Workspace 模式

跳过多 Workspace 目录结构，直接指定一个 workspace 路径：

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--workspace-kind project\|chat` | workspace 类型，默认 `project` |
| `--tool-dir <path>` | 公共 tool 目录 |
| `--skill-dir <path>` | 公共 skill 目录 |
| `--host <addr>` | 监听地址，默认 `127.0.0.1` |
| `--port <num>` | 监听端口，默认 `8787` |

> **warning**
> 单 Workspace 模式下，workspace 管理接口（`POST /workspaces`、`DELETE /workspaces/:id` 等）会被禁用。

---

## 启动检查

服务启动后，用以下端点验证状态：

| 端点 | 用途 | 正常响应 |
| --- | --- | --- |
| `GET /healthz` | 进程存活检查 | `{ "status": "ok" }` |
| `GET /readyz` | 就绪检查（含依赖） | `{ "status": "ready" }`，未就绪返回 503 |

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

额外确认项：

- 服务日志中打印了当前运行模式（`API + embedded worker` / `API only` / `standalone worker`）
- 发送消息后 Run 能从 `queued` 推进到执行
- 分离部署时 Worker 日志中有队列消费记录

---

## 环境变量

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 | `postgres://oah:oah@127.0.0.1:5432/open_agent_harness` |
| `REDIS_URL` | Redis 连接串 | `redis://127.0.0.1:6379` |
| `OAH_WEB_PROXY_TARGET` | 前端代理目标（后端地址不是默认时使用） | `http://127.0.0.1:8787` |

在 `server.yaml` 中通过 `${env.DATABASE_URL}` 语法引用环境变量。

本地开发使用 `docker-compose.local.yml` 启动的容器时，默认连接串为：

```yaml
storage:
  postgres_url: postgres://oah:oah@127.0.0.1:5432/open_agent_harness
  redis_url: redis://127.0.0.1:6379
```
