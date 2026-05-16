# OpenAgentHarness Memory 系统实现方向

## 结论

OpenAgentHarness 的长期记忆系统建议以 **Claude Code 风格的 project/workspace-scoped file memory** 作为主骨架，而不是优先实现 Hermes/OpenClaw 那种 user-centric global memory。

原因是 OAH 的核心边界本来就是 workspace：workspace 承载 runtime、tools、skills、models、sessions、runs 和执行环境。长期记忆最有价值的场景也大多发生在某个 workspace 内：

- 记住这个项目的长期协作背景。
- 记住本项目内用户反复给出的偏好和反馈。
- 记住架构决策、实验结论、约束和外部系统入口。
- 在后续 session、run、subagent 中复用这些项目上下文。
- 在 compaction、resume、fork、subagent handoff 时减少上下文损失。

因此，默认路线应是：

> 以 Claude Code 的 `MEMORY.md` 索引 + topic markdown 文件为骨架，吸收 OpenClaw 的 search/get、memory flush、promotion/dreaming 能力，借鉴 Hermes 的 cache、安全和 provider 边界。

## 设计定位

### 默认不是全局用户记忆

第一版不把“用户人生经历/跨所有 workspace 的全局画像”作为核心目标。

OAH 更需要的是：

- workspace memory
- project memory
- agent working memory
- session-to-session continuity
- compaction-safe context preservation

未来可以再增加 global user memory，但它应作为独立层，而不是和 workspace memory 混在一起。

### Memory 与现有 OAH 分层关系

OAH README 已经把 `.openharness/memory/MEMORY.md` 放在 OAS 用户规格层：

- OAR：runtime baseline，由平台/runtime 作者发布。
- OAS：用户导入的 workspace-level additions，包括 `AGENTS.md`、tools、skills、models、memory。
- Workspace：OAR baseline + OAS overlay 后的有效执行环境。

Memory 应属于 OAS/workspace overlay：

```text
workspace/
  .openharness/
    AGENTS.md
    memory/
      MEMORY.md
      topics/
      sessions/
      daily/
      proposals/
```

这样用户可以检查、编辑、迁移、删除，也能和 workspace lifecycle、archive、export、storage sync 保持一致。

## 目标架构

### 文件布局

建议采用如下结构：

```text
.openharness/
  memory/
    MEMORY.md
    topics/
      user.md
      feedback.md
      project.md
      references.md
    sessions/
      2026-05-15-api-debugging.md
    daily/
      2026-05-15.md
    dreams/
      DREAMS.md
    proposals/
      20260515123000-memoryremember-project-decision.md
```

各层职责：

| 路径 | 职责 |
| --- | --- |
| `MEMORY.md` | 长期记忆入口和索引，短、稳定、适合启动注入 |
| `topics/*.md` | 语义主题文件，保存 durable facts |
| `sessions/*.md` | session/run 边界摘要，保存较详细工作上下文 |
| `daily/*.md` | 工作日志，适合长时间 workspace 协作和按天回顾 |
| `dreams/DREAMS.md` | consolidation/promotion 的审阅记录 |
| `proposals/*.md` | `confirm-suggested` 策略下的待确认写入建议，不作为已确认 memory 参与默认召回 |

这五个部分都属于目标架构。实施上可以分阶段落地，但不再把 `daily/` 和 `dreams/` 视为可选组件。`daily/` 应作为低权重时间日志参与检索，而不是启动注入内容；`dreams/` 应作为整理、晋升、清理的审阅区，而不是直接回答时的高权重 memory。

### Memory 类型

沿用 Claude Code 的四类 taxonomy：

| 类型 | 保存内容 | 示例 |
| --- | --- | --- |
| `user` | 用户在当前 workspace 内的偏好、工作方式、相关背景 | 用户希望本项目回复简洁、先给结论 |
| `feedback` | 用户对 agent 行为的纠正或确认 | 不要在这个 repo 里 mock 数据库测试 |
| `project` | 不可从代码/git/文档重建的项目背景、决策、约束 | 某次架构选择是因为合规要求 |
| `reference` | 外部系统入口和用途 | 事故记录在某个 Linear/Grafana/Slack 位置 |

明确不保存：

