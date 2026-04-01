import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareMcpTools } from "../packages/model-gateway/dist/index.js";

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

    const prepared = await prepareMcpTools([
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
  });
});
