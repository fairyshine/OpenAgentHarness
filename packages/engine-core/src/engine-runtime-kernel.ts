import type { ChatMessage, Run, Session } from "@oah/api-contracts";

import {
  ModelInputService,
  type ModelExecutionInput
} from "./engine/model-input.js";
import { ContextPreparationPipeline } from "./engine/context-modules.js";
import {
  collapseLeadingSystemMessages,
  extractFailedToolResults,
  previewValue,
  serializeModelCallStepInput,
  serializeModelCallStepOutput,
  summarizeMessageRoles
} from "./engine/model-call-serialization.js";
import { RunRecoveryService } from "./engine/run-recovery.js";
import { RunProcessorService } from "./engine/run-processor.js";
import { EngineMessageSyncService } from "./engine/engine-message-sync.js";
import { EngineLifecycleService } from "./engine/engine-lifecycle.js";
import { SessionEngineService } from "./engine/session-engine.js";
import {
  createEngineExecutionServices,
  type CreateEngineExecutionServicesDependencies,
  type EngineExecutionServices
} from "./engine/execution-services.js";
import { buildGeneratedMessageMetadata, normalizeJsonObject } from "./engine/execution-support.js";
import { ContextCompactionService } from "./engine/context-compaction.js";
import { ModelRunExecutor } from "./engine/model-run-executor.js";
import { SessionMemoryService } from "./engine/session-memory.js";
import { WorkspaceMemoryService } from "./engine/workspace-memory.js";
import { EngineMessageProjector } from "./engine/message-projections.js";
import { buildEngineTools as createWorkspaceEngineTools } from "./capabilities/engine-capabilities.js";
import type { RunStepService } from "./engine/run-steps.js";
import type { RunStateService } from "./engine/run-state.js";
import type { SessionHistoryService } from "./engine/session-history.js";
import type { WorkspaceEngineService } from "./engine/workspace-engine.js";
import type {
  WorkspaceCommandExecutor,
  WorkspaceFileSystem,
  WorkspaceRecord,
  EngineToolSet,
  ModelDefinition,
  EngineServiceOptions,
  EngineToolExecutionContext
} from "./types.js";
import type { RunExecutionContext } from "./engine/internal-helpers.js";

export interface EngineRuntimeKernel {
  sessionRuntime: SessionEngineService;
  runRecovery: RunRecoveryService;
  modelRunExecutor: ModelRunExecutor;
  runProcessor: RunProcessorService;
  engineMessageSync: EngineMessageSyncService;
  engineLifecycle: EngineLifecycleService;
  modelInputs: ModelInputService;
  contextPreparation: ContextPreparationPipeline;
  contextCompaction: ContextCompactionService;
  sessionMemory: SessionMemoryService;
  workspaceMemory: WorkspaceMemoryService;
  engineMessageProjector: EngineMessageProjector;
}

export interface CreateEngineRuntimeKernelDependencies {
  defaultModel: string;
  modelGateway: EngineServiceOptions["modelGateway"];
  logger: EngineServiceOptions["logger"];
  runHeartbeatIntervalMs: number;
  staleRunTimeoutMs: number;
  staleRunRecoveryStrategy: "fail" | "requeue_running" | "requeue_all";
  staleRunRecoveryMaxAttempts: number;
  platformModels: Record<string, ModelDefinition>;
  messageRepository: EngineServiceOptions["messageRepository"];
  sessionRepository: EngineServiceOptions["sessionRepository"];
  runRepository: EngineServiceOptions["runRepository"];
  runStepRepository: EngineServiceOptions["runStepRepository"];
  sessionEventStore: EngineServiceOptions["sessionEventStore"];
  sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  runQueue: EngineServiceOptions["runQueue"];
  engineMessageRepository: EngineServiceOptions["engineMessageRepository"];
  agentTaskRepository: EngineServiceOptions["agentTaskRepository"];
  agentTaskNotificationRepository: EngineServiceOptions["agentTaskNotificationRepository"];
  workspaceExecutionProvider: EngineServiceOptions["workspaceExecutionProvider"];
  workspaceFileAccessProvider: EngineServiceOptions["workspaceFileAccessProvider"];
  workspaceActivityTracker: EngineServiceOptions["workspaceActivityTracker"];
  workspaceArchiveRepository: EngineServiceOptions["workspaceArchiveRepository"];
  workspaceFileSystem: WorkspaceFileSystem;
  workspaceRuntime: WorkspaceEngineService;
  runSteps: RunStepService;
  runState: RunStateService;
  sessionHistory: SessionHistoryService;
  createId: (prefix: string) => string;
  nowIso: () => string;
  runAbortControllers: Map<string, AbortController>;
  drainTimeoutRecoveredRuns: Set<string>;
  ensureExecutionServices: () => EngineExecutionServices;
  buildEngineTools: (
    workspace: WorkspaceRecord,
    run: Run,
    session: Session,
    executionContext: RunExecutionContext
  ) => EngineToolSet;
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
    response: import("@oah/api-contracts").ModelGenerateResponse
  ) => Promise<import("@oah/api-contracts").ModelGenerateResponse>;
  applyContextHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_build" | "after_context_build",
    messages: ChatMessage[]
  ) => Promise<ChatMessage[]>;
  applyCompactionHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_compact" | "after_context_compact",
    context: Record<string, unknown> & {
      messages?: ChatMessage[] | undefined;
    }
  ) => Promise<
    Record<string, unknown> & {
      messages?: ChatMessage[] | undefined;
    }
  >;
  getRun: (runId: string) => Promise<Run>;
  getSession: (sessionId: string) => Promise<Session>;
  requestRunCancellation: (runId: string) => Promise<void>;
}

