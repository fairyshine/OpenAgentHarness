# Files Module

Sandbox 文件管理 API，支撑 web 文件管理以及 `embedded` / `self_hosted` / `e2b` 三类 sandbox provider。当前以 `sandboxes` 作为主语义，文件路径使用 sandbox 内绝对路径，例如 `/workspace/notes/todo.md`。

暂不包括：全 workspace 递归树、批量操作、全文搜索、分片上传、文件变更推送。

## 接口

### `POST /sandboxes`

创建或解析一个 sandbox。可以直接传 `workspaceId` 绑定已有 workspace，也可以传 `name + blueprint` 新建。

### `GET /sandboxes/{sandboxId}`

读取 sandbox 元数据，包含 `provider`、`executionModel`、`workerPlacement`、`rootPath`、`workspaceId`、owner worker 信息等。

### `GET /sandboxes/{sandboxId}/files/entries`

读取目录直接子项。参数：`path`（默认 `/workspace`）、`pageSize`、`cursor`、`sortBy`（name / updatedAt / sizeBytes / type）、`sortOrder`。只返回直接 children，不递归。

### `GET /sandboxes/{sandboxId}/files/content`

读取文件内容。参数：`path`、`encoding`（utf8 / base64）、`maxBytes`（预览截断）。

返回：`content`、`truncated`、`sizeBytes`、`mimeType`、`etag`、`updatedAt`、`readOnly`。

### `GET /sandboxes/{sandboxId}/files/stat`

读取文件或目录元数据，返回 `type`、`sizeBytes`、`mode`、`mtimeMs`、`birthtimeMs` 等字段。

### `PUT /sandboxes/{sandboxId}/files/content`

创建或覆盖文件。字段：`path`、`content`、`encoding`、`overwrite`、`ifMatch`（乐观并发控制）。

### `POST /sandboxes/{sandboxId}/directories`

创建目录。字段：`path`、`createParents`。已存在时幂等返回。

### `PUT /sandboxes/{sandboxId}/files/upload`

原始字节流上传。参数：`path`。Body: `application/octet-stream`。适合二进制文件。

### `GET /sandboxes/{sandboxId}/files/download`

下载原始字节流。参数：`path`。附带 `Content-Disposition`、`ETag`、`Last-Modified`。

### `DELETE /sandboxes/{sandboxId}/files/entry`

删除文件或目录。参数：`path`、`recursive`（非空目录须 `true`）。

### `PATCH /sandboxes/{sandboxId}/files/move`

重命名或移动。字段：`sourcePath`、`targetPath`、`overwrite`。

### `POST /sandboxes/{sandboxId}/commands/foreground`

前台执行 shell command，等待完成后直接返回 stdout/stderr/exitCode。

### `POST /sandboxes/{sandboxId}/commands/process`

以结构化 `executable + args` 启动进程，适合非 shell 调用。

### `POST /sandboxes/{sandboxId}/commands/background`

启动后台命令，立即返回进程句柄，后续由更高层运行时追踪。

## 设计说明

- **统一 sandbox 语义：** 文件与命令执行都围绕 sandbox 暴露，便于在 `embedded`、`self_hosted` 与 `e2b` provider 之间做配置级切换
- **worker 位置明确：** `embedded` 表示 worker 在 `oah-api` 进程内；`self_hosted / e2b` 表示 standalone worker 在真实 sandbox 内
- **不用全量树：** 大 workspace 全量树慢，懒加载更适合虚拟滚动和分页
- **目录列表与文件内容分离：** 列表高频轻量，内容低频体积大
- **entry 抽象：** 删除、移动对文件和目录通用，减少重复接口
- **大目录：** 按 `pageSize` 分页，稳定键排序，优先 cursor 而非 offset
