import type {
  Message,
  AgentTaskNotificationRecord,
  AgentTaskNotificationRepository,
  AgentTaskRecord,
  AgentTaskRepository,
  EngineMessage,
  EngineMessageRepository,
  Run,
  RunStep,
  Session,
  SessionEvent,
  SessionEventStore,
  WorkspaceRecord,
  WorkspaceRepository,
  SessionRepository,
  MessageRepository,
  RunRepository,
  RunStepRepository
} from "@oah/engine-core";
import { AppError, createId, nowIso, parseCursor, parseMessagePageCursor } from "@oah/engine-core";
import type { SessionPendingRunQueueEntry, SessionPendingRunQueueRepository } from "@oah/engine-core";

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  readonly #items = new Map<string, WorkspaceRecord>();

  constructor(private readonly onDelete?: (workspaceId: string) => Promise<void>) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.#items.set(input.id, input);
    return input;
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.#items.set(input.id, input);
    return input;
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    return this.#items.get(id) ?? null;
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const startIndex = parseCursor(cursor);
    return [...this.#items.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(startIndex, startIndex + pageSize);
  }

  async delete(id: string): Promise<void> {
    await this.onDelete?.(id);
    this.#items.delete(id);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  readonly #items = new Map<string, Session>();

  constructor(private readonly onDelete?: (sessionId: string) => Promise<void>) {}

  async create(input: Session): Promise<Session> {
    this.#items.set(input.id, input);
    return input;
  }

  async getById(id: string): Promise<Session | null> {
    return this.#items.get(id) ?? null;
  }

  async update(input: Session): Promise<Session> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "session_not_found", `Session ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    return [...this.#items.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(startIndex, startIndex + pageSize);
  }

  async listChildrenByParentSessionId(parentSessionId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    return [...this.#items.values()]
      .filter((session) => session.parentSessionId === parentSessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(startIndex, startIndex + pageSize);
  }

  async delete(id: string): Promise<void> {
    if (!this.#items.has(id)) {
      return;
    }

    await this.onDelete?.(id);
    this.#items.delete(id);
  }

  async deleteByWorkspaceId(workspaceId: string): Promise<string[]> {
    const deletedSessionIds: string[] = [];

    for (const session of this.#items.values()) {
      if (session.workspaceId === workspaceId) {
        deletedSessionIds.push(session.id);
      }
    }

    for (const sessionId of deletedSessionIds) {
      await this.delete(sessionId);
    }

    return deletedSessionIds;
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  readonly #items = new Map<string, Message>();
  readonly #sessionMessageIds = new Map<string, string[]>();

  #compareMessages(left: Pick<Message, "createdAt" | "id">, right: Pick<Message, "createdAt" | "id">): number {
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  }

  #listSortedSessionMessages(sessionId: string): Message[] {
    const ids = this.#sessionMessageIds.get(sessionId) ?? [];
    return ids
      .map((id) => this.#items.get(id))
      .filter((value): value is Message => value !== undefined)
      .sort((left, right) => this.#compareMessages(left, right));
  }

  async create(input: Message): Promise<Message> {
    this.#items.set(input.id, input);
    const existing = this.#sessionMessageIds.get(input.sessionId) ?? [];
    existing.push(input.id);
    this.#sessionMessageIds.set(input.sessionId, existing);
    return input;
  }

  async getById(id: string): Promise<Message | null> {
    return this.#items.get(id) ?? null;
  }

  async update(input: Message): Promise<Message> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "message_not_found", `Message ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    return this.#listSortedSessionMessages(sessionId);
  }

  async listPageBySessionId(input: {
    sessionId: string;
    pageSize: number;
    cursor?: string | undefined;
    direction?: "forward" | "backward" | undefined;
  }): Promise<{ items: Message[]; hasMore: boolean; totalCount: number }> {
    const direction = input.direction ?? "forward";
    const items = this.#listSortedSessionMessages(input.sessionId);
    const cursor = parseMessagePageCursor(input.cursor);

    let filtered = items;
    if (cursor) {
      filtered = items.filter((message) => {
        const comparison = this.#compareMessages(message, cursor);
        return direction === "backward" ? comparison < 0 : comparison > 0;
      });
    }

    if (direction === "backward") {
      const page = filtered.slice(Math.max(0, filtered.length - (input.pageSize + 1)));
      const hasMore = page.length > input.pageSize;
      const visibleItems = hasMore ? page.slice(1) : page;
      return { items: visibleItems, hasMore, totalCount: items.length };
    }

    const page = filtered.slice(0, input.pageSize + 1);
    const hasMore = page.length > input.pageSize;
    const visibleItems = hasMore ? page.slice(0, input.pageSize) : page;
    return { items: visibleItems, hasMore, totalCount: items.length };
  }

  deleteBySessionIds(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const messageIds = this.#sessionMessageIds.get(sessionId) ?? [];
      for (const messageId of messageIds) {
        this.#items.delete(messageId);
      }

      this.#sessionMessageIds.delete(sessionId);
    }
  }
}

