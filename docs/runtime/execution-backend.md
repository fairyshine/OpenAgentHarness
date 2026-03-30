# Execution Backend

## 目标

屏蔽本地执行和未来沙箱执行的差异。

## 接口建议

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

## 当前实现

- `LocalWorkspaceBackend`
  - 以 workspace 根目录为工作目录
  - 在宿主机执行 shell
  - 提供文件读写能力

## 后续实现

- `SandboxBackend`
  - 容器 / VM / Firecracker / 远程 runner
