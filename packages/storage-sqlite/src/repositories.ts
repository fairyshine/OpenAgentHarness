import type {
  ArtifactRecord,
  ArtifactRepository,
  HistoryEventRecord,
  HistoryEventRepository,
  HookRunAuditRecord,
  HookRunAuditRepository,
  Message,
  MessageRepository,
  EngineMessage,
  EngineMessageRepository,
  Run,
  RunRepository,
  RunStep,
  RunStepRepository,
  SessionPendingRunQueueEntry,
  SessionPendingRunQueueRepository,
  Session,
  SessionEvent,
  SessionEventStore,
  SessionRepository,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/engine-core";
import { AppError, createId, isMessageRole, isEngineMessageKind, nowIso, parseCursor } from "@oah/engine-core";
import type { SQLitePersistenceCoordinator } from "./coordinator.js";
import type { CursorRow, HistoryEventRow, IdRow, JsonRow } from "./shared.js";
import {
  appendHistoryDeleteEvents,
  appendHistoryEvent,
  coerceRows,
  parseJson,
  runInTransaction,
  serializeJson
} from "./shared.js";

export class SQLiteSessionRepository implements SessionRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: Session): Promise<Session> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare("insert into sessions (id, workspace_id, created_at, updated_at, payload) values (?, ?, ?, ?, ?)")
        .run(input.id, input.workspaceId, input.createdAt, input.updatedAt, serializeJson(input));
      appendHistoryEvent(handle.db, {
        workspaceId: input.workspaceId,
        entityType: "session",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    await this.#coordinator.indexSession(input.id, input.workspaceId);
    return input;
  }

  async getById(id: string): Promise<Session | null> {
    try {
      const handle = await this.#coordinator.getSessionHandle(id);
      const row = handle.db.prepare("select payload from sessions where id = ? limit 1").get(id) as JsonRow | undefined;
      return row?.payload ? parseJson<Session>(row.payload) : null;
    } catch (error) {
      if (error instanceof AppError && error.code === "session_not_found") {
        return null;
      }
      throw error;
    }
  }

  async update(input: Session): Promise<Session> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    runInTransaction(handle.db, () => {
      const result = handle.db
        .prepare("update sessions set created_at = ?, updated_at = ?, payload = ? where id = ?")
        .run(input.createdAt, input.updatedAt, serializeJson(input), input.id);
      if (result.changes === 0) {
        throw new AppError(404, "session_not_found", `Session ${input.id} was not found.`);
      }
      appendHistoryEvent(handle.db, {
        workspaceId: input.workspaceId,
        entityType: "session",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    await this.#coordinator.indexSession(input.id, input.workspaceId);
    return input;
  }

  async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    const startIndex = parseCursor(cursor);
    const rows = coerceRows<JsonRow>(
      handle.db
        .prepare(
          `select payload from sessions
           where workspace_id = ?
           order by updated_at desc, created_at desc, id asc
           limit ? offset ?`
        )
        .all(workspaceId, pageSize, startIndex)
    );
    return rows.map((row) => parseJson<Session>(row.payload));
  }

  async delete(id: string): Promise<void> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForSession(id);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      const sessionRunRows = coerceRows<IdRow>(handle.db.prepare("select id from runs where session_id = ?").all(id));
      const runIds = sessionRunRows.map((row) => row.id);
      const sessionMessageRows = coerceRows<IdRow>(handle.db.prepare("select id from messages where session_id = ?").all(id));
      const runStepRows =
        runIds.length > 0
          ? coerceRows<IdRow>(handle.db.prepare(`select id from run_steps where run_id in (${runIds.map(() => "?").join(", ")})`).all(...runIds))
          : [];
      const toolCallRows =
        runIds.length > 0
          ? coerceRows<IdRow>(handle.db.prepare(`select id from tool_calls where run_id in (${runIds.map(() => "?").join(", ")})`).all(...runIds))
          : [];
      const hookRunRows =
        runIds.length > 0
          ? coerceRows<IdRow>(handle.db.prepare(`select id from hook_runs where run_id in (${runIds.map(() => "?").join(", ")})`).all(...runIds))
          : [];
      const artifactRows =
        runIds.length > 0
          ? coerceRows<IdRow>(handle.db.prepare(`select id from artifacts where run_id in (${runIds.map(() => "?").join(", ")})`).all(...runIds))
          : [];

      if (runIds.length > 0) {
        handle.db.prepare(`delete from run_steps where run_id in (${runIds.map(() => "?").join(", ")})`).run(...runIds);
        handle.db.prepare(`delete from tool_calls where run_id in (${runIds.map(() => "?").join(", ")})`).run(...runIds);
        handle.db.prepare(`delete from hook_runs where run_id in (${runIds.map(() => "?").join(", ")})`).run(...runIds);
        handle.db.prepare(`delete from artifacts where run_id in (${runIds.map(() => "?").join(", ")})`).run(...runIds);
        handle.db.prepare(`delete from runs where id in (${runIds.map(() => "?").join(", ")})`).run(...runIds);
      }

      handle.db.prepare("delete from runtime_messages where session_id = ?").run(id);
      handle.db.prepare("delete from session_events where session_id = ?").run(id);
      handle.db.prepare("delete from session_pending_runs where session_id = ?").run(id);
      handle.db.prepare("delete from messages where session_id = ?").run(id);
      handle.db.prepare("delete from sessions where id = ?").run(id);

      appendHistoryDeleteEvents(
        handle.db,
        workspaceId,
        [
          ...artifactRows.map((row) => ({ entityType: "artifact" as const, entityId: row.id })),
          ...hookRunRows.map((row) => ({ entityType: "hook_run" as const, entityId: row.id })),
          ...toolCallRows.map((row) => ({ entityType: "tool_call" as const, entityId: row.id })),
          ...runStepRows.map((row) => ({ entityType: "run_step" as const, entityId: row.id })),
          ...sessionRunRows.map((row) => ({ entityType: "run" as const, entityId: row.id })),
          ...sessionMessageRows.map((row) => ({ entityType: "message" as const, entityId: row.id })),
          { entityType: "session", entityId: id }
        ],
        nowIso()
      );
    });
    await this.#coordinator.reindexWorkspace(handle.db, workspaceId);
  }
}

