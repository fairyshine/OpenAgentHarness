# Models

## 双层来源

系统维护两类模型入口：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 平台级 | 服务端 `paths.model_dir` | 由服务端配置并注册 |
| Workspace 级 | `.openharness/models/*.yaml` | 由 workspace 声明 |

两类入口使用同一套 YAML 结构。进入 workspace 时，运行时将两者合并成可见 catalog。

## 引用方式

模型入口本身仍然定义在 `.openharness/models/*.yaml` 或平台 `model_dir` 中，但 agent 不再直接写具体 `model_ref`。

推荐做法：

1. 在 `.openharness/settings.yaml` 里声明模型别名
2. 在 `.openharness/agents/*.md` 里通过 `model` 直接引用

例如：

```yaml
# .openharness/settings.yaml
models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    max_tokens: 2048
  planner:
    ref: workspace/openrouter-personal
```

```yaml
# .openharness/agents/builder.md
model: default
```

加载时，运行时会把别名解析成具体 `model_ref`，并带上该别名对应的默认推理参数。因此“切换具体模型”或调整这组默认参数，都只需要修改 `settings.yaml`。

## Model YAML 示例

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5

openrouter-main:
  provider: openai-compatible
  key: ${env.OPENROUTER_API_KEY}
  url: https://openrouter.ai/api/v1
  name: openai/gpt-5
```

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 顶层 key | 是 | 模型入口名称，支持中文 |
| `provider` | 是 | AI SDK provider 标识，见 [model-providers](./model-providers.md) |
| `key` | 是 | 密钥引用，建议 `${env.OPENAI_API_KEY}` |
| `url` | 否 | 自定义 endpoint（`openai-compatible` 必填） |
| `name` | 是 | 对应的模型名 |

一个文件可声明多个模型入口。具体 `model_ref` 中的名称部分支持中文和其他 Unicode 字符。

## Context Window 发现与 Compact 优先级

对于 `openai-compatible` 模型，无论它来自服务端 `model_dir` 还是 workspace 本地 `.openharness/models/*.yaml`，服务端都会在发现该模型后尽力请求对应模型接口的 `/v1/models` 列表，并读取匹配模型卡上的 `max_model_len`。

compact 机制判断上下文窗口时，采用明确的两级优先级：

1. 优先使用模型 API 返回的 `max_model_len`
2. 若未拿到该字段，则回退到本地模型 metadata 里的 `contextWindowTokens`

如果这两个来源都不存在，运行时不会基于上下文窗口自动触发 compact。

这个在线探测是 best-effort 的：请求失败、接口未返回该字段，或模型名未匹配时，不会阻止模型加载，只会继续使用本地 metadata 回退。
