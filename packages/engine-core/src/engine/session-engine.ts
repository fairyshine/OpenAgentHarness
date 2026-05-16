import type { Message, Run, Session } from "@oah/api-contracts";

import { validateActionInput } from "../capabilities/action-input-validation.js";
import { AppError } from "../errors.js";
import {
  extractTextFromContent,
  isMessageContentForRole
} from "../execution-message-content.js";
import type { EngineMessageProjector, TranscriptMessage } from "./message-projections.js";
import type { ModelInputService } from "./model-input.js";
import type { EngineMessageSyncService } from "./engine-message-sync.js";
import { SessionMessageCreationService } from "./session-message-creation.js";
import { SessionRecordService } from "./session-records.js";
import type {
  ActionRunAcceptedResult,
  CreateSessionMessageParams,
  CreateSessionParams,
  GuideQueuedRunResult,
  MessageContextResult,
  MessagePageDirection,
  MessageListResult,
  MessageAcceptedResult,
  RunListResult,
  RunStepListResult,
  EngineMessageListResult,
  EngineServiceOptions,
  EngineWorkspaceCatalog,
  SessionListResult,
  SessionQueuedRunListResult,
  TriggerActionRunParams,
  UpdateSessionParams,
  WorkspaceRecord
} from "../types.js";
import { createId, nowIso, parseCursor } from "../utils.js";
import type { EngineMessage } from "./engine-messages.js";
import { buildSessionRecord, resolveWorkspaceDefaultAgentName } from "./session-creation.js";

export interface SessionEngineServiceDependencies {
  sessionRepository: EngineServiceOptions["sessionRepository"];
  messageRepository: EngineServiceOptions["messageRepository"];
  runRepository: EngineServiceOptions["runRepository"];
  runStepRepository: EngineServiceOptions["runStepRepository"];
  sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  workspaceArchiveRepository?: EngineServiceOptions["workspaceArchiveRepository"] | undefined;
  modelInputs: ModelInputService;
  engineMessageSync: EngineMessageSyncService;
  engineMessageProjector: EngineMessageProjector;
  getWorkspaceRecord: (workspaceId: string) => Promise<WorkspaceRecord>;
  getRun: (runId: string) => Promise<Run>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "run.queued" | "queue.updated";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  enqueueRun: (sessionId: string, runId: string) => Promise<void>;
  requestRunCancellation: (runId: string) => Promise<void>;
}

export class SessionEngineService {
  readonly #sessionRepository: EngineServiceOptions["sessionRepository"];
  readonly #messageRepository: EngineServiceOptions["messageRepository"];
  readonly #runRepository: EngineServiceOptions["runRepository"];
  readonly #runStepRepository: EngineServiceOptions["runStepRepository"];
  readonly #sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  readonly #workspaceArchiveRepository: EngineServiceOptions["workspaceArchiveRepository"];
  readonly #modelInputs: ModelInputService;
  readonly #engineMessageSync: EngineMessageSyncService;
  readonly #engineMessageProjector: EngineMessageProjector;
  readonly #getWorkspaceRecord: SessionEngineServiceDependencies["getWorkspaceRecord"];
  readonly #getRun: SessionEngineServiceDependencies["getRun"];
  readonly #appendEvent: SessionEngineServiceDependencies["appendEvent"];
  readonly #enqueueRun: SessionEngineServiceDependencies["enqueueRun"];
  readonly #requestRunCancellation: SessionEngineServiceDependencies["requestRunCancellation"];
  readonly #sessionRecords: SessionRecordService;
  readonly #sessionMessageCreation: SessionMessageCreationService;