export class SQLiteMessageRepository implements MessageRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: Message): Promise<Message> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForSession(input.sessionId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare("insert into messages (id, session_id, run_id, created_at, payload) values (?, ?, ?, ?, ?)")
        .run(input.id, input.sessionId, input.runId ?? null, input.createdAt, serializeJson(input));
      appendHistoryEvent(handle.db, {
        workspaceId,
        entityType: "message",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    await this.#coordinator.indexMessage(input.id, workspaceId);
    return input;
  }

  async getById(id: string): Promise<Message | null> {
    try {
      const workspaceId = await this.#coordinator.getWorkspaceIdForMessage(id);
      const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
      const row = handle.db.prepare("select payload from messages where id = ? limit 1").get(id) as JsonRow | undefined;
      if (row?.payload) {
        return parseJson<Message>(row.payload);
      }
      return null;
    } catch (error) {
      if (error instanceof AppError && error.code === "message_not_found") {
        return null;
      }
      throw error;
    }
  }

  async update(input: Message): Promise<Message> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForSession(input.sessionId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      const result = handle.db
        .prepare("update messages set session_id = ?, run_id = ?, created_at = ?, payload = ? where id = ?")
        .run(input.sessionId, input.runId ?? null, input.createdAt, serializeJson(input), input.id);
      if (result.changes === 0) {
        throw new AppError(404, "message_not_found", `Message ${input.id} was not found.`);
      }
      appendHistoryEvent(handle.db, {
        workspaceId,
        entityType: "message",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    await this.#coordinator.indexMessage(input.id, workspaceId);
    return input;
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    const handle = await this.#coordinator.getSessionHandle(sessionId);
    const rows = coerceRows<JsonRow>(
      handle.db.prepare("select payload from messages where session_id = ? order by created_at asc, id asc").all(sessionId)
    );
    return rows.map((row) => parseJson<Message>(row.payload));
  }

  async listKnownWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.#coordinator.listWorkspaceRecords();
  }

  workspaceRepository!: WorkspaceRepository;
}

export class SQLiteEngineMessageRepository implements EngineMessageRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async replaceBySessionId(sessionId: string, messages: EngineMessage[]): Promise<void> {
    const handle = await this.#coordinator.getSessionHandle(sessionId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("delete from runtime_messages where session_id = ?").run(sessionId);
      const insert = handle.db.prepare(
        "insert into runtime_messages (id, session_id, run_id, created_at, payload) values (?, ?, ?, ?, ?)"
      );
      for (const message of messages) {
        insert.run(message.id, message.sessionId, message.runId ?? null, message.createdAt, serializeJson(message));
      }
    });
  }

  async listBySessionId(sessionId: string): Promise<EngineMessage[]> {
    const handle = await this.#coordinator.getSessionHandle(sessionId);
    const rows = coerceRows<JsonRow>(
      handle.db.prepare("select payload from runtime_messages where session_id = ? order by created_at asc, id asc").all(sessionId)
    );

    return rows.map((row) => {
      const message = parseJson<EngineMessage>(row.payload);
      return {
        ...message,
        role: isMessageRole(message.role) ? message.role : "assistant",
        kind: isEngineMessageKind(message.kind) ? message.kind : "assistant_text"
      };
    });
  }
}

