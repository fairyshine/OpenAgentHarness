import type { ChatMessage, Message, ModelGenerateResponse, Run, RunStep, Session } from "@oah/api-contracts";

import { textContent } from "../runtime-message-content.js";
import {
  activeToolNamesForAgent as resolveActiveToolNamesForAgent,
  visibleEnabledToolServers as listVisibleEnabledToolServers,
  toolSourceType as resolveToolSourceType
} from "../runtime-tooling.js";
import type {
  ModelStepResult,
  RunStepStatus,
  RunStepType,
  RuntimeLogger,
  RuntimeServiceOptions,
  RuntimeToolSet,
  WorkspaceRecord
} from "../types.js";
import type { RuntimeMessageSyncService } from "./runtime-message-sync.js";
import type { ModelExecutionInput } from "./model-input.js";
import type { RunExecutionContext } from "./internal-helpers.js";
import { ModelStreamCoordinator } from "./model-stream.js";
import type { ToolErrorContentPart } from "./model-call-serialization.js";
import type { AgentCoordinationService } from "./agent-coordination.js";
import type { ToolExecutionService } from "./tool-execution.js";

interface ModelRunExecutorExecutionServices {
  agentCoordination: Pick<AgentCoordinationService, "delegatedRunRecords">;
  toolExecution: Pick<ToolExecutionService, "runStepRetryPolicy" | "wrapRuntimeToolsForEvents">;
}

export interface ModelRunExecutorDependencies {
  logger?: RuntimeLogger | undefined;
  modelGateway: RuntimeServiceOptions["modelGateway"];
  messageRepository: RuntimeServiceOptions["messageRepository"];
  runtimeMessageSync: RuntimeMessageSyncService;
  ensureExecutionServices: () => ModelRunExecutorExecutionServices;
  getRun: (runId: string) => Promise<Run>;
  repairSessionHistoryIfNeeded: (sessionId: string, messages: Message[]) => Promise<Message[]>;
  buildModelInput: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    runtimeMessages: Awaited<ReturnType<RuntimeMessageSyncService["loadSessionRuntimeMessages"]>>,
    activeAgentName: string,
    forceSystemReminder?: boolean
  ) => Promise<ModelExecutionInput>;
  applyBeforeModelHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: ModelExecutionInput
  ) => Promise<ModelExecutionInput>;
  applyAfterModelHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: ModelExecutionInput,
    response: ModelGenerateResponse
  ) => Promise<ModelGenerateResponse>;
  buildRuntimeTools: (
    workspace: WorkspaceRecord,
    run: Run,
    session: Session,
    executionContext: RunExecutionContext
  ) => RuntimeToolSet;
  startRunStep: (input: {
    runId: string;
    stepType: RunStepType;
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }) => Promise<RunStep>;
  completeRunStep: (
    step: RunStep,
    status: Extract<RunStepStatus, "completed" | "failed" | "cancelled">,
    output?: Record<string, unknown> | undefined
  ) => Promise<RunStep>;
  setRunStatusIfPossible: (runId: string, nextStatus: Run["status"]) => Promise<void>;
  ensureAssistantMessage: (
    session: Session,
    run: Run,
    currentMessage: Extract<Message, { role: "assistant" }> | undefined,
    allMessages?: Message[],
    content?: string,
    metadata?: Record<string, unknown> | undefined
  ) => Promise<Extract<Message, { role: "assistant" }>>;
  persistAssistantStepText: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    currentMessage: Extract<Message, { role: "assistant" }> | undefined,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ) => Promise<Extract<Message, { role: "assistant" }> | undefined>;
  persistAssistantToolCalls: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined,
    toolMetadataByCallId?: Map<
      string,
      {
        toolStatus: "completed" | "failed";
        toolSourceType: "action" | "skill" | "agent" | "tool" | "native";
        toolDurationMs?: number | undefined;
      }
    >
  ) => Promise<void>;
  persistToolResults: (
    session: Session,
    run: Run,
    step: ModelStepResult,
    failedToolResults: ToolErrorContentPart[],
    persistedToolCalls: Set<string>,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined,
    toolMetadataByCallId?: Map<
      string,
      {
        toolStatus: "completed" | "failed";
        toolSourceType: "action" | "skill" | "agent" | "tool" | "native";
        toolDurationMs?: number | undefined;
      }
    >
  ) => Promise<void>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "message.delta" | "tool.completed";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  serializeModelCallStepInput: (
    modelInput: ModelExecutionInput,
    activeToolNames: string[] | undefined,
    toolServers: WorkspaceRecord["toolServers"][string][],
    runtimeToolNames: string[],
    runtimeTools?: RuntimeToolSet | undefined
  ) => Record<string, unknown>;
  serializeModelCallStepOutput: (
    step: ModelStepResult,
    failedToolResults?: ToolErrorContentPart[]
  ) => Record<string, unknown>;
  extractFailedToolResults: (step: ModelStepResult) => ToolErrorContentPart[];
  buildGeneratedMessageMetadata: (
    workspace: WorkspaceRecord,
    agentName: string,
    modelInput: Pick<ModelExecutionInput, "messages">,
    modelCallStep?: Pick<RunStep, "id" | "seq"> | undefined
  ) => Record<string, unknown>;
  recordToolCallAuditFromStep: (
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ) => Promise<void>;
  summarizeMessageRoles: (messages: ChatMessage[]) => Record<string, number>;
  previewValue: (value: unknown, maxLength?: number) => string;
  normalizeJsonObject: (value: unknown) => Record<string, unknown>;
  finalizeSuccessfulRun: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    assistantMessage: Extract<Message, { role: "assistant" }> | undefined,
    completed: ModelGenerateResponse,
    finalAssistantStep: ModelStepResult | undefined,
    messageMetadata?: Record<string, unknown> | undefined
  ) => Promise<void>;
}

