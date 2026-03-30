# Skills

## 目标

Skill 表达能力封装型能力，仍可被 LLM 直接调用，但语义上不同于 Action。

Skill 采用目录式组织，参考 [Agent Skills](https://agentskills.io/home) 规范。

## 目录结构

最小结构：

```text
skills/
  repo-explorer/
    SKILL.md
```

常见结构：

```text
skills/
  repo-explorer/
    SKILL.md
    scripts/
    references/
    assets/
```

## `SKILL.md` 规范

`SKILL.md` 是 skill 的主入口文件。

frontmatter 是可选的，不做强约束。

如果提供 frontmatter，推荐字段包括：

- `name`
- `description`
- `license`
- `compatibility`
- `metadata`
- `allowed-tools`

frontmatter 和正文都应支持中文及其他 Unicode 字符。

带 frontmatter 的示例：

```md
---
name: repo-explorer
description: Explore repository structure and summarize key modules. Use when the task requires understanding project layout and major components.
---

# Repo Explorer

1. List key files and directories.
2. Read only the most relevant files first.
3. Summarize findings before taking action.
```

无 frontmatter 的示例：

```md
# 仓库探索器

适用于需要快速理解项目目录结构、核心模块和主要入口文件的场景。

1. 先列出关键目录和文件。
2. 优先阅读最相关的少量文件。
3. 输出结构化总结。
```

## 加载规则

- 发现阶段优先读取 `SKILL.md` frontmatter
- 若无 frontmatter，则从目录名和正文推断基础元数据
- 默认只将 skill catalog 注入到 system prompt
- 激活 skill 后通过 `activate_skill` 再读取完整 `SKILL.md`
- 若需要读取 skill 目录内的资源文件，继续调用 `activate_skill` 并传 `resource_path`
- `scripts/`、`references/`、`assets/` 按需加载
- skill 名称允许与目录名不同，但建议保持语义一致
- 同名 skill 的冲突处理遵循 workspace settings 中定义的优先级规则

## `activate_skill` 工具语义

建议结构：

```text
activate_skill({ name })
activate_skill({ name, resource_path })
```

规则：

- `name`
  - 必须命中当前 session / agent 可见的 skill 名称
- 无 `resource_path`
  - 返回 `<skill_content>`，其中包含 skill 正文和可用资源列表
- 有 `resource_path`
  - 返回 `<skill_resource>`，其中包含该资源文件内容
- skill 正文与资源文件内容都应视为按需加载内容，而不是初始 system prompt 的一部分

## 目录约定

- `scripts/`
  - 可执行脚本
- `references/`
  - 按需读取的补充文档
- `assets/`
  - 模板、图片、数据文件等静态资源
