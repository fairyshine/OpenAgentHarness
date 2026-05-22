---
title: "Execution Backend"
---

# Execution Backend

## 目标

屏蔽本地执行和未来沙箱执行的差异，为 tool dispatch 提供统一执行环境抽象。

## 接口

```ts
export interface ExecutionBackend {
  kind(): string
  prepare(ctx: BackendPrepareContext): Promise<BackendSession>
  execShell(req: ExecShellRequest, ctx: BackendSession): Promise<ExecShellResult>
  readFile(req: ReadFileRequest, ctx: BackendSession): Promise<ReadFileResult>
  writeFile(req: WriteFileRequest, ctx: BackendSession): Promise<WriteFileResult>
  listFiles(req: ListFilesRequest, ctx: BackendSession): Promise<ListFilesResult>
  dispose(ctx: BackendSession): Promise<void>
}
```

- `prepare()` — run 开始时创建执行上下文
- `execShell()` — 执行 shell 命令
- `readFile()` / `writeFile()` / `listFiles()` — 文件操作
- `dispose()` — run 结束后清理

## LocalWorkspaceBackend

以 workspace 根目录为工作目录，宿主机直接执行。所有路径限制在 workspace 根目录内，防止穿越。

## Native Tools 与 Backend

| Tool | 功能 | Backend 方法 |
| --- | --- | --- |
| `AskUserQuestion` | 生成需要用户回答的结构化问题 | structured tool result |
| `Bash` | 执行 shell 命令；可启动后台终端 | `execShell()` / command executor |
| `TerminalOutput` | 查看后台终端状态和输出 | command executor |
| `TerminalInput` | 向后台终端继续写入输入 | command executor |
| `TerminalStop` | 停止后台终端 | command executor |
| `LS` | 列出目录内容 | `listFiles()` |
| `Read` | 读取文件和目录；图片会先经模型分析后返回文本描述 | `readFile()` + model gateway |
| `Write` | 创建或覆盖文件 | `writeFile()` |
| `Edit` | 编辑文件指定段落 | `readFile()` + `writeFile()` |
| `MultiEdit` | 对单文件应用多处原子字符串替换 | `readFile()` + `writeFile()` |
| `Glob` | 模式匹配搜索文件 | `listFiles()` |
| `Grep` | 正则搜索文件内容 | `execShell()` (ripgrep) |
| `ViewImage` | 读取本地图片并返回模型生成的文本描述 | `readFile()` + model gateway |
| `WebFetch` | 获取网页内容 | 直接 HTTP |
| `TodoWrite` | session 级任务列表 | 内存状态 |

安全：`Read` 强制 read-before-write，所有路径不超出 workspace 根目录，session 级状态隔离。

## 后台终端与持续输入

`Bash` 有两类长生命周期能力：

- `run_in_background: true`：启动一个后台终端，立即返回 `terminal_id`、`pid` 和 `output_path`。后续通过 `TerminalOutput` / `TerminalInput` / `TerminalStop` 管理同一个后台进程，适合挂起 web 服务、ssh、REPL 等需要持续观察或继续输入的进程。
- `persistent_session_id`：给一个命名的持久终端发送命令或输入。它适合在同一个 shell 环境里连续执行多条命令，并保留环境变量、当前 shell 状态等进程内信息。

后台终端的模型可见协议：

```text
Bash({ command: "pnpm dev", run_in_background: true })
  -> terminal_id: task-...
     output_path: .openharness/background/<session-id>/task-....log

TerminalOutput({ terminal_id: "task-..." })
  -> status: running | completed | failed | stopped | unknown
     input_writable: true | false
     terminal_kind: pty | pipe
     output: ...

TerminalInput({ terminal_id: "task-...", input: "help" })
  -> input_written: true

TerminalStop({ terminal_id: "task-..." })
  -> status: stopped
```

实现策略：

- 后台 Bash 优先使用 PTY，因为 ssh、交互式 shell、REPL、全屏终端程序通常需要 TTY 语义才能正常工作。
- 如果当前运行环境无法加载 PTY，会降级为 pipe 模式。pipe 模式仍可读取输出并尝试写入 stdin，但交互兼容性弱于 PTY。
- `TerminalOutput` 会返回 `terminal_kind` 和 `input_writable`，调用方据此判断是否还能继续输入。
- 输出落盘在 workspace 下的 `.openharness/background/<session-id>/...`，因此即使进程句柄不可用，仍可通过 `TerminalOutput` 或 `Read(output_path)` 查看历史输出。
- 进程句柄保存在当前 executor 进程内。OAH 进程重启、worker 迁移、sandbox 断开后，已落盘的状态和输出仍在，但 `input_writable` 可能变为 `false`，此时不能再通过 `TerminalInput` 继续交互。

与 Claude Code 的差异：Claude Code 的后台 Bash 主要通过 `run_in_background` 暴露输出查看/停止能力，终端面板侧的持续交互由宿主终端会话承载。OAH 在 native tool 层显式暴露 `TerminalInput`，让 LLM 也可以继续和后台 PTY/pipe 进程交互。

## Chat vs Project Workspace

| 维度 | 统一 workspace |
| --- | --- | --- |
| Backend | 创建 `LocalWorkspaceBackend` session | 不创建 |
| Shell / 文件 / Native tools | 按 agent allowlist 暴露 | 全部禁止 |
| Actions / Skills / Hooks | 按配置加载 | 不加载 |

## Sandbox Backend

服务端通过统一的 sandbox backend 适配层屏蔽 provider 差异。当前 provider 词汇统一为：

- `embedded`
- `self_hosted`
- `e2b`

上层仍只消费统一的 `/sandboxes` API 与 runtime host contract。切换 provider 应尽量通过 `server.yaml` 中的 `sandbox.provider` 完成，而不是改动 Web 或调用方接口。
