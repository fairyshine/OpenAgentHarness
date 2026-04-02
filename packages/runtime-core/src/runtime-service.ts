import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  Message,
  ModelGenerateResponse,
  Run,
  RunStep,
  Session,
  WorkspaceCatalog
} from "@oah/api-contracts";

import { AppError } from "./errors.js";
import {
  buildAvailableAgentSwitchesMessage,
  buildAvailableSubagentsMessage,
  createAgentAwaitTool,
  createAgentDelegateTool,
  createAgentSwitchTool
} from "./agent-control.js";
import { createNativeToolSet, getNativeToolRetryPolicy, NATIVE_TOOL_NAMES } from "./native-tools.js";
import { buildAvailableActionsMessage, createRunActionTool } from "./action-dispatch.js";
import { buildAvailableSkillsMessage, createDynamicActivateSkillTool } from "./skill-activation.js";
import {
  type ActionRunAcceptedResult,
  type ActionRetryPolicy,
  type CancelRunResult,
  type CreateSessionMessageParams,
  type CreateSessionParams,
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
  toPublicWorkspace,
  type WorkspaceRecord
} from "./types.js";
import { createId, nowIso, parseCursor } from "./utils.js";

function canTransitionRunStatus(from: Run["status"], to: Run["status"]): boolean {
  if (from === to) {
    return true;
  }

  switch (from) {
    case "queued":
      return to === "running" || to === "cancelled" || to === "failed";
    case "running":
      return to === "waiting_tool" || to === "completed" || to === "failed" || to === "cancelled" || to === "timed_out";
    case "waiting_tool":
      return to === "running" || to === "completed" || to === "failed" || to === "cancelled" || to === "timed_out";
    default:
      return false;
  }
}

interface ResolvedRunModel {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
}

interface HookEnvelope {
  workspace_id: string;
  session_id?: string | undefined;
  run_id: string;
  cwd: string;
  hook_event_name: string;
  agent_name?: string | undefined;
  effective_agent_name: string;
  trigger_type: Run["triggerType"];
  run_status: Run["status"];
  model_ref?: string | undefined;
  model_request?: Record<string, unknown> | undefined;
  model_response?: Record<string, unknown> | undefined;
  context?: Record<string, unknown> | undefined;
  tool_name?: string | undefined;
  tool_input?: unknown;
  tool_output?: unknown;
  tool_call_id?: string | undefined;
}

interface HookResult {
  continue?: boolean | undefined;
  stopReason?: string | undefined;
  suppressOutput?: boolean | undefined;
  systemMessage?: string | undefined;
  decision?: string | undefined;
  reason?: string | undefined;
  hookSpecificOutput?: {
    hookEventName?: string | undefined;
    additionalContext?: string | undefined;
    patch?: Record<string, unknown> | undefined;
  } | undefined;
}

interface ModelExecutionInput {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
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
  assistantContent?: string | undefined;
}

type PromptMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };

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
  readonly #hookRunAuditRepository: RuntimeServiceOptions["hookRunAuditRepository"];
  readonly #workspaceDeletionHandler: RuntimeServiceOptions["workspaceDeletionHandler"];
  readonly #workspaceSettingsManager: RuntimeServiceOptions["workspaceSettingsManager"];
  readonly #workspaceInitializer: RuntimeServiceOptions["workspaceInitializer"];
  readonly #sessionChains = new Map<string, Promise<void>>();
  readonly #runAbortControllers = new Map<string, AbortController>();

  constructor(options: RuntimeServiceOptions) {
    this.#defaultModel = options.defaultModel;
    this.#modelGateway = options.modelGateway;
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
    this.#hookRunAuditRepository = options.hookRunAuditRepository;
    this.#workspaceDeletionHandler = options.workspaceDeletionHandler;
    this.#workspaceSettingsManager = options.workspaceSettingsManager;
    this.#workspaceInitializer = options.workspaceInitializer;
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
    const workspaceId = createId("ws");

    const workspace: WorkspaceRecord = {
      id: workspaceId,
      kind: initialized.kind ?? "project",
      readOnly: initialized.readOnly ?? false,
      historyMirrorEnabled: initialized.historyMirrorEnabled ?? false,
      defaultAgent: initialized.defaultAgent,
      projectAgentsMd: initialized.projectAgentsMd,
      settings: initialized.settings,
      workspaceModels: initialized.workspaceModels,
      agents: initialized.agents,
      actions: initialized.actions,
      skills: initialized.skills,
      toolServers: initialized.toolServers ?? initialized.mcpServers ?? {},
      ...(initialized.mcpServers ? { mcpServers: initialized.mcpServers } : {}),
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

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    await this.#workspaceDeletionHandler?.deleteWorkspace(workspace);
    await this.#workspaceRepository.delete(workspaceId);
  }

  async updateWorkspaceHistoryMirrorEnabled(
    workspaceId: string,
    enabled: boolean
  ): Promise<import("@oah/api-contracts").Workspace> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (workspace.kind !== "project") {
      if (enabled) {
        throw new AppError(
          400,
          "history_mirror_not_supported",
          `Workspace ${workspaceId} does not support local history mirror sync.`
        );
      }

      return toPublicWorkspace(workspace);
    }

    const updated =
      (await this.#workspaceSettingsManager?.updateHistoryMirrorEnabled(workspace, enabled)) ??
      (await this.#workspaceRepository.upsert({
        ...workspace,
        historyMirrorEnabled: enabled,
        settings: {
          ...workspace.settings,
          historyMirrorEnabled: enabled
        },
        updatedAt: nowIso()
      }));

    return toPublicWorkspace(updated);
  }

  async createSession({ workspaceId, caller, input }: CreateSessionParams): Promise<Session> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    const now = nowIso();
    const activeAgentName = input.agentName ?? workspace.defaultAgent;
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

    const session: Session = {
      id: createId("ses"),
      workspaceId: workspace.id,
      subjectRef: caller.subjectRef,
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

  async listWorkspaceSessions(workspaceId: string, pageSize: number, cursor?: string): Promise<SessionListResult> {
    await this.getWorkspaceRecord(workspaceId);
    const startIndex = parseCursor(cursor);
    const items = await this.#sessionRepository.listByWorkspaceId(workspaceId, pageSize, cursor);
    const nextCursor = items.length === pageSize ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionMessages(sessionId: string, pageSize: number, cursor?: string): Promise<MessageListResult> {
    await this.getSession(sessionId);
    const messages = await this.#messageRepository.listBySessionId(sessionId);
    const startIndex = parseCursor(cursor);
    const items = messages.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < messages.length ? String(startIndex + pageSize) : undefined;

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
      content: input.content,
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

    const resolvedAgentName = agentName ?? session?.activeAgentName ?? workspace.defaultAgent;
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

    try {
      if (run.triggerType === "api_action") {
        await this.#processActionRun(workspace, run, session, abortController.signal);
        return;
      }

      if (!session) {
        throw new AppError(500, "session_required", `Run ${run.id} requires a session for message execution.`);
      }

      const allMessages = await this.#messageRepository.listBySessionId(session.id);
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
      let latestHookedModelInput = hookedModelInput;
      const runtimeTools = this.#buildRuntimeTools(workspace, run, session, executionContext);
      const toolCallStartedAt = new Map<string, number>();
      const toolCallSteps = new Map<string, RunStep>();
      const activeToolCallIds = new Set<string>();
      let completedModelStepCount = 0;
      const syncRunStatusFromActiveTools = async () => {
        await this.#setRunStatusIfPossible(run.id, activeToolCallIds.size > 0 ? "waiting_tool" : "running");
      };
      const observableRuntimeTools = this.#wrapRuntimeToolsForEvents(
        workspace,
        session,
        run,
        runtimeTools,
        executionContext,
        toolCallStartedAt,
        toolCallSteps
      );
      const enabledToolServers = this.#enabledToolServers(workspace);
      const persistedToolCalls = new Set<string>();
      let assistantMessage: Message | undefined;
      const response = await this.#modelGateway.stream(
        {
          model: hookedModelInput.model,
          ...(hookedModelInput.modelDefinition ? { modelDefinition: hookedModelInput.modelDefinition } : {}),
          messages: hookedModelInput.messages,
          ...(hookedModelInput.temperature !== undefined ? { temperature: hookedModelInput.temperature } : {}),
          ...(hookedModelInput.maxTokens !== undefined ? { maxTokens: hookedModelInput.maxTokens } : {})
        },
        {
          signal: abortController.signal,
          ...(Object.keys(observableRuntimeTools).length > 0
            ? {
                tools: observableRuntimeTools
              }
            : {}),
          ...(enabledToolServers.length > 0
            ? {
                toolServers: enabledToolServers
              }
            : {}),
          maxSteps: workspace.agents[executionContext.currentAgentName]?.policy?.maxSteps ?? 8,
          parallelToolCalls: workspace.agents[executionContext.currentAgentName]?.policy?.parallelToolCalls,
          prepareStep: async (stepNumber) => {
            const activeToolNames = this.#activeToolNamesForAgent(workspace, executionContext.currentAgentName);
            if (stepNumber === 0) {
              modelCallSteps.set(
                stepNumber,
                await this.#startRunStep({
                  runId: run.id,
                  stepType: "model_call",
                  name: hookedModelInput.model,
                  agentName: executionContext.currentAgentName,
                  input: {
                    model: hookedModelInput.model,
                    canonicalModelRef: hookedModelInput.canonicalModelRef,
                    messageCount: hookedModelInput.messages.length
                  }
                })
              );
              return activeToolNames ? { activeToolNames } : undefined;
            }

            const latestRun = await this.getRun(run.id);
            const nextInput = await this.#buildModelInput(
              workspace,
              session,
              latestRun,
              allMessages,
              executionContext.currentAgentName,
              executionContext.injectSystemReminder
            );
            const hookedNextInput = await this.#applyBeforeModelHooks(workspace, session, latestRun, nextInput);
            latestHookedModelInput = hookedNextInput;
            executionContext.injectSystemReminder = false;
            modelCallSteps.set(
              stepNumber,
              await this.#startRunStep({
                runId: run.id,
                stepType: "model_call",
                name: hookedNextInput.model,
                agentName: executionContext.currentAgentName,
                input: {
                  model: hookedNextInput.model,
                  canonicalModelRef: hookedNextInput.canonicalModelRef,
                  messageCount: hookedNextInput.messages.length
                }
              })
            );

            return {
              model: hookedNextInput.model,
              ...(hookedNextInput.modelDefinition ? { modelDefinition: hookedNextInput.modelDefinition } : {}),
              systemMessages: hookedNextInput.messages.filter(
                (message): message is { role: "system"; content: string } => message.role === "system"
              ),
              ...(activeToolNames ? { activeToolNames } : {})
            };
          },
          onToolCallStart: async (toolCall) => {
            toolCallStartedAt.set(toolCall.toolCallId, Date.now());
            activeToolCallIds.add(toolCall.toolCallId);
            await syncRunStatusFromActiveTools();
          },
          onToolCallFinish: async (toolResult) => {
            const startedAt = toolCallStartedAt.get(toolResult.toolCallId);
            toolCallStartedAt.delete(toolResult.toolCallId);
            activeToolCallIds.delete(toolResult.toolCallId);
            const toolStep = toolCallSteps.get(toolResult.toolCallId);
            const retryPolicy = toolStep ? this.#runStepRetryPolicy(toolStep) : undefined;
            if (toolStep) {
              const completedToolStep = await this.#completeRunStep(toolStep, "completed", {
                sourceType: this.#toolSourceType(toolResult.toolName),
                ...(retryPolicy ? { retryPolicy } : {}),
                output: this.#normalizeJsonObject(toolResult.output),
                ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
              });
              await this.#recordToolCallAuditFromStep(completedToolStep, toolResult.toolName, "completed");
              toolCallSteps.delete(toolResult.toolCallId);
            }
            await this.#appendEvent({
              sessionId: session.id,
              runId: run.id,
              event: "tool.completed",
              data: {
                runId: run.id,
                sessionId: session.id,
                toolCallId: toolResult.toolCallId,
                toolName: toolResult.toolName,
                sourceType: this.#toolSourceType(toolResult.toolName),
                ...(retryPolicy ? { retryPolicy } : {}),
                output: toolResult.output,
                ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
              }
            });
            await syncRunStatusFromActiveTools();
          },
          onStepFinish: async (step) => {
            const modelCallStep = modelCallSteps.get(completedModelStepCount);
            if (modelCallStep) {
              await this.#completeRunStep(modelCallStep, "completed", {
                finishReason: step.finishReason ?? "unknown",
                toolCallsCount: step.toolCalls.length,
                toolResultsCount: step.toolResults.length
              });
              modelCallSteps.delete(completedModelStepCount);
            }
            completedModelStepCount += 1;
            await this.#persistToolResults(session, run, step, persistedToolCalls);
          }
        }
      );

      let accumulatedText = "";
      for await (const chunk of response.chunks) {
        assistantMessage = await this.#ensureAssistantMessage(session, run, assistantMessage);
        accumulatedText += chunk;
        await this.#messageRepository.update({
          ...assistantMessage,
          content: accumulatedText
        });
        await this.#appendEvent({
          sessionId: session.id,
          runId: run.id,
          event: "message.delta",
          data: {
            runId: run.id,
            messageId: assistantMessage.id,
            delta: chunk
          }
        });
      }

      const completed = await response.completed;
      const latestRun = await this.getRun(run.id);
      const hookedCompleted = await this.#applyAfterModelHooks(
        workspace,
        session,
        latestRun,
        latestHookedModelInput,
        completed
      );
      await this.#finalizeSuccessfulRun(session, latestRun, assistantMessage, hookedCompleted);
    } catch (error) {
      const pendingModelStepStatus = runTimedOut ? "failed" : abortController.signal.aborted ? "cancelled" : "failed";
      for (const step of modelCallSteps.values()) {
        await this.#completeRunStep(step, pendingModelStepStatus, {
          errorMessage: error instanceof Error ? error.message : "Unknown model execution error."
        });
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
      const failedRun =
        currentRun.status === "failed" || currentRun.status === "timed_out"
          ? currentRun
          : await this.#setRunStatus(currentRun, "failed", {
              endedAt: nowIso(),
              errorCode: "model_stream_failed",
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
            errorCode: failedRun.errorCode ?? "model_stream_failed",
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
    session: Session,
    run: Run,
    assistantMessage: Message | undefined,
    completed: ModelGenerateResponse
  ): Promise<void> {
    const latestRun = await this.getRun(run.id);
    const persistedAssistantMessage = await this.#ensureAssistantMessage(session, latestRun, assistantMessage, completed.text);
    const updatedMessage =
      persistedAssistantMessage.content === completed.text
        ? persistedAssistantMessage
        : await this.#messageRepository.update({
            ...persistedAssistantMessage,
            content: completed.text
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
    const cancelledRun =
      run.status === "cancelled"
        ? run
        : await this.#setRunStatus(run, "cancelled", {
            endedAt: nowIso(),
            cancelRequestedAt: run.cancelRequestedAt ?? nowIso()
          });
    await this.#recordSystemStep(cancelledRun, "run.cancelled", {
      status: cancelledRun.status
    });

    await this.#appendEvent({
      sessionId,
      runId: cancelledRun.id,
      event: "run.cancelled",
      data: {
        runId: cancelledRun.id,
        sessionId,
        status: cancelledRun.status
      }
    });
  }

  async #markRunTimedOut(run: Run, runTimeoutMs: number | undefined): Promise<Run> {
    if (run.status === "timed_out") {
      return run;
    }

    return this.#setRunStatus(run, "timed_out", {
      endedAt: nowIso(),
      errorCode: "run_timed_out",
      errorMessage:
        runTimeoutMs !== undefined
          ? `Run exceeded configured timeout of ${runTimeoutMs}ms.`
          : "Run exceeded the configured timeout."
    });
  }

  async #setRunStatus(run: Run, nextStatus: Run["status"], patch: Partial<Run>): Promise<Run> {
    if (!canTransitionRunStatus(run.status, nextStatus)) {
      throw new AppError(409, "invalid_run_transition", `Cannot transition run from ${run.status} to ${nextStatus}.`);
    }

    return this.#updateRun(run, {
      ...patch,
      status: nextStatus
    });
  }

  async #setRunStatusIfPossible(runId: string, nextStatus: Run["status"]): Promise<void> {
    const run = await this.getRun(runId);
    if (run.status === nextStatus || !canTransitionRunStatus(run.status, nextStatus)) {
      return;
    }

    await this.#setRunStatus(run, nextStatus, {});
  }

  async #refreshRunHeartbeat(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (run.status !== "running" && run.status !== "waiting_tool") {
      return;
    }

    await this.#updateRun(run, {
      heartbeatAt: nowIso()
    });
  }

  async #updateRun(run: Run, patch: Partial<Run>): Promise<Run> {
    return this.#runRepository.update({
      ...run,
      ...patch
    });
  }

  async #startRunStep(input: {
    runId: string;
    stepType: RunStepType;
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }): Promise<RunStep> {
    const existingSteps = await this.#runStepRepository.listByRunId(input.runId);
    return this.#runStepRepository.create({
      id: createId("step"),
      runId: input.runId,
      seq: existingSteps.length + 1,
      stepType: input.stepType,
      ...(input.name ? { name: input.name } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      status: "running",
      ...(input.input ? { input: input.input } : {}),
      startedAt: nowIso()
    });
  }

  async #completeRunStep(
    step: RunStep,
    status: Extract<RunStepStatus, "completed" | "failed" | "cancelled">,
    output?: Record<string, unknown> | undefined
  ): Promise<RunStep> {
    return this.#runStepRepository.update({
      ...step,
      status,
      ...(output ? { output } : {}),
      endedAt: nowIso()
    });
  }

  async #recordSystemStep(
    run: Run,
    name: string,
    output?: Record<string, unknown> | undefined
  ): Promise<RunStep> {
    const step = await this.#startRunStep({
      runId: run.id,
      stepType: "system",
      name,
      ...(run.effectiveAgentName ? { agentName: run.effectiveAgentName } : {})
    });

    return this.#completeRunStep(step, "completed", output);
  }

  #normalizeJsonObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return {
      value
    };
  }

  #normalizePromptMessages(rawMessages: unknown): PromptMessage[] {
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    return rawMessages.flatMap((message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        typeof (message as { role?: unknown }).role === "string" &&
        typeof (message as { content?: unknown }).content === "string"
      ) {
        const role = (message as { role: string }).role;
        if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
          return [
            {
              role,
              content: (message as { content: string }).content
            }
          ];
        }
      }

      return [];
    });
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
    const resolvedModel = this.#resolveModelForRun(workspace, activeAgent?.modelRef ?? inheritedModelRef);
    let contextMessages = await this.#applyContextHooks(
      workspace,
      session,
      run,
      "before_context_build",
      messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    );
    const promptMessages: Array<{ role: "system"; content: string }> = this.#buildStaticPromptMessages(
      workspace,
      activeAgentName,
      resolvedModel
    );

    if (activeAgent?.systemReminder && this.#shouldInjectSystemReminder(session, run, messages, activeAgentName, forceSystemReminder)) {
      promptMessages.push({
        role: "system",
        content: `<system_reminder>\n${activeAgent.systemReminder}\n</system_reminder>`
      });
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
      ...(activeAgent?.maxTokens !== undefined ? { maxTokens: activeAgent.maxTokens } : {}),
      messages: contextMessages
    };
  }

  #shouldInjectSystemReminder(
    session: Session,
    run: Run,
    messages: Message[],
    activeAgentName: string,
    forceSystemReminder = false
  ): boolean {
    if (forceSystemReminder) {
      return true;
    }

    const interactionCount = messages.filter((message) => message.role !== "system").length;
    if (interactionCount === 1 && session.agentName && session.agentName === activeAgentName && run.effectiveAgentName === activeAgentName) {
      return true;
    }

    return false;
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

  #buildStaticPromptMessages(
    workspace: WorkspaceRecord,
    activeAgentName: string,
    resolvedModel: ResolvedRunModel
  ): Array<{ role: "system"; content: string }> {
    const activeAgent = workspace.agents[activeAgentName];
    const systemPromptSettings = workspace.settings.systemPrompt;
    const compose = systemPromptSettings?.compose ?? {
      order: ["base", "llm_optimized", "agent", "actions", "project_agents_md", "skills"] as const,
      includeEnvironment: false
    };
    const visibleActions = activeAgent ? this.#visibleLlmActions(workspace, activeAgentName) : [];
    const visibleSkills = activeAgent ? this.#visibleLlmSkills(workspace, activeAgentName) : [];
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
      }
    }

    const agentSwitchMessage = this.#buildAgentSwitchMessage(workspace, activeAgentName);
    if (agentSwitchMessage) {
      orderedMessages.push({
        role: "system",
        content: agentSwitchMessage
      });
    }

    const availableSubagentsMessage = this.#buildAvailableSubagentsMessage(workspace, activeAgentName);
    if (availableSubagentsMessage) {
      orderedMessages.push({
        role: "system",
        content: availableSubagentsMessage
      });
    }

    if (compose.includeEnvironment && workspace.kind === "project") {
      orderedMessages.push({
        role: "system",
        content: this.#buildEnvironmentMessage(workspace, activeAgentName)
      });
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
    const activeAgent = workspace.agents[activeAgentName];
    const visibleNativeTools = activeAgent ? this.#visibleNativeToolNames(workspace, activeAgentName) : [];
    const visibleActions = activeAgent ? this.#visibleLlmActions(workspace, activeAgentName).map((action) => action.name) : [];
    const visibleSkills = activeAgent ? this.#visibleLlmSkills(workspace, activeAgentName).map((skill) => skill.name) : [];
    const visibleToolServers = activeAgent ? this.#visibleToolServers(workspace, activeAgentName).map((server) => server.name) : [];

    return [
      "<environment>",
      `workspace_id: ${workspace.id}`,
      `workspace_root: ${workspace.rootPath}`,
      `workspace_kind: ${workspace.kind}`,
      `execution_policy: ${workspace.executionPolicy}`,
      `active_agent: ${activeAgentName}`,
      `available_native_tools: ${visibleNativeTools.length > 0 ? visibleNativeTools.join(", ") : "none"}`,
      `available_actions: ${visibleActions.length > 0 ? visibleActions.join(", ") : "none"}`,
      `available_skills: ${visibleSkills.length > 0 ? visibleSkills.join(", ") : "none"}`,
      `available_tool_servers: ${visibleToolServers.length > 0 ? visibleToolServers.join(", ") : "none"}`,
      "</environment>"
    ].join("\n");
  }

  #buildRuntimeTools(
    workspace: WorkspaceRecord,
    run: Run,
    session: Session,
    executionContext: RunExecutionContext
  ): RuntimeToolSet {
    if (workspace.kind === "chat") {
      return {};
    }

    return {
      ...createNativeToolSet(workspace.rootPath, () =>
        this.#visibleNativeToolNames(workspace, executionContext.currentAgentName)
      ),
      ...createRunActionTool(() => this.#visibleLlmActions(workspace, executionContext.currentAgentName), async (action, input, context) =>
        this.#executeAction(workspace, action, run, context.abortSignal, input)
      ),
      ...createDynamicActivateSkillTool(() => this.#visibleLlmSkills(workspace, executionContext.currentAgentName)),
      ...createAgentDelegateTool(
        () => executionContext.currentAgentName,
        () => workspace.agents[executionContext.currentAgentName],
        () => workspace.agents,
        async ({ targetAgentName, task, handoffSummary }, currentAgentName) => {
          const accepted = await this.#delegateAgentRun(
            workspace,
            session,
            run,
            currentAgentName,
            targetAgentName,
            task,
            handoffSummary
          );
          executionContext.delegatedRunIds.push(accepted.childRunId);
          return accepted;
        }
      ),
      ...createAgentAwaitTool(
        () => executionContext.delegatedRunIds,
        async ({ runIds, mode }) => this.#awaitDelegatedRuns(run, runIds, mode)
      ),
      ...createAgentSwitchTool(
        () => executionContext.currentAgentName,
        () => workspace.agents[executionContext.currentAgentName],
        () => workspace.agents,
        async (targetAgentName, currentAgentName) => {
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
      )
    };
  }

  #wrapRuntimeToolsForEvents(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    runtimeTools: RuntimeToolSet,
    executionContext: RunExecutionContext,
    toolCallStartedAt: Map<string, number>,
    toolCallSteps: Map<string, RunStep>
  ): RuntimeToolSet {
    return Object.fromEntries(
      Object.entries(runtimeTools).map(([toolName, definition]) => [
        toolName,
        {
          ...definition,
          execute: async (input, context) => {
            const currentAgentName = executionContext.currentAgentName;
            const toolStartedAt = context.toolCallId ? (toolCallStartedAt.get(context.toolCallId) ?? Date.now()) : Date.now();
            let executedInput = input;
            let retryPolicy = this.#toolRetryPolicy(workspace, currentAgentName, toolName, input, definition);

            try {
              executedInput = await this.#applyBeforeToolDispatchHooks(
                workspace,
                session,
                run,
                currentAgentName,
                toolName,
                context.toolCallId,
                input
              );
              retryPolicy = this.#toolRetryPolicy(workspace, currentAgentName, toolName, executedInput, definition);

              if (context.toolCallId) {
                toolCallStartedAt.set(context.toolCallId, toolStartedAt);
                toolCallSteps.set(
                  context.toolCallId,
                  await this.#startRunStep({
                    runId: run.id,
                    stepType: "tool_call",
                    name: toolName,
                    agentName: currentAgentName,
                    input: {
                      toolCallId: context.toolCallId,
                      sourceType: this.#toolSourceType(toolName),
                      retryPolicy,
                      input: this.#normalizeJsonObject(executedInput)
                    }
                  })
                );
              }

              await this.#appendEvent({
                sessionId: session.id,
                runId: run.id,
                event: "tool.started",
                data: {
                  runId: run.id,
                  sessionId: session.id,
                  ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
                  toolName,
                  sourceType: this.#toolSourceType(toolName),
                  retryPolicy,
                  input: executedInput
                }
              });
              await this.#setRunStatusIfPossible(run.id, "waiting_tool");

              const toolTimeoutMs = timeoutMsFromSeconds(
                workspace.agents[currentAgentName]?.policy?.toolTimeoutSeconds
              );
              const output = await this.#executeRuntimeToolWithPolicy(
                definition,
                executedInput,
                context,
                toolName,
                toolTimeoutMs
              );
              return this.#applyAfterToolDispatchHooks(
                workspace,
                session,
                run,
                currentAgentName,
                toolName,
                context.toolCallId,
                executedInput,
                output
              );
            } catch (error) {
              const startedAt = context.toolCallId ? toolCallStartedAt.get(context.toolCallId) : undefined;
              const toolStep = context.toolCallId ? toolCallSteps.get(context.toolCallId) : undefined;
              if (context.toolCallId) {
                toolCallStartedAt.delete(context.toolCallId);
                toolCallSteps.delete(context.toolCallId);
              }
              if (toolStep) {
                const failedToolStep = await this.#completeRunStep(toolStep, "failed", {
                  sourceType: this.#toolSourceType(toolName),
                  retryPolicy,
                  errorCode: error instanceof AppError ? error.code : "tool_execution_failed",
                  errorMessage: error instanceof Error ? error.message : "Unknown tool execution error.",
                  ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
                });
                await this.#recordToolCallAuditFromStep(failedToolStep, toolName, "failed");
              }
              await this.#appendEvent({
                sessionId: session.id,
                runId: run.id,
                event: "tool.failed",
                data: {
                  runId: run.id,
                  sessionId: session.id,
                  ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
                  toolName,
                  sourceType: this.#toolSourceType(toolName),
                  retryPolicy,
                  errorCode: error instanceof AppError ? error.code : "tool_execution_failed",
                  errorMessage: error instanceof Error ? error.message : "Unknown tool execution error.",
                  ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
                }
              });
              throw error;
            }
          }
        }
      ])
    );
  }

  async #executeRuntimeToolWithPolicy(
    definition: RuntimeToolSet[string],
    input: unknown,
    context: RuntimeToolExecutionContext,
    toolName: string,
    timeoutMs: number | undefined
  ): Promise<unknown> {
    if (timeoutMs === undefined) {
      return definition.execute(input, context);
    }

    const abortController = new AbortController();
    const parentSignal = context.abortSignal;
    let timedOut = false;
    const forwardParentAbort = () => {
      abortController.abort();
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        abortController.abort();
      } else {
        parentSignal.addEventListener("abort", forwardParentAbort, { once: true });
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    try {
      return await Promise.race([
        Promise.resolve(
          definition.execute(input, {
            ...context,
            abortSignal: abortController.signal
          })
        ),
        new Promise<unknown>((_resolve, reject) => {
          const rejectForAbort = () => {
            reject(
              timedOut
                ? new AppError(408, "tool_timed_out", `Tool ${toolName} timed out after ${timeoutMs}ms.`)
                : createAbortError()
            );
          };

          if (abortController.signal.aborted) {
            rejectForAbort();
            return;
          }

          abortController.signal.addEventListener("abort", rejectForAbort, { once: true });
        })
      ]);
    } finally {
      clearTimeout(timeout);
      if (parentSignal && !parentSignal.aborted) {
        parentSignal.removeEventListener("abort", forwardParentAbort);
      }
    }
  }

  #toolSourceType(toolName: string): "action" | "skill" | "agent" | "tool" | "native" {
    if (toolName === "run_action") {
      return "action";
    }

    if (toolName === "activate_skill") {
      return "skill";
    }

    if (toolName.startsWith("agent.")) {
      return "agent";
    }

    if ((NATIVE_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return "native";
    }

    return "tool";
  }

  #toolRetryPolicy(
    workspace: WorkspaceRecord,
    _activeAgentName: string,
    toolName: string,
    input: unknown,
    definition?: RuntimeToolSet[string] | undefined
  ): ActionRetryPolicy {
    if ((NATIVE_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return getNativeToolRetryPolicy(toolName as (typeof NATIVE_TOOL_NAMES)[number]);
    }

    if (toolName === "run_action") {
      const actionInput =
        input && typeof input === "object" && !Array.isArray(input) ? (input as { name?: unknown }) : undefined;
      const actionName = typeof actionInput?.name === "string" ? actionInput.name : undefined;
      return actionName ? workspace.actions[actionName]?.retryPolicy ?? "manual" : "manual";
    }

    const definitionRetryPolicy = definition?.retryPolicy;
    return isActionRetryPolicy(definitionRetryPolicy) ? definitionRetryPolicy : "manual";
  }

  #runStepRetryPolicy(step: RunStep): ActionRetryPolicy | undefined {
    const inputPayload = this.#asJsonRecord(step.input);
    const inputRetryPolicy = inputPayload?.retryPolicy;
    if (isActionRetryPolicy(inputRetryPolicy)) {
      return inputRetryPolicy;
    }

    const outputPayload = this.#asJsonRecord(step.output);
    const outputRetryPolicy = outputPayload?.retryPolicy;
    if (isActionRetryPolicy(outputRetryPolicy)) {
      return outputRetryPolicy;
    }

    return undefined;
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

    if (!this.#canDelegateFromAgent(workspace, activeAgentName)) {
      return undefined;
    }

    const currentAgent = workspace.agents[activeAgentName];
    const message = buildAvailableSubagentsMessage(activeAgentName, currentAgent, workspace.agents);
    return message.length > 0 ? message : undefined;
  }

  #activeToolNamesForAgent(workspace: WorkspaceRecord, activeAgentName: string): string[] | undefined {
    if (workspace.kind === "chat") {
      return undefined;
    }

    if (this.#enabledToolServers(workspace).length > 0) {
      return undefined;
    }

    const names: string[] = [];
    names.push(...this.#visibleNativeToolNames(workspace, activeAgentName));
    if (this.#visibleLlmActions(workspace, activeAgentName).length > 0) {
      names.push("run_action");
    }
    if (this.#visibleLlmSkills(workspace, activeAgentName).length > 0) {
      names.push("activate_skill");
    }
    if ((workspace.agents[activeAgentName]?.switch ?? []).length > 0) {
      names.push("agent.switch");
    }
    if (this.#canDelegateFromAgent(workspace, activeAgentName)) {
      names.push("agent.delegate");
    }
    if ((workspace.agents[activeAgentName]?.subagents ?? []).length > 0) {
      names.push("agent.await");
    }
    return names.length > 0 ? names : undefined;
  }

  #canDelegateFromAgent(workspace: WorkspaceRecord, activeAgentName: string): boolean {
    const agent = workspace.agents[activeAgentName];
    return !!agent && agent.mode !== "subagent" && (agent.subagents?.length ?? 0) > 0;
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
    targetAgentName: string,
    task: string,
    handoffSummary?: string | undefined
  ): Promise<{ childSessionId: string; childRunId: string }> {
    if (!this.#canDelegateFromAgent(workspace, currentAgentName)) {
      throw new AppError(
        403,
        "agent_delegate_not_allowed",
        `Agent ${currentAgentName} is not allowed to delegate subagent work.`
      );
    }

    const targetAgent = workspace.agents[targetAgentName];
    if (!targetAgent) {
      throw new AppError(404, "agent_not_found", `Agent ${targetAgentName} was not found in workspace ${workspace.id}.`);
    }

    if (targetAgent.mode === "primary") {
      throw new AppError(
        409,
        "invalid_subagent_target",
        `Agent ${targetAgentName} is a primary agent and cannot be used as a subagent target.`
      );
    }

    const latestParentRun = await this.getRun(parentRun.id);
    await this.#enforceSubagentConcurrencyLimit(workspace, latestParentRun, currentAgentName);
    const delegateStep = await this.#startRunStep({
      runId: parentRun.id,
      stepType: "agent_delegate",
      name: targetAgentName,
      agentName: currentAgentName,
      input: {
        targetAgent: targetAgentName,
        task,
        ...(handoffSummary ? { handoffSummary } : {})
      }
    });

    const now = nowIso();
    const childSessionId = createId("ses");
    const childRunId = createId("run");
    const parentModelRef = this.#resolveModelForRun(workspace, workspace.agents[currentAgentName]?.modelRef).canonicalModelRef;
    const childSession: Session = {
      id: childSessionId,
      workspaceId: workspace.id,
      subjectRef: parentSession.subjectRef,
      agentName: targetAgentName,
      activeAgentName: targetAgentName,
      title: `Subagent ${targetAgentName}`,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    const childMessage: Message = {
      id: createId("msg"),
      sessionId: childSessionId,
      role: "user",
      content: this.#buildDelegatedTaskMessage(currentAgentName, targetAgentName, task, handoffSummary),
      metadata: {
        parentRunId: parentRun.id,
        parentSessionId: parentSession.id,
        delegatedByAgent: currentAgentName
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
      agentName: targetAgentName,
      effectiveAgentName: targetAgentName,
      switchCount: 0,
      status: "queued",
      createdAt: now,
      metadata: {
        parentRunId: parentRun.id,
        parentSessionId: parentSession.id,
        parentAgentName: currentAgentName,
        delegatedTask: task,
        ...(handoffSummary ? { handoffSummary } : {}),
        ...(targetAgent.modelRef ? {} : { inheritedModelRef: parentModelRef })
      }
    };

    await this.#sessionRepository.create(childSession);
    await this.#messageRepository.create(childMessage);
    await this.#runRepository.create(childRun);

    const updatedDelegatedRuns = [
      ...this.#delegatedRunRecords(latestParentRun),
      {
        childRunId,
        childSessionId,
        targetAgentName,
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
        targetAgent: targetAgentName,
        childSessionId,
        childRunId
      }
    });
    await this.#completeRunStep(delegateStep, "completed", {
      targetAgent: targetAgentName,
      childSessionId,
      childRunId
    });

    await this.#enqueueRun(childSessionId, childRunId);
    void this.#monitorDelegatedRun(parentSession.id, parentRun.id, currentAgentName, targetAgentName, childRunId);

    return {
      childSessionId,
      childRunId
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
          output: childSummary.assistantContent ?? ""
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

    return [
      `<agent_await mode="${mode}">`,
      ...summaries.map((summary) => this.#renderAwaitedRunSummary(summary)),
      "</agent_await>"
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
    const assistantMessage = [...messages]
      .reverse()
      .find((message) => message.runId === run.id && message.role === "assistant");

    return {
      run,
      ...(assistantMessage ? { assistantContent: assistantMessage.content } : {})
    };
  }

  #renderAwaitedRunSummary(summary: AwaitedRunSummary): string {
    return [
      `  <child_run id="${escapeXml(summary.run.id)}" status="${escapeXml(summary.run.status)}" agent="${escapeXml(summary.run.effectiveAgentName)}">`,
      ...(summary.assistantContent ? ["    <output>", escapeXml(summary.assistantContent), "    </output>"] : []),
      ...(summary.run.errorMessage ? ["    <error_message>", escapeXml(summary.run.errorMessage), "    </error_message>"] : []),
      "  </child_run>"
    ].join("\n");
  }

  #visibleLlmSkills(workspace: WorkspaceRecord, activeAgentName: string): WorkspaceRecord["skills"][string][] {
    return this.#visibleSkills(workspace, activeAgentName).filter((skill) => skill.exposeToLlm !== false);
  }

  #visibleNativeToolNames(workspace: WorkspaceRecord, activeAgentName: string): string[] {
    if (workspace.kind === "chat") {
      return [];
    }

    const activeAgent = workspace.agents[activeAgentName];
    const configuredNativeTools = activeAgent?.tools?.native ?? [];
    const availableNativeTools = [...NATIVE_TOOL_NAMES];

    if (!activeAgent || configuredNativeTools.length === 0) {
      return availableNativeTools;
    }

    return configuredNativeTools.map((toolName) => {
      if (!(NATIVE_TOOL_NAMES as readonly string[]).includes(toolName)) {
        throw new AppError(
          404,
          "native_tool_not_found",
          `Native tool ${toolName} was not found in workspace ${workspace.id}.`
        );
      }

      return toolName;
    });
  }

  #visibleLlmActions(workspace: WorkspaceRecord, activeAgentName: string): WorkspaceRecord["actions"][string][] {
    return this.#visibleActions(workspace, activeAgentName).filter((action) => action.exposeToLlm);
  }

  #visibleSkills(workspace: WorkspaceRecord, activeAgentName: string): WorkspaceRecord["skills"][string][] {
    if (workspace.kind === "chat") {
      return [];
    }

    const activeAgent = workspace.agents[activeAgentName];
    const configuredSkills = activeAgent?.tools?.skills ?? [];
    if (!activeAgent || configuredSkills.length === 0) {
      return Object.values(workspace.skills);
    }

    return configuredSkills.map((skillName) => {
      const skill = workspace.skills[skillName];
      if (!skill) {
        throw new AppError(404, "skill_not_found", `Skill ${skillName} was not found in workspace ${workspace.id}.`);
      }

      return skill;
    });
  }

  #visibleActions(workspace: WorkspaceRecord, activeAgentName: string): WorkspaceRecord["actions"][string][] {
    if (workspace.kind === "chat") {
      return [];
    }

    const activeAgent = workspace.agents[activeAgentName];
    const configuredActions = activeAgent?.tools?.actions ?? [];
    if (!activeAgent || configuredActions.length === 0) {
      return Object.values(workspace.actions);
    }

    return configuredActions.map((actionName) => {
      const action = workspace.actions[actionName];
      if (!action) {
        throw new AppError(404, "action_not_found", `Action ${actionName} was not found in workspace ${workspace.id}.`);
      }

      return action;
    });
  }

  #visibleToolServers(workspace: WorkspaceRecord, activeAgentName: string): WorkspaceRecord["toolServers"][string][] {
    if (workspace.kind === "chat") {
      return [];
    }

    const activeAgent = workspace.agents[activeAgentName];
    const configuredToolServers = activeAgent?.tools?.external ?? activeAgent?.tools?.mcp ?? [];
    if (!activeAgent || configuredToolServers.length === 0) {
      return Object.values(workspace.toolServers);
    }

    return configuredToolServers.map((serverName) => {
      const server = workspace.toolServers[serverName];
      if (!server) {
        throw new AppError(404, "tool_server_not_found", `Tool server ${serverName} was not found in workspace ${workspace.id}.`);
      }

      return server;
    });
  }

  #visibleEnabledToolServers(workspace: WorkspaceRecord, activeAgentName: string): WorkspaceRecord["toolServers"][string][] {
    return this.#visibleToolServers(workspace, activeAgentName).filter((server) => server.enabled);
  }

  #enabledToolServers(workspace: WorkspaceRecord): WorkspaceRecord["toolServers"][string][] {
    if (workspace.kind === "chat") {
      return [];
    }

    return Object.values(workspace.toolServers).filter((server) => server.enabled);
  }

  async #applyBeforeModelHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: ModelExecutionInput
  ): Promise<ModelExecutionInput> {
    let current = modelInput;
    const additionalMessages: Array<{ role: "system"; content: string }> = [];

    for (const hook of this.#selectHooks(workspace, "before_model_call", modelInput.canonicalModelRef)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "before_model_call",
        agent_name: run.agentName,
        effective_agent_name: run.effectiveAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        model_ref: current.canonicalModelRef,
        model_request: this.#serializeModelRequest(current)
      });

      this.#ensureHookCanContinue(result, hook.name);
      if (result?.systemMessage) {
        additionalMessages.push({ role: "system", content: result.systemMessage });
      }
      if (result?.hookSpecificOutput?.additionalContext) {
        additionalMessages.push({ role: "system", content: result.hookSpecificOutput.additionalContext });
      }

      const patch = result?.hookSpecificOutput?.patch?.model_request;
      if (patch && hook.capabilities.includes("rewrite_model_request") && typeof patch === "object") {
        current = this.#applyModelRequestPatch(workspace, current, patch as Record<string, unknown>);
      }
    }

    return additionalMessages.length === 0
      ? current
      : {
          ...current,
          messages: this.#insertSystemMessages(current.messages, additionalMessages)
        };
  }

  async #applyAfterModelHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: ModelExecutionInput,
    response: ModelGenerateResponse
  ): Promise<ModelGenerateResponse> {
    let currentResponse = response;

    for (const hook of this.#selectHooks(workspace, "after_model_call", modelInput.canonicalModelRef)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "after_model_call",
        agent_name: run.agentName,
        effective_agent_name: run.effectiveAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        model_ref: modelInput.canonicalModelRef,
        model_request: this.#serializeModelRequest(modelInput),
        model_response: {
          model: currentResponse.model,
          text: currentResponse.text,
          finishReason: currentResponse.finishReason
        }
      });

      this.#ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.model_response;
      if (patch && hook.capabilities.includes("rewrite_model_response") && typeof patch === "object") {
        currentResponse = this.#applyModelResponsePatch(currentResponse, patch as Record<string, unknown>);
      }

      const trailingNotes = [result?.systemMessage, result?.hookSpecificOutput?.additionalContext].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      if (trailingNotes.length > 0) {
        currentResponse = {
          ...currentResponse,
          text: [currentResponse.text, ...trailingNotes].join("\n\n")
        };
      }
    }

    return currentResponse;
  }

  async #applyContextHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_build" | "after_context_build",
    messages: PromptMessage[]
  ): Promise<PromptMessage[]> {
    let currentMessages = messages;

    for (const hook of this.#selectHooks(workspace, eventName)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: eventName,
        agent_name: run.agentName,
        effective_agent_name: run.effectiveAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        context: {
          messages: currentMessages
        }
      });

      this.#ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.context;
      if (patch && hook.capabilities.includes("rewrite_context") && typeof patch === "object") {
        currentMessages = this.#applyContextPatch(currentMessages, patch as Record<string, unknown>);
      }

      const notes = [result?.systemMessage, result?.hookSpecificOutput?.additionalContext].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      if (notes.length > 0) {
        currentMessages = this.#insertSystemMessages(
          currentMessages,
          notes.map((content) => ({
            role: "system",
            content
          }))
        );
      }
    }

    return currentMessages;
  }

  #applyContextPatch(currentMessages: PromptMessage[], patch: Record<string, unknown>): PromptMessage[] {
    if (Array.isArray(patch.messages)) {
      return this.#normalizePromptMessages(patch.messages);
    }

    return currentMessages;
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
    let currentInput = input;

    for (const hook of this.#selectHooks(workspace, "before_tool_dispatch", toolName)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "before_tool_dispatch",
        agent_name: run.agentName,
        effective_agent_name: activeAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        tool_name: toolName,
        tool_input: currentInput,
        ...(toolCallId ? { tool_call_id: toolCallId } : {})
      });

      this.#ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.tool_input;
      if (patch !== undefined && hook.capabilities.includes("rewrite_tool_request")) {
        currentInput = this.#applyToolPatch(currentInput, patch);
      }
    }

    return currentInput;
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
    let currentOutput = output;

    for (const hook of this.#selectHooks(workspace, "after_tool_dispatch", toolName)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "after_tool_dispatch",
        agent_name: run.agentName,
        effective_agent_name: activeAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        tool_name: toolName,
        tool_input: input,
        tool_output: currentOutput,
        ...(toolCallId ? { tool_call_id: toolCallId } : {})
      });

      this.#ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.tool_output;
      if (patch !== undefined && hook.capabilities.includes("rewrite_tool_response")) {
        currentOutput = this.#applyToolPatch(currentOutput, patch);
      }
      if (result?.suppressOutput && hook.capabilities.includes("suppress_output")) {
        currentOutput = "";
      }

      const notes = [result?.systemMessage, result?.hookSpecificOutput?.additionalContext].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      if (notes.length > 0) {
        currentOutput = this.#appendToolOutputNotes(currentOutput, notes);
      }
    }

    return currentOutput;
  }

  #applyToolPatch(currentValue: unknown, patch: unknown): unknown {
    if (
      currentValue &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue) &&
      patch &&
      typeof patch === "object" &&
      !Array.isArray(patch)
    ) {
      return {
        ...(currentValue as Record<string, unknown>),
        ...(patch as Record<string, unknown>)
      };
    }

    return patch;
  }

  #appendToolOutputNotes(currentValue: unknown, notes: string[]): unknown {
    if (typeof currentValue === "string") {
      return [currentValue, ...notes].filter((value) => value.length > 0).join("\n\n");
    }

    if (currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)) {
      const existingNotes = Array.isArray((currentValue as { hookNotes?: unknown }).hookNotes)
        ? ((currentValue as { hookNotes: unknown[] }).hookNotes.filter((value): value is string => typeof value === "string") ??
          [])
        : [];
      return {
        ...(currentValue as Record<string, unknown>),
        hookNotes: [...existingNotes, ...notes]
      };
    }

    return notes.join("\n\n");
  }

  async #runLifecycleHooks(
    workspace: WorkspaceRecord,
    session: Session | undefined,
    run: Run,
    eventName: "run_completed" | "run_failed"
  ): Promise<void> {
    const hooks = this.#selectHooks(workspace, eventName, run.triggerType);
    for (const hook of hooks) {
      try {
        await this.#executeHook(workspace, session, run, hook, {
          workspace_id: workspace.id,
          ...(session ? { session_id: session.id } : {}),
          run_id: run.id,
          cwd: workspace.rootPath,
          hook_event_name: eventName,
          agent_name: run.agentName,
          effective_agent_name: run.effectiveAgentName,
          trigger_type: run.triggerType,
          run_status: run.status
        });
      } catch {
        continue;
      }
    }
  }

  #selectHooks(workspace: WorkspaceRecord, eventName: string, matcherValue?: string): WorkspaceRecord["hooks"][string][] {
    if (workspace.kind === "chat") {
      return [];
    }

    return Object.values(workspace.hooks).filter((hook) => {
      if (!hook.events.includes(eventName)) {
        return false;
      }

      if (!hook.matcher || !matcherValue) {
        return true;
      }

      try {
        return new RegExp(hook.matcher, "u").test(matcherValue);
      } catch {
        return false;
      }
    });
  }

  #ensureHookCanContinue(result: HookResult | undefined, hookName: string): void {
    if (!result) {
      return;
    }

    if (result.continue === false || result.decision === "block") {
      throw new AppError(409, "hook_blocked", result.stopReason ?? result.reason ?? `Hook ${hookName} blocked execution.`);
    }
  }

  #insertSystemMessages(
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>,
    extraSystemMessages: Array<{ role: "system"; content: string }>
  ): Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> {
    const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
    if (firstNonSystemIndex === -1) {
      return [...messages, ...extraSystemMessages];
    }

    return [
      ...messages.slice(0, firstNonSystemIndex),
      ...extraSystemMessages,
      ...messages.slice(firstNonSystemIndex)
    ];
  }

  #serializeModelRequest(modelInput: ModelExecutionInput): Record<string, unknown> {
    return {
      model: modelInput.model,
      canonicalModelRef: modelInput.canonicalModelRef,
      temperature: modelInput.temperature,
      maxTokens: modelInput.maxTokens,
      messages: modelInput.messages
    };
  }

  #applyModelRequestPatch(
    workspace: WorkspaceRecord,
    current: ModelExecutionInput,
    patch: Record<string, unknown>
  ): ModelExecutionInput {
    let next = { ...current };

    const patchedModelRef =
      typeof patch.model_ref === "string" ? patch.model_ref : typeof patch.model === "string" ? patch.model : undefined;
    if (patchedModelRef) {
      const resolved = this.#resolveModelForRun(workspace, patchedModelRef);
      next = {
        ...next,
        model: resolved.model,
        canonicalModelRef: resolved.canonicalModelRef,
        provider: resolved.provider,
        modelDefinition: resolved.modelDefinition
      };
    }

    if (typeof patch.temperature === "number") {
      next.temperature = patch.temperature;
    }
    if (typeof patch.maxTokens === "number") {
      next.maxTokens = patch.maxTokens;
    }
    if (Array.isArray(patch.messages)) {
      next.messages = patch.messages
        .filter(
          (message): message is { role: "system" | "user" | "assistant" | "tool"; content: string } =>
            typeof message === "object" &&
            message !== null &&
            typeof (message as { role?: unknown }).role === "string" &&
            typeof (message as { content?: unknown }).content === "string"
        )
        .map((message) => ({
          role: message.role,
          content: message.content
        }));
    }

    return next;
  }

  #applyModelResponsePatch(response: ModelGenerateResponse, patch: Record<string, unknown>): ModelGenerateResponse {
    return {
      ...response,
      ...(typeof patch.text === "string" ? { text: patch.text } : {}),
      ...(typeof patch.finishReason === "string" ? { finishReason: patch.finishReason } : {})
    };
  }

  async #ensureAssistantMessage(
    session: Session,
    run: Run,
    currentMessage: Message | undefined,
    content = ""
  ): Promise<Message> {
    if (currentMessage) {
      return currentMessage;
    }

    return this.#messageRepository.create({
      id: createId("msg"),
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      content,
      createdAt: nowIso()
    });
  }

  async #persistToolResults(
    session: Session,
    run: Run,
    step: ModelStepResult,
    persistedToolCalls: Set<string>
  ): Promise<void> {
    for (const toolResult of step.toolResults) {
      if (persistedToolCalls.has(toolResult.toolCallId)) {
        continue;
      }

      persistedToolCalls.add(toolResult.toolCallId);
      const toolMessage = await this.#messageRepository.create({
        id: createId("msg"),
        sessionId: session.id,
        runId: run.id,
        role: "tool",
        toolName: toolResult.toolName,
        toolCallId: toolResult.toolCallId,
        content: this.#serializeToolOutput(toolResult.output),
        createdAt: nowIso()
      });

      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "message.completed",
        data: {
          runId: run.id,
          messageId: toolMessage.id,
          content: toolMessage.content,
          toolName: toolMessage.toolName,
          toolCallId: toolMessage.toolCallId
        }
      });
    }
  }

  #serializeToolOutput(output: unknown): string {
    if (typeof output === "string") {
      return output;
    }

    if (output === undefined) {
      return "";
    }

    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }

  async #executeHook(
    workspace: WorkspaceRecord,
    session: Session | undefined,
    run: Run,
    hook: WorkspaceRecord["hooks"][string],
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    const handler = hook.definition.handler as Record<string, unknown> | undefined;
    if (!handler || typeof handler.type !== "string") {
      return undefined;
    }

    const hookStep = await this.#startRunStep({
      runId: run.id,
      stepType: "hook",
      name: hook.name,
      agentName: run.effectiveAgentName,
      input: {
        hookEventName: envelope.hook_event_name,
        handlerType: handler.type,
        ...(hook.matcher ? { matcher: hook.matcher } : {})
      }
    });

    try {
      let result: HookResult | undefined;
      switch (handler.type) {
        case "command":
          result = await this.#executeCommandHook(workspace, handler, envelope);
          break;
        case "http":
          result = await this.#executeHttpHook(handler, envelope);
          break;
        case "prompt":
          result = await this.#executePromptHook(workspace, hook, handler, envelope);
          break;
        case "agent":
          result = await this.#executeAgentHook(workspace, hook, handler, session, run, envelope);
          break;
        default:
          result = undefined;
          break;
      }

      const completedHookStep = await this.#completeRunStep(hookStep, "completed", this.#serializeHookResult(result));
      await this.#recordHookRunAudit(hook, envelope, completedHookStep, "completed", result);
      return result;
    } catch (error) {
      const failedHookStep = await this.#completeRunStep(hookStep, "failed", {
        errorMessage: error instanceof Error ? error.message : "Unknown hook execution error."
      });
      await this.#recordHookRunAudit(hook, envelope, failedHookStep, "failed", undefined, error);
      if (session) {
        const errorCode = error instanceof AppError ? error.code : "hook_execution_failed";
        await this.#appendEvent({
          sessionId: session.id,
          runId: run.id,
          event: "hook.notice",
          data: {
            runId: run.id,
            sessionId: session.id,
            hookName: hook.name,
            eventName: envelope.hook_event_name,
            handlerType: handler.type,
            errorCode,
            errorMessage: error instanceof Error ? error.message : "Unknown hook execution error."
          }
        });
      }
      return undefined;
    }
  }

  async #executeCommandHook(
    workspace: WorkspaceRecord,
    handler: Record<string, unknown>,
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    if (typeof handler.command !== "string") {
      return undefined;
    }

    const cwd =
      typeof handler.cwd === "string" ? path.resolve(workspace.rootPath, handler.cwd) : workspace.rootPath;
    const child = spawn(handler.command, {
      cwd,
      env: {
        ...process.env,
        ...(handler.environment && typeof handler.environment === "object"
          ? (handler.environment as Record<string, string>)
          : {})
      },
      shell: true
    });
    const timeoutMs = timeoutMsFromSeconds(handler.timeout_seconds);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const killTimer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : undefined;

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    }).finally(() => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
    });

    if (timedOut) {
      throw new Error(`Command hook timed out after ${timeoutMs}ms.`);
    }

    if (exitCode === 2) {
      return {
        continue: false,
        stopReason: stderr.trim() || `Hook blocked execution: ${handler.command}`
      };
    }

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Command hook exited with code ${exitCode}.`);
    }

    if (stdout.trim().length === 0) {
      return undefined;
    }

    const parsed = this.#parseHookResult(stdout);
    if (!parsed) {
      throw new Error("Command hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #executeHttpHook(handler: Record<string, unknown>, envelope: HookEnvelope): Promise<HookResult | undefined> {
    if (typeof handler.url !== "string") {
      return undefined;
    }

    const timeoutMs = timeoutMsFromSeconds(handler.timeout_seconds);
    const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
    const abortTimer =
      timeoutMs !== undefined && abortController
        ? setTimeout(() => {
            abortController.abort();
          }, timeoutMs)
        : undefined;

    const response = await fetch(handler.url, {
      method: typeof handler.method === "string" ? handler.method : "POST",
      headers: {
        "content-type": "application/json",
        ...(handler.headers && typeof handler.headers === "object" ? (handler.headers as Record<string, string>) : {})
      },
      body: JSON.stringify(envelope),
      ...(abortController ? { signal: abortController.signal } : {})
    })
      .catch((error) => {
        if (isAbortError(error)) {
          throw new Error(`HTTP hook timed out after ${timeoutMs}ms.`);
        }

        throw error;
      })
      .finally(() => {
        if (abortTimer) {
          clearTimeout(abortTimer);
        }
      });

    if (!response.ok) {
      throw new Error(`HTTP hook returned ${response.status}.`);
    }

    const body = await response.text();
    if (!body.trim()) {
      return undefined;
    }

    const parsed = this.#parseHookResult(body);
    if (!parsed) {
      throw new Error("HTTP hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #executePromptHook(
    workspace: WorkspaceRecord,
    hook: WorkspaceRecord["hooks"][string],
    handler: Record<string, unknown>,
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    const prompt = await this.#resolveHookPromptSource(workspace, handler.prompt as Record<string, unknown> | undefined);
    if (!prompt) {
      return undefined;
    }

    const resolvedModel = this.#resolveModelForRun(
      workspace,
      typeof handler.model_ref === "string" ? handler.model_ref : this.#defaultModel
    );
    const timeoutMs = timeoutMsFromSeconds(handler.timeout_seconds);
    const result = await withTimeout(
      async (signal) => {
        const request = {
          model: resolvedModel.model,
          ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
          prompt: [
            prompt,
            "Return only JSON matching the Open Agent Harness hook output protocol.",
            JSON.stringify({
              hook: hook.name,
              envelope
            })
          ].join("\n\n")
        };
        return this.#modelGateway.generate(request, signal ? { signal } : undefined);
      },
      timeoutMs,
      `Prompt hook timed out after ${timeoutMs}ms.`
    );

    const parsed = this.#parseHookResult(result.text);
    if (!parsed) {
      throw new Error("Prompt hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #executeAgentHook(
    workspace: WorkspaceRecord,
    hook: WorkspaceRecord["hooks"][string],
    handler: Record<string, unknown>,
    _session: Session | undefined,
    _run: Run,
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    if (typeof handler.agent !== "string") {
      return undefined;
    }

    const agent = workspace.agents[handler.agent];
    if (!agent) {
      throw new AppError(404, "agent_not_found", `Agent ${handler.agent} was not found in workspace ${workspace.id}.`);
    }

    const task = await this.#resolveHookPromptSource(workspace, handler.task as Record<string, unknown> | undefined);
    if (!task) {
      return undefined;
    }

    const resolvedModel = this.#resolveModelForRun(workspace, agent.modelRef);
    const timeoutMs = timeoutMsFromSeconds(handler.timeout_seconds);
    const result = await withTimeout(
      async (signal) => {
        const request: GenerateModelInput = {
          model: resolvedModel.model,
          ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
          ...(agent.maxTokens !== undefined ? { maxTokens: agent.maxTokens } : {}),
          ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
          messages: [
            { role: "system", content: agent.prompt },
            { role: "user", content: task },
            {
              role: "user",
              content: `Return only JSON matching the Open Agent Harness hook output protocol.\n\n${JSON.stringify({
                hook: hook.name,
                envelope
              })}`
            }
          ]
        };
        return this.#modelGateway.generate(request, signal ? { signal } : undefined);
      },
      timeoutMs,
      `Agent hook timed out after ${timeoutMs}ms.`
    );

    const parsed = this.#parseHookResult(result.text);
    if (!parsed) {
      throw new Error("Agent hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #resolveHookPromptSource(
    workspace: WorkspaceRecord,
    promptSource: Record<string, unknown> | undefined
  ): Promise<string | undefined> {
    if (!promptSource) {
      return undefined;
    }

    if (typeof promptSource.inline === "string") {
      return promptSource.inline;
    }

    if (typeof promptSource.file === "string") {
      return readFile(path.resolve(workspace.rootPath, promptSource.file), "utf8");
    }

    return undefined;
  }

  #parseHookResult(rawOutput: string): HookResult | undefined {
    const trimmed = rawOutput.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
    if (!jsonMatch) {
      return undefined;
    }

    try {
      return JSON.parse(jsonMatch[0]) as HookResult;
    } catch {
      return undefined;
    }
  }

  #serializeHookResult(result: HookResult | undefined): Record<string, unknown> {
    if (!result) {
      return {
        result: null
      };
    }

    return {
      ...(result.continue !== undefined ? { continue: result.continue } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      ...(result.suppressOutput !== undefined ? { suppressOutput: result.suppressOutput } : {}),
      ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
      ...(result.decision ? { decision: result.decision } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.hookSpecificOutput ? { hookSpecificOutput: result.hookSpecificOutput } : {})
    };
  }

  async #processActionRun(
    workspace: WorkspaceRecord,
    run: Run,
    session: Session | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const actionName = typeof run.metadata?.actionName === "string" ? run.metadata.actionName : run.triggerRef;
    if (!actionName) {
      throw new AppError(500, "action_name_missing", `Run ${run.id} is missing an action name.`);
    }

    const action = workspace.actions[actionName];
    if (!action) {
      throw new AppError(404, "action_not_found", `Action ${actionName} was not found in workspace ${workspace.id}.`);
    }

    const actionStep = await this.#startRunStep({
      runId: run.id,
      stepType: "tool_call",
      name: action.name,
      ...(run.effectiveAgentName ? { agentName: run.effectiveAgentName } : {}),
      input: {
        sourceType: "action",
        actionName: action.name,
        input: this.#normalizeJsonObject(run.metadata?.input ?? null)
      }
    });

    let result: { stdout: string; stderr: string; exitCode: number; output: string };
    try {
      result = await this.#executeAction(workspace, action, run, signal);
    } catch (error) {
      const latestRun = await this.getRun(run.id);
      const failedStatus = signal.aborted || latestRun.status === "cancelled" ? "cancelled" : "failed";
      const completedActionStep = await this.#completeRunStep(actionStep, failedStatus, {
        sourceType: "action",
        actionName: action.name,
        ...(latestRun.errorCode ? { errorCode: latestRun.errorCode } : {}),
        ...(latestRun.errorMessage ? { errorMessage: latestRun.errorMessage } : {})
      });
      await this.#recordToolCallAuditFromStep(completedActionStep, action.name, failedStatus);
      throw error;
    }

    const completedActionStep = await this.#completeRunStep(actionStep, "completed", {
      sourceType: "action",
      actionName: action.name,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    });
    await this.#recordToolCallAuditFromStep(completedActionStep, action.name, "completed");

    if (session) {
      const toolMessage = await this.#messageRepository.create({
        id: createId("msg"),
        sessionId: session.id,
        runId: run.id,
        role: "tool",
        toolName: action.name,
        content: result.output,
        createdAt: nowIso()
      });

      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "message.completed",
        data: {
          runId: run.id,
          messageId: toolMessage.id,
          content: toolMessage.content,
          actionName: action.name
        }
      });
    }

    const endedAt = nowIso();
    const completedRun = await this.#setRunStatus(run, "completed", {
      endedAt,
      metadata: {
        ...(run.metadata ?? {}),
        actionName: action.name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      }
    });
    await this.#recordSystemStep(completedRun, "run.completed", {
      status: completedRun.status
    });

    if (session) {
      await this.#sessionRepository.update({
        ...session,
        lastRunAt: endedAt,
        updatedAt: endedAt
      });

      await this.#appendEvent({
        sessionId: session.id,
        runId: completedRun.id,
        event: "run.completed",
        data: {
          runId: completedRun.id,
          sessionId: session.id,
          status: completedRun.status
        }
      });
    }
  }

  async #executeAction(
    workspace: WorkspaceRecord,
    action: WorkspaceRecord["actions"][string],
    run: Run,
    signal: AbortSignal | undefined,
    explicitInput?: unknown
  ): Promise<{ stdout: string; stderr: string; exitCode: number; output: string }> {
    if (workspace.kind === "chat") {
      throw new AppError(400, "actions_not_supported", `Workspace ${workspace.id} does not allow action execution.`);
    }

    const cwd = action.entry.cwd ? path.resolve(action.directory, action.entry.cwd) : action.directory;
    const env = {
      ...process.env,
      ...(action.entry.environment ?? {}),
      OPENHARNESS_WORKSPACE_ROOT: workspace.rootPath,
      OPENHARNESS_ACTION_NAME: action.name,
      OPENHARNESS_RUN_ID: run.id,
      OPENHARNESS_DEFAULT_MODEL: this.#defaultModel,
      OPENHARNESS_ACTION_INPUT: JSON.stringify(explicitInput ?? run.metadata?.input ?? null)
    };

    const child = spawn(action.entry.command, {
      cwd,
      env,
      ...(signal ? { signal } : {}),
      shell: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout =
      action.entry.timeoutSeconds !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, action.entry.timeoutSeconds * 1000)
        : undefined;

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    }).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });

    if (signal?.aborted) {
      throw new Error("aborted");
    }

    if (timedOut) {
      const timedOutRun = await this.#setRunStatus(run, "timed_out", {
        endedAt: nowIso(),
        errorCode: "action_timed_out",
        errorMessage: `Action ${action.name} timed out.`
      });
      await this.#recordSystemStep(timedOutRun, "run.timed_out", {
        status: timedOutRun.status,
        errorCode: timedOutRun.errorCode,
        errorMessage: timedOutRun.errorMessage
      });
      throw new AppError(408, "action_timed_out", `Action ${action.name} timed out.`);
    }

    if (exitCode !== 0) {
      const failedRun = await this.#setRunStatus(run, "failed", {
        endedAt: nowIso(),
        errorCode: "action_failed",
        errorMessage: stderr.trim() || `Action ${action.name} exited with code ${exitCode}.`,
        metadata: {
          ...(run.metadata ?? {}),
          actionName: action.name,
          exitCode,
          stdout,
          stderr
        }
      });
      await this.#recordSystemStep(failedRun, "run.failed", {
        status: failedRun.status,
        errorCode: failedRun.errorCode,
        errorMessage: failedRun.errorMessage
      });
      throw new AppError(500, "action_failed", stderr.trim() || `Action ${action.name} exited with code ${exitCode}.`);
    }

    const output = stdout || stderr || "";
    return {
      stdout,
      stderr,
      exitCode,
      output
    };
  }

  async #recordToolCallAuditFromStep(
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ): Promise<void> {
    if (!this.#toolCallAuditRepository || !step.endedAt) {
      return;
    }

    const inputPayload = this.#asJsonRecord(step.input);
    const outputPayload = this.#asJsonRecord(step.output);
    const rawDurationMs =
      outputPayload && typeof outputPayload.durationMs === "number" ? outputPayload.durationMs : undefined;

    await this.#toolCallAuditRepository.create({
      id: createId("tool"),
      runId: step.runId,
      stepId: step.id,
      sourceType: this.#toolCallAuditSourceType(inputPayload, toolName),
      toolName,
      ...(inputPayload ? { request: inputPayload } : {}),
      ...(outputPayload ? { response: outputPayload } : {}),
      status,
      ...(rawDurationMs !== undefined ? { durationMs: rawDurationMs } : {}),
      startedAt: step.startedAt ?? step.endedAt,
      endedAt: step.endedAt
    });
  }

  #asJsonRecord(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return undefined;
  }

  #toolCallAuditSourceType(inputPayload: Record<string, unknown> | undefined, toolName: string) {
    const sourceType = inputPayload?.sourceType;
    if (
      sourceType === "action" ||
      sourceType === "skill" ||
      sourceType === "agent" ||
      sourceType === "mcp" ||
      sourceType === "tool" ||
      sourceType === "native"
    ) {
      return sourceType === "mcp" ? "tool" : sourceType;
    }

    return this.#toolSourceType(toolName);
  }

  async #recordHookRunAudit(
    hook: WorkspaceRecord["hooks"][string],
    envelope: HookEnvelope,
    step: RunStep,
    status: "completed" | "failed",
    result?: HookResult | undefined,
    error?: unknown
  ): Promise<void> {
    if (!this.#hookRunAuditRepository || !step.endedAt) {
      return;
    }

    const patch =
      result?.hookSpecificOutput?.patch && typeof result.hookSpecificOutput.patch === "object"
        ? (result.hookSpecificOutput.patch as Record<string, unknown>)
        : undefined;

    await this.#hookRunAuditRepository.create({
      id: createId("hookrun"),
      runId: step.runId,
      hookName: hook.name,
      eventName: envelope.hook_event_name,
      capabilities: hook.capabilities,
      ...(patch ? { patch } : {}),
      status,
      startedAt: step.startedAt ?? step.endedAt,
      endedAt: step.endedAt,
      ...(status === "failed"
        ? {
            errorMessage: error instanceof Error ? error.message : "Unknown hook execution error."
          }
        : {})
    });
  }

  #publicWorkspaceCatalog(workspace: WorkspaceRecord): RuntimeWorkspaceCatalog {
    const tools = workspace.catalog.tools ?? workspace.catalog.mcp ?? [];
    if (workspace.kind !== "chat") {
      return {
        ...workspace.catalog,
        tools,
        mcp: [...tools],
        nativeTools: [...NATIVE_TOOL_NAMES]
      };
    }

    return {
      ...workspace.catalog,
      actions: [],
      skills: [],
      tools: [],
      mcp: [],
      hooks: [],
      nativeTools: []
    };
  }
}
