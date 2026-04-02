import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

import type { PlatformModelDefinition, PlatformModelRegistry } from "@oah/config";
import type { ModelGenerateResponse, Usage } from "@oah/api-contracts";
import type {
  GenerateModelInput,
  ModelGateway,
  McpServerDefinition,
  ModelStepPreparation,
  ModelStepResult,
  ModelStreamOptions,
  RuntimeToolSet,
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

function normalizeMessages(messages: GenerateModelInput["messages"]): ModelMessage[] | undefined {
  return messages?.map((message) => ({
    role: message.role,
    content: message.content
  })) as ModelMessage[] | undefined;
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
  finishReason: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>;
}): ModelStepResult {
  return {
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
}

export class AiSdkModelGateway implements ModelGateway {
  readonly #defaultModelName: string;
  readonly #models: PlatformModelRegistry;
  readonly #clients = new Map<string, LanguageModel>();

  constructor(options: AiSdkModelGatewayOptions) {
    this.#defaultModelName = options.defaultModelName;
    this.#models = options.models;
  }

  async generate(input: GenerateModelInput, options?: { signal?: AbortSignal }): Promise<ModelGenerateResponse> {
    const modelName = input.model ?? this.#defaultModelName;
    const model = this.#resolveModel(modelName, input.modelDefinition);

    const result = await generateText({
      model,
      ...toPrompt(input),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
      ...(options?.signal ? { abortSignal: options.signal } : {})
    });

    return {
      model: modelName,
      text: result.text,
      finishReason: result.finishReason,
      usage: toUsage(result.usage)
    };
  }

  async stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse> {
    const modelName = input.model ?? this.#defaultModelName;
    const model = this.#resolveModel(modelName, input.modelDefinition);
    const runtimeTools = toAiTools(options?.tools, options?.signal, options?.parallelToolCalls);
    const preparedToolServers = await prepareToolServers(
      (((options as ModelStreamOptions & { toolServers?: McpServerDefinition[] | undefined })?.toolServers ??
        options?.mcpServers) as McpServerDefinition[] | undefined)
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

    const result = streamText({
      model,
      ...toPrompt(input),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
      ...(options?.signal ? { abortSignal: options.signal } : {}),
      onError: ({ error }) => {
        observedStreamError ??= toError(error);
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
              await options.onStepFinish?.(toStepResult(step));
            }
          }
        : {}),
      ...(options?.onToolCallStart
        ? {
            experimental_onToolCallStart: async (event) => {
              await options.onToolCallStart?.(toToolCall(event.toolCall));
            }
          }
        : {}),
      ...(options?.onToolCallFinish
        ? {
            experimental_onToolCallFinish: async (event) => {
              if (!event.success) {
                return;
              }

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
      completed: Promise.all([result.text, result.finishReason, result.usage])
        .then(([text, finishReason, usage]) => ({
          model: modelName,
          text,
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
