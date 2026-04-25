# Model Providers

当前 Open Agent Harness 支持的 `provider` 取值。新增 provider 时需同步更新 `packages/model-runtime/src/providers.ts` 和本文档。

## 支持列表

### `openai`

- AI SDK package: `@ai-sdk/openai`
- `url`: 不需要

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5
```

### `openai-compatible`

- AI SDK package: `@ai-sdk/openai-compatible`
- `url`: 必填

```yaml
openrouter-main:
  provider: openai-compatible
  key: ${env.OPENROUTER_API_KEY}
  url: https://openrouter.ai/api/v1
  name: openai/gpt-5
```

```yaml
kimi-campus:
  provider: openai-compatible
  key: ${env.KIMI_API_KEY}
  url: https://example.internal/v1
  name: Kimi-K25
```

## 选择建议

| 场景 | Provider |
| --- | --- |
| OpenAI 官方接口 | `openai` |
| 仅保证 `/chat/completions` 兼容的端点 | `openai-compatible` |

如果工具流或 assistant 历史消息行为异常，优先确认 provider 选择是否正确。
