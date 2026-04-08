import type { ChatMessage, ModelGenerateResponse } from "@oah/api-contracts";
import { z } from "zod";

import {
  contentToPromptMessage,
  extractTextFromContent,
  isMessagePartList,
  isMessageRole,
  normalizeToolErrorOutput
} from "../runtime-message-content.js";
import type { ModelDefinition, ModelStepResult, RuntimeToolSet, WorkspaceRecord } from "../types.js";

export interface ModelExecutionInputSnapshot {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  maxTokens?: number | undefined;
  messages: ChatMessage[];
}

export interface ResolvedRunModelSnapshot {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
}

export interface ToolErrorContentPart {
  type: "tool-error";
  toolCallId: string;
  toolName: string;
  error: unknown;
  input?: unknown;
  providerExecuted?: boolean | undefined;
}

interface ModelRequestPatchDependencies<TModelInput extends ModelExecutionInputSnapshot> {
  resolveModelForRun: (workspace: WorkspaceRecord, modelRef: string) => ResolvedRunModelSnapshot;
  collapseLeadingSystemMessages: (messages: ChatMessage[]) => ChatMessage[];
  createModelExecutionInput: (input: TModelInput) => TModelInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolErrorContentPart(value: unknown): value is ToolErrorContentPart {
  return (
    isRecord(value) &&
    value.type === "tool-error" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    "error" in value
  );
}

export function collapseLeadingSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const leadingSystemMessages: string[] = [];
  let firstNonSystemIndex = 0;

  while (firstNonSystemIndex < messages.length && messages[firstNonSystemIndex]?.role === "system") {
    leadingSystemMessages.push(extractTextFromContent(messages[firstNonSystemIndex]!.content));
    firstNonSystemIndex += 1;
  }

  if (leadingSystemMessages.length <= 1) {
    return messages;
  }

  return [
    {
      role: "system",
      content: leadingSystemMessages.join("\n\n")
    },
    ...messages.slice(firstNonSystemIndex)
  ];
}

export function serializeModelRequest(modelInput: ModelExecutionInputSnapshot): Record<string, unknown> {
  return {
    model: modelInput.model,
    canonicalModelRef: modelInput.canonicalModelRef,
    ...(modelInput.temperature !== undefined ? { temperature: modelInput.temperature } : {}),
    ...(modelInput.topP !== undefined ? { topP: modelInput.topP } : {}),
    ...(modelInput.maxTokens !== undefined ? { maxTokens: modelInput.maxTokens } : {}),
    messages: modelInput.messages
  };
}

export function serializeModelCallRequestSnapshot(modelInput: ModelExecutionInputSnapshot): Record<string, unknown> {
  return {
    ...serializeModelRequest(modelInput),
    ...(modelInput.provider ? { provider: modelInput.provider } : {})
  };
}

export function serializeRuntimeTools(runtimeTools: RuntimeToolSet): Array<Record<string, unknown>> {
  return Object.entries(runtimeTools).map(([name, definition]) => ({
    name,
    description: definition.description,
    ...(definition.retryPolicy ? { retryPolicy: definition.retryPolicy } : {}),
    inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(definition.inputSchema))) as Record<string, unknown>
  }));
}

export function serializeModelCallRuntimeSnapshot(
  modelInput: ModelExecutionInputSnapshot,
  activeToolNames: string[] | undefined,
  toolServers: WorkspaceRecord["toolServers"][string][],
  runtimeToolNames: string[],
  runtimeTools?: RuntimeToolSet | undefined
): Record<string, unknown> {
  return {
    messageCount: modelInput.messages.length,
    runtimeToolNames,
    ...(runtimeTools ? { runtimeTools: serializeRuntimeTools(runtimeTools) } : {}),
    ...(activeToolNames ? { activeToolNames } : {}),
    ...(toolServers.length > 0
      ? {
          toolServers: toolServers.map((server) => ({
            name: server.name,
            transportType: server.transportType,
            ...(server.toolPrefix ? { toolPrefix: server.toolPrefix } : {}),
            ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
            ...(server.include ? { include: server.include } : {}),
            ...(server.exclude ? { exclude: server.exclude } : {})
          }))
        }
      : {})
  };
}

export function serializeModelCallStepInput(
  modelInput: ModelExecutionInputSnapshot,
  activeToolNames: string[] | undefined,
  toolServers: WorkspaceRecord["toolServers"][string][],
  runtimeToolNames: string[],
  runtimeTools?: RuntimeToolSet | undefined
): Record<string, unknown> {
  return {
    request: serializeModelCallRequestSnapshot(modelInput),
    runtime: serializeModelCallRuntimeSnapshot(
      modelInput,
      activeToolNames,
      toolServers,
      runtimeToolNames,
      runtimeTools
    )
  };
}

