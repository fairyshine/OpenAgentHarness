import { createServer, type Server } from "node:http";
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
const httpServers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(preparedClosers.splice(0).map((close) => close()));
  await Promise.allSettled(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
    )
  );
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

    expect(Object.keys(prepared.tools).sort()).toEqual(["mcp.docs.search", "search"]);
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

  it("adds unique short-name aliases for namespaced MCP tools", async () => {
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
        include: ["search"]
      }
    ]);
    preparedClosers.push(() => prepared.close());

    expect(Object.keys(prepared.tools).sort()).toEqual(["mcp.docs.search", "search"]);
    const result = await (prepared.tools.search.execute as (...args: unknown[]) => Promise<unknown>)(
      { query: "alias-check" },
      {}
    );

    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: 'tool:search args:{"query":"alias-check"}'
        }
      ]
    });
  }, 15_000);

  it("skips unreachable remote MCP servers instead of exposing them to the model", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "oah-mcp-"));
    const serverPath = path.join(tempDir, "fake-mcp.cjs");
    await writeFile(serverPath, `${MCP_SERVER_SOURCE}\n`, "utf8");
    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = [];

    const prepared = await prepareToolServers(
      [
        {
          name: "docs-server",
          enabled: true,
          transportType: "stdio",
          command: `node ${JSON.stringify(serverPath)}`,
          toolPrefix: "mcp.docs",
          include: ["search"]
        },
        {
          name: "web-search-mcp",
          enabled: true,
          transportType: "http",
          url: "http://127.0.0.1:9/mcp",
          timeout: 300
        }
      ],
      {
        logger: {
          warn(message, details) {
            warnings.push({ message, details });
          }
        }
      }
    );
    preparedClosers.push(() => prepared.close());

    expect(Object.keys(prepared.tools).sort()).toEqual(["mcp.docs.search", "search"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: "Skipping unreachable remote MCP server.",
      details: {
        serverName: "web-search-mcp",
        transportType: "http",
        url: "http://127.0.0.1:9/mcp"
      }
    });
  }, 15_000);

  it("logs local MCP startup failures with command and cwd details", async () => {
    const errors: Array<{ message: string; details?: Record<string, unknown> }> = [];

    await expect(
      prepareToolServers(
        [
          {
            name: "broken-local-mcp",
            enabled: true,
            transportType: "stdio",
            command: "node ./.openharness/tools/servers/broken/index.js",
            workingDirectory: "/tmp/oah-demo"
          }
        ],
        {
          logger: {
            error(message, details) {
              errors.push({ message, details });
            }
          }
        }
      )
    ).rejects.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: "Local MCP server failed during initialization.",
      details: {
        serverName: "broken-local-mcp",
        transportType: "stdio",
        phase: "client creation",
        command: "node ./.openharness/tools/servers/broken/index.js",
        workingDirectory: "/tmp/oah-demo"
      }
    });
  });

  it("falls back to a compatible legacy protocol version for older HTTP MCP servers", async () => {
    const sessionId = "legacy-session-id";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", () => {
        const protocolVersion = request.headers["mcp-protocol-version"];
        if (protocolVersion !== "2025-06-18") {
          response.writeHead(400, {
            "content-type": "application/json"
          });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Bad Request: Unsupported protocol version (supported versions: 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"
              },
              id: null
            })
          );
          return;
        }

        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (request.method === "DELETE") {
          response.writeHead(204);
          response.end();
          return;
        }

        if (body.method === "initialize") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": sessionId
          });
          response.end(
            `event: message\n` +
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: { listChanged: true } },
                  serverInfo: { name: "legacy-http", version: "1.0.0" }
                }
              })}\n\n`
          );
          return;
        }

        if (body.method === "notifications/initialized") {
          response.writeHead(202, {
            "mcp-session-id": sessionId
          });
          response.end();
          return;
        }

        if (request.headers["mcp-session-id"] !== sessionId) {
          response.writeHead(400, {
            "content-type": "application/json"
          });
          response.end(JSON.stringify({ error: { message: "Invalid or missing session ID" } }));
          return;
        }

        if (body.method === "tools/list") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": sessionId
          });
          response.end(
            `event: message\n` +
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  tools: [
                    {
                      name: "lookup",
                      description: "Legacy HTTP lookup",
                      inputSchema: {
                        type: "object",
                        properties: {
                          query: { type: "string" }
                        },
                        required: ["query"],
                        additionalProperties: false
                      }
                    }
                  ]
                }
              })}\n\n`
          );
          return;
        }

        if (body.method === "tools/call") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": sessionId
          });
          response.end(
            `event: message\n` +
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `legacy:${body.params?.name}:${body.params?.arguments?.query ?? ""}`
                    }
                  ]
                }
              })}\n\n`
          );
          return;
        }

        response.writeHead(404);
        response.end();
      });
    });
    httpServers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind legacy MCP test server."));
          return;
        }

        resolve(address.port);
      });
      server.on("error", reject);
    });

    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const prepared = await prepareToolServers(
      [
        {
          name: "legacy-http-lookup",
          enabled: true,
          transportType: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          toolPrefix: "mcp.legacy"
        }
      ],
      {
        logger: {
          warn(message, details) {
            warnings.push({ message, details });
          }
        }
      }
    );
    preparedClosers.push(() => prepared.close());

    expect(Object.keys(prepared.tools).sort()).toEqual(["lookup", "mcp.legacy.lookup"]);
    const result = await (prepared.tools["mcp.legacy.lookup"].execute as (...args: unknown[]) => Promise<unknown>)(
      { query: "openai" },
      {}
    );

    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: "legacy:lookup:openai"
        }
      ]
    });
    expect(warnings).toContainEqual({
      message: "Falling back to legacy MCP HTTP protocol version.",
      details: {
        serverName: "legacy-http-lookup",
        transportType: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        protocolVersion: "2025-06-18"
      }
    });
  });
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

  it("accepts AI SDK tool-result outputs and converts them to provider request format", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body });

      return new Response(
        [
          'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","created":1,"model":"mock-model","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","created":1,"model":"mock-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}',
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
          { role: "user", content: "run the tool" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "Bash",
                input: { command: "pwd" }
              }
            ]
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "Bash",
                output: {
                  type: "text",
                  value: "/tmp/demo"
                }
              }
            ]
          }
        ]
      });

      for await (const _chunk of response.chunks) {
        void _chunk;
      }

      await response.completed;

      expect(requests).toHaveLength(1);
      expect(requests[0]?.body.messages).toEqual([
        { role: "user", content: "run the tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "Bash",
                arguments: '{"command":"pwd"}'
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "/tmp/demo"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
