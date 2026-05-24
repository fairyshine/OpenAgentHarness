import type { ChatMessage, Message, ModelGenerateResponse, Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import { textContent } from "../execution-message-content.js";
import {
  modelActiveToolNamesForAgent as resolveActiveToolNamesForAgent,
  visibleEnabledToolServers as listVisibleEnabledToolServers,
  toolSourceType as resolveToolSourceType
} from "../capabilities/engine-capabilities.js";
import type {
  ModelStepResult,
  RunStepStatus,
  RunStepType,
  EngineLogger,
  EngineServiceOptions,
  EngineToolSet,
  WorkspaceRecord
} from "../types.js";
import type { EngineMessageSyncService } from "./engine-message-sync.js";
import type { ModelExecutionInput } from "./model-input.js";
import type { RunExecutionContext } from "./internal-helpers.js";
import { ModelStreamCoordinator } from "./model-stream.js";
import type { ToolErrorContentPart } from "./model-call-serialization.js";
import type { AgentCoordinationService } from "./agent-coordination.js";
import type { ToolExecutionService } from "./tool-execution.js";

const DEFAULT_MODEL_STREAM_TIMEOUT_MS = 120_000;

function readPositiveNumberEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveModelStreamTimeoutMs(runTimeoutMs: number | undefined): number {
  const configured = readPositiveNumberEnv("OAH_MODEL_STREAM_TIMEOUT_MS");
  if (configured !== undefined) {
    return configured;
  }

  return runTimeoutMs !== undefined ? runTimeoutMs : DEFAULT_MODEL_STREAM_TIMEOUT_MS;
}

function isDelegatedTerminalUpdateMessage(message: Message): boolean {
  const metadata = message.metadata as
    | { delegatedUpdate?: unknown; taskNotificationPendingModelDelivery?: unknown; eligibleForModelContext?: unknown }
    | undefined;
  return (
    (message.role === "tool" || message.role === "user") &&
    (metadata?.delegatedUpdate === "completed" || metadata?.delegatedUpdate === "failed") &&
    metadata?.taskNotificationPendingModelDelivery !== true &&
    metadata?.eligibleForModelContext !== false
  );
}

interface ModelRunExecutorExecutionServices {
  agentCoordination: Pick<
    AgentCoordinationService,
    "delegatedRunRecords" | "persistUnreportedTerminalDelegatedRuns" | "drainPendingTaskNotifications"
  >;
  toolExecution: Pick<ToolExecutionService, "runStepRetryPolicy" | "wrapEngineToolsForEvents">;
}

export interface ModelRunExecutorDependencies {
  logger?: EngineLogger | undefined;
  modelGateway: EngineServiceOptions["modelGateway"];
  messageRepository: EngineServiceOptions["messageRepository"];
  engineMessageSync: EngineMessageSyncService;
  ensureExecutionServices: () => ModelRunExecutorExecutionServices;
  getRun: (runId: string) => Promise<Run>;
  repairSessionHistoryIfNeeded: (sessionId: string, messages: Message[]) => Promise<Message[]>;
  prepareMessagesForModelInput: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string,
    allMessages: Message[],
    options?: { abortSignal?: AbortSignal | undefined; modelTimeoutMs?: number | undefined } | undefined
  ) => Promise<Awaited<ReturnType<EngineMessageSyncService["loadSessionEngineMessages"]>>>;
  buildModelInput: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    engineMessages: Awaited<ReturnType<EngineMessageSyncService["loadSessionEngineMessages"]>>,
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
  buildEngineTools: (
    workspace: WorkspaceRecord,
    run: Run,
    session: Session,
    executionContext: RunExecutionContext
  ) => EngineToolSet;
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
        toolStatus: "started" | "completed" | "failed";
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
        toolStatus: "started" | "completed" | "failed";
        toolSourceType: "action" | "skill" | "agent" | "tool" | "native";
        toolDurationMs?: number | undefined;
      }
    >
  ) => Promise<void>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "message.delta" | "tool.started" | "tool.completed" | "tool.failed";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  serializeModelCallStepInput: (
    modelInput: ModelExecutionInput,
    activeToolNames: string[] | undefined,
    toolServers: WorkspaceRecord["toolServers"][string][],
    engineToolNames: string[],
    engineTools?: EngineToolSet | undefined
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
  runTimeoutMs?: number | undefined;
  shouldSkipCompletion?: ((runId: string) => boolean) | undefined;
  resolveAbortStepStatus?: (() => "failed" | "cancelled") | undefined;
}

