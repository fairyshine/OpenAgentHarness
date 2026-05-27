import type { Message, RunStep } from "@oah/api-contracts";

export interface ModelCallTraceMessage {
  role: Message["role"];
  content: Message["content"];
}

export interface ModelCallTraceToolCall {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

export interface ModelCallTraceToolResult {
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
}

export interface ModelCallTraceToolServer {
  name: string;
  transportType?: string;
  toolPrefix?: string;
  timeout?: number;
  include?: string[];
  exclude?: string[];
}

export interface ModelCallTraceEngineTool {
  name: string;
  description?: string;
  retryPolicy?: string;
  inputSchema?: unknown;
}

export interface ModelCallTraceInput {
  model?: string;
  canonicalModelRef?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  messageCount?: number;
  maxRetries?: number;
  activeToolNames: string[];
  engineToolNames: string[];
  engineTools: ModelCallTraceEngineTool[];
  toolServers: ModelCallTraceToolServer[];
  messages: ModelCallTraceMessage[];
}

export interface ModelCallTraceOutput {
  stepType?: string;
  text?: string;
  content?: unknown[];
  reasoning?: unknown[];
  usage?: Record<string, unknown>;
  warnings?: unknown[];
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  finishReason?: string;
  toolCallsCount?: number;
  toolResultsCount?: number;
  toolCalls: ModelCallTraceToolCall[];
  toolResults: ModelCallTraceToolResult[];
  errorMessage?: string;
}

export interface ModelCallTrace {
  id: string;
  seq: number;
  name?: string;
  agentName?: string;
  status: RunStep["status"];
  startedAt?: string;
  endedAt?: string;
  input: ModelCallTraceInput;
  output: ModelCallTraceOutput;
  rawInput: unknown;
  rawOutput: unknown;
}
