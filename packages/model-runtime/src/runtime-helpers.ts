import {
  type LanguageModel,
  modelMessageSchema,
  tool,
  type ModelMessage,
  type OnStepFinishEvent,
  type ToolSet
} from "ai";

import type { Usage } from "@oah/api-contracts";
import type {
  GenerateModelInput,
  ModelStepPreparation,
  ModelStepResult,
  EngineToolSet
} from "@oah/engine-core";
import { AppError } from "@oah/engine-core";

function maybeToUrl(value: string): string | URL {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    return trimmed;
  }

  try {
    return new URL(trimmed);
  } catch {
    return trimmed;
  }
}

function parseDataUrl(value: string): { mediaType?: string; data: string } | null {
  const match = value.trim().match(/^data:([^;,]+)?;base64,(.+)$/iu);
  if (!match?.[2]) {
    return null;
  }

  return {
    ...(match[1] ? { mediaType: match[1] } : {}),
    data: match[2]
  };
}

export function normalizeMessages(messages: GenerateModelInput["messages"]): ModelMessage[] | undefined {
  const normalized = (messages?.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => {
            if (part.type === "image") {
              const parsed = parseDataUrl(part.image);
              return {
                ...part,
                image: parsed?.data ?? maybeToUrl(part.image),
                mediaType: parsed?.mediaType ?? part.mediaType
              };
            }

            if (part.type === "file") {
              const parsed = parseDataUrl(part.data);
              return {
                ...part,
                data: parsed?.data ?? maybeToUrl(part.data),
                mediaType: parsed?.mediaType ?? part.mediaType
              };
            }

            return part;
          })
  })) ?? []) as ModelMessage[] | undefined;

  if (!normalized) {
    return undefined;
  }

  const parsed = modelMessageSchema.array().safeParse(normalized);
  if (!parsed.success) {
    throw new AppError(
      400,
      "invalid_model_messages",
      `Invalid AI SDK model messages: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }

  return parsed.data;
}

export function toUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  };
}

export function toPrompt(input: GenerateModelInput): { prompt: string } | { messages: ModelMessage[] } {
  if (input.prompt) {
    return { prompt: input.prompt };
  }

  const messages = normalizeMessages(input.messages);
  if (!messages || messages.length === 0) {
    throw new AppError(400, "invalid_model_input", "Either prompt or messages is required.");
  }

  return { messages };
}

function createSerialToolExecutor(): <T>(operation: () => Promise<T>) => Promise<T> {
  let queue = Promise.resolve();

  return async <T>(operation: () => Promise<T>) => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
}

export function toAiTools(
  tools: EngineToolSet | undefined,
  signal: AbortSignal | undefined,
  parallelToolCalls: boolean | undefined
): ToolSet | undefined {
  if (!tools || Object.keys(tools).length === 0) {
    return undefined;
  }

  const runSerially = parallelToolCalls === false ? createSerialToolExecutor() : undefined;

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [
      name,
      tool({
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (input, options) => {
          const executeTool = async () =>
            definition.execute(input, {
              abortSignal: signal,
              toolCallId: options.toolCallId
            });

          return runSerially ? runSerially(executeTool) : executeTool();
        }
      })
    ])
  );
}

export function mergeToolSets(...toolSets: Array<ToolSet | undefined>): ToolSet | undefined {
  const mergedEntries = toolSets.flatMap((toolSet) => (toolSet ? Object.entries(toolSet) : []));
  if (mergedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(mergedEntries);
}

export function replaceLeadingSystemMessages(
  messages: ModelMessage[],
  systemMessages: Array<{ role: "system"; content: string }>
): ModelMessage[] {
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
  const tail = firstNonSystemIndex === -1 ? [] : messages.slice(firstNonSystemIndex);
  return [...systemMessages.map((message) => ({ role: message.role, content: message.content })), ...tail] as ModelMessage[];
}

export function toStepResult(step: OnStepFinishEvent<ToolSet>): ModelStepResult {
  return {
    ...(typeof step.text === "string" ? { text: step.text } : {}),
    ...(Array.isArray(step.content) ? { content: step.content } : {}),
    ...(Array.isArray(step.reasoning) ? { reasoning: step.reasoning } : {}),
    ...(step.usage ? { usage: step.usage } : {}),
    ...(Array.isArray(step.warnings) ? { warnings: step.warnings } : {}),
    ...(step.request ? { request: step.request } : {}),
    ...(step.response ? { response: step.response } : {}),
    ...(step.providerMetadata ? { providerMetadata: step.providerMetadata } : {}),
    finishReason: step.finishReason,
    toolCalls: step.toolCalls.map((toolCall) => ({
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input
    })),
    toolResults: step.toolResults.map((toolResult) => ({
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      output: toolResult.output
    }))
  };
}

export function toToolCall(toolCall: { toolCallId: string; toolName: string; input: unknown }) {
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input
  };
}

export function toToolResult(toolResult: { toolCallId: string; toolName: string; output: unknown }) {
  return {
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    output: toolResult.output
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractToolErrors(step: ModelStepResult): Array<{ toolCallId: string; toolName: string; error: unknown }> {
  const responseContent = isRecord(step.response) && Array.isArray(step.response.content) ? step.response.content : [];
  const stepContent = Array.isArray(step.content) ? step.content : [];
  const successfulToolCallIds = new Set(step.toolResults.map((toolResult) => toolResult.toolCallId));
  const toolErrors = new Map<string, { toolCallId: string; toolName: string; error: unknown }>();

  for (const part of [...stepContent, ...responseContent]) {
    if (
      !isRecord(part) ||
      part.type !== "tool-error" ||
      typeof part.toolCallId !== "string" ||
      typeof part.toolName !== "string" ||
      !("error" in part) ||
      successfulToolCallIds.has(part.toolCallId)
    ) {
      continue;
    }

    toolErrors.set(part.toolCallId, {
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      error: part.error
    });
  }

  return [...toolErrors.values()];
}

export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  return new Error("Unknown model stream error.");
}

export function toStepPreparation(
  preparation: ModelStepPreparation | undefined,
  messages: ModelMessage[],
  currentModel: LanguageModel,
  resolveModel: (modelName: string, modelDefinition?: GenerateModelInput["modelDefinition"]) => LanguageModel
): { model: LanguageModel; messages?: ModelMessage[]; activeTools?: string[] } | undefined {
  if (!preparation) {
    return undefined;
  }

  const preparedMessages = preparation.messages ? normalizeMessages(preparation.messages) : undefined;
  const nextMessages = preparation.systemMessages
    ? replaceLeadingSystemMessages(preparedMessages ?? messages, preparation.systemMessages)
    : preparedMessages;

  return {
    ...(preparation.model
      ? {
          model: resolveModel(preparation.model, preparation.modelDefinition)
        }
      : { model: currentModel }),
    ...(nextMessages ? { messages: nextMessages } : {}),
    ...(preparation.activeToolNames ? { activeTools: preparation.activeToolNames } : {})
  };
}