  constructor(dependencies: SessionEngineServiceDependencies) {
    this.#sessionRepository = dependencies.sessionRepository;
    this.#messageRepository = dependencies.messageRepository;
    this.#runRepository = dependencies.runRepository;
    this.#runStepRepository = dependencies.runStepRepository;
    this.#sessionPendingRunQueueRepository = dependencies.sessionPendingRunQueueRepository;
    this.#workspaceArchiveRepository = dependencies.workspaceArchiveRepository;
    this.#modelInputs = dependencies.modelInputs;
    this.#engineMessageSync = dependencies.engineMessageSync;
    this.#engineMessageProjector = dependencies.engineMessageProjector;
    this.#getWorkspaceRecord = dependencies.getWorkspaceRecord;
    this.#getRun = dependencies.getRun;
    this.#appendEvent = dependencies.appendEvent;
    this.#enqueueRun = dependencies.enqueueRun;
    this.#requestRunCancellation = dependencies.requestRunCancellation;
    this.#sessionRecords = new SessionRecordService({
      sessionRepository: this.#sessionRepository,
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      runStepRepository: this.#runStepRepository,
      sessionPendingRunQueueRepository: this.#sessionPendingRunQueueRepository,
      workspaceArchiveRepository: this.#workspaceArchiveRepository,
      getWorkspaceRecord: this.#getWorkspaceRecord,
      normalizeModelRef: (workspace, modelRef) => this.#modelInputs.normalizeSessionModelRef(workspace, modelRef)
    });
    this.#sessionMessageCreation = new SessionMessageCreationService({
      messageRepository: this.#messageRepository,
      runRepository: this.#runRepository,
      sessionPendingRunQueueRepository: this.#sessionPendingRunQueueRepository,
      sessionRecords: this.#sessionRecords,
      appendEvent: this.#appendEvent,
      enqueueRun: this.#enqueueRun,
      requestRunCancellation: this.#requestRunCancellation
    });
  }

  async createSession({ workspaceId, caller, input }: CreateSessionParams): Promise<Session> {
    const workspace = await this.#getWorkspaceRecord(workspaceId);
    return this.#sessionRepository.create(
      buildSessionRecord({
        workspace,
        caller,
        sessionInput: input,
        normalizeModelRef: (targetWorkspace, modelRef) => this.#modelInputs.normalizeSessionModelRef(targetWorkspace, modelRef),
        createId,
        nowIso
      })
    );
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.#sessionRecords.getSession(sessionId);
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

  async listChildSessions(parentSessionId: string, pageSize: number, cursor?: string): Promise<SessionListResult> {
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
    await this.getSession(sessionId);
    const engineMessages = await this.#engineMessageSync.loadSessionEngineMessages(sessionId);
    const startIndex = parseCursor(cursor);
    const items = engineMessages.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < engineMessages.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionTranscriptMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    await this.getSession(sessionId);
    const engineMessages = await this.#engineMessageSync.loadSessionEngineMessages(sessionId);
    const engineMessagesById = new Map(engineMessages.map((message) => [message.id, message]));
    const projection = this.#engineMessageProjector.projectToTranscript(engineMessages, {
      sessionId,
      activeAgentName: "",
      applyCompactBoundary: false
    });
    const transcriptMessages = projection.messages.map((message) =>
      this.#toTranscriptMessage(sessionId, message, engineMessagesById)
    );
    const startIndex = parseCursor(cursor);
    const items = transcriptMessages.slice(startIndex, startIndex + pageSize);
    const nextCursor =
      startIndex + pageSize < transcriptMessages.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionRuns(sessionId: string, pageSize = 100, cursor?: string): Promise<RunListResult> {
    return this.#sessionRecords.listSessionRuns(sessionId, pageSize, cursor);
  }

  async listRunSteps(runId: string, pageSize = 100, cursor?: string): Promise<RunStepListResult> {
    return this.#sessionRecords.listRunSteps(runId, pageSize, cursor);
  }

  async createSessionMessage({ sessionId, caller, input }: CreateSessionMessageParams): Promise<MessageAcceptedResult> {
    return this.#sessionMessageCreation.createSessionMessage({ sessionId, caller, input });
  }

  async listSessionQueuedRuns(sessionId: string): Promise<SessionQueuedRunListResult> {
    return this.#sessionRecords.listSessionQueuedRuns(sessionId);
  }

  async #removeQueuedRunBestEffort(sessionId: string, runId: string): Promise<void> {
    await this.#sessionRecords.removeQueuedRunBestEffort(sessionId, runId);
    await this.#appendQueueUpdatedEvent(sessionId, runId, "removed").catch(() => undefined);
  }

  async #appendQueueUpdatedEvent(
    sessionId: string,
    runId: string,
    action: "enqueued" | "promoted" | "dequeued" | "removed",
    queuedPosition?: number
  ): Promise<void> {
    await this.#sessionMessageCreation.appendQueueUpdatedEvent(sessionId, runId, action, queuedPosition);
  }

  async guideQueuedRun(runId: string): Promise<GuideQueuedRunResult> {
    let queueEntry = await this.#sessionPendingRunQueueRepository.getByRunId(runId);
    if (!queueEntry) {
      const run = await this.#runRepository.getById(runId).catch(() => null);
      if (run?.sessionId) {
        const sessionEntries = await this.#sessionPendingRunQueueRepository.listBySessionId(run.sessionId).catch(() => []);
        queueEntry = sessionEntries.find((entry) => entry.runId === runId) ?? null;
      }
      if (!queueEntry && run?.sessionId && run.triggerType === "message") {
        return {
          runId,
          status: "interrupt_requested"
        };
      }
    }

    if (!queueEntry) {
      throw new AppError(404, "queued_run_not_found", `Queued run ${runId} was not found.`);
    }

    const sessionQueueState = await this.#getSessionQueueState(queueEntry.sessionId);
    await this.#sessionPendingRunQueueRepository.promote(runId);
    await this.#appendQueueUpdatedEvent(queueEntry.sessionId, runId, "promoted", queueEntry.position);
    if (sessionQueueState.hasActiveRun) {
      await this.#interruptActiveSessionRuns(queueEntry.sessionId, sessionQueueState.pendingRunIds);
    } else {
      await this.dispatchNextQueuedRun(queueEntry.sessionId);
    }

    return {
      runId,
      status: "interrupt_requested"
    };
  }

  async dispatchNextQueuedRun(sessionId: string): Promise<string | undefined> {
    return this.#sessionMessageCreation.dispatchNextQueuedRun(sessionId);
  }

  async #interruptActiveSessionRuns(sessionId: string, pendingRunIds?: ReadonlySet<string>): Promise<void> {
    const runs = await this.#runRepository.listBySessionId(sessionId);
    const queuedRunIds = pendingRunIds ?? new Set((await this.#sessionPendingRunQueueRepository.listBySessionId(sessionId)).map((entry) => entry.runId));
    const activeRuns = runs.filter(
      (run) =>
        (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") &&
        !queuedRunIds.has(run.id) &&
        !run.cancelRequestedAt
    );

    await Promise.all(activeRuns.map((run) => this.#requestRunCancellation(run.id)));
  }

  async #getSessionQueueState(sessionId: string): Promise<{
    hasActiveRun: boolean;
    pendingRunIds: Set<string>;
  }>;
  async #getSessionQueueState(
    sessionId: string,
    options: {
      excludeRunIds?: string[] | undefined;
    }
  ): Promise<{
    hasActiveRun: boolean;
    pendingRunIds: Set<string>;
  }>;
  async #getSessionQueueState(
    sessionId: string,
    options?: {
      excludeRunIds?: string[] | undefined;
    }
  ): Promise<{
    hasActiveRun: boolean;
    pendingRunIds: Set<string>;
  }> {
    const [runs, pendingRuns] = await Promise.all([
      this.#runRepository.listBySessionId(sessionId),
      this.#sessionPendingRunQueueRepository.listBySessionId(sessionId)
    ]);
    const excludedRunIds = new Set(options?.excludeRunIds ?? []);
    const pendingRunIds = new Set(pendingRuns.map((entry) => entry.runId));
    const hasActiveRun = runs.some(
      (run) =>
        (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") &&
        !excludedRunIds.has(run.id) &&
        !pendingRunIds.has(run.id) &&
        !run.cancelRequestedAt
    );

    return {
      hasActiveRun,
      pendingRunIds
    };
  }

  async #retimestampQueuedMessageForDispatch(runId: string, sessionId: string, dispatchAt: string): Promise<void> {
    const run = await this.#runRepository.getById(runId).catch(() => null);
    if (!run || run.sessionId !== sessionId || run.triggerType !== "message" || !run.triggerRef) {
      return;
    }

    const message = await this.#messageRepository.getById(run.triggerRef).catch(() => null);
    if (!message || message.sessionId !== sessionId) {
      return;
    }

    await this.#messageRepository.update({
      ...message,
      runId,
      createdAt: dispatchAt
    });
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
    const workspace = await this.#getWorkspaceRecord(workspaceId);
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

    const resolvedAgentName = agentName ?? session?.activeAgentName ?? resolveWorkspaceDefaultAgentName(workspace);
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
      ...(resolvedAgentName
        ? { agentName: resolvedAgentName, effectiveAgentName: resolvedAgentName }
        : { effectiveAgentName: "default" }),
      switchCount: 0,
      status: "queued",
      createdAt: now,
      metadata: {
        actionName,
        input: input ?? null,
        ...(workspaceMemory ? { workspaceMemory } : {})
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

  #toTranscriptMessage(
    sessionId: string,
    message: TranscriptMessage,
    engineMessagesById: Map<string, EngineMessage>
  ): Message {
    const sourceEngineMessage = message.sourceMessageIds
      .map((sourceMessageId) => engineMessagesById.get(sourceMessageId))
      .find((candidate): candidate is EngineMessage => candidate !== undefined);
    const metadata = {
      ...(sourceEngineMessage?.metadata ?? {}),
      projectedView: message.view,
      projectedSemanticType: message.semanticType,
      projectedSourceMessageIds: message.sourceMessageIds,
      ...(message.metadata ? { projectionMetadata: message.metadata } : {})
    };

    const baseMessage = {
      id: sourceEngineMessage?.id ?? message.sourceMessageIds[0] ?? createId("msg"),
      sessionId,
      ...(sourceEngineMessage?.runId ? { runId: sourceEngineMessage.runId } : {}),
      metadata,
      createdAt: sourceEngineMessage?.createdAt ?? nowIso()
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

}
