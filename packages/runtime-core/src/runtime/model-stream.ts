import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import type {
  ActionRetryPolicy,
  ModelStepResult,
  ModelStreamOptions,
  RuntimeLogger,
  RuntimeToolSet,
  WorkspaceRecord
} from "../types.js";
import type { ModelExecutionInputSnapshot, ToolErrorContentPart } from "./model-call-serialization.js";

interface RunExecutionContextLike {
  currentAgentName: string;
  injectSystemReminder: boolean;
}

type AssistantMessage = Extract<Message, { role: "assistant" }>;

export interface ModelStreamCoordinatorDependencies<TModelInput extends ModelExecutionInputSnapshot> {
  workspace: WorkspaceRecord;
  session: Session;
  run: Run;
  executionContext: RunExecutionContextLike;
  allMessages: Message[];
  initialModelInput: TModelInput;
  runtimeTools: RuntimeToolSet;
  activeToolServers: WorkspaceRecord["toolServers"][string][];
  runtimeToolNames: string[];
  logger?: RuntimeLogger | undefined;
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
  ensureAssistantMessage: (
    session: Session,
    run: Run,
    currentMessage: AssistantMessage | undefined,
    allMessages?: Message[],
    content?: string,
    metadata?: Record<string, unknown> | undefined
  ) => Promise<AssistantMessage>;
  persistAssistantToolCalls: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ) => Promise<void>;
  persistToolResults: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    failedToolResults: ToolErrorContentPart[],
    persistedToolCalls: Set<string>,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ) => Promise<void>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "message.delta" | "tool.completed";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  updateMessageContent: (message: AssistantMessage, content: string) => Promise<AssistantMessage>;
  serializeModelCallStepInput: (
    modelInput: TModelInput,
    activeToolNames: string[] | undefined,
    toolServers: WorkspaceRecord["toolServers"][string][],
    runtimeToolNames: string[],
    runtimeTools?: RuntimeToolSet | undefined
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
  recordToolCallAuditFromStep: (
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ) => Promise<void>;
  runStepRetryPolicy: (step: RunStep) => ActionRetryPolicy | undefined;
  normalizeJsonObject: (value: unknown) => Record<string, unknown>;
  resolveToolSourceType: (toolName: string) => "action" | "skill" | "agent" | "tool" | "native";
  previewValue: (value: unknown, maxLength?: number) => string;
}

export class ModelStreamCoordinator<TModelInput extends ModelExecutionInputSnapshot> {
  readonly #workspace: WorkspaceRecord;
  readonly #session: Session;
  readonly #run: Run;
  readonly #executionContext: RunExecutionContextLike;
  readonly #allMessages: Message[];
  readonly #runtimeTools: RuntimeToolSet;
  readonly #activeToolServers: WorkspaceRecord["toolServers"][string][];
  readonly #runtimeToolNames: string[];
  readonly #logger?: RuntimeLogger | undefined;
  readonly #buildModelInput: ModelStreamCoordinatorDependencies<TModelInput>["buildModelInput"];
  readonly #applyBeforeModelHooks: ModelStreamCoordinatorDependencies<TModelInput>["applyBeforeModelHooks"];
  readonly #getRun: ModelStreamCoordinatorDependencies<TModelInput>["getRun"];
  readonly #getActiveToolNames: ModelStreamCoordinatorDependencies<TModelInput>["getActiveToolNames"];
  readonly #startRunStep: ModelStreamCoordinatorDependencies<TModelInput>["startRunStep"];
  readonly #completeRunStep: ModelStreamCoordinatorDependencies<TModelInput>["completeRunStep"];
  readonly #setRunStatusIfPossible: ModelStreamCoordinatorDependencies<TModelInput>["setRunStatusIfPossible"];
  readonly #ensureAssistantMessage: ModelStreamCoordinatorDependencies<TModelInput>["ensureAssistantMessage"];
  readonly #persistAssistantToolCalls: ModelStreamCoordinatorDependencies<TModelInput>["persistAssistantToolCalls"];
  readonly #persistToolResults: ModelStreamCoordinatorDependencies<TModelInput>["persistToolResults"];
  readonly #appendEvent: ModelStreamCoordinatorDependencies<TModelInput>["appendEvent"];
  readonly #updateMessageContent: ModelStreamCoordinatorDependencies<TModelInput>["updateMessageContent"];
  readonly #serializeModelCallStepInput: ModelStreamCoordinatorDependencies<TModelInput>["serializeModelCallStepInput"];
  readonly #serializeModelCallStepOutput: ModelStreamCoordinatorDependencies<TModelInput>["serializeModelCallStepOutput"];
  readonly #extractFailedToolResults: ModelStreamCoordinatorDependencies<TModelInput>["extractFailedToolResults"];
  readonly #buildGeneratedMessageMetadata: ModelStreamCoordinatorDependencies<TModelInput>["buildGeneratedMessageMetadata"];
  readonly #recordToolCallAuditFromStep: ModelStreamCoordinatorDependencies<TModelInput>["recordToolCallAuditFromStep"];
  readonly #runStepRetryPolicy: ModelStreamCoordinatorDependencies<TModelInput>["runStepRetryPolicy"];
  readonly #normalizeJsonObject: ModelStreamCoordinatorDependencies<TModelInput>["normalizeJsonObject"];
  readonly #resolveToolSourceType: ModelStreamCoordinatorDependencies<TModelInput>["resolveToolSourceType"];
  readonly #previewValue: ModelStreamCoordinatorDependencies<TModelInput>["previewValue"];