export function createEngineRuntimeKernel(
  dependencies: CreateEngineRuntimeKernelDependencies
): EngineRuntimeKernel {
  const engineMessageSync = new EngineMessageSyncService({
    messageRepository: dependencies.messageRepository,
    sessionEventStore: dependencies.sessionEventStore,
    ...(dependencies.engineMessageRepository ? { engineMessageRepository: dependencies.engineMessageRepository } : {})
  });
  const modelInputs = new ModelInputService({
    defaultModel: dependencies.defaultModel,
    platformModels: dependencies.platformModels,
    workspaceFileSystem: dependencies.workspaceFileSystem,
    workspaceFileAccessProvider: dependencies.workspaceFileAccessProvider,
    applyContextHooks: (workspace, session, run, eventName, messages) =>
      dependencies.applyContextHooks(workspace, session, run, eventName, messages),
    collapseLeadingSystemMessages: (messages) => collapseLeadingSystemMessages(messages)
  });
  let engineLifecycle!: EngineLifecycleService;
  let runProcessor!: RunProcessorService;

  const workspaceMemory = new WorkspaceMemoryService({
    logger: dependencies.logger,
    modelGateway: dependencies.modelGateway,
    messageRepository: dependencies.messageRepository,
    sessionRepository: dependencies.sessionRepository,
    runRepository: dependencies.runRepository,
    runStepRepository: dependencies.runStepRepository,
    enqueueRun: (sessionId, runId, options) => engineLifecycle.enqueueRun(sessionId, runId, options),
    workspaceFileSystem: dependencies.workspaceFileSystem,
    workspaceFileAccessProvider: dependencies.workspaceFileAccessProvider,
    resolveModelForRun: (workspace, modelRef) => modelInputs.resolveModelForRun(workspace, modelRef),
    recordSystemStep: (run, name, output) => dependencies.runSteps.recordSystemStep(run, name, output),
    createId: dependencies.createId,
    nowIso: dependencies.nowIso
  });
  const contextCompaction = new ContextCompactionService({
    logger: dependencies.logger,
    messageRepository: dependencies.messageRepository,
    modelGateway: dependencies.modelGateway,
    appendEvent: (input) => engineLifecycle.appendEvent(input),
    recordSystemStep: (run, name, output) => dependencies.runSteps.recordSystemStep(run, name, output),
    scheduleEngineMessageSync: (sessionId) => engineMessageSync.scheduleEngineMessageSync(sessionId),
    createId: dependencies.createId,
    nowIso: dependencies.nowIso,
    resolveRunModel: (workspace, session, run, activeAgentName) =>
      modelInputs.resolveRunModel(workspace, session, run, activeAgentName),
    buildModelContextMessages: (workspace, session, run, engineMessages, activeAgentName, options) =>
      modelInputs.buildModelContextMessages(workspace, session, run, engineMessages, activeAgentName, false, options),
    applyCompactionHooks: (workspace, session, run, eventName, context) =>
      dependencies.applyCompactionHooks(workspace, session, run, eventName, context),
    captureWorkspaceMemoryBeforeCompaction: (input) => workspaceMemory.captureBeforeCompaction(input),
    buildEngineMessagesForSession: (sessionId, persistedMessages) =>
      engineMessageSync.buildEngineMessagesForSession(sessionId, persistedMessages)
  });
  const sessionMemory = new SessionMemoryService({
    logger: dependencies.logger,
    messageRepository: dependencies.messageRepository,
    modelGateway: dependencies.modelGateway,
    scheduleEngineMessageSync: (sessionId) => engineMessageSync.scheduleEngineMessageSync(sessionId),
    resolveRunModel: (workspace, session, run, activeAgentName) =>
      modelInputs.resolveRunModel(workspace, session, run, activeAgentName),
    recordSystemStep: (run, name, output) => dependencies.runSteps.recordSystemStep(run, name, output),
    createId: dependencies.createId,
    nowIso: dependencies.nowIso
  });
  const contextPreparation = new ContextPreparationPipeline({
    buildEngineMessagesForSession: (sessionId, persistedMessages) =>
      engineMessageSync.buildEngineMessagesForSession(sessionId, persistedMessages),
    modules: [sessionMemory, workspaceMemory, contextCompaction]
  });
  const modelRunExecutor = new ModelRunExecutor({
    logger: dependencies.logger,
    modelGateway: dependencies.modelGateway,
    messageRepository: dependencies.messageRepository,
    engineMessageSync,
    ensureExecutionServices: () => dependencies.ensureExecutionServices(),
    getRun: (runId) => dependencies.getRun(runId),
    repairSessionHistoryIfNeeded: (sessionId, messages) =>
      dependencies.sessionHistory.repairSessionHistoryIfNeeded(sessionId, messages),
    prepareMessagesForModelInput: (workspace, session, run, activeAgentName, allMessages) =>
      contextPreparation.prepareMessagesForModelInput({
        workspace,
        session,
        run,
        activeAgentName,
        messages: allMessages
      }),
    buildModelInput: (workspace, session, run, engineMessages, activeAgentName, forceSystemReminder) =>
      modelInputs.buildModelInput(workspace, session, run, engineMessages, activeAgentName, forceSystemReminder),
    applyBeforeModelHooks: (workspace, session, run, modelInput) =>
      dependencies.applyBeforeModelHooks(workspace, session, run, modelInput),
    applyAfterModelHooks: (workspace, session, run, modelInput, response) =>
      dependencies.applyAfterModelHooks(workspace, session, run, modelInput, response),
    buildEngineTools: (workspace, run, session, executionContext) => {
      executionContext.injectModelContextMessage = (message) => {
        executionContext.pendingModelContextMessages ??= [];
        executionContext.pendingModelContextMessages.push(message);
      };
      return dependencies.buildEngineTools(workspace, run, session, executionContext);
    },
    startRunStep: (input) => dependencies.runSteps.startRunStep(input),
    completeRunStep: (step, status, output) => dependencies.runSteps.completeRunStep(step, status, output),
    setRunStatusIfPossible: (runId, nextStatus) => dependencies.runState.setRunStatusIfPossible(runId, nextStatus),
    ensureAssistantMessage: (session, run, currentMessage, allMessages, content, metadata) =>
      dependencies.ensureExecutionServices().toolMessages.ensureAssistantMessage(
        session,
        run,
        currentMessage,
        allMessages,
        content,
        metadata
      ),
    persistAssistantStepText: (session, run, step, currentMessage, allMessages, metadata) =>
      dependencies.ensureExecutionServices().toolMessages.persistAssistantStepText(
        session,
        run,
        step,
        currentMessage,
        allMessages,
        metadata
      ),
    persistAssistantToolCalls: (session, run, step, allMessages, metadata, toolMetadataByCallId) =>
      dependencies.ensureExecutionServices().toolMessages.persistAssistantToolCalls(
        session,
        run,
        step,
        allMessages,
        metadata,
        toolMetadataByCallId
      ),
    persistToolResults: (
      session,
      run,
      step,
      failedToolResults,
      persistedToolCalls,
      allMessages,
      metadata,
      toolMetadataByCallId
    ) =>
      dependencies.ensureExecutionServices().toolMessages.persistToolResults(
        session,
        run,
        step,
        failedToolResults,
        persistedToolCalls,
        allMessages,
        metadata,
        toolMetadataByCallId
      ),
    appendEvent: (input) => engineLifecycle.appendEvent(input),
    serializeModelCallStepInput: (modelInput, activeToolNames, toolServers, engineToolNames, engineTools) =>
      serializeModelCallStepInput(modelInput, activeToolNames, toolServers, engineToolNames, engineTools),
    serializeModelCallStepOutput: (step, failedToolResults) =>
      serializeModelCallStepOutput(step, failedToolResults),
    extractFailedToolResults: (step) => extractFailedToolResults(step),
    buildGeneratedMessageMetadata: (workspace, agentName, modelInput, modelCallStep) =>
      buildGeneratedMessageMetadata(workspace, agentName, modelInput, modelCallStep),
    recordToolCallAuditFromStep: (step, toolName, status) =>
      dependencies.ensureExecutionServices().toolAudit.recordToolCallAuditFromStep(step, toolName, status),
    summarizeMessageRoles: (messages) => summarizeMessageRoles(messages),
    previewValue: (value, maxLength) => previewValue(value, maxLength),
    normalizeJsonObject: (value) => normalizeJsonObject(value),
    finalizeSuccessfulRun: (workspace, session, run, assistantMessage, completed, finalAssistantStep, messageMetadata) =>
      dependencies.ensureExecutionServices().runFinalization.finalizeSuccessfulRun({
        workspace,
        session,
        run,
        assistantMessage,
        completed,
        finalAssistantStep,
        messageMetadata
      })
  });
  runProcessor = new RunProcessorService({
    logger: dependencies.logger,
    ...(dependencies.workspaceExecutionProvider ? { workspaceExecutionProvider: dependencies.workspaceExecutionProvider } : {}),
    runAbortControllers: dependencies.runAbortControllers,
    drainTimeoutRecoveredRuns: dependencies.drainTimeoutRecoveredRuns,
    runHeartbeatIntervalMs: dependencies.runHeartbeatIntervalMs,
    ensureExecutionServices: () => dependencies.ensureExecutionServices(),
    getRun: (runId) => dependencies.getRun(runId),
    getSession: (sessionId) => dependencies.getSession(sessionId),
    getWorkspaceRecord: (workspaceId) => dependencies.workspaceRuntime.getWorkspaceRecord(workspaceId),
    setRunStatus: (run, nextStatus, patch) => dependencies.runState.setRunStatus(run, nextStatus, patch),
    markRunCancelled: (sessionId, run) => dependencies.runState.markRunCancelled(sessionId, run),
    refreshRunHeartbeat: (runId) => dependencies.runState.refreshRunHeartbeat(runId),
    recordSystemStep: (run, name, output) => dependencies.runSteps.recordSystemStep(run, name, output),
    appendEvent: (input) => engineLifecycle.appendEvent(input),
    modelRunExecutor,
    processActionRun: (workspace, run, session, signal) =>
      dependencies.ensureExecutionServices().actions.processActionRun(workspace, run, session, signal)
  });
  engineLifecycle = new EngineLifecycleService({
    sessionEventStore: dependencies.sessionEventStore,
    engineMessageSync,
    workspaceActivityTracker: dependencies.workspaceActivityTracker,
    runRepository: dependencies.runRepository,
    sessionRepository: dependencies.sessionRepository,
    ...(dependencies.runQueue ? { runQueue: dependencies.runQueue } : {}),
    processRun: (runId) => runProcessor.processRun(runId)
  });
  const engineMessageProjector = new EngineMessageProjector();
  const sessionRuntime = new SessionEngineService({
    sessionRepository: dependencies.sessionRepository,
    messageRepository: dependencies.messageRepository,
    runRepository: dependencies.runRepository,
    runStepRepository: dependencies.runStepRepository,
    sessionPendingRunQueueRepository: dependencies.sessionPendingRunQueueRepository,
    workspaceArchiveRepository: dependencies.workspaceArchiveRepository,
    modelInputs,
    engineMessageSync,
    engineMessageProjector,
    getWorkspaceRecord: (workspaceId) => dependencies.workspaceRuntime.getWorkspaceRecord(workspaceId),
    getRun: (runId) => dependencies.getRun(runId),
    appendEvent: (input) => engineLifecycle.appendEvent(input),
    enqueueRun: (sessionId, runId) => engineLifecycle.enqueueRun(sessionId, runId),
    requestRunCancellation: (runId) => dependencies.requestRunCancellation(runId)
  });
  const runRecovery = new RunRecoveryService({
    getRun: (runId) => dependencies.getRun(runId),
    getSession: (sessionId) => dependencies.getSession(sessionId),
    runRepository: dependencies.runRepository,
    ...(dependencies.runQueue ? { runQueue: dependencies.runQueue } : {}),
    updateRun: (run, patch) => dependencies.runState.updateRun(run, patch),
    appendEvent: (input) => engineLifecycle.appendEvent(input),
    recordSystemStep: (run, name, output) => dependencies.runSteps.recordSystemStep(run, name, output),
    enqueueRun: (sessionId, runId) => engineLifecycle.enqueueRun(sessionId, runId),
    runAbortControllers: dependencies.runAbortControllers,
    drainTimeoutRecoveredRuns: dependencies.drainTimeoutRecoveredRuns,
    staleRunTimeoutMs: dependencies.staleRunTimeoutMs,
    staleRunRecoveryStrategy: dependencies.staleRunRecoveryStrategy,
    staleRunRecoveryMaxAttempts: dependencies.staleRunRecoveryMaxAttempts
  });

  return {
    sessionRuntime,
    runRecovery,
    modelRunExecutor,
    runProcessor,
    engineMessageSync,
    engineLifecycle,
    modelInputs,
    contextPreparation,
    contextCompaction,
    sessionMemory,
    workspaceMemory,
    engineMessageProjector
  };
}

