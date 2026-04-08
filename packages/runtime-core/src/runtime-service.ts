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
import { HookApplicationService } from "./runtime/hook-application.js";
import { HookService } from "./runtime/hooks.js";
import { ActionRunService } from "./runtime/action-runs.js";
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
  type SortOrder,
  type WorkspaceDeleteResult,
  type WorkspaceEntry,
  type WorkspaceEntryPage,
  type WorkspaceEntrySortBy,
  type WorkspaceFileContentResult,
  type WorkspaceFileDownloadResult,
  WorkspaceFileService
} from "./workspace-files.js";
import { buildAvailableAgentSwitchesMessage, buildAvailableSubagentsMessage } from "./agent-control.js";
import { NATIVE_TOOL_NAMES } from "./native-tools.js";
import { buildAvailableActionsMessage } from "./action-dispatch.js";
import { buildAvailableSkillsMessage } from "./skill-activation.js";
import { formatToolOutput } from "./tool-output.js";
import {
  assistantContentFromModelOutput,
  contentToPromptMessage,
  textContent
} from "./runtime-message-content.js";
import {
  activeToolNamesForAgent as resolveActiveToolNamesForAgent,
  buildEnvironmentMessage as composeEnvironmentMessage,
  buildRuntimeTools as createWorkspaceRuntimeTools,
  canDelegateFromAgent as canAgentDelegate,
  runtimeToolNamesForCatalog as listRuntimeToolNamesForCatalog,
  toolRetryPolicy as resolveToolRetryPolicy,
  toolSourceType as resolveToolSourceType,
  visibleEnabledToolServers as listVisibleEnabledToolServers,
  visibleLlmActions as listVisibleLlmActions,
  visibleLlmSkills as listVisibleLlmSkills
} from "./runtime-tooling.js";
import {
  type ActionRunAcceptedResult,
  type ActionRetryPolicy,
  type CancelRunResult,
  type CreateSessionMessageParams,
  type CreateSessionParams,
  type UpdateSessionParams,
  type CreateWorkspaceParams,
  type GenerateModelInput,
  type MessageListResult,
  type RuntimeServiceOptions,
  type SessionEvent,
  type ModelStepResult,
  type RuntimeToolSet,
  type TriggerActionRunParams,
  type ModelDefinition,
  type RunStepListResult,
  type SessionListResult,
  type RunStepStatus,
  type RunStepType,
  type RuntimeToolExecutionContext,
  type RuntimeWorkspaceCatalog,
  type WorkspaceListResult,
  type RunListResult,
  toPublicWorkspace,
  type WorkspaceRecord
} from "./types.js";
import { createId, nowIso, parseCursor } from "./utils.js";

interface ResolvedRunModel {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
}

interface ModelExecutionInput {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  maxTokens?: number | undefined;
  messages: ChatMessage[];
}

interface RunExecutionContext {
  currentAgentName: string;
  injectSystemReminder: boolean;
  delegatedRunIds: string[];
}

interface DelegatedRunRecord {
  childRunId: string;
  childSessionId: string;
  targetAgentName: string;
  parentAgentName: string;
}

