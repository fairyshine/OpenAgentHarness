import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import type {
  ActionRetryPolicy,
  ModelStepResult,
  ModelStreamOptions,
  EngineLogger,
  EngineToolSet,
  WorkspaceRecord
} from "../types.js";
import { assistantContentFromModelOutput } from "../execution-message-content.js";
import type { ModelExecutionInputSnapshot, ToolErrorContentPart } from "./model-call-serialization.js";

interface RunExecutionContextLike {
  currentAgentName: string;
  injectSystemReminder: boolean;
}

type ToolMessageMetadata = {
  toolStatus: "started" | "completed" | "failed";
  toolSourceType: "action" | "skill" | "agent" | "tool" | "native";
  toolDurationMs?: number | undefined;
};

type AssistantMessage = Extract<Message, { role: "assistant" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSystemMessageSignature(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || !Array.isArray(metadata.systemMessages)) {
    return undefined;
  }

  return JSON.stringify(metadata.systemMessages);
}

function buildDeltaEventMetadata(
  metadata: Record<string, unknown> | undefined,
  previousSystemMessageSignature: string | undefined
): {
  metadata?: Record<string, unknown> | undefined;
  systemMessageSignature: string | undefined;
} {
  if (!metadata) {
    return {
      metadata: undefined,
      systemMessageSignature: previousSystemMessageSignature
    };
  }

  const nextSystemMessageSignature = readSystemMessageSignature(metadata);
  if (nextSystemMessageSignature === undefined || nextSystemMessageSignature !== previousSystemMessageSignature) {
    return {
      metadata,
      systemMessageSignature: nextSystemMessageSignature
    };
  }

  if (!isRecord(metadata) || !("systemMessages" in metadata)) {
    return {
      metadata,
      systemMessageSignature: nextSystemMessageSignature
    };
  }

  const { systemMessages: _ignored, ...trimmedMetadata } = metadata;
  return {
    metadata: Object.keys(trimmedMetadata).length > 0 ? trimmedMetadata : undefined,
    systemMessageSignature: nextSystemMessageSignature
  };
}

function buildAgentEventMetadata(workspace: WorkspaceRecord, agentName: string): Record<string, unknown> {
  const agentMode = workspace.agents[agentName]?.mode;

  return {
    agentName,
    effectiveAgentName: agentName,
    ...(agentMode ? { agentMode } : {})
  };
}

function readToolResultText(output: unknown): string | undefined {
  if (typeof output === "string") {
    return output;
  }

  if (
    isRecord(output) &&
    (output.type === "text" || output.type === "error-text") &&
    typeof output.value === "string"
  ) {
    return output.value;
  }

  return undefined;
}

function inferSuccessfulToolMessageStatus(output: unknown): ToolMessageMetadata["toolStatus"] {
  return /^started:\s*true(?:\s|$)/mu.test(readToolResultText(output) ?? "") ? "started" : "completed";
}

export interface ModelStreamPlanningCapabilities<TModelInput extends ModelExecutionInputSnapshot> {
  buildModelInput: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    allMessages: Message[],
    activeAgentName: string,
    injectSystemReminder?: boolean
  ) => Promise<TModelInput>;
  applyBeforeModelHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: TModelInput
  ) => Promise<TModelInput>;
  getRun: (runId: string) => Promise<Run>;
  getActiveToolNames: (agentName: string) => string[] | undefined;
}

export interface ModelStreamStepCapabilities {
  startRunStep: (input: {
    runId: string;
    stepType: RunStep["stepType"];
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }) => Promise<RunStep>;
  completeRunStep: (
    step: RunStep,
    status: "completed" | "failed" | "cancelled",
    output?: Record<string, unknown> | undefined
  ) => Promise<RunStep>;
  setRunStatusIfPossible: (runId: string, nextStatus: Run["status"]) => Promise<void>;
  recordToolCallAuditFromStep: (
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ) => Promise<void>;
  runStepRetryPolicy: (step: RunStep) => ActionRetryPolicy | undefined;
}

