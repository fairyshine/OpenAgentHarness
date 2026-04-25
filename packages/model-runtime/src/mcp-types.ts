import type { ListToolsResult } from "@ai-sdk/mcp";
import type { JSONValue, ToolSet } from "ai";

import type { EngineLogger } from "@oah/engine-core";

export interface PreparedToolServers {
  tools: ToolSet;
  close(): Promise<void>;
}

export interface PrepareToolServersOptions {
  logger?: EngineLogger | undefined;
}

export interface ToolServerClient {
  listTools(): Promise<ListToolsResult>;
  toolsFromDefinitions(definitions: ListToolsResult): ToolSet;
  close(): Promise<void>;
}

export type CompatibilityCallToolResult = Record<string, unknown> & {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  toolResult?: unknown;
  isError?: boolean;
};

export type JsonValueLike = JSONValue;
