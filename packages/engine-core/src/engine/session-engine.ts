import type { Message, Run, Session } from "@oah/api-contracts";

import { validateActionInput } from "../capabilities/action-input-validation.js";
import { AppError } from "../errors.js";
import {
  extractTextFromContent,
  isMessageContentForRole,
  summarizeContentForDisplay
} from "../execution-message-content.js";
import type { EngineMessageProjector, TranscriptMessage } from "./message-projections.js";
import type { ModelInputService } from "./model-input.js";
import type { EngineMessageSyncService } from "./engine-message-sync.js";
import type {
  ActionRunAcceptedResult,
  CreateSessionMessageParams,
  CreateSessionParams,
  GuideQueuedRunResult,
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
import { buildArchiveMetadata } from "./internal-helpers.js";
import type { EngineMessage } from "./engine-messages.js";

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
  }

  async createSession({ workspaceId, caller, input }: CreateSessionParams): Promise<Session> {
    const workspace = await this.#getWorkspaceRecord(workspaceId);
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

  async updateSession({ sessionId, input }: UpdateSessionParams): Promise<Session> {
    const session = await this.getSession(sessionId);
    const workspace = await this.#getWorkspaceRecord(session.workspaceId);
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
    const workspace = await this.#getWorkspaceRecord(session.workspaceId);
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
    await this.#getWorkspaceRecord(workspaceId);
    const startIndex = parseCursor(cursor);
    const items = await this.#sessionRepository.listByWorkspaceId(workspaceId, pageSize, cursor);
    const nextCursor = items.length === pageSize ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionMessages(
    sessionId: string,
    pageSize = 100,
    cursor?: string,
    direction: MessagePageDirection = "forward"
  ): Promise<MessageListResult> {
    await this.getSession(sessionId);
    const messages = await this.#messageRepository.listBySessionId(sessionId);
    if (direction === "backward") {
      const endIndex = cursor ? parseCursor(cursor) : messages.length;
      const startIndex = Math.max(0, endIndex - pageSize);
      const items = messages.slice(startIndex, endIndex);
      const nextCursor = startIndex > 0 ? String(startIndex) : undefined;

      return nextCursor === undefined ? { items } : { items, nextCursor };
    }

    const startIndex = parseCursor(cursor);
    const items = messages.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < messages.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
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
    await this.getSession(sessionId);
    const runs = await this.#runRepository.listBySessionId(sessionId);
    const startIndex = parseCursor(cursor);
    const items = runs.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < runs.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listRunSteps(runId: string, pageSize = 100, cursor?: string): Promise<RunStepListResult> {
    await this.#getRun(runId);
    const steps = await this.#runStepRepository.listByRunId(runId);
    const startIndex = parseCursor(cursor);
    const items = steps.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < steps.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async createSessionMessage({ sessionId, caller, input }: CreateSessionMessageParams): Promise<MessageAcceptedResult> {
    const session = await this.getSession(sessionId);
    const now = nowIso();
    const messageId = createId("msg");
    const runId = createId("run");

    const message: Message = {
      id: messageId,
      sessionId,
      runId,
      role: "user",
      content: input.content,
      metadata: input.metadata,
      createdAt: now
    };

    const run: Run = {
      id: runId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      initiatorRef: caller.subjectRef,
      triggerType: "message",
      triggerRef: messageId,
      agentName: session.activeAgentName,
      effectiveAgentName: session.activeAgentName,
      switchCount: 0,
      status: "queued",
      createdAt: now
    };

    await this.#runRepository.create(run);
    await this.#messageRepository.create(message);
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

    const runningRunBehavior = input.runningRunBehavior ?? "queue";
    const sessionQueueState = await this.#getSessionQueueState(session.id, {
      excludeRunIds: [run.id]
    });

    if (runningRunBehavior === "interrupt") {
      if (sessionQueueState.hasActiveRun || sessionQueueState.pendingRunIds.size > 0) {
        const queuedEntry = await this.#sessionPendingRunQueueRepository.enqueue({
          sessionId: session.id,
          runId: run.id,
          createdAt: now
        });
        await this.#sessionPendingRunQueueRepository.promote(run.id);
        await this.#appendQueueUpdatedEvent(session.id, run.id, "promoted", queuedEntry.position);
        const nextPendingRunIds = new Set(sessionQueueState.pendingRunIds);
        nextPendingRunIds.add(run.id);
        if (sessionQueueState.hasActiveRun) {
          await this.#interruptActiveSessionRuns(session.id, nextPendingRunIds);
        } else {
          await this.dispatchNextQueuedRun(session.id);
        }
        return {
          messageId: message.id,
          runId: run.id,
          status: "queued",
          delivery: "session_queue",
          queuedPosition: queuedEntry.position,
          createdAt: now
        };
      } else {
        await this.#enqueueRun(session.id, run.id);
      }
    } else if (sessionQueueState.hasActiveRun || sessionQueueState.pendingRunIds.size > 0) {
      const queuedEntry = await this.#sessionPendingRunQueueRepository.enqueue({
        sessionId: session.id,
        runId: run.id,
        createdAt: now
      });
      await this.#appendQueueUpdatedEvent(session.id, run.id, "enqueued", queuedEntry.position);
      return {
        messageId: message.id,
        runId: run.id,
        status: "queued",
        delivery: "session_queue",
        queuedPosition: queuedEntry.position,
        createdAt: now
      };
    } else {
      await this.#enqueueRun(session.id, run.id);
    }

    return {
      messageId: message.id,
      runId: run.id,
      status: "queued",
      delivery: "active_run",
      createdAt: now
    };
  }

  async listSessionQueuedRuns(sessionId: string): Promise<SessionQueuedRunListResult> {
    await this.getSession(sessionId);
    return {
      items: await this.#collectSessionQueuedRuns(sessionId, { healStaleEntries: true })
    };
  }

  async #removeQueuedRunBestEffort(sessionId: string, runId: string): Promise<void> {
    await this.#sessionPendingRunQueueRepository.remove(runId).catch(() => undefined);
    await this.#appendQueueUpdatedEvent(sessionId, runId, "removed").catch(() => undefined);
  }

  async #appendQueueUpdatedEvent(
    sessionId: string,
    runId: string,
    action: "enqueued" | "promoted" | "dequeued" | "removed",
    queuedPosition?: number
  ): Promise<void> {
    const items = await this.#collectSessionQueuedRuns(sessionId, { healStaleEntries: false });
    await this.#appendEvent({
      sessionId,
      runId,
      event: "queue.updated",
      data: {
        runId,
        action,
        items,
        ...(typeof queuedPosition === "number" ? { queuedPosition } : {})
      }
    });
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
    const sessionQueueState = await this.#getSessionQueueState(sessionId);
    if (sessionQueueState.hasActiveRun) {
      return undefined;
    }

    const nextQueuedRun = await this.#sessionPendingRunQueueRepository.dequeueNext(sessionId);
    if (!nextQueuedRun) {
      return undefined;
    }

    const dispatchAt = nowIso();
    await this.#retimestampQueuedMessageForDispatch(nextQueuedRun.runId, sessionId, dispatchAt);
    await this.#appendQueueUpdatedEvent(sessionId, nextQueuedRun.runId, "dequeued", nextQueuedRun.position);
    await this.#enqueueRun(sessionId, nextQueuedRun.runId);
    return nextQueuedRun.runId;
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

  async #collectSessionQueuedRuns(
    sessionId: string,
    options: {
      healStaleEntries: boolean;
    }
  ): Promise<SessionQueuedRunListResult["items"]> {
    const entries = await this.#sessionPendingRunQueueRepository.listBySessionId(sessionId);
    const items: SessionQueuedRunListResult["items"] = [];

    for (const entry of entries) {
      try {
        const run = await this.#runRepository.getById(entry.runId).catch(() => null);
        const messageId = run?.triggerType === "message" ? run.triggerRef : undefined;

        if (!run || run.sessionId !== sessionId || run.status !== "queued" || !messageId) {
          if (options.healStaleEntries) {
            await this.#removeQueuedRunBestEffort(sessionId, entry.runId);
          }
          continue;
        }

        const message = await this.#messageRepository.getById(messageId).catch(() => null);
        if (!message) {
          continue;
        }

        if (message.sessionId !== sessionId) {
          if (options.healStaleEntries) {
            await this.#removeQueuedRunBestEffort(sessionId, entry.runId);
          }
          continue;
        }

        items.push({
          runId: entry.runId,
          messageId,
          content: summarizeContentForDisplay(message.content),
          createdAt: entry.createdAt,
          position: items.length + 1
        });
      } catch {
        if (options.healStaleEntries) {
          await this.#removeQueuedRunBestEffort(sessionId, entry.runId);
        }
      }
    }

    return items;
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
      ...(resolvedAgentName
        ? { agentName: resolvedAgentName, effectiveAgentName: resolvedAgentName }
        : { effectiveAgentName: "default" }),
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

  async #sessionHasStarted(sessionId: string): Promise<boolean> {
    const [messages, runs] = await Promise.all([
      this.#messageRepository.listBySessionId(sessionId),
      this.#runRepository.listBySessionId(sessionId)
    ]);
    return messages.length > 0 || runs.length > 0;
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
