import type { ChatMessage, Message, Run, RunStep, Session } from "@oah/api-contracts";

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
  pendingModelContextMessages?: ChatMessage[] | undefined;
}

type ToolMessageMetadata = {
  toolStatus: "started" | "completed" | "failed";
  toolSourceType: "action" | "skill" | "agent" | "tool" | "native";
  toolDurationMs?: number | undefined;
};

type AssistantMessage = Extract<Message, { role: "assistant" }>;

const STRUCTURED_DELTA_MIN_SIZE_CHANGE = 2048;
const STRUCTURED_DELTA_MAX_QUIET_MS = 3000;

type LiveToolInputState = {
  toolCallId: string;
  toolName: string;
  inputText: string;
  input?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSerializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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

function parsePartialToolInput(inputText: string): unknown {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return {
      __streamingInput: ""
    };
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {
      __streamingInput: inputText
    };
  }
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

function drainPendingModelContextMessages(executionContext: RunExecutionContextLike): ChatMessage[] {
  const pending = executionContext.pendingModelContextMessages;
  if (!Array.isArray(pending) || pending.length === 0) {
    return [];
  }

  return pending.splice(0, pending.length);
}

function errorCodeFromUnknown(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "tool_execution_failed";
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return "Unknown tool execution error.";
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
    event: "message.delta" | "tool.started" | "tool.completed" | "tool.failed";
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
  readonly #liveToolInputsById = new Map<string, LiveToolInputState>();
  readonly #liveToolInputOrder: string[] = [];

  #assistantMessage: AssistantMessage | undefined;
  #accumulatedText = "";
  #latestHookedModelInput: TModelInput;
  #latestMessageGenerationMetadata: Record<string, unknown> | undefined;
  #latestDeltaSystemMessageSignature: string | undefined;
  #lastStructuredDeltaEmittedAt = 0;
  #lastStructuredDeltaSize = 0;
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

  get pendingModelStepCount(): number {
    return this.#modelCallSteps.size;
  }

  buildStreamOptions(): Pick<ModelStreamOptions, "prepareStep" | "onToolCallStart" | "onToolCallFinish" | "onStepFinish" | "onChunk"> {
    return {
      prepareStep: async (stepNumber, context) => {
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
        const shouldUseRebuiltMessages = this.#executionContext.injectSystemReminder;
        const rebuiltInput = await this.#planning.buildModelInput(
          this.#workspace,
          this.#session,
          latestRun,
          this.#allMessages,
          this.#executionContext.currentAgentName,
          this.#executionContext.injectSystemReminder
        );
        const nextInput =
          !shouldUseRebuiltMessages && context?.messages && context.messages.length > 0
            ? {
                ...rebuiltInput,
                messages: context.messages
              }
            : rebuiltInput;
        const pendingModelContextMessages = drainPendingModelContextMessages(this.#executionContext);
        const nextInputWithInjectedContext =
          pendingModelContextMessages.length > 0
            ? {
                ...nextInput,
                messages: [...nextInput.messages, ...pendingModelContextMessages]
              }
            : nextInput;
        const hookedNextInput = await this.#planning.applyBeforeModelHooks(
          this.#workspace,
          this.#session,
          latestRun,
          nextInputWithInjectedContext
        );
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
          injectedContextMessages: pendingModelContextMessages.length,
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
        const toolSourceType = this.#serialization.resolveToolSourceType(toolCall.toolName);
        if (!this.#engineTools[toolCall.toolName]) {
          this.#toolCallSteps.set(
            toolCall.toolCallId,
            await this.#steps.startRunStep({
              runId: this.#run.id,
              stepType: "tool_call",
              name: toolCall.toolName,
              agentName: this.#executionContext.currentAgentName,
              input: {
                toolCallId: toolCall.toolCallId,
                sourceType: toolSourceType,
                input: this.#serialization.normalizeJsonObject(toolCall.input)
              }
            })
          );
          this.#toolMessageMetadataByCallId.set(toolCall.toolCallId, {
            toolStatus: "started",
            toolSourceType
          });
          await this.#messages.appendEvent({
            sessionId: this.#session.id,
            runId: this.#run.id,
            event: "tool.started",
            data: {
              runId: this.#run.id,
              sessionId: this.#session.id,
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              sourceType: toolSourceType,
              input: toolCall.input,
              metadata: buildAgentEventMetadata(this.#workspace, this.#executionContext.currentAgentName)
            }
          });
        }
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
          return;
        }

        if (chunk.type === "tool-input-start") {
          await this.consumeToolInputStart(chunk.toolCallId, chunk.toolName);
          return;
        }

        if (chunk.type === "tool-input-delta") {
          await this.consumeToolInputDelta(chunk.toolCallId, chunk.inputTextDelta);
          return;
        }

        if (chunk.type === "tool-input-available") {
          await this.consumeToolInputAvailable(chunk.toolCallId, chunk.toolName, chunk.input);
        }
      },
      onStepFinish: async (step) => {
        const messageMetadata =
          this.#modelCallMessageMetadata.get(this.#completedModelStepCount) ?? this.#latestMessageGenerationMetadata;
        const failedToolResults = this.#serialization.extractFailedToolResults(step);
        for (const toolError of failedToolResults) {
          const startedAt = this.#toolCallStartedAt.get(toolError.toolCallId);
          const toolStep = this.#toolCallSteps.get(toolError.toolCallId);
          const toolSourceType = this.#serialization.resolveToolSourceType(toolError.toolName);
          this.#toolMessageMetadataByCallId.set(toolError.toolCallId, {
            toolStatus: "failed",
            toolSourceType,
            ...(startedAt !== undefined ? { toolDurationMs: Date.now() - startedAt } : {})
          });
          this.#toolCallStartedAt.delete(toolError.toolCallId);
          this.#toolCallSteps.delete(toolError.toolCallId);
          this.#activeToolCallIds.delete(toolError.toolCallId);
          if (toolStep) {
            const failedToolStep = await this.#steps.completeRunStep(toolStep, "failed", {
              sourceType: toolSourceType,
              errorCode: errorCodeFromUnknown(toolError.error),
              errorMessage: errorMessageFromUnknown(toolError.error),
              ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
            });
            await this.#steps.recordToolCallAuditFromStep(failedToolStep, toolError.toolName, "failed");
          }
          await this.#messages.appendEvent({
            sessionId: this.#session.id,
            runId: this.#run.id,
            event: "tool.failed",
            data: {
              runId: this.#run.id,
              sessionId: this.#session.id,
              toolCallId: toolError.toolCallId,
              toolName: toolError.toolName,
              sourceType: toolSourceType,
              errorCode: errorCodeFromUnknown(toolError.error),
              errorMessage: errorMessageFromUnknown(toolError.error),
              ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
              metadata: buildAgentEventMetadata(this.#workspace, toolStep?.agentName ?? this.#executionContext.currentAgentName)
            }
          });
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
        this.#resetLiveToolInputs();
        this.#resetStructuredDeltaThrottle();
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
    await this.#emitLiveStructuredContent(message);
  }

  async consumeToolInputStart(toolCallId: string, toolName: string): Promise<void> {
    if (!toolCallId || !toolName) {
      return;
    }

    const existing = this.#liveToolInputsById.get(toolCallId);
    if (!existing) {
      this.#liveToolInputOrder.push(toolCallId);
    }
    this.#liveToolInputsById.set(toolCallId, {
      toolCallId,
      toolName,
      inputText: existing?.inputText ?? "",
      ...(existing?.input !== undefined ? { input: existing.input } : {})
    });
    await this.#emitLiveStructuredContent(undefined, { force: true });
  }

  async consumeToolInputDelta(toolCallId: string, inputTextDelta: string): Promise<void> {
    if (!toolCallId || inputTextDelta.length === 0) {
      return;
    }

    const existing = this.#liveToolInputsById.get(toolCallId);
    if (!existing) {
      return;
    }

    this.#liveToolInputsById.set(toolCallId, {
      ...existing,
      inputText: `${existing.inputText}${inputTextDelta}`
    });
    await this.#emitLiveStructuredContent();
  }

  async consumeToolInputAvailable(toolCallId: string, toolName: string, input: unknown): Promise<void> {
    if (!toolCallId || !toolName) {
      return;
    }

    const existing = this.#liveToolInputsById.get(toolCallId);
    if (!existing) {
      this.#liveToolInputOrder.push(toolCallId);
    }
    this.#liveToolInputsById.set(toolCallId, {
      toolCallId,
      toolName,
      inputText: existing?.inputText ?? "",
      input
    });
    await this.#emitLiveStructuredContent(undefined, { force: true });
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
    if (this.#liveReasoningOrder.length === 0 && this.#liveToolInputOrder.length === 0) {
      return null;
    }

    const reasoning = this.#liveReasoningOrder
      .map((reasoningId) => this.#liveReasoningById.get(reasoningId) ?? "")
      .filter((reasoningText) => reasoningText.length > 0)
      .map((reasoningText) => ({
        type: "reasoning" as const,
        text: reasoningText
      }));

    const toolCalls = this.#liveToolInputOrder
      .map((toolCallId) => this.#liveToolInputsById.get(toolCallId))
      .filter((toolInput): toolInput is LiveToolInputState => Boolean(toolInput))
      .map((toolInput) => ({
        type: "tool-call" as const,
        toolCallId: toolInput.toolCallId,
        toolName: toolInput.toolName,
        input: toolInput.input ?? parsePartialToolInput(toolInput.inputText)
      }));

    if (reasoning.length === 0 && toolCalls.length === 0) {
      return null;
    }

    const content = assistantContentFromModelOutput({
      text: this.#accumulatedText,
      reasoning,
      content: toolCalls
    });

    return Array.isArray(content) ? content : null;
  }

  async #emitLiveStructuredContent(
    existingMessage?: AssistantMessage | undefined,
    options: { force?: boolean | undefined } = {}
  ): Promise<void> {
    const liveStructuredContent = this.#buildLiveStructuredContent();
    if (!liveStructuredContent) {
      return;
    }

    const serializedSize = safeSerializedLength(liveStructuredContent);
    const now = Date.now();
    const sizeChangedEnough =
      Math.abs(serializedSize - this.#lastStructuredDeltaSize) >= STRUCTURED_DELTA_MIN_SIZE_CHANGE;
    const quietLongEnough = now - this.#lastStructuredDeltaEmittedAt >= STRUCTURED_DELTA_MAX_QUIET_MS;
    if (
      !options.force &&
      this.#lastStructuredDeltaEmittedAt > 0 &&
      !sizeChangedEnough &&
      !quietLongEnough
    ) {
      return;
    }

    const currentMetadata =
      this.#modelCallMessageMetadata.get(this.#completedModelStepCount) ?? this.#latestMessageGenerationMetadata;
    const message =
      existingMessage ??
      (await this.#messages.ensureAssistantMessage(
        this.#session,
        this.#run,
        this.#assistantMessage,
        this.#allMessages,
        "",
        currentMetadata
      ));
    this.#assistantMessage = message;
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
    this.#lastStructuredDeltaEmittedAt = now;
    this.#lastStructuredDeltaSize = serializedSize;
  }

  #resetStructuredDeltaThrottle() {
    this.#lastStructuredDeltaEmittedAt = 0;
    this.#lastStructuredDeltaSize = 0;
  }

  #resetLiveReasoning() {
    this.#liveReasoningById.clear();
    this.#liveReasoningOrder.length = 0;
  }

  #resetLiveToolInputs() {
    this.#liveToolInputsById.clear();
    this.#liveToolInputOrder.length = 0;
  }
}
