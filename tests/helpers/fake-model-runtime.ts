import type { ModelGenerateResponse } from "@oah/api-contracts";
import type {
  GenerateModelInput,
  ModelGateway,
  ModelStepPreparation,
  ModelStreamOptions,
  StreamedModelResponse
} from "@oah/engine-core";

function extractText(content: GenerateModelInput["messages"] extends Array<infer T>
  ? T extends { content: infer C }
    ? C
    : never
  : never): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part?.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeModelGateway implements ModelGateway {
  readonly invocations: Array<{ model: string; input: GenerateModelInput }> = [];
  readonly delayMs: number;
  generateDelayMs = 0;
  maxConcurrentStreams = 0;
  maxConcurrentToolExecutions = 0;
  generateResponseFactory?: ((input: GenerateModelInput) => ModelGenerateResponse | undefined) | undefined;
  streamScenarioFactory?:
    | ((
        input: GenerateModelInput,
        options: ModelStreamOptions | undefined
      ) =>
        | {
            text?: string | undefined;
            content?: unknown[] | undefined;
            reasoning?: unknown[] | undefined;
            reasoningDeltas?: Array<{
              id?: string | undefined;
              text: string;
              delayMs?: number | undefined;
            }> | undefined;
            stepRequest?: Record<string, unknown> | undefined;
            stepResponse?: Record<string, unknown> | undefined;
            stepProviderMetadata?: Record<string, unknown> | undefined;
            preToolText?: string | undefined;
            preToolContent?: unknown[] | undefined;
            preToolReasoning?: unknown[] | undefined;
            toolSteps?: Array<{
              toolName: string;
              input: unknown;
              toolCallId?: string | undefined;
              delayMs?: number | undefined;
              continueOnError?: boolean | undefined;
            }> | undefined;
            toolBatches?:
              | Array<
                  Array<{
                    toolName: string;
                    input: unknown;
                    toolCallId?: string | undefined;
                    delayMs?: number | undefined;
                    continueOnError?: boolean | undefined;
                  }>
                >
              | undefined;
          }
        | undefined)
    | undefined;
  #activeStreams = 0;
  #activeToolExecutions = 0;

  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  async generate(input: GenerateModelInput, options?: { signal?: AbortSignal }): Promise<ModelGenerateResponse> {
    const modelName = input.model ?? "openai-default";
    this.invocations.push({ model: modelName, input });
    if (this.generateDelayMs > 0) {
      await sleepWithSignal(this.generateDelayMs, options?.signal);
    }
    const generated = this.generateResponseFactory?.(input);
    if (generated) {
      return generated;
    }

    return {
      model: modelName,
      text: this.#buildText(input),
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    };
  }

  async stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse> {
    const modelName = input.model ?? "openai-default";
    const scenario = this.streamScenarioFactory?.(input, options);
    let currentInput = { ...input };
    let currentModelName = modelName;
    const applyPreparation = async (stepNumber: number) => {
      const preparation = (await options?.prepareStep?.(stepNumber)) as ModelStepPreparation | undefined;
      if (!preparation) {
        return;
      }

      if (preparation.model) {
        currentModelName = preparation.model;
        currentInput = {
          ...currentInput,
          model: preparation.model,
          ...(preparation.modelDefinition ? { modelDefinition: preparation.modelDefinition } : {})
        };
      }

      if (preparation.messages) {
        currentInput = {
          ...currentInput,
          messages: preparation.messages
        };
      }

      if (preparation.systemMessages) {
        const tailMessages = (currentInput.messages ?? []).filter((message) => message.role !== "system");
        currentInput = {
          ...currentInput,
          messages: [...preparation.systemMessages, ...tailMessages]
        };
      }
    };

    await applyPreparation(0);
    let text = scenario?.text ?? this.#buildText(currentInput);
    let chunks = text.match(/.{1,4}/g) ?? [text];
    this.invocations.push({ model: currentModelName, input: currentInput });
    this.#activeStreams += 1;
    this.maxConcurrentStreams = Math.max(this.maxConcurrentStreams, this.#activeStreams);

    let resolveCompleted: (value: ModelGenerateResponse) => void;
    const completed = new Promise<ModelGenerateResponse>((resolve, reject) => {
      resolveCompleted = resolve;
      void reject;
    });

    const gateway = this;
    async function* streamGenerator() {
      let emitted = "";
      let preToolEmitted = "";

      try {
        const toolBatches =
          scenario?.toolBatches ?? (scenario?.toolSteps ?? []).map((toolStep) => [toolStep]);

        for (const [index, toolBatch] of toolBatches.entries()) {
          if (options?.signal?.aborted) {
            throw new Error("aborted");
          }

          if (index === 0 && typeof scenario?.preToolText === "string" && scenario.preToolText.length > 0) {
            const preToolChunks = scenario.preToolText.match(/.{1,4}/g) ?? [scenario.preToolText];
            for (const chunk of preToolChunks) {
              if (options?.signal?.aborted) {
                throw new Error("aborted");
              }

              if (gateway.delayMs > 0) {
                await sleep(gateway.delayMs);
              }

              preToolEmitted += chunk;
              yield chunk;
            }
          }

          const executeToolStep = async (
            toolStep: {
              toolName: string;
              input: unknown;
              toolCallId?: string | undefined;
              delayMs?: number | undefined;
              continueOnError?: boolean | undefined;
            },
            toolIndex: number
          ) => {
            const toolCallId = toolStep.toolCallId ?? `call_${index + 1}_${toolIndex + 1}`;
            await options?.onToolCallStart?.({
              toolCallId,
              toolName: toolStep.toolName,
              input: toolStep.input
            });

            gateway.#activeToolExecutions += 1;
            gateway.maxConcurrentToolExecutions = Math.max(
              gateway.maxConcurrentToolExecutions,
              gateway.#activeToolExecutions
            );

            try {
              if (toolStep.delayMs && toolStep.delayMs > 0) {
                await sleep(toolStep.delayMs);
              }

              const toolDefinition = options?.tools?.[toolStep.toolName];

              try {
                const toolResult = toolDefinition
                  ? await toolDefinition.execute(toolStep.input, {
                      abortSignal: options?.signal,
                      toolCallId
                    })
                  : `Error: Tool "${toolStep.toolName}" was not registered.`;

                await options?.onToolCallFinish?.({
                  toolCallId,
                  toolName: toolStep.toolName,
                  output: toolResult
                });

                return {
                  toolCall: {
                    toolCallId,
                    toolName: toolStep.toolName,
                    input: toolStep.input
                  },
                  toolResult: {
                    toolCallId,
                    toolName: toolStep.toolName,
                    output: toolResult
                  }
                };
              } catch (error) {
                if (!toolStep.continueOnError) {
                  throw error;
                }

                return {
                  toolCall: {
                    toolCallId,
                    toolName: toolStep.toolName,
                    input: toolStep.input
                  },
                  toolError: {
                    type: "tool-error" as const,
                    toolCallId,
                    toolName: toolStep.toolName,
                    input: toolStep.input,
                    error
                  }
                };
              }
            } finally {
              gateway.#activeToolExecutions -= 1;
            }
          };

          const executedBatch =
            options?.parallelToolCalls === false
              ? await toolBatch.reduce<Promise<Array<Awaited<ReturnType<typeof executeToolStep>>>>>(
                  async (previousPromise, toolStep, toolIndex) => {
                    const previous = await previousPromise;
                    return [...previous, await executeToolStep(toolStep, toolIndex)];
                  },
                  Promise.resolve([])
                )
              : await Promise.all(toolBatch.map((toolStep, toolIndex) => executeToolStep(toolStep, toolIndex)));

          await options?.onStepFinish?.({
            finishReason: "tool-calls",
            ...(preToolEmitted.length > 0 ? { text: preToolEmitted } : {}),
            ...(index === 0 && Array.isArray(scenario?.preToolContent) ? { content: scenario.preToolContent } : {}),
            ...(index === 0 && Array.isArray(scenario?.preToolReasoning) ? { reasoning: scenario.preToolReasoning } : {}),
            toolCalls: executedBatch.map((entry) => entry.toolCall),
            toolResults: executedBatch.flatMap((entry) => (entry.toolResult ? [entry.toolResult] : [])),
            ...(executedBatch.some((entry) => entry.toolError)
              ? {
                  response: {
                    content: executedBatch.flatMap((entry) => (entry.toolError ? [entry.toolError] : []))
                  }
                }
              : {})
          });

          await applyPreparation(index + 1);
          text = scenario?.text ?? gateway.#buildText(currentInput);
          chunks = text.match(/.{1,4}/g) ?? [text];
          gateway.invocations.push({ model: currentModelName, input: currentInput });
        }

        if (Array.isArray(scenario?.reasoningDeltas)) {
          for (const reasoningDelta of scenario.reasoningDeltas) {
            if (options?.signal?.aborted) {
              throw new Error("aborted");
            }

            if ((reasoningDelta.delayMs ?? gateway.delayMs) > 0) {
              await sleep(reasoningDelta.delayMs ?? gateway.delayMs);
            }

            await options?.onChunk?.({
              type: "reasoning-delta",
              id: reasoningDelta.id ?? "reasoning_1",
              text: reasoningDelta.text
            });
          }
        }

        for (const chunk of chunks) {
          if (options?.signal?.aborted) {
            throw new Error("aborted");
          }

          if (gateway.delayMs > 0) {
            await sleep(gateway.delayMs);
          }

          emitted += chunk;
          yield chunk;
        }

        await options?.onStepFinish?.({
          text: emitted,
          ...(Array.isArray(scenario?.content) ? { content: scenario.content } : {}),
          ...(Array.isArray(scenario?.reasoning) ? { reasoning: scenario.reasoning } : {}),
          ...(scenario?.stepRequest ? { request: scenario.stepRequest } : {}),
          ...(scenario?.stepResponse ? { response: scenario.stepResponse } : {}),
          ...(scenario?.stepProviderMetadata ? { providerMetadata: scenario.stepProviderMetadata } : {}),
          finishReason: "stop",
          toolCalls: [],
          toolResults: []
        });

        resolveCompleted({
          model: modelName,
          text: emitted,
          ...(Array.isArray(scenario?.content) ? { content: scenario.content } : {}),
          ...(Array.isArray(scenario?.reasoning) ? { reasoning: scenario.reasoning } : {}),
          finishReason: "stop",
          usage: {
            inputTokens: 10,
            outputTokens: emitted.length,
            totalTokens: emitted.length + 10
          }
        });
      } catch (error) {
        resolveCompleted({
          model: modelName,
          text: emitted,
          ...(Array.isArray(scenario?.content) ? { content: scenario.content } : {}),
          ...(Array.isArray(scenario?.reasoning) ? { reasoning: scenario.reasoning } : {}),
          finishReason: "stop",
          usage: {
            inputTokens: 10,
            outputTokens: emitted.length,
            totalTokens: emitted.length + 10
          }
        });
        throw error;
      } finally {
        gateway.#activeStreams -= 1;
      }
    }

    return {
      chunks: streamGenerator(),
      completed
    };
  }

  #buildText(input: GenerateModelInput): string {
    if (input.prompt) {
      return `generated:${input.prompt}`;
    }

    const latestMessageContent = input.messages?.at(-1)?.content;
    const latestMessage = latestMessageContent ? extractText(latestMessageContent) : "empty";
    return `reply:${latestMessage}`;
  }
}