export function extractFailedToolResults(step: ModelStepResult): ToolErrorContentPart[] {
  const responseContent = isRecord(step.response) && Array.isArray(step.response.content) ? step.response.content : [];
  const stepContent = Array.isArray(step.content) ? step.content : [];
  const successfulToolCallIds = new Set(step.toolResults.map((toolResult) => toolResult.toolCallId));
  const failedToolResults = new Map<string, ToolErrorContentPart>();

  for (const part of [...stepContent, ...responseContent]) {
    if (!isToolErrorContentPart(part) || successfulToolCallIds.has(part.toolCallId)) {
      continue;
    }

    failedToolResults.set(part.toolCallId, part);
  }

  return [...failedToolResults.values()];
}

export function serializeModelCallStepOutput(
  step: ModelStepResult,
  failedToolResults = extractFailedToolResults(step)
): Record<string, unknown> {
  return {
    response: {
      ...(typeof step.stepType === "string" ? { stepType: step.stepType } : {}),
      ...(typeof step.text === "string" ? { text: step.text } : {}),
      ...(Array.isArray(step.content) ? { content: step.content } : {}),
      ...(Array.isArray(step.reasoning) && step.reasoning.length > 0 ? { reasoning: step.reasoning } : {}),
      ...(step.usage ? { usage: step.usage } : {}),
      ...(Array.isArray(step.warnings) && step.warnings.length > 0 ? { warnings: step.warnings } : {}),
      ...(step.request ? { request: step.request } : {}),
      ...(step.response ? { response: step.response } : {}),
      ...(step.providerMetadata ? { providerMetadata: step.providerMetadata } : {}),
      finishReason: step.finishReason ?? "unknown",
      toolCalls: step.toolCalls.map((toolCall) => ({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input
      })),
      toolResults: step.toolResults.map((toolResult) => ({
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        output: toolResult.output
      })),
      ...(failedToolResults.length > 0
        ? {
            toolErrors: failedToolResults.map((toolError) => ({
              toolCallId: toolError.toolCallId,
              toolName: toolError.toolName,
              output: normalizeToolErrorOutput(toolError.error)
            }))
          }
        : {})
    },
    runtime: {
      toolCallsCount: step.toolCalls.length,
      toolResultsCount: step.toolResults.length,
      toolErrorsCount: failedToolResults.length
    }
  };
}

export function summarizeMessageRoles(messages: ChatMessage[]): Record<string, number> {
  return messages.reduce<Record<string, number>>((summary, message) => {
    summary[message.role] = (summary[message.role] ?? 0) + 1;
    return summary;
  }, {});
}

export function previewValue(value: unknown, maxLength = 240): string {
  if (value instanceof Error) {
    return value.message;
  }

  const serialized =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();

  if (serialized.length <= maxLength) {
    return serialized;
  }

  return `${serialized.slice(0, maxLength)}...`;
}

export function applyModelRequestPatch<TModelInput extends ModelExecutionInputSnapshot>(
  workspace: WorkspaceRecord,
  current: TModelInput,
  patch: Record<string, unknown>,
  dependencies: ModelRequestPatchDependencies<TModelInput>
): TModelInput {
  let next = dependencies.createModelExecutionInput(current);

  const patchedModelRef =
    typeof patch.model_ref === "string" ? patch.model_ref : typeof patch.model === "string" ? patch.model : undefined;
  if (patchedModelRef) {
    const resolved = dependencies.resolveModelForRun(workspace, patchedModelRef);
    next = dependencies.createModelExecutionInput({
      ...next,
      model: resolved.model,
      canonicalModelRef: resolved.canonicalModelRef,
      provider: resolved.provider,
      modelDefinition: resolved.modelDefinition
    });
  }

  if (typeof patch.temperature === "number") {
    next.temperature = patch.temperature;
  }
  if (typeof patch.topP === "number" || typeof patch.top_p === "number") {
    next.topP = typeof patch.topP === "number" ? patch.topP : (patch.top_p as number);
  }
  if (typeof patch.maxTokens === "number") {
    next.maxTokens = patch.maxTokens;
  }
  if (Array.isArray(patch.messages)) {
    next.messages = dependencies.collapseLeadingSystemMessages(
      patch.messages
        .filter(
          (message): message is ChatMessage =>
            typeof message === "object" &&
            message !== null &&
            isMessageRole((message as { role?: unknown }).role) &&
            (typeof (message as { content?: unknown }).content === "string" ||
              isMessagePartList((message as { content?: unknown }).content))
        )
        .map((message) => contentToPromptMessage(message.role, message.content))
    );
  }

  return next;
}

export function applyModelResponsePatch(
  response: ModelGenerateResponse,
  patch: Record<string, unknown>
): ModelGenerateResponse {
  return {
    ...response,
    ...(typeof patch.text === "string" ? { text: patch.text } : {}),
    ...(typeof patch.finishReason === "string" ? { finishReason: patch.finishReason } : {})
  };
}