export interface ExecuteModelRunParams {
  workspace: WorkspaceRecord;
  session: Session;
  run: Run;
  abortSignal: AbortSignal;
  shouldSkipCompletion?: ((runId: string) => boolean) | undefined;
}

export class ModelRunExecutor {
  readonly #logger?: RuntimeLogger | undefined;
  readonly #modelGateway: RuntimeServiceOptions["modelGateway"];
  readonly #messageRepository: RuntimeServiceOptions["messageRepository"];
  readonly #runtimeMessageSync: RuntimeMessageSyncService;
  readonly #ensureExecutionServices: ModelRunExecutorDependencies["ensureExecutionServices"];
  readonly #getRun: ModelRunExecutorDependencies["getRun"];
  readonly #repairSessionHistoryIfNeeded: ModelRunExecutorDependencies["repairSessionHistoryIfNeeded"];
  readonly #buildModelInput: ModelRunExecutorDependencies["buildModelInput"];
  readonly #applyBeforeModelHooks: ModelRunExecutorDependencies["applyBeforeModelHooks"];
  readonly #applyAfterModelHooks: ModelRunExecutorDependencies["applyAfterModelHooks"];
  readonly #buildRuntimeTools: ModelRunExecutorDependencies["buildRuntimeTools"];
  readonly #startRunStep: ModelRunExecutorDependencies["startRunStep"];
  readonly #completeRunStep: ModelRunExecutorDependencies["completeRunStep"];
  readonly #setRunStatusIfPossible: ModelRunExecutorDependencies["setRunStatusIfPossible"];
  readonly #ensureAssistantMessage: ModelRunExecutorDependencies["ensureAssistantMessage"];
  readonly #persistAssistantStepText: ModelRunExecutorDependencies["persistAssistantStepText"];
  readonly #persistAssistantToolCalls: ModelRunExecutorDependencies["persistAssistantToolCalls"];
  readonly #persistToolResults: ModelRunExecutorDependencies["persistToolResults"];
  readonly #appendEvent: ModelRunExecutorDependencies["appendEvent"];
  readonly #serializeModelCallStepInput: ModelRunExecutorDependencies["serializeModelCallStepInput"];
  readonly #serializeModelCallStepOutput: ModelRunExecutorDependencies["serializeModelCallStepOutput"];
  readonly #extractFailedToolResults: ModelRunExecutorDependencies["extractFailedToolResults"];
  readonly #buildGeneratedMessageMetadata: ModelRunExecutorDependencies["buildGeneratedMessageMetadata"];
  readonly #recordToolCallAuditFromStep: ModelRunExecutorDependencies["recordToolCallAuditFromStep"];
  readonly #summarizeMessageRoles: ModelRunExecutorDependencies["summarizeMessageRoles"];
  readonly #previewValue: ModelRunExecutorDependencies["previewValue"];
  readonly #normalizeJsonObject: ModelRunExecutorDependencies["normalizeJsonObject"];
  readonly #finalizeSuccessfulRun: ModelRunExecutorDependencies["finalizeSuccessfulRun"];