export class InMemoryEngineMessageRepository implements EngineMessageRepository {
  readonly #itemsBySession = new Map<string, EngineMessage[]>();

  async replaceBySessionId(sessionId: string, messages: EngineMessage[]): Promise<void> {
    this.#itemsBySession.set(sessionId, [...messages]);
  }

  async listBySessionId(sessionId: string): Promise<EngineMessage[]> {
    return [...(this.#itemsBySession.get(sessionId) ?? [])];
  }

  deleteBySessionIds(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.#itemsBySession.delete(sessionId);
    }
  }
}

export class InMemoryRunRepository implements RunRepository {
  readonly #items = new Map<string, Run>();

  async create(input: Run): Promise<Run> {
    this.#items.set(input.id, input);
    return input;
  }

  async getById(id: string): Promise<Run | null> {
    return this.#items.get(id) ?? null;
  }

  async update(input: Run): Promise<Run> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "run_not_found", `Run ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listBySessionId(sessionId: string): Promise<Run[]> {
    return [...this.#items.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  async listPageBySessionId(sessionId: string, pageSize: number, cursor?: string): Promise<Run[]> {
    const startIndex = parseCursor(cursor);
    return (await this.listBySessionId(sessionId)).slice(startIndex, startIndex + pageSize);
  }

  async hasActiveRunForSession(sessionId: string, excludedRunIds: ReadonlySet<string> = new Set()): Promise<boolean> {
    return [...this.#items.values()].some(
      (run) =>
        run.sessionId === sessionId &&
        (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") &&
        !excludedRunIds.has(run.id) &&
        !run.cancelRequestedAt
    );
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    return [...this.#items.values()]
      .filter((run) => {
        if (run.status !== "running" && run.status !== "waiting_tool") {
          return false;
        }

        const candidateTimestamp = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
        return candidateTimestamp <= staleBefore;
      })
      .sort((left, right) => {
        const leftTimestamp = left.heartbeatAt ?? left.startedAt ?? left.createdAt;
        const rightTimestamp = right.heartbeatAt ?? right.startedAt ?? right.createdAt;
        return leftTimestamp.localeCompare(rightTimestamp);
      })
      .slice(0, Math.max(1, limit));
  }

  deleteBySessionIds(sessionIds: string[]): string[] {
    const sessionIdSet = new Set(sessionIds);
    const deletedRunIds: string[] = [];

    for (const [runId, run] of this.#items.entries()) {
      if (!run.sessionId || !sessionIdSet.has(run.sessionId)) {
        continue;
      }

      deletedRunIds.push(runId);
      this.#items.delete(runId);
    }

    return deletedRunIds;
  }

  deleteByWorkspaceId(workspaceId: string): string[] {
    const deletedRunIds: string[] = [];

    for (const [runId, run] of this.#items.entries()) {
      if (run.workspaceId !== workspaceId) {
        continue;
      }

      deletedRunIds.push(runId);
      this.#items.delete(runId);
    }

    return deletedRunIds;
  }
}

export class InMemoryRunStepRepository implements RunStepRepository {
  readonly #items = new Map<string, RunStep>();
  readonly #runStepIds = new Map<string, string[]>();

  async create(input: RunStep): Promise<RunStep> {
    this.#items.set(input.id, input);
    const existing = this.#runStepIds.get(input.runId) ?? [];
    existing.push(input.id);
    this.#runStepIds.set(input.runId, existing);
    return input;
  }

  async update(input: RunStep): Promise<RunStep> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "run_step_not_found", `Run step ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    const ids = this.#runStepIds.get(runId) ?? [];
    return ids
      .map((id) => this.#items.get(id))
      .filter((value): value is RunStep => value !== undefined);
  }

