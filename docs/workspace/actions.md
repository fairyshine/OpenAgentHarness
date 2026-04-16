# Actions

Action 是可被模型和用户调用的命名任务入口。每个 action 封装固定执行逻辑，不承担通用工作流 DSL 职责。

## 目录结构

最小结构：

```text
actions/
  test-run/
    ACTION.yaml
```

完整结构：

```text
actions/
  test-run/
    ACTION.yaml
    scripts/      # 内部脚本
    references/   # 补充文档
    assets/       # 资源文件和静态资源
```

## 示例

```yaml
name: test.run
description: Run project tests

expose:
  to_llm: true
  callable_by_user: true
  callable_by_api: true

recovery:
  retry_policy: manual

input_schema:
  type: object
  properties:
    watch:
      type: boolean
  additionalProperties: false

entry:
  command: npm test
```

## 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | Action 名称 |
| `description` | 是 | 简短说明 |
| `expose` | 否 | 暴露策略（to_llm / callable_by_user / callable_by_api） |
| `input_schema` | 否 | JSON Schema 输入约束 |
| `recovery` | 否 | 重试策略 |
| `entry` | 是 | 执行入口 |

## `entry`

```yaml
entry:
  command: npm test
  environment:
    CI: "true"
  cwd: ./
  timeout_seconds: 300
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | Shell 命令字符串 |
| `environment` | 否 | 追加环境变量 |
| `cwd` | 否 | 工作目录 |
| `timeout_seconds` | 否 | 执行超时 |

## `recovery`

```yaml
recovery:
  retry_policy: safe
```

| 值 | 说明 |
| --- | --- |
| `manual` | 默认值。只允许人工或外部调用方显式重试 |
| `safe` | 仅用于已确认幂等的 action，为自动恢复提供信号 |

## DSL 约束

- 一个 action 只有一个入口，统一使用 `command`
- Shell 命令、脚本、解释器调用都通过 `command` 表达
- 复杂编排逻辑放在被调用的脚本或程序中
- 不提供 steps / if / loop / matrix / DAG 语义

## `command` 示例

```yaml
# Shell
entry:
  command: npm test

# Python
entry:
  command: python ./scripts/run_tests.py --watch

# Node.js
entry:
  command: node ./scripts/run-tests.js

# TypeScript
entry:
  command: npx tsx ./scripts/code-review.ts
```
