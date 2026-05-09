import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

import type { WorkspaceArchiveRecord, WorkspaceArchiveRepository, WorkspaceRecord } from "@oah/engine-core";
import { AppError, createId } from "@oah/engine-core";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import type { OahDatabase, OahTransaction } from "./schema.js";
import { archives, artifacts, engineMessages, hookRuns, messages, runSteps, runs, sessions, toolCalls } from "./schema.js";
import {
  buildWorkspaceArchiveRow,
  toArtifactRecord,
  toEngineMessageRecord,
  toHookRunAuditRecord,
  toMessage,
  toRun,
  toRunStep,
  toSession,
  toToolCallAuditRecord,
  toWorkspaceArchiveRecord
} from "./row-mappers.js";
import { DEFAULT_POSTGRES_BOUNDED_READ_LIMIT, resolvePostgresBoundedReadLimit } from "./repository-read-limits.js";

const MAX_POSTGRES_ARCHIVE_COMPONENT_LIMIT = 500_000;
const POSTGRES_ARCHIVE_PAYLOAD_PAGE_SIZE = 500;

const DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS = {
  sessions: 10_000,
  runs: 50_000,
  messages: 100_000,
  engineMessages: 100_000,
  runSteps: 100_000,
  toolCalls: 100_000,
  hookRuns: 100_000,
  artifacts: 100_000
} as const;

interface PostgresWorkspaceArchiveRepositoryOptions {
  payloadRoot?: string | undefined;
}

type ArchiveComponentName =
  | "sessions"
  | "runs"
  | "messages"
  | "engineMessages"
  | "runSteps"
  | "toolCalls"
  | "hookRuns"
  | "artifacts";

type ArchiveComponentLimits = Record<ArchiveComponentName, number>;

function resolvePostgresArchiveComponentLimit(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim() || process.env.OAH_POSTGRES_ARCHIVE_MAX_COMPONENT_ROWS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_POSTGRES_ARCHIVE_COMPONENT_LIMIT);
}

function assertArchiveComponentLimit(
  component: string,
  rows: readonly unknown[],
  limit: number,
  input: {
    workspace: WorkspaceRecord;
    scopeType: WorkspaceArchiveRecord["scopeType"];
    scopeId: string;
  }
): void {
  if (rows.length <= limit) {
    return;
  }

  throw new AppError(
    413,
    "workspace_archive_too_large",
    `Workspace archive ${input.scopeType}:${input.scopeId} for workspace ${input.workspace.id} exceeded the ${component} row limit (${limit}). ` +
      "Export or prune older metadata before retrying, or raise the matching OAH_POSTGRES_ARCHIVE_MAX_* limit."
  );
}

class JsonArchivePayloadWriter {
  readonly #stream: ReturnType<typeof createWriteStream>;
  #needsPropertySeparator = false;
  #currentArrayNeedsSeparator = false;

