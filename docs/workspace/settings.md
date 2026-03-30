# Workspace Settings

`.openharness/settings.yaml` 是 workspace 的总配置入口，用于定义：

- 默认 primary agent
- 额外的 skill 搜索目录
- workspace 级公共 system prompt
- system prompt 的分层拼装顺序与开关

它不用于定义具体 agent 的个性化行为；agent 自身定义仍放在 `agents/*.md`。

## 示例

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
      - platform
      - base
      - llm_optimized
      - agent
      - project_agents_md
      - skills
      - environment
    include_environment: true
    include_project_agents_md: true
    include_skills: true
```

## 顶层字段

- `default_agent`
- `skill_dirs`
- `system_prompt`

## `default_agent`

- 可选；声明当前 workspace 默认使用的 primary agent
- 可指向当前可见 catalog 中的任意 primary agent，包括平台内建 agent
- 若未声明，则需要由调用方在创建 session 或启动 run 时显式指定 agent
- 目标必须存在，且不能是纯 `subagent`

## `skill_dirs`

建议结构：

```yaml
skill_dirs:
  - ./.codex/skills
  - ./.shared/skills
```

字段说明：

- 每一项都是一个额外的 skill 根目录
- 每个根目录下仍按 `*/SKILL.md` 发现技能

规则：

- 默认始终扫描 `.openharness/skills/*`
- `skill_dirs` 仅用于追加额外目录，不替代默认目录
- 相对路径按 workspace 根目录解析
- 在可信环境下也可支持绝对路径
- 若出现同名 skill，优先级为：
  1. `.openharness/skills/*`
  2. `skill_dirs` 中按声明顺序扫描到的第一个定义
- 跨层同名冲突：
  - 记录 warning，并按优先级覆盖
- 同层同名冲突：
  - 视为配置错误，加载失败

## `system_prompt`

建议结构：

```yaml
system_prompt:
  base:
    inline: |-
      ...
  llm_optimized:
    providers:
      openai:
        inline: |-
          ...
    models:
      platform/openai-default:
        file: ./.openharness/prompts/openai-default.md
  compose:
    order:
      - platform
      - base
      - llm_optimized
      - agent
      - project_agents_md
      - skills
      - environment
```

字段说明：

- `base`
  - workspace 级公共基础提示词
- `llm_optimized`
  - 针对 provider 或具体 model 的优化提示词
- `compose`
  - system prompt 的拼装顺序和开关

## Prompt Source 写法

所有 prompt 段都建议支持两种来源：

- `inline`
  - 直接在 YAML 内联长文本，推荐使用 `|-`
- `file`
  - 引用外部 Markdown / text 文件

示例：

```yaml
base:
  inline: |-
    You are Open Agent Harness.
```

```yaml
base:
  file: ./.openharness/prompts/base.md
```

规则：

- `inline` 与 `file` 二选一
- `file` 路径相对 workspace 根目录解析
- prompt 文件建议使用 `.md` 或 `.txt`

## `llm_optimized`

建议结构：

```yaml
llm_optimized:
  providers:
    openai:
      inline: |-
        ...
  models:
    platform/openai-default:
      inline: |-
        ...
```

规则：

- `models` 精确匹配优先级高于 `providers`
- provider key 使用 AI SDK provider 标识
- model key 使用完整 `model_ref`

## `compose`

建议结构：

```yaml
compose:
  order:
    - platform
    - base
    - llm_optimized
    - agent
    - project_agents_md
    - skills
    - environment
  include_environment: true
  include_project_agents_md: true
  include_skills: true
```

建议支持的段名：

- `base`
- `llm_optimized`
- `platform`
- `agent`
- `project_agents_md`
- `skills`
- `environment`

规则：

- `system_reminder` 不在这里配置，仍由运行时动态注入
- `order` 只控制静态 system prompt 段的拼装顺序
- `include_environment` 控制是否注入运行环境摘要
- `include_project_agents_md` 控制是否拼入根目录 `AGENTS.md` 原文全文
- `include_skills` 控制是否拼入技能摘要
