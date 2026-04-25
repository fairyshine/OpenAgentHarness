import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";

import type { ToolServerDefinition } from "@oah/engine-core";
import { AppError } from "@oah/engine-core";
import { createCompatibilityHttpClient, resolveCompatibleProtocolVersion } from "./mcp-http-compat.js";
import { normalizeRemoteMcpUrl } from "./mcp-endpoint-utils.js";
import type {
  PreparedToolServers,
  PrepareToolServersOptions,
  ToolServerClient
} from "./mcp-types.js";
import {
  createShellWrappedCommand,
  logToolServerFailure,
  normalizePrefix,
  shouldIncludeTool,
  shouldSkipRemoteServer,
  withServerTimeout,
  withUniqueShortAliases
} from "./mcp-tool-utils.js";

export type { PreparedToolServers, PrepareToolServersOptions } from "./mcp-types.js";

async function createClient(server: ToolServerDefinition): Promise<ToolServerClient> {
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
        ...(server.workingDirectory ? { cwd: server.workingDirectory } : {}),
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

  const resolvedUrl = normalizeRemoteMcpUrl(server.url);

  return createMCPClient({
    transport: {
      type: "http",
      url: resolvedUrl,
      ...(server.headers ? { headers: server.headers } : {})
    }
  });
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

  const clients: ToolServerClient[] = [];
  const toolEntries: Array<[string, ToolSet[string]]> = [];

  try {
    for (const server of enabledServers) {
      let client: ToolServerClient | undefined;

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
        const compatibleProtocolVersion =
          server.transportType === "http" && !client ? resolveCompatibleProtocolVersion(error) : undefined;
        if (compatibleProtocolVersion) {
          try {
            client = await withServerTimeout(
              server,
              createCompatibilityHttpClient(server, compatibleProtocolVersion, options),
              "client creation"
            );
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
            continue;
          } catch (compatibilityError) {
            error = compatibilityError;
          }
        }

        if (server.transportType === "stdio" || !shouldSkipRemoteServer(server, error)) {
          logToolServerFailure(server, client ? "tool listing" : "client creation", error, options?.logger);
        }

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
      tools: Object.fromEntries(withUniqueShortAliases(toolEntries)),
      async close() {
        await Promise.allSettled(clients.map((client) => client.close()));
      }
    };
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
}