  async listPageByRunId(runId: string, pageSize: number, cursor?: string): Promise<RunStep[]> {
    const startIndex = parseCursor(cursor);
    return (await this.listByRunId(runId)).slice(startIndex, startIndex + pageSize);
  }

  deleteByRunIds(runIds: string[]): void {
    for (const runId of runIds) {
      const stepIds = this.#runStepIds.get(runId) ?? [];
      for (const stepId of stepIds) {
        this.#items.delete(stepId);
      }

      this.#runStepIds.delete(runId);
    }
  }
}

export class InMemoryAgentTaskRepository implements AgentTaskRepository {
  readonly #items = new Map<string, AgentTaskRecord>();

  async upsert(input: AgentTaskRecord): Promise<AgentTaskRecord> {
    this.#items.set(input.taskId, input);
    return input;
  }

  async getByTaskId(taskId: string): Promise<AgentTaskRecord | null> {
    return this.#items.get(taskId) ?? null;
  }

  async update(input: {
    taskId: string;
    status: AgentTaskRecord["status"];
    updatedAt: string;
    toolUseId?: string | undefined;
    outputRef?: string | undefined;
    outputFile?: string | undefined;
    finalText?: string | undefined;
    errorMessage?: string | undefined;
    usage?: Record<string, unknown> | undefined;
    taskState?: AgentTaskRecord["taskState"] | undefined;
    notifiedAt?: string | undefined;
  }): Promise<AgentTaskRecord> {
    const existing = this.#items.get(input.taskId);
    if (!existing) {
      throw new AppError(404, "agent_task_not_found", `Agent task ${input.taskId} was not found.`);
    }

    const next: AgentTaskRecord = {
      ...existing,
      status: input.status,
      updatedAt: input.updatedAt,
      ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
      ...(input.outputRef !== undefined ? { outputRef: input.outputRef } : {}),
      ...(input.outputFile !== undefined ? { outputFile: input.outputFile } : {}),
      ...(input.finalText !== undefined ? { finalText: input.finalText } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.taskState !== undefined ? { taskState: input.taskState } : {}),
      ...(input.notifiedAt !== undefined ? { notifiedAt: input.notifiedAt } : {})
    };
    this.#items.set(input.taskId, next);
    return next;
  }

  deleteByWorkspaceId(workspaceId: string): void {
    for (const [taskId, task] of this.#items.entries()) {
      if (task.workspaceId === workspaceId) {
        this.#items.delete(taskId);
      }
    }
  }

  deleteBySessionIds(sessionIds: string[]): void {
    const sessionIdSet = new Set(sessionIds);
    for (const [taskId, task] of this.#items.entries()) {
      if (sessionIdSet.has(task.parentSessionId) || sessionIdSet.has(task.childSessionId)) {
        this.#items.delete(taskId);
      }
    }
  }
}

export class InMemoryAgentTaskNotificationRepository implements AgentTaskNotificationRepository {
  readonly #items = new Map<string, AgentTaskNotificationRecord>();

  async create(input: AgentTaskNotificationRecord): Promise<AgentTaskNotificationRecord> {
    this.#items.set(input.id, input);
    return input;
  }

  async listPendingBySessionId(parentSessionId: string): Promise<AgentTaskNotificationRecord[]> {
    return [...this.#items.values()]
      .filter((item) => item.parentSessionId === parentSessionId && item.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async markConsumed(input: { ids: string[]; consumedAt: string }): Promise<void> {
    for (const id of input.ids) {
      const existing = this.#items.get(id);
      if (existing) {
        this.#items.set(id, {
          ...existing,
          status: "consumed",
          consumedAt: input.consumedAt
        });
      }
    }
  }

  deleteByWorkspaceId(workspaceId: string): void {
    for (const [id, item] of this.#items.entries()) {
      if (item.workspaceId === workspaceId) {
        this.#items.delete(id);
      }
    }
  }

  deleteBySessionIds(sessionIds: string[]): void {
    const sessionIdSet = new Set(sessionIds);
    for (const [id, item] of this.#items.entries()) {
      if (sessionIdSet.has(item.parentSessionId) || sessionIdSet.has(item.childSessionId)) {
        this.#items.delete(id);
      }
    }
  }
}

export class InMemorySessionPendingRunQueueRepository implements SessionPendingRunQueueRepository {
  readonly #itemsBySessionId = new Map<string, SessionPendingRunQueueEntry[]>();

