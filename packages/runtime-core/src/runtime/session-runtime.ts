import type { Message, Run, Session } from "@oah/api-contracts";

import { validateActionInput } from "../action-input-validation.js";
import { AppError } from "../errors.js";
import {
  extractTextFromContent,
  isMessageContentForRole,
  textContent
} from "../runtime-message-content.js";
import type { RuntimeMessageProjector, TranscriptMessage } from "./message-projections.js";
import type { ModelInputService } from "./model-input.js";
import type { RuntimeMessageSyncService } from "./runtime-message-sync.js";
import type {
  ActionRunAcceptedResult,
  CreateSessionMessageParams,
  CreateSessionParams,
  MessageListResult,
  RunListResult,
  RunStepListResult,
  RuntimeMessageListResult,
  RuntimeServiceOptions,
  RuntimeWorkspaceCatalog,
  SessionListResult,
  TriggerActionRunParams,
  UpdateSessionParams,
  WorkspaceRecord
} from "../types.js";
import { createId, nowIso, parseCursor } from "../utils.js";
import { buildArchiveMetadata } from "./internal-helpers.js";
import type { RuntimeMessage } from "./runtime-messages.js";

export interface SessionRuntimeServiceDependencies {
  sessionRepository: RuntimeServiceOptions["sessionRepository"];
  messageRepository: RuntimeServiceOptions["messageRepository"];
  runRepository: RuntimeServiceOptions["runRepository"];
  runStepRepository: RuntimeServiceOptions["runStepRepository"];
  workspaceArchiveRepository?: RuntimeServiceOptions["workspaceArchiveRepository"] | undefined;
  modelInputs: ModelInputService;
  runtimeMessageSync: RuntimeMessageSyncService;
  runtimeMessageProjector: RuntimeMessageProjector;
  getWorkspaceRecord: (workspaceId: string) => Promise<WorkspaceRecord>;
  getRun: (runId: string) => Promise<Run>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "run.queued";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  enqueueRun: (sessionId: string, runId: string) => Promise<void>;
}

export class SessionRuntimeService {
  readonly #sessionRepository: RuntimeServiceOptions["sessionRepository"];
  readonly #messageRepository: RuntimeServiceOptions["messageRepository"];
  readonly #runRepository: RuntimeServiceOptions["runRepository"];
  readonly #runStepRepository: RuntimeServiceOptions["runStepRepository"];
  readonly #workspaceArchiveRepository: RuntimeServiceOptions["workspaceArchiveRepository"];
  readonly #modelInputs: ModelInputService;
  readonly #runtimeMessageSync: RuntimeMessageSyncService;
  readonly #runtimeMessageProjector: RuntimeMessageProjector;
  readonly #getWorkspaceRecord: SessionRuntimeServiceDependencies["getWorkspaceRecord"];
  readonly #getRun: SessionRuntimeServiceDependencies["getRun"];
  readonly #appendEvent: SessionRuntimeServiceDependencies["appendEvent"];
  readonly #enqueueRun: SessionRuntimeServiceDependencies["enqueueRun"];

  constructor(dependencies: SessionRuntimeServiceDependencies) {
    this.#sessionRepository = dependencies.sessionRepository;
    this.#messageRepository = dependencies.messageRepository;
    this.#runRepository = dependencies.runRepository;
    this.#runStepRepository = dependencies.runStepRepository;
    this.#workspaceArchiveRepository = dependencies.workspaceArchiveRepository;
    this.#modelInputs = dependencies.modelInputs;
    this.#runtimeMessageSync = dependencies.runtimeMessageSync;
    this.#runtimeMessageProjector = dependencies.runtimeMessageProjector;
    this.#getWorkspaceRecord = dependencies.getWorkspaceRecord;
    this.#getRun = dependencies.getRun;
    this.#appendEvent = dependencies.appendEvent;
    this.#enqueueRun = dependencies.enqueueRun;
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
    const runtimeMessages = await this.#runtimeMessageSync.loadSessionRuntimeMessages(sessionId);
    const startIndex = parseCursor(cursor);
    const items = runtimeMessages.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < runtimeMessages.length ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listSessionTranscriptMessages(sessionId: string, pageSize = 100, cursor?: string): Promise<MessageListResult> {
    await this.getSession(sessionId);
    const runtimeMessages = await this.#runtimeMessageSync.loadSessionRuntimeMessages(sessionId);
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
    await this.#getRun(runId);
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
