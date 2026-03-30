# Actions

## 目标

Action 表达一个可被模型和用户调用的命名任务入口。

Action 不再承担通用工作流 DSL 的职责，而是把固定执行逻辑封装成一个高层入口。

## 目录结构

最小结构：

```text
actions/
  test-run/
    ACTION.yaml
```

常见结构：

```text
actions/
  test-run/
    ACTION.yaml
    scripts/
    references/
    assets/
```

## 示例

```yaml
name: test.run
description: Run project tests

expose:
  to_llm: true
  callable_by_user: true
  callable_by_api: true

input_schema:
  type: object
  properties:
    watch:
      type: boolean
  additionalProperties: false

entry:
  command: npm test
```

## 当前 DSL 约束

- 一个 action 只声明一个入口
- 入口统一使用 `command`
- `command` 使用字符串
- shell 命令、本地脚本和解释器调用都通过 `command` 表达
- 复杂编排逻辑交给脚本或被调用的程序实现
- 不提供 steps / if / loop / matrix / DAG 语义

## 顶层字段

- `name`
- `description`
- `expose`
- `input_schema`
- `entry`

## `ACTION.yaml` 规范

`ACTION.yaml` 是 action 的主定义文件。

推荐与 action 目录配合使用：

- `scripts/`
  - action 内部用到的脚本
- `references/`
  - 补充文档
- `assets/`
  - 模板和静态资源

## `entry` 字段

建议结构：

```yaml
entry:
  command: npm test
```

字段说明：

- `command`
  - 命令字符串
- `environment`
  - 可选，追加环境变量
- `cwd`
  - 可选，工作目录
- `timeout_seconds`
  - 可选，当前 action 超时

规则：

- `command` 始终按 shell 命令字符串执行

## `command` 示例

字符串形式：

```yaml
entry:
  command: npm test
```

Python：

```yaml
entry:
  command: python ./scripts/run_tests.py --watch
```

JS：

```yaml
entry:
  command: node ./scripts/run-tests.js
```

TypeScript：

```yaml
entry:
  command: npx tsx ./scripts/code-review.ts
```

## 设计原则

- action 是命名任务入口，不是工作流语言
- action 内部复杂逻辑优先放在命令调用的脚本或程序中
- 模型调用 action 时，只需要理解 action 的高层语义，不需要关心内部实现