  async enqueue(input: {
    sessionId: string;
    runId: string;
    createdAt: string;
  }): Promise<SessionPendingRunQueueEntry> {
    const existing = await this.getByRunId(input.runId);
    if (existing) {
      return existing;
    }

    const items = this.#itemsBySessionId.get(input.sessionId) ?? [];
    const position = items.at(-1)?.position ?? 0;
    const entry: SessionPendingRunQueueEntry = {
      sessionId: input.sessionId,
      runId: input.runId,
      position: position + 1,
      createdAt: input.createdAt
    };
    items.push(entry);
    this.#itemsBySessionId.set(input.sessionId, items);
    return entry;
  }

  async listBySessionId(sessionId: string): Promise<SessionPendingRunQueueEntry[]> {
    return [...(this.#itemsBySessionId.get(sessionId) ?? [])].sort((left, right) => left.position - right.position);
  }

  async getByRunId(runId: string): Promise<SessionPendingRunQueueEntry | null> {
    for (const items of this.#itemsBySessionId.values()) {
      const entry = items.find((candidate) => candidate.runId === runId);
      if (entry) {
        return entry;
      }
    }

    return null;
  }

  async promote(runId: string): Promise<void> {
    const entry = await this.getByRunId(runId);
    if (!entry) {
      return;
    }

    const items = this.#itemsBySessionId.get(entry.sessionId) ?? [];
    const minPosition = items.reduce((lowest, candidate) => Math.min(lowest, candidate.position), entry.position);
    const target = items.find((candidate) => candidate.runId === runId);
    if (target) {
      target.position = minPosition - 1;
    }
    items.sort((left, right) => left.position - right.position);
  }

  async dequeueNext(sessionId: string): Promise<SessionPendingRunQueueEntry | null> {
    const items = this.#itemsBySessionId.get(sessionId) ?? [];
    if (items.length === 0) {
      return null;
    }

    items.sort((left, right) => left.position - right.position);
    const [next] = items.splice(0, 1);
    if (items.length === 0) {
      this.#itemsBySessionId.delete(sessionId);
    }
    return next ?? null;
  }

  async remove(runId: string): Promise<void> {
    for (const [sessionId, items] of this.#itemsBySessionId.entries()) {
      const nextItems = items.filter((candidate) => candidate.runId !== runId);
      if (nextItems.length === items.length) {
        continue;
      }

      if (nextItems.length === 0) {
        this.#itemsBySessionId.delete(sessionId);
      } else {
        this.#itemsBySessionId.set(sessionId, nextItems);
      }
      return;
    }
  }

  deleteBySessionIds(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.#itemsBySessionId.delete(sessionId);
    }
  }
}

export class InMemorySessionEventStore implements SessionEventStore {
  readonly #eventsBySession = new Map<string, SessionEvent[]>();
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  readonly #nextCursorBySession = new Map<string, number>();

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const currentEvents = this.#eventsBySession.get(input.sessionId) ?? [];
    const nextCursor = this.#nextCursorBySession.get(input.sessionId) ?? 0;
    const event: SessionEvent = {
      ...input,
      id: createId("evt"),
      cursor: String(nextCursor),
      createdAt: nowIso()
    };

    currentEvents.push(event);
    this.#eventsBySession.set(input.sessionId, currentEvents);
    this.#nextCursorBySession.set(input.sessionId, nextCursor + 1);

