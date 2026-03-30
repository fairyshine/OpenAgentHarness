# Models

## Model 解析规则

### 双层来源

系统同时维护两类模型入口：

- 平台级模型入口
  - 由服务端配置并注册
- workspace 级模型入口
  - 由 `.openharness/models/*.yaml` 声明

### 可见性

进入某个 workspace 时，运行时会将两类模型入口合并成一个可见 catalog。

这意味着在同一个 workspace 内：

- 可以使用平台统一提供的模型入口
- 也可以使用项目自定义的模型入口

### 引用方式

Agent 必须通过 `model.model_ref` 显式引用模型入口。

建议格式：

- `platform/openai-default`
- `workspace/openrouter-personal`
- `workspace/中文模型`

这里的 `model_ref` 指向一个具体模型入口，而不是抽象 provider 连接。

## Model YAML 规范

Model YAML 用于声明 workspace 级模型入口。

其中 `provider` 字段应对齐 [AI SDK Providers](https://ai-sdk.dev/docs/foundations/providers-and-models#ai-sdk-providers)。

## 示例

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

## 关键字段

- 顶层 key
  - 模型入口的自定义名称
- `provider`
  - AI SDK provider 标识
- `key`
  - 密钥或密钥引用，建议使用变量引用
- `url`
  - 可选，自定义 endpoint 或兼容接口地址
- `name`
  - 该自定义名称对应的唯一模型名

说明：

- 一个文件可以声明多个模型入口
- 每个自定义名称只对应一个模型
- 顶层自定义名称支持中文和其他 Unicode 字符
- `model_ref` 中的自定义名称部分也支持中文和其他 Unicode 字符
- `key` 建议写变量引用，例如 `${env.OPENAI_API_KEY}`
