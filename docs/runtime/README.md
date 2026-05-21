# Runtime 配置教程

Runtime 是一个可复用的 workspace 初始化模板。它放在服务端 `paths.runtime_dir` 下，用来创建新的 workspace，或者给一个还没有 `.openharness/` 的本地项目补上 Agent Runtime 配置。

这组文档讲两件事：

- 如何设计、编写和发布一个 runtime
- runtime 里的每个配置文件各自负责什么

## 模板与生成后的 Workspace

Runtime 不是正在执行的进程，也不是 worker。它是一份目录模板。服务端通过 `paths.runtime_dir` 找到这些模板；具体目录边界见 [服务端配置](../server-config.md#runtime_dir)。

```text
paths.runtime_dir/
  vibe-coding/
    AGENTS.md
    .openharness/
      settings.yaml
      prompts.yaml
      agents/
      models/
      actions/
      skills/
      tools/
      hooks/
```

创建 workspace 时，OAH 会把选中的 runtime 目录复制到 workspace 根目录，然后再执行导入、追加和校验。创建完成后，运行时只读取 workspace 自己的 `.openharness/`，不会继续把 `paths.runtime_dir/<runtime>` 当成实时配置源。

## 什么时候需要一个 Runtime

适合做 runtime 的场景：

- 给一类项目提供固定 agent 组合，例如 coding、research、teaching、ops
- 复用 prompts、agents、tools、skills、actions、hooks
- 给团队提供“开箱即用”的 workspace 初始化模板
- 希望通过 API 上传和版本化分发模板

不适合塞进 runtime 的内容：

- 具体用户项目的私有源码
- 运行时产生的日志、缓存、数据库
- 必须每个 workspace 独立维护的业务数据
- 密钥明文

## 最小 Runtime

最小可用 runtime 只需要一个默认 agent 和对应 agent 文件：

```text
my-runtime/
  .openharness/
    settings.yaml
    agents/
      build.md
```

```yaml title=".openharness/settings.yaml"
default_agent: build
```

```md title=".openharness/agents/build.md"
---
mode: primary
description: Default implementation agent
model: default
tools:
  native:
    - Bash
    - Read
    - Edit
    - Grep
    - TodoWrite
policy:
  run_timeout_seconds: 1800
  tool_timeout_seconds: 180
---

# Build

You are the default implementation agent. Understand the repository, make scoped changes, and verify important behavior.
```

如果 `model: default` 没有在 `settings.models.default` 中声明，运行时会回退到服务端 `llm.default_model`。团队 runtime 仍然推荐显式声明模型别名，方便以后整体换模型。

## 配置文件放在哪里

Runtime 的目录形态和 workspace 声明式配置一致：`AGENTS.md` 加 `.openharness/`。本页只讲制作流程；每个文件的字段语义放在 [配置文件详解](./config-files.md)。

推荐从三个文件开始：

- `.openharness/settings.yaml`
- `.openharness/prompts.yaml`
- `.openharness/agents/<default-agent>.md`

等确实需要固定操作入口、外部工具或安全拦截时，再加入 actions、tools、skills、hooks。

## 从零创建一个 Runtime

1. 在 `paths.runtime_dir` 下创建目录，例如 `runtimes/team-coding`。
2. 写 `.openharness/settings.yaml`，至少声明 `default_agent`。
3. 写 `.openharness/agents/<name>.md`，确保默认 agent 是 `mode: primary` 或 `mode: all`。
4. 按需写 `.openharness/prompts.yaml`，把通用行为放在 `base`，把 provider/model 特化行为放在 `llm_optimized`。
5. 按需加入 actions、tools、skills、hooks。
6. 用 `POST /workspaces` 创建测试 workspace，确认 catalog 能加载。

创建 workspace 的 API 示例：

```bash
curl -X POST http://127.0.0.1:8787/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "name": "team-coding-demo",
    "runtime": "team-coding"
  }'
```

## 上传与更新 Runtime

Runtime 可以直接放到 `paths.runtime_dir`，也可以通过 API 上传 zip。

```bash
zip -r team-coding.zip team-coding

curl -X POST "http://127.0.0.1:8787/api/v1/runtimes/upload?name=team-coding&overwrite=true" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @team-coding.zip
```

更新已有 runtime：

```bash
curl -X PUT "http://127.0.0.1:8787/api/v1/runtimes/team-coding" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @team-coding.zip
```

## 应用到已有本地项目

在 personal local daemon 场景，可以把已有项目注册成 workspace，并在项目没有 `.openharness/` 时套用 runtime：

```bash
curl -X POST http://127.0.0.1:8787/api/v1/local/workspaces/register \
  -H "Content-Type: application/json" \
  -d '{
    "rootPath": "/Users/me/Code/my-project",
    "name": "my-project",
    "runtime": "team-coding"
  }'
```

如果目标目录已经有 `.openharness/`，OAH 不会覆盖现有配置。这样可以避免误伤用户已经调整过的 workspace。

## 设计建议

- 把模型选择集中在 `settings.models`，agent 只引用别名。
- 把通用行为放进 `prompts.yaml`，把角色职责放进 agent 正文。
- `primary` agent 控制用户主流程，`subagent` 做检索、审查、验证等边界清晰的任务。
- 给每个 agent 配明确的 `tools` allowlist，默认少给，按场景加。
- 把可重复的命令封装成 action，把临时命令留给 native tools。
- 导入公共 tools/skills 时用 `settings.imports`，发布后 workspace 会持有自己的副本。

下一页：[配置文件详解](./config-files.md)。
