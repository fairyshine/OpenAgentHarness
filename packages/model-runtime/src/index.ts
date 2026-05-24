import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type StopCondition,
  type ToolSet
} from "ai";

import type { PlatformModelDefinition, PlatformModelRegistry } from "@oah/config";
import type { ModelGenerateResponse } from "@oah/api-contracts";
import type {
  GenerateModelInput,
  ModelGenerateOptions,
  ModelGateway,
  ModelStreamOptions,
  EngineLogger,
  ToolServerDefinition,
  StreamedModelResponse
} from "@oah/engine-core";
import { AppError } from "@oah/engine-core";
import {
  extractToolErrors,
  mergeToolSets,
  toAiTools,
  toError,
  toPrompt,
  toStepPreparation,
  toStepResult,
  toToolCall,
  toToolResult,
  toUsage
} from "./runtime-helpers.js";
import { prepareToolServers } from "./mcp-tools.js";
import { formatSupportedModelProviders } from "./providers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function toEngineMessages(messages: import("ai").ModelMessage[]): GenerateModelInput["messages"] {
  return messages as GenerateModelInput["messages"];
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return undefined;
  }

  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
}

function createTimeoutSignal(timeoutMs: number | undefined): { signal?: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { cleanup: () => undefined };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout)
  };
}

export { prepareToolServers } from "./mcp-tools.js";
export {
  SUPPORTED_MODEL_PROVIDERS,
  SUPPORTED_MODEL_PROVIDER_IDS,
  formatSupportedModelProviders,
  isSupportedModelProvider,
  type SupportedModelProviderDefinition,
  type SupportedModelProviderId
} from "./providers.js";

export interface AiSdkModelRuntimeOptions {
  defaultModelName: string;
  models: PlatformModelRegistry;
  logger?: EngineLogger | undefined;
}

export class AiSdkModelRuntime implements ModelGateway {
  readonly #defaultModelName: string;
  readonly #models: PlatformModelRegistry;
  readonly #logger: EngineLogger | undefined;
  readonly #clients = new Map<string, LanguageModel>();

  constructor(options: AiSdkModelRuntimeOptions) {
    this.#defaultModelName = options.defaultModelName;
    this.#models = options.models;
    this.#logger = options.logger;
  }

  clearModelCache(modelNames?: string[]): void {
    if (!modelNames || modelNames.length === 0) {
      this.#clients.clear();
      return;
    }

    for (const modelName of modelNames) {
      this.#clients.delete(this.#canonicalModelName(modelName));
    }
  }

