---
title: "Assets Module"
---

# Assets Module

平台资产接口用于管理 server 级别的 `runtimes`、`models`、`tools`、`skills`。这些资产会写入 `server.paths.runtime_dir`、`server.paths.model_dir`、`server.paths.tool_dir`、`server.paths.skill_dir`，供后续 workspace 创建、导入或能力启用流程使用。

## `GET /assets/runtimes`

列出 workspace runtime 资产。返回：

- `kind: "runtime"`
- `items[].name`

## `POST /assets/runtimes/upload`

上传一个 `.zip` 包作为新的 workspace runtime。请求：

- Query: `name`、可选 `overwrite`
- Body: `application/octet-stream`

## `PUT /assets/runtimes/{name}`

覆盖更新一个已有 runtime 资产。Body 同上传接口。该接口要求目标 runtime 已存在。

## `DELETE /assets/runtimes/{name}`

删除一个已有 runtime 资产。

## `GET /assets/models`

列出平台 model 资产。返回：

- `kind: "model"`
- `items[].id`
- `items[].provider`
- `items[].modelName`
- `items[].url`

## `POST /assets/models/upload`

上传一个 model YAML 文件。请求：

- Query: `name`、可选 `overwrite`
- Body: `application/octet-stream`

YAML 必须且只能定义一个同名 model：

```yaml
openai-default:
  provider: openai
  name: gpt-5
```

## `PUT /assets/models/{name}`

覆盖更新一个已有 model 资产。Body 同上传接口。该接口要求目标 model 已存在。

## `DELETE /assets/models/{name}`

删除一个已有 model 资产。

## `GET /assets/tools`

列出平台 tool 资产。返回：

- `kind: "tool"`
- `items[].name`
- `items[].transportType`
- `items[].enabled`
- `items[].toolPrefix`

## `POST /assets/tools/upload`

上传一个 tool 定义。请求：

- Query: `name`、可选 `overwrite`
- Body: `application/json`

```json
{
  "definition": {
    "command": "node ./servers/repo-tools/index.js",
    "expose": {
      "tool_prefix": "repo"
    }
  },
  "serverFiles": {
    "index.js": "console.log('ok');\n"
  }
}
```

`definition` 会写入 `tools/settings.yaml` 的同名条目。`serverFiles` 可选，会写入 `tools/servers/{name}/`。

## `PUT /assets/tools/{name}`

覆盖更新一个已有 tool 资产。Body 同上传接口。该接口要求目标 tool 已存在。

## `DELETE /assets/tools/{name}`

删除 `tools/settings.yaml` 中的同名条目，并删除 `tools/servers/{name}/`。

## `GET /assets/skills`

列出平台 skill 资产。返回：

- `kind: "skill"`
- `items[].name`
- `items[].description`
- `items[].exposeToLlm`

## `POST /assets/skills/upload`

上传一个 skill。请求：

- Query: `name`、可选 `overwrite`
- Body: `application/json`

```json
{
  "skillMarkdown": "---\ndescription: Inspect repositories\n---\n# Repo scout\n\nRead the repository and summarize it.\n",
  "files": {
    "references/checklist.md": "- inspect tree\n"
  }
}
```

`skillMarkdown` 会写入 `skills/{name}/SKILL.md`。`files` 可选，会写入同一 skill 目录下。

## `PUT /assets/skills/{name}`

覆盖更新一个已有 skill 资产。Body 同上传接口。该接口要求目标 skill 已存在。

## `DELETE /assets/skills/{name}`

删除 `skills/{name}/`。

## Compatibility Aliases

`/platform-assets/runtimes`、`/platform-assets/models`、`/platform-assets/tools`、`/platform-assets/skills` 及其 upload / update / delete 子路径是早期客户端兼容别名。新客户端应使用 `/assets/*`。`/runtimes` 仍保留为 workspace runtime 的兼容接口，但 Web 端统一从 Assets 入口管理。