export interface ModelStreamMessageCapabilities {
  ensureAssistantMessage: (
    session: Session,
    run: Run,
    currentMessage: AssistantMessage | undefined,
    allMessages?: Message[],
    content?: string,
    metadata?: Record<string, unknown> | undefined
  ) => Promise<AssistantMessage>;
  persistAssistantStepText: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    currentMessage: AssistantMessage | undefined,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ) => Promise<AssistantMessage | undefined>;
  persistAssistantToolCalls: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined,
    toolMetadataByCallId?: Map<string, ToolMessageMetadata> | undefined
  ) => Promise<void>;
  persistToolResults: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    failedToolResults: ToolErrorContentPart[],
    persistedToolCalls: Set<string>,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined,
    toolMetadataByCallId?: Map<string, ToolMessageMetadata> | undefined
  ) => Promise<void>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "message.delta" | "tool.completed";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  updateMessageContent: (message: AssistantMessage, content: string) => Promise<AssistantMessage>;
}

export interface ModelStreamSerializationCapabilities<TModelInput extends ModelExecutionInputSnapshot> {
  serializeModelCallStepInput: (
    modelInput: TModelInput,
    activeToolNames: string[] | undefined,
    toolServers: WorkspaceRecord["toolServers"][string][],
    engineToolNames: string[],
    engineTools?: EngineToolSet | undefined
  ) => Record<string, unknown>;
  serializeModelCallStepOutput: (
    step: ModelStepResult,
    failedToolResults: ToolErrorContentPart[]
  ) => Record<string, unknown>;
  extractFailedToolResults: (step: ModelStepResult) => ToolErrorContentPart[];
  buildGeneratedMessageMetadata: (
    workspace: WorkspaceRecord,
    agentName: string,
    modelInput: Pick<TModelInput, "messages">,
    modelCallStep?: Pick<RunStep, "id" | "seq"> | undefined
  ) => Record<string, unknown>;
  normalizeJsonObject: (value: unknown) => Record<string, unknown>;
  resolveToolSourceType: (toolName: string) => "action" | "skill" | "agent" | "tool" | "native";
  previewValue: (value: unknown, maxLength?: number) => string;
}

export interface ModelStreamCoordinatorDependencies<TModelInput extends ModelExecutionInputSnapshot> {
  workspace: WorkspaceRecord;
  session: Session;
  run: Run;
  executionContext: RunExecutionContextLike;
  allMessages: Message[];
  initialModelInput: TModelInput;
  engineTools: EngineToolSet;
  activeToolServers: WorkspaceRecord["toolServers"][string][];
  engineToolNames: string[];
  logger?: EngineLogger | undefined;
  planning: ModelStreamPlanningCapabilities<TModelInput>;
  steps: ModelStreamStepCapabilities;
  messages: ModelStreamMessageCapabilities;
  serialization: ModelStreamSerializationCapabilities<TModelInput>;
}

export class ModelStreamCoordinator<TModelInput extends ModelExecutionInputSnapshot> {
  readonly #workspace: WorkspaceRecord;
  readonly #session: Session;
  readonly #run: Run;
  readonly #executionContext: RunExecutionContextLike;
  readonly #allMessages: Message[];
  readonly #engineTools: EngineToolSet;
  readonly #activeToolServers: WorkspaceRecord["toolServers"][string][];
  readonly #engineToolNames: string[];
  readonly #logger?: EngineLogger | undefined;
  readonly #planning: ModelStreamPlanningCapabilities<TModelInput>;
  readonly #steps: ModelStreamStepCapabilities;
  readonly #messages: ModelStreamMessageCapabilities;
  readonly #serialization: ModelStreamSerializationCapabilities<TModelInput>;

  readonly #toolCallStartedAt = new Map<string, number>();
  readonly #toolCallSteps = new Map<string, RunStep>();
  readonly #activeToolCallIds = new Set<string>();
  readonly #modelCallSteps = new Map<number, RunStep>();
  readonly #modelCallMessageMetadata = new Map<number, Record<string, unknown>>();
  readonly #persistedToolCalls = new Set<string>();
  readonly #toolMessageMetadataByCallId = new Map<string, ToolMessageMetadata>();
  readonly #liveReasoningById = new Map<string, string>();
  readonly #liveReasoningOrder: string[] = [];

  #assistantMessage: AssistantMessage | undefined;
  #accumulatedText = "";
  #latestHookedModelInput: TModelInput;
  #latestMessageGenerationMetadata: Record<string, unknown> | undefined;
  #latestDeltaSystemMessageSignature: string | undefined;
  #finalAssistantStep: ModelStepResult | undefined;
  #completedModelStepCount = 0;