  readonly #toolCallStartedAt = new Map<string, number>();
  readonly #toolCallSteps = new Map<string, RunStep>();
  readonly #activeToolCallIds = new Set<string>();
  readonly #modelCallSteps = new Map<number, RunStep>();
  readonly #modelCallMessageMetadata = new Map<number, Record<string, unknown>>();
  readonly #persistedToolCalls = new Set<string>();

  #assistantMessage: AssistantMessage | undefined;
  #accumulatedText = "";
  #latestHookedModelInput: TModelInput;
  #latestMessageGenerationMetadata: Record<string, unknown> | undefined;
  #finalAssistantStep: ModelStepResult | undefined;
  #completedModelStepCount = 0;

  constructor(dependencies: ModelStreamCoordinatorDependencies<TModelInput>) {
    this.#workspace = dependencies.workspace;
    this.#session = dependencies.session;
    this.#run = dependencies.run;
    this.#executionContext = dependencies.executionContext;
    this.#allMessages = dependencies.allMessages;
    this.#latestHookedModelInput = dependencies.initialModelInput;
    this.#runtimeTools = dependencies.runtimeTools;
    this.#activeToolServers = dependencies.activeToolServers;
    this.#runtimeToolNames = dependencies.runtimeToolNames;
    this.#logger = dependencies.logger;
    this.#buildModelInput = dependencies.buildModelInput;
    this.#applyBeforeModelHooks = dependencies.applyBeforeModelHooks;
    this.#getRun = dependencies.getRun;
    this.#getActiveToolNames = dependencies.getActiveToolNames;
    this.#startRunStep = dependencies.startRunStep;
    this.#completeRunStep = dependencies.completeRunStep;
    this.#setRunStatusIfPossible = dependencies.setRunStatusIfPossible;
    this.#ensureAssistantMessage = dependencies.ensureAssistantMessage;
    this.#persistAssistantToolCalls = dependencies.persistAssistantToolCalls;
    this.#persistToolResults = dependencies.persistToolResults;
    this.#appendEvent = dependencies.appendEvent;
    this.#updateMessageContent = dependencies.updateMessageContent;
    this.#serializeModelCallStepInput = dependencies.serializeModelCallStepInput;
    this.#serializeModelCallStepOutput = dependencies.serializeModelCallStepOutput;
    this.#extractFailedToolResults = dependencies.extractFailedToolResults;
    this.#buildGeneratedMessageMetadata = dependencies.buildGeneratedMessageMetadata;
    this.#recordToolCallAuditFromStep = dependencies.recordToolCallAuditFromStep;
    this.#runStepRetryPolicy = dependencies.runStepRetryPolicy;
    this.#normalizeJsonObject = dependencies.normalizeJsonObject;
    this.#resolveToolSourceType = dependencies.resolveToolSourceType;
    this.#previewValue = dependencies.previewValue;
  }

  get toolCallStartedAt(): Map<string, number> {
    return this.#toolCallStartedAt;
  }

