# 快速开始

这份文档把最常用的启动路径整理成一页，适合第一次接触 Open Agent Harness 的同学。

## 先选一条路径

| 目标 | 建议路径 |
| --- | --- |
| 先把项目跑起来 | 按本文从上到下操作 |
| 想理解模式差异 | 先看 [部署与运行](./deploy.md) |
| 只想跑文档站 | 直接看本文后半部分的“本地预览文档站”章节 |

!!! tip

    如果你是第一次上手，最省心的路线是：`pnpm infra:up` -> `pnpm dev:server -- --config ./server.example.yaml` -> `pnpm dev:web`。

## 1. 环境准备

建议先确认以下工具可用：

- `Node.js 20+`
- `pnpm 10+`
- `Docker` 与 `docker compose`
- `Python 3.10+`（仅在本地预览文档站时需要）

安装项目依赖：

```bash
pnpm install
```

建议在仓库根目录执行所有命令：

```bash
cd <项目根目录>
```

## 2. 启动本地基础设施

项目默认使用 PostgreSQL 和 Redis 作为存储与协调层。开发环境可以直接启动仓库内置的 compose 配置：

```bash
pnpm infra:up
```

关闭基础设施：

```bash
pnpm infra:down
```

## 3. 启动运行时

默认最省心的方式是直接启动 `server`，它会自动带上 embedded worker：

```bash
pnpm dev:server -- --config ./server.example.yaml
```

如果你要模拟生产拆分部署，可以分开启动：

```bash
pnpm dev:server -- --config ./server.example.yaml --api-only
pnpm dev:worker -- --config ./server.example.yaml
```

两种方式怎么选：

- 只是本地开发、联调、验证功能：用默认 `server`
- 想模拟生产架构或分离 API 与执行资源：用 `--api-only` + `worker`

## 4. 启动调试 Web 控制台

```bash
pnpm dev:web
```

默认访问地址：

- [http://localhost:5174](http://localhost:5174)

如果后端不在默认地址，可以这样指定代理目标：

```bash
OAH_WEB_PROXY_TARGET=http://127.0.0.1:8787 pnpm dev:web
```

## 5. 启动成功后怎么确认

跑起来后，通常可以快速检查这几件事：

1. 后端启动日志里能看到当前运行模式
2. 前端能打开 [http://localhost:5174](http://localhost:5174)
3. 发起 message 后，run 能从 `queued` 进入执行
4. 如果是拆分部署，`worker` 日志里能看到队列消费

## 6. 验证构建与测试

```bash
pnpm build
pnpm test
pnpm test:dist
```

## 7. 本地预览文档站

文档站使用 `mkdocs-material` 主题，依赖单独放在 `docs/requirements.txt`：

```bash
python3 -m pip install -r docs/requirements.txt
mkdocs serve
```

本地预览地址通常是：

- [http://127.0.0.1:8000](http://127.0.0.1:8000)

构建静态站点：

```bash
mkdocs build --strict
```

## 8. 常见问题

### 为什么推荐先启动 `server`，而不是先拆 API / worker？

因为默认模式更接近“先跑通闭环”的目标，适合第一次确认配置、模型、workspace 和 Web 调试链路是否工作。

### Redis 没配也能跑吗？

可以。本地开发下，当前仍保留 in-process 执行语义；但如果你要模拟生产拆分部署，还是建议配上 Redis。

### 文档站改完后怎么避免坏链接？

优先执行：

```bash
mkdocs build --strict
```

它会比浏览器手点更早发现导航缺失和链接问题。

## 9. 推荐阅读顺序

如果你想快速建立整体认知，推荐按这个顺序看：

1. [首页](./index.md)
2. [设计总览](./design-overview.md)
3. [架构总览](./architecture-overview.md)
4. [部署与运行](./deploy.md)
5. [Workspace 导航](./workspace/README.md)
6. [Runtime 导航](./runtime/README.md)
7. [OpenAPI 导航](./openapi/README.md)

## 10. 常用命令速查

```bash
pnpm install
pnpm infra:up
pnpm dev:server -- --config ./server.example.yaml
pnpm dev:worker -- --config ./server.example.yaml
pnpm dev:web
pnpm build
pnpm test
mkdocs serve
mkdocs build --strict
```