export function createRuntimeExecutionServices(
  dependencies: CreateEngineExecutionServicesDependencies
): EngineExecutionServices {
  return createEngineExecutionServices(dependencies);
}

export function buildRuntimeEngineTools(input: {
  workspace: WorkspaceRecord;
  run: Run;
  session: Session;
  executionContext: RunExecutionContext;
  modelGateway: EngineServiceOptions["modelGateway"];
  defaultModel: string;
  commandExecutor: WorkspaceCommandExecutor;
  fileSystem: WorkspaceFileSystem;
  workspaceFileAccessProvider?: EngineServiceOptions["workspaceFileAccessProvider"] | undefined;
  executeAction: (
    action: WorkspaceRecord["actions"][string],
    value: unknown,
    context: EngineToolExecutionContext
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; output: string }>;
  delegateAgent: (
    input: {
      targetAgentName?: string | undefined;
      task: string;
      handoffSummary?: string | undefined;
      taskId?: string | undefined;
      notifyParentOnCompletion?: boolean | undefined;
      toolUseId?: string | undefined;
    },
    currentAgentName: string
  ) => Promise<{
    childSessionId: string;
    childRunId: string;
    targetAgentName: string;
    outputFile?: string | undefined;
    outputRef?: string | undefined;
    canReadOutputFile?: boolean | undefined;
  }>;
  readAgentTaskOutput: (input: {
    taskId: string;
    block?: boolean | undefined;
    timeoutMs?: number | undefined;
    abortSignal?: AbortSignal | undefined;
  }) => Promise<{
    retrievalStatus: "success" | "timeout" | "not_ready";
    task: {
      taskId: string;
      taskType: "local_agent";
      childSessionId?: string | undefined;
      childRunId?: string | undefined;
      status: "pending" | "running" | "completed" | "failed" | "killed";
      description: string;
      output: string;
      outputRef: string;
      outputFile?: string | undefined;
      result?: string | undefined;
      error?: string | undefined;
      usage?: Record<string, unknown> | undefined;
    } | null;
  }>;
  awaitDelegatedRuns: (input: { runIds: string[]; mode: "all" | "any" }) => Promise<string>;
  switchAgent: (targetAgentName: string, currentAgentName: string) => Promise<void>;
  injectModelContextMessage?: ((message: ChatMessage) => void) | undefined;
}): EngineToolSet {
  return createWorkspaceEngineTools({
    workspace: input.workspace,
    run: input.run,
    session: input.session,
    getCurrentAgentName: () => input.executionContext.currentAgentName,
    modelGateway: input.modelGateway,
    defaultModel: input.defaultModel,
    commandExecutor: input.commandExecutor,
    fileSystem: input.fileSystem,
    ...(input.injectModelContextMessage ? { injectModelContextMessage: input.injectModelContextMessage } : {}),
    ...(input.workspaceFileAccessProvider ? { workspaceFileAccessProvider: input.workspaceFileAccessProvider } : {}),
    executeAction: async (action, value, context) => input.executeAction(action, value, context),
    delegateAgent: (options, currentAgentName) => input.delegateAgent(options, currentAgentName),
    readAgentTaskOutput: (options) => input.readAgentTaskOutput(options),
    awaitDelegatedRuns: (options) => input.awaitDelegatedRuns(options),
    switchAgent: (targetAgentName, currentAgentName) => input.switchAgent(targetAgentName, currentAgentName)
  });
}
