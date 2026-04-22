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
  Session,
  SessionEvent,
  SessionEventStore,
  SessionPendingRunQueueEntry,
  SessionPendingRunQueueRepository,
  SessionRepository,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceArchiveRecord,
  WorkspaceArchiveRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/engine-core";
import { AppError, createId, nowIso, parseCursor } from "@oah/engine-core";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { OahDatabase, OahTransaction } from "./schema.js";
import {
  archives,
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
  buildArtifactRow,
  buildHookRunRow,
  buildMessageRow,
  buildRunRow,
  buildEngineMessageRow,
  buildRunStepRow,
  buildSessionRow,
  buildToolCallRow,
  buildWorkspaceArchiveRow,
  buildWorkspaceRow,
  expectRow,
  nonNull,
  resolveWorkspaceIdForRun,
  resolveWorkspaceIdForSession,
  toArtifactRecord,
  toHistoryEventRecord,
  toHookRunAuditRecord,
  toMessage,
  toRun,
  toEngineMessageRecord,
  toRunStep,
  toSession,
  toSessionEvent,
  toToolCallAuditRecord,
  toWorkspaceArchiveRecord,
  toWorkspaceRecord
} from "./row-mappers.js";

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
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    return rows.map(toMessage);
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
    const rows = await this.db
      .select()
      .from(engineMessages)
      .where(eq(engineMessages.sessionId, sessionId))
      .orderBy(asc(engineMessages.createdAt), asc(engineMessages.id));

    return rows.map(toEngineMessageRecord);
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
    const rows = await this.db.select().from(runs).where(eq(runs.sessionId, sessionId)).orderBy(desc(runs.createdAt), desc(runs.id));
    return rows.map(toRun);
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
    const rows = await this.db
      .select()
      .from(sessionPendingRuns)
      .where(eq(sessionPendingRuns.sessionId, sessionId))
      .orderBy(asc(sessionPendingRuns.position), asc(sessionPendingRuns.createdAt), asc(sessionPendingRuns.runId));

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

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : -1;
    const normalizedCursor = Number.isFinite(parsedCursor) && parsedCursor >= -1 ? parsedCursor : -1;
    const filters = [eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.cursor, normalizedCursor)];
    if (runId) {
      filters.push(eq(sessionEvents.runId, runId));
    }

    const rows = await this.db.select().from(sessionEvents).where(and(...filters)).orderBy(asc(sessionEvents.cursor));
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

export class PostgresWorkspaceArchiveRepository implements WorkspaceArchiveRepository {
  constructor(private readonly db: OahDatabase) {}