  async generate(input: GenerateModelInput, options?: ModelGenerateOptions): Promise<ModelGenerateResponse> {
    const modelName = input.model ?? this.#defaultModelName;
    const model = this.#resolveModel(modelName, input.modelDefinition);
    const timeoutSignal = createTimeoutSignal(options?.timeoutMs);
    const generateSignal = combineAbortSignals(options?.signal, timeoutSignal.signal);

    try {
      const result = await generateText({
        model,
        ...toPrompt(input),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.topP !== undefined ? { topP: input.topP } : {}),
        ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
        ...(generateSignal ? { abortSignal: generateSignal } : {})
      });

      return {
        model: modelName,
        text: result.text,
        ...(Array.isArray(result.content) ? { content: result.content } : {}),
        ...(Array.isArray(result.reasoning) ? { reasoning: result.reasoning } : {}),
        finishReason: result.finishReason,
        usage: toUsage(result.usage)
      };
    } finally {
      timeoutSignal.cleanup();
    }
  }

  async stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse> {
    const modelName = input.model ?? this.#defaultModelName;
    const model = this.#resolveModel(modelName, input.modelDefinition);
    const timeoutSignal = createTimeoutSignal(options?.timeoutMs);
    const streamSignal = combineAbortSignals(options?.signal, timeoutSignal.signal);
    const engineTools = toAiTools(options?.tools, streamSignal, options?.parallelToolCalls);
    const preparedToolServers = await prepareToolServers(
      (options as ModelStreamOptions & { toolServers?: ToolServerDefinition[] | undefined })?.toolServers,
      { logger: this.#logger }
    );
    const aiTools = mergeToolSets(engineTools, preparedToolServers.tools);
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      timeoutSignal.cleanup();
      await preparedToolServers.close();
    };
    let observedStreamError: Error | undefined;
    this.#logger?.debug?.("Model runtime starting AI SDK stream.", {
      model: modelName,
      provider: input.modelDefinition?.provider,
      messageCount: input.messages?.length ?? 0,
      hasPrompt: typeof input.prompt === "string",
      toolNames: options?.tools ? Object.keys(options.tools) : [],
      toolServerNames: options?.toolServers?.map((server) => server.name) ?? [],
      maxSteps: options?.maxSteps,
      parallelToolCalls: options?.parallelToolCalls
    });

    const maxSteps = options?.maxSteps !== undefined ? Math.max(2, options.maxSteps) : undefined;
    const maxStepsStopCondition = maxSteps !== undefined ? stepCountIs(maxSteps) : undefined;
    let maxStepsReached = false;
    const stopWhen: StopCondition<ToolSet> | undefined = maxStepsStopCondition
      ? async (event) => {
          const shouldStop = await maxStepsStopCondition(event);
          if (shouldStop) {
            maxStepsReached = true;
          }
          return shouldStop;
        }
      : aiTools
        ? () => false
        : undefined;
    const result = streamText({
      model,
      ...toPrompt(input),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
      ...(streamSignal ? { abortSignal: streamSignal } : {}),
      onError: ({ error }) => {
        observedStreamError ??= toError(error);
        this.#logger?.error?.("Model runtime stream error observed.", {
          model: modelName,
          provider: input.modelDefinition?.provider,
          errorMessage: observedStreamError.message
        });
      },
      ...(aiTools
        ? {
            tools: aiTools,
            ...(stopWhen ? { stopWhen } : {})
          }
        : {}),
      ...(options?.prepareStep
        ? {
            prepareStep: async ({ stepNumber, messages, model: currentModel }) =>
              toStepPreparation(
                (await options.prepareStep?.(stepNumber, { messages: toEngineMessages(messages) })),
                messages,
                currentModel,
                (nextModelName, modelDefinition) => this.#resolveModel(nextModelName, modelDefinition)
              )
          }
        : {}),
      ...(options?.onStepFinish
        ? {
            onStepFinish: async (step) => {
              const stepResult = toStepResult(step);
              const toolErrors = extractToolErrors(stepResult);
              this.#logger?.debug?.("Model runtime step finished.", {
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
              this.#logger?.debug?.("Model runtime tool call started.", {
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
                this.#logger?.debug?.("Model runtime tool call finished with non-success status.", {
                  model: modelName,
                  provider: input.modelDefinition?.provider,
                  toolCallId: event.toolCall.toolCallId,
                  toolName: event.toolCall.toolName
                });
                return;
              }

              this.#logger?.debug?.("Model runtime tool call finished.", {
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
        : {}),
      ...(options?.onChunk
        ? {
            onChunk: async ({ chunk }) => {
              if (chunk.type === "reasoning-delta") {
                await options.onChunk?.({
                  type: "reasoning-delta",
                  id: chunk.id,
                  text: chunk.text
                });
                return;
              }

              if (chunk.type === "tool-input-start") {
                const toolCallId = readStringField(chunk, "toolCallId") ?? readStringField(chunk, "id");
                await options.onChunk?.({
                  type: "tool-input-start",
                  toolCallId: toolCallId ?? "",
                  toolName: chunk.toolName
                });
                return;
              }

              if (chunk.type === "tool-input-delta") {
                const toolCallId = readStringField(chunk, "toolCallId") ?? readStringField(chunk, "id");
                const inputTextDelta = readStringField(chunk, "inputTextDelta") ?? readStringField(chunk, "delta");
                await options.onChunk?.({
                  type: "tool-input-delta",
                  toolCallId: toolCallId ?? "",
                  inputTextDelta: inputTextDelta ?? ""
                });
                return;
              }

              if (chunk.type === "tool-call") {
                await options.onChunk?.({
                  type: "tool-input-available",
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  input: chunk.input
                });
              }
            }
          }
        : {})
    });

    return {
      chunks: (async function* () {
        try {
          for await (const chunk of result.fullStream) {
            if (chunk.type === "error") {
              observedStreamError ??= toError(chunk.error);
              continue;
            }

            if (chunk.type === "text-delta") {
              yield chunk.text;
            }
          }
        } finally {
          await cleanup();
        }
      })(),
      completed: Promise.all([result.text, result.finishReason, result.usage, result.content, result.reasoning, result.steps])
        .then(([text, finishReason, usage, content, reasoning, steps]) => {
          if (observedStreamError) {
            throw observedStreamError;
          }

          return {
            model: modelName,
            text,
            ...(Array.isArray(content) ? { content } : {}),
            ...(Array.isArray(reasoning) ? { reasoning } : {}),
            finishReason,
            ...(maxStepsReached ? { stopReason: "max_steps", stepCount: steps.length, maxSteps } : {}),
            usage: toUsage(usage)
          };
        })
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
      case "deepseek": {
        const provider = createDeepSeek({
          ...(definition.key ? { apiKey: definition.key } : {}),
          ...(definition.url ? { baseURL: definition.url } : {})
        });
        return provider(definition.name);
      }
      case "moonshotai": {
        const provider = createMoonshotAI({
          ...(definition.key ? { apiKey: definition.key } : {}),
          ...(definition.url ? { baseURL: definition.url } : {})
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
