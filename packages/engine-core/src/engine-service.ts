import type {
  ChatMessage,
  Message,
  ModelGenerateResponse,
  Run,
  Session,
  WorkspaceCatalog
} from "@oah/api-contracts";
import type {
  WorkspaceMemoryApplyProposalRequest,
  WorkspaceMemoryIndex,
  WorkspaceMemoryProposalActionResult,
  WorkspaceMemoryProposalPage,
  WorkspaceMemoryReadQuery,
  WorkspaceMemoryReadResponse,
  WorkspaceMemoryRejectProposalRequest,
  WorkspaceMemorySearchQuery,
  WorkspaceMemorySearchResponse,
  WorkspaceMemoryStatus
} from "@oah/api-contracts";

import { AppError } from "./errors.js";
import type { ModelExecutionInput } from "./engine/model-input.js";
import { RunStateService } from "./engine/run-state.js";
import { SessionHistoryService } from "./engine/session-history.js";
import { RunStepService } from "./engine/run-steps.js";
import { WorkspaceEngineService } from "./engine/workspace-engine.js";
import { ModelResolverService } from "./engine/model-resolver.js";
import { buildSessionRecord } from "./engine/session-creation.js";
import { SessionMessageCreationService } from "./engine/session-message-creation.js";
import { SessionRecordService } from "./engine/session-records.js";
import type {
  CreateEngineExecutionServicesDependencies,
  EngineExecutionServices
} from "./engine/execution-services.js";
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
  type ActionRunAcceptedResult,
  type CancelRunResult,
  type CompactSessionParams,
  type RequeueRunResult,
  type MessageContextResult,
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
  type SessionTerminalInputResult,
  type SessionTerminalSnapshotResult,
  type WorkspaceListResult,
  type RunListResult,
  type WorkspaceRecord,
  type SessionCurrentStateRecord
} from "./types.js";
import { createId, nowIso } from "./utils.js";
import { createLocalWorkspaceCommandExecutor } from "./workspace/workspace-command-executor.js";
import { createLocalWorkspaceFileSystem } from "./workspace/workspace-file-system.js";
import { visibleNativeToolNames } from "./capabilities/engine-capabilities.js";
import {
  type AutomaticRecoveryStrategy,
  type RunExecutionContext
} from "./engine/internal-helpers.js";
import type { EngineRuntimeKernel } from "./engine-runtime-kernel.js";

export class EngineService {
  readonly #defaultModel: string;
  readonly #modelGateway: EngineServiceOptions["modelGateway"];
  readonly #logger: EngineServiceOptions["logger"];
  readonly #executionServicesMode: NonNullable<EngineServiceOptions["executionServicesMode"]>;
  readonly #runHeartbeatIntervalMs: number;
  readonly #staleRunTimeoutMs: number;
  readonly #staleRunRecoveryStrategy: "fail" | "requeue_running" | "requeue_all";
  readonly #staleRunRecoveryMaxAttempts: number;
  readonly #platformModels: Record<string, ModelDefinition>;
  readonly #workspaceRepository: EngineServiceOptions["workspaceRepository"];
  readonly #sessionRepository: EngineServiceOptions["sessionRepository"];
  readonly #messageRepository: EngineServiceOptions["messageRepository"];
  readonly #runRepository: EngineServiceOptions["runRepository"];
  readonly #runStepRepository: EngineServiceOptions["runStepRepository"];
  readonly #sessionEventStore: EngineServiceOptions["sessionEventStore"];
  readonly #sessionCurrentStateRepository: EngineServiceOptions["sessionCurrentStateRepository"];
  readonly #sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  readonly #runQueue: EngineServiceOptions["runQueue"];
  readonly #engineMessageRepository: EngineServiceOptions["engineMessageRepository"];
  readonly #toolCallAuditRepository: EngineServiceOptions["toolCallAuditRepository"];
  readonly #agentTaskRepository: EngineServiceOptions["agentTaskRepository"];
  readonly #agentTaskNotificationRepository: EngineServiceOptions["agentTaskNotificationRepository"];
  readonly #workspaceArchiveRepository: EngineServiceOptions["workspaceArchiveRepository"];
  readonly #workspaceDeletionHandler: EngineServiceOptions["workspaceDeletionHandler"];
  readonly #workspaceInitializer: EngineServiceOptions["workspaceInitializer"];
  readonly #workspaceExecutionProvider: EngineServiceOptions["workspaceExecutionProvider"];
  readonly #workspaceFileAccessProvider: EngineServiceOptions["workspaceFileAccessProvider"];
  readonly #workspaceActivityTracker: EngineServiceOptions["workspaceActivityTracker"];
  readonly #hookRunAuditRepository: EngineServiceOptions["hookRunAuditRepository"];
  readonly #workspaceFileSystem: WorkspaceFileSystem;
  readonly #workspaceCommandExecutor: WorkspaceCommandExecutor;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #sessionHistory: SessionHistoryService;
  readonly #runSteps: RunStepService;
  readonly #runState: RunStateService;
  readonly #workspaceRuntime: WorkspaceEngineService;
  readonly #sessionModelResolver: ModelResolverService;
  readonly #sessionRecords: SessionRecordService;
  readonly #sessionMessageCreation: SessionMessageCreationService;
  #runtimeKernelModule:
    | (typeof import("./engine-runtime-kernel.js"))
    | undefined;
  #runtimeKernelModulePromise:
    | Promise<typeof import("./engine-runtime-kernel.js")>
    | undefined;
  #runtimeKernel: EngineRuntimeKernel | undefined;
  #runtimeKernelPromise: Promise<EngineRuntimeKernel> | undefined;
  #executionServices: EngineExecutionServices | undefined;
  readonly #runAbortControllers = new Map<string, AbortController>();
  readonly #drainTimeoutRecoveredRuns = new Set<string>();