  constructor(dependencies: ModelRunExecutorDependencies) {
    this.#logger = dependencies.logger;
    this.#modelGateway = dependencies.modelGateway;
    this.#messageRepository = dependencies.messageRepository;
    this.#runtimeMessageSync = dependencies.runtimeMessageSync;
    this.#ensureExecutionServices = dependencies.ensureExecutionServices;
    this.#getRun = dependencies.getRun;
    this.#repairSessionHistoryIfNeeded = dependencies.repairSessionHistoryIfNeeded;
    this.#buildModelInput = dependencies.buildModelInput;
    this.#applyBeforeModelHooks = dependencies.applyBeforeModelHooks;
    this.#applyAfterModelHooks = dependencies.applyAfterModelHooks;
    this.#buildRuntimeTools = dependencies.buildRuntimeTools;
    this.#startRunStep = dependencies.startRunStep;
    this.#completeRunStep = dependencies.completeRunStep;
    this.#setRunStatusIfPossible = dependencies.setRunStatusIfPossible;
    this.#ensureAssistantMessage = dependencies.ensureAssistantMessage;
    this.#persistAssistantStepText = dependencies.persistAssistantStepText;
    this.#persistAssistantToolCalls = dependencies.persistAssistantToolCalls;
    this.#persistToolResults = dependencies.persistToolResults;
    this.#appendEvent = dependencies.appendEvent;
    this.#serializeModelCallStepInput = dependencies.serializeModelCallStepInput;
    this.#serializeModelCallStepOutput = dependencies.serializeModelCallStepOutput;
    this.#extractFailedToolResults = dependencies.extractFailedToolResults;
    this.#buildGeneratedMessageMetadata = dependencies.buildGeneratedMessageMetadata;
    this.#recordToolCallAuditFromStep = dependencies.recordToolCallAuditFromStep;
    this.#summarizeMessageRoles = dependencies.summarizeMessageRoles;
    this.#previewValue = dependencies.previewValue;
    this.#normalizeJsonObject = dependencies.normalizeJsonObject;
    this.#finalizeSuccessfulRun = dependencies.finalizeSuccessfulRun;
  }

