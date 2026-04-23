import type {
  ChatMessage,
  Message,
  ModelGenerateResponse,
  Run,
  Session,
  WorkspaceCatalog
} from "@oah/api-contracts";

import { AppError } from "./errors.js";
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
import { RunStateService } from "./engine/run-state.js";
import { SessionHistoryService } from "./engine/session-history.js";
import { RunStepService } from "./engine/run-steps.js";
import { RunRecoveryService } from "./engine/run-recovery.js";
import { RunProcessorService } from "./engine/run-processor.js";
import { EngineMessageSyncService } from "./engine/engine-message-sync.js";
import { EngineLifecycleService } from "./engine/engine-lifecycle.js";
import { SessionEngineService } from "./engine/session-engine.js";
import { createEngineExecutionServices, type EngineExecutionServices } from "./engine/execution-services.js";
import { buildGeneratedMessageMetadata, normalizeJsonObject } from "./engine/execution-support.js";
import { ContextCompactionService } from "./engine/context-compaction.js";
import { ModelRunExecutor } from "./engine/model-run-executor.js";
import { SessionMemoryService } from "./engine/session-memory.js";
import { WorkspaceMemoryService } from "./engine/workspace-memory.js";
import { WorkspaceEngineService } from "./engine/workspace-engine.js";
import {
  EngineMessageProjector
} from "./engine/message-projections.js";
import {
  type SortOrder,
  type WorkspaceDeleteResult,
  type WorkspaceEntry,
  type WorkspaceEntryPage,
  type WorkspaceEntrySortBy,
  type WorkspaceFileContentResult,
  type WorkspaceFileDownloadResult,
  WorkspaceFileService
} from "./workspace/workspace-files.js";
import {
  buildEngineTools as createWorkspaceEngineTools,
} from "./capabilities/engine-capabilities.js";
import {
  type ActionRunAcceptedResult,
  type CancelRunResult,
  type CompactSessionParams,
  type RequeueRunResult,
  type MessageAcceptedResult,
  type CreateSessionMessageParams,
  type CreateSessionParams,
  type UpdateSessionParams,
  type CreateWorkspaceParams,
  type MessageListResult,
  type MessagePageDirection,
  type EngineMessageListResult,
  type EngineServiceOptions,
  type SessionEvent,
  type EngineToolSet,
  type TriggerActionRunParams,
  type ModelDefinition,
  type WorkspaceCommandExecutor,
  type WorkspaceFileSystem,
  type RunStepListResult,
  type SessionListResult,
  type SessionCompactResult,
  type WorkspaceListResult,
  type RunListResult,
  type WorkspaceRecord
} from "./types.js";
import { createId, nowIso } from "./utils.js";
import { createLocalWorkspaceCommandExecutor } from "./workspace/workspace-command-executor.js";
import { createLocalWorkspaceFileSystem } from "./workspace/workspace-file-system.js";
import {
  type AutomaticRecoveryStrategy,
  type RunExecutionContext
} from "./engine/internal-helpers.js";

export class EngineService {
  readonly #defaultModel: string;
  readonly #modelGateway: EngineServiceOptions["modelGateway"];
  readonly #logger: EngineServiceOptions["logger"];
  readonly #executionServicesMode: NonNullable<EngineServiceOptions["executionServicesMode"]>;
  readonly #runHeartbeatIntervalMs: number;
  readonly #staleRunRecoveryStrategy: "fail" | "requeue_running" | "requeue_all";
  readonly #staleRunRecoveryMaxAttempts: number;
  readonly #platformModels: Record<string, ModelDefinition>;
  readonly #workspaceRepository: EngineServiceOptions["workspaceRepository"];
  readonly #sessionRepository: EngineServiceOptions["sessionRepository"];
  readonly #messageRepository: EngineServiceOptions["messageRepository"];
  readonly #runRepository: EngineServiceOptions["runRepository"];
  readonly #runStepRepository: EngineServiceOptions["runStepRepository"];
  readonly #sessionEventStore: EngineServiceOptions["sessionEventStore"];
  readonly #sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  readonly #runQueue: EngineServiceOptions["runQueue"];
  readonly #toolCallAuditRepository: EngineServiceOptions["toolCallAuditRepository"];
  readonly #workspaceArchiveRepository: EngineServiceOptions["workspaceArchiveRepository"];
  readonly #workspaceDeletionHandler: EngineServiceOptions["workspaceDeletionHandler"];
  readonly #workspaceInitializer: EngineServiceOptions["workspaceInitializer"];
  readonly #workspaceExecutionProvider: EngineServiceOptions["workspaceExecutionProvider"];
  readonly #workspaceFileAccessProvider: EngineServiceOptions["workspaceFileAccessProvider"];
  readonly #hookRunAuditRepository: EngineServiceOptions["hookRunAuditRepository"];
  readonly #workspaceFileSystem: WorkspaceFileSystem;
  readonly #workspaceCommandExecutor: WorkspaceCommandExecutor;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #sessionHistory: SessionHistoryService;
  readonly #runSteps: RunStepService;
  readonly #runState: RunStateService;
  readonly #workspaceRuntime: WorkspaceEngineService;
  readonly #sessionRuntime: SessionEngineService;
  readonly #runRecovery: RunRecoveryService;
  readonly #modelRunExecutor: ModelRunExecutor;
  readonly #runProcessor: RunProcessorService;
  readonly #engineMessageSync: EngineMessageSyncService;
  readonly #engineLifecycle: EngineLifecycleService;
  readonly #modelInputs: ModelInputService;
  readonly #contextPreparation: ContextPreparationPipeline;
  readonly #contextCompaction: ContextCompactionService;
  readonly #sessionMemory: SessionMemoryService;
  readonly #workspaceMemory: WorkspaceMemoryService;
  readonly #engineMessageProjector: EngineMessageProjector;
  #executionServices: EngineExecutionServices | undefined;
  readonly #runAbortControllers = new Map<string, AbortController>();
  readonly #drainTimeoutRecoveredRuns = new Set<string>();