export class ModelRunExecutor {
  readonly #logger?: EngineLogger | undefined;
  readonly #modelGateway: EngineServiceOptions["modelGateway"];
  readonly #messageRepository: EngineServiceOptions["messageRepository"];
  readonly #ensureExecutionServices: ModelRunExecutorDependencies["ensureExecutionServices"];
  readonly #getRun: ModelRunExecutorDependencies["getRun"];
  readonly #repairSessionHistoryIfNeeded: ModelRunExecutorDependencies["repairSessionHistoryIfNeeded"];
  readonly #prepareMessagesForModelInput: ModelRunExecutorDependencies["prepareMessagesForModelInput"];
  readonly #buildModelInput: ModelRunExecutorDependencies["buildModelInput"];
  readonly #applyBeforeModelHooks: ModelRunExecutorDependencies["applyBeforeModelHooks"];
  readonly #applyAfterModelHooks: ModelRunExecutorDependencies["applyAfterModelHooks"];
  readonly #buildEngineTools: ModelRunExecutorDependencies["buildEngineTools"];
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
    this.#ensureExecutionServices = dependencies.ensureExecutionServices;
    this.#getRun = dependencies.getRun;
    this.#repairSessionHistoryIfNeeded = dependencies.repairSessionHistoryIfNeeded;
    this.#prepareMessagesForModelInput = dependencies.prepareMessagesForModelInput;
    this.#buildModelInput = dependencies.buildModelInput;
    this.#applyBeforeModelHooks = dependencies.applyBeforeModelHooks;
    this.#applyAfterModelHooks = dependencies.applyAfterModelHooks;
    this.#buildEngineTools = dependencies.buildEngineTools;
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
    runTimeoutMs,
    shouldSkipCompletion,
    resolveAbortStepStatus
  }: ExecuteModelRunParams): Promise<void> {
    const execution = this.#ensureExecutionServices();
    const allMessages = await this.#repairSessionHistoryIfNeeded(
      session.id,
      await this.#messageRepository.listBySessionId(session.id)
    );
    const executionContext: RunExecutionContext = {
      currentAgentName: run.effectiveAgentName,
      injectSystemReminder: false,
      delegatedRunIds: execution.agentCoordination.delegatedRunRecords(run).map((record) => record.childRunId),
      pendingModelContextMessages: []
    };
    const modelStreamTimeoutMs = resolveModelStreamTimeoutMs(runTimeoutMs);
    const buildInitialHookedModelInput = async () => {
      const latestRun = await this.#getRun(run.id);
      const engineMessages = await this.#prepareMessagesForModelInput(
        workspace,
        session,
        latestRun,
        executionContext.currentAgentName,
        allMessages,
        {
          abortSignal,
          modelTimeoutMs: modelStreamTimeoutMs
        }
      );
      const modelInput = await this.#buildModelInput(
        workspace,
        session,
        latestRun,
        engineMessages,
        executionContext.currentAgentName
      );
      return this.#applyBeforeModelHooks(workspace, session, latestRun, modelInput);
    };
    const drainPendingTaskNotificationsIntoHistory = async (targetRunId: string) => {
      const drainedNotifications = await execution.agentCoordination.drainPendingTaskNotifications({
        parentSessionId: session.id,
        runId: targetRunId,
        parentAgentName: executionContext.currentAgentName
      });
      if (drainedNotifications.messageIds.length === 0) {
        return drainedNotifications;
      }

      const latestMessages = await this.#repairSessionHistoryIfNeeded(
        session.id,
        await this.#messageRepository.listBySessionId(session.id)
      );
      allMessages.length = 0;
      allMessages.push(...latestMessages);
      return drainedNotifications;
    };
    await drainPendingTaskNotificationsIntoHistory(run.id);
    let hookedModelInput = await buildInitialHookedModelInput();
    const engineTools = this.#buildEngineTools(workspace, run, session, executionContext);
    const activeToolServers = listVisibleEnabledToolServers(workspace, executionContext.currentAgentName);
    const engineToolNames = Object.keys(engineTools);
    let streamCoordinator: ModelStreamCoordinator<ModelExecutionInput> | undefined;

    try {
      let continuationCount = 0;
      while (true) {
        streamCoordinator = new ModelStreamCoordinator({
          workspace,
          session,
          run,
          executionContext,
          allMessages,
          initialModelInput: hookedModelInput,
          engineTools,
          activeToolServers,
          engineToolNames,
          logger: this.#logger,
          planning: {
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
                await this.#prepareMessagesForModelInput(
                  targetWorkspace,
                  targetSession,
                  targetRun,
                  activeAgentName,
                  targetMessages,
                  {
                    abortSignal,
                    modelTimeoutMs: modelStreamTimeoutMs
                  }
                ),
                activeAgentName,
                injectSystemReminder
              ),
            applyBeforeModelHooks: (targetWorkspace, targetSession, targetRun, nextModelInput) =>
              this.#applyBeforeModelHooks(targetWorkspace, targetSession, targetRun, nextModelInput),
            getRun: (targetRunId) => this.#getRun(targetRunId),
            getActiveToolNames: (agentName) => resolveActiveToolNamesForAgent(workspace, agentName)
          },
          steps: {
            startRunStep: (input) => this.#startRunStep(input),
            completeRunStep: (step, status, output) => this.#completeRunStep(step, status, output),
            setRunStatusIfPossible: (targetRunId, nextStatus) => this.#setRunStatusIfPossible(targetRunId, nextStatus),
            recordToolCallAuditFromStep: (step, toolName, status) =>
              this.#recordToolCallAuditFromStep(step, toolName, status),
            runStepRetryPolicy: (step) => execution.toolExecution.runStepRetryPolicy(step)
          },
          messages: {
            ensureAssistantMessage: (targetSession, targetRun, currentMessage, targetMessages, content, metadata) =>
              this.#ensureAssistantMessage(targetSession, targetRun, currentMessage, targetMessages, content, metadata),
            persistAssistantStepText: (targetSession, targetRun, step, currentMessage, targetMessages, metadata) =>
              this.#persistAssistantStepText(targetSession, targetRun, step, currentMessage, targetMessages, metadata),
            persistAssistantToolCalls: (targetSession, targetRun, step, targetMessages, metadata, toolMetadataByCallId) =>
              this.#persistAssistantToolCalls(
                targetSession,
                targetRun,
                step,
                targetMessages,
                metadata,
                toolMetadataByCallId
              ),
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
              }) as Promise<Extract<Message, { role: "assistant" }>>
          },
          serialization: {
            serializeModelCallStepInput: (
              modelExecutionInput,
              activeToolNames,
              toolServers,
              currentEngineToolNames,
              currentEngineTools
            ) =>
              this.#serializeModelCallStepInput(
                modelExecutionInput,
                activeToolNames,
                toolServers,
                currentEngineToolNames,
                currentEngineTools
              ),
            serializeModelCallStepOutput: (step, failedToolResults) =>
              this.#serializeModelCallStepOutput(step, failedToolResults),
            extractFailedToolResults: (step) => this.#extractFailedToolResults(step),
            buildGeneratedMessageMetadata: (targetWorkspace, agentName, currentModelInput, modelCallStep) =>
              this.#buildGeneratedMessageMetadata(targetWorkspace, agentName, currentModelInput, modelCallStep),
            normalizeJsonObject: (value) => this.#normalizeJsonObject(value),
            resolveToolSourceType,
            previewValue: (value, maxLength) => this.#previewValue(value, maxLength)
          }
        });

      const observableEngineTools = execution.toolExecution.wrapEngineToolsForEvents({
        workspace,
        session,
        run,
        engineTools,
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
        engineToolNames,
        toolServerNames: activeToolServers.map((server) => server.name)
      });
      const agentPolicy = workspace.agents[executionContext.currentAgentName]?.policy;
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
          timeoutMs: modelStreamTimeoutMs,
          ...(Object.keys(observableEngineTools).length > 0 ? { tools: observableEngineTools } : {}),
          ...(activeToolServers.length > 0 ? { toolServers: activeToolServers } : {}),
          ...(agentPolicy?.maxSteps !== undefined ? { maxSteps: agentPolicy.maxSteps } : {}),
          parallelToolCalls: agentPolicy?.parallelToolCalls,
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
      if (streamCoordinator.pendingModelStepCount > 0) {
        throw new AppError(
          502,
          "model_stream_incomplete",
          `Model stream completed while ${streamCoordinator.pendingModelStepCount} model step(s) were still running.`
        );
      }

      const latestRun = await this.#getRun(run.id);
      await execution.agentCoordination.persistUnreportedTerminalDelegatedRuns({
        workspace,
        parentSessionId: session.id,
        parentRun: latestRun,
        parentAgentName: executionContext.currentAgentName
      });
      const knownMessageIds = new Set(allMessages.map((message) => message.id));
      const drainedNotifications = await drainPendingTaskNotificationsIntoHistory(latestRun.id);
      const latestMessages = await this.#repairSessionHistoryIfNeeded(
        session.id,
        await this.#messageRepository.listBySessionId(session.id)
      );
      const hasUnseenDelegatedUpdate = latestMessages.some(
        (message) => isDelegatedTerminalUpdateMessage(message) && !knownMessageIds.has(message.id)
      );
      if (hasUnseenDelegatedUpdate || drainedNotifications.messageIds.length > 0) {
        continuationCount += 1;
        if (agentPolicy?.maxSteps !== undefined && continuationCount > agentPolicy.maxSteps) {
          throw new AppError(
            409,
            "delegated_run_continuation_limit_exceeded",
            `Run ${run.id} exceeded the delegated run continuation limit.`
          );
        }

        await this.#setRunStatusIfPossible(run.id, "running");
        allMessages.length = 0;
        allMessages.push(...latestMessages);
        hookedModelInput = await buildInitialHookedModelInput();
        continue;
      }

      const hookedCompleted = await this.#applyAfterModelHooks(
        workspace,
        session,
        latestRun,
        streamCoordinator.latestHookedModelInput,
        completed
      );
      const maxSteps = hookedCompleted.maxSteps ?? agentPolicy?.maxSteps;
      if (hookedCompleted.stopReason === "max_steps") {
        throw new AppError(
          409,
          "model_max_steps_exhausted",
          maxSteps === undefined
            ? "Run reached the provider or runtime max model steps before the assistant could finish. Set agent policy.max_steps higher or retry with a narrower request."
            : `Run reached the max model steps (${maxSteps}) before the assistant could finish. Increase the agent policy.max_steps or retry with a narrower request.`
        );
      }

      await this.#finalizeSuccessfulRun(
        workspace,
        session,
        latestRun,
        streamCoordinator.assistantMessage,
        hookedCompleted,
        streamCoordinator.finalAssistantStep,
        streamCoordinator.latestMessageGenerationMetadata
      );
      break;
      }
    } catch (error) {
      const pendingModelStepStatus = abortSignal.aborted ? resolveAbortStepStatus?.() ?? "cancelled" : "failed";
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