interface AwaitedRunSummary {
  run: Run;
  outputContent?: string | undefined;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isActionRetryPolicy(value: unknown): value is ActionRetryPolicy {
  return value === "manual" || value === "safe";
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

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
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

export class RuntimeService {
  readonly #defaultModel: string;
  readonly #modelGateway: RuntimeServiceOptions["modelGateway"];
  readonly #logger: RuntimeServiceOptions["logger"];
  readonly #runHeartbeatIntervalMs: number;
  readonly #platformModels: Record<string, ModelDefinition>;
  readonly #workspaceRepository: RuntimeServiceOptions["workspaceRepository"];
  readonly #sessionRepository: RuntimeServiceOptions["sessionRepository"];
  readonly #messageRepository: RuntimeServiceOptions["messageRepository"];
  readonly #runRepository: RuntimeServiceOptions["runRepository"];
  readonly #runStepRepository: RuntimeServiceOptions["runStepRepository"];
  readonly #sessionEventStore: RuntimeServiceOptions["sessionEventStore"];
  readonly #runQueue: RuntimeServiceOptions["runQueue"];
  readonly #toolCallAuditRepository: RuntimeServiceOptions["toolCallAuditRepository"];
  readonly #workspaceDeletionHandler: RuntimeServiceOptions["workspaceDeletionHandler"];
  readonly #workspaceInitializer: RuntimeServiceOptions["workspaceInitializer"];
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #sessionHistory: SessionHistoryService;
  readonly #runSteps: RunStepService;
  readonly #runState: RunStateService;
  readonly #hooks: HookService;
  readonly #hookApplications: HookApplicationService<ModelExecutionInput>;
  readonly #toolAudit: ToolAuditService;
  readonly #toolExecution: ToolExecutionService;
  readonly #toolMessages: ToolMessageService;
  readonly #actions: ActionRunService;
  readonly #sessionChains = new Map<string, Promise<void>>();
  readonly #runAbortControllers = new Map<string, AbortController>();

  constructor(options: RuntimeServiceOptions) {
    this.#defaultModel = options.defaultModel;
    this.#modelGateway = options.modelGateway;
    this.#logger = options.logger;
    this.#runHeartbeatIntervalMs = Math.max(50, options.runHeartbeatIntervalMs ?? 5_000);
    this.#platformModels = options.platformModels ?? {};
    this.#workspaceRepository = options.workspaceRepository;
    this.#sessionRepository = options.sessionRepository;
    this.#messageRepository = options.messageRepository;
    this.#runRepository = options.runRepository;
    this.#runStepRepository = options.runStepRepository;
    this.#sessionEventStore = options.sessionEventStore;
    this.#runQueue = options.runQueue;
    this.#toolCallAuditRepository = options.toolCallAuditRepository;
    this.#workspaceDeletionHandler = options.workspaceDeletionHandler;
    this.#workspaceInitializer = options.workspaceInitializer;
    this.#workspaceFiles = new WorkspaceFileService();
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
    this.#hooks = new HookService({
      defaultModel: this.#defaultModel,
      modelGateway: this.#modelGateway,
      hookRunAuditRepository: options.hookRunAuditRepository,
      startRunStep: (input) => this.#runSteps.startRunStep(input),
      completeRunStep: (step, status, output) => this.#runSteps.completeRunStep(step, status, output),
      appendEvent: (input) => this.#appendEvent(input),
      resolveModelForRun: (workspace, modelRef) => this.#resolveModelForRun(workspace, modelRef),
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
  }

  async createWorkspace({ input }: CreateWorkspaceParams): Promise<import("@oah/api-contracts").Workspace> {
    if (!this.#workspaceInitializer) {
      throw new AppError(
        501,
        "workspace_initializer_not_configured",
        "Workspace creation requires a configured template initializer."
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
    const items = workspaces.map((workspace) => toPublicWorkspace(workspace));
    const nextCursor = workspaces.length === pageSize ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.#workspaceRepository.getById(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", `Workspace ${workspaceId} was not found.`);
    }

    return workspace;
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
    return this.#workspaceFiles.listEntries(await this.getWorkspaceRecord(workspaceId), input);
  }

  async getWorkspaceFileContent(
    workspaceId: string,
    input: { path: string; encoding: "utf8" | "base64"; maxBytes?: number | undefined }
  ): Promise<WorkspaceFileContentResult> {
    return this.#workspaceFiles.getFileContent(await this.getWorkspaceRecord(workspaceId), input);
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
    return this.#workspaceFiles.putFileContent(await this.getWorkspaceRecord(workspaceId), input);
  }

  async uploadWorkspaceFile(
    workspaceId: string,
    input: { path: string; data: Buffer; overwrite?: boolean | undefined; ifMatch?: string | undefined }
  ): Promise<WorkspaceEntry> {
    return this.#workspaceFiles.uploadFile(await this.getWorkspaceRecord(workspaceId), input);
  }

  async createWorkspaceDirectory(
    workspaceId: string,
    input: { path: string; createParents: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#workspaceFiles.createDirectory(await this.getWorkspaceRecord(workspaceId), input);
  }

  async deleteWorkspaceEntry(
    workspaceId: string,
    input: { path: string; recursive: boolean }
  ): Promise<WorkspaceDeleteResult> {
    return this.#workspaceFiles.deleteEntry(await this.getWorkspaceRecord(workspaceId), input);
  }

  async moveWorkspaceEntry(
    workspaceId: string,
    input: { sourcePath: string; targetPath: string; overwrite: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#workspaceFiles.moveEntry(await this.getWorkspaceRecord(workspaceId), input);
  }

  async getWorkspaceFileDownload(
    workspaceId: string,
    targetPath: string
  ): Promise<WorkspaceFileDownloadResult> {
    return this.#workspaceFiles.getFileDownload(await this.getWorkspaceRecord(workspaceId), targetPath);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    await this.#workspaceDeletionHandler?.deleteWorkspace(workspace);
    await this.#workspaceRepository.delete(workspaceId);
  }

  async createSession({ workspaceId, caller, input }: CreateSessionParams): Promise<Session> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    const now = nowIso();
    const activeAgentName = input.agentName ?? this.#resolveWorkspaceDefaultAgentName(workspace);
    const modelRef = this.#normalizeSessionModelRef(workspace, input.modelRef);
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
      const normalizedModelRef = input.modelRef === null ? undefined : this.#normalizeSessionModelRef(workspace, input.modelRef);
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
    input
  }: TriggerActionRunParams): Promise<ActionRunAcceptedResult> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (workspace.kind === "chat") {
      throw new AppError(400, "actions_not_supported", `Workspace ${workspaceId} does not allow action execution.`);
    }

    const action = workspace.actions[actionName];
    if (!action) {
      throw new AppError(404, "action_not_found", `Action ${actionName} was not found in workspace ${workspaceId}.`);
    }

    if (!action.callableByApi) {
      throw new AppError(403, "action_not_callable_by_api", `Action ${actionName} cannot be triggered by API.`);
    }

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

    const now = nowIso();
    const run: Run = {
      id: createId("run"),
      workspaceId,
      ...(session ? { sessionId: session.id } : {}),
      initiatorRef: caller.subjectRef,
      triggerType: "api_action",
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
    if (session) {
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
    }

    await this.#enqueueRun(session?.id ?? run.id, run.id);

    return session
      ? {
          runId: run.id,
          status: "queued",
          actionName,
          sessionId: session.id
        }
      : {
          runId: run.id,
          status: "queued",
          actionName
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

  async recoverStaleRuns(options?: { staleBefore?: string | undefined; limit?: number | undefined }): Promise<{ recoveredRunIds: string[] }> {
    const staleBefore = options?.staleBefore ?? new Date(Date.now() - this.#runHeartbeatIntervalMs * 3).toISOString();
    const recoverableRuns = await this.#runRepository.listRecoverableActiveRuns(staleBefore, options?.limit ?? 100);
    const recoveredRunIds: string[] = [];

    for (const run of recoverableRuns) {
      const currentRun = await this.#runRepository.getById(run.id);
      if (!currentRun || (currentRun.status !== "running" && currentRun.status !== "waiting_tool")) {
        continue;
      }

      const endedAt = nowIso();
      const failedRun = await this.#updateRun(currentRun, {
        status: "failed",
        endedAt,
        errorCode: "worker_recovery_failed",
        errorMessage: "Run was recovered as failed after worker heartbeat expired."
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
            recoveredBy: "worker_startup"
          }
        });
      }

      await this.#recordSystemStep(failedRun, "run.failed", {
        status: failedRun.status,
        errorCode: failedRun.errorCode,
        errorMessage: failedRun.errorMessage,
        recoveredBy: "worker_startup"
      });
      recoveredRunIds.push(failedRun.id);
    }

    return { recoveredRunIds };
  }