- 可从代码直接读出的目录结构、函数、架构事实。
- git history、最近修改记录。
- 当前任务临时状态。
- 已在 `AGENTS.md` 或项目文档里的规则。
- 原始日志、长代码块、完整 transcript。

## 召回设计

### 第一阶段：启动注入 + 本地检索

第一版应先做低复杂度召回：

1. 启动或 run prompt 组装时加载 `MEMORY.md`。
2. 提供 `MemorySearch` 工具，先用 lexical search 或 SQLite FTS。
3. 提供 `MemoryRead` 工具，读取具体文件和行范围。
4. 在系统提示中要求：
   - 涉及过去决策、用户偏好、项目背景时先查 memory。
   - memory 是历史 claim，涉及当前代码状态时必须验证。

当前自动召回只读取 `topics/` 下的已确认长期 topic 文件；`sessions/`、`daily/`、`dreams/` 和 `proposals/` 不会自动注入主上下文，只能通过 `MemorySearch` / `MemoryRead` 或 CLI 显式查看。这样可以让低权重历史材料保持可检索，同时避免待确认 proposal 或 session 日志污染高权重长期记忆。

不建议第一版就上 vector DB。先把文件布局、权限、读写规则和 UI/CLI 可见性做稳。

### 第二阶段：LLM selector

当 topic 文件增多后，可以借鉴 Claude Code：

- 扫描 topic 文件 frontmatter。
- 构造 manifest：文件名、类型、description、mtime。
- 用小模型按当前 query 选最多 N 个相关文件。
- 再通过 `MemoryRead` 读取正文。

这比直接 embedding 更容易调试，也符合早期规模。

### 第三阶段：Hybrid retrieval

当 memory 规模继续变大，再借鉴 OpenClaw：

- SQLite FTS/BM25。
- 可选 embeddings。
- vector + keyword hybrid ranking。
- MMR 去重。
- temporal decay 降低陈旧 daily/session notes 权重。
- recall tracking 记录哪些 memory 经常被用到。

## 写入设计

### 写入触发语义

第一版应采用保守写入：长期记忆默认只在用户有明确意图时写入。明确意图包括：

- 直接指令：`记住`、`以后都这样`、`把这个加入 memory`、`忘记这个`。
- 明确纠正：用户指出 agent 的长期行为偏差，例如“以后不要在这个项目里 mock 数据库测试”。
- 明确确认：用户确认某个项目决策、偏好或外部引用需要长期保留。

主 agent 不应因为普通对话里出现了用户偏好、项目事实或经历，就自动写入 `topics/*.md`。对于不确定是否应长期保存的信息，应先询问用户，或者只写入 session summary 作为低权重原材料。

Memory 写入策略应由 runtime policy 控制，而不是写死在 prompt 或工具实现里。runtime 至少支持三档策略：

| Policy | 行为 |
| --- | --- |
| `explicit-only` | 只响应用户明确 remember/forget/update 指令 |
| `confirm-suggested` | agent 可提出 memory 写入建议，但必须用户确认后写入 |
| `auto-extract` | 后台 extraction agent 可自动维护 memory，但所有写入可审计、可撤销 |

推荐默认值是 `explicit-only`。团队或长期个人 workspace 可以选择 `confirm-suggested`；`auto-extract` 应作为高级选项，默认关闭。

policy 应支持分层覆盖：

1. platform default：产品级默认策略。
2. workspace policy：项目或团队 workspace 的默认策略。当前已支持 `.openharness/settings.yaml` 中的 `engine.workspace_memory.write_policy`。
3. agent policy：不同 agent 可有不同写入权限。当前已支持 agent frontmatter 中的 `policy.workspace_memory.write_policy`。
4. session override：单个 session 可临时设置 `workspaceMemory.writePolicy`，例如长期会话提升到 `auto-extract` 或临时降到 `explicit-only`。
5. run override：单次 message/action run 可通过 `workspaceMemory.writePolicy` 覆盖 session/agent/workspace 策略。

