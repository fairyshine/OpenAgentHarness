import type { ToolSet } from "ai";

import type { EngineLogger, ToolServerDefinition } from "@oah/engine-core";
import { AppError } from "@oah/engine-core";
import type { JsonValueLike } from "./mcp-types.js";

export function createShellWrappedCommand(command: string): { command: string; args: string[] } {
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

export function normalizePrefix(prefix: string | undefined): string | undefined {
  if (!prefix || prefix.trim().length === 0) {
    return undefined;
  }

  return prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
}

export function shouldIncludeTool(toolName: string, include: string[] | undefined, exclude: string[] | undefined): boolean {
  if (include && include.length > 0 && !include.includes(toolName)) {
    return false;
  }

  if (exclude && exclude.includes(toolName)) {
    return false;
  }

  return true;
}

export function toJsonValue(value: unknown): JsonValueLike {
  return JSON.parse(JSON.stringify(value)) as JsonValueLike;
}

export function logToolServerFailure(
  server: ToolServerDefinition,
  phase: string,
  error: unknown,
  logger: EngineLogger | undefined
): void {
  const details = {
    serverName: server.name,
    transportType: server.transportType,
    phase,
    ...(server.command ? { command: server.command } : {}),
    ...(server.workingDirectory ? { workingDirectory: server.workingDirectory } : {}),
    ...(server.url ? { url: server.url } : {}),
    error: error instanceof Error ? error.message : String(error)
  };

  if (server.transportType === "stdio") {
    logger?.error?.("Local MCP server failed during initialization.", details);
    if (!logger?.error) {
      console.error("[oah-runtime] Local MCP server failed during initialization.", details);
    }
    return;
  }

  logger?.warn?.("Remote MCP server failed during initialization.", details);
  if (!logger?.warn) {
    console.warn("[oah-runtime] Remote MCP server failed during initialization.", details);
  }
}

export async function withServerTimeout<T>(
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

export function shouldSkipRemoteServer(server: ToolServerDefinition, error: unknown): boolean {
  return server.transportType === "http" && !(error instanceof AppError);
}

function shortToolAlias(toolName: string): string | undefined {
  const separatorIndex = toolName.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === toolName.length - 1) {
    return undefined;
  }

  return toolName.slice(separatorIndex + 1);
}

export function withUniqueShortAliases(toolEntries: Array<[string, ToolSet[string]]>): Array<[string, ToolSet[string]]> {
  const aliasCandidates = new Map<string, Array<[string, ToolSet[string]]>>();

  for (const entry of toolEntries) {
    const alias = shortToolAlias(entry[0]);
    if (!alias) {
      continue;
    }

    const existing = aliasCandidates.get(alias) ?? [];
    existing.push(entry);
    aliasCandidates.set(alias, existing);
  }

  const reservedNames = new Set(toolEntries.map(([name]) => name));
  const aliasedEntries = [...toolEntries];

  for (const [alias, entries] of aliasCandidates) {
    const [entry] = entries;
    if (entries.length !== 1 || !entry || reservedNames.has(alias)) {
      continue;
    }

    aliasedEntries.push([alias, entry[1]]);
    reservedNames.add(alias);
  }

  return aliasedEntries;
}
