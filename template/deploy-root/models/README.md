# Models

This template includes `openai-default.yaml`, which defines the default platform model used by the bundled starter runtimes.

For local daemon usage, set your API key before starting OAH:

```bash
export OPENAI_API_KEY=sk-...
oah daemon start
```

The included file intentionally does not store the key:

```yaml
openai-default:
  provider: openai
  name: gpt-5
```

If you prefer keeping the key reference in YAML, add `key: ${env.OPENAI_API_KEY}` to the model file. You can also define OpenAI-compatible or other supported providers here.
