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
| `Bash` | 执行 shell 命令 | `execShell()` |
| `Read` | 读取文件（utf8 / base64） | `readFile()` |
| `Write` | 创建或覆盖文件 | `writeFile()` |
| `Edit` | 编辑文件指定段落 | `readFile()` + `writeFile()` |
| `Glob` | 模式匹配搜索文件 | `listFiles()` |
| `Grep` | 正则搜索文件内容 | `execShell()` (ripgrep) |
| `WebFetch` | 获取网页内容 | 直接 HTTP |
| `TodoWrite` | session 级任务列表 | 内存状态 |

安全：`Read` 强制 read-before-write，所有路径不超出 workspace 根目录，session 级状态隔离。

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