    for (const listener of this.#listeners.get(input.sessionId) ?? []) {
      listener(event);
    }

    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string, limit?: number): Promise<SessionEvent[]> {
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : -1;
    const normalizedCursor = Number.isFinite(parsedCursor) && parsedCursor >= -1 ? parsedCursor : -1;
    const events = this.#eventsBySession.get(sessionId) ?? [];
    const readLimit = Number.isFinite(limit) && limit !== undefined ? Math.max(1, Math.floor(limit)) : undefined;

    const filtered = events.filter((event) => {
      const eventCursor = Number.parseInt(event.cursor, 10);
      return Number.isFinite(eventCursor) && eventCursor > normalizedCursor && (!runId || event.runId === runId);
    });
    return readLimit ? filtered.slice(0, readLimit) : filtered;
  }

  async deleteById(eventId: string): Promise<void> {
    for (const [sessionId, events] of this.#eventsBySession.entries()) {
      const nextEvents = events.filter((event) => event.id !== eventId);
      if (nextEvents.length !== events.length) {
        this.#eventsBySession.set(sessionId, nextEvents);
        return;
      }
    }
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);

    return () => {
      const current = this.#listeners.get(sessionId);
      if (!current) {
        return;
      }

      current.delete(listener);
      if (current.size === 0) {
        this.#listeners.delete(sessionId);
      }
    };
  }

  deleteBySessionIds(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.#eventsBySession.delete(sessionId);
      this.#listeners.delete(sessionId);
      this.#nextCursorBySession.delete(sessionId);
    }
  }
}

export interface MemoryRuntimePersistence {
  workspaceRepository: InMemoryWorkspaceRepository;
  sessionRepository: InMemorySessionRepository;
  messageRepository: InMemoryMessageRepository;
  engineMessageRepository: InMemoryEngineMessageRepository;
  runRepository: InMemoryRunRepository;
  runStepRepository: InMemoryRunStepRepository;
  agentTaskRepository: InMemoryAgentTaskRepository;
  agentTaskNotificationRepository: InMemoryAgentTaskNotificationRepository;
  sessionEventStore: InMemorySessionEventStore;
  sessionPendingRunQueueRepository: InMemorySessionPendingRunQueueRepository;
}

export function createMemoryRuntimePersistence(): MemoryRuntimePersistence {
  const messageRepository = new InMemoryMessageRepository();
  const engineMessageRepository = new InMemoryEngineMessageRepository();
  const runRepository = new InMemoryRunRepository();
  const runStepRepository = new InMemoryRunStepRepository();
  const agentTaskRepository = new InMemoryAgentTaskRepository();
  const agentTaskNotificationRepository = new InMemoryAgentTaskNotificationRepository();
  const sessionEventStore = new InMemorySessionEventStore();
  const sessionPendingRunQueueRepository = new InMemorySessionPendingRunQueueRepository();
  const deleteSessionArtifacts = async (sessionId: string) => {
    const deletedRunIds = runRepository.deleteBySessionIds([sessionId]);
    sessionEventStore.deleteBySessionIds([sessionId]);
    sessionPendingRunQueueRepository.deleteBySessionIds([sessionId]);
    messageRepository.deleteBySessionIds([sessionId]);
    engineMessageRepository.deleteBySessionIds([sessionId]);
    runStepRepository.deleteByRunIds(deletedRunIds);
    agentTaskRepository.deleteBySessionIds([sessionId]);
    agentTaskNotificationRepository.deleteBySessionIds([sessionId]);
  };
  const sessionRepository = new InMemorySessionRepository(deleteSessionArtifacts);
  const workspaceRepository = new InMemoryWorkspaceRepository(async (workspaceId) => {
    await sessionRepository.deleteByWorkspaceId(workspaceId);
    const deletedRunIds = runRepository.deleteByWorkspaceId(workspaceId);
    runStepRepository.deleteByRunIds(deletedRunIds);
    agentTaskRepository.deleteByWorkspaceId(workspaceId);
    agentTaskNotificationRepository.deleteByWorkspaceId(workspaceId);
  });

  return {
    workspaceRepository,
    sessionRepository,
    messageRepository,
    engineMessageRepository,
    runRepository,
    runStepRepository,
    agentTaskRepository,
    agentTaskNotificationRepository,
    sessionEventStore,
    sessionPendingRunQueueRepository
  };
}