  constructor(dependencies: ModelStreamCoordinatorDependencies<TModelInput>) {
    this.#workspace = dependencies.workspace;
    this.#session = dependencies.session;
    this.#run = dependencies.run;
    this.#executionContext = dependencies.executionContext;
    this.#allMessages = dependencies.allMessages;
    this.#latestHookedModelInput = dependencies.initialModelInput;
    this.#engineTools = dependencies.engineTools;
    this.#activeToolServers = dependencies.activeToolServers;
    this.#engineToolNames = dependencies.engineToolNames;
    this.#logger = dependencies.logger;
    this.#planning = dependencies.planning;
    this.#steps = dependencies.steps;
    this.#messages = dependencies.messages;
    this.#serialization = dependencies.serialization;
  }

  get toolCallStartedAt(): Map<string, number> {
    return this.#toolCallStartedAt;
  }

  get toolCallSteps(): Map<string, RunStep> {
    return this.#toolCallSteps;
  }

  get toolMessageMetadataByCallId(): Map<string, ToolMessageMetadata> {
    return this.#toolMessageMetadataByCallId;
  }

  get latestHookedModelInput(): TModelInput {
    return this.#latestHookedModelInput;
  }

  get latestMessageGenerationMetadata(): Record<string, unknown> | undefined {
    return this.#latestMessageGenerationMetadata;
  }

  get finalAssistantStep(): ModelStepResult | undefined {
    return this.#finalAssistantStep;
  }

  get assistantMessage(): AssistantMessage | undefined {
    return this.#assistantMessage;
  }

  get modelCallSteps(): Map<number, RunStep> {
    return this.#modelCallSteps;
  }