  async #buildArchive(
    tx: OahTransaction,
    input: {
      workspace: WorkspaceRecord;
      scopeType: WorkspaceArchiveRecord["scopeType"];
      scopeId: string;
      archiveDate: string;
      archivedAt: string;
      deletedAt: string;
      timezone: string;
      sessionIds?: string[] | undefined;
    }
  ): Promise<WorkspaceArchiveRecord> {
    const sessionsForArchive = (
      input.sessionIds && input.sessionIds.length > 0
        ? await tx.select().from(sessions).where(inArray(sessions.id, input.sessionIds)).orderBy(desc(sessions.createdAt), asc(sessions.id))
        : await tx.select().from(sessions).where(eq(sessions.workspaceId, input.workspace.id)).orderBy(desc(sessions.createdAt), asc(sessions.id))
    ).map(toSession);
    const sessionIds = sessionsForArchive.map((session) => session.id);

    const runsForArchive = (
      input.sessionIds && input.sessionIds.length > 0
        ? sessionIds.length > 0
          ? await tx.select().from(runs).where(inArray(runs.sessionId, sessionIds)).orderBy(desc(runs.createdAt), asc(runs.id))
          : []
        : await tx.select().from(runs).where(eq(runs.workspaceId, input.workspace.id)).orderBy(desc(runs.createdAt), asc(runs.id))
    ).map(toRun);
    const runIds = runsForArchive.map((run) => run.id);

    const messagesForArchive =
      sessionIds.length > 0
        ? (
            await tx
              .select()
              .from(messages)
              .where(inArray(messages.sessionId, sessionIds))
              .orderBy(desc(messages.createdAt), asc(messages.id))
          ).map(toMessage)
        : [];

    const engineMessagesForArchive =
      sessionIds.length > 0
        ? (
            await tx
              .select()
              .from(engineMessages)
              .where(inArray(engineMessages.sessionId, sessionIds))
              .orderBy(desc(engineMessages.createdAt), asc(engineMessages.id))
          ).map(toEngineMessageRecord)
        : [];

    const runStepsForArchive =
      runIds.length > 0
        ? (
            await tx
              .select()
              .from(runSteps)
              .where(inArray(runSteps.runId, runIds))
              .orderBy(desc(runSteps.startedAt), desc(runSteps.endedAt), desc(runSteps.seq), asc(runSteps.id))
          ).map(toRunStep)
        : [];

    const toolCallsForArchive =
      runIds.length > 0
        ? (
            await tx
              .select()
              .from(toolCalls)
              .where(inArray(toolCalls.runId, runIds))
              .orderBy(desc(toolCalls.startedAt), asc(toolCalls.id))
          ).map(toToolCallAuditRecord)
        : [];

    const hookRunsForArchive =
      runIds.length > 0
        ? (
            await tx
              .select()
              .from(hookRuns)
              .where(inArray(hookRuns.runId, runIds))
              .orderBy(desc(hookRuns.startedAt), asc(hookRuns.id))
          ).map(toHookRunAuditRecord)
        : [];

    const artifactsForArchive =
      runIds.length > 0
        ? (
            await tx
              .select()
              .from(artifacts)
              .where(inArray(artifacts.runId, runIds))
              .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
          ).map(toArtifactRecord)
        : [];

    return {
      id: createId("warc"),
      workspaceId: input.workspace.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      archiveDate: input.archiveDate,
      archivedAt: input.archivedAt,
      deletedAt: input.deletedAt,
      timezone: input.timezone,
      workspace: input.workspace,
      sessions: sessionsForArchive,
      runs: runsForArchive,
      messages: messagesForArchive,
      engineMessages: engineMessagesForArchive,
      runSteps: runStepsForArchive,
      toolCalls: toolCallsForArchive,
      hookRuns: hookRunsForArchive,
      artifacts: artifactsForArchive
    };
  }

  async archiveWorkspace(input: {
    workspace: WorkspaceRecord;
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord> {
    return this.db.transaction(async (tx) => {
      const archive = await this.#buildArchive(tx, {
        ...input,
        scopeType: "workspace",
        scopeId: input.workspace.id
      });

      const [row] = await tx.insert(archives).values(buildWorkspaceArchiveRow(archive)).returning();
      return toWorkspaceArchiveRecord(expectRow(row, `workspace archive ${archive.id}`));
    });
  }

  async archiveSessionTree(input: {
    workspace: WorkspaceRecord;
    rootSessionId: string;
    sessionIds: string[];
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord> {
    return this.db.transaction(async (tx) => {
      const archive = await this.#buildArchive(tx, {
        workspace: input.workspace,
        scopeType: "session",
        scopeId: input.rootSessionId,
        sessionIds: input.sessionIds,
        archiveDate: input.archiveDate,
        archivedAt: input.archivedAt,
        deletedAt: input.deletedAt,
        timezone: input.timezone
      });

      const [row] = await tx.insert(archives).values(buildWorkspaceArchiveRow(archive)).returning();
      return toWorkspaceArchiveRecord(expectRow(row, `session archive ${archive.id}`));
    });
  }

  async listPendingArchiveDates(beforeArchiveDate: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ archiveDate: archives.archiveDate })
      .from(archives)
      .where(and(sql`${archives.exportedAt} is null`, sql`${archives.archiveDate} < ${beforeArchiveDate}`))
      .orderBy(asc(archives.archiveDate))
      .limit(limit);

    return rows.map((row) => row.archiveDate);
  }

  async listByArchiveDate(archiveDate: string): Promise<WorkspaceArchiveRecord[]> {
    const rows = await this.db
      .select()
      .from(archives)
      .where(eq(archives.archiveDate, archiveDate))
      .orderBy(asc(archives.archivedAt), asc(archives.id));

    return rows.map(toWorkspaceArchiveRecord);
  }

  async markExported(ids: string[], input: { exportedAt: string; exportPath: string }): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .update(archives)
      .set({
        exportedAt: input.exportedAt,
        exportPath: input.exportPath
      })
      .where(inArray(archives.id, ids));
  }

  async pruneExportedBefore(beforeArchiveDate: string, limit: number): Promise<number> {
    if (limit <= 0) {
      return 0;
    }

    const ids = await this.db
      .select({ id: archives.id })
      .from(archives)
      .where(and(sql`${archives.exportedAt} is not null`, sql`${archives.archiveDate} < ${beforeArchiveDate}`))
      .orderBy(asc(archives.archiveDate), asc(archives.archivedAt), asc(archives.id))
      .limit(limit);

    if (ids.length === 0) {
      return 0;
    }

    const deleted = await this.db
      .delete(archives)
      .where(inArray(archives.id, ids.map((row) => row.id)))
      .returning({ id: archives.id });

    return deleted.length;
  }
}