  constructor(options: EngineServiceOptions) {
    this.#defaultModel = options.defaultModel;
    this.#modelGateway = options.modelGateway;
    this.#logger = options.logger;
    this.#executionServicesMode = options.executionServicesMode ?? "eager";
    this.#runHeartbeatIntervalMs = Math.max(50, options.runHeartbeatIntervalMs ?? 5_000);
    this.#staleRunTimeoutMs = Math.max(this.#runHeartbeatIntervalMs, options.staleRunTimeoutMs ?? this.#runHeartbeatIntervalMs * 3);
    this.#staleRunRecoveryStrategy = options.staleRunRecovery?.strategy ?? "fail";
    this.#staleRunRecoveryMaxAttempts = Math.max(1, Math.floor(options.staleRunRecovery?.maxAttempts ?? 1));
    this.#platformModels = options.platformModels ?? {};
    this.#workspaceRepository = options.workspaceRepository;
    this.#sessionRepository = options.sessionRepository;
    this.#messageRepository = options.messageRepository;
    this.#runRepository = options.runRepository;
    this.#runStepRepository = options.runStepRepository;
    this.#sessionEventStore = options.sessionEventStore;
    this.#sessionCurrentStateRepository = options.sessionCurrentStateRepository;
    this.#sessionPendingRunQueueRepository = options.sessionPendingRunQueueRepository;
    this.#runQueue = options.runQueue;
    this.#engineMessageRepository = options.engineMessageRepository;
    this.#toolCallAuditRepository = options.toolCallAuditRepository;
    this.#agentTaskRepository = options.agentTaskRepository;
    this.#agentTaskNotificationRepository = options.agentTaskNotificationRepository;
    this.#workspaceArchiveRepository = options.workspaceArchiveRepository;
    this.#workspaceDeletionHandler = options.workspaceDeletionHandler;
    this.#workspaceInitializer = options.workspaceInitializer;
    this.#workspaceExecutionProvider = options.workspaceExecutionProvider;
    this.#workspaceFileAccessProvider = options.workspaceFileAccessProvider;
    this.#workspaceActivityTracker = options.workspaceActivityTracker;
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
      appendEvent: async (input) => (await this.#ensureRuntimeKernel()).engineLifecycle.appendEvent(input),
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
    this.#sessionModelResolver = new ModelResolverService({
      defaultModel: this.#defaultModel,
      platformModels: this.#platformModels
    });
    this.#sessionRecords = new SessionRecordService({
      sessionRepository: this.#sessionRepository,
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      runStepRepository: this.#runStepRepository,
      sessionPendingRunQueueRepository: this.#sessionPendingRunQueueRepository,
      workspaceArchiveRepository: this.#workspaceArchiveRepository,
      getWorkspaceRecord: (workspaceId) => this.#workspaceRuntime.getWorkspaceRecord(workspaceId),
      normalizeModelRef: (workspace, modelRef) => this.#sessionModelResolver.normalizeSessionModelRef(workspace, modelRef)
    });
    this.#sessionMessageCreation = new SessionMessageCreationService({
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      sessionPendingRunQueueRepository: this.#sessionPendingRunQueueRepository,
      sessionRecords: this.#sessionRecords,
      appendEvent: (input) => this.#appendSessionEvent(input),
      enqueueRun: (sessionId, runId) => this.#enqueueRunForExecution(sessionId, runId),
      requestRunCancellation: (runId) => this.#requestRunCancellation(runId)
    });
    if (this.#executionServicesMode === "eager") {
      this.#warmExecutionRuntime();
    }
  }

  #warmExecutionRuntime(): void {
    void this.#ensureRuntimeKernel().then((runtimeKernel) => {
      this.#executionServices ??= this.#createExecutionServices(runtimeKernel);
    });
  }

  async #appendSessionEvent(input: {
    sessionId: string;
    runId: string;
    event: "run.queued" | "queue.updated";
    data: Record<string, unknown>;
  }): Promise<SessionEvent> {
    const event = await this.#sessionEventStore.append(input);
    if (input.event === "run.queued") {
      await this.#touchWorkspaceActivityForRunEvent(input.runId, input.sessionId);
    }
    if (input.event === "run.queued" || input.event === "queue.updated") {
      void this.#ensureRuntimeKernel()
        .then((runtimeKernel) => runtimeKernel.engineMessageSync.scheduleEngineMessageSync(input.sessionId))
        .catch((error: unknown) => {
          this.#logger?.warn?.("Failed to schedule engine message sync after session event.", {
            sessionId: input.sessionId,
            event: input.event,
            errorMessage: error instanceof Error ? error.message : String(error)
          });
        });
    }
    return event;
  }

  async #touchWorkspaceActivityForRunEvent(runId: string, sessionId: string): Promise<void> {
    if (!this.#workspaceActivityTracker) {
      return;
    }

    const run = await this.#runRepository.getById(runId);
    if (run) {
      await this.#workspaceActivityTracker.touchWorkspace(run.workspaceId);
      return;
    }

    const session = await this.#sessionRepository.getById(sessionId);
    if (session) {
      await this.#workspaceActivityTracker.touchWorkspace(session.workspaceId);
    }
  }

  async #enqueueRunForExecution(_sessionId: string, runId: string): Promise<void> {
    if (this.#runQueue) {
      const run = await this.getRun(runId);
      await this.#runQueue.enqueue(run.sessionId ?? _sessionId, runId);
      return;
    }

    void this.#ensureRuntimeKernel()
      .then((runtimeKernel) => runtimeKernel.runProcessor.processRun(runId))
      .catch((error: unknown) => {
        this.#logger?.error?.("Failed to process queued run.", {
          runId,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async #loadRuntimeKernelModule(): Promise<typeof import("./engine-runtime-kernel.js")> {
    this.#runtimeKernelModulePromise ??= import("./engine-runtime-kernel.js").then((module) => {
      this.#runtimeKernelModule = module;
      return module;
    });
    return this.#runtimeKernelModulePromise;
  }

  #getRuntimeKernelModule(): typeof import("./engine-runtime-kernel.js") {
    if (!this.#runtimeKernelModule) {
      throw new Error("Engine runtime kernel module has not been loaded yet.");
    }

    return this.#runtimeKernelModule;
  }

  async #createRuntimeKernel(): Promise<EngineRuntimeKernel> {
    const runtimeKernelModule = await this.#loadRuntimeKernelModule();
    return runtimeKernelModule.createEngineRuntimeKernel({
      defaultModel: this.#defaultModel,
      modelGateway: this.#modelGateway,
      logger: this.#logger,
      runHeartbeatIntervalMs: this.#runHeartbeatIntervalMs,
      staleRunTimeoutMs: this.#staleRunTimeoutMs,
      staleRunRecoveryStrategy: this.#staleRunRecoveryStrategy,
      staleRunRecoveryMaxAttempts: this.#staleRunRecoveryMaxAttempts,
      platformModels: this.#platformModels,
      messageRepository: this.#messageRepository,
      sessionRepository: this.#sessionRepository,
      runRepository: this.#runRepository,
      runStepRepository: this.#runStepRepository,
      sessionEventStore: this.#sessionEventStore,
      sessionPendingRunQueueRepository: this.#sessionPendingRunQueueRepository,
      runQueue: this.#runQueue,
      engineMessageRepository: this.#engineMessageRepository,
      agentTaskRepository: this.#agentTaskRepository,
      agentTaskNotificationRepository: this.#agentTaskNotificationRepository,
      workspaceExecutionProvider: this.#workspaceExecutionProvider,
      workspaceFileAccessProvider: this.#workspaceFileAccessProvider,
      workspaceActivityTracker: this.#workspaceActivityTracker,
      workspaceArchiveRepository: this.#workspaceArchiveRepository,
      workspaceFileSystem: this.#workspaceFileSystem,
      workspaceRuntime: this.#workspaceRuntime,
      runSteps: this.#runSteps,
      runState: this.#runState,
      sessionHistory: this.#sessionHistory,
      createId,
      nowIso,
      runAbortControllers: this.#runAbortControllers,
      drainTimeoutRecoveredRuns: this.#drainTimeoutRecoveredRuns,
      ensureExecutionServices: () => this.#ensureExecutionServices(),
      buildEngineTools: (workspace, run, session, executionContext) =>
        this.#buildEngineTools(workspace, run, session, executionContext),
      applyBeforeModelHooks: (workspace, session, run, modelInput) =>
        this.#applyBeforeModelHooks(workspace, session, run, modelInput),
      applyAfterModelHooks: (workspace, session, run, modelInput, response) =>
        this.#applyAfterModelHooks(workspace, session, run, modelInput, response),
      applyContextHooks: (workspace, session, run, eventName, messages) =>
        this.#applyContextHooks(workspace, session, run, eventName, messages),
      applyCompactionHooks: (workspace, session, run, eventName, context) =>
        this.#applyCompactionHooks(workspace, session, run, eventName, context),
      getRun: (runId) => this.getRun(runId),
      getSession: (sessionId) => this.getSession(sessionId),
      requestRunCancellation: (runId) => this.#requestRunCancellation(runId)
    });
  }

  async #ensureRuntimeKernel(): Promise<EngineRuntimeKernel> {
    this.#runtimeKernelPromise ??= this.#createRuntimeKernel().then((runtimeKernel) => {
      this.#runtimeKernel = runtimeKernel;
      return runtimeKernel;
    });
    return this.#runtimeKernelPromise;
  }

  #buildExecutionServiceDependencies(runtimeKernel: EngineRuntimeKernel): CreateEngineExecutionServicesDependencies {
    return {
      defaultModel: this.#defaultModel,
      modelGateway: this.#modelGateway,
      logger: this.#logger,
      workspaceCommandExecutor: this.#workspaceCommandExecutor,
      workspaceFileSystem: this.#workspaceFileSystem,
      workspaceFileAccessProvider: this.#workspaceFileAccessProvider,
      hookRunAuditRepository: this.#hookRunAuditRepository,
      toolCallAuditRepository: this.#toolCallAuditRepository,
      agentTaskRepository: this.#agentTaskRepository,
      agentTaskNotificationRepository: this.#agentTaskNotificationRepository,
      sessionRepository: this.#sessionRepository,
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      sessionPendingRunQueueRepository: this.#sessionPendingRunQueueRepository,
      runStepRepository: this.#runStepRepository,
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      setRunStatus: (run, nextStatus, patch) => this.#runState.setRunStatus(run, nextStatus, patch),
      setRunStatusIfPossible: (runId, nextStatus) => this.#runState.setRunStatusIfPossible(runId, nextStatus),
      updateRun: (run, patch) => this.#runState.updateRun(run, patch),
      markRunTimedOut: (run, runTimeoutMs) => this.#runState.markRunTimedOut(run, runTimeoutMs),
      markRunCancelled: (sessionId, run) => this.#runState.markRunCancelled(sessionId, run),
      resolveModelForRun: (workspace, modelRef) => runtimeKernel.modelInputs.resolveModelForRun(workspace, modelRef),
      appendEvent: (input) => runtimeKernel.engineLifecycle.appendEvent(input),
      getRun: (runId) => this.getRun(runId),
      enqueueRun: (sessionId, runId, options) => runtimeKernel.engineLifecycle.enqueueRun(sessionId, runId, options),
      dispatchNextQueuedRun: (sessionId) => runtimeKernel.sessionRuntime.dispatchNextQueuedRun(sessionId),
      afterSuccessfulRun: async ({ workspace, session, run }) => {
        await runtimeKernel.workspaceMemory.recordRecallForCompletedRun({ workspace, run });
        await runtimeKernel.workspaceMemory.captureAfterSuccessfulRun({ workspace, session, run });
        runtimeKernel.sessionMemory.scheduleBackgroundUpdate({ workspace, session, run });
        runtimeKernel.workspaceMemory.scheduleBackgroundUpdate({ workspace, session, run });
      }
    };
  }

  #createExecutionServices(runtimeKernel: EngineRuntimeKernel): EngineExecutionServices {
    return this.#getRuntimeKernelModule().createRuntimeExecutionServices(
      this.#buildExecutionServiceDependencies(runtimeKernel)
    );
  }

  #ensureExecutionServices(): EngineExecutionServices {
    if (!this.#executionServices) {
      if (!this.#runtimeKernel) {
        throw new Error("Execution services requested before the runtime kernel was initialized.");
      }
      this.#executionServices = this.#createExecutionServices(this.#runtimeKernel);
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

  async getWorkspaceMemoryStatus(workspaceId: string): Promise<WorkspaceMemoryStatus> {
    return this.#workspaceRuntime.getWorkspaceMemoryStatus(workspaceId);
  }

  async listWorkspaceMemory(workspaceId: string): Promise<WorkspaceMemoryIndex> {
    return this.#workspaceRuntime.listWorkspaceMemory(workspaceId);
  }

  async searchWorkspaceMemory(workspaceId: string, query: WorkspaceMemorySearchQuery): Promise<WorkspaceMemorySearchResponse> {
    return this.#workspaceRuntime.searchWorkspaceMemory(workspaceId, query);
  }

  async readWorkspaceMemory(workspaceId: string, query: WorkspaceMemoryReadQuery): Promise<WorkspaceMemoryReadResponse> {
    return this.#workspaceRuntime.readWorkspaceMemory(workspaceId, query);
  }

  async listWorkspaceMemoryProposals(workspaceId: string): Promise<WorkspaceMemoryProposalPage> {
    return this.#workspaceRuntime.listWorkspaceMemoryProposals(workspaceId);
  }

  async applyWorkspaceMemoryProposal(
    workspaceId: string,
    input: WorkspaceMemoryApplyProposalRequest
  ): Promise<WorkspaceMemoryProposalActionResult> {
    return this.#workspaceRuntime.applyWorkspaceMemoryProposal(workspaceId, input);
  }

  async rejectWorkspaceMemoryProposal(
    workspaceId: string,
    input: WorkspaceMemoryRejectProposalRequest
  ): Promise<WorkspaceMemoryProposalActionResult> {
    return this.#workspaceRuntime.rejectWorkspaceMemoryProposal(workspaceId, input);
  }

  async listWorkspaceEntries(
    workspaceId: string,
    input: {
      path?: string | undefined;
      pageSize: number;
      cursor?: string | undefined;
      sortBy: WorkspaceEntrySortBy;
      sortOrder: SortOrder;
      includeDirectoryDescendantUpdatedAt?: boolean | undefined;
      includeEntryMetadata?: boolean | undefined;
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

  async getSessionTerminalSnapshot(
    sessionId: string,
    terminalId: string,
    input?: {
      maxBytes?: number | undefined;
    }
  ): Promise<SessionTerminalSnapshotResult> {
    const session = await this.getSession(sessionId);
    const task = await this.#workspaceRuntime.getWorkspaceBackgroundTask(session.workspaceId, {
      sessionId,
      taskId: terminalId
    });
    if (!task) {
      throw new AppError(404, "session_terminal_not_found", `Terminal ${terminalId} was not found for session ${sessionId}.`);
    }

    const file = await this.#workspaceRuntime
      .getWorkspaceFileContent(session.workspaceId, {
        path: task.outputPath,
        encoding: "utf8",
        ...(input?.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {})
      })
      .catch((error: unknown) => {
        if (error instanceof AppError && error.code === "workspace_file_not_found") {
          return null;
        }
        throw error;
      });

    return {
      sessionId,
      terminalId: task.taskId,
      status: task.status,
      outputPath: task.outputPath,
      output: file?.content ?? "",
      encoding: "utf8",
      truncated: file?.truncated ?? false,
      ...(typeof task.inputWritable === "boolean" ? { inputWritable: task.inputWritable } : {}),
      ...(task.terminalKind ? { terminalKind: task.terminalKind } : {}),
      ...(typeof task.pid === "number" ? { pid: task.pid } : {}),
      ...(task.description ? { description: task.description } : {}),
      ...(task.command ? { command: task.command } : {}),
      ...(typeof task.exitCode === "number" ? { exitCode: task.exitCode } : {}),
      ...(task.signal ? { signal: task.signal } : {}),
      ...(task.createdAt ? { createdAt: task.createdAt } : {}),
      ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
      ...(task.endedAt ? { endedAt: task.endedAt } : {})
    };
  }

  async writeSessionTerminalInput(
    sessionId: string,
    terminalId: string,
    input: {
      input: string;
      appendNewline?: boolean | undefined;
    }
  ): Promise<SessionTerminalInputResult> {
    const session = await this.getSession(sessionId);
    const task = await this.#workspaceRuntime.writeWorkspaceBackgroundTaskInput(session.workspaceId, {
      sessionId,
      taskId: terminalId,
      inputText: input.input,
      ...(input.appendNewline !== undefined ? { appendNewline: input.appendNewline } : {})
    });
    if (!task) {
      throw new AppError(404, "session_terminal_not_found", `Terminal ${terminalId} was not found for session ${sessionId}.`);
    }
    if (task.status !== "running") {
      throw new AppError(
        409,
        "session_terminal_not_running",
        `Terminal ${terminalId} is not running; current status is ${task.status}.`
      );
    }
    if (task.inputWritable === false) {
      throw new AppError(
        409,
        "session_terminal_input_unavailable",
        `Terminal ${terminalId} is running, but stdin is not available.`
      );
    }

    return {
      sessionId,
      terminalId: task.taskId,
      status: task.status,
      inputWritten: true,
      appendNewline: input.appendNewline ?? true,
      ...(typeof task.inputWritable === "boolean" ? { inputWritable: task.inputWritable } : {}),
      ...(task.updatedAt ? { updatedAt: task.updatedAt } : {})
    };
  }

  async getWorkspaceFileStat(workspaceId: string, targetPath: string) {
    return this.#workspaceRuntime.getWorkspaceFileStat(workspaceId, targetPath);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.#workspaceRuntime.deleteWorkspace(workspaceId);
  }

  async createSession({ workspaceId, caller, input }: CreateSessionParams): Promise<Session> {
    const workspace = await this.#workspaceRuntime.getWorkspaceRecord(workspaceId);
    return this.#sessionRepository.create(
      buildSessionRecord({
        workspace,
        caller,
        sessionInput: input,
        normalizeModelRef: (targetWorkspace, modelRef) =>
          this.#sessionModelResolver.normalizeSessionModelRef(targetWorkspace, modelRef),
        createId,
        nowIso
      })
    );
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.#sessionRecords.getSession(sessionId);
  }

  async getSessionCurrentState(sessionId: string): Promise<SessionCurrentStateRecord> {
    const projected = await this.#sessionCurrentStateRepository?.getBySessionId(sessionId);
    if (projected) {
      return projected;
    }

    const session = await this.getSession(sessionId);
    const [messagePage, runs, queue] = await Promise.all([
      this.listSessionMessages(sessionId, 1, undefined, "backward"),
      this.listSessionRuns(sessionId, 1),
      this.listSessionQueuedRuns(sessionId)
    ]);
    const latestMessage = messagePage.items[0];
    const latestRun = runs.items[0];

    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      activeAgentName: session.activeAgentName,
      ...(session.modelRef ? { modelRef: session.modelRef } : {}),
      ...(latestRun
        ? {
            latestRunId: latestRun.id,
            latestRunStatus: latestRun.status,
            ...(latestRun.startedAt ? { latestRunStartedAt: latestRun.startedAt } : {}),
            ...(latestRun.endedAt ? { latestRunEndedAt: latestRun.endedAt } : {}),
            latestRunCreatedAt: latestRun.createdAt
          }
        : {}),
      ...(latestMessage
        ? {
            latestMessageId: latestMessage.id,
            latestMessageCreatedAt: latestMessage.createdAt
          }
        : {}),
      messageTotalCount: messagePage.totalCount ?? messagePage.items.length,
      queueCount: queue.items.length,
      updatedAt: nowIso()
    };
  }

  async updateSession({ sessionId, input }: UpdateSessionParams): Promise<Session> {
    return this.#sessionRecords.updateSession({ sessionId, input });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#sessionRecords.deleteSession(sessionId);
  }

  async listWorkspaceSessions(workspaceId: string, pageSize: number, cursor?: string): Promise<SessionListResult> {
    return this.#sessionRecords.listWorkspaceSessions(workspaceId, pageSize, cursor);
  }

  async listChildSessions(parentSessionId: string, pageSize = 100, cursor?: string): Promise<SessionListResult> {
    return this.#sessionRecords.listChildSessions(parentSessionId, pageSize, cursor);
  }

  async listSessionMessages(
    sessionId: string,
    pageSize = 100,
    cursor?: string,
    direction: MessagePageDirection = "forward"
  ): Promise<MessageListResult> {
    return this.#sessionRecords.listSessionMessages(sessionId, pageSize, cursor, direction);
  }

  async getSessionMessage(sessionId: string, messageId: string): Promise<Message> {
    return this.#sessionRecords.getSessionMessage(sessionId, messageId);
  }

  async getSessionMessageContext(
    sessionId: string,
    messageId: string,
    before = 20,
    after = 20
  ): Promise<MessageContextResult> {
    return this.#sessionRecords.getSessionMessageContext(sessionId, messageId, before, after);
  }

  async listSessionEngineMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<EngineMessageListResult> {
    return (await this.#ensureRuntimeKernel()).sessionRuntime.listSessionEngineMessages(sessionId, pageSize, cursor);
  }

  async listSessionTranscriptMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    return (await this.#ensureRuntimeKernel()).sessionRuntime.listSessionTranscriptMessages(sessionId, pageSize, cursor);
  }

  async listSessionRuns(sessionId: string, pageSize = 100, cursor?: string): Promise<RunListResult> {
    return this.#sessionRecords.listSessionRuns(sessionId, pageSize, cursor);
  }

  async listSessionQueuedRuns(sessionId: string): Promise<import("./types.js").SessionQueuedRunListResult> {
    return this.#sessionRecords.listSessionQueuedRuns(sessionId);
  }

  async compactSession({ sessionId, caller, input }: CompactSessionParams): Promise<SessionCompactResult> {
    const runtimeKernel = await this.#ensureRuntimeKernel();
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
    await runtimeKernel.engineLifecycle.appendEvent({
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
      const engineMessages = await runtimeKernel.engineMessageSync.buildEngineMessagesForSession(session.id, messages);
      const compacted = await runtimeKernel.contextCompaction.compactSessionContext({
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
      await runtimeKernel.engineLifecycle.appendEvent({
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
      await runtimeKernel.engineLifecycle.appendEvent({
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
    return this.#sessionRecords.listRunSteps(runId, pageSize, cursor);
  }

  async createSessionMessage({ sessionId, caller, input }: CreateSessionMessageParams): Promise<MessageAcceptedResult> {
    return this.#sessionMessageCreation.createSessionMessage({ sessionId, caller, input });
  }

  async triggerActionRun({
    workspaceId,
    caller,
    actionName,
    sessionId,
    agentName,
    input,
    workspaceMemory,
    triggerSource
  }: TriggerActionRunParams): Promise<ActionRunAcceptedResult> {
    return (await this.#ensureRuntimeKernel()).sessionRuntime.triggerActionRun({
      workspaceId,
      caller,
      actionName,
      sessionId,
      agentName,
      input,
      workspaceMemory,
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
    return (await this.#ensureRuntimeKernel()).runRecovery.requeueRun(runId, requestedBy);
  }

  async guideQueuedRun(runId: string): Promise<import("./types.js").GuideQueuedRunResult> {
    return (await this.#ensureRuntimeKernel()).sessionRuntime.guideQueuedRun(runId);
  }

  async recoverRunAfterDrainTimeout(
    runId: string,
    strategy: AutomaticRecoveryStrategy
  ): Promise<"failed" | "requeued" | "ignored"> {
    return (await this.#ensureRuntimeKernel()).runRecovery.recoverRunAfterDrainTimeout(runId, strategy);
  }

  async listSessionEvents(sessionId: string, cursor?: string, runId?: string, limit?: number): Promise<SessionEvent[]> {
    await this.getSession(sessionId);
    return this.#sessionEventStore.listSince(sessionId, cursor, runId, limit);
  }

  subscribeSessionEvents(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    return this.#sessionEventStore.subscribe(sessionId, listener);
  }

  async processQueuedRun(runId: string): Promise<void> {
    await (await this.#ensureRuntimeKernel()).runProcessor.processRun(runId);
  }

  async recoverStaleRuns(options?: {
    staleBefore?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ recoveredRunIds: string[]; requeuedRunIds: string[] }> {
    return (await this.#ensureRuntimeKernel()).runRecovery.recoverStaleRuns(options);
  }

  #buildEngineTools(
    workspace: WorkspaceRecord,
    run: Run,
    session: Session,
    executionContext: RunExecutionContext
  ): EngineToolSet {
    return this.#getRuntimeKernelModule().buildRuntimeEngineTools({
      workspace,
      run,
      session,
      executionContext,
      modelGateway: this.#modelGateway,
      defaultModel: this.#defaultModel,
      commandExecutor: this.#workspaceCommandExecutor,
      fileSystem: this.#workspaceFileSystem,
      injectModelContextMessage: (message) => {
        executionContext.pendingModelContextMessages ??= [];
        executionContext.pendingModelContextMessages.push(message);
      },
      ...(this.#workspaceFileAccessProvider ? { workspaceFileAccessProvider: this.#workspaceFileAccessProvider } : {}),
      executeAction: async (action, input, context) => this.#executeAction(workspace, action, run, context.abortSignal, input),
      delegateAgent: async ({ targetAgentName, task, handoffSummary, taskId, notifyParentOnCompletion, toolUseId }, currentAgentName) => {
        const accepted = await this.#ensureExecutionServices().agentCoordination.delegateAgentRun({
          workspace,
          parentSession: session,
          parentRun: run,
          currentAgentName,
          targetAgentName,
          task,
          handoffSummary,
          taskId,
          notifyParentOnCompletion,
          toolUseId,
          canReadOutputFile: visibleNativeToolNames(workspace, currentAgentName).some(
            (toolName) => toolName === "Read" || toolName === "Bash"
          )
        });
        executionContext.delegatedRunIds.push(accepted.childRunId);
        return accepted;
      },
      readAgentTaskOutput: async ({ taskId, block, timeoutMs, abortSignal }) =>
        this.#ensureExecutionServices().agentCoordination.readAgentTaskOutput({
          taskId,
          block,
          timeoutMs,
          abortSignal
        }),
      awaitDelegatedRuns: async ({ runIds, mode }) =>
        this.#ensureExecutionServices().agentCoordination.awaitDelegatedRuns(runIds, mode),
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
