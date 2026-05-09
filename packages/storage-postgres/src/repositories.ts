import type {
  ArtifactRecord,
  ArtifactRepository,
  AgentTaskNotificationRecord,
  AgentTaskNotificationRepository,
  AgentTaskRecord,
  AgentTaskRepository,
  HistoryEventRecord,
  HistoryEventRepository,
  HookRunAuditRecord,
  HookRunAuditRepository,
  Message,
  MessageRepository,
  MessagePageCursor,
  EngineMessage,
  EngineMessageRepository,
  Run,
  RunRepository,
  RunStep,
  RunStepRepository,
  Session,
  SessionEvent,
  SessionEventStore,
  SessionPendingRunQueueEntry,
  SessionPendingRunQueueRepository,
  SessionRepository,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/engine-core";
import { AppError, createId, nowIso, parseCursor, parseMessagePageCursor } from "@oah/engine-core";
import { and, asc, desc, eq, gt, inArray, isNull, lt, not, or, sql } from "drizzle-orm";
import type { OahDatabase } from "./schema.js";
import {
  agentTaskNotifications,
  agentTasks,
  artifacts,
  historyEvents,
  hookRuns,
  messages,
  runSteps,
  runs,
  engineMessages,
  sessionEvents,
  sessionPendingRuns,
  sessions,
  toolCalls,
  workspaces
} from "./schema.js";
import {
  appendHistoryDeleteEvents,
  appendHistoryEventRecord,
  buildAgentTaskRow,
  buildAgentTaskNotificationRow,
  buildArtifactRow,
  buildHookRunRow,
  buildMessageRow,
  buildRunRow,
  buildEngineMessageRow,
  buildRunStepRow,
  buildSessionRow,
  buildToolCallRow,
  buildWorkspaceRow,
  expectRow,
  nonNull,
  resolveWorkspaceIdForRun,
  resolveWorkspaceIdForSession,
  toArtifactRecord,
  toAgentTaskRecord,
  toAgentTaskNotificationRecord,
  toHistoryEventRecord,
  toHookRunAuditRecord,
  toMessage,
  toRun,
  toEngineMessageRecord,
  toRunStep,
  toSession,
  toSessionEvent,
  toToolCallAuditRecord,
  toWorkspaceRecord
} from "./row-mappers.js";
import {
  DEFAULT_POSTGRES_BOUNDED_READ_LIMIT,
  DEFAULT_POSTGRES_EVENT_READ_LIMIT,
  MAX_POSTGRES_BOUNDED_READ_LIMIT,
  resolvePostgresBoundedReadLimit
} from "./repository-read-limits.js";
export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const [row] = await this.db.insert(workspaces).values(buildWorkspaceRow(input)).returning();
    return toWorkspaceRecord(expectRow(row, `workspace ${input.id}`));
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const values = buildWorkspaceRow(input);
    const [row] = await this.db
      .insert(workspaces)
      .values(values)
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          externalRef: values.externalRef,
          name: values.name,
          rootPath: values.rootPath,
          executionPolicy: values.executionPolicy,
          status: values.status,
          kind: values.kind,
          readOnly: values.readOnly,
          historyMirrorEnabled: values.historyMirrorEnabled,
          defaultAgent: values.defaultAgent,
          projectAgentsMd: values.projectAgentsMd,
          settings: values.settings,
          workspaceModels: values.workspaceModels,
          agents: values.agents,
          actions: values.actions,
          skills: values.skills,
          toolServers: values.toolServers,
          hooks: values.hooks,
          catalog: values.catalog,
          updatedAt: values.updatedAt
        }
      })
      .returning();

    return toWorkspaceRecord(expectRow(row, `workspace ${input.id}`));
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return row ? toWorkspaceRecord(row) : null;
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(workspaces)
      .orderBy(sql`${workspaces.updatedAt} desc`, sql`${workspaces.createdAt} desc`, sql`${workspaces.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toWorkspaceRecord);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
  }
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: Session): Promise<Session> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(sessions).values(buildSessionRow(input)).returning();
      const created = toSession(expectRow(row, `session ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: created.workspaceId,
        entityType: "session",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Session | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ? toSession(row) : null;
  }

  async update(input: Session): Promise<Session> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(sessions).set(buildSessionRow(input)).where(eq(sessions.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "session_not_found", `Session ${input.id} was not found.`);
      }

      const updated = toSession(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: updated.workspaceId,
        entityType: "session",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId))
      .orderBy(sql`${sessions.updatedAt} desc`, sql`${sessions.createdAt} desc`, sql`${sessions.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toSession);
  }

  async listChildrenByParentSessionId(parentSessionId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.parentSessionId, parentSessionId))
      .orderBy(sql`${sessions.updatedAt} desc`, sql`${sessions.createdAt} desc`, sql`${sessions.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toSession);
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      if (!sessionRow) {
        return;
      }

      const workspaceId = sessionRow.workspaceId;
      const sessionRunRows = await tx.select({ id: runs.id }).from(runs).where(eq(runs.sessionId, id));
      const runIds = sessionRunRows.map((row) => row.id);
      const [sessionMessageRows, runStepRows, toolCallRows, hookRunRows, artifactRows] = await Promise.all([
        tx.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, id)),
        runIds.length > 0 ? tx.select({ id: runSteps.id }).from(runSteps).where(inArray(runSteps.runId, runIds)) : Promise.resolve([]),
        runIds.length > 0 ? tx.select({ id: toolCalls.id }).from(toolCalls).where(inArray(toolCalls.runId, runIds)) : Promise.resolve([]),
        runIds.length > 0 ? tx.select({ id: hookRuns.id }).from(hookRuns).where(inArray(hookRuns.runId, runIds)) : Promise.resolve([]),
        runIds.length > 0 ? tx.select({ id: artifacts.id }).from(artifacts).where(inArray(artifacts.runId, runIds)) : Promise.resolve([])
      ]);

      await tx.delete(messages).where(eq(messages.sessionId, id));
      await tx.delete(sessions).where(eq(sessions.id, id));

      const occurredAt = nowIso();
      await appendHistoryDeleteEvents(
        tx,
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
        occurredAt
      );
    });
  }
}

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly db: OahDatabase) {}

  #buildMessageCursorPredicate(
    cursor: MessagePageCursor,
    direction: "forward" | "backward"
  ): ReturnType<typeof or> {
    if (direction === "backward") {
      return or(
        lt(messages.createdAt, cursor.createdAt),
        and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
      );
    }

    return or(
      gt(messages.createdAt, cursor.createdAt),
      and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id))
    );
  }

  async create(input: Message): Promise<Message> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(messages).values(buildMessageRow(input)).returning();
      const created = toMessage(expectRow(row, `message ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForSession(tx, created.sessionId),
        entityType: "message",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Message | null> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return row ? toMessage(row) : null;
  }

  async update(input: Message): Promise<Message> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(messages).set(buildMessageRow(input)).where(eq(messages.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "message_not_found", `Message ${input.id} was not found.`);
      }

      const updated = toMessage(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForSession(tx, updated.sessionId),
        entityType: "message",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    const limit = resolvePostgresBoundedReadLimit(
      "OAH_POSTGRES_SESSION_MESSAGE_READ_LIMIT",
      DEFAULT_POSTGRES_BOUNDED_READ_LIMIT
    );
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);

    return rows.map(toMessage).reverse();
  }

  async listPageBySessionId(input: {
    sessionId: string;
    pageSize: number;
    cursor?: string | undefined;
    direction?: "forward" | "backward" | undefined;
  }): Promise<{ items: Message[]; hasMore: boolean }> {
    const direction = input.direction ?? "forward";
    const cursor = parseMessagePageCursor(input.cursor);
    const whereClause = cursor
      ? and(eq(messages.sessionId, input.sessionId), this.#buildMessageCursorPredicate(cursor, direction))
      : eq(messages.sessionId, input.sessionId);
    const rows = await this.db
      .select()
      .from(messages)
      .where(whereClause)
      .orderBy(
        direction === "backward" ? desc(messages.createdAt) : asc(messages.createdAt),
        direction === "backward" ? desc(messages.id) : asc(messages.id)
      )
      .limit(input.pageSize + 1);

    const hasMore = rows.length > input.pageSize;
    const pageRows = hasMore ? rows.slice(0, input.pageSize) : rows;
    const orderedRows = direction === "backward" ? [...pageRows].reverse() : pageRows;

    return {
      items: orderedRows.map(toMessage),
      hasMore
    };
  }
}

export class PostgresEngineMessageRepository implements EngineMessageRepository {
  constructor(private readonly db: OahDatabase) {}

  async replaceBySessionId(sessionId: string, messagesForSession: EngineMessage[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(engineMessages).where(eq(engineMessages.sessionId, sessionId));
      if (messagesForSession.length === 0) {
        return;
      }

      await tx.insert(engineMessages).values(messagesForSession.map((message) => buildEngineMessageRow(message)));
    });
  }

  async listBySessionId(sessionId: string): Promise<EngineMessage[]> {
    const limit = resolvePostgresBoundedReadLimit(
      "OAH_POSTGRES_SESSION_ENGINE_MESSAGE_READ_LIMIT",
      DEFAULT_POSTGRES_BOUNDED_READ_LIMIT
    );
    const rows = await this.db
      .select()
      .from(engineMessages)
      .where(eq(engineMessages.sessionId, sessionId))
      .orderBy(desc(engineMessages.createdAt), desc(engineMessages.id))
      .limit(limit);

    return rows.map(toEngineMessageRecord).reverse();
  }
}

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: Run): Promise<Run> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(runs).values(buildRunRow(input)).returning();
      const created = toRun(expectRow(row, `run ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: created.workspaceId,
        entityType: "run",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Run | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async update(input: Run): Promise<Run> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(runs).set(buildRunRow(input)).where(eq(runs.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "run_not_found", `Run ${input.id} was not found.`);
      }

      const updated = toRun(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: updated.workspaceId,
        entityType: "run",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listBySessionId(sessionId: string): Promise<Run[]> {
    const limit = resolvePostgresBoundedReadLimit("OAH_POSTGRES_SESSION_RUN_READ_LIMIT", DEFAULT_POSTGRES_BOUNDED_READ_LIMIT);
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit);
    return rows.map(toRun);
  }

  async hasActiveRunForSession(sessionId: string, excludedRunIds: ReadonlySet<string> = new Set()): Promise<boolean> {
    const predicates = [
      eq(runs.sessionId, sessionId),
      inArray(runs.status, ["queued", "running", "waiting_tool"]),
      isNull(runs.cancelRequestedAt)
    ];
    const excluded = Array.from(excludedRunIds);
    if (excluded.length > 0) {
      predicates.push(not(inArray(runs.id, excluded)));
    }

    const [row] = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(...predicates))
      .limit(1);
    return Boolean(row);
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["running", "waiting_tool"]),
          sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt}) <= ${staleBefore}`
        )
      )
      .orderBy(asc(sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt})`), asc(runs.id))
      .limit(Math.max(1, limit));

    return rows.map(toRun);
  }
}

