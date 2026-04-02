# Workspace Spec

workspace 是能力发现的主边界。用户打开一个项目后，平台应尽可能从项目根目录自动发现完整能力，而不是要求用户先去平台后台做大量全局配置。

## 这页适合什么时候看

- 你准备新建一个 workspace
- 你想知道 `.openharness/` 里应该放什么
- 你在排查“为什么某个 agent / model / skill 没被加载”

!!! tip

    如果你只想先搭一个最小可用 workspace，优先看本页的“目录结构”“自动发现规则”和 [settings.md](./settings.md)。

当前约束：

- 只读取 workspace 根目录的 `AGENTS.md`
- 声明式配置放在 workspace 根目录 `.openharness/` 下
- 除 LLM API Key 外，不要求用户额外提供全局设置

## Workspace 形态

建议支持两种 workspace 形态：

- `project`
  - 常规项目 workspace
  - 可加载完整能力定义，并按 agent allowlist 暴露工具
  - 可启用 `.openharness/data/history.db` 本地历史镜像
- `chat`
  - 只读普通对话 workspace
  - 常用于把一个目录下的多个 workspace 文件夹组织成不同对话模式
  - 只读取 prompt、agent、model 等静态配置
  - 不允许修改 workspace 内容，不允许执行 shell / action / skill / tool / hook
  - 不在 workspace 内创建对话历史数据库

推荐规则：

- `chat` 与 `project` 的差异由服务端注册时决定，不由 workspace 自己声明
- 服务端配置文件可通过 `paths.chat_dir` 指定一个“对话模式目录”，其下每个直接子目录自动注册为 `kind=chat` workspace
- `paths.chat_dir` 下的目录本身就是可直接进入的只读 workspace，不需要像 `template_dir` 一样先复制
- 因为这些 workspace 是只读的，所以也天然可以承担预置对话模式模板的角色

## 目录结构

建议的 workspace 结构：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    data/
      history.db
    agents/
      planner.md
      builder.md
      reviewer.md
    models/
      GPT.yaml
      Kimi-K25.yaml
    actions/
      code-review/
        ACTION.yaml
      run-tests/
        ACTION.yaml
    skills/
      repo-explorer/
        SKILL.md
        scripts/
        references/
      doc-reader/
        SKILL.md
    tools/
      settings.yaml
      servers/
        docs-server/
        browser/
    hooks/
      redact-secrets.yaml
      policy-guard.yaml
      scripts/
      prompts/
      resources/
```

如果你只想先跑一个最小版本，通常至少需要：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    agents/
      builder.md
    models/
      openai.yaml
```

## 自动发现规则

系统在 run 启动时检查：

- `AGENTS.md`
- `.openharness/settings.yaml`
- `.openharness/agents/*.md`
- `.openharness/models/*.yaml`
- `.openharness/actions/*/ACTION.yaml`
- `.openharness/skills/*/SKILL.md`
- `.openharness/tools/settings.yaml`
- `.openharness/tools/servers/*`
- `.openharness/hooks/*.yaml`

其中：

- `.openharness/data/` 是 runtime 托管目录，不参与能力定义解析
- `.openharness/data/history.db` 是该 workspace 的本地历史镜像库
- 历史镜像来源于中心数据库的异步同步，不是配置源
- `kind=chat` workspace 不会创建 `.openharness/data/history.db`

运行时使用三类输入：

1. 平台内建 agent / model
2. workspace 当前文件声明
3. 当前 API / session / run 的显式参数

规则：

- 平台模板只用于初始化生成 workspace 文件，不参与运行时 merge
- 运行时只读取 workspace 当前文件，不读取模板源
- 平台内建 agent 与 workspace agent 一起组成当前 workspace 的可见 agent catalog
- 若平台内建 agent 与 workspace agent 同名，则 workspace agent 覆盖 platform agent
- 平台级与 workspace 级模型入口不互相覆盖，而是合并成当前 workspace 的 model catalog
- 模型入口解析优先使用显式 `model_ref`
- 显式参数只允许选择当前可见 catalog 中已有能力，或在未来支持时收窄权限边界，不允许扩展该 catalog 之外的能力
- 当前不做多级目录合并
- 当前不做子目录 override
- `.openharness/data/history.db` 为只读镜像语义，运行时不会把它作为事实源反向合并回中心库
- `kind=chat` workspace 仅暴露 agents 与 models，`actions`、`skills`、`tools`、`hooks`、`nativeTools` 均为空
- 如果 workspace 未声明 `default_agent`，且调用方也未显式指定 agent，则应返回配置错误

## 常见问题

### `chat` workspace 和 `project` workspace 最核心的区别是什么？

最核心的区别不是目录长什么样，而是运行策略不同：

- `project` 可以装配并执行工具能力
- `chat` 只提供静态对话能力，不进入执行 backend

### 为什么 `.openharness/data/` 不参与配置解析？

因为它是 runtime 托管目录，不是能力声明目录。尤其是 `history.db` 只是异步镜像，不是事实源。

## 文档导航

- [settings.md](./settings.md)
- [agents.md](./agents.md)
- [agents-project.md](./agents-project.md)
- [agents-definition.md](./agents-definition.md)
- [agents-controls.md](./agents-controls.md)
- [models.md](./models.md)
- [model-providers.md](./model-providers.md)
- [actions.md](./actions.md)
- [skills.md](./skills.md)
- [external tools (MCP-backed)](./mcp.md)
- [hooks.md](./hooks.md)
- [hooks-events.md](./hooks-events.md)
- [hooks-handlers.md](./hooks-handlers.md)
- [hooks-protocol.md](./hooks-protocol.md)
- [loading-and-validation.md](./loading-and-validation.md)

## 建议阅读顺序

1. [settings.md](./settings.md)
2. [agents.md](./agents.md)
3. [models.md](./models.md)
4. [actions.md](./actions.md)
5. [skills.md](./skills.md)
6. [external tools (MCP-backed)](./mcp.md)
7. [hooks.md](./hooks.md)
8. [loading-and-validation.md](./loading-and-validation.md)