  constructor(filePath: string) {
    this.#stream = createWriteStream(filePath, {
      encoding: "utf8"
    });
  }

  async open(): Promise<void> {
    await this.write("{");
  }

  async writeProperty(name: string, value: unknown): Promise<void> {
    await this.writePropertyPrefix(name);
    await this.write(JSON.stringify(value ?? null));
  }

  async beginArray(name: ArchiveComponentName): Promise<void> {
    await this.writePropertyPrefix(name);
    this.#currentArrayNeedsSeparator = false;
    await this.write("[");
  }

  async writeArrayItem(value: unknown): Promise<void> {
    if (this.#currentArrayNeedsSeparator) {
      await this.write(",");
    }
    this.#currentArrayNeedsSeparator = true;
    await this.write(JSON.stringify(value ?? null));
  }

  async endArray(): Promise<void> {
    await this.write("]");
  }

  async close(): Promise<void> {
    await this.write("}");
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async destroy(): Promise<void> {
    this.#stream.destroy();
  }

  private async writePropertyPrefix(name: string): Promise<void> {
    if (this.#needsPropertySeparator) {
      await this.write(",");
    }
    this.#needsPropertySeparator = true;
    await this.write(`${JSON.stringify(name)}:`);
  }

  private async write(chunk: string): Promise<void> {
    if (this.#stream.write(chunk)) {
      return;
    }

    await once(this.#stream, "drain");
  }
}

function resolveArchivePayloadRoot(input?: string | undefined): string | undefined {
  const configured = input?.trim() || process.env.OAH_POSTGRES_ARCHIVE_PAYLOAD_DIR?.trim();
  return configured ? path.resolve(configured) : undefined;
}

function archivePayloadPath(root: string, archiveDate: string, archiveId: string): string {
  return path.join(root, archiveDate, `${archiveId}.json`);
}

export class PostgresWorkspaceArchiveRepository implements WorkspaceArchiveRepository {
  readonly #payloadRoot: string | undefined;

  constructor(private readonly db: OahDatabase, options: PostgresWorkspaceArchiveRepositoryOptions = {}) {
    this.#payloadRoot = resolveArchivePayloadRoot(options.payloadRoot);
  }

  async #writePagedArchiveArray<Row, Value>(
    writer: JsonArchivePayloadWriter,
    component: ArchiveComponentName,
    limit: number,
    loadPage: (offset: number, pageSize: number) => Promise<Row[]>,
    mapRow: (row: Row) => Value
  ): Promise<void> {
    await writer.beginArray(component);
    let count = 0;
    let offset = 0;

    while (true) {
      const rows = await loadPage(offset, POSTGRES_ARCHIVE_PAYLOAD_PAGE_SIZE);
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        count += 1;
        if (count > limit) {
          throw new AppError(
            413,
            "workspace_archive_too_large",
            `Workspace archive exceeded the ${component} row limit (${limit}). ` +
              "Export or prune older metadata before retrying, or raise the matching OAH_POSTGRES_ARCHIVE_MAX_* limit."
          );
        }
        await writer.writeArrayItem(mapRow(row));
      }

      if (rows.length < POSTGRES_ARCHIVE_PAYLOAD_PAGE_SIZE) {
        break;
      }
      offset += rows.length;
    }

    await writer.endArray();
  }

  async #writeExternalArchivePayload(
    tx: OahTransaction,
    input: {
      archiveId: string;
      workspace: WorkspaceRecord;
      archiveDate: string;
      sessionIds?: string[] | undefined;
      limits: ArchiveComponentLimits;
    }
  ): Promise<{ payloadRef: string; payloadBytes: number }> {
    const payloadRoot = this.#payloadRoot;
    if (!payloadRoot) {
      throw new Error("Postgres archive payload root is not configured.");
    }

    const payloadPath = archivePayloadPath(payloadRoot, input.archiveDate, input.archiveId);
    const tempPath = `${payloadPath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(payloadPath), { recursive: true });
    await rm(tempPath, { force: true });

    const writer = new JsonArchivePayloadWriter(tempPath);
    try {
      await writer.open();
      await writer.writeProperty("workspace", input.workspace);

      const sessionFilterIds = input.sessionIds?.length ? input.sessionIds : undefined;

      await this.#writePagedArchiveArray(
        writer,
        "sessions",
        input.limits.sessions,
        (offset, pageSize) =>
          sessionFilterIds
            ? tx
                .select()
                .from(sessions)
                .where(inArray(sessions.id, sessionFilterIds))
                .orderBy(desc(sessions.createdAt), asc(sessions.id))
                .limit(pageSize)
                .offset(offset)
            : tx
                .select()
                .from(sessions)
                .where(eq(sessions.workspaceId, input.workspace.id))
                .orderBy(desc(sessions.createdAt), asc(sessions.id))
                .limit(pageSize)
                .offset(offset),
        toSession
      );

      await this.#writePagedArchiveArray(
        writer,
        "runs",
        input.limits.runs,
        (offset, pageSize) =>
          sessionFilterIds
            ? tx
                .select()
                .from(runs)
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(runs.createdAt), asc(runs.id))
                .limit(pageSize)
                .offset(offset)
            : tx
                .select()
                .from(runs)
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(runs.createdAt), asc(runs.id))
                .limit(pageSize)
                .offset(offset),
        toRun
      );

      await this.#writePagedArchiveArray(
        writer,
        "messages",
        input.limits.messages,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ message: messages })
                .from(messages)
                .where(inArray(messages.sessionId, sessionFilterIds))
                .orderBy(desc(messages.createdAt), asc(messages.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ message: messages })
                .from(messages)
                .innerJoin(sessions, eq(messages.sessionId, sessions.id))
                .where(eq(sessions.workspaceId, input.workspace.id))
                .orderBy(desc(messages.createdAt), asc(messages.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.message);
        },
        toMessage
      );

      await this.#writePagedArchiveArray(
        writer,
        "engineMessages",
        input.limits.engineMessages,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ engineMessage: engineMessages })
                .from(engineMessages)
                .where(inArray(engineMessages.sessionId, sessionFilterIds))
                .orderBy(desc(engineMessages.createdAt), asc(engineMessages.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ engineMessage: engineMessages })
                .from(engineMessages)
                .innerJoin(sessions, eq(engineMessages.sessionId, sessions.id))
                .where(eq(sessions.workspaceId, input.workspace.id))
                .orderBy(desc(engineMessages.createdAt), asc(engineMessages.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.engineMessage);
        },
        toEngineMessageRecord
      );

      await this.#writePagedArchiveArray(
        writer,
        "runSteps",
        input.limits.runSteps,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ runStep: runSteps })
                .from(runSteps)
                .innerJoin(runs, eq(runSteps.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(runSteps.startedAt), desc(runSteps.endedAt), desc(runSteps.seq), asc(runSteps.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ runStep: runSteps })
                .from(runSteps)
                .innerJoin(runs, eq(runSteps.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(runSteps.startedAt), desc(runSteps.endedAt), desc(runSteps.seq), asc(runSteps.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.runStep);
        },
        toRunStep
      );

      await this.#writePagedArchiveArray(
        writer,
        "toolCalls",
        input.limits.toolCalls,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ toolCall: toolCalls })
                .from(toolCalls)
                .innerJoin(runs, eq(toolCalls.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(toolCalls.startedAt), asc(toolCalls.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ toolCall: toolCalls })
                .from(toolCalls)
                .innerJoin(runs, eq(toolCalls.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(toolCalls.startedAt), asc(toolCalls.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.toolCall);
        },
        toToolCallAuditRecord
      );

      await this.#writePagedArchiveArray(
        writer,
        "hookRuns",
        input.limits.hookRuns,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ hookRun: hookRuns })
                .from(hookRuns)
                .innerJoin(runs, eq(hookRuns.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(hookRuns.startedAt), asc(hookRuns.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ hookRun: hookRuns })
                .from(hookRuns)
                .innerJoin(runs, eq(hookRuns.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(hookRuns.startedAt), asc(hookRuns.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.hookRun);
        },
        toHookRunAuditRecord
      );

      await this.#writePagedArchiveArray(
        writer,
        "artifacts",
        input.limits.artifacts,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ artifact: artifacts })
                .from(artifacts)
                .innerJoin(runs, eq(artifacts.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ artifact: artifacts })
                .from(artifacts)
                .innerJoin(runs, eq(artifacts.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.artifact);
        },
        toArtifactRecord
      );

      await writer.close();
      await rm(payloadPath, { force: true });
      await rename(tempPath, payloadPath);
      const payloadStat = await stat(payloadPath);
      return {
        payloadRef: payloadPath,
        payloadBytes: payloadStat.size
      };
    } catch (error) {
      await writer.destroy();
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  #archiveComponentLimits(): ArchiveComponentLimits {
    return {
      sessions: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_SESSIONS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.sessions
      ),
      runs: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_RUNS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.runs
      ),
      messages: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_MESSAGES",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.messages
      ),
      engineMessages: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_RUNTIME_MESSAGES",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.engineMessages
      ),
      runSteps: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_RUN_STEPS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.runSteps
      ),
      toolCalls: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_TOOL_CALLS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.toolCalls
      ),
      hookRuns: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_HOOK_RUNS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.hookRuns
      ),
      artifacts: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_ARTIFACTS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.artifacts
      )
    };
  }

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
    const archiveId = createId("warc");
    const limits = this.#archiveComponentLimits();

    if (this.#payloadRoot) {
      const payload = await this.#writeExternalArchivePayload(tx, {
        archiveId,
        workspace: input.workspace,
        archiveDate: input.archiveDate,
        ...(input.sessionIds ? { sessionIds: input.sessionIds } : {}),
        limits
      });

      return {
        id: archiveId,
        workspaceId: input.workspace.id,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        archiveDate: input.archiveDate,
        archivedAt: input.archivedAt,
        deletedAt: input.deletedAt,
        timezone: input.timezone,
        payloadRef: payload.payloadRef,
        payloadFormat: "json_v1",
        payloadBytes: payload.payloadBytes,
        workspace: input.workspace,
        sessions: [],
        runs: [],
        messages: [],
        engineMessages: [],
        runSteps: [],
        toolCalls: [],
        hookRuns: [],
        artifacts: []
      };
    }

    const sessionLimit = limits.sessions;
    const runLimit = limits.runs;
    const messageLimit = limits.messages;
    const engineMessageLimit = limits.engineMessages;
    const runStepLimit = limits.runSteps;
    const toolCallLimit = limits.toolCalls;
    const hookRunLimit = limits.hookRuns;
    const artifactLimit = limits.artifacts;

    const sessionRows =
      input.sessionIds && input.sessionIds.length > 0
        ? await tx
            .select()
            .from(sessions)
            .where(inArray(sessions.id, input.sessionIds))
            .orderBy(desc(sessions.createdAt), asc(sessions.id))
            .limit(sessionLimit + 1)
        : await tx
            .select()
            .from(sessions)
            .where(eq(sessions.workspaceId, input.workspace.id))
            .orderBy(desc(sessions.createdAt), asc(sessions.id))
            .limit(sessionLimit + 1);
    assertArchiveComponentLimit("sessions", sessionRows, sessionLimit, input);
    const sessionsForArchive = sessionRows.map(toSession);
    const sessionIds = sessionsForArchive.map((session) => session.id);

    const runRows =
      input.sessionIds && input.sessionIds.length > 0
        ? sessionIds.length > 0
          ? await tx
              .select()
              .from(runs)
              .where(inArray(runs.sessionId, sessionIds))
              .orderBy(desc(runs.createdAt), asc(runs.id))
              .limit(runLimit + 1)
          : []
        : await tx
            .select()
            .from(runs)
            .where(eq(runs.workspaceId, input.workspace.id))
            .orderBy(desc(runs.createdAt), asc(runs.id))
            .limit(runLimit + 1);
    assertArchiveComponentLimit("runs", runRows, runLimit, input);
    const runsForArchive = runRows.map(toRun);
    const runIds = runsForArchive.map((run) => run.id);

    const messageRows =
      sessionIds.length > 0
        ? await tx
            .select()
            .from(messages)
            .where(inArray(messages.sessionId, sessionIds))
            .orderBy(desc(messages.createdAt), asc(messages.id))
            .limit(messageLimit + 1)
        : [];
    assertArchiveComponentLimit("messages", messageRows, messageLimit, input);
    const messagesForArchive = messageRows.map(toMessage);

    const engineMessageRows =
      sessionIds.length > 0
        ? await tx
            .select()
            .from(engineMessages)
            .where(inArray(engineMessages.sessionId, sessionIds))
            .orderBy(desc(engineMessages.createdAt), asc(engineMessages.id))
            .limit(engineMessageLimit + 1)
        : [];
    assertArchiveComponentLimit("runtime_messages", engineMessageRows, engineMessageLimit, input);
    const engineMessagesForArchive = engineMessageRows.map(toEngineMessageRecord);

    const runStepRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(runSteps)
            .where(inArray(runSteps.runId, runIds))
            .orderBy(desc(runSteps.startedAt), desc(runSteps.endedAt), desc(runSteps.seq), asc(runSteps.id))
            .limit(runStepLimit + 1)
        : [];
    assertArchiveComponentLimit("run_steps", runStepRows, runStepLimit, input);
    const runStepsForArchive = runStepRows.map(toRunStep);

    const toolCallRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(toolCalls)
            .where(inArray(toolCalls.runId, runIds))
            .orderBy(desc(toolCalls.startedAt), asc(toolCalls.id))
            .limit(toolCallLimit + 1)
        : [];
    assertArchiveComponentLimit("tool_calls", toolCallRows, toolCallLimit, input);
    const toolCallsForArchive = toolCallRows.map(toToolCallAuditRecord);

    const hookRunRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(hookRuns)
            .where(inArray(hookRuns.runId, runIds))
            .orderBy(desc(hookRuns.startedAt), asc(hookRuns.id))
            .limit(hookRunLimit + 1)
        : [];
    assertArchiveComponentLimit("hook_runs", hookRunRows, hookRunLimit, input);
    const hookRunsForArchive = hookRunRows.map(toHookRunAuditRecord);

    const artifactRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(artifacts)
            .where(inArray(artifacts.runId, runIds))
            .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
            .limit(artifactLimit + 1)
        : [];
    assertArchiveComponentLimit("artifacts", artifactRows, artifactLimit, input);
    const artifactsForArchive = artifactRows.map(toArtifactRecord);

    return {
      id: archiveId,
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

      await tx.insert(archives).values(buildWorkspaceArchiveRow(archive)).returning();
      return archive;
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

      await tx.insert(archives).values(buildWorkspaceArchiveRow(archive)).returning();
      return archive;
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
    const limit = resolvePostgresBoundedReadLimit("OAH_POSTGRES_ARCHIVE_DATE_READ_LIMIT", DEFAULT_POSTGRES_BOUNDED_READ_LIMIT);
    const rows = await this.db
      .select()
      .from(archives)
      .where(eq(archives.archiveDate, archiveDate))
      .orderBy(asc(archives.archivedAt), asc(archives.id))
      .limit(limit);

    return rows.map(toWorkspaceArchiveRecord);
  }

  async forEachByArchiveDate(
    archiveDate: string,
    visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void,
    options?: {
      pageSize?: number | undefined;
    }
  ): Promise<number> {
    const pageSize = Math.max(1, options?.pageSize ?? 4);
    let lastArchivedAt: string | undefined;
    let lastId: string | undefined;
    let count = 0;

    while (true) {
      const cursorFilter =
        lastArchivedAt && lastId
          ? or(gt(archives.archivedAt, lastArchivedAt), and(eq(archives.archivedAt, lastArchivedAt), gt(archives.id, lastId)))
          : undefined;
      const rows = await this.db
        .select()
        .from(archives)
        .where(cursorFilter ? and(eq(archives.archiveDate, archiveDate), cursorFilter) : eq(archives.archiveDate, archiveDate))
        .orderBy(asc(archives.archivedAt), asc(archives.id))
        .limit(pageSize);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        await visitor(toWorkspaceArchiveRecord(row));
        count += 1;
      }

      if (rows.length < pageSize) {
        break;
      }

      const lastRow = rows[rows.length - 1]!;
      lastArchivedAt = lastRow.archivedAt;
      lastId = lastRow.id;
    }

    return count;
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

    const victims = await this.db
      .select({ id: archives.id, payloadRef: archives.payloadRef })
      .from(archives)
      .where(and(sql`${archives.exportedAt} is not null`, sql`${archives.archiveDate} < ${beforeArchiveDate}`))
      .orderBy(asc(archives.archiveDate), asc(archives.archivedAt), asc(archives.id))
      .limit(limit);

    if (victims.length === 0) {
      return 0;
    }

    const deleted = await this.db
      .delete(archives)
      .where(inArray(archives.id, victims.map((row) => row.id)))
      .returning({ id: archives.id });

    await Promise.allSettled(
      victims
        .map((row) => row.payloadRef)
        .filter((payloadRef): payloadRef is string => typeof payloadRef === "string" && payloadRef.length > 0)
        .map((payloadRef) => rm(payloadRef, { force: true }))
    );

    return deleted.length;
  }
}
