import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import { summarizeContentForDisplay } from "../execution-message-content.js";
import type {
  EngineServiceOptions,
  MessageContextResult,
  MessageListResult,
  MessagePageDirection,
  UpdateSessionParams,
  RunListResult,
  RunStepListResult,
  SessionListResult,
  SessionQueuedRunListResult,
  WorkspaceArchiveRepository,
  WorkspaceRecord
} from "../types.js";
import { encodeMessagePageCursor, parseCursor } from "../utils.js";
import { buildArchiveMetadata } from "./internal-helpers.js";

export interface SessionRecordServiceDependencies {
  sessionRepository: EngineServiceOptions["sessionRepository"];
  messageRepository: EngineServiceOptions["messageRepository"];
  runRepository: EngineServiceOptions["runRepository"];
  runStepRepository: EngineServiceOptions["runStepRepository"];
  sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  workspaceArchiveRepository?: WorkspaceArchiveRepository | undefined;
  getWorkspaceRecord: (workspaceId: string) => Promise<WorkspaceRecord>;
  normalizeModelRef: (workspace: WorkspaceRecord, modelRef?: string) => string | undefined;
}

export class SessionRecordService {
  readonly #sessionRepository: EngineServiceOptions["sessionRepository"];
  readonly #messageRepository: EngineServiceOptions["messageRepository"];
  readonly #runRepository: EngineServiceOptions["runRepository"];
  readonly #runStepRepository: EngineServiceOptions["runStepRepository"];
  readonly #sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  readonly #workspaceArchiveRepository: WorkspaceArchiveRepository | undefined;
  readonly #getWorkspaceRecord: SessionRecordServiceDependencies["getWorkspaceRecord"];
  readonly #normalizeModelRef: SessionRecordServiceDependencies["normalizeModelRef"];

  constructor(dependencies: SessionRecordServiceDependencies) {
    this.#sessionRepository = dependencies.sessionRepository;
    this.#messageRepository = dependencies.messageRepository;
    this.#runRepository = dependencies.runRepository;
    this.#runStepRepository = dependencies.runStepRepository;
    this.#sessionPendingRunQueueRepository = dependencies.sessionPendingRunQueueRepository;
    this.#workspaceArchiveRepository = dependencies.workspaceArchiveRepository;
    this.#getWorkspaceRecord = dependencies.getWorkspaceRecord;
    this.#normalizeModelRef = dependencies.normalizeModelRef;
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
      const normalizedModelRef = input.modelRef === null ? undefined : this.#normalizeModelRef(workspace, input.modelRef);
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
      updatedAt: new Date().toISOString()
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

  async listChildSessions(parentSessionId: string, pageSize: number, cursor?: string): Promise<SessionListResult> {
    await this.getSession(parentSessionId);
    const startIndex = parseCursor(cursor);
    const items = await this.#sessionRepository.listChildrenByParentSessionId(parentSessionId, pageSize, cursor);
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
    const page = await this.#messageRepository.listPageBySessionId({
      sessionId,
      pageSize,
      cursor,
      direction
    });
    const boundaryMessage = direction === "backward" ? page.items[0] : page.items.at(-1);
    const nextCursor =
      page.hasMore && boundaryMessage
        ? encodeMessagePageCursor({
            createdAt: boundaryMessage.createdAt,
            id: boundaryMessage.id
          })
        : undefined;

    return nextCursor === undefined ? { items: page.items } : { items: page.items, nextCursor };
  }

  async getSessionMessage(sessionId: string, messageId: string): Promise<Message> {
    await this.getSession(sessionId);
    const message = await this.#messageRepository.getById(messageId);
    if (!message || message.sessionId !== sessionId) {
      throw new AppError(404, "message_not_found", `Message ${messageId} was not found in session ${sessionId}.`);
    }

    return message;
  }

  async getSessionMessageContext(
    sessionId: string,
    messageId: string,
    before = 20,
    after = 20
  ): Promise<MessageContextResult> {
    const anchor = await this.getSessionMessage(sessionId, messageId);
    const anchorCursor = encodeMessagePageCursor({
      createdAt: anchor.createdAt,
      id: anchor.id
    });
    const [beforePage, afterPage] = await Promise.all([
      before > 0
        ? this.#messageRepository.listPageBySessionId({
            sessionId,
            pageSize: before,
            cursor: anchorCursor,
            direction: "backward"
          })
        : Promise.resolve({ items: [], hasMore: false }),
      after > 0
        ? this.#messageRepository.listPageBySessionId({
            sessionId,
            pageSize: after,
            cursor: anchorCursor,
            direction: "forward"
          })
        : Promise.resolve({ items: [], hasMore: false })
    ]);

    return {
      anchor,
      before: beforePage.items,
      after: afterPage.items,
      hasMoreBefore: beforePage.hasMore,
      hasMoreAfter: afterPage.hasMore
    };
  }

  async listSessionRuns(sessionId: string, pageSize = 100, cursor?: string): Promise<RunListResult> {
    await this.getSession(sessionId);
    const startIndex = parseCursor(cursor);
    const runs = this.#runRepository.listPageBySessionId
      ? await this.#runRepository.listPageBySessionId(sessionId, pageSize + 1, cursor)
      : (await this.#runRepository.listBySessionId(sessionId)).slice(startIndex, startIndex + pageSize + 1);
    const hasMore = runs.length > pageSize;
    const items = hasMore ? runs.slice(0, pageSize) : runs;
    const nextCursor = hasMore ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async listRunSteps(runId: string, pageSize = 100, cursor?: string): Promise<RunStepListResult> {
    await this.getRun(runId);
    const startIndex = parseCursor(cursor);
    const steps = this.#runStepRepository.listPageByRunId
      ? await this.#runStepRepository.listPageByRunId(runId, pageSize + 1, cursor)
      : (await this.#runStepRepository.listByRunId(runId)).slice(startIndex, startIndex + pageSize + 1);
    const hasMore = steps.length > pageSize;
    const items = hasMore ? steps.slice(0, pageSize) : steps;
    const nextCursor = hasMore ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async getRun(runId: string): Promise<Run> {
    const run = await this.#runRepository.getById(runId);
    if (!run) {
      throw new AppError(404, "run_not_found", `Run ${runId} was not found.`);
    }

    return run;
  }

  async listSessionQueuedRuns(sessionId: string): Promise<SessionQueuedRunListResult> {
    await this.getSession(sessionId);
    return {
      items: await this.collectSessionQueuedRuns(sessionId, { healStaleEntries: true })
    };
  }

  async collectSessionQueuedRuns(
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
            await this.removeQueuedRunBestEffort(sessionId, entry.runId);
          }
          continue;
        }

        const message = await this.#messageRepository.getById(messageId).catch(() => null);
        if (!message) {
          continue;
        }

        if (message.sessionId !== sessionId) {
          if (options.healStaleEntries) {
            await this.removeQueuedRunBestEffort(sessionId, entry.runId);
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
          await this.removeQueuedRunBestEffort(sessionId, entry.runId);
        }
      }
    }

    return items;
  }

  async removeQueuedRunBestEffort(sessionId: string, runId: string): Promise<void> {
    await this.#sessionPendingRunQueueRepository.remove(runId).catch(() => undefined);
  }

  async #sessionHasStarted(sessionId: string): Promise<boolean> {
    const [messages, runs] = await Promise.all([
      this.#messageRepository.listBySessionId(sessionId),
      this.#runRepository.listBySessionId(sessionId)
    ]);

    return messages.length > 0 || runs.length > 0;
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