  buildStreamOptions(): Pick<ModelStreamOptions, "prepareStep" | "onToolCallStart" | "onToolCallFinish" | "onStepFinish" | "onChunk"> {
    return {
      prepareStep: async (stepNumber) => {
        const activeToolNames = this.#planning.getActiveToolNames(this.#executionContext.currentAgentName);
        if (stepNumber === 0) {
          const initialModelCallStep = await this.#steps.startRunStep({
            runId: this.#run.id,
            stepType: "model_call",
            name: this.#latestHookedModelInput.model,
            agentName: this.#executionContext.currentAgentName,
            input: this.#serialization.serializeModelCallStepInput(
              this.#latestHookedModelInput,
              activeToolNames,
              this.#activeToolServers,
              this.#engineToolNames,
              this.#engineTools
            )
          });
          this.#modelCallSteps.set(stepNumber, initialModelCallStep);
          this.#latestMessageGenerationMetadata = this.#serialization.buildGeneratedMessageMetadata(
            this.#workspace,
            this.#executionContext.currentAgentName,
            this.#latestHookedModelInput,
            initialModelCallStep
          );
          this.#modelCallMessageMetadata.set(stepNumber, this.#latestMessageGenerationMetadata);
          this.#logger?.debug?.("Runtime prepared initial model step.", {
            workspaceId: this.#workspace.id,
            sessionId: this.#session.id,
            runId: this.#run.id,
            stepNumber,
            agentName: this.#executionContext.currentAgentName,
            model: this.#latestHookedModelInput.model,
            provider: this.#latestHookedModelInput.provider,
            canonicalModelRef: this.#latestHookedModelInput.canonicalModelRef,
            messageCount: this.#latestHookedModelInput.messages.length,
            activeToolNames
          });
          return activeToolNames ? { activeToolNames } : undefined;
        }

        const latestRun = await this.#planning.getRun(this.#run.id);
        const nextInput = await this.#planning.buildModelInput(
          this.#workspace,
          this.#session,
          latestRun,
          this.#allMessages,
          this.#executionContext.currentAgentName,
          this.#executionContext.injectSystemReminder
        );
        const hookedNextInput = await this.#planning.applyBeforeModelHooks(this.#workspace, this.#session, latestRun, nextInput);
        this.#latestHookedModelInput = hookedNextInput;
        this.#executionContext.injectSystemReminder = false;
        const followupModelCallStep = await this.#steps.startRunStep({
          runId: this.#run.id,
          stepType: "model_call",
          name: hookedNextInput.model,
          agentName: this.#executionContext.currentAgentName,
          input: this.#serialization.serializeModelCallStepInput(
            hookedNextInput,
            activeToolNames,
            this.#activeToolServers,
            this.#engineToolNames,
            this.#engineTools
          )
        });
        this.#modelCallSteps.set(stepNumber, followupModelCallStep);
        this.#latestMessageGenerationMetadata = this.#serialization.buildGeneratedMessageMetadata(
          this.#workspace,
          this.#executionContext.currentAgentName,
          hookedNextInput,
          followupModelCallStep
        );
        this.#modelCallMessageMetadata.set(stepNumber, this.#latestMessageGenerationMetadata);
        this.#logger?.debug?.("Runtime prepared follow-up model step.", {
          workspaceId: this.#workspace.id,
          sessionId: this.#session.id,
          runId: this.#run.id,
          stepNumber,
          agentName: this.#executionContext.currentAgentName,
          model: hookedNextInput.model,
          provider: hookedNextInput.provider,
          canonicalModelRef: hookedNextInput.canonicalModelRef,
          messageCount: hookedNextInput.messages.length,
          activeToolNames
        });

        return {
          model: hookedNextInput.model,
          ...(hookedNextInput.modelDefinition ? { modelDefinition: hookedNextInput.modelDefinition } : {}),
          messages: hookedNextInput.messages,
          ...(activeToolNames ? { activeToolNames } : {})
        };
      },
      onToolCallStart: async (toolCall) => {
        this.#toolCallStartedAt.set(toolCall.toolCallId, Date.now());
        this.#activeToolCallIds.add(toolCall.toolCallId);
        this.#logger?.debug?.("Runtime tool call started.", {
          workspaceId: this.#workspace.id,
          sessionId: this.#session.id,
          runId: this.#run.id,
          agentName: this.#executionContext.currentAgentName,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          inputPreview: this.#serialization.previewValue(toolCall.input)
        });
        await this.#syncRunStatusFromActiveTools();
      },
      onToolCallFinish: async (toolResult) => {
        const startedAt = this.#toolCallStartedAt.get(toolResult.toolCallId);
        this.#toolCallStartedAt.delete(toolResult.toolCallId);
        this.#activeToolCallIds.delete(toolResult.toolCallId);
        const toolStep = this.#toolCallSteps.get(toolResult.toolCallId);
        const toolAgentName = toolStep?.agentName ?? this.#executionContext.currentAgentName;
        const toolSourceType = this.#serialization.resolveToolSourceType(toolResult.toolName);
        const toolStatus = inferSuccessfulToolMessageStatus(toolResult.output);
        const retryPolicy = toolStep ? this.#steps.runStepRetryPolicy(toolStep) : undefined;
        this.#toolMessageMetadataByCallId.set(toolResult.toolCallId, {
          toolStatus,
          toolSourceType,
          ...(startedAt !== undefined ? { toolDurationMs: Date.now() - startedAt } : {})
        });
        if (toolStep) {
          const completedToolStep = await this.#steps.completeRunStep(toolStep, "completed", {
            sourceType: toolSourceType,
            ...(retryPolicy ? { retryPolicy } : {}),
            output: this.#serialization.normalizeJsonObject(toolResult.output),
            ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
          });
          await this.#steps.recordToolCallAuditFromStep(completedToolStep, toolResult.toolName, "completed");
          this.#toolCallSteps.delete(toolResult.toolCallId);
        }
        await this.#messages.appendEvent({
          sessionId: this.#session.id,
          runId: this.#run.id,
          event: "tool.completed",
          data: {
            runId: this.#run.id,
            sessionId: this.#session.id,
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            sourceType: toolSourceType,
            ...(retryPolicy ? { retryPolicy } : {}),
            output: toolResult.output,
            ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
            metadata: {
              ...buildAgentEventMetadata(this.#workspace, toolAgentName),
              toolStatus
            }
          }
        });
        this.#logger?.debug?.("Runtime tool call finished.", {
          workspaceId: this.#workspace.id,
          sessionId: this.#session.id,
          runId: this.#run.id,
          agentName: this.#executionContext.currentAgentName,
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          outputPreview: this.#serialization.previewValue(toolResult.output),
          ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
        });
        await this.#syncRunStatusFromActiveTools();
      },
      onChunk: async (chunk) => {
        if (chunk.type === "reasoning-delta") {
          await this.consumeReasoningDelta(chunk.id, chunk.text);
        }
      },
      onStepFinish: async (step) => {
        const messageMetadata =
          this.#modelCallMessageMetadata.get(this.#completedModelStepCount) ?? this.#latestMessageGenerationMetadata;
        const failedToolResults = this.#serialization.extractFailedToolResults(step);
        for (const toolError of failedToolResults) {
          this.#toolMessageMetadataByCallId.set(toolError.toolCallId, {
            toolStatus: "failed",
            toolSourceType: this.#serialization.resolveToolSourceType(toolError.toolName)
          });
          this.#toolCallStartedAt.delete(toolError.toolCallId);
          this.#toolCallSteps.delete(toolError.toolCallId);
          this.#activeToolCallIds.delete(toolError.toolCallId);
        }
        await this.#syncRunStatusFromActiveTools();
        const modelCallStep = this.#modelCallSteps.get(this.#completedModelStepCount);
        if (modelCallStep) {
          await this.#steps.completeRunStep(
            modelCallStep,
            "completed",
            this.#serialization.serializeModelCallStepOutput(step, failedToolResults)
          );
          this.#modelCallSteps.delete(this.#completedModelStepCount);
        }
        this.#modelCallMessageMetadata.delete(this.#completedModelStepCount);
        this.#completedModelStepCount += 1;
        this.#logger?.debug?.("Runtime model step finished.", {
          workspaceId: this.#workspace.id,
          sessionId: this.#session.id,
          runId: this.#run.id,
          stepNumber: this.#completedModelStepCount - 1,
          finishReason: step.finishReason ?? "unknown",
          toolCallsCount: step.toolCalls.length,
          toolResultsCount: step.toolResults.length,
          toolErrorsCount: failedToolResults.length,
          toolErrorIds: failedToolResults.map((toolError) => toolError.toolCallId)
        });
        if (
          step.toolCalls.length === 0 &&
          step.toolResults.length === 0 &&
          (typeof step.text === "string" || Array.isArray(step.content) || Array.isArray(step.reasoning))
        ) {
          this.#finalAssistantStep = step;
          if (Array.isArray(step.content) || Array.isArray(step.reasoning)) {
            const liveStructuredContent = assistantContentFromModelOutput({
              text: step.text,
              content: step.content,
              reasoning: step.reasoning
            });
            if (Array.isArray(liveStructuredContent)) {
              const assistantMessage = await this.#messages.ensureAssistantMessage(
                this.#session,
                this.#run,
                this.#assistantMessage,
                this.#allMessages,
                this.#accumulatedText,
                messageMetadata
              );
              this.#assistantMessage = assistantMessage;
              const deltaEventMetadata = buildDeltaEventMetadata(
                assistantMessage.metadata,
                this.#latestDeltaSystemMessageSignature
              );
              this.#latestDeltaSystemMessageSignature = deltaEventMetadata.systemMessageSignature;
              await this.#messages.appendEvent({
                sessionId: this.#session.id,
                runId: this.#run.id,
                event: "message.delta",
                data: {
                  runId: this.#run.id,
                  messageId: assistantMessage.id,
                  content: liveStructuredContent,
                  ...(deltaEventMetadata.metadata ? { metadata: deltaEventMetadata.metadata } : {})
                }
              });
            }
          }
        }
        if (step.toolCalls.length > 0) {
          await this.#messages.persistAssistantStepText(
            this.#session,
            this.#run,
            step,
            this.#assistantMessage,
            this.#allMessages,
            messageMetadata
          );
          this.#assistantMessage = undefined;
          this.#accumulatedText = "";
        }
        await this.#messages.persistAssistantToolCalls(
          this.#session,
          this.#run,
          step,
          this.#allMessages,
          messageMetadata,
          this.#toolMessageMetadataByCallId
        );
        await this.#messages.persistToolResults(
          this.#session,
          this.#run,
          step,
          failedToolResults,
          this.#persistedToolCalls,
          this.#allMessages,
          messageMetadata,
          this.#toolMessageMetadataByCallId
        );
        for (const toolCall of step.toolCalls) {
          this.#toolMessageMetadataByCallId.delete(toolCall.toolCallId);
        }
        for (const toolResult of step.toolResults) {
          this.#toolMessageMetadataByCallId.delete(toolResult.toolCallId);
        }
        for (const toolError of failedToolResults) {
          this.#toolMessageMetadataByCallId.delete(toolError.toolCallId);
        }
        this.#resetLiveReasoning();
      }
    };
  }

  async consumeChunk(chunk: string): Promise<AssistantMessage> {
    const currentMetadata =
      this.#modelCallMessageMetadata.get(this.#completedModelStepCount) ?? this.#latestMessageGenerationMetadata;
    const message = await this.#messages.ensureAssistantMessage(
      this.#session,
      this.#run,
      this.#assistantMessage,
      this.#allMessages,
      "",
      currentMetadata
    );
    this.#accumulatedText += chunk;
    const updatedMessage = await this.#messages.updateMessageContent(message, this.#accumulatedText);
    this.#assistantMessage = updatedMessage;
    const deltaEventMetadata = buildDeltaEventMetadata(updatedMessage.metadata, this.#latestDeltaSystemMessageSignature);
    this.#latestDeltaSystemMessageSignature = deltaEventMetadata.systemMessageSignature;
    const liveStructuredContent = this.#buildLiveStructuredContent();
    await this.#messages.appendEvent({
      sessionId: this.#session.id,
      runId: this.#run.id,
      event: "message.delta",
      data: {
        runId: this.#run.id,
        messageId: updatedMessage.id,
        ...(liveStructuredContent ? { content: liveStructuredContent } : { delta: chunk }),
        ...(deltaEventMetadata.metadata ? { metadata: deltaEventMetadata.metadata } : {})
      }
    });
    return updatedMessage;
  }

  async consumeReasoningDelta(reasoningId: string, text: string): Promise<void> {
    if (text.length === 0) {
      return;
    }

    const currentMetadata =
      this.#modelCallMessageMetadata.get(this.#completedModelStepCount) ?? this.#latestMessageGenerationMetadata;
    const message = await this.#messages.ensureAssistantMessage(
      this.#session,
      this.#run,
      this.#assistantMessage,
      this.#allMessages,
      "",
      currentMetadata
    );
    this.#assistantMessage = message;
    const previousReasoning = this.#liveReasoningById.get(reasoningId) ?? "";
    if (!this.#liveReasoningById.has(reasoningId)) {
      this.#liveReasoningOrder.push(reasoningId);
    }
    this.#liveReasoningById.set(reasoningId, `${previousReasoning}${text}`);
    const liveStructuredContent = this.#buildLiveStructuredContent();
    if (!liveStructuredContent) {
      return;
    }

    const deltaEventMetadata = buildDeltaEventMetadata(message.metadata, this.#latestDeltaSystemMessageSignature);
    this.#latestDeltaSystemMessageSignature = deltaEventMetadata.systemMessageSignature;
    await this.#messages.appendEvent({
      sessionId: this.#session.id,
      runId: this.#run.id,
      event: "message.delta",
      data: {
        runId: this.#run.id,
        messageId: message.id,
        content: liveStructuredContent,
        ...(deltaEventMetadata.metadata ? { metadata: deltaEventMetadata.metadata } : {})
      }
    });
  }

  async completePendingModelSteps(
    status: "completed" | "failed" | "cancelled",
    errorMessage?: string | undefined
  ): Promise<void> {
    for (const step of this.#modelCallSteps.values()) {
      await this.#steps.completeRunStep(step, status, errorMessage ? { errorMessage } : undefined);
    }
  }

  #syncRunStatusFromActiveTools(): Promise<void> {
    return this.#steps.setRunStatusIfPossible(
      this.#run.id,
      this.#activeToolCallIds.size > 0 ? "waiting_tool" : "running"
    );
  }

  #buildLiveStructuredContent() {
    if (this.#liveReasoningOrder.length === 0) {
      return null;
    }

    const reasoning = this.#liveReasoningOrder
      .map((reasoningId) => this.#liveReasoningById.get(reasoningId) ?? "")
      .filter((reasoningText) => reasoningText.length > 0)
      .map((reasoningText) => ({
        type: "reasoning" as const,
        text: reasoningText
      }));

    if (reasoning.length === 0) {
      return null;
    }

    const content = assistantContentFromModelOutput({
      text: this.#accumulatedText,
      reasoning
    });

    return Array.isArray(content) ? content : null;
  }

  #resetLiveReasoning() {
    this.#liveReasoningById.clear();
    this.#liveReasoningOrder.length = 0;
  }
}
