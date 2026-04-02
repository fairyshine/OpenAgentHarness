# Deploy And Run

这份文档专门整理 Open Agent Harness 的本地启动、联调和拆分部署方式。

当前推荐原则很简单：

- 本地开发、PoC、单机部署：默认直接启动 `server`
- 生产或分布式部署：`API only` + `standalone worker`

## 先做决策：你现在属于哪种场景

| 场景 | 推荐模式 |
| --- | --- |
| 第一次本地跑通 | `API + embedded worker` |
| 产品联调 | `API + embedded worker` |
| 模拟生产拆分部署 | `API only + standalone worker` |
| 生产环境多实例扩容 | `API only + standalone worker` |

## 运行模式

### `API + embedded worker`

这是默认模式。

特点：

- 启动一个 `server` 进程即可
- API 进程会自托管一个 embedded worker
- 如果配置了 Redis，embedded worker 会消费 Redis run queue
- 如果没有配置 Redis，run 会在当前 API 进程内直接执行

适合：

- 本地开发
- 产品联调
- PoC
- 单机自托管

### `API only`

这是显式拆分模式。

启动方式：

```bash
pnpm dev:server -- --config ./server.example.yaml --api-only
```

特点：

- 只启动 API
- 不托管 embedded worker
- 如果配置了 Redis，需要额外启动独立 worker
- 如果没有配置 Redis，当前仍保留本地 in-process 执行语义

适合：

- 模拟生产拆分部署
- 将 API 和执行层分开扩容

### `standalone worker`

这是独立 worker 模式。

启动方式：

```bash
pnpm dev:worker -- --config ./server.example.yaml
```

特点：

- 单独消费 Redis run queue
- 真正执行 queued runs
- 负责 history mirror sync

适合：

- 生产环境横向扩展
- API / worker 分离部署
- 资源隔离

## 启动前准备

先安装依赖：

```bash
pnpm install
```

如果使用本地 PostgreSQL 和 Redis：

```bash
pnpm infra:up
```

关闭本地基础设施：

```bash
pnpm infra:down
```

默认示例配置文件：

```bash
./server.example.yaml
```

## 最推荐的本地启动方式

只开 3 个终端 Tab。

### Tab 1：基础设施

```bash
cd <项目根目录>
pnpm infra:up
```

作用：

- 启动 PostgreSQL
- 启动 Redis

### Tab 2：后端

```bash
cd <项目根目录>
pnpm dev:server -- --config ./server.example.yaml
```

作用：

- 启动 API
- 默认自动托管 embedded worker
- 发 message 后 run 会从 `queued` 真正进入执行

启动成功后，日志里会打印当前模式，例如：

- `API + embedded worker`

### Tab 3：前端

```bash
cd <项目根目录>
pnpm dev:web
```

默认访问地址：

- [http://localhost:5174](http://localhost:5174)

建议你第一次就按这个方式跑，因为问题面最小，最容易定位是环境问题、配置问题还是业务问题。

## 模拟生产拆分部署

如果你想按更接近生产的方式联调，推荐开 4 个终端 Tab。

### Tab 1：基础设施

```bash
cd <项目根目录>
pnpm infra:up
```

### Tab 2：API

```bash
cd <项目根目录>
pnpm dev:server -- --config ./server.example.yaml --api-only
```

作用：

- 只启动 API
- 不托管 embedded worker

启动成功后，日志里会打印：

- `API only`

### Tab 3：Worker

```bash
cd <项目根目录>
pnpm dev:worker -- --config ./server.example.yaml
```

作用：

- 单独消费 Redis queue
- 执行 queued runs
- 做 history mirror sync

启动成功后，日志里会打印：

- `standalone worker`

### Tab 4：前端

```bash
cd <项目根目录>
pnpm dev:web
```

默认访问地址：

- [http://localhost:5174](http://localhost:5174)

## 启动后检查清单

不管你用哪种模式，建议至少确认下面几件事：

1. `server` 日志里出现当前运行模式
2. 前端页面能打开
3. 发起 message 后，run 能推进而不是长期停在 `queued`
4. 拆分部署时，`worker` 进程日志里能看到队列消费

## 常用命令速查

安装依赖：

```bash
pnpm install
```

启动基础设施：

```bash
pnpm infra:up
```

关闭基础设施：

```bash
pnpm infra:down
```

启动默认后端：

```bash
pnpm dev:server -- --config ./server.example.yaml
```

启动 API only：

```bash
pnpm dev:server -- --config ./server.example.yaml --api-only
```

启动独立 worker：

```bash
pnpm dev:worker -- --config ./server.example.yaml
```

启动前端：

```bash
pnpm dev:web
```

跑源码测试：

```bash
pnpm test
```

构建产物后再回归测试：

```bash
pnpm test:dist
```

构建项目：

```bash
pnpm build
```

## Web 代理说明

前端开发服务器会优先读取：

- `OAH_WEB_PROXY_TARGET`

如果没配，会自动尝试从这些配置推断后端地址：

- `OAH_CONFIG`
- `test_server/server.yaml`
- `server.yaml`

如果后端不在默认地址，可以显式指定：

```bash
OAH_WEB_PROXY_TARGET=http://127.0.0.1:8787 pnpm dev:web
```

## 推荐用法总结

- 想先跑通：只启动 `server`
- 想靠近生产：拆成 `api-only + worker`
- 想排查问题：优先看模式日志、队列消费和 run 状态推进

### 日常本地开发

```bash
pnpm infra:up
pnpm dev:server -- --config ./server.example.yaml
pnpm dev:web
```

### 模拟生产拆分

```bash
pnpm infra:up
pnpm dev:server -- --config ./server.example.yaml --api-only
pnpm dev:worker -- --config ./server.example.yaml
pnpm dev:web
```
