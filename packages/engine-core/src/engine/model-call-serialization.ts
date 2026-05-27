import type { ChatMessage, ModelGenerateResponse } from "@oah/api-contracts";
import { z } from "zod";

import {
  contentToPromptMessage,
  extractTextFromContent,
  isMessagePartList,
  isMessageRole,
  normalizeToolErrorOutput
} from "../execution-message-content.js";
import { MODEL_REQUEST_MAX_RETRIES, type ModelDefinition, type ModelStepResult, type EngineToolSet, type WorkspaceRecord } from "../types.js";

const MODEL_CALL_SNAPSHOT_MAX_CHARS = 128 * 1024;
const MODEL_CALL_SNAPSHOT_HEAD_MESSAGES = 4;
const MODEL_CALL_SNAPSHOT_TAIL_MESSAGES = 12;
const MODEL_CALL_SNAPSHOT_MAX_STRING_CHARS = 4096;
const MODEL_CALL_SNAPSHOT_MAX_ARRAY_ITEMS = 40;
const MODEL_CALL_SNAPSHOT_MAX_OBJECT_KEYS = 80;
const MODEL_CALL_SNAPSHOT_MAX_DEPTH = 6;

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

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateSnapshotString(value: string, maxChars = MODEL_CALL_SNAPSHOT_MAX_STRING_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  const head = Math.max(0, Math.floor(maxChars * 0.6));
  const tail = Math.max(0, maxChars - head);
  return `${value.slice(0, head)}\n[truncated ${value.length - maxChars} chars]\n${value.slice(-tail)}`;
}

function compactSnapshotValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateSnapshotString(value);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (depth >= MODEL_CALL_SNAPSHOT_MAX_DEPTH) {
    return "[truncated:max-depth]";
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MODEL_CALL_SNAPSHOT_MAX_ARRAY_ITEMS)
      .map((entry) => compactSnapshotValue(entry, depth + 1));
    return value.length > MODEL_CALL_SNAPSHOT_MAX_ARRAY_ITEMS
      ? [
          ...items,
          {
            truncated: true,
            omittedItems: value.length - MODEL_CALL_SNAPSHOT_MAX_ARRAY_ITEMS
          }
        ]
      : items;
  }

  const entries = Object.entries(value);
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, MODEL_CALL_SNAPSHOT_MAX_OBJECT_KEYS)) {
    compacted[key] = compactSnapshotValue(entry, depth + 1);
  }
  if (entries.length > MODEL_CALL_SNAPSHOT_MAX_OBJECT_KEYS) {
    compacted.__truncated = {
      omittedKeys: entries.length - MODEL_CALL_SNAPSHOT_MAX_OBJECT_KEYS
    };
  }
  return compacted;
}

function compactModelCallMessages(messages: ChatMessage[]) {
  const retainedIndexes = new Set<number>();
  for (let index = 0; index < Math.min(MODEL_CALL_SNAPSHOT_HEAD_MESSAGES, messages.length); index += 1) {
    retainedIndexes.add(index);
  }
  for (let index = Math.max(0, messages.length - MODEL_CALL_SNAPSHOT_TAIL_MESSAGES); index < messages.length; index += 1) {
    retainedIndexes.add(index);
  }

  const indexes = [...retainedIndexes].sort((left, right) => left - right);
  return {
    indexes,
    messages: indexes.map((index) => ({
      ...messages[index]!,
      content: compactSnapshotValue(messages[index]!.content)
    }))
  };
}

export function compactModelCallRequestSnapshot(request: Record<string, unknown>, messages: ChatMessage[]): Record<string, unknown> {
  if (safeJsonLength(request) <= MODEL_CALL_SNAPSHOT_MAX_CHARS) {
    return request;
  }

  const compacted = compactModelCallMessages(messages);
  return {
    ...request,
    messages: compacted.messages,
    messagesCompacted: {
      originalCount: messages.length,
      retainedCount: compacted.messages.length,
      retainedIndexes: compacted.indexes,
      maxSnapshotChars: MODEL_CALL_SNAPSHOT_MAX_CHARS,
      maxStringChars: MODEL_CALL_SNAPSHOT_MAX_STRING_CHARS
    }
  };
}

export function serializeEngineTools(engineTools: EngineToolSet): Array<Record<string, unknown>> {
  return Object.entries(engineTools).map(([name, definition]) => ({
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
  engineToolNames: string[],
  engineTools?: EngineToolSet | undefined
): Record<string, unknown> {
  return {
    messageCount: modelInput.messages.length,
    maxRetries: MODEL_REQUEST_MAX_RETRIES,
    engineToolNames,
    ...(engineTools ? { engineTools: serializeEngineTools(engineTools) } : {}),
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
  engineToolNames: string[],
  engineTools?: EngineToolSet | undefined
): Record<string, unknown> {
  const request = serializeModelCallRequestSnapshot(modelInput);
  return {
    request: compactModelCallRequestSnapshot(request, modelInput.messages),
    runtime: serializeModelCallRuntimeSnapshot(
      modelInput,
      activeToolNames,
      toolServers,
      engineToolNames,
      engineTools
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
