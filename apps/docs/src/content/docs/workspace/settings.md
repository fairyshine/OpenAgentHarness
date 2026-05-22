---
title: "Settings"
---

# Settings

`.openharness/settings.yaml` 现在只负责 workspace 的核心配置：默认 agent、可选模型别名、engine 行为开关、导入项和额外 skill 目录。

Prompt 相关配置已拆到独立文件 [`prompts.yaml`](./prompts/)。

## 最小配置

```yaml
default_agent: build
```

## 完整示例

```yaml
default_agent: build

models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    max_tokens: 2048
  planner:
    ref: workspace/repo-planner

skill_dirs:
  - ./.codex/skills

imports:
  tools:
    - docs-server
  skills:
    - repo-explorer

engine:
  session_memory:
    enabled: false
  workspace_memory:
    enabled: false
```

## 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `default_agent` | 否 | 默认主 agent。运行时必须能解析到当前可见 agent，且不能只是一种纯 `subagent` 形态 |
| `models` | 否 | agent 可引用的模型别名表；不配置时 agent 使用平台默认模型 |
| `skill_dirs` | 否 | 额外 skill 搜索目录列表 |
| `engine` | 否 | 可选 runtime engine 行为开关。当前内置 `compact`；`session_memory` 与 `workspace_memory` 分别对应两类记忆能力 |
| `runtime` | 否 | 记录当前 workspace 来源的 runtime 名称 |
| `imports` | 否 | runtime 初始化时导入的公共 tools/skills |

> **tip**

    如果某个 runtime 需要稳定地切换模型，推荐所有 agent 都通过 `model: <alias>` 引用这里声明的别名。之后只改 `settings.yaml` 就能整体切换。

## `models`

```yaml
models:
  default: platform/openai-default
  cheap: workspace/repo-model
  tuned:
    ref: platform/openai-default
    temperature: 0.2
    top_p: 0.9
    max_tokens: 2048
```

| 规则 | 说明 |
| --- | --- |
| key | 别名，由 agent frontmatter 使用，例如 `model: default` |
| 值类型 | 可以直接写成字符串 `platform/<name>` / `workspace/<name>`，也可以写成带 `ref` 的对象 |
| `ref` | 具体模型引用，格式必须是 `platform/<name>` 或 `workspace/<name>` |
| `temperature` / `top_p` / `max_tokens` | 该模型别名对应的默认推理参数 |
| 解析时机 | workspace 加载阶段解析；运行时内部仍使用具体 `model_ref` |
| 适用范围 | 仅影响显式声明非默认别名或 canonical model ref 的 agent；未声明模型的 agent 走平台默认模型 |

如果 agent 未声明 `model`，或者声明了 `model: default` 但 `models.default` 不存在，运行时会使用平台默认模型。其他未声明的别名仍会在 workspace 加载阶段报错。

推荐把“要不要换模型”和“这个模型档位的推理参数”都放在这里，把“这个 agent 用哪个模型档位”放在 agent frontmatter。

## `engine`

```yaml
engine:
  session_memory:
    enabled: true
  workspace_memory:
    enabled: true
```

| 字段 | 说明 |
| --- | --- |
| `compact.enabled` | 是否启用自动 compact 能力。默认开启；不需要显式配置。只有想关闭时才写 `compact: { enabled: false }` |
| `session_memory.enabled` | Session 级记忆能力开关。用于当前会话连续性，不等同于 workspace 持久记忆 |
| `workspace_memory.enabled` | Workspace 级持久记忆能力开关。对应 `.openharness/memory/` 目录 |

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
| 同名处理 | 按扫描顺序“先到先得”；后面目录里的同名 skill 会被忽略 |
| 同目录重复 | 同一个 skill 根目录下若解析出重名 skill，会直接报错 |

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

仅用于 runtime 初始化。导入后这些内容会被复制进 workspace 自己的 `.openharness/` 目录，之后以该 workspace 的 `Active Workspace Copy` 为准，不再依赖平台目录。引用不存在的 tool 或 skill 时，初始化失败。
