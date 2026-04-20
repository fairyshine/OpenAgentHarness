# MCP (External Tools)

MCP tool server 配置位于 `.openharness/tools/`，采用目录式组织。

## 目录结构

```text
tools/
  settings.yaml         # Server 注册中心
  servers/
    docs-server/        # 本地代码型 server
      package.json
      index.js
    browser/
      package.json
      server.py
```

## settings.yaml

声明当前 workspace 可见的 MCP servers：

```yaml
docs-server:
  command: node ./servers/docs-server/index.js
  enabled: true
  environment:
    DOCS_TOKEN: ${secrets.DOCS_TOKEN}
  timeout: 30000
  expose:
    tool_prefix: mcp.docs
    include:
      - search
      - fetch

browser:
  url: https://example.com/mcp
  headers:
    Authorization: Bearer ${secrets.BROWSER_TOKEN}
  enabled: true
  timeout: 30000
  oauth: false
```

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 顶层 key | 是 | Server 名称 |
| `command` | 二选一 | 本地进程型 server 启动命令 |
| `url` | 二选一 | 远程 server 地址 |
| `enabled` | 否 | 是否启用 |
| `environment` | 否 | 追加环境变量 |
| `headers` | 否 | 请求头（远程 server） |
| `timeout` | 否 | 超时（毫秒） |
| `expose` | 否 | 工具暴露策略（前缀、include/exclude） |
| `oauth` | 否 | 是否使用 OAuth 认证 |

每个 server 必须声明 `command` 或 `url`，不可同时声明。

## 连接方式

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| 本地 stdio | `command` | 本地代码放 `servers/<name>/` |
| 远程 http | `url` | 可只在 settings.yaml 声明，无需本地目录 |

## Docker 中访问宿主机 MCP Server

当 OAH 运行在 Docker 容器里，而 MCP Server 跑在宿主机本地时，`127.0.0.1` / `localhost` 指向的是容器自身，不是宿主机。

现在对于 HTTP MCP server，OAH 在容器内会自动把下面这类地址：

- `http://127.0.0.1:PORT/...`
- `http://localhost:PORT/...`

改写为：

- `http://host.docker.internal:PORT/...`

本地 `docker-compose.local.yml` 也已经为 OAH 容器补了 `host.docker.internal:host-gateway` 映射，因此在 Linux 上也能正常解析。

如果你的环境不使用 `host.docker.internal`，可以通过环境变量覆盖：

```bash
OAH_DOCKER_HOST_ALIAS=your-host-gateway-name
```

例如宿主机 MCP server 配置可以继续写成：

```yaml
browser:
  url: http://127.0.0.1:8789/mcp
  enabled: true
```

当 OAH 运行在容器里时，它会自动转成可访问宿主机的地址。
