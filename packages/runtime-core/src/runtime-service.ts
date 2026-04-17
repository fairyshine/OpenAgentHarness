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
} from "./runtime/model-input.js";
import {
  collapseLeadingSystemMessages,
  extractFailedToolResults,
  previewValue,
  serializeModelCallStepInput,
  serializeModelCallStepOutput,
  summarizeMessageRoles
} from "./runtime/model-call-serialization.js";
import { RunStateService } from "./runtime/run-state.js";
import { SessionHistoryService } from "./runtime/session-history.js";
import { RunStepService } from "./runtime/run-steps.js";
import { RunRecoveryService } from "./runtime/run-recovery.js";
import { RunProcessorService } from "./runtime/run-processor.js";
import { RuntimeMessageSyncService } from "./runtime/runtime-message-sync.js";
import { SessionRuntimeService } from "./runtime/session-runtime.js";
import { createRuntimeExecutionServices, type RuntimeExecutionServices } from "./runtime/execution-services.js";
import { buildGeneratedMessageMetadata, normalizeJsonObject } from "./runtime/execution-support.js";
import { ModelRunExecutor } from "./runtime/model-run-executor.js";
import { WorkspaceRuntimeService } from "./runtime/workspace-runtime.js";
import {
  doesSessionEventAffectRuntimeMessages
} from "./runtime/runtime-messages.js";
import {
  RuntimeMessageProjector
} from "./runtime/message-projections.js";
import {
  type SortOrder,
  type WorkspaceDeleteResult,
  type WorkspaceEntry,
  type WorkspaceEntryPage,
  type WorkspaceEntrySortBy,
  type WorkspaceFileContentResult,
  type WorkspaceFileDownloadResult,
  WorkspaceFileService
} from "./workspace-files.js";
import {
  buildRuntimeTools as createWorkspaceRuntimeTools,
} from "./runtime-tooling.js";
import {
  type ActionRunAcceptedResult,
  type CancelRunResult,
  type RequeueRunResult,
  type CreateSessionMessageParams,
  type CreateSessionParams,
  type UpdateSessionParams,
  type CreateWorkspaceParams,
  type MessageListResult,
  type RuntimeMessageListResult,
  type RuntimeServiceOptions,
  type SessionEvent,
  type RuntimeToolSet,
  type TriggerActionRunParams,
  type ModelDefinition,
  type WorkspaceCommandExecutor,
  type WorkspaceFileSystem,
  type RunStepListResult,
  type SessionListResult,
  type RunQueuePriority,
  type WorkspaceListResult,
  type RunListResult,
  type WorkspaceActivityTracker,
  type WorkspaceRecord
} from "./types.js";
import { createId, nowIso } from "./utils.js";
import { createLocalWorkspaceCommandExecutor } from "./workspace-command-executor.js";
import { createLocalWorkspaceFileSystem } from "./workspace-file-system.js";
import {
  type AutomaticRecoveryStrategy,
  type RunExecutionContext
} from "./runtime/internal-helpers.js";

export class RuntimeService {
  readonly #defaultModel: string;
  readonly #modelGateway: RuntimeServiceOptions["modelGateway"];
  readonly #logger: RuntimeServiceOptions["logger"];
  readonly #workspaceActivityTracker: WorkspaceActivityTracker | undefined;
  readonly #executionServicesMode: NonNullable<RuntimeServiceOptions["executionServicesMode"]>;
  readonly #runHeartbeatIntervalMs: number;
  readonly #staleRunRecoveryStrategy: "fail" | "requeue_running" | "requeue_all";
  readonly #staleRunRecoveryMaxAttempts: number;
  readonly #platformModels: Record<string, ModelDefinition>;
  readonly #workspaceRepository: RuntimeServiceOptions["workspaceRepository"];
  readonly #sessionRepository: RuntimeServiceOptions["sessionRepository"];
  readonly #messageRepository: RuntimeServiceOptions["messageRepository"];
  readonly #runRepository: RuntimeServiceOptions["runRepository"];
  readonly #runStepRepository: RuntimeServiceOptions["runStepRepository"];
  readonly #sessionEventStore: RuntimeServiceOptions["sessionEventStore"];
  readonly #runQueue: RuntimeServiceOptions["runQueue"];
  readonly #toolCallAuditRepository: RuntimeServiceOptions["toolCallAuditRepository"];
  readonly #workspaceArchiveRepository: RuntimeServiceOptions["workspaceArchiveRepository"];
  readonly #workspaceDeletionHandler: RuntimeServiceOptions["workspaceDeletionHandler"];
  readonly #workspaceInitializer: RuntimeServiceOptions["workspaceInitializer"];
  readonly #workspaceExecutionProvider: RuntimeServiceOptions["workspaceExecutionProvider"];
  readonly #workspaceFileAccessProvider: RuntimeServiceOptions["workspaceFileAccessProvider"];
  readonly #hookRunAuditRepository: RuntimeServiceOptions["hookRunAuditRepository"];
  readonly #workspaceFileSystem: WorkspaceFileSystem;
  readonly #workspaceCommandExecutor: WorkspaceCommandExecutor;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #sessionHistory: SessionHistoryService;
  readonly #runSteps: RunStepService;
  readonly #runState: RunStateService;
  readonly #workspaceRuntime: WorkspaceRuntimeService;
  readonly #sessionRuntime: SessionRuntimeService;
  readonly #runRecovery: RunRecoveryService;
  readonly #modelRunExecutor: ModelRunExecutor;
  readonly #runProcessor: RunProcessorService;
  readonly #runtimeMessageSync: RuntimeMessageSyncService;
  readonly #modelInputs: ModelInputService;
  readonly #runtimeMessageProjector: RuntimeMessageProjector;
  #executionServices: RuntimeExecutionServices | undefined;
  readonly #sessionChains = new Map<string, Promise<void>>();
  readonly #runAbortControllers = new Map<string, AbortController>();
  readonly #drainTimeoutRecoveredRuns = new Set<string>();

