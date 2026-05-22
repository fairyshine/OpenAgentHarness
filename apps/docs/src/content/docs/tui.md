---
title: "TUI Client"
---

# TUI Client

## 定位

OpenAgentHarness 本身仍然是 headless runtime，不提供正式产品 UI。

仓库提供了一个轻量的 `oah` 终端端。CLI 命令和 `tui` 是同一个入口下的两种模式：

- CLI 命令：适合脚本化和单次查询。
- TUI 模式：适合实时观察和交互式操作。

它的定位是：

- TUI 客户端
- 本地开发工具
- 运维与观测工具

而不是：

- 正式终端产品
- 面向最终用户的聊天客户端
- 配置后台或管理平台

## 当前入口

默认情况下，TUI 会连接本地 OAP daemon；如果 daemon 尚未运行，会尝试先启动：

```bash
cd /path/to/repo
pnpm dev:cli -- tui
pnpm dev:cli -- tui --runtime vibe-coding
pnpm dev:cli -- tui --new-session
pnpm dev:cli -- tui --resume-last
```

不传 `--base-url` 时，`oah tui` 会把当前目录注册或复用为本地 workspace。`--runtime <name>` 只在当前目录没有 `.openharness/` 时用于首次 bootstrap；如果已经有 `.openharness/`，会保留现有 OAS 配置并直接注册 / 复用 workspace。

进入 workspace 后，TUI 默认恢复最近的 session；如果该 workspace 还没有 session，会自动创建一个。需要明确开始新对话时使用 `--new-session`，需要显式恢复最近对话时使用 `--resume-last`。session picker 会显示最近 run 的 `queued` / `running` / `completed` 等状态，方便判断是继续等待、恢复还是新建。

连接远端或企业 OAH server 时，显式传入 `--base-url`：

```bash
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

当前 CLI 已包含：

```text
oah
  version
  update [version]
  rollback [version]
  daemon init|start|status|stop|restart|logs|state|maintenance
  web
  models list|add|default
  runtimes list
  tools list
  skills list
  tui [--workspace <path>] [--runtime <name>] [--new-session|--resume-last]
  workspace:list
  workspaces
  workspace:list --missing
  workspace repair <workspace-id> [--workspace <path>]
  workspaces repair <workspace-id> [--workspace <path>]
  workspaces:repair <workspace-id> [--workspace <path>]
  workspace cleanup <workspace-id> [--dry-run] [--force] [--include-history] [--yes]
  workspaces cleanup <workspace-id> [--dry-run] [--force] [--include-history] [--yes]
  workspaces:cleanup <workspace-id> [--dry-run] [--force] [--include-history] [--yes]
  workspace migrate-history [workspace-id] [--workspace <path>] [--dry-run] [--overwrite]
  workspaces migrate-history [workspace-id] [--workspace <path>] [--dry-run] [--overwrite]
  catalog:show --workspace <id>
  tools enable <name> [--workspace <path>] [--dry-run] [--overwrite]
  skills enable <name> [--workspace <path>] [--dry-run] [--overwrite]
```

`version` 查看当前 CLI 与本地 release 安装信息，`update` 下载 GitHub Release tarball 并切换 `OAH_HOME/current`，`rollback` 切回已有版本。`workspace:list` / `workspaces` 用于列出可见 workspace，`workspace:list --missing` 用于筛出 rootPath 已不存在的本地记录，`workspace repair <workspace-id> --workspace /new/path` 用于在 repo 移动后把旧记录重新绑定到新路径，`workspace cleanup <workspace-id>` 默认清理指定 workspace 的可重建 materialized/cache 状态且不删除历史；如需删除该 workspace 的 session/run/event history，先用 `--include-history --dry-run` 预览，再用 `--include-history` 并输入 workspace id 二次确认。`workspace migrate-history` 用于把早期 repo-local `.openharness/data/history.db` 复制进 OAP shadow storage。`catalog:show` 用于查看指定 workspace 的 catalog JSON，`tui` 则进入交互式终端界面。连接 OAP local daemon 时，`oah tui` 默认注册或复用当前目录，也可以用 `--workspace /path/to/repo` 显式指定路径。`web` 会启动 WebUI 并指向同一套 OAH-compatible API。`models`、`runtimes`、`tools`、`skills` 命令管理或查看 `OAH_HOME` 下的本地资产，其中 tools / skills 仍只是全局 catalog；只有 `tools enable` / `skills enable` 会把能力写入 repo 的 `.openharness`，随后 WebUI / TUI 看到的是 workspace 当前实际启用后的 catalog。

## 为什么需要 TUI

相比 Web UI，TUI 更适合当前系统：

- 贴合 headless runtime 定位
- 更容易接入本地目录、shell、Unix Socket 和日志流
- 不需要先处理前端鉴权、静态资源和部署问题
- 对开发者来说，终端内操作 action、model runtime、hook、run 更顺手

## 工具形态

采用同一个二进制入口：

- `oah`

分成两种模式：

- CLI 命令
  - 适合脚本化和单次查询
- TUI 模式
  - 适合实时观察和交互式操作

## CLI 命令结构

长期命令树可以继续朝下面扩展：

```text
oah
  tui
  workspace list
  workspace inspect
  catalog show
  session create
  session inspect
  action run
  model generate
  model stream
  run inspect
  run cancel
