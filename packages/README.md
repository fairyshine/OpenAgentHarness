# Packages Overview

`packages/` 目前的包边界整体上是合理的，主要问题已经不再是“包拆错了”，而是少数包内部还有明显的单文件实现偏重。

## 包职责

| Package | Responsibility |
| --- | --- |
| `@oah/api-contracts` | API schema、共享 DTO、catalog/engine event 合约 |
| `@oah/config` | 服务配置加载、workspace 发现、runtime 导入、平台模型与能力目录扫描 |
| `@oah/model-runtime` | 模型提供方适配、AI SDK 集成、MCP/tool server 装配 |
| `@oah/engine-core` | Agent Engine 核心编排、workspace 访问抽象、能力装配、运行执行主流程 |
| `@oah/storage-memory` | 轻量内存仓储实现，用于测试和简单场景 |
| `@oah/storage-postgres` | PostgreSQL 持久化实现 |
| `@oah/storage-sqlite` | SQLite 持久化实现 |
| `@oah/storage-redis` | Redis 协调层实现：事件总线、队列、worker/workspace lease、worker pool |

## 当前判断

当前仓库架构的“包边界”是清楚的：

- `api-contracts` 负责合约
- `config` 负责发现和配置解释
- `engine-core` 负责 Agent Engine 内核
- `storage-*` 负责存储与协调后端适配
- `model-runtime` 负责模型和外部 tool server 接入

也就是说，**跨包分层基本合理**。现在更值得持续优化的是 **包内结构**。

## 当前热点

按源码体量看，当前最值得继续拆分的文件是：

1. `packages/storage-redis/src/index.ts`
2. `packages/storage-sqlite/src/index.ts`
3. `packages/storage-postgres/src/index.ts`
4. `packages/config/src/index.ts`

其中：

- `storage-redis` 偏重是因为把 queue、event bus、worker registry、workspace registry、worker pool 都放在了一个入口文件
- `storage-sqlite` / `storage-postgres` 偏重是因为 schema、row mapper、repository 实现、factory 都放在同一文件
- `config` 偏重是因为 server config、object storage policy、workspace discovery、runtime 逻辑都叠在一个文件

## 已完成的整理方向

- `engine-core` 已经完成按子域分层：
  - `capabilities/`
  - `native-tools/`
  - `runtime/`
  - `types/`
  - `workspace/`
- `config` 已开始从单文件里抽出独立策略模块：
  - `src/object-storage.ts`

## 后续拆分建议

### `@oah/config`

建议继续按职责拆成：

- `server-config.ts`
- `object-storage.ts`
- `workspace-discovery.ts`
- `runtimes.ts`
- `models.ts`

### `@oah/storage-postgres`

建议继续按职责拆成：

- `schema.ts`
- `row-mappers.ts`
- `repositories/*.ts`
- `factory.ts`

### `@oah/storage-sqlite`

建议继续按职责拆成：

- `schema.ts`
- `migration.ts`
- `persistence-coordinator.ts`
- `repositories/*.ts`
- `factory.ts`

### `@oah/storage-redis`

建议继续按职责拆成：

- `event-bus.ts`
- `run-queue.ts`
- `worker-registry.ts`
- `workspace-lease-registry.ts`
- `workspace-placement-registry.ts`
- `run-worker.ts`
- `run-worker-pool.ts`

## 放置规则

以后在 `packages/` 下新增代码时，优先遵循：

1. 如果是在解释配置或发现 workspace 资源，放 `config`
2. 如果是在编排 agent runtime 生命周期，放 `engine-core`
3. 如果是在适配数据库或 Redis 协调原语，放对应 `storage-*`
4. 如果是在适配模型提供方或 MCP/tool server，放 `model-runtime`
5. 如果一个文件同时承担 schema、mapper、repository、factory 四种职责，就应该继续拆

## 一个简单阈值

下面任意两条同时满足，就优先考虑拆文件：

- 文件超过约 800 行
- 同时包含类型定义、序列化/映射、核心实现、工厂导出
- 已经出现 3 个以上明显的职责簇
- 修改一个功能时经常需要滚动跨越几百行