  constructor(options: RuntimeServiceOptions) {
    this.#defaultModel = options.defaultModel;
    this.#modelGateway = options.modelGateway;
    this.#logger = options.logger;
    this.#workspaceActivityTracker = options.workspaceActivityTracker;
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
      appendEvent: (input) => this.#appendEvent(input),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      nowIso
    });
    this.#workspaceRuntime = new WorkspaceRuntimeService({
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
      appendEvent: (input) => this.#appendEvent(input),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      enqueueRun: (sessionId, runId) => this.#enqueueRun(sessionId, runId),
      runAbortControllers: this.#runAbortControllers,
      drainTimeoutRecoveredRuns: this.#drainTimeoutRecoveredRuns,
      runHeartbeatIntervalMs: this.#runHeartbeatIntervalMs,
      staleRunRecoveryStrategy: this.#staleRunRecoveryStrategy,
      staleRunRecoveryMaxAttempts: this.#staleRunRecoveryMaxAttempts
    });
    this.#runtimeMessageSync = new RuntimeMessageSyncService({
      messageRepository: this.#messageRepository,
      sessionEventStore: this.#sessionEventStore,
      ...(options.runtimeMessageRepository ? { runtimeMessageRepository: options.runtimeMessageRepository } : {})
    });
    this.#runProcessor = new RunProcessorService({
      logger: this.#logger,
      modelGateway: this.#modelGateway,
      messageRepository: this.#messageRepository,
      ...(this.#workspaceExecutionProvider ? { workspaceExecutionProvider: this.#workspaceExecutionProvider } : {}),
      runtimeMessageSync: this.#runtimeMessageSync,
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
      appendEvent: (input) => this.#appendEvent(input),
      repairSessionHistoryIfNeeded: (sessionId, messages) => this.#sessionHistory.repairSessionHistoryIfNeeded(sessionId, messages),
      buildModelInput: (workspace, session, run, runtimeMessages, activeAgentName, forceSystemReminder) =>
        this.#modelInputs.buildModelInput(workspace, session, run, runtimeMessages, activeAgentName, forceSystemReminder),
      applyBeforeModelHooks: (workspace, session, run, modelInput) =>
        this.#applyBeforeModelHooks(workspace, session, run, modelInput),
      applyAfterModelHooks: (workspace, session, run, modelInput, response) =>
        this.#applyAfterModelHooks(workspace, session, run, modelInput, response),
      buildRuntimeTools: (workspace, run, session, executionContext) =>
        this.#buildRuntimeTools(workspace, run, session, executionContext),
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
      serializeModelCallStepInput: (modelInput, activeToolNames, toolServers, runtimeToolNames, runtimeTools) =>
        serializeModelCallStepInput(modelInput, activeToolNames, toolServers, runtimeToolNames, runtimeTools),
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
        }),
      processActionRun: (workspace, run, session, signal) =>
        this.#ensureExecutionServices().actions.processActionRun(workspace, run, session, signal)
    });
    this.#modelInputs = new ModelInputService({
      defaultModel: this.#defaultModel,
      platformModels: this.#platformModels,
      applyContextHooks: (workspace, session, run, eventName, messages) =>
        this.#applyContextHooks(workspace, session, run, eventName, messages),
      collapseLeadingSystemMessages: (messages) => collapseLeadingSystemMessages(messages)
    });
    this.#runtimeMessageProjector = new RuntimeMessageProjector();
    this.#sessionRuntime = new SessionRuntimeService({
      sessionRepository: this.#sessionRepository,
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      runStepRepository: this.#runStepRepository,
      workspaceArchiveRepository: this.#workspaceArchiveRepository,
      modelInputs: this.#modelInputs,
      runtimeMessageSync: this.#runtimeMessageSync,
      runtimeMessageProjector: this.#runtimeMessageProjector,
      getWorkspaceRecord: (workspaceId) => this.#workspaceRuntime.getWorkspaceRecord(workspaceId),
      getRun: (runId) => this.getRun(runId),
      appendEvent: (input) => this.#appendEvent(input),
      enqueueRun: (sessionId, runId) => this.#enqueueRun(sessionId, runId)
    });
    if (this.#executionServicesMode === "eager") {
      this.#executionServices = this.#createExecutionServices();
    }
  }

  #createExecutionServices(): RuntimeExecutionServices {
    return createRuntimeExecutionServices({
      defaultModel: this.#defaultModel,
      modelGateway: this.#modelGateway,
      logger: this.#logger,
      workspaceCommandExecutor: this.#workspaceCommandExecutor,
      workspaceFileSystem: this.#workspaceFileSystem,
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
      appendEvent: (input) => this.#appendEvent(input),
      getRun: (runId) => this.getRun(runId),
      enqueueRun: (sessionId, runId, options) => this.#enqueueRun(sessionId, runId, options)
    });
  }

  #ensureExecutionServices(): RuntimeExecutionServices {
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
    input: { path: string; data: Buffer; overwrite?: boolean | undefined; ifMatch?: string | undefined }
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

  async listSessionMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    return this.#sessionRuntime.listSessionMessages(sessionId, pageSize, cursor);
  }

  async listSessionRuntimeMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<RuntimeMessageListResult> {
    return this.#sessionRuntime.listSessionRuntimeMessages(sessionId, pageSize, cursor);
  }

  async listSessionTranscriptMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    return this.#sessionRuntime.listSessionTranscriptMessages(sessionId, pageSize, cursor);
  }

  async listSessionRuns(sessionId: string, pageSize = 100, cursor?: string): Promise<RunListResult> {
    return this.#sessionRuntime.listSessionRuns(sessionId, pageSize, cursor);
  }

  async listRunSteps(runId: string, pageSize = 100, cursor?: string): Promise<RunStepListResult> {
    return this.#sessionRuntime.listRunSteps(runId, pageSize, cursor);
  }

  async createSessionMessage({ sessionId, caller, input }: CreateSessionMessageParams): Promise<{
    messageId: string;
    runId: string;
    status: "queued";
  }> {
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
    const run = await this.getRun(runId);
    if (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") {
      const updated = await this.#runState.updateRun(run, {
        cancelRequestedAt: run.cancelRequestedAt ?? nowIso()
      });

      if (updated.status === "running" || updated.status === "waiting_tool") {
        this.#runAbortControllers.get(runId)?.abort();
      }
    }

    return {
      runId,
      status: "cancellation_requested"
    };
  }

  async requeueRun(runId: string, requestedBy?: string): Promise<RequeueRunResult> {
    return this.#runRecovery.requeueRun(runId, requestedBy);
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

  async #appendEvent(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.#sessionEventStore.append(input);
    await this.#touchWorkspaceActivityForEvent(input);
    if (doesSessionEventAffectRuntimeMessages(event)) {
      await this.#runtimeMessageSync.scheduleRuntimeMessageSync(input.sessionId);
    }
    return event;
  }

  async #touchWorkspaceActivity(workspaceId: string): Promise<void> {
    await this.#workspaceActivityTracker?.touchWorkspace(workspaceId);
  }

  async #touchWorkspaceActivityForEvent(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<void> {
    if (
      input.event !== "run.queued" &&
      input.event !== "run.started" &&
      input.event !== "run.completed" &&
      input.event !== "run.failed" &&
      input.event !== "run.cancelled"
    ) {
      return;
    }

    if (input.runId) {
      const run = await this.#runRepository.getById(input.runId);
      if (run) {
        await this.#touchWorkspaceActivity(run.workspaceId);
        return;
      }
    }

    const session = await this.#sessionRepository.getById(input.sessionId);
    if (session) {
      await this.#touchWorkspaceActivity(session.workspaceId);
    }
  }

  async #enqueueRun(
    sessionId: string,
    runId: string,
    options?: { priority?: RunQueuePriority | undefined }
  ): Promise<void> {
    if (this.#runQueue) {
      await this.#runQueue.enqueue(sessionId, runId, options);
      return;
    }

    const previous = this.#sessionChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.#runProcessor.processRun(runId);
      })
      .finally(() => {
        if (this.#sessionChains.get(sessionId) === next) {
          this.#sessionChains.delete(sessionId);
        }
      });

    this.#sessionChains.set(sessionId, next);
  }

  #buildRuntimeTools(
    workspace: WorkspaceRecord,
    run: Run,
    session: Session,
    executionContext: RunExecutionContext
  ): RuntimeToolSet {
    return createWorkspaceRuntimeTools({
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