export class SQLiteSessionPendingRunQueueRepository implements SessionPendingRunQueueRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async enqueue(input: {
    sessionId: string;
    runId: string;
    createdAt: string;
  }): Promise<SessionPendingRunQueueEntry> {
    const handle = await this.#coordinator.getSessionHandle(input.sessionId);
    const maxRow = handle.db
      .prepare("select coalesce(max(position), 0) as position from session_pending_runs where session_id = ?")
      .get(input.sessionId) as { position: number } | undefined;
    const entry: SessionPendingRunQueueEntry = {
      sessionId: input.sessionId,
      runId: input.runId,
      position: (maxRow?.position ?? 0) + 1,
      createdAt: input.createdAt
    };
    handle.db
      .prepare(
        `insert into session_pending_runs (run_id, session_id, position, created_at)
         values (?, ?, ?, ?)
         on conflict(run_id) do nothing`
      )
      .run(entry.runId, entry.sessionId, entry.position, entry.createdAt);

    return (await this.getByRunId(input.runId)) ?? entry;
  }

  async listBySessionId(sessionId: string): Promise<SessionPendingRunQueueEntry[]> {
    const handle = await this.#coordinator.getSessionHandle(sessionId);
    const rows = coerceRows<{
      run_id: string;
      session_id: string;
      position: number;
      created_at: string;
    }>(
      handle.db
        .prepare(
          `select run_id, session_id, position, created_at
           from session_pending_runs
           where session_id = ?
           order by position asc, created_at asc, run_id asc`
        )
        .all(sessionId)
    );
    return rows.map((row) => ({
      sessionId: row.session_id,
      runId: row.run_id,
      position: row.position,
      createdAt: row.created_at
    }));
  }

  async getByRunId(runId: string): Promise<SessionPendingRunQueueEntry | null> {
    try {
      const handle = await this.#coordinator.getRunHandle(runId);
      const row = handle.db
        .prepare(
          `select run_id, session_id, position, created_at
           from session_pending_runs
           where run_id = ?
           limit 1`
        )
        .get(runId) as { run_id: string; session_id: string; position: number; created_at: string } | undefined;

      if (!row) {
        return null;
      }

      return {
        sessionId: row.session_id,
        runId: row.run_id,
        position: row.position,
        createdAt: row.created_at
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "run_not_found") {
        return null;
      }
      throw error;
    }
  }

  async promote(runId: string): Promise<void> {
    const entry = await this.getByRunId(runId);
    if (!entry) {
      return;
    }

    const handle = await this.#coordinator.getSessionHandle(entry.sessionId);
    const minRow = handle.db
      .prepare("select coalesce(min(position), 0) as position from session_pending_runs where session_id = ?")
      .get(entry.sessionId) as { position: number } | undefined;
    handle.db
      .prepare("update session_pending_runs set position = ? where run_id = ?")
      .run((minRow?.position ?? 0) - 1, runId);
  }

  async dequeueNext(sessionId: string): Promise<SessionPendingRunQueueEntry | null> {
    const handle = await this.#coordinator.getSessionHandle(sessionId);
    const row = handle.db
      .prepare(
        `select run_id, session_id, position, created_at
         from session_pending_runs
         where session_id = ?
         order by position asc, created_at asc, run_id asc
         limit 1`
      )
      .get(sessionId) as { run_id: string; session_id: string; position: number; created_at: string } | undefined;

    if (!row) {
      return null;
    }

    handle.db.prepare("delete from session_pending_runs where run_id = ?").run(row.run_id);
    return {
      sessionId: row.session_id,
      runId: row.run_id,
      position: row.position,
      createdAt: row.created_at
    };
  }

  async remove(runId: string): Promise<void> {
    try {
      const handle = await this.#coordinator.getRunHandle(runId);
      handle.db.prepare("delete from session_pending_runs where run_id = ?").run(runId);
    } catch (error) {
      if (error instanceof AppError && error.code === "run_not_found") {
        return;
      }
      throw error;
    }
  }
}

