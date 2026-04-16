# Skills

Skill 是能力封装型组件，可被 LLM 调用，语义上不同于 Action。采用目录式组织，参考 [Agent Skills](https://agentskills.io/home) 规范。

## 目录结构

```text
skills/
  repo-explorer/
    SKILL.md            # 主入口
    scripts/            # 可执行脚本
    references/         # 补充文档
    assets/             # 资源、图片、数据
```

最小结构只需 `SKILL.md`。

## SKILL.md

`SKILL.md` 是 skill 主入口。Frontmatter 可选。

带 frontmatter：

```md
---
name: repo-explorer
description: Explore repository structure and summarize key modules.
---

# Repo Explorer

1. List key files and directories.
2. Read only the most relevant files first.
3. Summarize findings before taking action.
```

无 frontmatter：

```md
# 仓库探索器

1. 先列出关键目录和文件。
2. 优先阅读最相关的少量文件。
3. 输出结构化总结。
```

Frontmatter 可选字段：`name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`。

## 加载规则

| 阶段 | 行为 |
| --- | --- |
| 发现 | 读取 `SKILL.md` frontmatter；无 frontmatter 则从目录名和正文推断元数据 |
| 注册 | 将 skill catalog 注入 system prompt |
| 激活 | 通过 `Skill` 工具读取完整 `SKILL.md` |
| 资源访问 | 调用 `Skill({ name, resource_path })` 读取目录内资源文件 |

**优先级：** `.openharness/skills/*` > `settings.skill_dirs` 声明顺序。

同名冲突处理遵循 settings 中的优先级规则。

## `Skill` 工具语义

```text
Skill({ name })              # 返回 skill 正文 + 可用资源列表
Skill({ name, resource_path })  # 返回指定资源文件内容
```

- `name` 必须命中当前 session/agent 可见的 skill
- Skill 内容视为按需加载，不属于初始 system prompt
