import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPlatformModelCatalogService } from "../apps/server/src/bootstrap/platform-model-service.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("platform model service", () => {
  it("enriches openai-compatible models with max_model_len from /v1/models", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-platform-model-service-"));
    tempDirs.push(tempDir);

    const modelsDir = path.join(tempDir, "models");
    await mkdir(modelsDir, { recursive: true });
    await writeFile(
      path.join(modelsDir, "models.yaml"),
      `
openrouter-main:
  provider: openai-compatible
  key: secret-key
  url: https://llm.example.com/v1
  name: openai/gpt-5
  metadata:
    contextWindowTokens: 8192
`,
      "utf8"
    );

    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: unknown; init?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ input, init });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-5",
              max_model_len: 200_000
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    try {
      const service = await createPlatformModelCatalogService({
        modelDir: modelsDir,
        defaultModel: "openrouter-main",
        onLoadError({ error }) {
          throw error;
        }
      });

      const items = await service.listModels();

      expect(requests).toHaveLength(1);
      expect(String(requests[0]?.input)).toBe("https://llm.example.com/v1/models");
      expect(requests[0]?.init?.headers).toEqual({
        accept: "application/json",
        authorization: "Bearer secret-key"
      });
      expect(items).toEqual([
        expect.objectContaining({
          id: "openrouter-main",
          metadata: expect.objectContaining({
            max_model_len: 200_000,
            contextWindowTokens: 8192
          })
        })
      ]);
      expect(service.definitions["openrouter-main"]?.metadata).toEqual(
        expect.objectContaining({
          max_model_len: 200_000,
          contextWindowTokens: 8192
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
