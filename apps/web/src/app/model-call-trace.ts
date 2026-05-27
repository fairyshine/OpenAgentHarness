import type { Message, RunStep } from "@oah/api-contracts";

import { isRecord, readStringArray } from "./support-core";
import { normalizeMessageContent } from "./message-content";
import type {
  ModelCallTrace,
  ModelCallTraceEngineTool,
  ModelCallTraceMessage,
  ModelCallTraceToolCall,
  ModelCallTraceToolResult,
  ModelCallTraceToolServer
} from "./model-call-trace-types";

function readModelCallTraceMessages(value: unknown): ModelCallTraceMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const role = entry.role;
    const content = normalizeMessageContent(entry.content);
    if (!["system", "user", "assistant", "tool"].includes(String(role)) || content === null) {
      return [];
    }

    return [
      {
        role: role as Message["role"],
        content
      }
    ];
  });
}

function readModelCallTraceToolServers(value: unknown): ModelCallTraceToolServer[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return [];
    }

    return [
      {
        name: entry.name,
        ...(typeof entry.transportType === "string" ? { transportType: entry.transportType } : {}),
        ...(typeof entry.toolPrefix === "string" ? { toolPrefix: entry.toolPrefix } : {}),
        ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
        ...(Array.isArray(entry.include) ? { include: readStringArray(entry.include) } : {}),
        ...(Array.isArray(entry.exclude) ? { exclude: readStringArray(entry.exclude) } : {})
      }
    ];
  });
}

function readModelCallTraceEngineTools(value: unknown): ModelCallTraceEngineTool[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return [];
    }

    return [
      {
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.retryPolicy === "string" ? { retryPolicy: entry.retryPolicy } : {}),
        ...("inputSchema" in entry ? { inputSchema: entry.inputSchema } : {})
      }
    ];
  });
}

function readModelCallTraceToolCalls(value: unknown): ModelCallTraceToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        ...(typeof entry.toolCallId === "string" ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.toolName === "string" ? { toolName: entry.toolName } : {}),
        ...("input" in entry ? { input: entry.input } : {})
      }
    ];
  });
}

function readModelCallTraceToolResults(value: unknown): ModelCallTraceToolResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        ...(typeof entry.toolCallId === "string" ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.toolName === "string" ? { toolName: entry.toolName } : {}),
        ...("output" in entry ? { output: entry.output } : {})
      }
    ];
  });
}

function toModelCallTrace(step: RunStep): ModelCallTrace | null {
  if (step.stepType !== "model_call") {
    return null;
  }

  const input = isRecord(step.input) ? step.input : {};
  const output = isRecord(step.output) ? step.output : {};
  const request = isRecord(input.request) ? input.request : {};
  const inputRuntime = isRecord(input.runtime) ? input.runtime : {};
  const response = isRecord(output.response) ? output.response : {};
  const outputRuntime = isRecord(output.runtime) ? output.runtime : {};

  return {
    id: step.id,
    seq: step.seq,
    ...(step.name ? { name: step.name } : {}),
    ...(step.agentName ? { agentName: step.agentName } : {}),
    status: step.status,
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt ? { endedAt: step.endedAt } : {}),
    input: {
      ...(typeof request.model === "string" ? { model: request.model } : {}),
      ...(typeof request.canonicalModelRef === "string" ? { canonicalModelRef: request.canonicalModelRef } : {}),
      ...(typeof request.provider === "string" ? { provider: request.provider } : {}),
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(typeof request.maxTokens === "number" ? { maxTokens: request.maxTokens } : {}),
      ...(typeof inputRuntime.messageCount === "number" ? { messageCount: inputRuntime.messageCount } : {}),
      ...(typeof inputRuntime.maxRetries === "number" ? { maxRetries: inputRuntime.maxRetries } : {}),
      activeToolNames: readStringArray(inputRuntime.activeToolNames),
      engineToolNames: readStringArray(inputRuntime.engineToolNames),
      engineTools: readModelCallTraceEngineTools(inputRuntime.engineTools),
      toolServers: readModelCallTraceToolServers(inputRuntime.toolServers),
      messages: readModelCallTraceMessages(request.messages)
    },
    output: {
      ...(typeof response.stepType === "string" ? { stepType: response.stepType } : {}),
      ...(typeof response.text === "string" ? { text: response.text } : {}),
      ...(Array.isArray(response.content) ? { content: response.content } : {}),
      ...(Array.isArray(response.reasoning) ? { reasoning: response.reasoning } : {}),
      ...(isRecord(response.usage) ? { usage: response.usage } : {}),
      ...(Array.isArray(response.warnings) ? { warnings: response.warnings } : {}),
      ...(isRecord(response.request) ? { request: response.request } : {}),
      ...(isRecord(response.response) ? { response: response.response } : {}),
      ...(isRecord(response.providerMetadata) ? { providerMetadata: response.providerMetadata } : {}),
      ...(typeof response.finishReason === "string" ? { finishReason: response.finishReason } : {}),
      ...(typeof outputRuntime.toolCallsCount === "number" ? { toolCallsCount: outputRuntime.toolCallsCount } : {}),
      ...(typeof outputRuntime.toolResultsCount === "number" ? { toolResultsCount: outputRuntime.toolResultsCount } : {}),
      ...(typeof response.errorMessage === "string" ? { errorMessage: response.errorMessage } : {}),
      toolCalls: readModelCallTraceToolCalls(response.toolCalls),
      toolResults: readModelCallTraceToolResults(response.toolResults)
    },
    rawInput: step.input,
    rawOutput: step.output
  };
}

export { toModelCallTrace };