最终执行时由 runtime 解析有效 policy，再决定是否允许 `MemoryRemember` / `MemoryUpdate` / `MemoryForget` / `MemoryCaptureSession` 执行、是否需要用户确认、是否只生成 pending proposal。当前已实现 workspace、agent、session、run 四层 `explicit-only` / `confirm-suggested` / `auto-extract` 解析，优先级为 `run > session > agent > workspace > explicit-only`；`confirm-suggested` 会把写入建议保存到 `.openharness/memory/proposals/*.md`，不直接修改目标 memory 文件；用户确认后可通过 `MemoryApplyProposal` 应用，拒绝时通过 `MemoryRejectProposal` 标记为 rejected；后台 extraction 只有在有效 `write_policy: auto-extract` 时运行。

### 显式写入

当用户说“记住/忘记/以后都这样”时，主 agent 应直接更新 memory：

- `remember`：写入 topic 文件，必要时更新 `MEMORY.md` 索引。
- `forget`：查找并删除或改写相关条目。
- `update`：优先更新已有文件，避免重复。

写入应返回可读反馈，告诉用户保存到了哪里。

### Session-boundary capture

每个 session/run 结束、reset、fork、archive 前，可以生成一个短 session summary：

```text
.openharness/memory/sessions/YYYY-MM-DD-<slug>.md
```

它保存：

- 本次目标。
- 关键用户指令。
- 已完成事项。
- 重要发现。
- 后续未完成事项。
- 相关文件。

这不是长期记忆正文，而是后续 search 和 consolidation 的原材料。

session summary 可以默认开启，因为它不是高权重长期记忆，也不应直接注入启动上下文。它主要服务后续检索、compaction 前 flush、人工回顾和 consolidation。

### Turn-end extraction

第二阶段加入后台 extraction agent：

- 在自然回合结束后运行。
- 只看最近新增消息。
- 只允许读上下文、读 memory、写 memory 目录。
- 如果主 agent 本轮已经写 memory，则跳过。
- 输出应该是更新 existing memory，而不是盲目新增。

这是 Claude Code 最值得借鉴的部分：把记忆维护从主回答路径中拆出来，但仍保持文件可读可改。

### Consolidation / Dreaming

后续可以借鉴 OpenClaw/Claude Code autoDream：

- 定期扫描 session summaries 和 daily notes。
- 识别重复出现、被多次 recall、跨查询仍有价值的内容。
- 提议晋升到 `MEMORY.md` 或 `topics/*.md`。
- 先 preview，再 apply。
- 把整理过程写入 `dreams/DREAMS.md` 供人审阅。

长期记忆不应由单次事件直接无限堆积，应有晋升和清理机制。

## 与 Compaction 的关系

Memory 系统必须和 compaction 协作。

建议顺序：

1. 当 session 接近 context 上限时，先触发 memory flush。
2. memory flush 让 agent 通过 `MemoryCaptureSession` 保存“压缩后不能丢”的 durable context。
3. 再执行 compaction，生成 compact summary。
4. compact summary 只服务当前 session 续接，不覆盖长期 memory。

这避免重要信息只存在于即将被压缩的 transcript 里。

当前已实现 compaction 前 workspace memory flush：当手动或自动 compaction 确认会压缩早期消息时，runtime 会先把即将被压缩掉的消息片段写入 `.openharness/memory/sessions/*.md`，并在 run step 中记录 `workspace_memory_compaction_flush`。这个 flush 属于低权重 session memory，不会替代 compact summary，也不会自动晋升为 topic。

## 工具与 API 草案

### Agent tools

OAH 当前公开 native tools 使用 PascalCase，例如 `Read`、`Write`、`TodoWrite`、`AgentSwitch`、`SubAgent`。Memory 是 runtime context 的核心能力，建议作为原生工具加入，而不是挂在 workspace action 上。OpenClaw 的 `memory_search` / `memory_get` 只作为参考实现名，不作为 OAH 最终命名。

第一阶段建议提供两个只读 native tools：

```text
MemorySearch(query, maxResults?, corpus?)
MemoryRead(path, from?, lines?)
```

`MemoryRead` 比 `MemoryGet` 更贴近 OAH 现有 `Read` 工具语义；如果希望强调“两段式 search/get”模型，也可以命名为 `MemoryGet`，但需要在整体工具命名里保持一致。

第二阶段再加入写入类 native tools：

```text
MemoryRemember(type, title, content, scope?)
MemoryUpdate(path, oldText, newText)
MemoryForget(query | path)
MemoryCaptureSession(sessionId?, reason?)
MemoryApplyProposal(path)
MemoryRejectProposal(path, reason?)
```

