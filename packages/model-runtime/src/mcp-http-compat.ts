import type { ListToolsResult } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema } from "ai";

import type { ToolServerDefinition } from "@oah/engine-core";
import { AppError } from "@oah/engine-core";
import type {
  CompatibilityCallToolResult,
  PrepareToolServersOptions,
  ToolServerClient
} from "./mcp-types.js";
import { normalizeRemoteMcpUrl } from "./mcp-endpoint-utils.js";
import { toJsonValue, withServerTimeout } from "./mcp-tool-utils.js";

const HTTP_MCP_COMPATIBLE_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;

function parseSupportedProtocolVersions(message: string): string[] {
  const match = message.match(/supported versions:\s*([^)]+)/iu);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function resolveCompatibleProtocolVersion(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/unsupported protocol version/iu.test(message)) {
    return undefined;
  }

  const supportedVersions = parseSupportedProtocolVersions(message);
  return HTTP_MCP_COMPATIBLE_PROTOCOL_VERSIONS.find((version) => supportedVersions.includes(version));
}

function toFetchHeaders(
  server: ToolServerDefinition,
  protocolVersion: string,
  sessionId?: string
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(server.headers ?? {})
  };
}

async function parseJsonRpcResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  const chunks = text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  for (const chunk of chunks) {
    const dataLine = chunk
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("data:"));
    if (!dataLine) {
      continue;
    }

    const payload = dataLine.slice(5).trim();
    if (payload.length === 0) {
      continue;
    }

    return JSON.parse(payload);
  }

  throw new Error("MCP HTTP compatibility client received no JSON-RPC payload.");
}

async function sendCompatibilityRequest(
  server: ToolServerDefinition,
  protocolVersion: string,
  message: Record<string, unknown>,
  sessionId?: string
): Promise<{ payload?: Record<string, unknown>; sessionId?: string }> {
  if (!server.url) {
    throw new AppError(400, "invalid_mcp_server", `Tool server ${server.name} is missing url.`);
  }

  const resolvedUrl = normalizeRemoteMcpUrl(server.url);

  const response = await fetch(resolvedUrl, {
    method: "POST",
    headers: toFetchHeaders(server, protocolVersion, sessionId),
    body: JSON.stringify(message)
  });

  const responseSessionId = response.headers.get("mcp-session-id") ?? sessionId ?? undefined;
  if (response.status === 202) {
    return {
      ...(responseSessionId ? { sessionId: responseSessionId } : {})
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MCP HTTP compatibility client failed (HTTP ${response.status}): ${text}`);
  }

  const payload = await parseJsonRpcResponse(response);
  if (!payload || typeof payload !== "object") {
    throw new Error("MCP HTTP compatibility client received an invalid JSON-RPC response.");
  }

  if ("error" in payload && payload.error && typeof payload.error === "object") {
    const messageText =
      "message" in payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : JSON.stringify(payload.error);
    throw new Error(messageText);
  }

  return {
    payload: payload as Record<string, unknown>,
    ...(responseSessionId ? { sessionId: responseSessionId } : {})
  };
}

function compatibilityToolResultToModelOutput({
  output
}: {
  toolCallId: string;
  input: unknown;
  output: unknown;
}) {
  const result = output as CompatibilityCallToolResult;
  if (!("content" in result) || !Array.isArray(result.content)) {
    return { type: "json" as const, value: toJsonValue(result) };
  }

  return {
    type: "content" as const,
    value: result.content.map((part: Record<string, unknown>) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return {
          type: "text" as const,
          text: String(part.text)
        };
      }

      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "image" &&
        "data" in part &&
        "mimeType" in part
      ) {
        return {
          type: "image-data" as const,
          data: String(part.data),
          mediaType: String(part.mimeType)
        };
      }

      return {
        type: "text" as const,
        text: JSON.stringify(part)
      };
    })
  };
}

export async function createCompatibilityHttpClient(
  server: ToolServerDefinition,
  protocolVersion: string,
  options?: PrepareToolServersOptions
): Promise<ToolServerClient> {
  let sessionId: string | undefined;
  let nextRequestId = 0;

  const initializeResponse = await sendCompatibilityRequest(
    server,
    protocolVersion,
    {
      jsonrpc: "2.0",
      id: String(++nextRequestId),
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "oah-mcp-compat-client",
          version: "1.0.0"
        }
      }
    },
    sessionId
  );
  sessionId = initializeResponse.sessionId ?? sessionId;

  await sendCompatibilityRequest(
    server,
    protocolVersion,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    },
    sessionId
  );

  options?.logger?.warn?.("Falling back to legacy MCP HTTP protocol version.", {
    serverName: server.name,
    transportType: server.transportType,
    url: server.url,
    protocolVersion
  });

  return {
    async listTools() {
      const response = await sendCompatibilityRequest(
        server,
        protocolVersion,
        {
          jsonrpc: "2.0",
          id: String(++nextRequestId),
          method: "tools/list",
          params: {}
        },
        sessionId
      );
      sessionId = response.sessionId ?? sessionId;
      const result = response.payload?.result;
      if (!result || typeof result !== "object" || !Array.isArray((result as ListToolsResult).tools)) {
        throw new Error(`Legacy MCP HTTP server ${server.name} returned an invalid tools/list result.`);
      }

      return result as ListToolsResult;
    },
    toolsFromDefinitions(definitions: ListToolsResult) {
      return Object.fromEntries(
        definitions.tools.map((definition) => [
          definition.name,
          dynamicTool({
            ...(typeof definition.description === "string" ? { description: definition.description } : {}),
            ...(definition.title ? { title: definition.title } : {}),
            inputSchema: jsonSchema({
              ...definition.inputSchema,
              properties: definition.inputSchema.properties ?? {},
              additionalProperties: false
            }),
            execute: async (args, executeOptions) => {
              const response = await withServerTimeout(
                server,
                sendCompatibilityRequest(
                  server,
                  protocolVersion,
                  {
                    jsonrpc: "2.0",
                    id: String(++nextRequestId),
                    method: "tools/call",
                    params: {
                      name: definition.name,
                      arguments: args as Record<string, unknown>
                    }
                  },
                  sessionId
                ),
                "tool call"
              );
              sessionId = response.sessionId ?? sessionId;
              const result = response.payload?.result;
              if (!result || typeof result !== "object") {
                throw new Error(`Legacy MCP HTTP server ${server.name} returned an invalid tools/call result.`);
              }
              executeOptions?.abortSignal?.throwIfAborted();
              return result as CompatibilityCallToolResult;
            },
            toModelOutput: compatibilityToolResultToModelOutput
          })
        ])
      );
    },
    async close() {
      if (!sessionId || !server.url) {
        return;
      }

      await fetch(server.url, {
        method: "DELETE",
        headers: {
          "mcp-protocol-version": protocolVersion,
          "mcp-session-id": sessionId,
          ...(server.headers ?? {})
        }
      }).catch(() => undefined);
    }
  };
}
