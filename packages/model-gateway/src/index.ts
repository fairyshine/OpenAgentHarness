import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, modelMessageSchema, stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

import type { PlatformModelDefinition, PlatformModelRegistry } from "@oah/config";
import type { ModelGenerateResponse, Usage } from "@oah/api-contracts";
import type {
  GenerateModelInput,
  ModelGateway,
  RuntimeLogger,
  ModelStepPreparation,
  ModelStepResult,
  ModelStreamOptions,
  RuntimeToolSet,
  ToolServerDefinition,
  StreamedModelResponse
} from "@oah/runtime-core";
import { AppError } from "@oah/runtime-core";
import { prepareToolServers } from "./mcp-tools.js";
import { formatSupportedModelProviders } from "./providers.js";

export { prepareToolServers } from "./mcp-tools.js";
export {
  SUPPORTED_MODEL_PROVIDERS,
  SUPPORTED_MODEL_PROVIDER_IDS,
  formatSupportedModelProviders,
  isSupportedModelProvider,
  type SupportedModelProviderDefinition,
  type SupportedModelProviderId
} from "./providers.js";

function maybeToUrl(value: string): string | URL {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    return value;
  }

  try {
    return new URL(value);
  } catch {
    return value;
  }
}

function normalizeMessages(messages: GenerateModelInput["messages"]): ModelMessage[] | undefined {
  const normalized = (messages?.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => {
            if (part.type === "image") {
              return {
                ...part,
                image: maybeToUrl(part.image)
              };
            }

            if (part.type === "file") {
              return {
                ...part,
                data: maybeToUrl(part.data)
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

function toUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  };
}

function toPrompt(input: GenerateModelInput): { prompt: string } | { messages: ModelMessage[] } {
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

function toAiTools(
  tools: RuntimeToolSet | undefined,
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

function mergeToolSets(...toolSets: Array<ToolSet | undefined>): ToolSet | undefined {
  const mergedEntries = toolSets.flatMap((toolSet) => (toolSet ? Object.entries(toolSet) : []));
  if (mergedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(mergedEntries);
}

function replaceLeadingSystemMessages(
  messages: ModelMessage[],
  systemMessages: Array<{ role: "system"; content: string }>
): ModelMessage[] {
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
  const tail = firstNonSystemIndex === -1 ? [] : messages.slice(firstNonSystemIndex);
  return [...systemMessages.map((message) => ({ role: message.role, content: message.content })), ...tail] as ModelMessage[];
}

function toStepResult(step: {
  stepType?: string;
  text?: string;
  content?: unknown[];
  reasoning?: unknown[];
  usage?: Record<string, unknown>;
  warnings?: unknown[];
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  finishReason: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>;
}): ModelStepResult {
  return {
    ...(typeof step.stepType === "string" ? { stepType: step.stepType } : {}),
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

function toToolCall(toolCall: { toolCallId: string; toolName: string; input: unknown }) {
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input
  };
}

function toToolResult(toolResult: { toolCallId: string; toolName: string; output: unknown }) {
  return {
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    output: toolResult.output
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolErrors(step: ModelStepResult): Array<{ toolCallId: string; toolName: string; error: unknown }> {
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

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  return new Error("Unknown model stream error.");
}

export interface AiSdkModelGatewayOptions {
  defaultModelName: string;
  models: PlatformModelRegistry;
  logger?: RuntimeLogger | undefined;
}

export class AiSdkModelGateway implements ModelGateway {
  readonly #defaultModelName: string;
  readonly #models: PlatformModelRegistry;
  readonly #logger: RuntimeLogger | undefined;
  readonly #clients = new Map<string, LanguageModel>();

  constructor(options: AiSdkModelGatewayOptions) {
    this.#defaultModelName = options.defaultModelName;
    this.#models = options.models;
    this.#logger = options.logger;
  }

  async generate(input: GenerateModelInput, options?: { signal?: AbortSignal }): Promise<ModelGenerateResponse> {
    const modelName = input.model ?? this.#defaultModelName;
    const model = this.#resolveModel(modelName, input.modelDefinition);

    const result = await generateText({
      model,
      ...toPrompt(input),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
      ...(options?.signal ? { abortSignal: options.signal } : {})
    });

    return {
      model: modelName,
      text: result.text,
      ...(Array.isArray(result.content) ? { content: result.content } : {}),
      ...(Array.isArray(result.reasoning) ? { reasoning: result.reasoning } : {}),
      finishReason: result.finishReason,
      usage: toUsage(result.usage)
    };
  }

  async stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse> {
    const modelName = input.model ?? this.#defaultModelName;
    const model = this.#resolveModel(modelName, input.modelDefinition);
    const runtimeTools = toAiTools(options?.tools, options?.signal, options?.parallelToolCalls);
    const preparedToolServers = await prepareToolServers(
      (options as ModelStreamOptions & { toolServers?: ToolServerDefinition[] | undefined })?.toolServers,
      { logger: this.#logger }
    );
    const aiTools = mergeToolSets(runtimeTools, preparedToolServers.tools);
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      await preparedToolServers.close();
    };
    let observedStreamError: Error | undefined;
    this.#logger?.debug?.("Model gateway starting AI SDK stream.", {
      model: modelName,
      provider: input.modelDefinition?.provider,
      messageCount: input.messages?.length ?? 0,
      hasPrompt: typeof input.prompt === "string",
      toolNames: options?.tools ? Object.keys(options.tools) : [],
      toolServerNames: options?.toolServers?.map((server) => server.name) ?? [],
      maxSteps: options?.maxSteps,
      parallelToolCalls: options?.parallelToolCalls
    });

    const result = streamText({
      model,
      ...toPrompt(input),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
      ...(options?.signal ? { abortSignal: options.signal } : {}),
      onError: ({ error }) => {
        observedStreamError ??= toError(error);
        this.#logger?.error?.("Model gateway stream error observed.", {
          model: modelName,
          provider: input.modelDefinition?.provider,
          errorMessage: observedStreamError.message
        });
      },
      ...(aiTools
        ? {
            tools: aiTools,
            stopWhen: stepCountIs(Math.max(2, options?.maxSteps ?? 8))
          }
        : {}),
      ...(options?.prepareStep
        ? {
            prepareStep: async ({ stepNumber, messages, model: currentModel }) => {
              const preparation = (await options.prepareStep?.(stepNumber)) as ModelStepPreparation | undefined;
              if (!preparation) {
                return undefined;
              }

              return {
                ...(preparation.model
                  ? {
                      model: this.#resolveModel(preparation.model, preparation.modelDefinition)
                    }
                  : { model: currentModel }),
                ...(preparation.messages
                  ? {
                      messages: preparation.messages
                    }
                  : {}),
                ...(preparation.systemMessages
                  ? {
                      messages: replaceLeadingSystemMessages(messages, preparation.systemMessages)
                    }
                  : {}),
                ...(preparation.activeToolNames ? { activeTools: preparation.activeToolNames } : {})
              };
            }
          }
        : {}),
      ...(options?.onStepFinish
        ? {
            onStepFinish: async (step) => {
              const stepResult = toStepResult(step);
              const toolErrors = extractToolErrors(stepResult);
              this.#logger?.debug?.("Model gateway step finished.", {
                model: modelName,
                provider: input.modelDefinition?.provider,
                finishReason: stepResult.finishReason ?? "unknown",
                toolCallsCount: stepResult.toolCalls.length,
                toolResultsCount: stepResult.toolResults.length,
                toolErrorsCount: toolErrors.length,
                toolErrorIds: toolErrors.map((toolError) => toolError.toolCallId)
              });
              await options.onStepFinish?.(stepResult);
            }
          }
        : {}),
      ...(options?.onToolCallStart
        ? {
            experimental_onToolCallStart: async (event) => {
              this.#logger?.debug?.("Model gateway tool call started.", {
                model: modelName,
                provider: input.modelDefinition?.provider,
                toolCallId: event.toolCall.toolCallId,
                toolName: event.toolCall.toolName
              });
              await options.onToolCallStart?.(toToolCall(event.toolCall));
            }
          }
        : {}),
      ...(options?.onToolCallFinish
        ? {
            experimental_onToolCallFinish: async (event) => {
              if (!event.success) {
                this.#logger?.debug?.("Model gateway tool call finished with non-success status.", {
                  model: modelName,
                  provider: input.modelDefinition?.provider,
                  toolCallId: event.toolCall.toolCallId,
                  toolName: event.toolCall.toolName
                });
                return;
              }

              this.#logger?.debug?.("Model gateway tool call finished.", {
                model: modelName,
                provider: input.modelDefinition?.provider,
                toolCallId: event.toolCall.toolCallId,
                toolName: event.toolCall.toolName
              });
              await options.onToolCallFinish?.(
                toToolResult({
                  toolCallId: event.toolCall.toolCallId,
                  toolName: event.toolCall.toolName,
                  output: event.output
                })
              );
            }
          }
        : {})
    });

    return {
      chunks: (async function* () {
        try {
          for await (const chunk of result.textStream) {
            yield chunk;
          }
        } finally {
          await cleanup();
        }
      })(),
      completed: Promise.all([result.text, result.finishReason, result.usage, result.content, result.reasoning])
        .then(([text, finishReason, usage, content, reasoning]) => ({
          model: modelName,
          text,
          ...(Array.isArray(content) ? { content } : {}),
          ...(Array.isArray(reasoning) ? { reasoning } : {}),
          finishReason,
          usage: toUsage(usage)
        }))
        .catch((error) => {
          throw observedStreamError ?? error;
        })
        .finally(cleanup)
    };
  }

  #resolveModel(modelName: string, modelDefinition?: PlatformModelDefinition): LanguageModel {
    const cacheKey = modelDefinition ? modelName : this.#canonicalModelName(modelName);
    const cached = this.#clients.get(cacheKey);
    if (cached) {
      return cached;
    }

    const definition = modelDefinition ?? this.#models[this.#canonicalModelName(modelName)];
    if (!definition) {
      throw new AppError(404, "model_not_found", `Model ${modelName} was not found.`);
    }

    const model = this.#createLanguageModel(definition, modelName);
    this.#clients.set(cacheKey, model);
    return model;
  }

  #createLanguageModel(definition: PlatformModelDefinition, modelName: string): LanguageModel {
    switch (definition.provider) {
      case "openai": {
        const provider = createOpenAI({
          ...(definition.key ? { apiKey: definition.key } : {}),
          ...(definition.url ? { baseURL: definition.url } : {})
        });
        return provider(definition.name);
      }
      case "openai-compatible": {
        if (!definition.url) {
          throw new AppError(
            400,
            "invalid_model_definition",
            `Provider ${definition.provider} requires a base URL for model ${modelName}.`,
            { provider: definition.provider, model: modelName }
          );
        }

        const provider = createOpenAICompatible({
          name: definition.provider,
          baseURL: definition.url,
          ...(definition.key ? { apiKey: definition.key } : {}),
          includeUsage: true
        });
        return provider(definition.name);
      }
      default:
        throw new AppError(
          400,
          "unsupported_model_provider",
          `Provider ${definition.provider} is not supported in Phase 1A. Supported providers: ${formatSupportedModelProviders()}.`,
          { provider: definition.provider, model: modelName }
        );
    }
  }

  #canonicalModelName(modelName: string): string {
    return modelName.startsWith("platform/") ? modelName.slice("platform/".length) : modelName;
  }
}