```

### 首批命令与后续补齐

- `oah tui`
  - 启动 TUI
- `oah workspace:list` / `oah workspaces`
  - 列出已发现 workspace
- `oah catalog:show --workspace <id>`
  - 查看当前 workspace 的 agents / models / actions / skills / tools / hooks
- `oah session inspect --workspace <id>`
  - 后续可补成脚本化或非 TUI 的 session 操作入口
- `oah action run --workspace <id> --action <name>`
  - 手动触发 action
- `oah model generate --model <name>`
  - 调用内部模型运行时
- `oah run inspect --run <id>`
  - 查看 run、step、tool call、hook 和错误信息

## TUI 页面建议

当前 TUI 的默认工作流围绕“当前 workspace 的当前 session”展开，避免把 workspace、catalog、session 三套概念同时铺满屏幕。后续能力可以按需展开以下区域：

- Workspace 列表
- Catalog 面板
- Session / Chat 面板
- Run 时间线
- 日志 / 事件面板

### 1. Workspace 列表

展示：

- workspace 名称
- `kind`
- `rootPath`
- `defaultAgent`
- `readOnly`

用途：

- 快速切换当前工作对象

### 2. Catalog 面板

展示：

- agents
- models
- actions
- skills
- tools
- hooks

用途：

- 直接确认当前 workspace 实际加载到了什么
- 排查覆盖、冲突和缺失定义

### 3. Session / Chat 面板

能力：

- 创建 session
- 发送消息
- 实时查看 SSE 输出
- 切换 agent

说明：

- 对常规 workspace，这里是主要交互界面之一
- 对 `project` workspace，可同时观察普通对话和工具调用结果

### 4. Run 时间线

展示：

- run 状态变化
- model call
- tool call
- action run
- hook run
- agent switch
- subagent delegate / await

用途：

- 快速定位某一步卡住、失败或超时的位置

### 5. 日志 / 事件面板

展示：

- SSE 事件
- 结构化日志摘要
- 错误码
- 最近失败原因

## 特别有价值的观测能力

后续建议优先补强：

- 查看最终可见 model catalog
- 查看最终可见 agent catalog
- 查看 workspace 自动发现结果
- 查看配置解析错误
- 查看当前 run 选中了哪个模型
- 查看最终 prompt 拼装顺序和段来源
- 直接测试内部模型运行时
- 查看 action 注入的环境变量摘要

## 与现有系统的关系

`oah` 终端端只消费已有能力，不新增一套并行运行时。

它主要依赖：

- 对外 OpenAPI
- SSE
- 内部模型运行时
- 服务端 catalog 发现结果

建议原则：

- 能复用已有 HTTP / SSE 接口，就不要额外造私有协议
- `oah` 终端端仅在“本机运行时工具”场景下使用内部模型运行时

## 与模型运行时的关系

`oah model generate` 与 `oah model stream` 直接调用：

- `/internal/v1/models/generate`
- `/internal/v1/models/stream`

因此 `oah` 终端端也是内部模型运行时的第一个官方客户端。

## 边界

`oah` 终端端不负责：

- 用户体系
- 多租户后台
- 权限管理台
- 长期聊天产品体验

它只负责：

- 使用
- 验证
- 观察
- 运维

## 实现建议

当前技术选型与演进方向：

- CLI 参数层：`commander`
- TUI：`ink`
- SSE：直接复用现有事件流协议
- 本地模型调用：复用内部模型运行时

## 实施优先级

建议后续顺序：

1. 稳定现有 `workspace:list`、`catalog:show` 和 `oah tui`
2. 补齐非交互式 `session inspect`、`run inspect`、`model generate`
3. 在 TUI 内增强 run timeline、tool call、prompt compose 与 catalog 检视
4. 再补 hooks、subagent、action 环境变量摘要等深层观测视图
