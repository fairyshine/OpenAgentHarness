import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";

import type { McpServerDefinition } from "@oah/runtime-core";
import { AppError } from "@oah/runtime-core";

export interface PreparedMcpTools {
  tools: ToolSet;
  close(): Promise<void>;
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

async function createClient(server: McpServerDefinition): Promise<MCPClient> {
  if (server.oauth) {
    throw new AppError(
      501,
      "mcp_oauth_not_implemented",
      `MCP server ${server.name} requests OAuth, which is not implemented yet.`
    );
  }

  if (server.transportType === "stdio") {
    if (!server.command) {
      throw new AppError(400, "invalid_mcp_server", `MCP server ${server.name} is missing command.`);
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
    throw new AppError(400, "invalid_mcp_server", `MCP server ${server.name} is missing url.`);
  }

  return createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {})
    }
  });
}

export async function prepareMcpTools(mcpServers: McpServerDefinition[] | undefined): Promise<PreparedMcpTools> {
  const enabledServers = (mcpServers ?? []).filter((server) => server.enabled);
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
      const client = await createClient(server);
      clients.push(client);

      const definitions = await client.listTools();
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
            `Duplicate MCP tool name detected: ${exposedToolName}. Adjust tool_prefix/include/exclude settings.`
          );
        }

        toolEntries.push([exposedToolName, toolDefinition]);
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
