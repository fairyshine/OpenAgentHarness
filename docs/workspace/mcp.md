# MCP

## 目标

MCP 采用目录式组织：

- `settings.yaml`
  - MCP server 注册中心
- `servers/`
  - 本地代码型 MCP server 目录

这种方式更适合同时支持：

- workspace 自带 MCP server
- 用户上传自己的 MCP server 代码
- 远程 MCP server
- stdio / http 等不同连接方式
- 显式声明本地 server 的启动命令

## 目录结构

```text
mcp/
  settings.yaml
  servers/
    docs-server/
      package.json
      index.js
    browser/
      package.json
      server.py
```

## `settings.yaml` 规范

`settings.yaml` 用于声明当前 workspace 中可见的 MCP servers。

建议结构：

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

## 设计原则

- `settings.yaml` 负责注册、命名、启用、暴露策略和连接参数
- 有 `command` 的 server 视为本地进程型 server
- 有 `url` 的 server 视为远程 server
- 每个 server 必须二选一，只能声明 `command` 或 `url`
- 本地代码目录建议放在 `servers/<name>/`
- 远程 server 可以只在 `settings.yaml` 中声明，无需本地目录
- 运行时应支持用户上传自己的 server 目录
- `settings.yaml` 是当前 workspace 的单一 MCP 配置入口
- `command` 使用字符串

## 当前范围

- 支持 `stdio`
- 支持 `http`
- 从 workspace 关联 secrets 或平台注入环境中读取认证信息
- 支持本地代码型 server 和远程 server 并存
- 本地 server 使用 `command` 声明启动方式
