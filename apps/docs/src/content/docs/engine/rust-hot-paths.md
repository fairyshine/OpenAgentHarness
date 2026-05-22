---
title: "Rust 热路径优化总结"
---

# Rust 热路径优化总结

本文替代根目录旧的 `refine_with_rust.md` 阶段日志，只保留当前仍有决策价值的结论。

## 边界

Rust 只用于可测量的本地系统热路径：

- workspace sync
- workspace materialization
- sandbox seed upload / prepared-seed reuse
- directory scan、fingerprint、diff planning

TypeScript 仍负责路由、配置语义、runtime 初始化编排、业务规则和 fallback。Rust 不作为 server rewrite 方向。

## 已确立的方向

- native 代码放在 `native/`
- 集成方式优先是 sidecar binary / persistent worker
- `native/oah-workspace-sync` 是 workspace 生命周期主热路径
- TS fallback 必须保持语义一致
- native persistent mode 是优先路径；oneshot 仅作为 fallback / benchmark control

当前主路径默认倾向：

- `OAH_NATIVE_WORKSPACE_SYNC=1`
- `OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT=1`
- `OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT=primary`
- `OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES=1`

## 已完成的主要能力

`native/oah-workspace-sync` 已覆盖：

- local scan / fingerprint
- local-to-remote sync
- remote-to-local sync / materialization
- bundle-backed push / pull / hydrate
- persistent worker ready handshake、pool sharing、prewarm
- in-process ustar bundle writer
- constrained ustar extractor
- seed archive build
- runtime/tool/skill local-tree materialization
- deploy-source fingerprint acceleration

Archive export 的 Rust worker 仍保留，但它不再是 Rust 优化策略的主线。

## 测量结论

当前数据支持继续把 Rust 用在 workspace 文件系统热路径：

- larger-sample bundle build 曾约 `55ms`，Rust writer 后约 `11ms`
- native persistent cold push 在 writer on/off control 中约从 `97ms` 降到 `45ms`
- `1024 files x 4 KiB` materialize 约从 `127ms` 降到 `78-96ms`
- pull 约从 `113ms` 降到 `78ms`
- Docker-limited prepared-seed warm prepare：native persistent 约 `35ms`，TS 约 `86ms`
- real runtime warm prepare：native persistent 约 `6.5ms`，TS 约 `22.5ms`

当前剩余瓶颈更多在 upload、file creation / materialization cost、以及更大 runtime mix 的 Docker-constrained 验证，而不是 server orchestration。

## 不再推进的方向

以下内容暂不迁入 Rust：

- runtime settings merge
- tool command rewrite
- `AGENTS.md` 写入
- explicit runtime skill 写入
- session / queue / model / SSE / Fastify route orchestration
- Postgres repository mapping

这些路径要么不是当前瓶颈，要么由外部系统和业务语义主导。

## 后续重点

下一轮只应沿着已验证的热路径继续：

- 降低 bundle upload 和 materialization 剩余成本
- 测量更大的 real runtime mix，尤其是 Docker CPU / memory 受限环境
- 继续优化 native local-tree materialization 的 copy kernel
- 保持 TS fallback 与 native 行为一致
- 继续拆小 native 模块，避免 `main.rs` 重新膨胀

Rust scope 扩大前必须有新的 benchmark 证据。