export class PostgresRunStepRepository implements RunStepRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: RunStep): Promise<RunStep> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(runSteps).values(buildRunStepRow(input)).returning();
      const created = toRunStep(expectRow(row, `run step ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "run_step",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async update(input: RunStep): Promise<RunStep> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(runSteps).set(buildRunStepRow(input)).where(eq(runSteps.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "run_step_not_found", `Run step ${input.id} was not found.`);
      }

      const updated = toRunStep(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, updated.runId),
        entityType: "run_step",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    const rows = await this.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
    return rows.map(toRunStep);
  }
}

export class PostgresSessionPendingRunQueueRepository implements SessionPendingRunQueueRepository {
  constructor(private readonly db: OahDatabase) {}

  async enqueue(input: {
    sessionId: string;
    runId: string;
    createdAt: string;
  }): Promise<SessionPendingRunQueueEntry> {
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select({
          maxPosition: sql<number>`coalesce(max(${sessionPendingRuns.position}), 0)`
        })
        .from(sessionPendingRuns)
        .where(eq(sessionPendingRuns.sessionId, input.sessionId));
      const position = nonNull(current[0]?.maxPosition, 0) + 1;

      await tx
        .insert(sessionPendingRuns)
        .values({
          runId: input.runId,
          sessionId: input.sessionId,
          position,
          createdAt: input.createdAt
        })
        .onConflictDoNothing();

      return (
        (await this.getByRunId(input.runId)) ?? {
          sessionId: input.sessionId,
          runId: input.runId,
          position,
          createdAt: input.createdAt
        }
      );
    });
  }

  async listBySessionId(sessionId: string): Promise<SessionPendingRunQueueEntry[]> {
    const limit = resolvePostgresBoundedReadLimit("OAH_POSTGRES_PENDING_RUN_READ_LIMIT", DEFAULT_POSTGRES_BOUNDED_READ_LIMIT);
    const rows = await this.db
      .select()
      .from(sessionPendingRuns)
      .where(eq(sessionPendingRuns.sessionId, sessionId))
      .orderBy(asc(sessionPendingRuns.position), asc(sessionPendingRuns.createdAt), asc(sessionPendingRuns.runId))
      .limit(limit);

    return rows.map((row) => ({
      sessionId: row.sessionId,
      runId: row.runId,
      position: row.position,
      createdAt: row.createdAt
    }));
  }

  async getByRunId(runId: string): Promise<SessionPendingRunQueueEntry | null> {
    const [row] = await this.db.select().from(sessionPendingRuns).where(eq(sessionPendingRuns.runId, runId)).limit(1);
    if (!row) {
      return null;
    }

    return {
      sessionId: row.sessionId,
      runId: row.runId,
      position: row.position,
      createdAt: row.createdAt
    };
  }

  async promote(runId: string): Promise<void> {
    const entry = await this.getByRunId(runId);
    if (!entry) {
      return;
    }

    const current = await this.db
      .select({
        minPosition: sql<number>`coalesce(min(${sessionPendingRuns.position}), 0)`
      })
      .from(sessionPendingRuns)
      .where(eq(sessionPendingRuns.sessionId, entry.sessionId));
    await this.db
      .update(sessionPendingRuns)
      .set({
        position: nonNull(current[0]?.minPosition, 0) - 1
      })
      .where(eq(sessionPendingRuns.runId, runId));
  }

  async dequeueNext(sessionId: string): Promise<SessionPendingRunQueueEntry | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sessionPendingRuns)
        .where(eq(sessionPendingRuns.sessionId, sessionId))
        .orderBy(asc(sessionPendingRuns.position), asc(sessionPendingRuns.createdAt), asc(sessionPendingRuns.runId))
        .limit(1);
      if (!row) {
        return null;
      }

      await tx.delete(sessionPendingRuns).where(eq(sessionPendingRuns.runId, row.runId));
      return {
        sessionId: row.sessionId,
        runId: row.runId,
        position: row.position,
        createdAt: row.createdAt
      };
    });
  }

  async remove(runId: string): Promise<void> {
    await this.db.delete(sessionPendingRuns).where(eq(sessionPendingRuns.runId, runId));
  }
}

export class PostgresSessionEventStore implements SessionEventStore {
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();

  constructor(private readonly db: OahDatabase) {}

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.db.transaction(async (tx) => {
      await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, input.sessionId)).for("update").execute();
      const current = await tx
        .select({
          maxCursor: sql<number>`coalesce(max(${sessionEvents.cursor}), -1)`
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, input.sessionId));
      const nextCursor = nonNull(current[0]?.maxCursor, -1) + 1;
      const [row] = await tx
        .insert(sessionEvents)
        .values({
          id: createId("evt"),
          cursor: nextCursor,
          sessionId: input.sessionId,
          runId: input.runId ?? null,
          event: input.event,
          data: input.data,
          createdAt: nowIso()
        })
        .returning();

      return toSessionEvent(expectRow(row, `session event ${nextCursor}`));
    });

    for (const listener of this.#listeners.get(input.sessionId) ?? []) {
      listener(event);
    }

    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string, limit?: number): Promise<SessionEvent[]> {
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : -1;
    const normalizedCursor = Number.isFinite(parsedCursor) && parsedCursor >= -1 ? parsedCursor : -1;
    const readLimit = Math.max(
      1,
      Math.min(
        limit ?? resolvePostgresBoundedReadLimit("OAH_POSTGRES_SESSION_EVENT_READ_LIMIT", DEFAULT_POSTGRES_EVENT_READ_LIMIT),
        MAX_POSTGRES_BOUNDED_READ_LIMIT
      )
    );
    const filters = [eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.cursor, normalizedCursor)];
    if (runId) {
      filters.push(eq(sessionEvents.runId, runId));
    }

    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(...filters))
      .orderBy(asc(sessionEvents.cursor))
      .limit(readLimit);
    return rows.map(toSessionEvent);
  }

  async deleteById(eventId: string): Promise<void> {
    await this.db.delete(sessionEvents).where(eq(sessionEvents.id, eventId));
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

export class PostgresToolCallAuditRepository implements ToolCallAuditRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(toolCalls).values(buildToolCallRow(input)).returning();
      const created = toToolCallAuditRecord(expectRow(row, `tool call ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "tool_call",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }
}