  async #appendEvent(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    return this.#sessionEventStore.append(input);
  }

  async #enqueueRun(sessionId: string, runId: string): Promise<void> {
    if (this.#runQueue) {
      await this.#runQueue.enqueue(sessionId, runId);
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

    try {
      if (run.triggerType === "api_action") {
        await this.#processActionRun(workspace, run, session, abortController.signal);
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
        delegatedRunIds: this.#delegatedRunRecords(run).map((record) => record.childRunId)
      };
      const modelInput = await this.#buildModelInput(
        workspace,
        session,
        run,
        allMessages,
        executionContext.currentAgentName
      );
      const hookedModelInput = await this.#applyBeforeModelHooks(workspace, session, run, modelInput);
      const runtimeTools = this.#buildRuntimeTools(workspace, run, session, executionContext);
      const activeToolServers = listVisibleEnabledToolServers(workspace, executionContext.currentAgentName);
      const runtimeToolNames = Object.keys(runtimeTools);
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
        buildModelInput: (
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
            targetMessages,
            activeAgentName,
            injectSystemReminder
          ),
        applyBeforeModelHooks: (targetWorkspace, targetSession, targetRun, nextModelInput) =>
          this.#applyBeforeModelHooks(targetWorkspace, targetSession, targetRun, nextModelInput),
        getRun: (targetRunId) => this.getRun(targetRunId),
        getActiveToolNames: (agentName) => resolveActiveToolNamesForAgent(workspace, agentName),
        startRunStep: (input) => this.#startRunStep(input),
        completeRunStep: (step, status, output) => this.#completeRunStep(step, status, output),
        setRunStatusIfPossible: (targetRunId, nextStatus) => this.#setRunStatusIfPossible(targetRunId, nextStatus),
        ensureAssistantMessage: (targetSession, targetRun, currentMessage, targetMessages, content, metadata) =>
          this.#ensureAssistantMessage(targetSession, targetRun, currentMessage, targetMessages, content, metadata),
        persistAssistantToolCalls: (targetSession, targetRun, step, targetMessages, metadata) =>
          this.#persistAssistantToolCalls(targetSession, targetRun, step, targetMessages, metadata),
        persistToolResults: (targetSession, targetRun, step, failedToolResults, persistedToolCalls, targetMessages, metadata) =>
          this.#persistToolResults(
            targetSession,
            targetRun,
            step,
            failedToolResults,
            persistedToolCalls,
            targetMessages,
            metadata
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
        workspace,
        session,
        run,
        runtimeTools,
        executionContext,
        toolCallStartedAt: streamCoordinator.toolCallStartedAt,
        toolCallSteps: streamCoordinator.toolCallSteps
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
          maxSteps: workspace.agents[executionContext.currentAgentName]?.policy?.maxSteps ?? 8,
          parallelToolCalls: workspace.agents[executionContext.currentAgentName]?.policy?.parallelToolCalls,
          ...streamCoordinator.buildStreamOptions()
        }
      );

      for await (const chunk of response.chunks) {
        await streamCoordinator.consumeChunk(chunk);
      }

      const completed = await response.completed;
      const latestRun = await this.getRun(run.id);
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
      const pendingModelStepStatus = runTimedOut ? "failed" : abortController.signal.aborted ? "cancelled" : "failed";
      if (streamCoordinator) {
        await streamCoordinator.completePendingModelSteps(
          pendingModelStepStatus,
          error instanceof Error ? error.message : "Unknown model execution error."
        );
      }
      if (abortController.signal.aborted) {
        if (runTimedOut) {
          const timedOutRun = await this.#markRunTimedOut(await this.getRun(run.id), runTimeoutMs);
          if (session) {
            await this.#appendEvent({
              sessionId: session.id,
              runId: timedOutRun.id,
              event: "run.failed",
              data: {
                runId: timedOutRun.id,
                sessionId: session.id,
                status: timedOutRun.status,
                errorCode: timedOutRun.errorCode ?? "run_timed_out",
                errorMessage: timedOutRun.errorMessage ?? "Run exceeded the configured timeout."
              }
            });
          }
          await this.#recordSystemStep(timedOutRun, "run.timed_out", {
            status: timedOutRun.status,
            ...(timedOutRun.errorCode ? { errorCode: timedOutRun.errorCode } : {}),
            ...(timedOutRun.errorMessage ? { errorMessage: timedOutRun.errorMessage } : {})
          });
          await this.#runLifecycleHooks(workspace, session, timedOutRun, "run_failed");
          return;
        }

        if (session) {
          await this.#markRunCancelled(session.id, await this.getRun(run.id));
        } else {
          const cancelledRun = await this.#setRunStatus(await this.getRun(run.id), "cancelled", {
            endedAt: nowIso(),
            cancelRequestedAt: nowIso()
          });
          await this.#recordSystemStep(cancelledRun, "run.cancelled", {
            status: cancelledRun.status
          });
        }
        return;
      }

      const currentRun = await this.getRun(run.id);
      this.#logger?.error?.("Runtime run failed.", {
        workspaceId: workspace.id,
        sessionId: session?.id,
        runId: run.id,
        triggerType: run.triggerType,
        status: currentRun.status,
        errorCode: error instanceof AppError ? error.code : "model_stream_failed",
        errorMessage: error instanceof Error ? error.message : "Unknown streaming error."
      });
      const failedRun =
        currentRun.status === "failed" || currentRun.status === "timed_out"
          ? currentRun
          : await this.#setRunStatus(currentRun, "failed", {
              endedAt: nowIso(),
              errorCode: error instanceof AppError ? error.code : "model_stream_failed",
              errorMessage: error instanceof Error ? error.message : "Unknown streaming error."
            });

      if (session) {
        await this.#appendEvent({
          sessionId: session.id,
          runId: failedRun.id,
          event: "run.failed",
          data: {
            runId: failedRun.id,
            sessionId: session.id,
            status: failedRun.status,
            errorCode: failedRun.errorCode ?? (error instanceof AppError ? error.code : "model_stream_failed"),
            errorMessage: failedRun.errorMessage ?? "Unknown streaming error."
          }
        });
      }

      await this.#recordSystemStep(failedRun, failedRun.status === "timed_out" ? "run.timed_out" : "run.failed", {
        status: failedRun.status,
        ...(failedRun.errorCode ? { errorCode: failedRun.errorCode } : {}),
        ...(failedRun.errorMessage ? { errorMessage: failedRun.errorMessage } : {})
      });

      await this.#runLifecycleHooks(workspace, session, failedRun, "run_failed");
    } finally {
      clearInterval(runHeartbeat);
      if (runTimeout) {
        clearTimeout(runTimeout);
      }
      this.#runAbortControllers.delete(run.id);
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
    const finalizedAssistantContent = assistantContentFromModelOutput({
      text: completed.text,
      content: Array.isArray(completed.content) ? completed.content : finalAssistantStep?.content,
      reasoning: Array.isArray(completed.reasoning) ? completed.reasoning : finalAssistantStep?.reasoning
    });
    const latestRun = await this.getRun(run.id);
    const persistedAssistantMessage = await this.#ensureAssistantMessage(
      session,
      latestRun,
      assistantMessage,
      undefined,
      typeof finalizedAssistantContent === "string" ? finalizedAssistantContent : completed.text,
      messageMetadata ?? this.#buildGeneratedMessageMetadata(workspace, latestRun.effectiveAgentName, { messages: [] })
    );
    const updatedMessage =
      JSON.stringify(persistedAssistantMessage.content) === JSON.stringify(finalizedAssistantContent)
        ? persistedAssistantMessage
        : await this.#messageRepository.update({
            ...persistedAssistantMessage,
            content: finalizedAssistantContent
          });

    await this.#appendEvent({
      sessionId: session.id,
      runId: run.id,
      event: "message.completed",
      data: {
        runId: run.id,
        messageId: updatedMessage.id,
        content: updatedMessage.content,
        finishReason: completed.finishReason ?? "stop"
      }
    });

    const endedAt = nowIso();
    const updatedRun = await this.#setRunStatus(latestRun, "completed", {
      endedAt
    });
    await this.#recordSystemStep(updatedRun, "run.completed", {
      status: updatedRun.status
    });

    await this.#sessionRepository.update({
      ...session,
      activeAgentName: updatedRun.effectiveAgentName,
      lastRunAt: endedAt,
      updatedAt: endedAt
    });

    await this.#appendEvent({
      sessionId: session.id,
      runId: updatedRun.id,
      event: "run.completed",
      data: {
        runId: updatedRun.id,
        sessionId: session.id,
        status: updatedRun.status
      }
    });

    await this.#runLifecycleHooks(await this.getWorkspaceRecord(run.workspaceId), session, updatedRun, "run_completed");
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

  #formatSystemReminder(reminder: string): string {
    return `<system_reminder>\n${reminder}\n</system_reminder>`;
  }

  #withInjectedSystemReminder(messages: ChatMessage[], reminder: string): ChatMessage[] {
    let lastUserMessageIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        lastUserMessageIndex = index;
        break;
      }
    }

    if (lastUserMessageIndex === -1) {
      return messages;
    }

    const userMessage = messages[lastUserMessageIndex];
    if (!userMessage || userMessage.role !== "user") {
      return messages;
    }

    const reminderBlock = this.#formatSystemReminder(reminder);
    const updatedMessages = [...messages];
    updatedMessages[lastUserMessageIndex] = {
      ...userMessage,
      content:
        typeof userMessage.content === "string"
          ? this.#hasMeaningfulText(userMessage.content)
            ? `${reminderBlock}\n\n${userMessage.content}`
            : reminderBlock
          : [{ type: "text", text: reminderBlock }, ...userMessage.content]
    };

    return updatedMessages;
  }

  async #buildModelInput(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    messages: Message[],
    activeAgentName: string,
    forceSystemReminder = false
  ): Promise<ModelExecutionInput> {
    const activeAgent = workspace.agents[activeAgentName];
    const inheritedModelRef =
      typeof run.metadata?.inheritedModelRef === "string" ? run.metadata.inheritedModelRef : undefined;
    const resolvedModel = this.#resolveModelForRun(workspace, session.modelRef ?? activeAgent?.modelRef ?? inheritedModelRef);
    let contextMessages = await this.#applyContextHooks(
      workspace,
      session,
      run,
      "before_context_build",
      messages.map((message) => contentToPromptMessage(message.role, message.content))
    );
    const promptMessages: Array<{ role: "system"; content: string }> = this.#buildStaticPromptMessages(
      workspace,
      activeAgentName,
      resolvedModel
    );

    if (activeAgent?.systemReminder && this.#shouldInjectSystemReminder(messages, activeAgentName, forceSystemReminder)) {
      contextMessages = this.#withInjectedSystemReminder(contextMessages, activeAgent.systemReminder);
    }

    contextMessages = await this.#applyContextHooks(workspace, session, run, "after_context_build", [
      ...promptMessages,
      ...contextMessages
    ]);

    return {
      model: resolvedModel.model,
      canonicalModelRef: resolvedModel.canonicalModelRef,
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
      ...(activeAgent?.temperature !== undefined ? { temperature: activeAgent.temperature } : {}),
      ...(activeAgent?.topP !== undefined ? { topP: activeAgent.topP } : {}),
      ...(activeAgent?.maxTokens !== undefined ? { maxTokens: activeAgent.maxTokens } : {}),
      messages: this.#collapseLeadingSystemMessages(contextMessages)
    };
  }

  #latestMessageAgentName(messages: Message[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role === "system") {
        continue;
      }

      // Ignore the newest user turn; we only care about the previously active agent.
      if (index === messages.length - 1 && message.role === "user") {
        continue;
      }

      const metadata = isRecord(message.metadata) ? message.metadata : undefined;
      if (typeof metadata?.effectiveAgentName === "string" && metadata.effectiveAgentName.length > 0) {
        return metadata.effectiveAgentName;
      }

      if (typeof metadata?.agentName === "string" && metadata.agentName.length > 0) {
        return metadata.agentName;
      }
    }

    return undefined;
  }

  #shouldInjectSystemReminder(messages: Message[], activeAgentName: string, forceSystemReminder = false): boolean {
    if (forceSystemReminder) {
      return true;
    }

    const latestAgentName = this.#latestMessageAgentName(messages);
    return latestAgentName !== undefined && latestAgentName !== activeAgentName;
  }

  #resolveModelForRun(
    workspace: WorkspaceRecord,
    modelRef?: string | undefined
  ): ResolvedRunModel {
    if (!modelRef || modelRef.length === 0) {
      const defaultPlatformModel = this.#platformModels[this.#defaultModel];
      return {
        model: this.#defaultModel,
        canonicalModelRef: `platform/${this.#defaultModel}`,
        ...(defaultPlatformModel ? { provider: defaultPlatformModel.provider, modelDefinition: defaultPlatformModel } : {})
      };
    }

    if (modelRef.startsWith("platform/")) {
      const platformModelName = modelRef.slice("platform/".length);
      const platformModel = this.#platformModels[platformModelName];
      return {
        model: platformModelName,
        canonicalModelRef: modelRef,
        ...(platformModel ? { provider: platformModel.provider, modelDefinition: platformModel } : {})
      };
    }

    if (modelRef.startsWith("workspace/")) {
      const workspaceModelName = modelRef.slice("workspace/".length);
      const workspaceModel = workspace.workspaceModels[workspaceModelName];
      if (!workspaceModel) {
        throw new AppError(
          404,
          "model_not_found",
          `Workspace model ${workspaceModelName} was not found in workspace ${workspace.id}.`
        );
      }

      return {
        model: modelRef,
        canonicalModelRef: modelRef,
        provider: workspaceModel.provider,
        modelDefinition: workspaceModel
      };
    }

    if (workspace.workspaceModels[modelRef]) {
      return {
        model: `workspace/${modelRef}`,
        canonicalModelRef: `workspace/${modelRef}`,
        provider: workspace.workspaceModels[modelRef].provider,
        modelDefinition: workspace.workspaceModels[modelRef]
      };
    }

    if (this.#platformModels[modelRef]) {
      return {
        model: modelRef,
        canonicalModelRef: `platform/${modelRef}`,
        provider: this.#platformModels[modelRef].provider,
        modelDefinition: this.#platformModels[modelRef]
      };
    }

    return {
      model: modelRef,
      canonicalModelRef: modelRef
    };
  }

  #normalizeSessionModelRef(workspace: WorkspaceRecord, modelRef?: string): string | undefined {
    const candidate = modelRef?.trim();
    if (!candidate) {
      return undefined;
    }

    if (candidate.startsWith("platform/")) {
      const platformModelName = candidate.slice("platform/".length);
      if (!this.#platformModels[platformModelName]) {
        throw new AppError(404, "model_not_found", `Platform model ${platformModelName} was not found.`);
      }

      return candidate;
    }

    if (candidate.startsWith("workspace/")) {
      const workspaceModelName = candidate.slice("workspace/".length);
      if (!workspace.workspaceModels[workspaceModelName]) {
        throw new AppError(404, "model_not_found", `Workspace model ${workspaceModelName} was not found in workspace ${workspace.id}.`);
      }

      return candidate;
    }

    if (workspace.workspaceModels[candidate]) {
      return `workspace/${candidate}`;
    }

    if (this.#platformModels[candidate]) {
      return `platform/${candidate}`;
    }

    throw new AppError(404, "model_not_found", `Model ${candidate} was not found in workspace ${workspace.id}.`);
  }

  async #sessionHasStarted(sessionId: string): Promise<boolean> {
    const [messages, runs] = await Promise.all([
      this.#messageRepository.listBySessionId(sessionId),
      this.#runRepository.listBySessionId(sessionId)
    ]);
    return messages.length > 0 || runs.length > 0;
  }

  #buildStaticPromptMessages(
    workspace: WorkspaceRecord,
    activeAgentName: string,
    resolvedModel: ResolvedRunModel
  ): Array<{ role: "system"; content: string }> {
    const activeAgent = workspace.agents[activeAgentName];
    const systemPromptSettings = workspace.settings.systemPrompt;
    const compose = systemPromptSettings?.compose ?? {
      order: [
        "base",
        "llm_optimized",
        "agent",
        "actions",
        "project_agents_md",
        "skills",
        "agent_switches",
        "subagents",
        "environment"
      ] as const,
      includeEnvironment: false
    };
    const visibleActions = activeAgent ? listVisibleLlmActions(workspace, activeAgentName) : [];
    const visibleSkills = activeAgent ? listVisibleLlmSkills(workspace, activeAgentName) : [];
    const agentSwitchMessage = this.#buildAgentSwitchMessage(workspace, activeAgentName);
    const availableSubagentsMessage = this.#buildAvailableSubagentsMessage(workspace, activeAgentName);
    const environmentMessage =
      compose.includeEnvironment && workspace.kind === "project"
        ? this.#buildEnvironmentMessage(workspace, activeAgentName)
        : undefined;
    const orderedMessages: Array<{ role: "system"; content: string }> = [];

    for (const segment of compose.order) {
      switch (segment) {
        case "base":
          if (systemPromptSettings?.base?.content) {
            orderedMessages.push({
              role: "system",
              content: systemPromptSettings.base.content
            });
          }
          break;
        case "llm_optimized": {
          const optimizedPrompt = this.#resolveLlmOptimizedPrompt(workspace, resolvedModel);
          if (optimizedPrompt) {
            orderedMessages.push({
              role: "system",
              content: optimizedPrompt
            });
          }
          break;
        }
        case "agent":
          if (activeAgent) {
            orderedMessages.push({
              role: "system",
              content: activeAgent.prompt
            });
          }
          break;
        case "actions":
          if (visibleActions.length > 0) {
            orderedMessages.push({
              role: "system",
              content: buildAvailableActionsMessage(visibleActions)
            });
          }
          break;
        case "project_agents_md":
          if (workspace.projectAgentsMd) {
            orderedMessages.push({
              role: "system",
              content: workspace.projectAgentsMd
            });
          }
          break;
        case "skills":
          if (visibleSkills.length > 0) {
            orderedMessages.push({
              role: "system",
              content: buildAvailableSkillsMessage(visibleSkills)
            });
          }
          break;
        case "agent_switches":
          if (agentSwitchMessage) {
            orderedMessages.push({
              role: "system",
              content: agentSwitchMessage
            });
          }
          break;
        case "subagents":
          if (availableSubagentsMessage) {
            orderedMessages.push({
              role: "system",
              content: availableSubagentsMessage
            });
          }
          break;
        case "environment":
          if (environmentMessage) {
            orderedMessages.push({
              role: "system",
              content: environmentMessage
            });
          }
          break;
      }
    }

    return orderedMessages;
  }

  #resolveLlmOptimizedPrompt(workspace: WorkspaceRecord, resolvedModel: ResolvedRunModel): string | undefined {
    const llmOptimized = workspace.settings.systemPrompt?.llmOptimized;
    if (!llmOptimized) {
      return undefined;
    }

    return (
      llmOptimized.models?.[resolvedModel.canonicalModelRef]?.content ??
      (resolvedModel.provider ? llmOptimized.providers?.[resolvedModel.provider]?.content : undefined)
    );
  }

  #buildEnvironmentMessage(workspace: WorkspaceRecord, activeAgentName: string): string {
    return composeEnvironmentMessage(workspace, activeAgentName);
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
      executeAction: async (action, input, context) =>
        this.#executeAction(workspace, action, run, context.abortSignal, input),
      delegateAgent: async ({ targetAgentName, task, handoffSummary, taskId }, currentAgentName) => {
        const accepted = await this.#delegateAgentRun(
          workspace,
          session,
          run,
          currentAgentName,
          targetAgentName,
          task,
          handoffSummary,
          taskId
        );
        executionContext.delegatedRunIds.push(accepted.childRunId);
        return accepted;
      },
      awaitDelegatedRuns: async ({ runIds, mode }) => this.#awaitDelegatedRuns(run, runIds, mode),
      switchAgent: async (targetAgentName, currentAgentName) => {
        const switchStep = await this.#startRunStep({
          runId: run.id,
          stepType: "agent_switch",
          name: `${currentAgentName}->${targetAgentName}`,
          agentName: currentAgentName,
          input: {
            fromAgent: currentAgentName,
            toAgent: targetAgentName
          }
        });
        await this.#appendEvent({
          sessionId: session.id,
          runId: run.id,
          event: "agent.switch.requested",
          data: {
            runId: run.id,
            sessionId: session.id,
            fromAgent: currentAgentName,
            toAgent: targetAgentName
          }
        });

        const latestRun = await this.getRun(run.id);
        const nextSwitchCount = (latestRun.switchCount ?? 0) + 1;
        await this.#updateRun(latestRun, {
          effectiveAgentName: targetAgentName,
          switchCount: nextSwitchCount
        });
        executionContext.currentAgentName = targetAgentName;
        executionContext.injectSystemReminder = true;
        await this.#completeRunStep(switchStep, "completed", {
          fromAgent: currentAgentName,
          toAgent: targetAgentName,
          switchCount: nextSwitchCount
        });

        await this.#appendEvent({
          sessionId: session.id,
          runId: run.id,
          event: "agent.switched",
          data: {
            runId: run.id,
            sessionId: session.id,
            fromAgent: currentAgentName,
            toAgent: targetAgentName,
            switchCount: nextSwitchCount
          }
        });
      }
    });
  }

  #buildAgentSwitchMessage(workspace: WorkspaceRecord, activeAgentName: string): string | undefined {
    if (workspace.kind === "chat") {
      return undefined;
    }

    const currentAgent = workspace.agents[activeAgentName];
    const message = buildAvailableAgentSwitchesMessage(activeAgentName, currentAgent, workspace.agents);
    return message.length > 0 ? message : undefined;
  }

  #buildAvailableSubagentsMessage(workspace: WorkspaceRecord, activeAgentName: string): string | undefined {
    if (workspace.kind === "chat") {
      return undefined;
    }

    if (!canAgentDelegate(workspace, activeAgentName)) {
      return undefined;
    }

    const currentAgent = workspace.agents[activeAgentName];
    const message = buildAvailableSubagentsMessage(activeAgentName, currentAgent, workspace.agents);
    return message.length > 0 ? message : undefined;
  }

  #delegatedRunRecords(run: Run): DelegatedRunRecord[] {
    const rawRecords = run.metadata?.delegatedRuns;
    if (!Array.isArray(rawRecords)) {
      return [];
    }

    return rawRecords.flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { childRunId?: unknown }).childRunId === "string" &&
        typeof (entry as { childSessionId?: unknown }).childSessionId === "string" &&
        typeof (entry as { targetAgentName?: unknown }).targetAgentName === "string" &&
        typeof (entry as { parentAgentName?: unknown }).parentAgentName === "string"
      ) {
        return [
          {
            childRunId: (entry as { childRunId: string }).childRunId,
            childSessionId: (entry as { childSessionId: string }).childSessionId,
            targetAgentName: (entry as { targetAgentName: string }).targetAgentName,
            parentAgentName: (entry as { parentAgentName: string }).parentAgentName
          }
        ];
      }

      return [];
    });
  }

  async #delegateAgentRun(
    workspace: WorkspaceRecord,
    parentSession: Session,
    parentRun: Run,
    currentAgentName: string,
    targetAgentName: string | undefined,
    task: string,
    handoffSummary?: string | undefined,
    taskId?: string | undefined
  ): Promise<{ childSessionId: string; childRunId: string; targetAgentName: string }> {
    if (!canAgentDelegate(workspace, currentAgentName)) {
      throw new AppError(
        403,
        "agent_delegate_not_allowed",
        `Agent ${currentAgentName} is not allowed to delegate subagent work.`
      );
    }

    const resumedSession = taskId ? await this.#sessionRepository.getById(taskId) : null;
    if (taskId && !resumedSession) {
      throw new AppError(404, "task_not_found", `Subagent task ${taskId} was not found.`);
    }

    if (resumedSession && resumedSession.workspaceId !== workspace.id) {
      throw new AppError(
        409,
        "task_workspace_mismatch",
        `Subagent task ${taskId} does not belong to workspace ${workspace.id}.`
      );
    }

    const resolvedTargetAgentName = targetAgentName ?? resumedSession?.activeAgentName ?? resumedSession?.agentName;
    if (!resolvedTargetAgentName) {
      throw new AppError(400, "agent_type_required", "SubAgent requires subagent_type or a resumable task_id.");
    }

    const allowedTargets = workspace.agents[currentAgentName]?.subagents ?? [];
    if (!allowedTargets.includes(resolvedTargetAgentName)) {
      throw new AppError(
        403,
        "agent_delegate_not_allowed",
        `Agent ${currentAgentName} is not allowed to delegate to ${resolvedTargetAgentName}.`
      );
    }

    const targetAgent = workspace.agents[resolvedTargetAgentName];
    if (!targetAgent) {
      throw new AppError(404, "agent_not_found", `Agent ${resolvedTargetAgentName} was not found in workspace ${workspace.id}.`);
    }

    if (targetAgent.mode === "primary") {
      throw new AppError(
        409,
        "invalid_subagent_target",
        `Agent ${resolvedTargetAgentName} is a primary agent and cannot be used as a subagent target.`
      );
    }

    if (resumedSession && targetAgentName && resumedSession.activeAgentName !== targetAgentName && resumedSession.agentName !== targetAgentName) {
      throw new AppError(
        409,
        "task_agent_mismatch",
        `Subagent task ${taskId} is currently associated with ${resumedSession.activeAgentName}, not ${targetAgentName}.`
      );
    }

    const latestParentRun = await this.getRun(parentRun.id);
    await this.#enforceSubagentConcurrencyLimit(workspace, latestParentRun, currentAgentName);
    const delegateStep = await this.#startRunStep({
      runId: parentRun.id,
      stepType: "agent_delegate",
      name: resolvedTargetAgentName,
      agentName: currentAgentName,
      input: {
        targetAgent: resolvedTargetAgentName,
        task,
        ...(handoffSummary ? { handoffSummary } : {}),
        ...(taskId ? { taskId } : {})
      }
    });

    const now = nowIso();
    const childSessionId = resumedSession?.id ?? createId("ses");
    const childRunId = createId("run");
    const parentModelRef = this.#resolveModelForRun(
      workspace,
      parentSession.modelRef ?? workspace.agents[currentAgentName]?.modelRef
    ).canonicalModelRef;
    const childSession: Session = resumedSession ?? {
      id: childSessionId,
      workspaceId: workspace.id,
      parentSessionId: parentSession.id,
      subjectRef: parentSession.subjectRef,
      ...(parentSession.modelRef ? { modelRef: parentSession.modelRef } : {}),
      agentName: resolvedTargetAgentName,
      activeAgentName: resolvedTargetAgentName,
      title: `Agent ${resolvedTargetAgentName}`,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    const childMessage: Message = {
      id: createId("msg"),
      sessionId: childSessionId,
      role: "user",
      content: textContent(this.#buildDelegatedTaskMessage(currentAgentName, resolvedTargetAgentName, task, handoffSummary)),
      metadata: {
        parentRunId: parentRun.id,
        parentSessionId: parentSession.id,
        delegatedByAgent: currentAgentName,
        ...(taskId ? { delegatedTaskId: taskId } : {})
      },
      createdAt: now
    };
    const childRun: Run = {
      id: childRunId,
      workspaceId: workspace.id,
      sessionId: childSessionId,
      parentRunId: parentRun.id,
      initiatorRef: parentRun.initiatorRef ?? parentSession.subjectRef,
      triggerType: "system",
      triggerRef: "agent.delegate",
      agentName: childSession.activeAgentName,
      effectiveAgentName: childSession.activeAgentName,
      switchCount: 0,
      status: "queued",
      createdAt: now,
      metadata: {
        parentRunId: parentRun.id,
        parentSessionId: parentSession.id,
        parentAgentName: currentAgentName,
        delegatedTask: task,
        ...(handoffSummary ? { handoffSummary } : {}),
        ...(taskId ? { taskId } : {}),
        ...(targetAgent.modelRef ? {} : { inheritedModelRef: parentModelRef })
      }
    };

    if (resumedSession) {
      await this.#sessionRepository.update({
        ...childSession,
        status: "active",
        updatedAt: now
      });
    } else {
      await this.#sessionRepository.create(childSession);
    }
    await this.#messageRepository.create(childMessage);
    await this.#runRepository.create(childRun);

    const updatedDelegatedRuns = [
      ...this.#delegatedRunRecords(latestParentRun),
      {
        childRunId,
        childSessionId,
        targetAgentName: resolvedTargetAgentName,
        parentAgentName: currentAgentName
      }
    ];

    await this.#updateRun(latestParentRun, {
      metadata: {
        ...(latestParentRun.metadata ?? {}),
        delegatedRuns: updatedDelegatedRuns
      }
    });

    await this.#appendEvent({
      sessionId: parentSession.id,
      runId: parentRun.id,
      event: "agent.delegate.started",
      data: {
        runId: parentRun.id,
        sessionId: parentSession.id,
        agentName: currentAgentName,
        targetAgent: resolvedTargetAgentName,
        childSessionId,
        childRunId,
        ...(taskId ? { taskId, resumed: true } : {})
      }
    });
    await this.#completeRunStep(delegateStep, "completed", {
      targetAgent: resolvedTargetAgentName,
      childSessionId,
      childRunId,
      ...(taskId ? { taskId, resumed: true } : {})
    });

    await this.#enqueueRun(childSessionId, childRunId);
    void this.#monitorDelegatedRun(parentSession.id, parentRun.id, currentAgentName, resolvedTargetAgentName, childRunId);

    return {
      childSessionId,
      childRunId,
      targetAgentName: resolvedTargetAgentName
    };
  }

  async #enforceSubagentConcurrencyLimit(
    workspace: WorkspaceRecord,
    parentRun: Run,
    currentAgentName: string
  ): Promise<void> {
    const maxConcurrentSubagents = workspace.agents[currentAgentName]?.policy?.maxConcurrentSubagents;
    if (maxConcurrentSubagents === undefined) {
      return;
    }

    const childRuns = await Promise.all(
      this.#delegatedRunRecords(parentRun).map(async (record) => this.#runRepository.getById(record.childRunId))
    );
    const activeRuns = childRuns.filter(
      (run): run is Run => run !== null && (run.status === "queued" || run.status === "running" || run.status === "waiting_tool")
    );

    if (activeRuns.length >= maxConcurrentSubagents) {
      throw new AppError(
        409,
        "subagent_concurrency_limit_exceeded",
        `Agent ${currentAgentName} reached max_concurrent_subagents=${maxConcurrentSubagents}.`
      );
    }
  }

  #buildDelegatedTaskMessage(
    currentAgentName: string,
    targetAgentName: string,
    task: string,
    handoffSummary?: string | undefined
  ): string {
    return [
      `<delegated_task from_agent="${currentAgentName}" to_agent="${targetAgentName}">`,
      "<task>",
      task,
      "</task>",
      ...(handoffSummary ? ["<handoff_summary>", handoffSummary, "</handoff_summary>"] : []),
      "</delegated_task>"
    ].join("\n");
  }

  async #monitorDelegatedRun(
    parentSessionId: string,
    parentRunId: string,
    parentAgentName: string,
    targetAgentName: string,
    childRunId: string
  ): Promise<void> {
    const childRun = await this.#waitForRunTerminalState(childRunId);
    const childSummary = await this.#collectAwaitedRunSummary(childRunId);

    if (childRun.status === "completed") {
      await this.#appendEvent({
        sessionId: parentSessionId,
        runId: parentRunId,
        event: "agent.delegate.completed",
        data: {
          runId: parentRunId,
          sessionId: parentSessionId,
          agentName: parentAgentName,
          targetAgent: targetAgentName,
          childRunId,
          childStatus: childRun.status,
          output: childSummary.outputContent ?? ""
        }
      });
      return;
    }

    await this.#appendEvent({
      sessionId: parentSessionId,
      runId: parentRunId,
      event: "agent.delegate.failed",
      data: {
        runId: parentRunId,
        sessionId: parentSessionId,
        agentName: parentAgentName,
        targetAgent: targetAgentName,
        childRunId,
        childStatus: childRun.status,
        errorCode: childRun.errorCode,
        errorMessage: childRun.errorMessage
      }
    });
  }

  async #awaitDelegatedRuns(_parentRun: Run, runIds: string[], mode: "all" | "any"): Promise<string> {
    const awaitedRuns = mode === "any" ? [await this.#waitForAnyRunTerminalState(runIds)] : await Promise.all(runIds.map(async (runId) => this.#waitForRunTerminalState(runId)));
    const summaries = await Promise.all(awaitedRuns.map(async (run) => this.#collectAwaitedRunSummary(run.id)));
    const rendered = summaries.map((summary) => this.#renderAwaitedRunSummary(summary));

    if (rendered.length === 1) {
      return rendered[0] ?? "";
    }

    return [
      `mode: ${mode}`,
      `results: ${rendered.length}`,
      "",
      rendered.join("\n\n")
    ].join("\n");
  }

  async #waitForRunTerminalState(runId: string): Promise<Run> {
    while (true) {
      const run = await this.getRun(runId);
      if (this.#isRunTerminal(run.status)) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async #waitForAnyRunTerminalState(runIds: string[]): Promise<Run> {
    while (true) {
      const runs = await Promise.all(runIds.map(async (runId) => this.getRun(runId)));
      const completedRun = runs.find((run) => this.#isRunTerminal(run.status));
      if (completedRun) {
        return completedRun;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  #isRunTerminal(status: Run["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
  }

  async #collectAwaitedRunSummary(runId: string): Promise<AwaitedRunSummary> {
    const run = await this.getRun(runId);
    if (!run.sessionId) {
      return { run };
    }

    const messages = await this.#messageRepository.listBySessionId(run.sessionId);
    const runMessages = messages.filter((message) => message.runId === run.id);
    const assistantMessage = [...runMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    const assistantContent = assistantMessage ? this.#extractMessageDisplayText(assistantMessage) : undefined;

    if (this.#hasMeaningfulText(assistantContent)) {
      return {
        run,
        outputContent: assistantContent
      };
    }

    const toolMessage = [...runMessages].reverse().find((message) => message.role === "tool");
    const toolContent = toolMessage ? this.#extractMessageDisplayText(toolMessage) : undefined;

    return {
      run,
      ...(this.#hasMeaningfulText(toolContent) ? { outputContent: toolContent } : {})
    };
  }

  #renderAwaitedRunSummary(summary: AwaitedRunSummary): string {
    return formatToolOutput(
      [
        ["task_id", summary.run.sessionId],
        ["run_id", summary.run.id],
        ["status", summary.run.status],
        ["subagent_type", summary.run.effectiveAgentName]
      ],
      [
        ...(summary.outputContent
          ? [
              {
                title: "output",
                lines: summary.outputContent.split(/\r?\n/),
                emptyText: "(empty output)"
              }
            ]
          : []),
        ...(summary.run.errorMessage
          ? [
              {
                title: "error_message",
                lines: summary.run.errorMessage.split(/\r?\n/),
                emptyText: "(empty error)"
              }
            ]
          : [])
      ]
    );
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
      resolveModelForRun: (targetWorkspace, modelRef) => this.#resolveModelForRun(targetWorkspace, modelRef),
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
    metadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    await this.#toolMessages.persistAssistantToolCalls(session, run, step, allMessages, metadata);
  }

  async #persistToolResults(
    session: Session,
    run: Run,
    step: ModelStepResult,
    failedToolResults: ToolErrorContentPart[],
    persistedToolCalls: Set<string>,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    await this.#toolMessages.persistToolResults(
      session,
      run,
      step,
      failedToolResults,
      persistedToolCalls,
      allMessages,
      metadata
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
    if (workspace.kind !== "chat") {
      return {
        ...workspace.catalog,
        tools,
        nativeTools: [...NATIVE_TOOL_NAMES],
        runtimeTools: listRuntimeToolNamesForCatalog(workspace)
      };
    }

    return {
      ...workspace.catalog,
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: [],
      runtimeTools: []
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