这些工具仍然需要比只读工具更严格的执行策略：`MemorySearch` / `MemoryRead` 可以是 `safe`，写入、更新、删除和 session capture 默认应是 `manual` 或带 workspace policy 的受控执行。runtime 需要按 workspace 策略、人类确认、agent 权限、写入目录约束和审计日志决定是否批准。

### CLI / UI

建议最少提供：

```bash
oah memory status   # 已实现，本地 workspace 文件模式
oah memory search "query"  # 已实现
oah memory get <path>  # 已实现
oah memory index  # 已实现
oah memory proposals  # 已实现，列出 confirm-suggested 待确认写入
oah memory apply-proposal <path>  # 已实现，应用待确认写入
oah memory reject-proposal <path>  # 已实现，拒绝待确认写入
```

Web/TUI 中至少能看到：

- 当前 workspace memory 是否启用。
- `MEMORY.md` 是否被注入。
- 最近 session summaries。
- 搜索命中和来源文件。
- 哪些 memory 是自动写入的。

当前已补齐 workspace memory inspection/review 的 HTTP API：

```text
GET  /api/v1/workspaces/:workspaceId/memory/status
GET  /api/v1/workspaces/:workspaceId/memory
GET  /api/v1/workspaces/:workspaceId/memory/search
GET  /api/v1/workspaces/:workspaceId/memory/read
GET  /api/v1/workspaces/:workspaceId/memory/proposals
POST /api/v1/workspaces/:workspaceId/memory/proposals/apply
POST /api/v1/workspaces/:workspaceId/memory/proposals/reject
```

这些接口返回结构化 DTO，而不是解析 native tool 文本输出；底层仍走 workspace file lease，因此可以复用本地/远端 workspace 的 materialization、flush 和 owner routing。

当前 Web Inspector 的 Workspace 工作台已接入这层 API，并新增 `Memory` 子面板：

- 展示 workspace memory enable/write policy/root/index/files/bytes/topics/sessions/daily/dreams/proposals 状态。
- 支持按 corpus 搜索 memory，并展示命中来源文件、snippet、更新时间和大小。
- 支持读取 memory markdown 内容。
- 支持查看 pending proposals，并通过 structured API apply/reject。

后续 TUI 面板也应接这层 API，而不是直接读取 `.openharness/memory` 文件。

## 权限与安全

自动写入 memory 的流程必须受限：

- 写路径只能在 `.openharness/memory/` 下。
- 禁止写 workspace 其它文件。
- shell 只允许只读命令。
- 不允许网络请求，除非明确配置。
- 已加入基础 secret scanner，不允许把明显 secret、token、private key 写入 memory。
- 对 prompt injection、exfiltration、invisible unicode 做基础扫描。

Shared/team memory 暂不作为第一阶段目标。以后如果支持，需要额外加入：

- secret scanner
- 审核流
- scope 标记
- 删除/tombstone 语义

## 实施阶段

当前代码中已有 `WorkspaceMemoryService` 基础能力：可注入 `.openharness/memory/MEMORY.md`，可解析带 frontmatter 的 topic files，可做相关 topic recall，并已有后台 extraction agent 的雏形。后续实现应优先沿着这条现有 runtime 集成路径补齐工具、策略、存储和 UI，而不是另起一套 memory subsystem。

### Phase 1：Workspace file memory

目标：建立最小可用、可读、可删的 workspace memory。

- 创建 `.openharness/memory/MEMORY.md` 支持。
- 在 prompt/context assembly 中注入 `MEMORY.md`。
- 已实现 `MemorySearch` / `MemoryRead` 的 lexical 版本。
- 已将 `MemorySearch` / `MemoryRead` 注册为 `safe` native tools。
- 已将自动 topic recall 收窄为只读取 `.openharness/memory/topics/**/*.md`，避免 sessions/daily/dreams/proposals 自动进入主上下文。
- 已实现 `MemoryCaptureSession`，可在 session/run 边界或 compact 前生成 `sessions/*.md`。
- 基础 CLI 可查看、搜索、读取和列出 pending proposals；HTTP memory inspection/review API 已补齐；Web Inspector 已接入 `Memory` 子面板；TUI 面板后续接入同一层 API。