  constructor(options: EngineServiceOptions) {
    this.#defaultModel = options.defaultModel;
    this.#modelGateway = options.modelGateway;
    this.#logger = options.logger;
    this.#executionServicesMode = options.executionServicesMode ?? "eager";
    this.#runHeartbeatIntervalMs = Math.max(50, options.runHeartbeatIntervalMs ?? 5_000);
    this.#staleRunRecoveryStrategy = options.staleRunRecovery?.strategy ?? "fail";
    this.#staleRunRecoveryMaxAttempts = Math.max(1, Math.floor(options.staleRunRecovery?.maxAttempts ?? 1));
    this.#platformModels = options.platformModels ?? {};
    this.#workspaceRepository = options.workspaceRepository;
    this.#sessionRepository = options.sessionRepository;
    this.#messageRepository = options.messageRepository;
    this.#runRepository = options.runRepository;
    this.#runStepRepository = options.runStepRepository;
    this.#sessionEventStore = options.sessionEventStore;
    this.#sessionPendingRunQueueRepository = options.sessionPendingRunQueueRepository;
    this.#runQueue = options.runQueue;
    this.#toolCallAuditRepository = options.toolCallAuditRepository;
    this.#workspaceArchiveRepository = options.workspaceArchiveRepository;
    this.#workspaceDeletionHandler = options.workspaceDeletionHandler;
    this.#workspaceInitializer = options.workspaceInitializer;
    this.#workspaceExecutionProvider = options.workspaceExecutionProvider;
    this.#workspaceFileAccessProvider = options.workspaceFileAccessProvider;
    this.#hookRunAuditRepository = options.hookRunAuditRepository;
    this.#workspaceFileSystem = options.workspaceFileSystem ?? createLocalWorkspaceFileSystem();
    this.#workspaceCommandExecutor = options.workspaceCommandExecutor ?? createLocalWorkspaceCommandExecutor();
    this.#workspaceFiles = new WorkspaceFileService(this.#workspaceFileSystem);
    this.#sessionHistory = new SessionHistoryService({
      messageRepository: this.#messageRepository,
      logger: this.#logger
    });
    this.#runSteps = new RunStepService({
      runStepRepository: this.#runStepRepository,
      createId,
      nowIso
    });
    this.#runState = new RunStateService({
      runRepository: this.#runRepository,
      getRun: (runId) => this.getRun(runId),
      appendEvent: (input) => this.#engineLifecycle.appendEvent(input),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      nowIso
    });
    this.#workspaceRuntime = new WorkspaceEngineService({
      workspaceRepository: this.#workspaceRepository,
      workspaceInitializer: this.#workspaceInitializer,
      workspaceArchiveRepository: this.#workspaceArchiveRepository,
      workspaceDeletionHandler: this.#workspaceDeletionHandler,
      workspaceFileAccessProvider: this.#workspaceFileAccessProvider,
      workspaceFiles: this.#workspaceFiles,
      workspaceFileSystem: this.#workspaceFileSystem,
      workspaceCommandExecutor: this.#workspaceCommandExecutor
    });
    this.#runRecovery = new RunRecoveryService({
      getRun: (runId) => this.getRun(runId),
      getSession: (sessionId) => this.getSession(sessionId),
      runRepository: this.#runRepository,
      ...(this.#runQueue ? { runQueue: this.#runQueue } : {}),
      updateRun: (run, patch) => this.#runState.updateRun(run, patch),
      appendEvent: (input) => this.#engineLifecycle.appendEvent(input),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      enqueueRun: (sessionId, runId) => this.#engineLifecycle.enqueueRun(sessionId, runId),
      runAbortControllers: this.#runAbortControllers,
      drainTimeoutRecoveredRuns: this.#drainTimeoutRecoveredRuns,
      runHeartbeatIntervalMs: this.#runHeartbeatIntervalMs,
      staleRunRecoveryStrategy: this.#staleRunRecoveryStrategy,
      staleRunRecoveryMaxAttempts: this.#staleRunRecoveryMaxAttempts
    });
    this.#engineMessageSync = new EngineMessageSyncService({
      messageRepository: this.#messageRepository,
      sessionEventStore: this.#sessionEventStore,
      ...(options.engineMessageRepository ? { engineMessageRepository: options.engineMessageRepository } : {})
    });
    this.#modelInputs = new ModelInputService({
      defaultModel: this.#defaultModel,
      platformModels: this.#platformModels,
      applyContextHooks: (workspace, session, run, eventName, messages) =>
        this.#applyContextHooks(workspace, session, run, eventName, messages),
      collapseLeadingSystemMessages: (messages) => collapseLeadingSystemMessages(messages)
    });
    this.#contextCompaction = new ContextCompactionService({
      logger: this.#logger,
      messageRepository: this.#messageRepository,
      modelGateway: this.#modelGateway,
      appendEvent: (input) => this.#engineLifecycle.appendEvent(input),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      scheduleEngineMessageSync: (sessionId) => this.#engineMessageSync.scheduleEngineMessageSync(sessionId),
      createId,
      nowIso,
      resolveRunModel: (workspace, session, run, activeAgentName) =>
        this.#modelInputs.resolveRunModel(workspace, session, run, activeAgentName),
      buildModelContextMessages: (workspace, session, run, engineMessages, activeAgentName, options) =>
        this.#modelInputs.buildModelContextMessages(
          workspace,
          session,
          run,
          engineMessages,
          activeAgentName,
          false,
          options
        ),
      applyCompactionHooks: (workspace, session, run, eventName, context) =>
        this.#applyCompactionHooks(workspace, session, run, eventName, context),
      buildEngineMessagesForSession: (sessionId, persistedMessages) =>
        this.#engineMessageSync.buildEngineMessagesForSession(sessionId, persistedMessages)
    });
    this.#sessionMemory = new SessionMemoryService({
      logger: this.#logger,
      messageRepository: this.#messageRepository,
      modelGateway: this.#modelGateway,
      scheduleEngineMessageSync: (sessionId) => this.#engineMessageSync.scheduleEngineMessageSync(sessionId),
      resolveRunModel: (workspace, session, run, activeAgentName) =>
        this.#modelInputs.resolveRunModel(workspace, session, run, activeAgentName),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      createId,
      nowIso
    });
    this.#workspaceMemory = new WorkspaceMemoryService({
      logger: this.#logger,
      modelGateway: this.#modelGateway,
      messageRepository: this.#messageRepository,
      sessionRepository: this.#sessionRepository,
      runRepository: this.#runRepository,
      runStepRepository: this.#runStepRepository,
      enqueueRun: (sessionId, runId, options) => this.#engineLifecycle.enqueueRun(sessionId, runId, options),
      workspaceFileSystem: this.#workspaceFileSystem,
      workspaceFileAccessProvider: this.#workspaceFileAccessProvider,
      resolveModelForRun: (workspace, modelRef) => this.#modelInputs.resolveModelForRun(workspace, modelRef),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      createId,
      nowIso
    });
    this.#contextPreparation = new ContextPreparationPipeline({
      buildEngineMessagesForSession: (sessionId, persistedMessages) =>
        this.#engineMessageSync.buildEngineMessagesForSession(sessionId, persistedMessages),
      modules: [this.#sessionMemory, this.#workspaceMemory, this.#contextCompaction]
    });
    this.#modelRunExecutor = new ModelRunExecutor({
      logger: this.#logger,
      modelGateway: this.#modelGateway,
      messageRepository: this.#messageRepository,
      engineMessageSync: this.#engineMessageSync,
      ensureExecutionServices: () => this.#ensureExecutionServices(),
      getRun: (runId) => this.getRun(runId),
      repairSessionHistoryIfNeeded: (sessionId, messages) => this.#sessionHistory.repairSessionHistoryIfNeeded(sessionId, messages),
      prepareMessagesForModelInput: (workspace, session, run, activeAgentName, allMessages) =>
        this.#contextPreparation.prepareMessagesForModelInput({
          workspace,
          session,
          run,
          activeAgentName,
          messages: allMessages
        }),
      buildModelInput: (workspace, session, run, engineMessages, activeAgentName, forceSystemReminder) =>
        this.#modelInputs.buildModelInput(workspace, session, run, engineMessages, activeAgentName, forceSystemReminder),
      applyBeforeModelHooks: (workspace, session, run, modelInput) =>
        this.#applyBeforeModelHooks(workspace, session, run, modelInput),
      applyAfterModelHooks: (workspace, session, run, modelInput, response) =>
        this.#applyAfterModelHooks(workspace, session, run, modelInput, response),
      buildEngineTools: (workspace, run, session, executionContext) =>
        this.#buildEngineTools(workspace, run, session, executionContext),
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      setRunStatusIfPossible: (runId, nextStatus) => this.#runState.setRunStatusIfPossible(runId, nextStatus),
      ensureAssistantMessage: (session, run, currentMessage, allMessages, content, metadata) =>
        this.#ensureExecutionServices().toolMessages.ensureAssistantMessage(
          session,
          run,
          currentMessage,
          allMessages,
          content,
          metadata
        ),
      persistAssistantStepText: (session, run, step, currentMessage, allMessages, metadata) =>
        this.#ensureExecutionServices().toolMessages.persistAssistantStepText(
          session,
          run,
          step,
          currentMessage,
          allMessages,
          metadata
        ),
      persistAssistantToolCalls: (session, run, step, allMessages, metadata, toolMetadataByCallId) =>
        this.#ensureExecutionServices().toolMessages.persistAssistantToolCalls(
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
        this.#ensureExecutionServices().toolMessages.persistToolResults(
          session,
          run,
          step,
          failedToolResults,
          persistedToolCalls,
          allMessages,
          metadata,
          toolMetadataByCallId
        ),
      appendEvent: (input) => this.#engineLifecycle.appendEvent(input),
      serializeModelCallStepInput: (modelInput, activeToolNames, toolServers, engineToolNames, engineTools) =>
        serializeModelCallStepInput(modelInput, activeToolNames, toolServers, engineToolNames, engineTools),
      serializeModelCallStepOutput: (step, failedToolResults) =>
        serializeModelCallStepOutput(step, failedToolResults),
      extractFailedToolResults: (step) => extractFailedToolResults(step),
      buildGeneratedMessageMetadata: (workspace, agentName, modelInput, modelCallStep) =>
        buildGeneratedMessageMetadata(workspace, agentName, modelInput, modelCallStep),
      recordToolCallAuditFromStep: (step, toolName, status) =>
        this.#ensureExecutionServices().toolAudit.recordToolCallAuditFromStep(step, toolName, status),
      summarizeMessageRoles: (messages) => summarizeMessageRoles(messages),
      previewValue: (value, maxLength) => previewValue(value, maxLength),
      normalizeJsonObject: (value) => normalizeJsonObject(value),
      finalizeSuccessfulRun: (workspace, session, run, assistantMessage, completed, finalAssistantStep, messageMetadata) =>
        this.#ensureExecutionServices().runFinalization.finalizeSuccessfulRun({
          workspace,
          session,
          run,
          assistantMessage,
          completed,
          finalAssistantStep,
          messageMetadata
        })
    });
    this.#runProcessor = new RunProcessorService({
      logger: this.#logger,
      ...(this.#workspaceExecutionProvider ? { workspaceExecutionProvider: this.#workspaceExecutionProvider } : {}),
      runAbortControllers: this.#runAbortControllers,
      drainTimeoutRecoveredRuns: this.#drainTimeoutRecoveredRuns,
      runHeartbeatIntervalMs: this.#runHeartbeatIntervalMs,
      ensureExecutionServices: () => this.#ensureExecutionServices(),
      getRun: (runId) => this.getRun(runId),
      getSession: (sessionId) => this.getSession(sessionId),
      getWorkspaceRecord: (workspaceId) => this.getWorkspaceRecord(workspaceId),
      setRunStatus: (run, nextStatus, patch) => this.#runState.setRunStatus(run, nextStatus, patch),
      markRunCancelled: (sessionId, run) => this.#runState.markRunCancelled(sessionId, run),
      refreshRunHeartbeat: (runId) => this.#runState.refreshRunHeartbeat(runId),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      appendEvent: (input) => this.#engineLifecycle.appendEvent(input),
      modelRunExecutor: this.#modelRunExecutor,
      processActionRun: (workspace, run, session, signal) =>
        this.#ensureExecutionServices().actions.processActionRun(workspace, run, session, signal)
    });
    this.#engineLifecycle = new EngineLifecycleService({
      sessionEventStore: this.#sessionEventStore,
      engineMessageSync: this.#engineMessageSync,
      workspaceActivityTracker: options.workspaceActivityTracker,
      runRepository: this.#runRepository,
      sessionRepository: this.#sessionRepository,
      ...(this.#runQueue ? { runQueue: this.#runQueue } : {}),
      processRun: (runId) => this.#runProcessor.processRun(runId)
    });
    this.#engineMessageProjector = new EngineMessageProjector();
    this.#sessionRuntime = new SessionEngineService({
      sessionRepository: this.#sessionRepository,
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      runStepRepository: this.#runStepRepository,
      sessionPendingRunQueueRepository: this.#sessionPendingRunQueueRepository,
      workspaceArchiveRepository: this.#workspaceArchiveRepository,
      modelInputs: this.#modelInputs,
      engineMessageSync: this.#engineMessageSync,
      engineMessageProjector: this.#engineMessageProjector,
      getWorkspaceRecord: (workspaceId) => this.#workspaceRuntime.getWorkspaceRecord(workspaceId),
      getRun: (runId) => this.getRun(runId),
      appendEvent: (input) => this.#engineLifecycle.appendEvent(input),
      enqueueRun: (sessionId, runId) => this.#engineLifecycle.enqueueRun(sessionId, runId),
      requestRunCancellation: (runId) => this.#requestRunCancellation(runId)
    });
    if (this.#executionServicesMode === "eager") {
      this.#executionServices = this.#createExecutionServices();
    }
  }

  #createExecutionServices(): EngineExecutionServices {
    return createEngineExecutionServices({
      defaultModel: this.#defaultModel,
      modelGateway: this.#modelGateway,
      logger: this.#logger,
      workspaceCommandExecutor: this.#workspaceCommandExecutor,
      workspaceFileSystem: this.#workspaceFileSystem,
      workspaceFileAccessProvider: this.#workspaceFileAccessProvider,
      hookRunAuditRepository: this.#hookRunAuditRepository,
      toolCallAuditRepository: this.#toolCallAuditRepository,
      sessionRepository: this.#sessionRepository,
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      setRunStatus: (run, nextStatus, patch) => this.#runState.setRunStatus(run, nextStatus, patch),
      setRunStatusIfPossible: (runId, nextStatus) => this.#runState.setRunStatusIfPossible(runId, nextStatus),
      updateRun: (run, patch) => this.#runState.updateRun(run, patch),
      markRunTimedOut: (run, runTimeoutMs) => this.#runState.markRunTimedOut(run, runTimeoutMs),
      markRunCancelled: (sessionId, run) => this.#runState.markRunCancelled(sessionId, run),
      resolveModelForRun: (workspace, modelRef) => this.#modelInputs.resolveModelForRun(workspace, modelRef),
      appendEvent: (input) => this.#engineLifecycle.appendEvent(input),
      getRun: (runId) => this.getRun(runId),
      enqueueRun: (sessionId, runId, options) => this.#engineLifecycle.enqueueRun(sessionId, runId, options),
      dispatchNextQueuedRun: (sessionId) => this.#sessionRuntime.dispatchNextQueuedRun(sessionId),
      afterSuccessfulRun: async ({ workspace, session, run }) => {
        await this.#workspaceMemory.recordRecallForCompletedRun(run);
        this.#sessionMemory.scheduleBackgroundUpdate({ workspace, session, run });
        this.#workspaceMemory.scheduleBackgroundUpdate({ workspace, session, run });
      }
    });
  }

  #ensureExecutionServices(): EngineExecutionServices {
    if (!this.#executionServices) {
      this.#executionServices = this.#createExecutionServices();
    }

    return this.#executionServices;
  }

  async createWorkspace({ input }: CreateWorkspaceParams): Promise<import("@oah/api-contracts").Workspace> {
    return this.#workspaceRuntime.createWorkspace({ input });
  }

  async getWorkspace(workspaceId: string): Promise<import("@oah/api-contracts").Workspace> {
    return this.#workspaceRuntime.getWorkspace(workspaceId);
  }

  async listWorkspaces(pageSize = 50, cursor?: string): Promise<WorkspaceListResult> {
    return this.#workspaceRuntime.listWorkspaces(pageSize, cursor);
  }

  async getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord> {
    return this.#workspaceRuntime.getWorkspaceRecord(workspaceId);
  }

  async getWorkspaceCatalog(workspaceId: string): Promise<WorkspaceCatalog> {
    return this.#workspaceRuntime.getWorkspaceCatalog(workspaceId);
  }

  async listWorkspaceEntries(
    workspaceId: string,
    input: {
      path?: string | undefined;
      pageSize: number;
      cursor?: string | undefined;
      sortBy: WorkspaceEntrySortBy;
      sortOrder: SortOrder;
    }
  ): Promise<WorkspaceEntryPage> {
    return this.#workspaceRuntime.listWorkspaceEntries(workspaceId, input);
  }

  async getWorkspaceFileContent(
    workspaceId: string,
    input: { path: string; encoding: "utf8" | "base64"; maxBytes?: number | undefined }
  ): Promise<WorkspaceFileContentResult> {
    return this.#workspaceRuntime.getWorkspaceFileContent(workspaceId, input);
  }

  async putWorkspaceFileContent(
    workspaceId: string,
    input: {
      path: string;
      content: string;
      encoding: "utf8" | "base64";
      overwrite?: boolean | undefined;
      ifMatch?: string | undefined;
    }
  ): Promise<WorkspaceEntry> {
    return this.#workspaceRuntime.putWorkspaceFileContent(workspaceId, input);
  }

  async uploadWorkspaceFile(
    workspaceId: string,
    input: { path: string; data: Buffer; overwrite?: boolean | undefined; ifMatch?: string | undefined; mtimeMs?: number | undefined }
  ): Promise<WorkspaceEntry> {
    return this.#workspaceRuntime.uploadWorkspaceFile(workspaceId, input);
  }

  async createWorkspaceDirectory(
    workspaceId: string,
    input: { path: string; createParents: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#workspaceRuntime.createWorkspaceDirectory(workspaceId, input);
  }

  async deleteWorkspaceEntry(
    workspaceId: string,
    input: { path: string; recursive: boolean }
  ): Promise<WorkspaceDeleteResult> {
    return this.#workspaceRuntime.deleteWorkspaceEntry(workspaceId, input);
  }

  async moveWorkspaceEntry(
    workspaceId: string,
    input: { sourcePath: string; targetPath: string; overwrite: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#workspaceRuntime.moveWorkspaceEntry(workspaceId, input);
  }

  async getWorkspaceFileDownload(
    workspaceId: string,
    targetPath: string
  ): Promise<WorkspaceFileDownloadResult> {
    return this.#workspaceRuntime.getWorkspaceFileDownload(workspaceId, targetPath);
  }

  async openWorkspaceFileDownload(
    workspaceId: string,
    targetPath: string
  ): Promise<{
    file: WorkspaceFileDownloadResult;
    release(options?: { dirty?: boolean | undefined }): Promise<void>;
  }> {
    return this.#workspaceRuntime.openWorkspaceFileDownload(workspaceId, targetPath);
  }

  async runWorkspaceCommandForeground(
    workspaceId: string,
    input: {
      command: string;
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      timeoutMs?: number | undefined;
      stdinText?: string | undefined;
      access?: "read" | "write" | undefined;
    }
  ) {
    return this.#workspaceRuntime.runWorkspaceCommandForeground(workspaceId, input);
  }

  async runWorkspaceCommandProcess(
    workspaceId: string,
    input: {
      executable: string;
      args: string[];
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      timeoutMs?: number | undefined;
      stdinText?: string | undefined;
      access?: "read" | "write" | undefined;
    }
  ) {
    return this.#workspaceRuntime.runWorkspaceCommandProcess(workspaceId, input);
  }

  async runWorkspaceCommandBackground(
    workspaceId: string,
    input: {
      command: string;
      sessionId: string;
      description?: string | undefined;
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      access?: "read" | "write" | undefined;
    }
  ) {
    return this.#workspaceRuntime.runWorkspaceCommandBackground(workspaceId, input);
  }

  async getWorkspaceFileStat(workspaceId: string, targetPath: string) {
    return this.#workspaceRuntime.getWorkspaceFileStat(workspaceId, targetPath);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.#workspaceRuntime.deleteWorkspace(workspaceId);
  }

  async createSession({ workspaceId, caller, input }: CreateSessionParams): Promise<Session> {
    return this.#sessionRuntime.createSession({ workspaceId, caller, input });
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.#sessionRuntime.getSession(sessionId);
  }

  async updateSession({ sessionId, input }: UpdateSessionParams): Promise<Session> {
    return this.#sessionRuntime.updateSession({ sessionId, input });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#sessionRuntime.deleteSession(sessionId);
  }

  async listWorkspaceSessions(workspaceId: string, pageSize: number, cursor?: string): Promise<SessionListResult> {
    return this.#sessionRuntime.listWorkspaceSessions(workspaceId, pageSize, cursor);
  }

  async listSessionMessages(
    sessionId: string,
    pageSize = 100,
    cursor?: string,
    direction: MessagePageDirection = "forward"
  ): Promise<MessageListResult> {
    return this.#sessionRuntime.listSessionMessages(sessionId, pageSize, cursor, direction);
  }

  async listSessionEngineMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<EngineMessageListResult> {
    return this.#sessionRuntime.listSessionEngineMessages(sessionId, pageSize, cursor);
  }

  async listSessionTranscriptMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    return this.#sessionRuntime.listSessionTranscriptMessages(sessionId, pageSize, cursor);
  }

  async listSessionRuns(sessionId: string, pageSize = 100, cursor?: string): Promise<RunListResult> {
    return this.#sessionRuntime.listSessionRuns(sessionId, pageSize, cursor);
  }

  async listSessionQueuedRuns(sessionId: string): Promise<import("./types.js").SessionQueuedRunListResult> {
    return this.#sessionRuntime.listSessionQueuedRuns(sessionId);
  }

  async compactSession({ sessionId, caller, input }: CompactSessionParams): Promise<SessionCompactResult> {
    const session = await this.getSession(sessionId);
    const workspace = await this.getWorkspaceRecord(session.workspaceId);
    const instructions = input?.instructions?.trim() || undefined;
    const [runs, pendingRuns] = await Promise.all([
      this.#runRepository.listBySessionId(sessionId),
      this.#sessionPendingRunQueueRepository.listBySessionId(sessionId)
    ]);
    const pendingRunIds = new Set(pendingRuns.map((entry) => entry.runId));
    const hasActiveRun = runs.some(
      (run) =>
        (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") &&
        !pendingRunIds.has(run.id) &&
        !run.cancelRequestedAt
    );
    if (hasActiveRun || pendingRuns.length > 0) {
      throw new AppError(
        409,
        "session_busy",
        `Session ${sessionId} has active or queued runs and cannot be compacted manually.`
      );
    }

    const startedAt = nowIso();
    const run: Run = {
      id: createId("run"),
      workspaceId: workspace.id,
      sessionId: session.id,
      initiatorRef: caller.subjectRef,
      triggerType: "system",
      triggerRef: "compact",
      agentName: session.activeAgentName,
      effectiveAgentName: session.activeAgentName,
      switchCount: 0,
      status: "running",
      createdAt: startedAt,
      startedAt,
      heartbeatAt: startedAt,
      ...(instructions
        ? {
            metadata: {
              instructions
            }
          }
        : {})
    };

    await this.#runRepository.create(run);
    await this.#runSteps.recordSystemStep(run, "run.started", {
      status: run.status
    });
    await this.#engineLifecycle.appendEvent({
      sessionId: session.id,
      runId: run.id,
      event: "run.started",
      data: {
        runId: run.id,
        sessionId: session.id,
        status: run.status
      }
    });

    try {
      const messages = await this.#messageRepository.listBySessionId(session.id);
      const engineMessages = await this.#engineMessageSync.buildEngineMessagesForSession(session.id, messages);
      const compacted = await this.#contextCompaction.compactSessionContext({
        workspace,
        session,
        run,
        activeAgentName: session.activeAgentName,
        messages,
        engineMessages,
        instructions
      });
      if (!compacted.compacted) {
        await this.#runSteps.recordSystemStep(run, "context_compact_skipped", {
          ...(instructions ? { instructions } : {}),
          ...(compacted.reason ? { reason: compacted.reason } : {})
        });
      }

      const completedAt = nowIso();
      const completedRun = await this.#runState.setRunStatus(run, "completed", {
        endedAt: completedAt,
        heartbeatAt: completedAt
      });
      await this.#runSteps.recordSystemStep(completedRun, "run.completed", {
        status: completedRun.status
      });
      await this.#sessionRepository.update({
        ...session,
        lastRunAt: completedAt,
        updatedAt: completedAt
      });
      await this.#engineLifecycle.appendEvent({
        sessionId: session.id,
        runId: completedRun.id,
        event: "run.completed",
        data: {
          runId: completedRun.id,
          sessionId: session.id,
          status: completedRun.status
        }
      });

      return {
        runId: completedRun.id,
        status: "completed",
        compacted: compacted.compacted,
        ...(compacted.reason ? { reason: compacted.reason } : {}),
        ...(compacted.boundaryMessageId ? { boundaryMessageId: compacted.boundaryMessageId } : {}),
        ...(compacted.summaryMessageId ? { summaryMessageId: compacted.summaryMessageId } : {}),
        ...(typeof compacted.summarizedMessageCount === "number"
          ? { summarizedMessageCount: compacted.summarizedMessageCount }
          : {}),
        createdAt: startedAt,
        completedAt
      };
    } catch (error) {
      const failedAt = nowIso();
      const latestRun = await this.getRun(run.id).catch(() => run);
      const failedRun =
        latestRun.status === "failed"
          ? latestRun
          : await this.#runState.setRunStatus(latestRun, "failed", {
              endedAt: failedAt,
              heartbeatAt: failedAt,
              errorCode: error instanceof AppError ? error.code : "session_compact_failed",
              errorMessage: error instanceof Error ? error.message : String(error)
            });
      await this.#runSteps.recordSystemStep(failedRun, "run.failed", {
        status: failedRun.status,
        ...(failedRun.errorCode ? { errorCode: failedRun.errorCode } : {}),
        ...(failedRun.errorMessage ? { errorMessage: failedRun.errorMessage } : {})
      });
      await this.#engineLifecycle.appendEvent({
        sessionId: session.id,
        runId: failedRun.id,
        event: "run.failed",
        data: {
          runId: failedRun.id,
          sessionId: session.id,
          status: failedRun.status,
          errorCode: failedRun.errorCode ?? (error instanceof AppError ? error.code : "session_compact_failed"),
          errorMessage: failedRun.errorMessage ?? (error instanceof Error ? error.message : String(error))
        }
      });
      throw error;
    }
  }

  async listRunSteps(runId: string, pageSize = 100, cursor?: string): Promise<RunStepListResult> {
    return this.#sessionRuntime.listRunSteps(runId, pageSize, cursor);
  }

  async createSessionMessage({ sessionId, caller, input }: CreateSessionMessageParams): Promise<MessageAcceptedResult> {
    return this.#sessionRuntime.createSessionMessage({ sessionId, caller, input });
  }

  async triggerActionRun({
    workspaceId,
    caller,
    actionName,
    sessionId,
    agentName,
    input,
    triggerSource
  }: TriggerActionRunParams): Promise<ActionRunAcceptedResult> {
    return this.#sessionRuntime.triggerActionRun({
      workspaceId,
      caller,
      actionName,
      sessionId,
      agentName,
      input,
      triggerSource
    });
  }

  async getRun(runId: string): Promise<Run> {
    const run = await this.#runRepository.getById(runId);
    if (!run) {
      throw new AppError(404, "run_not_found", `Run ${runId} was not found.`);
    }

    return run;
  }

  async cancelRun(runId: string): Promise<CancelRunResult> {
    await this.#requestRunCancellation(runId);

    return {
      runId,
      status: "cancellation_requested"
    };
  }

  async #requestRunCancellation(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting_tool") {
      return;
    }

    const updated = await this.#runState.updateRun(run, {
      cancelRequestedAt: run.cancelRequestedAt ?? nowIso()
    });

    if (updated.status === "running" || updated.status === "waiting_tool") {
      this.#runAbortControllers.get(runId)?.abort("interrupt");
    }
  }

  async requeueRun(runId: string, requestedBy?: string): Promise<RequeueRunResult> {
    return this.#runRecovery.requeueRun(runId, requestedBy);
  }

  async guideQueuedRun(runId: string): Promise<import("./types.js").GuideQueuedRunResult> {
    return this.#sessionRuntime.guideQueuedRun(runId);
  }

  async recoverRunAfterDrainTimeout(
    runId: string,
    strategy: AutomaticRecoveryStrategy
  ): Promise<"failed" | "requeued" | "ignored"> {
    return this.#runRecovery.recoverRunAfterDrainTimeout(runId, strategy);
  }

  async listSessionEvents(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    await this.getSession(sessionId);
    return this.#sessionEventStore.listSince(sessionId, cursor, runId);
  }

  subscribeSessionEvents(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    return this.#sessionEventStore.subscribe(sessionId, listener);
  }

  async processQueuedRun(runId: string): Promise<void> {
    await this.#runProcessor.processRun(runId);
  }

  async recoverStaleRuns(options?: {
    staleBefore?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ recoveredRunIds: string[]; requeuedRunIds: string[] }> {
    return this.#runRecovery.recoverStaleRuns(options);
  }

  #buildEngineTools(
    workspace: WorkspaceRecord,
    run: Run,
    session: Session,
    executionContext: RunExecutionContext
  ): EngineToolSet {
    return createWorkspaceEngineTools({
      workspace,
      run,
      session,
      getCurrentAgentName: () => executionContext.currentAgentName,
      modelGateway: this.#modelGateway,
      defaultModel: this.#defaultModel,
      commandExecutor: this.#workspaceCommandExecutor,
      executeAction: async (action, input, context) =>
        this.#executeAction(workspace, action, run, context.abortSignal, input),
      delegateAgent: async ({ targetAgentName, task, handoffSummary, taskId, notifyParentOnCompletion }, currentAgentName) => {
        const accepted = await this.#ensureExecutionServices().agentCoordination.delegateAgentRun({
          workspace,
          parentSession: session,
          parentRun: run,
          currentAgentName,
          targetAgentName,
          task,
          handoffSummary,
          taskId,
          notifyParentOnCompletion
        });
        executionContext.delegatedRunIds.push(accepted.childRunId);
        return accepted;
      },
      awaitDelegatedRuns: async ({ runIds, mode }) => this.#ensureExecutionServices().agentCoordination.awaitDelegatedRuns(runIds, mode),
      switchAgent: async (targetAgentName, currentAgentName) => {
        await this.#ensureExecutionServices().agentCoordination.switchAgent({
          session,
          run,
          currentAgentName,
          targetAgentName
        });
        executionContext.currentAgentName = targetAgentName;
        executionContext.injectSystemReminder = true;
      }
    });
  }

  async #applyBeforeModelHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: ModelExecutionInput
  ): Promise<ModelExecutionInput> {
    return this.#ensureExecutionServices().hookApplications.applyBeforeModelHooks(workspace, session, run, modelInput);
  }

  async #applyAfterModelHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: ModelExecutionInput,
    response: ModelGenerateResponse
  ): Promise<ModelGenerateResponse> {
    return this.#ensureExecutionServices().hookApplications.applyAfterModelHooks(workspace, session, run, modelInput, response);
  }

  async #applyContextHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_build" | "after_context_build",
    messages: ChatMessage[]
  ): Promise<ChatMessage[]> {
    return this.#ensureExecutionServices().hookApplications.applyContextHooks(workspace, session, run, eventName, messages);
  }

  async #applyCompactionHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_compact" | "after_context_compact",
    context: Record<string, unknown> & {
      messages?: ChatMessage[] | undefined;
    }
  ): Promise<
    Record<string, unknown> & {
      messages?: ChatMessage[] | undefined;
    }
  > {
    return this.#ensureExecutionServices().hookApplications.applyCompactionHooks(
      workspace,
      session,
      run,
      eventName,
      context
    );
  }

  async #executeAction(
    workspace: WorkspaceRecord,
    action: WorkspaceRecord["actions"][string],
    run: Run,
    signal: AbortSignal | undefined,
    explicitInput?: unknown
  ): Promise<{ stdout: string; stderr: string; exitCode: number; output: string }> {
    return this.#ensureExecutionServices().actions.executeAction(workspace, action, run, signal, explicitInput);
  }
}
