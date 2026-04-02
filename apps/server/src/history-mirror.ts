import path from "node:path";
import { access, mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { nowIso, type HistoryEventRecord, type HistoryEventRepository, type WorkspaceRecord, type WorkspaceRepository } from "@oah/runtime-core";

export interface HistoryMirrorLogger {
  info?(message: string): void;
  warn?(message: string, error?: unknown): void;
  error?(message: string, error?: unknown): void;
}

export interface HistoryMirrorSyncerOptions {
  workspaceRepository: WorkspaceRepository;
  historyEventRepository: HistoryEventRepository;
  pollIntervalMs?: number | undefined;
  batchSize?: number | undefined;
  logger?: HistoryMirrorLogger | undefined;
}

interface MirrorDatabaseHandle {
  dbPath: string;
  db: DatabaseSync;
}

interface MirrorStateRow {
  lastEventId: number;
  lastSyncedAt: string;
  status: string;
  errorMessage: string | null;
}

export interface HistoryMirrorStatus {
  workspaceId: string;
  supported: boolean;
  enabled: boolean;
  dbPath?: string | undefined;
  state: "unsupported" | "disabled" | "missing" | "idle" | "error";
  lastEventId?: number | undefined;
  lastSyncedAt?: string | undefined;
  errorMessage?: string | undefined;
}

const mirrorSchemaStatements = [
  `create table if not exists sessions (
    id text primary key,
    workspace_id text not null,
    subject_ref text not null,
    agent_name text,
    active_agent_name text not null,
    title text,
    status text not null,
    last_run_at text,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists sessions_workspace_created_idx on sessions (workspace_id, created_at desc)`,
  `create table if not exists messages (
    id text primary key,
    session_id text not null,
    run_id text,
    role text not null,
    content text not null,
    tool_name text,
    tool_call_id text,
    metadata text,
    created_at text not null
  )`,
  `create index if not exists messages_session_created_idx on messages (session_id, created_at)`,
  `create table if not exists runs (
    id text primary key,
    workspace_id text not null,
    session_id text,
    initiator_ref text,
    trigger_type text not null,
    trigger_ref text,
    agent_name text,
    effective_agent_name text not null,
    switch_count integer,
    status text not null,
    cancel_requested_at text,
    started_at text,
    ended_at text,
    error_code text,
    error_message text,
    metadata text,
    created_at text not null
  )`,
  `create index if not exists runs_workspace_created_idx on runs (workspace_id, created_at desc)`,
  `create table if not exists run_steps (
    id text primary key,
    run_id text not null,
    seq integer not null,
    step_type text not null,
    name text,
    agent_name text,
    status text not null,
    input text,
    output text,
    started_at text,
    ended_at text
  )`,
  `create index if not exists run_steps_run_seq_idx on run_steps (run_id, seq)`,
  `create table if not exists tool_calls (
    id text primary key,
    run_id text not null,
    step_id text,
    source_type text not null,
    tool_name text not null,
    request text,
    response text,
    status text not null,
    duration_ms integer,
    started_at text not null,
    ended_at text not null
  )`,
  `create index if not exists tool_calls_run_started_idx on tool_calls (run_id, started_at)`,
  `create table if not exists hook_runs (
    id text primary key,
    run_id text not null,
    hook_name text not null,
    event_name text not null,
    capabilities text not null,
    patch text,
    status text not null,
    started_at text not null,
    ended_at text not null,
    error_message text
  )`,
  `create index if not exists hook_runs_run_started_idx on hook_runs (run_id, started_at)`,
  `create table if not exists artifacts (
    id text primary key,
    run_id text not null,
    type text not null,
    path text,
    content_ref text,
    metadata text,
    created_at text not null
  )`,
  `create index if not exists artifacts_run_created_idx on artifacts (run_id, created_at desc)`,
  `create table if not exists mirror_state (
    workspace_id text primary key,
    last_event_id integer not null,
    last_synced_at text not null,
    status text not null,
    error_message text
  )`
];

const mirrorTableByEntityType = {
  session: "sessions",
  message: "messages",
  run: "runs",
  run_step: "run_steps",
  tool_call: "tool_calls",
  hook_run: "hook_runs",
  artifact: "artifacts"
} as const;

export function historyMirrorDbPath(rootPath: string): string {
  return path.join(rootPath, ".openharness", "data", "history.db");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function inspectHistoryMirrorStatus(workspace: WorkspaceRecord): Promise<HistoryMirrorStatus> {
  const dbPath = historyMirrorDbPath(workspace.rootPath);

  if (workspace.kind !== "project") {
    return {
      workspaceId: workspace.id,
      supported: false,
      enabled: false,
      dbPath,
      state: "unsupported"
    };
  }

  if (!workspace.historyMirrorEnabled) {
    return {
      workspaceId: workspace.id,
      supported: true,
      enabled: false,
      dbPath,
      state: "disabled"
    };
  }

  if (!(await pathExists(dbPath))) {
    return {
      workspaceId: workspace.id,
      supported: true,
      enabled: true,
      dbPath,
      state: "missing"
    };
  }

  try {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare(
          `select
             last_event_id as lastEventId,
             last_synced_at as lastSyncedAt,
             status,
             error_message as errorMessage
           from mirror_state
           where workspace_id = ?`
        )
        .get(workspace.id) as MirrorStateRow | undefined;

      if (!row) {
        return {
          workspaceId: workspace.id,
          supported: true,
          enabled: true,
          dbPath,
          state: "missing"
        };
      }

      return {
        workspaceId: workspace.id,
        supported: true,
        enabled: true,
        dbPath,
        state: row.status === "error" ? "error" : "idle",
        lastEventId: row.lastEventId,
        lastSyncedAt: row.lastSyncedAt,
        ...(row.errorMessage ? { errorMessage: row.errorMessage } : {})
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      workspaceId: workspace.id,
      supported: true,
      enabled: true,
      dbPath,
      state: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown history mirror error."
    };
  }
}

export class HistoryMirrorSyncer {
  readonly #workspaceRepository: WorkspaceRepository;
  readonly #historyEventRepository: HistoryEventRepository;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #logger: HistoryMirrorLogger;
  readonly #databases = new Map<string, MirrorDatabaseHandle>();
  #activeOperation: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: HistoryMirrorSyncerOptions) {
    this.#workspaceRepository = options.workspaceRepository;
    this.#historyEventRepository = options.historyEventRepository;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#batchSize = options.batchSize ?? 250;
    this.#logger = options.logger ?? {};
  }

  start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.syncOnce();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
    void this.syncOnce();
  }

  async close(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    if (this.#activeOperation) {
      try {
        await this.#activeOperation;
      } catch {
        // Ignore sync failures during shutdown.
      }
    }

    for (const { db } of this.#databases.values()) {
      db.close();
    }

    this.#databases.clear();
  }

  async syncOnce(): Promise<void> {
    if (this.#activeOperation) {
      return;
    }

    await this.#runExclusive(async () => {
      let cursor: string | undefined;
      do {
        const workspaces = await this.#workspaceRepository.list(100, cursor);
        for (const workspace of workspaces) {
          await this.#syncWorkspace(workspace);
        }

        cursor = workspaces.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
      } while (cursor);
    });
  }

  async rebuildWorkspace(workspace: WorkspaceRecord): Promise<HistoryMirrorStatus> {
    await this.#runExclusive(async () => {
      if (workspace.kind !== "project" || !workspace.historyMirrorEnabled) {
        return;
      }

      const dbPath = historyMirrorDbPath(workspace.rootPath);
      this.#closeMirrorDatabase(workspace.id);
      await Promise.all([
        rm(dbPath, { force: true }),
        rm(`${dbPath}-shm`, { force: true }),
        rm(`${dbPath}-wal`, { force: true })
      ]);
      await this.#syncWorkspace(workspace, {
        reset: true
      });
    });

    return inspectHistoryMirrorStatus(workspace);
  }

  async #syncWorkspace(workspace: WorkspaceRecord, options?: { reset?: boolean | undefined }): Promise<void> {
    if (workspace.kind !== "project" || !workspace.historyMirrorEnabled) {
      return;
    }

    const handle = await this.#openMirrorDatabase(workspace);
    let lastAppliedEventId = options?.reset ? 0 : this.#readMirrorState(handle.db, workspace.id)?.lastEventId ?? 0;

    try {
      while (true) {
        const fetchedEvents = await this.#historyEventRepository.listByWorkspaceId(
          workspace.id,
          this.#batchSize,
          lastAppliedEventId > 0 ? lastAppliedEventId : undefined
        );
        const events = fetchedEvents.filter((event) => event.id > lastAppliedEventId);
        if (events.length === 0) {
          if (fetchedEvents.length > 0) {
            this.#logger.warn?.(
              `History mirror sync made no forward progress for workspace ${workspace.id}; stopping this pass to avoid a tight loop.`
            );
          }
          if (options?.reset || lastAppliedEventId > 0) {
            this.#writeMirrorState(handle.db, workspace.id, lastAppliedEventId, "idle", null);
          }
          return;
        }

        this.#runInTransaction(handle.db, () => {
          for (const event of events) {
            this.#applyHistoryEvent(handle.db, event);
          }

          const latestEventId = events.at(-1)?.id ?? lastAppliedEventId;
          this.#writeMirrorState(handle.db, workspace.id, latestEventId, "idle", null);
          lastAppliedEventId = latestEventId;
        });
      }
    } catch (error) {
      this.#writeMirrorState(handle.db, workspace.id, lastAppliedEventId, "error", this.#errorMessage(error));
      this.#logger.warn?.(`History mirror sync failed for workspace ${workspace.id}.`, error);
    }
  }

  async #runExclusive(operation: () => Promise<void>): Promise<void> {
    while (this.#activeOperation) {
      try {
        await this.#activeOperation;
      } catch {
        // Ignore previous operation failures and allow a fresh retry.
      }
    }

    const task = operation();
    this.#activeOperation = task;
    try {
      await task;
    } finally {
      if (this.#activeOperation === task) {
        this.#activeOperation = undefined;
      }
    }
  }

  async #openMirrorDatabase(workspace: WorkspaceRecord): Promise<MirrorDatabaseHandle> {
    const dbPath = historyMirrorDbPath(workspace.rootPath);
    const cached = this.#databases.get(workspace.id);
    if (cached && cached.dbPath === dbPath) {
      return cached;
    }

    if (cached) {
      cached.db.close();
    }

    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("pragma journal_mode = wal");
    db.exec("pragma busy_timeout = 5000");
    for (const statement of mirrorSchemaStatements) {
      db.exec(statement);
    }

    const handle = { dbPath, db };
    this.#databases.set(workspace.id, handle);
    return handle;
  }

  #closeMirrorDatabase(workspaceId: string): void {
    const cached = this.#databases.get(workspaceId);
    if (!cached) {
      return;
    }

    cached.db.close();
    this.#databases.delete(workspaceId);
  }

  #readMirrorState(db: DatabaseSync, workspaceId: string): MirrorStateRow | undefined {
    return db
      .prepare(
        `select
          last_event_id as lastEventId,
          last_synced_at as lastSyncedAt,
          status,
          error_message as errorMessage
        from mirror_state
        where workspace_id = ?`
      )
      .get(workspaceId) as MirrorStateRow | undefined;
  }

  #writeMirrorState(
    db: DatabaseSync,
    workspaceId: string,
    lastEventId: number,
    status: "idle" | "error",
    errorMessage: string | null
  ): void {
    db.prepare(
      `insert into mirror_state (workspace_id, last_event_id, last_synced_at, status, error_message)
       values (?, ?, ?, ?, ?)
       on conflict(workspace_id) do update set
         last_event_id = excluded.last_event_id,
         last_synced_at = excluded.last_synced_at,
         status = excluded.status,
         error_message = excluded.error_message`
    ).run(workspaceId, lastEventId, nowIso(), status, errorMessage);
  }

  #applyHistoryEvent(db: DatabaseSync, event: HistoryEventRecord): void {
    if (event.op === "delete") {
      this.#deleteMirrorRow(db, event);
      return;
    }

    if (event.op === "replace") {
      this.#deleteMirrorRow(db, event);
    }

    const payload = event.payload;
    switch (event.entityType) {
      case "session":
        this.#upsertRow(db, "sessions", "id", {
          id: this.#string(payload.id) ?? event.entityId,
          workspace_id: this.#string(payload.workspaceId) ?? event.workspaceId,
          subject_ref: this.#requiredString(payload.subjectRef, "subjectRef", event),
          agent_name: this.#string(payload.agentName),
          active_agent_name: this.#requiredString(payload.activeAgentName, "activeAgentName", event),
          title: this.#string(payload.title),
          status: this.#requiredString(payload.status, "status", event),
          last_run_at: this.#string(payload.lastRunAt),
          created_at: this.#requiredString(payload.createdAt, "createdAt", event),
          updated_at: this.#requiredString(payload.updatedAt, "updatedAt", event)
        });
        return;
      case "message":
        this.#upsertRow(db, "messages", "id", {
          id: this.#string(payload.id) ?? event.entityId,
          session_id: this.#requiredString(payload.sessionId, "sessionId", event),
          run_id: this.#string(payload.runId),
          role: this.#requiredString(payload.role, "role", event),
          content: this.#requiredString(payload.content, "content", event),
          tool_name: this.#string(payload.toolName),
          tool_call_id: this.#string(payload.toolCallId),
          metadata: this.#json(payload.metadata),
          created_at: this.#requiredString(payload.createdAt, "createdAt", event)
        });
        return;
      case "run":
        this.#upsertRow(db, "runs", "id", {
          id: this.#string(payload.id) ?? event.entityId,
          workspace_id: this.#string(payload.workspaceId) ?? event.workspaceId,
          session_id: this.#string(payload.sessionId),
          initiator_ref: this.#string(payload.initiatorRef),
          trigger_type: this.#requiredString(payload.triggerType, "triggerType", event),
          trigger_ref: this.#string(payload.triggerRef),
          agent_name: this.#string(payload.agentName),
          effective_agent_name: this.#requiredString(payload.effectiveAgentName, "effectiveAgentName", event),
          switch_count: this.#integer(payload.switchCount),
          status: this.#requiredString(payload.status, "status", event),
          cancel_requested_at: this.#string(payload.cancelRequestedAt),
          started_at: this.#string(payload.startedAt),
          ended_at: this.#string(payload.endedAt),
          error_code: this.#string(payload.errorCode),
          error_message: this.#string(payload.errorMessage),
          metadata: this.#json(payload.metadata),
          created_at: this.#requiredString(payload.createdAt, "createdAt", event)
        });
        return;
      case "run_step":
        this.#upsertRow(db, "run_steps", "id", {
          id: this.#string(payload.id) ?? event.entityId,
          run_id: this.#requiredString(payload.runId, "runId", event),
          seq: this.#requiredInteger(payload.seq, "seq", event),
          step_type: this.#requiredString(payload.stepType, "stepType", event),
          name: this.#string(payload.name),
          agent_name: this.#string(payload.agentName),
          status: this.#requiredString(payload.status, "status", event),
          input: this.#json(payload.input),
          output: this.#json(payload.output),
          started_at: this.#string(payload.startedAt),
          ended_at: this.#string(payload.endedAt)
        });
        return;
      case "tool_call":
        this.#upsertRow(db, "tool_calls", "id", {
          id: this.#string(payload.id) ?? event.entityId,
          run_id: this.#requiredString(payload.runId, "runId", event),
          step_id: this.#string(payload.stepId),
          source_type: this.#requiredString(payload.sourceType, "sourceType", event),
          tool_name: this.#requiredString(payload.toolName, "toolName", event),
          request: this.#json(payload.request),
          response: this.#json(payload.response),
          status: this.#requiredString(payload.status, "status", event),
          duration_ms: this.#integer(payload.durationMs),
          started_at: this.#requiredString(payload.startedAt, "startedAt", event),
          ended_at: this.#requiredString(payload.endedAt, "endedAt", event)
        });
        return;
      case "hook_run":
        this.#upsertRow(db, "hook_runs", "id", {
          id: this.#string(payload.id) ?? event.entityId,
          run_id: this.#requiredString(payload.runId, "runId", event),
          hook_name: this.#requiredString(payload.hookName, "hookName", event),
          event_name: this.#requiredString(payload.eventName, "eventName", event),
          capabilities: this.#requiredJson(payload.capabilities, "capabilities", event),
          patch: this.#json(payload.patch),
          status: this.#requiredString(payload.status, "status", event),
          started_at: this.#requiredString(payload.startedAt, "startedAt", event),
          ended_at: this.#requiredString(payload.endedAt, "endedAt", event),
          error_message: this.#string(payload.errorMessage)
        });
        return;
      case "artifact":
        this.#upsertRow(db, "artifacts", "id", {
          id: this.#string(payload.id) ?? event.entityId,
          run_id: this.#requiredString(payload.runId, "runId", event),
          type: this.#requiredString(payload.type, "type", event),
          path: this.#string(payload.path),
          content_ref: this.#string(payload.contentRef),
          metadata: this.#json(payload.metadata),
          created_at: this.#requiredString(payload.createdAt, "createdAt", event)
        });
        return;
      default:
        return;
    }
  }

  #deleteMirrorRow(db: DatabaseSync, event: HistoryEventRecord): void {
    const table = mirrorTableByEntityType[event.entityType];
    if (!table) {
      return;
    }

    db.prepare(`delete from ${table} where id = ?`).run(event.entityId);
  }

  #upsertRow(
    db: DatabaseSync,
    table: string,
    primaryKey: string,
    row: Record<string, string | number | null>
  ): void {
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column] ?? null);
    const placeholders = columns.map(() => "?").join(", ");
    const updateAssignments = columns
      .filter((column) => column !== primaryKey)
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");

    db.prepare(
      `insert into ${table} (${columns.join(", ")})
       values (${placeholders})
       on conflict(${primaryKey}) do update set ${updateAssignments}`
    ).run(...values);
  }

  #runInTransaction(db: DatabaseSync, operation: () => void): void {
    db.exec("begin immediate");
    try {
      operation();
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // Ignore rollback errors because the original error is more useful.
      }
      throw error;
    }
  }

  #string(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  #integer(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  }

  #json(value: unknown): string | null {
    if (value === undefined) {
      return null;
    }

    return JSON.stringify(value);
  }

  #requiredString(value: unknown, fieldName: string, event: HistoryEventRecord): string {
    const resolved = this.#string(value);
    if (resolved !== null) {
      return resolved;
    }

    throw new Error(`Missing string field "${fieldName}" in history event ${event.id} (${event.entityType}:${event.entityId}).`);
  }

  #requiredInteger(value: unknown, fieldName: string, event: HistoryEventRecord): number {
    const resolved = this.#integer(value);
    if (resolved !== null) {
      return resolved;
    }

    throw new Error(`Missing integer field "${fieldName}" in history event ${event.id} (${event.entityType}:${event.entityId}).`);
  }

  #requiredJson(value: unknown, fieldName: string, event: HistoryEventRecord): string {
    const resolved = this.#json(value);
    if (resolved !== null) {
      return resolved;
    }

    throw new Error(`Missing JSON field "${fieldName}" in history event ${event.id} (${event.entityType}:${event.entityId}).`);
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown history mirror error.";
  }
}
