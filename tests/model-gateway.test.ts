import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AiSdkModelGateway, prepareToolServers } from "@oah/model-gateway";

const globalWithAiSdkWarnings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
globalWithAiSdkWarnings.AI_SDK_LOG_WARNINGS = false;

const MCP_SERVER_SOURCE = String.raw`
const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

function reply(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (!("id" in message)) {
    return;
  }

  if (message.method === "initialize") {
    reply(message.id, {
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: {
          name: "fake-mcp",
          version: "1.0.0"
        },
        capabilities: {
          tools: {}
        }
      }
    });
    return;
  }

  if (message.method === "tools/list") {
    reply(message.id, {
      result: {
        tools: [
          {
            name: "search",
            description: "Search docs",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string"
                }
              }
            }
          },
          {
            name: "fetch",
            description: "Fetch docs",
            inputSchema: {
              type: "object",
              properties: {
                url: {
                  type: "string"
                }
              }
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    reply(message.id, {
      result: {
        content: [
          {
            type: "text",
            text: "tool:" + message.params.name + " args:" + JSON.stringify(message.params.arguments ?? {})
          }
        ]
      }
    });
  }
});
`;

const preparedClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(preparedClosers.splice(0).map((close) => close()));
});

describe("model gateway mcp tools", () => {
  it("loads MCP tools through AI SDK, applying prefix and include/exclude filters", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "oah-mcp-"));
    const serverPath = path.join(tempDir, "fake-mcp.cjs");
    await writeFile(serverPath, `${MCP_SERVER_SOURCE}\n`, "utf8");

    const prepared = await prepareToolServers([
      {
        name: "docs-server",
        enabled: true,
        transportType: "stdio",
        command: `node ${JSON.stringify(serverPath)}`,
        toolPrefix: "mcp.docs",
        include: ["search"],
        exclude: ["fetch"]
      }
    ]);
    preparedClosers.push(() => prepared.close());

    expect(Object.keys(prepared.tools)).toEqual(["mcp.docs.search"]);
    const result = await (prepared.tools["mcp.docs.search"].execute as (...args: unknown[]) => Promise<unknown>)(
      { query: "runtime" },
      {}
    );

    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: 'tool:search args:{"query":"runtime"}'
        }
      ]
    });
  }, 15_000);
});

describe("AiSdkModelGateway openai-compatible provider", () => {
  it("streams multi-turn chat through chat completions for openai-compatible models", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body });

      return new Response(
        [
          'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"mock-model","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"mock-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
          "data: [DONE]",
          ""
        ].join("\n\n"),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          }
        }
      );
    }) as typeof fetch;

    try {
      const gateway = new AiSdkModelGateway({
        defaultModelName: "mock-entry",
        models: {
          "mock-entry": {
            provider: "openai-compatible",
            key: "test-key",
            url: "http://mock.local/v1",
            name: "mock-model"
          }
        }
      });

      const response = await gateway.stream({
        model: "mock-entry",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "ping" }
        ]
      });

      let streamed = "";
      for await (const chunk of response.chunks) {
        streamed += chunk;
      }

      await expect(response.completed).resolves.toMatchObject({
        model: "mock-entry",
        text: "pong",
        finishReason: "stop"
      });
      expect(streamed).toBe("pong");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://mock.local/v1/chat/completions");
      expect(requests[0]?.body.stream).toBe(true);
      expect(requests[0]?.body.messages).toEqual([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "ping" }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves provider error details instead of masking them as no output", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "assistant messages are not supported" } }), {
        status: 400,
        headers: {
          "content-type": "application/json"
        }
      })) as typeof fetch;

    try {
      const gateway = new AiSdkModelGateway({
        defaultModelName: "mock-entry",
        models: {
          "mock-entry": {
            provider: "openai-compatible",
            key: "test-key",
            url: "http://mock.local/v1",
            name: "mock-model"
          }
        }
      });

      const response = await gateway.stream({
        model: "mock-entry",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "ping" }
        ]
      });

      for await (const _chunk of response.chunks) {
        void _chunk;
      }

      await expect(response.completed).rejects.toThrow("assistant messages are not supported");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