### Phase 2：Claude Code 式 topic memory

目标：让长期记忆结构化、可维护。

- `topics/*.md` + frontmatter。
- `user/feedback/project/reference` taxonomy。
- 已通过 `MemoryRemember` / `MemoryUpdate` / `MemoryForget` 支持 remember/forget/update。
- 已将写入类 memory tools 注册为 `manual` 或 policy-gated native tools。
- `confirm-suggested` 已持久化 pending proposal 到 `.openharness/memory/proposals/*.md`，并从普通 search/index 中排除，避免待确认建议被误当成已确认记忆。
- 已实现 `MemoryApplyProposal` / `MemoryRejectProposal`，支持确认后应用或拒绝 pending proposal，并回写 proposal 状态。
- `MEMORY.md` 作为短索引由 `MemoryRemember` 自动补充链接。
- 防重复、校验、truncation warning。

### Phase 3：后台抽取与 compaction flush

目标：减少上下文丢失，让记忆自动维护。

- turn-end extraction agent。
- 已实现 compaction 前 memory flush，会把即将被压缩的早期消息保存到 `sessions/*.md`。
- session-boundary summary 更稳定。
- 已实现 `MemoryAppendDaily`，可生成/追加 `daily/*.md` 低权重工作日志。
- 自动写入权限隔离。

### Phase 4：搜索增强与晋升

目标：支持大量长期记忆。

- SQLite FTS。
- 可选 embedding hybrid search。
- recall tracking。
- promotion preview/apply。
- 已实现 `MemoryRecordDream`，可记录 `dreams/DREAMS.md` 整理、晋升、去重和清理建议。

### Phase 5：Global user memory 可选层

只有当 OAH 明确需要跨 workspace 用户画像时再做：

```text
OAH_HOME/
  memory/
    USER.md
    agent-memory/
```

它应独立于 workspace memory，并且默认不自动混入所有 workspace，避免隐私和上下文污染。

## 关键取舍

### 为什么不是先做 Hermes 式 USER.md

Hermes 的 `USER.md` 很适合个人助手，但 OAH 的第一目标是 workspace-first agent harness。全局用户画像过早进入，会带来：

- 跨项目隐私污染。
- 用户偏好和项目约定混淆。
- 多租户/团队部署边界不清。
- 与 workspace archive/export 生命周期不一致。

因此全局 user memory 应后置。

### 为什么不是直接做 OpenClaw 全量能力

OpenClaw 的 memory-core、active-memory、dreaming、context-engine 很完整，但第一版照搬会过重。OAH 现在更需要把基础事实源和执行边界打稳：

- 文件存储先可解释。
- 搜索先可调试。
- 写入先可控。
- compaction 先不丢关键上下文。

后续再把 OpenClaw 的高级检索和晋升能力逐步接入。

### 为什么 Claude Code 更适合做骨架

Claude Code 的主记忆模式天然是 repo/project scoped：

```text
~/.claude/projects/<repo-root>/memory/
```

这和 OAH 的 workspace boundary 对齐。它的 `MEMORY.md` 索引 + topic 文件也符合 OAH 对可审计、可导出、可迁移 workspace 状态的要求。

## 待确认问题

执行前需要确认：

1. Memory 文件是否默认写入 `.openharness/memory/`，还是放在 OAH shadow state 后再 materialize。
2. `MEMORY.md` 是全文注入，还是只注入索引和摘要。
3. 自动写入是否默认开启，还是只在用户显式 opt-in 后开启。
4. memory 写入是否需要用户确认。
5. session summary 是每个 run 都生成，还是只在 reset/archive/compaction 前生成。
6. 第一版是否需要支持 workspace archive/export 中包含 memory。

## 推荐默认答案

初始实现建议采用以下默认：

- memory 根目录：`.openharness/memory/`
- 默认启用读取和搜索。
- 默认不启用后台自动写入，只支持显式 remember/forget 和 session-boundary summary。
- `MEMORY.md` 注入时设置行数/字节上限。
- 自动写入进入 preview 或低权限 internal action。
- memory 随 workspace archive/export 一起导出。

这样既符合 OAH workspace-first 的产品形态，也为后续 Claude Code/OpenClaw 式增强留足空间。
