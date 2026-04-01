import type {
  Message,
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
} from "@oah/runtime-core";
import { AppError, createId, nowIso } from "@oah/runtime-core";

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  readonly #items = new Map<string, WorkspaceRecord>();

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
}

export class InMemorySessionRepository implements SessionRepository {
  readonly #items = new Map<string, Session>();

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
}

export class InMemoryMessageRepository implements MessageRepository {
  readonly #items = new Map<string, Message>();
  readonly #sessionMessageIds = new Map<string, string[]>();

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
    const ids = this.#sessionMessageIds.get(sessionId) ?? [];
    return ids
      .map((id) => this.#items.get(id))
      .filter((value): value is Message => value !== undefined);
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
}

export class InMemorySessionEventStore implements SessionEventStore {
  readonly #eventsBySession = new Map<string, SessionEvent[]>();
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const currentEvents = this.#eventsBySession.get(input.sessionId) ?? [];
    const event: SessionEvent = {
      ...input,
      id: createId("evt"),
      cursor: String(currentEvents.length),
      createdAt: nowIso()
    };

    currentEvents.push(event);
    this.#eventsBySession.set(input.sessionId, currentEvents);

    for (const listener of this.#listeners.get(input.sessionId) ?? []) {
      listener(event);
    }

    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const normalizedStart = Number.isFinite(start) && start >= 0 ? start + 1 : 0;
    const events = this.#eventsBySession.get(sessionId) ?? [];

    return events.filter((event, index) => index >= normalizedStart && (!runId || event.runId === runId));
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
}

export interface MemoryRuntimePersistence {
  workspaceRepository: InMemoryWorkspaceRepository;
  sessionRepository: InMemorySessionRepository;
  messageRepository: InMemoryMessageRepository;
  runRepository: InMemoryRunRepository;
  runStepRepository: InMemoryRunStepRepository;
  sessionEventStore: InMemorySessionEventStore;
}

export function createMemoryRuntimePersistence(): MemoryRuntimePersistence {
  return {
    workspaceRepository: new InMemoryWorkspaceRepository(),
    sessionRepository: new InMemorySessionRepository(),
    messageRepository: new InMemoryMessageRepository(),
    runRepository: new InMemoryRunRepository(),
    runStepRepository: new InMemoryRunStepRepository(),
    sessionEventStore: new InMemorySessionEventStore()
  };
}