  get toolCallSteps(): Map<string, RunStep> {
    return this.#toolCallSteps;
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

  buildStreamOptions(): Pick<ModelStreamOptions, "prepareStep" | "onToolCallStart" | "onToolCallFinish" | "onStepFinish"> {
    return {
      prepareStep: async (stepNumber) => {
        const activeToolNames = this.#getActiveToolNames(this.#executionContext.currentAgentName);
        if (stepNumber === 0) {
          const initialModelCallStep = await this.#startRunStep({
            runId: this.#run.id,
            stepType: "model_call",
            name: this.#latestHookedModelInput.model,
            agentName: this.#executionContext.currentAgentName,
            input: this.#serializeModelCallStepInput(
              this.#latestHookedModelInput,
              activeToolNames,
              this.#activeToolServers,
              this.#runtimeToolNames,
              this.#runtimeTools
            )
          });
          this.#modelCallSteps.set(stepNumber, initialModelCallStep);
          this.#latestMessageGenerationMetadata = this.#buildGeneratedMessageMetadata(
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

        const latestRun = await this.#getRun(this.#run.id);
        const nextInput = await this.#buildModelInput(
          this.#workspace,
          this.#session,
          latestRun,
          this.#allMessages,
          this.#executionContext.currentAgentName,
          this.#executionContext.injectSystemReminder
        );
        const hookedNextInput = await this.#applyBeforeModelHooks(this.#workspace, this.#session, latestRun, nextInput);
        this.#latestHookedModelInput = hookedNextInput;
        this.#executionContext.injectSystemReminder = false;
        const followupModelCallStep = await this.#startRunStep({
          runId: this.#run.id,
          stepType: "model_call",
          name: hookedNextInput.model,
          agentName: this.#executionContext.currentAgentName,
          input: this.#serializeModelCallStepInput(
            hookedNextInput,
            activeToolNames,
            this.#activeToolServers,
            this.#runtimeToolNames,
            this.#runtimeTools
          )
        });
        this.#modelCallSteps.set(stepNumber, followupModelCallStep);
        this.#latestMessageGenerationMetadata = this.#buildGeneratedMessageMetadata(
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
          inputPreview: this.#previewValue(toolCall.input)
        });
        await this.#syncRunStatusFromActiveTools();
      },
      onToolCallFinish: async (toolResult) => {
        const startedAt = this.#toolCallStartedAt.get(toolResult.toolCallId);
        this.#toolCallStartedAt.delete(toolResult.toolCallId);
        this.#activeToolCallIds.delete(toolResult.toolCallId);
        const toolStep = this.#toolCallSteps.get(toolResult.toolCallId);
        const retryPolicy = toolStep ? this.#runStepRetryPolicy(toolStep) : undefined;
        if (toolStep) {
          const completedToolStep = await this.#completeRunStep(toolStep, "completed", {
            sourceType: this.#resolveToolSourceType(toolResult.toolName),
            ...(retryPolicy ? { retryPolicy } : {}),
            output: this.#normalizeJsonObject(toolResult.output),
            ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
          });
          await this.#recordToolCallAuditFromStep(completedToolStep, toolResult.toolName, "completed");
          this.#toolCallSteps.delete(toolResult.toolCallId);
        }
        await this.#appendEvent({
          sessionId: this.#session.id,
          runId: this.#run.id,
          event: "tool.completed",
          data: {
            runId: this.#run.id,
            sessionId: this.#session.id,
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            sourceType: this.#resolveToolSourceType(toolResult.toolName),
            ...(retryPolicy ? { retryPolicy } : {}),
            output: toolResult.output,
            ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
          }
        });
        this.#logger?.debug?.("Runtime tool call finished.", {
          workspaceId: this.#workspace.id,
          sessionId: this.#session.id,
          runId: this.#run.id,
          agentName: this.#executionContext.currentAgentName,
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          outputPreview: this.#previewValue(toolResult.output),
          ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
        });
        await this.#syncRunStatusFromActiveTools();
      },
      onStepFinish: async (step) => {
        const messageMetadata =
          this.#modelCallMessageMetadata.get(this.#completedModelStepCount) ?? this.#latestMessageGenerationMetadata;
        const failedToolResults = this.#extractFailedToolResults(step);
        for (const toolError of failedToolResults) {
          this.#toolCallStartedAt.delete(toolError.toolCallId);
          this.#toolCallSteps.delete(toolError.toolCallId);
          this.#activeToolCallIds.delete(toolError.toolCallId);
        }
        await this.#syncRunStatusFromActiveTools();
        const modelCallStep = this.#modelCallSteps.get(this.#completedModelStepCount);
        if (modelCallStep) {
          await this.#completeRunStep(
            modelCallStep,
            "completed",
            this.#serializeModelCallStepOutput(step, failedToolResults)
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
        }
        await this.#persistAssistantToolCalls(this.#session, this.#run, step, this.#allMessages, messageMetadata);
        await this.#persistToolResults(
          this.#session,
          this.#run,
          step,
          failedToolResults,
          this.#persistedToolCalls,
          this.#allMessages,
          messageMetadata
        );
      }
    };
  }

  async consumeChunk(chunk: string): Promise<AssistantMessage> {
    const currentMetadata =
      this.#modelCallMessageMetadata.get(this.#completedModelStepCount) ?? this.#latestMessageGenerationMetadata;
    const message = await this.#ensureAssistantMessage(
      this.#session,
      this.#run,
      this.#assistantMessage,
      this.#allMessages,
      "",
      currentMetadata
    );
    this.#accumulatedText += chunk;
    const updatedMessage = await this.#updateMessageContent(message, this.#accumulatedText);
    this.#assistantMessage = updatedMessage;
    await this.#appendEvent({
      sessionId: this.#session.id,
      runId: this.#run.id,
      event: "message.delta",
      data: {
        runId: this.#run.id,
        messageId: updatedMessage.id,
        delta: chunk
      }
    });
    return updatedMessage;
  }

  async completePendingModelSteps(
    status: "completed" | "failed" | "cancelled",
    errorMessage?: string | undefined
  ): Promise<void> {
    for (const step of this.#modelCallSteps.values()) {
      await this.#completeRunStep(step, status, errorMessage ? { errorMessage } : undefined);
    }
  }

  #syncRunStatusFromActiveTools(): Promise<void> {
    return this.#setRunStatusIfPossible(
      this.#run.id,
      this.#activeToolCallIds.size > 0 ? "waiting_tool" : "running"
    );
  }
}
