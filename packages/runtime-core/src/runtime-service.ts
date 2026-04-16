import path from "node:path";
import type {
  ChatMessage,
  Message,
  ModelGenerateResponse,
  Run,
  RunStep,
  Session,
  WorkspaceCatalog
} from "@oah/api-contracts";

import { AppError } from "./errors.js";
import { validateActionInput } from "./action-input-validation.js";
import { HookApplicationService } from "./runtime/hook-application.js";
import { HookService } from "./runtime/hooks.js";
import { AgentCoordinationService } from "./runtime/agent-coordination.js";
import { ActionRunService } from "./runtime/action-runs.js";
import {
  ModelInputService,
  type ModelExecutionInput
} from "./runtime/model-input.js";
import { ModelStreamCoordinator } from "./runtime/model-stream.js";
import {
  applyModelRequestPatch,
  applyModelResponsePatch,
  collapseLeadingSystemMessages,
  extractFailedToolResults,
  previewValue,
  serializeModelCallStepInput,
  serializeModelCallStepOutput,
  serializeModelRequest,
  summarizeMessageRoles,
  type ToolErrorContentPart
} from "./runtime/model-call-serialization.js";
import { RunFinalizationService } from "./runtime/run-finalization.js";
import { RunStateService } from "./runtime/run-state.js";
import {
  extractMessageDisplayText,
  hasMeaningfulText,
  normalizePromptMessages,
  SessionHistoryService
} from "./runtime/session-history.js";
import { ToolAuditService } from "./runtime/tool-audit.js";
import { ToolExecutionService } from "./runtime/tool-execution.js";
import { ToolMessageService } from "./runtime/tool-messages.js";
import { RunStepService } from "./runtime/run-steps.js";
import {
  buildSessionRuntimeMessages,
  doesSessionEventAffectRuntimeMessages
} from "./runtime/runtime-messages.js";
import {
  RuntimeMessageProjector,
  type TranscriptMessage
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
import { NATIVE_TOOL_NAMES } from "./native-tools.js";
import {
  extractTextFromContent,
  isMessageContentForRole,
  textContent
} from "./runtime-message-content.js";
import {
  activeToolNamesForAgent as resolveActiveToolNamesForAgent,
  buildRuntimeTools as createWorkspaceRuntimeTools,
  runtimeToolNamesForCatalog as listRuntimeToolNamesForCatalog,
  toolRetryPolicy as resolveToolRetryPolicy,
  toolSourceType as resolveToolSourceType,
  visibleEnabledToolServers as listVisibleEnabledToolServers
} from "./runtime-tooling.js";
import {
  type ActionRunAcceptedResult,
  type CancelRunResult,
  type RequeueRunResult,
  type CreateSessionMessageParams,
  type CreateSessionParams,
  type UpdateSessionParams,
  type CreateWorkspaceParams,
  type GenerateModelInput,
  type MessageListResult,
  type RuntimeMessageListResult,
  type RuntimeServiceOptions,
  type SessionEvent,
  type ModelStepResult,
  type RuntimeToolSet,
  type TriggerActionRunParams,
  type ModelDefinition,
  type WorkspaceCommandExecutor,
  type WorkspaceFileSystem,
  type RunStepListResult,
  type SessionListResult,
  type RunStepStatus,
  type RunStepType,
  type RuntimeToolExecutionContext,
  type RuntimeWorkspaceCatalog,
  type RunQueuePriority,
  type WorkspaceListResult,
  type RunListResult,
  normalizeWorkspaceRecord,
  toPublicWorkspace,
  type WorkspaceRecord
} from "./types.js";
import { createId, nowIso, parseCursor } from "./utils.js";
import type { RuntimeMessage } from "./runtime/runtime-messages.js";
import { createLocalWorkspaceCommandExecutor } from "./workspace-command-executor.js";
import { createLocalWorkspaceFileSystem } from "./workspace-file-system.js";
import { resolveWorkspacePath } from "./native-tools/paths.js";

interface RunExecutionContext {
  currentAgentName: string;
  injectSystemReminder: boolean;
  delegatedRunIds: string[];
}

function timeoutMsFromSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value * 1000);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "aborted" ||
      error.message === "This operation was aborted")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveArchiveTimeZone(): string {
  return process.env.OAH_ARCHIVE_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatArchiveDate(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function buildArchiveMetadata() {
  const deletedAt = nowIso();
  const timezone = resolveArchiveTimeZone();

  return {
    archiveDate: formatArchiveDate(deletedAt, timezone),
    archivedAt: deletedAt,
    deletedAt,
    timezone
  };
}

async function withTimeout<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number | undefined,
  timeoutMessage: string
): Promise<T> {
  if (timeoutMs === undefined) {
    return operation(undefined);
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    return await Promise.race([
      operation(abortController.signal),
      new Promise<T>((_resolve, reject) => {
        abortController.signal.addEventListener(
          "abort",
          () => {
            reject(new Error(timeoutMessage));
          },
          { once: true }
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

type AutomaticRecoveryStrategy = "fail" | "requeue_running" | "requeue_all";

type RecoveryActor =
  | "worker_startup"
  | "worker_startup_requeue"
  | "worker_drain_timeout"
  | "worker_drain_timeout_requeue"
  | "manual_operator_requeue";

export class RuntimeService {
  readonly #defaultModel: string;
  readonly #modelGateway: RuntimeServiceOptions["modelGateway"];
  readonly #logger: RuntimeServiceOptions["logger"];
  readonly #runHeartbeatIntervalMs: number;
  readonly #staleRunRecoveryStrategy: "fail" | "requeue_running" | "requeue_all";
  readonly #staleRunRecoveryMaxAttempts: number;
  readonly #platformModels: Record<string, ModelDefinition>;
  readonly #workspaceRepository: RuntimeServiceOptions["workspaceRepository"];
  readonly #sessionRepository: RuntimeServiceOptions["sessionRepository"];
  readonly #messageRepository: RuntimeServiceOptions["messageRepository"];
  readonly #runtimeMessageRepository: RuntimeServiceOptions["runtimeMessageRepository"];
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
  readonly #workspaceFileSystem: WorkspaceFileSystem;
  readonly #workspaceCommandExecutor: WorkspaceCommandExecutor;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #sessionHistory: SessionHistoryService;
  readonly #runSteps: RunStepService;
  readonly #runState: RunStateService;
  readonly #hooks: HookService;
  readonly #hookApplications: HookApplicationService<ModelExecutionInput>;
  readonly #modelInputs: ModelInputService;
  readonly #toolAudit: ToolAuditService;
  readonly #toolExecution: ToolExecutionService;
  readonly #toolMessages: ToolMessageService;
  readonly #actions: ActionRunService;
  readonly #agentCoordination: AgentCoordinationService;
  readonly #runFinalization: RunFinalizationService;
  readonly #runtimeMessageProjector: RuntimeMessageProjector;
  readonly #sessionChains = new Map<string, Promise<void>>();
  readonly #runtimeMessageSyncChains = new Map<string, Promise<void>>();
  readonly #runAbortControllers = new Map<string, AbortController>();
  readonly #drainTimeoutRecoveredRuns = new Set<string>();

  constructor(options: RuntimeServiceOptions) {
    this.#defaultModel = options.defaultModel;
    this.#modelGateway = options.modelGateway;
    this.#logger = options.logger;
    this.#runHeartbeatIntervalMs = Math.max(50, options.runHeartbeatIntervalMs ?? 5_000);
    this.#staleRunRecoveryStrategy = options.staleRunRecovery?.strategy ?? "fail";
    this.#staleRunRecoveryMaxAttempts = Math.max(1, Math.floor(options.staleRunRecovery?.maxAttempts ?? 1));
    this.#platformModels = options.platformModels ?? {};
    this.#workspaceRepository = options.workspaceRepository;
    this.#sessionRepository = options.sessionRepository;
    this.#messageRepository = options.messageRepository;
    this.#runtimeMessageRepository = options.runtimeMessageRepository;
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
    this.#modelInputs = new ModelInputService({
      defaultModel: this.#defaultModel,
      platformModels: this.#platformModels,
      applyContextHooks: (workspace, session, run, eventName, messages) =>
        this.#applyContextHooks(workspace, session, run, eventName, messages),
      collapseLeadingSystemMessages: (messages) => collapseLeadingSystemMessages(messages)
    });
    this.#hooks = new HookService({
      defaultModel: this.#defaultModel,
      modelGateway: this.#modelGateway,
      commandExecutor: this.#workspaceCommandExecutor,
      fileSystem: this.#workspaceFileSystem,
      hookRunAuditRepository: options.hookRunAuditRepository,
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      appendEvent: (input) => this.#appendEvent(input),
      resolveModelForRun: (workspace, modelRef) => this.#modelInputs.resolveModelForRun(workspace, modelRef),
      createId,
      timeoutMsFromSeconds,
      withTimeout,
      isAbortError
    });
    this.#hookApplications = new HookApplicationService<ModelExecutionInput>({
      executeHook: (workspace, session, run, hook, envelope) =>
        this.#hooks.executeHook(workspace, session, run, hook, envelope),
      serializeModelRequest: (modelInput) => this.#serializeModelRequest(modelInput),
      applyModelRequestPatch: (workspace, current, patch) => this.#applyModelRequestPatch(workspace, current, patch),
      applyModelResponsePatch: (response, patch) => this.#applyModelResponsePatch(response, patch)
    });
    this.#toolAudit = new ToolAuditService({
      toolCallAuditRepository: options.toolCallAuditRepository,
      createId,
      resolveToolSourceType
    });
    this.#toolExecution = new ToolExecutionService({
      logger: this.#logger,
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      recordToolCallAuditFromStep: (step, toolName, status) =>
        this.#toolAudit.recordToolCallAuditFromStep(step, toolName, status),
      appendEvent: (input) => this.#appendEvent(input),
      setRunStatusIfPossible: (runId, nextStatus) => this.#runState.setRunStatusIfPossible(runId, nextStatus),
      applyBeforeToolDispatchHooks: (workspace, session, run, activeAgentName, toolName, toolCallId, input) =>
        this.#hookApplications.applyBeforeToolDispatchHooks(
          workspace,
          session,
          run,
          activeAgentName,
          toolName,
          toolCallId,
          input
        ),
      applyAfterToolDispatchHooks: (workspace, session, run, activeAgentName, toolName, toolCallId, input, output) =>
        this.#hookApplications.applyAfterToolDispatchHooks(
          workspace,
          session,
          run,
          activeAgentName,
          toolName,
          toolCallId,
          input,
          output
        ),
      resolveToolRetryPolicy,
      resolveToolSourceType,
      timeoutMsFromSeconds,
      createAbortError,
      normalizeJsonObject: (value) => this.#normalizeJsonObject(value),
      previewValue: (value, maxLength) => this.#previewValue(value, maxLength)
    });
    this.#toolMessages = new ToolMessageService({
      messageRepository: this.#messageRepository,
      logger: this.#logger,
      appendEvent: (input) => this.#appendEvent(input),
      createId,
      nowIso,
      previewValue: (value, maxLength) => this.#previewValue(value, maxLength)
    });
    this.#actions = new ActionRunService({
      defaultModel: this.#defaultModel,
      commandExecutor: this.#workspaceCommandExecutor,
      sessionRepository: this.#sessionRepository,
      toolMessages: this.#toolMessages,
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      setRunStatus: (run, nextStatus, patch) => this.#runState.setRunStatus(run, nextStatus, patch),
      getRun: (runId) => this.getRun(runId),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      recordToolCallAuditFromStep: (step, toolName, status) =>
        this.#toolAudit.recordToolCallAuditFromStep(step, toolName, status),
      appendEvent: (input) => this.#appendEvent(input),
      nowIso,
      normalizeJsonObject: (value) => this.#normalizeJsonObject(value)
    });
    this.#agentCoordination = new AgentCoordinationService({
      sessionRepository: this.#sessionRepository,
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      getRun: (runId) => this.getRun(runId),
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      updateRun: (run, patch) => this.#runState.updateRun(run, patch),
      appendEvent: (input) => this.#appendEvent(input),
      enqueueRun: (sessionId, runId, options) => this.#enqueueRun(sessionId, runId, options),
      resolveModelForRun: (workspace, modelRef) => this.#modelInputs.resolveModelForRun(workspace, modelRef),
      extractMessageDisplayText: (message) => this.#extractMessageDisplayText(message),
      hasMeaningfulText: (value) => this.#hasMeaningfulText(value),
      createId,
      nowIso
    });
    this.#runFinalization = new RunFinalizationService({
      sessionRepository: this.#sessionRepository,
      getRun: (runId) => this.getRun(runId),
      ensureAssistantMessage: (session, run, currentMessage, allMessages, content, metadata) =>
        this.#toolMessages.ensureAssistantMessage(session, run, currentMessage, allMessages, content, metadata),
      updateAssistantMessage: (message, content) =>
        this.#messageRepository.update({
          ...message,
          content
        }) as Promise<Extract<Message, { role: "assistant" }>>,
      appendEvent: (input) => this.#appendEvent(input),
      setRunStatus: (run, nextStatus, patch) => this.#runState.setRunStatus(run, nextStatus, patch),
      markRunTimedOut: (run, runTimeoutMs) => this.#runState.markRunTimedOut(run, runTimeoutMs),
      markRunCancelled: (sessionId, run) => this.#runState.markRunCancelled(sessionId, run),
      recordSystemStep: (run, name, output) => this.#runSteps.recordSystemStep(run, name, output),
      runLifecycleHooks: (workspace, session, run, eventName) => this.#hookApplications.runLifecycleHooks(workspace, session, run, eventName),
      buildGeneratedMessageMetadata: (workspace, agentName, modelInput) =>
        this.#buildGeneratedMessageMetadata(workspace, agentName, modelInput),
      nowIso
    });
    this.#runtimeMessageProjector = new RuntimeMessageProjector();
  }

  async createWorkspace({ input }: CreateWorkspaceParams): Promise<import("@oah/api-contracts").Workspace> {
    if (!this.#workspaceInitializer) {
      throw new AppError(
        501,
        "workspace_initializer_not_configured",
        "Workspace creation requires a configured blueprint initializer."
      );
    }

    const initialized = await this.#workspaceInitializer.initialize(input);
    const now = nowIso();
    const workspaceId = initialized.id ?? createId("ws");

    const workspace: WorkspaceRecord = {
      id: workspaceId,
      kind: initialized.kind ?? "project",
      readOnly: initialized.readOnly ?? false,
      historyMirrorEnabled: (initialized.kind ?? "project") === "project",
      defaultAgent: initialized.defaultAgent,
      projectAgentsMd: initialized.projectAgentsMd,
      settings: initialized.settings,
      workspaceModels: initialized.workspaceModels,
      agents: initialized.agents,
      actions: initialized.actions,
      skills: initialized.skills,
      toolServers: initialized.toolServers,
      hooks: initialized.hooks,
      catalog: {
        ...initialized.catalog,
        workspaceId
      },
      externalRef: input.externalRef,
      ...(input.serviceName ? { serviceName: input.serviceName } : {}),
      name: input.name,
      rootPath: initialized.rootPath,
      executionPolicy: input.executionPolicy ?? "local",
      status: "active",
      createdAt: now,
      updatedAt: now
    };

    const created = await this.#workspaceRepository.create(workspace);
    return toPublicWorkspace(created);
  }

  async getWorkspace(workspaceId: string): Promise<import("@oah/api-contracts").Workspace> {
    return toPublicWorkspace(await this.getWorkspaceRecord(workspaceId));
  }

  async listWorkspaces(pageSize = 50, cursor?: string): Promise<WorkspaceListResult> {
    const startIndex = parseCursor(cursor);
    const workspaces = await this.#workspaceRepository.list(pageSize, cursor);
    const items = workspaces.map((workspace) => toPublicWorkspace(normalizeWorkspaceRecord(workspace)));
    const nextCursor = workspaces.length === pageSize ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.#workspaceRepository.getById(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", `Workspace ${workspaceId} was not found.`);
    }

    return normalizeWorkspaceRecord(workspace);
  }

  async getWorkspaceCatalog(workspaceId: string): Promise<WorkspaceCatalog> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    return this.#publicWorkspaceCatalog(workspace);
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
    return this.#withWorkspaceFileLease(workspaceId, "read", input.path, (workspace) =>
      this.#workspaceFiles.listEntries(workspace, input)
    );
  }

  async getWorkspaceFileContent(
    workspaceId: string,
    input: { path: string; encoding: "utf8" | "base64"; maxBytes?: number | undefined }
  ): Promise<WorkspaceFileContentResult> {
    return this.#withWorkspaceFileLease(workspaceId, "read", input.path, (workspace) =>
      this.#workspaceFiles.getFileContent(workspace, input)
    );
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
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.putFileContent(workspace, input)
    );
  }

  async uploadWorkspaceFile(
    workspaceId: string,
    input: { path: string; data: Buffer; overwrite?: boolean | undefined; ifMatch?: string | undefined }
  ): Promise<WorkspaceEntry> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.uploadFile(workspace, input)
    );
  }

  async createWorkspaceDirectory(
    workspaceId: string,
    input: { path: string; createParents: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.createDirectory(workspace, input)
    );
  }

  async deleteWorkspaceEntry(
    workspaceId: string,
    input: { path: string; recursive: boolean }
  ): Promise<WorkspaceDeleteResult> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.deleteEntry(workspace, input)
    );
  }

  async moveWorkspaceEntry(
    workspaceId: string,
    input: { sourcePath: string; targetPath: string; overwrite: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.targetPath, (workspace) =>
      this.#workspaceFiles.moveEntry(workspace, input)
    );
  }

  async getWorkspaceFileDownload(
    workspaceId: string,
    targetPath: string
  ): Promise<WorkspaceFileDownloadResult> {
    return this.#workspaceFiles.getFileDownload(await this.getWorkspaceRecord(workspaceId), targetPath);
  }

  async openWorkspaceFileDownload(
    workspaceId: string,
    targetPath: string
  ): Promise<{
    file: WorkspaceFileDownloadResult;
    release(options?: { dirty?: boolean | undefined }): Promise<void>;
  }> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (!this.#workspaceFileAccessProvider) {
      return {
        file: await this.#workspaceFiles.getFileDownload(workspace, targetPath),
        async release() {
          return undefined;
        }
      };
    }

    const lease = await this.#workspaceFileAccessProvider.acquire({
      workspace,
      access: "read",
      path: targetPath
    });

    let released = false;
    try {
      return {
        file: await this.#workspaceFiles.getFileDownload(lease.workspace, targetPath),
        async release(options?: { dirty?: boolean | undefined }) {
          if (released) {
            return;
          }

          released = true;
          await lease.release(options);
        }
      };
    } catch (error) {
      await lease.release({ dirty: false });
      throw error;
    }
  }

  async #withWorkspaceFileLease<T>(
    workspaceId: string,
    access: "read" | "write",
    targetPath: string | undefined,
    operation: (workspace: WorkspaceRecord) => Promise<T>
  ): Promise<T> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (!this.#workspaceFileAccessProvider) {
      return operation(workspace);
    }

    const lease = await this.#workspaceFileAccessProvider.acquire({
      workspace,
      access,
      ...(targetPath ? { path: targetPath } : {})
    });

    try {
      return await operation(lease.workspace);
    } finally {
      await lease.release({
        dirty: access === "write" && !lease.workspace.readOnly && lease.workspace.kind === "project"
      });
    }
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
    return this.#withWorkspaceCommandLease(workspaceId, input.cwd, input.access ?? "write", async (workspace, cwd) =>
      this.#workspaceCommandExecutor.runForeground({
        workspace,
        command: input.command,
        ...(cwd ? { cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      })
    );
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
    return this.#withWorkspaceCommandLease(workspaceId, input.cwd, input.access ?? "write", async (workspace, cwd) =>
      this.#workspaceCommandExecutor.runProcess({
        workspace,
        executable: input.executable,
        args: input.args,
        ...(cwd ? { cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      })
    );
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
    return this.#withWorkspaceCommandLease(workspaceId, input.cwd, input.access ?? "write", async (workspace, cwd) =>
      this.#workspaceCommandExecutor.runBackground({
        workspace,
        command: input.command,
        sessionId: input.sessionId,
        ...(input.description ? { description: input.description } : {}),
        ...(cwd ? { cwd } : {}),
        ...(input.env ? { env: input.env } : {})
      })
    );
  }

  async getWorkspaceFileStat(workspaceId: string, targetPath: string) {
    return this.#withWorkspaceFileLease(workspaceId, "read", targetPath, async (workspace) => {
      const resolved = await resolveWorkspacePath(this.#workspaceFileSystem, workspace.rootPath, targetPath);
      const stats = await this.#workspaceFileSystem.stat(resolved.absolutePath);
      return {
        ...stats,
        path: targetPath
      };
    });
  }

  async #withWorkspaceCommandLease<T>(
    workspaceId: string,
    commandPath: string | undefined,
    access: "read" | "write",
    operation: (workspace: WorkspaceRecord, cwd: string | undefined) => Promise<T>
  ): Promise<T> {
    return this.#withWorkspaceFileLease(workspaceId, access, commandPath, async (workspace) => {
      const cwd =
        commandPath !== undefined
          ? (await resolveWorkspacePath(this.#workspaceFileSystem, workspace.rootPath, commandPath)).absolutePath
          : undefined;
      return operation(workspace, cwd ?? path.resolve(workspace.rootPath));
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (this.#workspaceArchiveRepository) {
      await this.#workspaceArchiveRepository.archiveWorkspace({
        workspace,
        ...buildArchiveMetadata()
      });
    }
    await this.#workspaceDeletionHandler?.deleteWorkspace(workspace);
    await this.#workspaceRepository.delete(workspaceId);
  }

  async createSession({ workspaceId, caller, input }: CreateSessionParams): Promise<Session> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    const now = nowIso();
    const activeAgentName = input.agentName ?? this.#resolveWorkspaceDefaultAgentName(workspace);
    const modelRef = this.#modelInputs.normalizeSessionModelRef(workspace, input.modelRef);
    if (!activeAgentName) {
      throw new AppError(
        409,
        "missing_default_agent",
        `Workspace ${workspaceId} has no default agent. Provide agentName explicitly or configure .openharness/settings.yaml.`
      );
    }

    if (Object.keys(workspace.agents).length > 0 && !workspace.agents[activeAgentName]) {
      throw new AppError(404, "agent_not_found", `Agent ${activeAgentName} was not found in workspace ${workspaceId}.`);
    }

    const initialAgent = workspace.agents[activeAgentName];
    if (initialAgent?.mode === "subagent") {
      throw new AppError(
        409,
        "invalid_session_agent_target",
        `Agent ${activeAgentName} is a subagent and cannot be set as the active session agent.`
      );
    }

    const session: Session = {
      id: createId("ses"),
      workspaceId: workspace.id,
      subjectRef: caller.subjectRef,
      ...(modelRef ? { modelRef } : {}),
      agentName: input.agentName,
      activeAgentName,
      title: input.title,
      status: "active",
      createdAt: now,
      updatedAt: now
    };

    return this.#sessionRepository.create(session);
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = await this.#sessionRepository.getById(sessionId);
    if (!session) {
      throw new AppError(404, "session_not_found", `Session ${sessionId} was not found.`);
    }

    return session;
  }

  #resolveWorkspaceDefaultAgentName(workspace: WorkspaceRecord): string | undefined {
    if (workspace.defaultAgent) {
      return workspace.defaultAgent;
    }

    const assistantAgent = workspace.agents.assistant;
    if (assistantAgent && assistantAgent.mode !== "subagent") {
      return assistantAgent.name;
    }

    return Object.values(workspace.agents)
      .filter((agent) => agent.mode === "primary" || agent.mode === "all")
      .sort((left, right) => left.name.localeCompare(right.name))
      .at(0)?.name;
  }

  async updateSession({ sessionId, input }: UpdateSessionParams): Promise<Session> {
    const session = await this.getSession(sessionId);
    const workspace = await this.getWorkspaceRecord(session.workspaceId);
    let nextActiveAgentName = session.activeAgentName;
    let nextModelRef = session.modelRef;

    if (input.activeAgentName !== undefined) {
      const targetAgent = workspace.agents[input.activeAgentName];
      if (!targetAgent) {
        throw new AppError(
          404,
          "agent_not_found",
          `Agent ${input.activeAgentName} was not found in workspace ${workspace.id}.`
        );
      }

      if (targetAgent.mode === "subagent") {
        throw new AppError(
          409,
          "invalid_session_agent_target",
          `Agent ${input.activeAgentName} is a subagent and cannot be set as the active session agent.`
        );
      }

      nextActiveAgentName = input.activeAgentName;
    }

    if (input.modelRef !== undefined) {
      const normalizedModelRef =
        input.modelRef === null ? undefined : this.#modelInputs.normalizeSessionModelRef(workspace, input.modelRef);
      if (normalizedModelRef !== session.modelRef && (await this.#sessionHasStarted(session.id))) {
        throw new AppError(
          409,
          "session_model_locked",
          `Session ${session.id} model cannot be changed after the conversation has started.`
        );
      }

      nextModelRef = normalizedModelRef;
    }

    const updatedSession: Session = {
      ...session,
      ...(input.title !== undefined ? { title: input.title } : {}),
      activeAgentName: nextActiveAgentName,
      updatedAt: nowIso()
    };
    if (nextModelRef) {
      updatedSession.modelRef = nextModelRef;
    } else {
      delete updatedSession.modelRef;
    }

    return this.#sessionRepository.update(updatedSession);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    const workspace = await this.getWorkspaceRecord(session.workspaceId);
    const workspaceSessions = await this.#listAllWorkspaceSessions(session.workspaceId);
    const childSessionIdsByParentId = new Map<string, string[]>();

    for (const candidate of workspaceSessions) {
      if (!candidate.parentSessionId) {
        continue;
      }

      const childIds = childSessionIdsByParentId.get(candidate.parentSessionId) ?? [];
      childIds.push(candidate.id);
      childSessionIdsByParentId.set(candidate.parentSessionId, childIds);
    }

    const deletionOrder: string[] = [];
    const visit = (targetSessionId: string) => {
      for (const childSessionId of childSessionIdsByParentId.get(targetSessionId) ?? []) {
        visit(childSessionId);
      }
      deletionOrder.push(targetSessionId);
    };

    visit(sessionId);

    if (this.#workspaceArchiveRepository) {
      await this.#workspaceArchiveRepository.archiveSessionTree({
        workspace,
        rootSessionId: sessionId,
        sessionIds: deletionOrder,
        ...buildArchiveMetadata()
      });
    }

    for (const targetSessionId of deletionOrder) {
      await this.#sessionRepository.delete(targetSessionId);
    }
  }

  async listWorkspaceSessions(workspaceId: string, pageSize: number, cursor?: string): Promise<SessionListResult> {
    await this.getWorkspaceRecord(workspaceId);
    const startIndex = parseCursor(cursor);
    const items = await this.#sessionRepository.listByWorkspaceId(workspaceId, pageSize, cursor);
    const nextCursor = items.length === pageSize ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    await this.getSession(sessionId);
    const messages = await this.#messageRepository.listBySessionId(sessionId);
    const startIndex = parseCursor(cursor);
    const items = messages.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < messages.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionRuntimeMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<RuntimeMessageListResult> {
    await this.getSession(sessionId);
    const runtimeMessages = await this.#loadSessionRuntimeMessages(sessionId);
    const startIndex = parseCursor(cursor);
    const items = runtimeMessages.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < runtimeMessages.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionTranscriptMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    await this.getSession(sessionId);
    const runtimeMessages = await this.#loadSessionRuntimeMessages(sessionId);
    const runtimeMessagesById = new Map(runtimeMessages.map((message) => [message.id, message]));
    const projection = this.#runtimeMessageProjector.projectToTranscript(runtimeMessages, {
      sessionId,
      activeAgentName: "",
      applyCompactBoundary: false
    });
    const transcriptMessages = projection.messages.map((message) =>
      this.#toTranscriptMessage(sessionId, message, runtimeMessagesById)
    );
    const startIndex = parseCursor(cursor);
    const items = transcriptMessages.slice(startIndex, startIndex + pageSize);
    const nextCursor =
      startIndex + pageSize < transcriptMessages.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionRuns(sessionId: string, pageSize = 100, cursor?: string): Promise<RunListResult> {
    await this.getSession(sessionId);
    const runs = await this.#runRepository.listBySessionId(sessionId);
    const startIndex = parseCursor(cursor);
    const items = runs.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < runs.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listRunSteps(runId: string, pageSize = 100, cursor?: string): Promise<RunStepListResult> {
    await this.getRun(runId);
    const steps = await this.#runStepRepository.listByRunId(runId);
    const startIndex = parseCursor(cursor);
    const items = steps.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < steps.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async createSessionMessage({ sessionId, caller, input }: CreateSessionMessageParams): Promise<{
    messageId: string;
    runId: string;
    status: "queued";
  }> {
    const session = await this.getSession(sessionId);
    const now = nowIso();

    const message: Message = {
      id: createId("msg"),
      sessionId,
      role: "user",
      content: textContent(input.content),
      metadata: input.metadata,
      createdAt: now
    };

    await this.#messageRepository.create(message);

    const run: Run = {
      id: createId("run"),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      initiatorRef: caller.subjectRef,
      triggerType: "message",
      triggerRef: message.id,
      agentName: session.activeAgentName,
      effectiveAgentName: session.activeAgentName,
      switchCount: 0,
      status: "queued",
      createdAt: now
    };

    await this.#runRepository.create(run);
    await this.#appendEvent({
      sessionId: session.id,
      runId: run.id,
      event: "run.queued",
      data: {
        runId: run.id,
        sessionId: session.id,
        status: "queued"
      }
    });

    await this.#enqueueRun(session.id, run.id);

    return {
      messageId: message.id,
      runId: run.id,
      status: "queued"
    };
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
    const workspace = await this.getWorkspaceRecord(workspaceId);
    const action = workspace.actions[actionName];
    if (!action) {
      throw new AppError(404, "action_not_found", `Action ${actionName} was not found in workspace ${workspaceId}.`);
    }

    const resolvedTriggerSource = triggerSource ?? "api";
    if (resolvedTriggerSource === "user" ? !action.callableByUser : !action.callableByApi) {
      throw new AppError(
        403,
        resolvedTriggerSource === "user" ? "action_not_callable_by_user" : "action_not_callable_by_api",
        resolvedTriggerSource === "user"
          ? `Action ${actionName} cannot be triggered by a user.`
          : `Action ${actionName} cannot be triggered by API.`
      );
    }

    validateActionInput(action, input ?? null);

    let session: Session | undefined;
    if (sessionId) {
      session = await this.getSession(sessionId);
      if (session.workspaceId !== workspaceId) {
        throw new AppError(
          409,
          "session_workspace_mismatch",
          `Session ${sessionId} does not belong to workspace ${workspaceId}.`
        );
      }
    }

    const resolvedAgentName = agentName ?? session?.activeAgentName ?? this.#resolveWorkspaceDefaultAgentName(workspace);
    if (resolvedAgentName && Object.keys(workspace.agents).length > 0 && !workspace.agents[resolvedAgentName]) {
      throw new AppError(404, "agent_not_found", `Agent ${resolvedAgentName} was not found in workspace ${workspaceId}.`);
    }

    if (!session) {
      session = await this.createSession({
        workspaceId,
        caller,
        input: {
          agentName: resolvedAgentName ?? "default",
          title: `Action · ${actionName}`
        }
      });
    }

    const now = nowIso();
    const run: Run = {
      id: createId("run"),
      workspaceId,
      sessionId: session.id,
      initiatorRef: caller.subjectRef,
      triggerType: resolvedTriggerSource === "user" ? "manual_action" : "api_action",
      triggerRef: actionName,
      ...(resolvedAgentName ? { agentName: resolvedAgentName, effectiveAgentName: resolvedAgentName } : { effectiveAgentName: "default" }),
      switchCount: 0,
      status: "queued",
      createdAt: now,
      metadata: {
        actionName,
        input: input ?? null
      }
    };

    await this.#runRepository.create(run);
    await this.#appendEvent({
      sessionId: session.id,
      runId: run.id,
      event: "run.queued",
      data: {
        runId: run.id,
        sessionId: session.id,
        status: "queued"
      }
    });

    await this.#enqueueRun(session.id, run.id);

    return {
      runId: run.id,
      status: "queued",
      actionName,
      sessionId: session.id
    };
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
      const updated = await this.#updateRun(run, {
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
    const run = await this.getRun(runId);
    if (run.status !== "failed" && run.status !== "timed_out") {
      throw new AppError(409, "run_requeue_invalid_status", `Run ${runId} is not in a terminal recovery state.`);
    }

    if (!this.#isRecoveryManagedRun(run)) {
      throw new AppError(409, "run_requeue_not_supported", `Run ${runId} is not eligible for manual requeue.`);
    }

    if (!this.#runQueue || !run.sessionId) {
      throw new AppError(409, "run_requeue_unavailable", `Run ${runId} cannot be requeued on this deployment.`);
    }

    await this.getSession(run.sessionId);
    const previousStatus = run.status;
    const recoveredAt = nowIso();
    const queuedRun = await this.#updateRun(run, {
      status: "queued",
      startedAt: undefined,
      heartbeatAt: undefined,
      endedAt: undefined,
      cancelRequestedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      metadata: this.#buildRecoveryMetadata(run, {
        attempts: this.#readRecoveryAttempts(run.metadata),
        outcome: "requeued",
        recoveredBy: "manual_operator_requeue",
        recoveredAt,
        reason: "manual_operator_requeue",
        quarantined: false,
        strategy: "manual",
        requestedBy
      })
    });

    await this.#appendEvent({
      sessionId: run.sessionId,
      runId: queuedRun.id,
      event: "run.queued",
      data: {
        runId: queuedRun.id,
        sessionId: run.sessionId,
        status: queuedRun.status,
        recoveredBy: "manual_operator_requeue",
        recoveryAttempt: this.#readRecoveryAttempts(queuedRun.metadata),
        recoveryState: "requeued",
        recoveryReason: "manual_operator_requeue",
        recoveryStrategy: "manual",
        previousStatus,
        ...(requestedBy ? { requestedBy } : {})
      }
    });
    await this.#recordSystemStep(queuedRun, "run.requeued", {
      status: queuedRun.status,
      recoveredBy: "manual_operator_requeue",
      recoveryAttempt: this.#readRecoveryAttempts(queuedRun.metadata),
      recoveryState: "requeued",
      recoveryReason: "manual_operator_requeue",
      recoveryStrategy: "manual",
      previousStatus,
      ...(requestedBy ? { requestedBy } : {})
    });
    await this.#enqueueRun(run.sessionId, queuedRun.id);

    return {
      runId: queuedRun.id,
      status: "queued",
      previousStatus,
      source: "manual_requeue"
    };
  }

  async recoverRunAfterDrainTimeout(
    runId: string,
    strategy: AutomaticRecoveryStrategy
  ): Promise<"failed" | "requeued" | "ignored"> {
    const run = await this.#runRepository.getById(runId);
    if (!run || (run.status !== "running" && run.status !== "waiting_tool")) {
      return "ignored";
    }

    const abortController = this.#runAbortControllers.get(run.id);
    if (abortController) {
      this.#drainTimeoutRecoveredRuns.add(run.id);
      abortController.abort();
    }

    if (strategy !== "fail") {
      if (
        await this.#tryRequeueRecoveredRun(run, {
          strategy,
          recoveredBy: "worker_drain_timeout_requeue"
        })
      ) {
        return "requeued";
      }
    }

    const endedAt = nowIso();
    const failureContext = this.#resolveRecoveryFailureContext(run, strategy);
    const failedRun = await this.#updateRun(run, {
      status: "failed",
      endedAt,
      errorCode: "worker_recovery_failed",
      errorMessage: "Run was recovered as failed after worker drain timed out.",
      metadata: this.#buildRecoveryMetadata(run, {
        attempts: failureContext.recoveryAttempts,
        outcome: "failed",
        recoveredBy: "worker_drain_timeout",
        recoveredAt: endedAt,
        reason: failureContext.reason,
        quarantined: failureContext.quarantined,
        strategy
      })
    });

    if (failedRun.sessionId) {
      await this.#appendEvent({
        sessionId: failedRun.sessionId,
        runId: failedRun.id,
        event: "run.failed",
        data: {
          runId: failedRun.id,
          sessionId: failedRun.sessionId,
          status: failedRun.status,
          errorCode: failedRun.errorCode,
          errorMessage: failedRun.errorMessage,
          recoveredBy: "worker_drain_timeout",
          recoveryAttempt: failureContext.recoveryAttempts,
          recoveryState: failureContext.quarantined ? "quarantined" : "failed",
          recoveryReason: failureContext.reason,
          recoveryStrategy: strategy
        }
      });
    }

    await this.#recordSystemStep(failedRun, "run.failed", {
      status: failedRun.status,
      errorCode: failedRun.errorCode,
      errorMessage: failedRun.errorMessage,
      recoveredBy: "worker_drain_timeout",
      recoveryAttempt: failureContext.recoveryAttempts,
      recoveryState: failureContext.quarantined ? "quarantined" : "failed",
      recoveryReason: failureContext.reason,
      recoveryStrategy: strategy
    });

    return "failed";
  }

  async listSessionEvents(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    await this.getSession(sessionId);
    return this.#sessionEventStore.listSince(sessionId, cursor, runId);
  }

  subscribeSessionEvents(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    return this.#sessionEventStore.subscribe(sessionId, listener);
  }

  async processQueuedRun(runId: string): Promise<void> {
    await this.#processRun(runId);
  }

  async recoverStaleRuns(options?: {
    staleBefore?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ recoveredRunIds: string[]; requeuedRunIds: string[] }> {
    const staleBefore = options?.staleBefore ?? new Date(Date.now() - this.#runHeartbeatIntervalMs * 3).toISOString();
    const recoverableRuns = await this.#runRepository.listRecoverableActiveRuns(staleBefore, options?.limit ?? 100);
    const recoveredRunIds: string[] = [];
    const requeuedRunIds: string[] = [];

    for (const run of recoverableRuns) {
      const currentRun = await this.#runRepository.getById(run.id);
      if (!currentRun || (currentRun.status !== "running" && currentRun.status !== "waiting_tool")) {
        continue;
      }

      if (this.#staleRunRecoveryStrategy !== "fail") {
        if (
          await this.#tryRequeueRecoveredRun(currentRun, {
            strategy: this.#staleRunRecoveryStrategy,
            recoveredBy: "worker_startup_requeue"
          })
        ) {
          requeuedRunIds.push(currentRun.id);
          continue;
        }
      }

      const endedAt = nowIso();
      const failureContext = this.#resolveRecoveryFailureContext(currentRun, this.#staleRunRecoveryStrategy);
      const failedRun = await this.#updateRun(currentRun, {
        status: "failed",
        endedAt,
        errorCode: "worker_recovery_failed",
        errorMessage: "Run was recovered as failed after worker heartbeat expired.",
        metadata: this.#buildRecoveryMetadata(currentRun, {
          attempts: failureContext.recoveryAttempts,
          outcome: "failed",
          recoveredBy: "worker_startup",
          recoveredAt: endedAt,
          reason: failureContext.reason,
          quarantined: failureContext.quarantined,
          strategy: this.#staleRunRecoveryStrategy
        })
      });

      if (failedRun.sessionId) {
        await this.#appendEvent({
          sessionId: failedRun.sessionId,
          runId: failedRun.id,
          event: "run.failed",
          data: {
            runId: failedRun.id,
            sessionId: failedRun.sessionId,
            status: failedRun.status,
            errorCode: failedRun.errorCode,
            errorMessage: failedRun.errorMessage,
            recoveredBy: "worker_startup",
            recoveryAttempt: failureContext.recoveryAttempts,
            recoveryState: failureContext.quarantined ? "quarantined" : "failed",
            recoveryReason: failureContext.reason
          }
        });
      }

      await this.#recordSystemStep(failedRun, "run.failed", {
        status: failedRun.status,
        errorCode: failedRun.errorCode,
        errorMessage: failedRun.errorMessage,
        recoveredBy: "worker_startup",
        recoveryAttempt: failureContext.recoveryAttempts,
        recoveryState: failureContext.quarantined ? "quarantined" : "failed",
        recoveryReason: failureContext.reason
      });
      recoveredRunIds.push(failedRun.id);
    }

    return { recoveredRunIds, requeuedRunIds };
  }

  async #appendEvent(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.#sessionEventStore.append(input);
    if (doesSessionEventAffectRuntimeMessages(event)) {
      await this.#scheduleRuntimeMessageSync(input.sessionId);
    }
    return event;
  }

  async #scheduleRuntimeMessageSync(sessionId: string): Promise<void> {
    if (!this.#runtimeMessageRepository) {
      return;
    }

    const previous = this.#runtimeMessageSyncChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const [messages, events, storedRuntimeMessages] = await Promise.all([
          this.#messageRepository.listBySessionId(sessionId),
          this.#sessionEventStore.listSince(sessionId),
          this.#runtimeMessageRepository?.listBySessionId(sessionId) ?? Promise.resolve([])
        ]);
        const runtimeMessages = buildSessionRuntimeMessages({
          messages,
          events
        });
        if (this.#runtimeMessagesEqual(storedRuntimeMessages, runtimeMessages)) {
          return;
        }

        await this.#runtimeMessageRepository?.replaceBySessionId(sessionId, runtimeMessages);
      })
      .finally(() => {
        if (this.#runtimeMessageSyncChains.get(sessionId) === next) {
          this.#runtimeMessageSyncChains.delete(sessionId);
        }
      });

    this.#runtimeMessageSyncChains.set(sessionId, next);
    await next;
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
        await this.#processRun(runId);
      })
      .finally(() => {
        if (this.#sessionChains.get(sessionId) === next) {
          this.#sessionChains.delete(sessionId);
        }
      });

    this.#sessionChains.set(sessionId, next);
  }

  async #tryRequeueRecoveredRun(
    run: Run,
    input: {
      strategy: Exclude<AutomaticRecoveryStrategy, "fail">;
      recoveredBy: Extract<RecoveryActor, "worker_startup_requeue" | "worker_drain_timeout_requeue">;
    }
  ): Promise<boolean> {
    if (!this.#runQueue || !run.sessionId) {
      return false;
    }

    if (input.strategy === "requeue_running" && run.status !== "running") {
      return false;
    }

    const recoveryAttempts = this.#readRecoveryAttempts(run.metadata);
    if (recoveryAttempts >= this.#staleRunRecoveryMaxAttempts) {
      return false;
    }

    const nextRecoveryAttempt = recoveryAttempts + 1;
    const recoveredAt = nowIso();
    const queuedRun = await this.#updateRun(run, {
      status: "queued",
      startedAt: undefined,
      heartbeatAt: undefined,
      endedAt: undefined,
      cancelRequestedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      metadata: this.#buildRecoveryMetadata(run, {
        attempts: nextRecoveryAttempt,
        outcome: "requeued",
        recoveredBy: input.recoveredBy,
        recoveredAt,
        reason: "automatic_requeue",
        quarantined: false,
        strategy: input.strategy
      })
    });

    await this.#appendEvent({
      sessionId: run.sessionId,
      runId: queuedRun.id,
      event: "run.queued",
      data: {
        runId: queuedRun.id,
        sessionId: run.sessionId,
        status: queuedRun.status,
        recoveredBy: input.recoveredBy,
        recoveryAttempt: nextRecoveryAttempt,
        recoveryState: "requeued",
        recoveryReason: "automatic_requeue",
        recoveryStrategy: input.strategy
      }
    });
    await this.#recordSystemStep(queuedRun, "run.requeued", {
      status: queuedRun.status,
      recoveredBy: input.recoveredBy,
      recoveryAttempt: nextRecoveryAttempt,
      recoveryState: "requeued",
      recoveryReason: "automatic_requeue",
      recoveryStrategy: input.strategy
    });
    await this.#enqueueRun(run.sessionId, queuedRun.id);
    return true;
  }

  #readRecoveryAttempts(metadata: Run["metadata"]): number {
    const rootMetadata = isRecord(metadata) ? metadata : {};
    const recoveryMetadata = isRecord(rootMetadata.recovery) ? rootMetadata.recovery : {};
    const attemptsValue = rootMetadata.recoveryAttempts ?? recoveryMetadata.attempts;

    return typeof attemptsValue === "number" && Number.isFinite(attemptsValue) && attemptsValue >= 0
      ? Math.floor(attemptsValue)
      : 0;
  }

  #resolveRecoveryFailureContext(run: Run, strategy: AutomaticRecoveryStrategy): {
    recoveryAttempts: number;
    reason:
      | "fail_closed"
      | "requeue_unavailable"
      | "session_missing"
      | "waiting_tool_manual_resume_required"
      | "max_attempts_exhausted"
      | "requeue_not_possible";
    quarantined: boolean;
  } {
    const recoveryAttempts = this.#readRecoveryAttempts(run.metadata);
    if (strategy === "fail") {
      return {
        recoveryAttempts,
        reason: "fail_closed",
        quarantined: false
      };
    }

    if (!this.#runQueue) {
      return {
        recoveryAttempts,
        reason: "requeue_unavailable",
        quarantined: true
      };
    }

    if (!run.sessionId) {
      return {
        recoveryAttempts,
        reason: "session_missing",
        quarantined: true
      };
    }

    if (strategy === "requeue_running" && run.status === "waiting_tool") {
      return {
        recoveryAttempts,
        reason: "waiting_tool_manual_resume_required",
        quarantined: true
      };
    }

    if (recoveryAttempts >= this.#staleRunRecoveryMaxAttempts) {
      return {
        recoveryAttempts,
        reason: "max_attempts_exhausted",
        quarantined: true
      };
    }

    return {
      recoveryAttempts,
      reason: "requeue_not_possible",
      quarantined: true
    };
  }

  #buildRecoveryMetadata(
    run: Run,
    input: {
      attempts: number;
      outcome: "failed" | "requeued";
      recoveredBy: RecoveryActor;
      recoveredAt: string;
      reason: string;
      quarantined: boolean;
      strategy: AutomaticRecoveryStrategy | "manual";
      requestedBy?: string | undefined;
    }
  ): Record<string, unknown> {
    const rootMetadata = isRecord(run.metadata) ? run.metadata : {};
    const previousRecovery = isRecord(rootMetadata.recovery) ? rootMetadata.recovery : {};
    const { deadLetter: _previousDeadLetter, ...previousRecoveryWithoutDeadLetter } = previousRecovery;
    const manualRequeueCount =
      input.recoveredBy === "manual_operator_requeue"
        ? typeof previousRecovery.manualRequeueCount === "number" && Number.isFinite(previousRecovery.manualRequeueCount)
          ? Math.max(0, Math.floor(previousRecovery.manualRequeueCount)) + 1
          : 1
        : typeof previousRecovery.manualRequeueCount === "number" && Number.isFinite(previousRecovery.manualRequeueCount)
          ? Math.max(0, Math.floor(previousRecovery.manualRequeueCount))
          : undefined;
    const recoveryMetadata: Record<string, unknown> = {
      ...previousRecoveryWithoutDeadLetter,
      state: input.quarantined ? "quarantined" : input.outcome,
      strategy: input.strategy,
      attempts: input.attempts,
      maxAttempts: this.#staleRunRecoveryMaxAttempts,
      lastOutcome: input.outcome,
      lastRecoveredBy: input.recoveredBy,
      lastRecoveredAt: input.recoveredAt,
      reason: input.reason,
      ...(typeof manualRequeueCount === "number" ? { manualRequeueCount } : {}),
      ...(input.recoveredBy === "manual_operator_requeue"
        ? {
            lastManualRequeueAt: input.recoveredAt,
            ...(input.requestedBy ? { lastManualRequeueBy: input.requestedBy } : {})
          }
        : {}),
      ...(input.quarantined
        ? {
            deadLetter: {
              status: "quarantined",
              reason: input.reason,
              at: input.recoveredAt
            }
          }
        : {})
    };

    return {
      ...rootMetadata,
      recoveryAttempts: input.attempts,
      recoveredBy: input.recoveredBy,
      recoveredAt: input.recoveredAt,
      recovery: recoveryMetadata,
      ...(input.requestedBy ? { recoveryRequestedBy: input.requestedBy } : {})
    };
  }

  #isRecoveryManagedRun(run: Run): boolean {
    if (run.errorCode === "worker_recovery_failed") {
      return true;
    }

    const rootMetadata = isRecord(run.metadata) ? run.metadata : {};
    const recoveryMetadata = isRecord(rootMetadata.recovery) ? rootMetadata.recovery : undefined;
    const recoveryState = typeof recoveryMetadata?.state === "string" ? recoveryMetadata.state : undefined;

    return (
      recoveryState === "quarantined" ||
      recoveryState === "failed" ||
      recoveryState === "requeued" ||
      typeof rootMetadata.recoveryAttempts === "number"
    );
  }

  async #processRun(runId: string): Promise<void> {
    let run = await this.getRun(runId);
    const workspace = await this.getWorkspaceRecord(run.workspaceId);
    const session = run.sessionId ? await this.getSession(run.sessionId) : undefined;
    if (run.cancelRequestedAt) {
      if (session) {
        await this.#markRunCancelled(session.id, run);
      } else {
        await this.#setRunStatus(run, "cancelled", {
          endedAt: nowIso(),
          cancelRequestedAt: run.cancelRequestedAt ?? nowIso()
        });
      }
      return;
    }

    const startedAt = nowIso();
    run = await this.#setRunStatus(run, "running", {
      startedAt,
      heartbeatAt: startedAt
    });
    await this.#recordSystemStep(run, "run.started", {
      status: run.status
    });
    if (session) {
      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "run.started",
        data: {
          runId: run.id,
          sessionId: session.id,
          status: "running"
        }
      });
    }

    const abortController = new AbortController();
    this.#runAbortControllers.set(run.id, abortController);
    const runHeartbeat = setInterval(() => {
      void this.#refreshRunHeartbeat(run.id);
    }, this.#runHeartbeatIntervalMs);
    runHeartbeat.unref?.();
    const modelCallSteps = new Map<number, RunStep>();
    const runTimeoutMs = timeoutMsFromSeconds(workspace.agents[run.effectiveAgentName]?.policy?.runTimeoutSeconds);
    let runTimedOut = false;
    const runTimeout =
      runTimeoutMs !== undefined
        ? setTimeout(() => {
            runTimedOut = true;
            abortController.abort();
          }, runTimeoutMs)
        : undefined;
    let streamCoordinator: ModelStreamCoordinator<ModelExecutionInput> | undefined;
    let executionWorkspace = workspace;
    let executionLease: import("./types.js").WorkspaceExecutionLease | undefined;

    try {
      if (this.#workspaceExecutionProvider) {
        executionLease = await this.#workspaceExecutionProvider.acquire({
          workspace,
          run,
          ...(session ? { session } : {})
        });
        executionWorkspace = executionLease.workspace;
      }

      if (run.triggerType === "api_action") {
        await this.#processActionRun(executionWorkspace, run, session, abortController.signal);
        return;
      }

      if (!session) {
        throw new AppError(500, "session_required", `Run ${run.id} requires a session for message execution.`);
      }

      const allMessages = await this.#repairSessionHistoryIfNeeded(
        session.id,
        await this.#messageRepository.listBySessionId(session.id)
      );
      const executionContext: RunExecutionContext = {
        currentAgentName: run.effectiveAgentName,
        injectSystemReminder: false,
        delegatedRunIds: this.#agentCoordination.delegatedRunRecords(run).map((record) => record.childRunId)
      };
      const runtimeMessages = await this.#loadSessionRuntimeMessages(session.id, allMessages);
      const modelInput = await this.#modelInputs.buildModelInput(
        executionWorkspace,
        session,
        run,
        runtimeMessages,
        executionContext.currentAgentName
      );
      const hookedModelInput = await this.#applyBeforeModelHooks(executionWorkspace, session, run, modelInput);
      const runtimeTools = this.#buildRuntimeTools(executionWorkspace, run, session, executionContext);
      const activeToolServers = listVisibleEnabledToolServers(executionWorkspace, executionContext.currentAgentName);
      const runtimeToolNames = Object.keys(runtimeTools);
      streamCoordinator = new ModelStreamCoordinator({
        workspace: executionWorkspace,
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
          this.#modelInputs.buildModelInput(
            targetWorkspace,
            targetSession,
            targetRun,
            await this.#buildRuntimeMessagesForSession(targetSession.id, targetMessages),
            activeAgentName,
            injectSystemReminder
          ),
        applyBeforeModelHooks: (targetWorkspace, targetSession, targetRun, nextModelInput) =>
          this.#applyBeforeModelHooks(targetWorkspace, targetSession, targetRun, nextModelInput),
        getRun: (targetRunId) => this.getRun(targetRunId),
        getActiveToolNames: (agentName) => resolveActiveToolNamesForAgent(executionWorkspace, agentName),
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
        runStepRetryPolicy: (step) => this.#toolExecution.runStepRetryPolicy(step),
        normalizeJsonObject: (value) => this.#normalizeJsonObject(value),
        resolveToolSourceType,
        previewValue: (value, maxLength) => this.#previewValue(value, maxLength)
      });
      const observableRuntimeTools = this.#toolExecution.wrapRuntimeToolsForEvents({
        workspace: executionWorkspace,
        session,
        run,
        runtimeTools,
        executionContext,
        toolCallStartedAt: streamCoordinator.toolCallStartedAt,
        toolCallSteps: streamCoordinator.toolCallSteps,
        toolMessageMetadataByCallId: streamCoordinator.toolMessageMetadataByCallId
      });
      this.#logger?.debug?.("Runtime run starting model stream.", {
        workspaceId: executionWorkspace.id,
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
          signal: abortController.signal,
          ...(Object.keys(observableRuntimeTools).length > 0
            ? {
                tools: observableRuntimeTools
              }
            : {}),
          ...(activeToolServers.length > 0
            ? {
                toolServers: activeToolServers
              }
            : {}),
          maxSteps: executionWorkspace.agents[executionContext.currentAgentName]?.policy?.maxSteps ?? 8,
          parallelToolCalls: executionWorkspace.agents[executionContext.currentAgentName]?.policy?.parallelToolCalls,
          ...streamCoordinator.buildStreamOptions()
        }
      );

      for await (const chunk of response.chunks) {
        await streamCoordinator.consumeChunk(chunk);
      }

      const completed = await response.completed;
      if (this.#drainTimeoutRecoveredRuns.has(run.id)) {
        return;
      }
      const latestRun = await this.getRun(run.id);
      const hookedCompleted = await this.#applyAfterModelHooks(
        executionWorkspace,
        session,
        latestRun,
        streamCoordinator.latestHookedModelInput,
        completed
      );
      await this.#finalizeSuccessfulRun(
        executionWorkspace,
        session,
        latestRun,
        streamCoordinator.assistantMessage,
        hookedCompleted,
        streamCoordinator.finalAssistantStep,
        streamCoordinator.latestMessageGenerationMetadata
      );
    } catch (error) {
      const pendingModelStepStatus = runTimedOut ? "failed" : abortController.signal.aborted ? "cancelled" : "failed";
      if (streamCoordinator) {
        await streamCoordinator.completePendingModelSteps(
          pendingModelStepStatus,
          error instanceof Error ? error.message : "Unknown model execution error."
        );
      }
      if (abortController.signal.aborted) {
        if (this.#drainTimeoutRecoveredRuns.has(run.id)) {
          return;
        }

        if (runTimedOut) {
          this.#logger?.error?.("Runtime run timed out.", {
            workspaceId: executionWorkspace.id,
            sessionId: session?.id,
            runId: run.id,
            triggerType: run.triggerType,
            errorCode: "run_timed_out",
            errorMessage: runTimeoutMs ? `Run exceeded timeout after ${runTimeoutMs}ms.` : "Run exceeded the configured timeout."
          });
          await this.#runFinalization.finalizeTimedOutRun({
            workspace: executionWorkspace,
            session,
            runId: run.id,
            runTimeoutMs
          });
          return;
        }

        this.#logger?.warn?.("Runtime run cancelled.", {
          workspaceId: executionWorkspace.id,
          sessionId: session?.id,
          runId: run.id,
          triggerType: run.triggerType,
          status: "cancelled"
        });
        await this.#runFinalization.finalizeCancelledRun({
          session,
          runId: run.id
        });
        return;
      }

      if (this.#drainTimeoutRecoveredRuns.has(run.id)) {
        return;
      }

      const currentRun = await this.getRun(run.id);
      this.#logger?.error?.("Runtime run failed.", {
        workspaceId: executionWorkspace.id,
        sessionId: session?.id,
        runId: run.id,
        triggerType: run.triggerType,
        status: currentRun.status,
        errorCode: error instanceof AppError ? error.code : "model_stream_failed",
        errorMessage: error instanceof Error ? error.message : "Unknown streaming error."
      });
      await this.#runFinalization.finalizeFailedRun({
        workspace: executionWorkspace,
        session,
        runId: run.id,
        errorCode: error instanceof AppError ? error.code : "model_stream_failed",
        errorMessage: error instanceof Error ? error.message : "Unknown streaming error."
      });
    } finally {
      clearInterval(runHeartbeat);
      if (runTimeout) {
        clearTimeout(runTimeout);
      }
      this.#runAbortControllers.delete(run.id);
      this.#drainTimeoutRecoveredRuns.delete(run.id);
      if (executionLease) {
        try {
          await executionLease.release({
            dirty: !executionWorkspace.readOnly && executionWorkspace.kind === "project"
          });
        } catch (error) {
          this.#logger?.warn?.("Failed to release execution workspace lease.", {
            error: error instanceof Error ? error.message : String(error),
            workspaceId: executionWorkspace.id,
            runId: run.id
          });
        }
      }
    }
  }

  async #finalizeSuccessfulRun(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    assistantMessage: Extract<Message, { role: "assistant" }> | undefined,
    completed: ModelGenerateResponse,
    finalAssistantStep: ModelStepResult | undefined,
    messageMetadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    await this.#runFinalization.finalizeSuccessfulRun({
      workspace,
      session,
      run,
      assistantMessage,
      completed,
      finalAssistantStep,
      messageMetadata
    });
  }

  async #markRunCancelled(sessionId: string, run: Run): Promise<void> {
    await this.#runState.markRunCancelled(sessionId, run);
  }

  async #markRunTimedOut(run: Run, runTimeoutMs: number | undefined): Promise<Run> {
    return this.#runState.markRunTimedOut(run, runTimeoutMs);
  }

  async #setRunStatus(run: Run, nextStatus: Run["status"], patch: Partial<Run>): Promise<Run> {
    return this.#runState.setRunStatus(run, nextStatus, patch);
  }

  async #setRunStatusIfPossible(runId: string, nextStatus: Run["status"]): Promise<void> {
    await this.#runState.setRunStatusIfPossible(runId, nextStatus);
  }

  async #refreshRunHeartbeat(runId: string): Promise<void> {
    await this.#runState.refreshRunHeartbeat(runId);
  }

  async #updateRun(run: Run, patch: Partial<Run>): Promise<Run> {
    return this.#runState.updateRun(run, patch);
  }

  async #startRunStep(input: {
    runId: string;
    stepType: RunStepType;
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }): Promise<RunStep> {
    return this.#runSteps.startRunStep(input);
  }

  async #completeRunStep(
    step: RunStep,
    status: Extract<RunStepStatus, "completed" | "failed" | "cancelled">,
    output?: Record<string, unknown> | undefined
  ): Promise<RunStep> {
    return this.#runSteps.completeRunStep(step, status, output);
  }

  async #recordSystemStep(
    run: Run,
    name: string,
    output?: Record<string, unknown> | undefined
  ): Promise<RunStep> {
    return this.#runSteps.recordSystemStep(run, name, output);
  }

  #normalizeJsonObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return {
      value
    };
  }

  #normalizePromptMessages(rawMessages: unknown): ChatMessage[] {
    return normalizePromptMessages(rawMessages);
  }

  async #repairSessionHistoryIfNeeded(sessionId: string, messages: Message[]): Promise<Message[]> {
    return this.#sessionHistory.repairSessionHistoryIfNeeded(sessionId, messages);
  }

  #extractMessageDisplayText(message: Message): string {
    return extractMessageDisplayText(message);
  }

  #hasMeaningfulText(value: string | undefined): value is string {
    return hasMeaningfulText(value);
  }

  async #sessionHasStarted(sessionId: string): Promise<boolean> {
    const [messages, runs] = await Promise.all([
      this.#messageRepository.listBySessionId(sessionId),
      this.#runRepository.listBySessionId(sessionId)
    ]);
    return messages.length > 0 || runs.length > 0;
  }

  async #loadSessionRuntimeMessages(sessionId: string, persistedMessages?: Message[]): Promise<RuntimeMessage[]> {
    if (persistedMessages) {
      return this.#buildRuntimeMessagesForSession(sessionId, persistedMessages);
    }

    if (this.#runtimeMessageRepository) {
      const storedRuntimeMessages = await this.#runtimeMessageRepository.listBySessionId(sessionId);
      if (storedRuntimeMessages.length > 0) {
        return storedRuntimeMessages;
      }
    }

    return this.#buildRuntimeMessagesForSession(sessionId);
  }

  async #buildRuntimeMessagesForSession(sessionId: string, persistedMessages?: Message[]): Promise<RuntimeMessage[]> {
    const [messages, events] = await Promise.all([
      persistedMessages ? Promise.resolve(persistedMessages) : this.#messageRepository.listBySessionId(sessionId),
      this.#sessionEventStore.listSince(sessionId)
    ]);

    return buildSessionRuntimeMessages({
      messages,
      events
    });
  }

  #runtimeMessagesEqual(left: RuntimeMessage[], right: RuntimeMessage[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((message, index) => {
      const candidate = right[index];
      if (!candidate) {
        return false;
      }

      return (
        message.id === candidate.id &&
        message.sessionId === candidate.sessionId &&
        message.runId === candidate.runId &&
        message.role === candidate.role &&
        message.kind === candidate.kind &&
        message.createdAt === candidate.createdAt &&
        JSON.stringify(message.content) === JSON.stringify(candidate.content) &&
        JSON.stringify(message.metadata ?? null) === JSON.stringify(candidate.metadata ?? null)
      );
    });
  }

  #toTranscriptMessage(
    sessionId: string,
    message: TranscriptMessage,
    runtimeMessagesById: Map<string, RuntimeMessage>
  ): Message {
    const sourceRuntimeMessage = message.sourceMessageIds
      .map((sourceMessageId) => runtimeMessagesById.get(sourceMessageId))
      .find((candidate): candidate is RuntimeMessage => candidate !== undefined);
    const metadata = {
      ...(sourceRuntimeMessage?.metadata ?? {}),
      projectedView: message.view,
      projectedSemanticType: message.semanticType,
      projectedSourceMessageIds: message.sourceMessageIds,
      ...(message.metadata ? { projectionMetadata: message.metadata } : {})
    };

    const baseMessage = {
      id: sourceRuntimeMessage?.id ?? message.sourceMessageIds[0] ?? createId("msg"),
      sessionId,
      ...(sourceRuntimeMessage?.runId ? { runId: sourceRuntimeMessage.runId } : {}),
      metadata,
      createdAt: sourceRuntimeMessage?.createdAt ?? nowIso()
    };

    switch (message.role) {
      case "system":
        return {
          ...baseMessage,
          role: "system",
          content: typeof message.content === "string" ? message.content : extractTextFromContent(message.content)
        };
      case "user":
        return {
          ...baseMessage,
          role: "user",
          content: isMessageContentForRole("user", message.content) ? message.content : extractTextFromContent(message.content)
        };
      case "assistant":
        return {
          ...baseMessage,
          role: "assistant",
          content:
            isMessageContentForRole("assistant", message.content) ? message.content : extractTextFromContent(message.content)
        };
      case "tool":
        return {
          ...baseMessage,
          role: "tool",
          content: isMessageContentForRole("tool", message.content) ? message.content : []
        };
    }
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
        const accepted = await this.#agentCoordination.delegateAgentRun({
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
      awaitDelegatedRuns: async ({ runIds, mode }) => this.#agentCoordination.awaitDelegatedRuns(runIds, mode),
      switchAgent: async (targetAgentName, currentAgentName) => {
        await this.#agentCoordination.switchAgent({
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
    return this.#hookApplications.applyBeforeModelHooks(workspace, session, run, modelInput);
  }

  async #applyAfterModelHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: ModelExecutionInput,
    response: ModelGenerateResponse
  ): Promise<ModelGenerateResponse> {
    return this.#hookApplications.applyAfterModelHooks(workspace, session, run, modelInput, response);
  }

  async #applyContextHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_build" | "after_context_build",
    messages: ChatMessage[]
  ): Promise<ChatMessage[]> {
    return this.#hookApplications.applyContextHooks(workspace, session, run, eventName, messages);
  }

  async #applyBeforeToolDispatchHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string,
    toolName: string,
    toolCallId: string | undefined,
    input: unknown
  ): Promise<unknown> {
    return this.#hookApplications.applyBeforeToolDispatchHooks(
      workspace,
      session,
      run,
      activeAgentName,
      toolName,
      toolCallId,
      input
    );
  }

  async #applyAfterToolDispatchHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string,
    toolName: string,
    toolCallId: string | undefined,
    input: unknown,
    output: unknown
  ): Promise<unknown> {
    return this.#hookApplications.applyAfterToolDispatchHooks(
      workspace,
      session,
      run,
      activeAgentName,
      toolName,
      toolCallId,
      input,
      output
    );
  }

  async #runLifecycleHooks(
    workspace: WorkspaceRecord,
    session: Session | undefined,
    run: Run,
    eventName: "run_completed" | "run_failed"
  ): Promise<void> {
    await this.#hookApplications.runLifecycleHooks(workspace, session, run, eventName);
  }

  #collapseLeadingSystemMessages(
    messages: ChatMessage[]
  ): ChatMessage[] {
    return collapseLeadingSystemMessages(messages);
  }

  #serializeModelRequest(modelInput: ModelExecutionInput): Record<string, unknown> {
    return serializeModelRequest(modelInput);
  }

  #serializeModelCallStepInput(
    modelInput: ModelExecutionInput,
    activeToolNames: string[] | undefined,
    toolServers: WorkspaceRecord["toolServers"][string][],
    runtimeToolNames: string[],
    runtimeTools?: RuntimeToolSet | undefined
  ): Record<string, unknown> {
    return serializeModelCallStepInput(modelInput, activeToolNames, toolServers, runtimeToolNames, runtimeTools);
  }

  #serializeModelCallStepOutput(
    step: ModelStepResult,
    failedToolResults = this.#extractFailedToolResults(step)
  ): Record<string, unknown> {
    return serializeModelCallStepOutput(step, failedToolResults);
  }

  #extractFailedToolResults(step: ModelStepResult): ToolErrorContentPart[] {
    return extractFailedToolResults(step);
  }

  #summarizeMessageRoles(messages: ChatMessage[]): Record<string, number> {
    return summarizeMessageRoles(messages);
  }

  #previewValue(value: unknown, maxLength = 240): string {
    return previewValue(value, maxLength);
  }

  #applyModelRequestPatch(
    workspace: WorkspaceRecord,
    current: ModelExecutionInput,
    patch: Record<string, unknown>
  ): ModelExecutionInput {
    return applyModelRequestPatch(workspace, current, patch, {
      resolveModelForRun: (targetWorkspace, modelRef) => this.#modelInputs.resolveModelForRun(targetWorkspace, modelRef),
      collapseLeadingSystemMessages: (messages) => this.#collapseLeadingSystemMessages(messages),
      createModelExecutionInput: (input) => ({ ...input })
    });
  }

  #applyModelResponsePatch(response: ModelGenerateResponse, patch: Record<string, unknown>): ModelGenerateResponse {
    return applyModelResponsePatch(response, patch);
  }

  #buildGeneratedMessageMetadata(
    workspace: WorkspaceRecord,
    agentName: string,
    modelInput: Pick<ModelExecutionInput, "messages">,
    modelCallStep?: Pick<RunStep, "id" | "seq"> | undefined
  ): Record<string, unknown> {
    const systemMessages = modelInput.messages
      .filter((message): message is { role: "system"; content: string } => message.role === "system" && typeof message.content === "string")
      .map((message) => ({
        role: "system" as const,
        content: message.content
      }));
    const agentMode = workspace.agents[agentName]?.mode;

    return {
      agentName,
      effectiveAgentName: agentName,
      ...(agentMode ? { agentMode } : {}),
      ...(modelCallStep ? { modelCallStepId: modelCallStep.id, modelCallStepSeq: modelCallStep.seq } : {}),
      ...(systemMessages.length > 0 ? { systemMessages } : {})
    };
  }

  async #ensureAssistantMessage(
    session: Session,
    run: Run,
    currentMessage: Extract<Message, { role: "assistant" }> | undefined,
    allMessages?: Message[],
    content = "",
    metadata?: Record<string, unknown> | undefined
  ): Promise<Extract<Message, { role: "assistant" }>> {
    return this.#toolMessages.ensureAssistantMessage(session, run, currentMessage, allMessages, content, metadata);
  }

  async #persistAssistantToolCalls(
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
  ): Promise<void> {
    await this.#toolMessages.persistAssistantToolCalls(session, run, step, allMessages, metadata, toolMetadataByCallId);
  }

  async #persistAssistantStepText(
    session: Session,
    run: Run,
    step: ModelStepResult,
    currentMessage: Extract<Message, { role: "assistant" }> | undefined,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ): Promise<Extract<Message, { role: "assistant" }> | undefined> {
    return this.#toolMessages.persistAssistantStepText(session, run, step, currentMessage, allMessages, metadata);
  }

  async #persistToolResults(
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
  ): Promise<void> {
    await this.#toolMessages.persistToolResults(
      session,
      run,
      step,
      failedToolResults,
      persistedToolCalls,
      allMessages,
      metadata,
      toolMetadataByCallId
    );
  }

  async #processActionRun(
    workspace: WorkspaceRecord,
    run: Run,
    session: Session | undefined,
    signal: AbortSignal
  ): Promise<void> {
    await this.#actions.processActionRun(workspace, run, session, signal);
  }

  async #executeAction(
    workspace: WorkspaceRecord,
    action: WorkspaceRecord["actions"][string],
    run: Run,
    signal: AbortSignal | undefined,
    explicitInput?: unknown
  ): Promise<{ stdout: string; stderr: string; exitCode: number; output: string }> {
    return this.#actions.executeAction(workspace, action, run, signal, explicitInput);
  }

  async #recordToolCallAuditFromStep(
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ): Promise<void> {
    await this.#toolAudit.recordToolCallAuditFromStep(step, toolName, status);
  }

  #publicWorkspaceCatalog(workspace: WorkspaceRecord): RuntimeWorkspaceCatalog {
    const tools = workspace.catalog.tools ?? [];
    return {
      ...workspace.catalog,
      tools,
      nativeTools: [...NATIVE_TOOL_NAMES],
      runtimeTools: listRuntimeToolNamesForCatalog(workspace)
    };
  }

  async #listAllWorkspaceSessions(workspaceId: string): Promise<Session[]> {
    const pageSize = 200;
    const items: Session[] = [];

    for (let offset = 0; ; offset += pageSize) {
      const page = await this.#sessionRepository.listByWorkspaceId(workspaceId, pageSize, String(offset));
      items.push(...page);
      if (page.length < pageSize) {
        return items;
      }
    }
  }
}
