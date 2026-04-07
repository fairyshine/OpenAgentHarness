import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";

import type { RuntimeLogger, ToolServerDefinition } from "@oah/runtime-core";
import { AppError } from "@oah/runtime-core";

export interface PreparedToolServers {
  tools: ToolSet;
  close(): Promise<void>;
}

export interface PrepareToolServersOptions {
  logger?: RuntimeLogger | undefined;
}

function createShellWrappedCommand(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", command]
  };
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (!prefix || prefix.trim().length === 0) {
    return undefined;
  }

  return prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
}

function shouldIncludeTool(toolName: string, include: string[] | undefined, exclude: string[] | undefined): boolean {
  if (include && include.length > 0 && !include.includes(toolName)) {
    return false;
  }

  if (exclude && exclude.includes(toolName)) {
    return false;
  }

  return true;
}

async function createClient(server: ToolServerDefinition): Promise<MCPClient> {
  if (server.oauth) {
    throw new AppError(
      501,
      "mcp_oauth_not_implemented",
      `Tool server ${server.name} requests OAuth over MCP, which is not implemented yet.`
    );
  }

  if (server.transportType === "stdio") {
    if (!server.command) {
      throw new AppError(400, "invalid_mcp_server", `Tool server ${server.name} is missing command.`);
    }

    const wrapped = createShellWrappedCommand(server.command);
    return createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: wrapped.command,
        args: wrapped.args,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
          ),
          ...(server.environment ?? {})
        }
      })
    });
  }

  if (!server.url) {
    throw new AppError(400, "invalid_mcp_server", `Tool server ${server.name} is missing url.`);
  }

  return createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {})
    }
  });
}

async function withServerTimeout<T>(
  server: ToolServerDefinition,
  operation: Promise<T>,
  phase: string
): Promise<T> {
  if (server.timeout === undefined || !Number.isFinite(server.timeout) || server.timeout <= 0) {
    return operation;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`MCP server ${server.name} timed out during ${phase} after ${server.timeout}ms.`));
        }, server.timeout);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function shouldSkipRemoteServer(server: ToolServerDefinition, error: unknown): boolean {
  return server.transportType === "http" && !(error instanceof AppError);
}

export async function prepareToolServers(
  toolServers: ToolServerDefinition[] | undefined,
  options?: PrepareToolServersOptions
): Promise<PreparedToolServers> {
  const enabledServers = (toolServers ?? []).filter((server) => server.enabled);
  if (enabledServers.length === 0) {
    return {
      tools: {},
      async close() {}
    };
  }

  const clients: MCPClient[] = [];
  const toolEntries: Array<[string, ToolSet[string]]> = [];

  try {
    for (const server of enabledServers) {
      let client: MCPClient | undefined;

      try {
        client = await withServerTimeout(server, createClient(server), "client creation");
        clients.push(client);

        const definitions = await withServerTimeout(server, client.listTools(), "tool listing");
        const filteredDefinitions = {
          ...definitions,
          tools: definitions.tools.filter((tool) => shouldIncludeTool(tool.name, server.include, server.exclude))
        };
        const serverTools = client.toolsFromDefinitions(filteredDefinitions);
        const prefix = normalizePrefix(server.toolPrefix);

        for (const [toolName, toolDefinition] of Object.entries(serverTools)) {
          const exposedToolName = prefix ? `${prefix}.${toolName}` : toolName;
          if (toolEntries.some(([existingName]) => existingName === exposedToolName)) {
            throw new AppError(
              409,
              "duplicate_mcp_tool_name",
              `Duplicate external tool name detected: ${exposedToolName}. Adjust tool_prefix/include/exclude settings.`
            );
          }

          toolEntries.push([exposedToolName, toolDefinition]);
        }
      } catch (error) {
        if (client) {
          await Promise.allSettled([client.close()]);
          const clientIndex = clients.indexOf(client);
          if (clientIndex >= 0) {
            clients.splice(clientIndex, 1);
          }
        }

        if (!shouldSkipRemoteServer(server, error)) {
          throw error;
        }

        options?.logger?.warn?.("Skipping unreachable remote MCP server.", {
          serverName: server.name,
          transportType: server.transportType,
          url: server.url,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      tools: Object.fromEntries(toolEntries),
      async close() {
        await Promise.allSettled(clients.map((client) => client.close()));
      }
    };
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
}