  async executeRun({
    workspace,
    session,
    run,
    abortSignal,
    shouldSkipCompletion
  }: ExecuteModelRunParams): Promise<void> {
    const execution = this.#ensureExecutionServices();
    const allMessages = await this.#repairSessionHistoryIfNeeded(
      session.id,
      await this.#messageRepository.listBySessionId(session.id)
    );
    const executionContext: RunExecutionContext = {
      currentAgentName: run.effectiveAgentName,
      injectSystemReminder: false,
      delegatedRunIds: execution.agentCoordination.delegatedRunRecords(run).map((record) => record.childRunId)
    };
    const runtimeMessages = await this.#runtimeMessageSync.loadSessionRuntimeMessages(session.id, allMessages);
    const modelInput = await this.#buildModelInput(
      workspace,
      session,
      run,
      runtimeMessages,
      executionContext.currentAgentName
    );
    const hookedModelInput = await this.#applyBeforeModelHooks(workspace, session, run, modelInput);
    const runtimeTools = this.#buildRuntimeTools(workspace, run, session, executionContext);
    const activeToolServers = listVisibleEnabledToolServers(workspace, executionContext.currentAgentName);
    const runtimeToolNames = Object.keys(runtimeTools);
    let streamCoordinator: ModelStreamCoordinator<ModelExecutionInput> | undefined;

    try {
      streamCoordinator = new ModelStreamCoordinator({
        workspace,
        session,
        run,
        executionContext,
        allMessages,
        initialModelInput: hookedModelInput,
        runtimeTools,
        activeToolServers,
        runtimeToolNames,
        logger: this.#logger,
        buildModelInput: async (
          targetWorkspace,
          targetSession,
          targetRun,
          targetMessages,
          activeAgentName,
          injectSystemReminder
        ) =>
          this.#buildModelInput(
            targetWorkspace,
            targetSession,
            targetRun,
            await this.#runtimeMessageSync.buildRuntimeMessagesForSession(targetSession.id, targetMessages),
            activeAgentName,
            injectSystemReminder
          ),
        applyBeforeModelHooks: (targetWorkspace, targetSession, targetRun, nextModelInput) =>
          this.#applyBeforeModelHooks(targetWorkspace, targetSession, targetRun, nextModelInput),
        getRun: (targetRunId) => this.#getRun(targetRunId),
        getActiveToolNames: (agentName) => resolveActiveToolNamesForAgent(workspace, agentName),
        startRunStep: (input) => this.#startRunStep(input),
        completeRunStep: (step, status, output) => this.#completeRunStep(step, status, output),
        setRunStatusIfPossible: (targetRunId, nextStatus) => this.#setRunStatusIfPossible(targetRunId, nextStatus),
        ensureAssistantMessage: (targetSession, targetRun, currentMessage, targetMessages, content, metadata) =>
          this.#ensureAssistantMessage(targetSession, targetRun, currentMessage, targetMessages, content, metadata),
        persistAssistantStepText: (targetSession, targetRun, step, currentMessage, targetMessages, metadata) =>
          this.#persistAssistantStepText(targetSession, targetRun, step, currentMessage, targetMessages, metadata),
        persistAssistantToolCalls: (targetSession, targetRun, step, targetMessages, metadata, toolMetadataByCallId) =>
          this.#persistAssistantToolCalls(targetSession, targetRun, step, targetMessages, metadata, toolMetadataByCallId),
        persistToolResults: (
          targetSession,
          targetRun,
          step,
          failedToolResults,
          persistedToolCalls,
          targetMessages,
          metadata,
          toolMetadataByCallId
        ) =>
          this.#persistToolResults(
            targetSession,
            targetRun,
            step,
            failedToolResults,
            persistedToolCalls,
            targetMessages,
            metadata,
            toolMetadataByCallId
          ),
        appendEvent: (input) => this.#appendEvent(input),
        updateMessageContent: (message, content) =>
          this.#messageRepository.update({
            ...message,
            content: textContent(content)
          }) as Promise<Extract<Message, { role: "assistant" }>>,
        serializeModelCallStepInput: (modelExecutionInput, activeToolNames, toolServers, currentRuntimeToolNames, currentRuntimeTools) =>
          this.#serializeModelCallStepInput(
            modelExecutionInput,
            activeToolNames,
            toolServers,
            currentRuntimeToolNames,
            currentRuntimeTools
          ),
        serializeModelCallStepOutput: (step, failedToolResults) =>
          this.#serializeModelCallStepOutput(step, failedToolResults),
        extractFailedToolResults: (step) => this.#extractFailedToolResults(step),
        buildGeneratedMessageMetadata: (targetWorkspace, agentName, currentModelInput, modelCallStep) =>
          this.#buildGeneratedMessageMetadata(targetWorkspace, agentName, currentModelInput, modelCallStep),
        recordToolCallAuditFromStep: (step, toolName, status) =>
          this.#recordToolCallAuditFromStep(step, toolName, status),
        runStepRetryPolicy: (step) => execution.toolExecution.runStepRetryPolicy(step),
        normalizeJsonObject: (value) => this.#normalizeJsonObject(value),
        resolveToolSourceType,
        previewValue: (value, maxLength) => this.#previewValue(value, maxLength)
      });

      const observableRuntimeTools = execution.toolExecution.wrapRuntimeToolsForEvents({
        workspace,
        session,
        run,
        runtimeTools,
        executionContext,
        toolCallStartedAt: streamCoordinator.toolCallStartedAt,
        toolCallSteps: streamCoordinator.toolCallSteps,
        toolMessageMetadataByCallId: streamCoordinator.toolMessageMetadataByCallId
      });
      this.#logger?.debug?.("Runtime run starting model stream.", {
        workspaceId: workspace.id,
        sessionId: session.id,
        runId: run.id,
        triggerType: run.triggerType,
        agentName: executionContext.currentAgentName,
        model: hookedModelInput.model,
        provider: hookedModelInput.provider,
        canonicalModelRef: hookedModelInput.canonicalModelRef,
        messageCount: hookedModelInput.messages.length,
        messageRoles: this.#summarizeMessageRoles(hookedModelInput.messages),
        runtimeToolNames,
        toolServerNames: activeToolServers.map((server) => server.name)
      });
      const response = await this.#modelGateway.stream(
        {
          model: hookedModelInput.model,
          ...(hookedModelInput.modelDefinition ? { modelDefinition: hookedModelInput.modelDefinition } : {}),
          messages: hookedModelInput.messages,
          ...(hookedModelInput.temperature !== undefined ? { temperature: hookedModelInput.temperature } : {}),
          ...(hookedModelInput.topP !== undefined ? { topP: hookedModelInput.topP } : {}),
          ...(hookedModelInput.maxTokens !== undefined ? { maxTokens: hookedModelInput.maxTokens } : {})
        },
        {
          signal: abortSignal,
          ...(Object.keys(observableRuntimeTools).length > 0 ? { tools: observableRuntimeTools } : {}),
          ...(activeToolServers.length > 0 ? { toolServers: activeToolServers } : {}),
          maxSteps: workspace.agents[executionContext.currentAgentName]?.policy?.maxSteps ?? 8,
          parallelToolCalls: workspace.agents[executionContext.currentAgentName]?.policy?.parallelToolCalls,
          ...streamCoordinator.buildStreamOptions()
        }
      );

      for await (const chunk of response.chunks) {
        await streamCoordinator.consumeChunk(chunk);
      }

      const completed = await response.completed;
      if (shouldSkipCompletion?.(run.id)) {
        return;
      }

      const latestRun = await this.#getRun(run.id);
      const hookedCompleted = await this.#applyAfterModelHooks(
        workspace,
        session,
        latestRun,
        streamCoordinator.latestHookedModelInput,
        completed
      );
      await this.#finalizeSuccessfulRun(
        workspace,
        session,
        latestRun,
        streamCoordinator.assistantMessage,
        hookedCompleted,
        streamCoordinator.finalAssistantStep,
        streamCoordinator.latestMessageGenerationMetadata
      );
    } catch (error) {
      const pendingModelStepStatus = abortSignal.aborted ? "cancelled" : "failed";
      if (streamCoordinator) {
        await streamCoordinator.completePendingModelSteps(
          pendingModelStepStatus,
          error instanceof Error ? error.message : "Unknown model execution error."
        );
      }

      throw error;
    }
  }
}