export class PostgresHookRunAuditRepository implements HookRunAuditRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(hookRuns).values(buildHookRunRow(input)).returning();
      const created = toHookRunAuditRecord(expectRow(row, `hook run ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "hook_run",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }
}

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(artifacts).values(buildArtifactRow(input)).returning();
      const created = toArtifactRecord(expectRow(row, `artifact ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "artifact",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async listByRunId(runId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db.select().from(artifacts).where(eq(artifacts.runId, runId)).orderBy(asc(artifacts.createdAt));
    return rows.map(toArtifactRecord);
  }
}

export class PostgresAgentTaskRepository implements AgentTaskRepository {
  constructor(private readonly db: OahDatabase) {}

  async upsert(input: AgentTaskRecord): Promise<AgentTaskRecord> {
    const values = buildAgentTaskRow(input);
    const [row] = await this.db
      .insert(agentTasks)
      .values(values)
      .onConflictDoUpdate({
        target: agentTasks.taskId,
        set: {
          workspaceId: values.workspaceId,
          parentSessionId: values.parentSessionId,
          parentRunId: values.parentRunId,
          childSessionId: values.childSessionId,
          childRunId: values.childRunId,
          toolUseId: values.toolUseId,
          targetAgentName: values.targetAgentName,
          parentAgentName: values.parentAgentName,
          status: values.status,
          description: values.description,
          handoffSummary: values.handoffSummary,
          outputRef: values.outputRef,
          outputFile: values.outputFile,
          finalText: values.finalText,
          errorMessage: values.errorMessage,
          usage: values.usage,
          taskState: values.taskState,
          notifiedAt: values.notifiedAt,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt
        }
      })
      .returning();
    return toAgentTaskRecord(expectRow(row, `agent task ${input.taskId}`));
  }

  async getByTaskId(taskId: string): Promise<AgentTaskRecord | null> {
    const [row] = await this.db.select().from(agentTasks).where(eq(agentTasks.taskId, taskId)).limit(1);
    return row ? toAgentTaskRecord(row) : null;
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
    const [row] = await this.db
      .update(agentTasks)
      .set({
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
      })
      .where(eq(agentTasks.taskId, input.taskId))
      .returning();
    if (!row) {
      throw new AppError(404, "agent_task_not_found", `Agent task ${input.taskId} was not found.`);
    }

    return toAgentTaskRecord(row);
  }
}

export class PostgresAgentTaskNotificationRepository implements AgentTaskNotificationRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: AgentTaskNotificationRecord): Promise<AgentTaskNotificationRecord> {
    const values = buildAgentTaskNotificationRow(input);
    const [row] = await this.db
      .insert(agentTaskNotifications)
      .values(values)
      .onConflictDoUpdate({
        target: agentTaskNotifications.id,
        set: {
          workspaceId: values.workspaceId,
          parentSessionId: values.parentSessionId,
          parentRunId: values.parentRunId,
          taskId: values.taskId,
          toolUseId: values.toolUseId,
          childRunId: values.childRunId,
          childSessionId: values.childSessionId,
          updateType: values.updateType,
          content: values.content,
          metadata: values.metadata,
          status: values.status,
          createdAt: values.createdAt,
          consumedAt: values.consumedAt
        }
      })
      .returning();
    return toAgentTaskNotificationRecord(expectRow(row, `agent task notification ${input.id}`));
  }

  async listPendingBySessionId(parentSessionId: string): Promise<AgentTaskNotificationRecord[]> {
    const rows = await this.db
      .select()
      .from(agentTaskNotifications)
      .where(and(eq(agentTaskNotifications.parentSessionId, parentSessionId), eq(agentTaskNotifications.status, "pending")))
      .orderBy(asc(agentTaskNotifications.createdAt), asc(agentTaskNotifications.id));
    return rows.map(toAgentTaskNotificationRecord);
  }

  async markConsumed(input: { ids: string[]; consumedAt: string }): Promise<void> {
    if (input.ids.length === 0) {
      return;
    }

    await this.db
      .update(agentTaskNotifications)
      .set({
        status: "consumed",
        consumedAt: input.consumedAt
      })
      .where(inArray(agentTaskNotifications.id, input.ids));
  }
}

export class PostgresHistoryEventRepository implements HistoryEventRepository {
  constructor(private readonly db: OahDatabase) {}

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    return appendHistoryEventRecord(this.db, input);
  }

  async listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const filters = [eq(historyEvents.workspaceId, workspaceId)];
    if (afterId !== undefined) {
      filters.push(gt(historyEvents.id, afterId));
    }

    const rows = await this.db
      .select()
      .from(historyEvents)
      .where(and(...filters))
      .orderBy(asc(historyEvents.id))
      .limit(limit);

    return rows.map(toHistoryEventRecord);
  }

  async pruneByWorkspace(workspaceId: string, maxEventId: number, occurredBefore: string): Promise<number> {
    if (maxEventId <= 0) {
      return 0;
    }

    const rows = await this.db
      .delete(historyEvents)
      .where(
        and(
          eq(historyEvents.workspaceId, workspaceId),
          sql`${historyEvents.id} <= ${maxEventId}`,
          sql`${historyEvents.occurredAt} < ${occurredBefore}`
        )
      )
      .returning({ id: historyEvents.id });

    return rows.length;
  }
}

export { PostgresWorkspaceArchiveRepository } from "./workspace-archive-repository.js";