export class SQLiteRunRepository implements RunRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: Run): Promise<Run> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare(
          "insert into runs (id, workspace_id, session_id, status, heartbeat_at, started_at, created_at, payload) values (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(input.id, input.workspaceId, input.sessionId ?? null, input.status, input.heartbeatAt ?? null, input.startedAt ?? null, input.createdAt, serializeJson(input));
      appendHistoryEvent(handle.db, {
        workspaceId: input.workspaceId,
        entityType: "run",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    await this.#coordinator.indexRun(input);
    return input;
  }

  async getById(id: string): Promise<Run | null> {
    try {
      const handle = await this.#coordinator.getRunHandle(id);
      const row = handle.db.prepare("select payload from runs where id = ? limit 1").get(id) as JsonRow | undefined;
      return row?.payload ? parseJson<Run>(row.payload) : null;
    } catch (error) {
      if (error instanceof AppError && error.code === "run_not_found") {
        return null;
      }
      throw error;
    }
  }

  async update(input: Run): Promise<Run> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    runInTransaction(handle.db, () => {
      const result = handle.db
        .prepare(
          "update runs set session_id = ?, status = ?, heartbeat_at = ?, started_at = ?, created_at = ?, payload = ? where id = ?"
        )
        .run(input.sessionId ?? null, input.status, input.heartbeatAt ?? null, input.startedAt ?? null, input.createdAt, serializeJson(input), input.id);
      if (result.changes === 0) {
        throw new AppError(404, "run_not_found", `Run ${input.id} was not found.`);
      }
      appendHistoryEvent(handle.db, {
        workspaceId: input.workspaceId,
        entityType: "run",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    await this.#coordinator.indexRun(input);
    return input;
  }

  async listBySessionId(sessionId: string): Promise<Run[]> {
    const handle = await this.#coordinator.getSessionHandle(sessionId);
    const rows = coerceRows<JsonRow>(
      handle.db.prepare("select payload from runs where session_id = ? order by created_at desc, id desc").all(sessionId)
    );
    return rows.map((row) => parseJson<Run>(row.payload));
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    const runIds = this.#coordinator.listRecoverableRunIds(staleBefore, Math.max(1, limit * 2));
    const runs = await Promise.all(runIds.map((runId) => this.getById(runId)));
    return runs
      .filter((run): run is Run => run !== null && (run.status === "running" || run.status === "waiting_tool"))
      .sort((left, right) => {
        const leftTimestamp = left.heartbeatAt ?? left.startedAt ?? left.createdAt;
        const rightTimestamp = right.heartbeatAt ?? right.startedAt ?? right.createdAt;
        return leftTimestamp.localeCompare(rightTimestamp) || left.id.localeCompare(right.id);
      })
      .slice(0, Math.max(1, limit));
  }

  async listKnownWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.#coordinator.listWorkspaceRecords();
  }

  workspaceRepository!: WorkspaceRepository;
}

export class SQLiteRunStepRepository implements RunStepRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: RunStep): Promise<RunStep> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("insert into run_steps (id, run_id, seq, payload) values (?, ?, ?, ?)").run(input.id, input.runId, input.seq, serializeJson(input));
      appendHistoryEvent(handle.db, {
        workspaceId,
        entityType: "run_step",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    return input;
  }

  async update(input: RunStep): Promise<RunStep> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      const result = handle.db.prepare("update run_steps set run_id = ?, seq = ?, payload = ? where id = ?").run(input.runId, input.seq, serializeJson(input), input.id);
      if (result.changes === 0) {
        throw new AppError(404, "run_step_not_found", `Run step ${input.id} was not found.`);
      }
      appendHistoryEvent(handle.db, {
        workspaceId,
        entityType: "run_step",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    return input;
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    const handle = await this.#coordinator.getRunHandle(runId);
    const rows = coerceRows<JsonRow>(handle.db.prepare("select payload from run_steps where run_id = ? order by seq asc, id asc").all(runId));
    return rows.map((row) => parseJson<RunStep>(row.payload));
  }
}

export class SQLiteSessionEventStore implements SessionEventStore {
  readonly #coordinator: SQLitePersistenceCoordinator;
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const handle = await this.#coordinator.getSessionHandle(input.sessionId);
    const workspaceId = await this.#coordinator.getWorkspaceIdForSession(input.sessionId);
    let created: SessionEvent | undefined;
    runInTransaction(handle.db, () => {
      const row = handle.db
        .prepare("select coalesce(max(cursor), -1) as maxCursor from session_events where session_id = ?")
        .get(input.sessionId) as CursorRow | undefined;
      const nextCursor = (row?.maxCursor ?? -1) + 1;
      created = {
        ...input,
        id: createId("evt"),
        cursor: String(nextCursor),
        createdAt: nowIso()
      };
      handle.db
        .prepare("insert into session_events (id, session_id, run_id, cursor, created_at, payload) values (?, ?, ?, ?, ?, ?)")
        .run(created.id, created.sessionId, created.runId ?? null, nextCursor, created.createdAt, serializeJson(created));
    });

    const event = created!;
    await this.#coordinator.indexSessionEvent(event.id, workspaceId);
    for (const listener of this.#listeners.get(input.sessionId) ?? []) {
      listener(event);
    }
    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    const handle = await this.#coordinator.getSessionHandle(sessionId);
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : -1;
    const normalizedCursor = Number.isFinite(parsedCursor) && parsedCursor >= -1 ? parsedCursor : -1;
    const rows = runId
      ? coerceRows<JsonRow>(
          handle.db
            .prepare(
              `select payload from session_events
               where session_id = ? and cursor > ? and run_id = ?
               order by cursor asc`
            )
            .all(sessionId, normalizedCursor, runId)
        )
      : coerceRows<JsonRow>(
          handle.db
            .prepare(
              `select payload from session_events
               where session_id = ? and cursor > ?
               order by cursor asc`
            )
            .all(sessionId, normalizedCursor)
        );
    return rows.map((row) => parseJson<SessionEvent>(row.payload));
  }

  async deleteById(eventId: string): Promise<void> {
    try {
      const workspaceId = await this.#coordinator.getWorkspaceIdForSessionEvent(eventId);
      const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
      handle.db.prepare("delete from session_events where id = ?").run(eventId);
      await this.#coordinator.deleteRegistryEntry("session_event_registry", eventId);
    } catch (error) {
      if (error instanceof AppError && error.code === "session_event_not_found") {
        return;
      }
      throw error;
    }
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<(event: SessionEvent) => void>();
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

export class SQLiteToolCallAuditRepository implements ToolCallAuditRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("insert into tool_calls (id, run_id, started_at, payload) values (?, ?, ?, ?)").run(input.id, input.runId, input.startedAt, serializeJson(input));
      appendHistoryEvent(handle.db, {
        workspaceId,
        entityType: "tool_call",
        entityId: input.id,
        op: "upsert",
        payload: input as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    return input;
  }
}

export class SQLiteHookRunAuditRepository implements HookRunAuditRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("insert into hook_runs (id, run_id, started_at, payload) values (?, ?, ?, ?)").run(input.id, input.runId, input.startedAt, serializeJson(input));
      appendHistoryEvent(handle.db, {
        workspaceId,
        entityType: "hook_run",
        entityId: input.id,
        op: "upsert",
        payload: input as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    return input;
  }
}

export class SQLiteArtifactRepository implements ArtifactRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("insert into artifacts (id, run_id, created_at, payload) values (?, ?, ?, ?)").run(input.id, input.runId, input.createdAt, serializeJson(input));
      appendHistoryEvent(handle.db, {
        workspaceId,
        entityType: "artifact",
        entityId: input.id,
        op: "upsert",
        payload: input as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    return input;
  }

  async listByRunId(runId: string): Promise<ArtifactRecord[]> {
    const handle = await this.#coordinator.getRunHandle(runId);
    const rows = coerceRows<JsonRow>(handle.db.prepare("select payload from artifacts where run_id = ? order by created_at asc, id asc").all(runId));
    return rows.map((row) => parseJson<ArtifactRecord>(row.payload));
  }
}

export class SQLiteHistoryEventRepository implements HistoryEventRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    let created: HistoryEventRecord | undefined;
    runInTransaction(handle.db, () => {
      const result = handle.db
        .prepare("insert into history_events (workspace_id, entity_type, entity_id, op, payload, occurred_at) values (?, ?, ?, ?, ?, ?)")
        .run(input.workspaceId, input.entityType, input.entityId, input.op, serializeJson(input.payload), input.occurredAt);
      created = {
        id: Number(result.lastInsertRowid),
        ...input
      };
    });
    return created!;
  }

  async listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    const rows =
      afterId !== undefined
        ? coerceRows<HistoryEventRow>(
            handle.db
              .prepare(
                `select id, workspace_id, entity_type, entity_id, op, payload, occurred_at
                 from history_events
                 where workspace_id = ? and id > ?
                 order by id asc
                 limit ?`
              )
              .all(workspaceId, afterId, limit)
          )
        : coerceRows<HistoryEventRow>(
            handle.db
              .prepare(
                `select id, workspace_id, entity_type, entity_id, op, payload, occurred_at
                 from history_events
                 where workspace_id = ?
                 order by id asc
                 limit ?`
              )
              .all(workspaceId, limit)
          );

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      op: row.op,
      payload: parseJson<Record<string, unknown>>(row.payload),
      occurredAt: row.occurred_at
    }));
  }
}
