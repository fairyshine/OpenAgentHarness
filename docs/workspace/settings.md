# Settings

`.openharness/settings.yaml` 是 workspace 的总配置入口。

## 最小配置

```yaml
default_agent: build
```

指定 `build` 作为默认主 agent。其余字段全部可选。

## 完整示例

```yaml
default_agent: build
skill_dirs:
  - ./.codex/skills

system_prompt:
  base:
    inline: |-
      You are Open Agent Harness running inside the current workspace.
      Prefer workspace-local configuration and tools.

  llm_optimized:
    providers:
      openai:
        inline: |-
          Be concise, tool-oriented, and explicit about assumptions.
      anthropic:
        file: ./.openharness/prompts/anthropic.md
    models:
      platform/openai-default:
        inline: |-
          Prefer short, direct tool call arguments.

  compose:
    order:
      - base
      - llm_optimized
      - agent
      - actions
      - project_agents_md
      - skills
    include_environment: false
```

## 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `default_agent` | 否 | 默认主 agent。目标必须存在且不能是纯 `subagent` |
| `skill_dirs` | 否 | 额外 skill 搜索目录列表 |
| `blueprint` | 否 | 记录当前 workspace 来源的 blueprint 名称 |
| `imports` | 否 | blueprint 初始化时导入的公共 tools/skills |
| `system_prompt` | 否 | Workspace 级 system prompt 配置 |

!!! tip

    workspace 使用统一结构。是否暴露 actions/tools 由当前 workspace 配置与运行时能力共同决定。

## `skill_dirs`

```yaml
skill_dirs:
  - ./.codex/skills
  - ./.shared/skills
```

| 规则 | 说明 |
| --- | --- |
| 默认目录 | `.openharness/skills/*` 始终扫描 |
| 追加语义 | `skill_dirs` 追加额外目录，不替代默认目录 |
| 路径解析 | 相对 workspace 根目录 |
| 优先级 | `.openharness/skills/*` > `skill_dirs` 声明顺序 |
| 跨层同名 | 记录 warning，高优先级覆盖 |
| 同层同名 | 配置错误，加载失败 |

## `system_prompt`

控制 system prompt 的组装方式。

### `base`

Workspace 级基础提示词。支持 `inline` 或 `file`（二选一）：

```yaml
base:
  inline: |-
    You are Open Agent Harness.
```

```yaml
base:
  file: ./.openharness/prompts/base.md
```

`file` 路径相对 workspace 根目录解析。建议使用 `.md` 或 `.txt`。

### `llm_optimized`

针对 provider 或具体 model 的优化提示词：

```yaml
llm_optimized:
  providers:
    openai:
      inline: |-
        Be concise and tool-oriented.
  models:
    platform/openai-default:
      file: ./.openharness/prompts/openai-default.md
```

| 规则 | 说明 |
| --- | --- |
| 优先级 | `models` 精确匹配 > `providers` |
| Provider key | AI SDK provider 标识 |
| Model key | 完整 `model_ref` |

### `compose`

控制静态 system prompt 段的拼装顺序：

```yaml
compose:
  order:
    - base
    - llm_optimized
    - agent
    - actions
    - project_agents_md
    - skills
  include_environment: false
```

可用段名：`base`、`llm_optimized`、`agent`、`actions`、`project_agents_md`、`skills`

| 规则 | 说明 |
| --- | --- |
| `system_reminder` | 不在此处配置，由运行时动态注入 |
| `actions` | 当前 agent 无可见 actions 时自动跳过 |
| `project_agents_md` | 根目录无 `AGENTS.md` 时自动跳过 |
| `skills` | 当前 agent 无可见 skills 时自动跳过 |
| `include_environment` | 是否追加运行环境摘要，默认 `false` |

## `imports`

```yaml
imports:
  tools:
    - docs-server
  skills:
    - repo-explorer
```

| 字段 | 说明 |
| --- | --- |
| `tools` | 从 `paths.tool_dir` 导入到 workspace 的公共 tool 名称 |
| `skills` | 从 `paths.skill_dir` 导入到 workspace 的公共 skill 名称 |

仅用于 blueprint 初始化。导入后 workspace 以本地副本为准，不再依赖平台目录。引用不存在的 tool 或 skill 时，初始化失败。
