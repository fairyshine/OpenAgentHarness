import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRecord,
  ArtifactRepository,
  HistoryEventRecord,
  HistoryEventRepository,
  HookRunAuditRecord,
  HookRunAuditRepository,
  Message,
  MessageRepository,
  Run,
  RunRepository,
  RunStep,
  RunStepRepository,
  Session,
  SessionEvent,
  SessionEventStore,
  SessionRepository,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/runtime-core";
import {
  AppError,
  createId,
  normalizePersistedMessageRecord,
  normalizePersistedMessages,
  normalizePersistedRunStep,
  nowIso,
  parseCursor
} from "@oah/runtime-core";

interface DatabaseHandle {
  dbPath: string;
  db: DatabaseSync;
}

interface JsonRow {
  payload: string;
}

interface IdRow {
  id: string;
}

interface WorkspaceMessageRow {
  session_id: string;
  payload: string;
}

interface WorkspaceScopedPayloadRow {
  id: string;
  workspace_id: string;
  payload: string;
}

interface WorkspaceRunStepRow {
  id: string;
  payload: string;
}

interface CursorRow {
  maxCursor: number | null;
}

interface HistoryEventRow {
  id: number;
  workspace_id: string;
  entity_type: HistoryEventRecord["entityType"];
  entity_id: string;
  op: HistoryEventRecord["op"];
  payload: string;
  occurred_at: string;
}

interface TableInfoRow {
  name: string;
}

const schemaStatements = [
  `create table if not exists workspace_meta (
    id text primary key,
    root_path text not null,
    kind text not null,
    read_only integer not null,
    payload text not null,
    updated_at text not null
  )`,
  `create table if not exists sessions (
    id text primary key,
    workspace_id text not null,
    created_at text not null,
    updated_at text not null,
    payload text not null
  )`,
  `create index if not exists sessions_workspace_updated_idx on sessions (workspace_id, updated_at desc, created_at desc, id asc)`,
  `create table if not exists messages (
    id text primary key,
    session_id text not null,
    run_id text,
    created_at text not null,
    payload text not null
  )`,
  `create index if not exists messages_session_created_idx on messages (session_id, created_at asc, id asc)`,
  `create table if not exists runs (
    id text primary key,
    workspace_id text not null,
    session_id text,
    status text not null,
    heartbeat_at text,
    started_at text,
    created_at text not null,
    payload text not null
  )`,
  `create index if not exists runs_workspace_created_idx on runs (workspace_id, created_at desc, id asc)`,
  `create index if not exists runs_recoverable_idx on runs (status, heartbeat_at, started_at, created_at, id)`,
  `create table if not exists run_steps (
    id text primary key,
    run_id text not null,
    seq integer not null,
    payload text not null
  )`,
  `create unique index if not exists run_steps_run_seq_idx on run_steps (run_id, seq)`,
  `create table if not exists session_events (
    id text primary key,
    session_id text not null,
    run_id text,
    cursor integer not null,
    created_at text not null,
    payload text not null
  )`,
  `create unique index if not exists session_events_session_cursor_idx on session_events (session_id, cursor)`,
  `create index if not exists session_events_session_run_cursor_idx on session_events (session_id, run_id, cursor)`,
  `create table if not exists tool_calls (
    id text primary key,
    run_id text not null,
    started_at text not null,
    payload text not null
  )`,
  `create index if not exists tool_calls_run_started_idx on tool_calls (run_id, started_at asc, id asc)`,
  `create table if not exists hook_runs (
    id text primary key,
    run_id text not null,
    started_at text not null,
    payload text not null
  )`,
  `create index if not exists hook_runs_run_started_idx on hook_runs (run_id, started_at asc, id asc)`,
  `create table if not exists artifacts (
    id text primary key,
    run_id text not null,
    created_at text not null,
    payload text not null
  )`,
  `create index if not exists artifacts_run_created_idx on artifacts (run_id, created_at asc, id asc)`,
  `create table if not exists history_events (
    id integer primary key autoincrement,
    workspace_id text not null,
    entity_type text not null,
    entity_id text not null,
    op text not null,
    payload text not null,
    occurred_at text not null
  )`,
  `create index if not exists history_events_workspace_idx on history_events (workspace_id, id asc)`
];

function defaultProjectDbPath(workspace: Pick<WorkspaceRecord, "rootPath">): string {
  return path.join(workspace.rootPath, ".openharness", "data", "history.db");
}

function shadowDbPath(shadowRoot: string, workspaceId: string): string {
  return path.join(shadowRoot, workspaceId, "history.db");
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function coerceRows<T>(value: unknown): T[] {
  return value as T[];
}

function parseJsonish(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("select name from sqlite_master where type = 'table' and name = ? limit 1")
    .get(tableName) as TableInfoRow | undefined;
  return Boolean(row?.name);
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const rows = coerceRows<{ name?: unknown }>(db.prepare(`pragma table_info(${tableName})`).all());
  return rows.some((row) => row.name === columnName);
}

function applyPrimarySchema(db: DatabaseSync): void {
  for (const statement of schemaStatements) {
    db.exec(statement);
  }
}

function migrateLegacyMirrorSchemaIfNeeded(db: DatabaseSync): void {
  if (!tableExists(db, "sessions") || tableHasColumn(db, "sessions", "payload")) {
    applyPrimarySchema(db);
    return;
  }

  const legacyTables = ["sessions", "messages", "runs", "run_steps", "tool_calls", "hook_runs", "artifacts", "mirror_state"];

  runInTransaction(db, () => {
    for (const tableName of legacyTables) {
      if (!tableExists(db, tableName)) {
        continue;
      }

      db.exec(`alter table ${tableName} rename to legacy_${tableName}`);
    }

    applyPrimarySchema(db);

    if (tableExists(db, "legacy_sessions")) {
      const rows = coerceRows<Record<string, unknown>>(db.prepare("select * from legacy_sessions").all());
      for (const row of rows) {
        const payload: Session = {
          id: stringValue(row.id) ?? "",
          workspaceId: stringValue(row.workspace_id) ?? "",
          subjectRef: stringValue(row.subject_ref) ?? "",
          activeAgentName: stringValue(row.active_agent_name) ?? "",
          status: (stringValue(row.status) ?? "active") as Session["status"],
          createdAt: stringValue(row.created_at) ?? nowIso(),
          updatedAt: stringValue(row.updated_at) ?? nowIso(),
          ...(stringValue(row.agent_name) ? { agentName: stringValue(row.agent_name) } : {}),
          ...(stringValue(row.title) ? { title: stringValue(row.title) } : {}),
          ...(stringValue(row.last_run_at) ? { lastRunAt: stringValue(row.last_run_at) } : {})
        };

        db.prepare("insert or replace into sessions (id, workspace_id, created_at, updated_at, payload) values (?, ?, ?, ?, ?)")
          .run(payload.id, payload.workspaceId, payload.createdAt, payload.updatedAt, serializeJson(payload));
      }
    }

    if (tableExists(db, "legacy_messages")) {
      const rows = coerceRows<Record<string, unknown>>(db.prepare("select * from legacy_messages").all());
      for (const row of rows) {
        const payload: Message = {
          id: stringValue(row.id) ?? "",
          sessionId: stringValue(row.session_id) ?? "",
          role: (stringValue(row.role) ?? "assistant") as Message["role"],
          content: (parseJsonish(row.content) ?? "") as Message["content"],
          createdAt: stringValue(row.created_at) ?? nowIso(),
          ...(stringValue(row.run_id) ? { runId: stringValue(row.run_id) } : {}),
          ...(parseJsonish(row.metadata) !== undefined ? { metadata: parseJsonish(row.metadata) as Record<string, unknown> } : {})
        };

        db.prepare("insert or replace into messages (id, session_id, run_id, created_at, payload) values (?, ?, ?, ?, ?)")
          .run(payload.id, payload.sessionId, payload.runId ?? null, payload.createdAt, serializeJson(payload));
      }
    }

    if (tableExists(db, "legacy_runs")) {
      const rows = coerceRows<Record<string, unknown>>(db.prepare("select * from legacy_runs").all());
      for (const row of rows) {
        const payload: Run = {
          id: stringValue(row.id) ?? "",
          workspaceId: stringValue(row.workspace_id) ?? "",
          triggerType: (stringValue(row.trigger_type) ?? "user_message") as Run["triggerType"],
          effectiveAgentName: stringValue(row.effective_agent_name) ?? "default",
          status: (stringValue(row.status) ?? "queued") as Run["status"],
          createdAt: stringValue(row.created_at) ?? nowIso(),
          ...(stringValue(row.session_id) ? { sessionId: stringValue(row.session_id) } : {}),
          ...(stringValue(row.initiator_ref) ? { initiatorRef: stringValue(row.initiator_ref) } : {}),
          ...(stringValue(row.trigger_ref) ? { triggerRef: stringValue(row.trigger_ref) } : {}),
          ...(stringValue(row.agent_name) ? { agentName: stringValue(row.agent_name) } : {}),
          ...(integerValue(row.switch_count) !== undefined ? { switchCount: integerValue(row.switch_count) } : {}),
          ...(stringValue(row.cancel_requested_at) ? { cancelRequestedAt: stringValue(row.cancel_requested_at) } : {}),
          ...(stringValue(row.started_at) ? { startedAt: stringValue(row.started_at) } : {}),
          ...(stringValue(row.ended_at) ? { endedAt: stringValue(row.ended_at) } : {}),
          ...(stringValue(row.error_code) ? { errorCode: stringValue(row.error_code) } : {}),
          ...(stringValue(row.error_message) ? { errorMessage: stringValue(row.error_message) } : {}),
          ...(parseJsonish(row.metadata) !== undefined ? { metadata: parseJsonish(row.metadata) as Record<string, unknown> } : {})
        };

        db.prepare(
          "insert or replace into runs (id, workspace_id, session_id, status, heartbeat_at, started_at, created_at, payload) values (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          payload.id,
          payload.workspaceId,
          payload.sessionId ?? null,
          payload.status,
          payload.heartbeatAt ?? null,
          payload.startedAt ?? null,
          payload.createdAt,
          serializeJson(payload)
        );
      }
    }

    if (tableExists(db, "legacy_run_steps")) {
      const rows = coerceRows<Record<string, unknown>>(db.prepare("select * from legacy_run_steps").all());
      for (const row of rows) {
        const payload: RunStep = {
          id: stringValue(row.id) ?? "",
          runId: stringValue(row.run_id) ?? "",
          seq: integerValue(row.seq) ?? 0,
          stepType: (stringValue(row.step_type) ?? "system") as RunStep["stepType"],
          status: (stringValue(row.status) ?? "completed") as RunStep["status"],
          ...(stringValue(row.name) ? { name: stringValue(row.name) } : {}),
          ...(stringValue(row.agent_name) ? { agentName: stringValue(row.agent_name) } : {}),
          ...(parseJsonish(row.input) !== undefined ? { input: parseJsonish(row.input) } : {}),
          ...(parseJsonish(row.output) !== undefined ? { output: parseJsonish(row.output) } : {}),
          ...(stringValue(row.started_at) ? { startedAt: stringValue(row.started_at) } : {}),
          ...(stringValue(row.ended_at) ? { endedAt: stringValue(row.ended_at) } : {})
        };

        db.prepare("insert or replace into run_steps (id, run_id, seq, payload) values (?, ?, ?, ?)")
          .run(payload.id, payload.runId, payload.seq, serializeJson(payload));
      }
    }

    if (tableExists(db, "legacy_tool_calls")) {
      const rows = coerceRows<Record<string, unknown>>(db.prepare("select * from legacy_tool_calls").all());
      for (const row of rows) {
        const payload: ToolCallAuditRecord = {
          id: stringValue(row.id) ?? "",
          runId: stringValue(row.run_id) ?? "",
          sourceType: (stringValue(row.source_type) ?? "tool") as ToolCallAuditRecord["sourceType"],
          toolName: stringValue(row.tool_name) ?? "unknown",
          status: (stringValue(row.status) ?? "completed") as ToolCallAuditRecord["status"],
          startedAt: stringValue(row.started_at) ?? nowIso(),
          endedAt: stringValue(row.ended_at) ?? nowIso(),
          ...(stringValue(row.step_id) ? { stepId: stringValue(row.step_id) } : {}),
          ...(parseJsonish(row.request) !== undefined ? { request: parseJsonish(row.request) as Record<string, unknown> } : {}),
          ...(parseJsonish(row.response) !== undefined ? { response: parseJsonish(row.response) as Record<string, unknown> } : {}),
          ...(integerValue(row.duration_ms) !== undefined ? { durationMs: integerValue(row.duration_ms) } : {})
        };

        db.prepare("insert or replace into tool_calls (id, run_id, started_at, payload) values (?, ?, ?, ?)")
          .run(payload.id, payload.runId, payload.startedAt, serializeJson(payload));
      }
    }

    if (tableExists(db, "legacy_hook_runs")) {
      const rows = coerceRows<Record<string, unknown>>(db.prepare("select * from legacy_hook_runs").all());
      for (const row of rows) {
        const payload: HookRunAuditRecord = {
          id: stringValue(row.id) ?? "",
          runId: stringValue(row.run_id) ?? "",
          hookName: stringValue(row.hook_name) ?? "unknown",
          eventName: stringValue(row.event_name) ?? "unknown",
          capabilities: (parseJsonish(row.capabilities) ?? []) as string[],
          status: (stringValue(row.status) ?? "completed") as HookRunAuditRecord["status"],
          startedAt: stringValue(row.started_at) ?? nowIso(),
          endedAt: stringValue(row.ended_at) ?? nowIso(),
          ...(parseJsonish(row.patch) !== undefined ? { patch: parseJsonish(row.patch) as Record<string, unknown> } : {}),
          ...(stringValue(row.error_message) ? { errorMessage: stringValue(row.error_message) } : {})
        };

        db.prepare("insert or replace into hook_runs (id, run_id, started_at, payload) values (?, ?, ?, ?)")
          .run(payload.id, payload.runId, payload.startedAt, serializeJson(payload));
      }
    }

    if (tableExists(db, "legacy_artifacts")) {
      const rows = coerceRows<Record<string, unknown>>(db.prepare("select * from legacy_artifacts").all());
      for (const row of rows) {
        const payload: ArtifactRecord = {
          id: stringValue(row.id) ?? "",
          runId: stringValue(row.run_id) ?? "",
          type: stringValue(row.type) ?? "unknown",
          createdAt: stringValue(row.created_at) ?? nowIso(),
          ...(stringValue(row.path) ? { path: stringValue(row.path) } : {}),
          ...(stringValue(row.content_ref) ? { contentRef: stringValue(row.content_ref) } : {}),
          ...(parseJsonish(row.metadata) !== undefined ? { metadata: parseJsonish(row.metadata) as Record<string, unknown> } : {})
        };

        db.prepare("insert or replace into artifacts (id, run_id, created_at, payload) values (?, ?, ?, ?)")
          .run(payload.id, payload.runId, payload.createdAt, serializeJson(payload));
      }
    }

    for (const tableName of legacyTables) {
      if (tableExists(db, `legacy_${tableName}`)) {
        db.exec(`drop table legacy_${tableName}`);
      }
    }

    applyPrimarySchema(db);
  });
}

function normalizePersistedWorkspaceData(db: DatabaseSync): void {
  runInTransaction(db, () => {
    const messageRows = coerceRows<WorkspaceMessageRow>(
      db.prepare("select session_id, payload from messages order by session_id asc, created_at asc, id asc").all()
    );
    const messageRowsBySession = new Map<string, Message[]>();

    for (const row of messageRows) {
      const parsed = parseJson<Message>(row.payload);
      const existing = messageRowsBySession.get(row.session_id);
      if (existing) {
        existing.push(parsed);
      } else {
        messageRowsBySession.set(row.session_id, [parsed]);
      }
    }

    for (const [sessionId, messages] of messageRowsBySession.entries()) {
      const normalized = normalizePersistedMessages(messages);
      if (!normalized.changed) {
        continue;
      }

      db.prepare("delete from messages where session_id = ?").run(sessionId);
      const insertStatement = db.prepare(
        "insert into messages (id, session_id, run_id, created_at, payload) values (?, ?, ?, ?, ?)"
      );
      for (const message of normalized.messages) {
        insertStatement.run(
          message.id,
          message.sessionId,
          message.runId ?? null,
          message.createdAt,
          serializeJson(message)
        );
      }
    }

    const runStepRows = coerceRows<WorkspaceRunStepRow>(db.prepare("select id, payload from run_steps").all());
    const updateRunStep = db.prepare("update run_steps set run_id = ?, seq = ?, payload = ? where id = ?");
    for (const row of runStepRows) {
      const normalized = normalizePersistedRunStep(parseJson<RunStep>(row.payload));
      if (!normalized.changed) {
        continue;
      }

      updateRunStep.run(
        normalized.step.runId,
        normalized.step.seq,
        serializeJson(normalized.step),
        normalized.step.id
      );
    }

    const historyRows = coerceRows<HistoryEventRow>(
      db.prepare("select id, workspace_id, entity_type, entity_id, op, payload, occurred_at from history_events").all()
    );
    const updateHistoryEvent = db.prepare("update history_events set payload = ? where id = ?");
    for (const row of historyRows) {
      if (row.entity_type === "message") {
        const normalized = normalizePersistedMessageRecord(parseJson<Message>(row.payload));
        if (normalized.changed) {
          updateHistoryEvent.run(serializeJson(normalized.message), row.id);
        }
        continue;
      }

      if (row.entity_type === "run_step") {
        const normalized = normalizePersistedRunStep(parseJson<RunStep>(row.payload));
        if (normalized.changed) {
          updateHistoryEvent.run(serializeJson(normalized.step), row.id);
        }
      }
    }
  });
}

function reconcilePersistedWorkspaceScope(db: DatabaseSync, workspace: Pick<WorkspaceRecord, "id" | "rootPath">): void {
  runInTransaction(db, () => {
    const workspaceMetaRows = coerceRows<Record<string, unknown>>(
      db.prepare("select id, root_path as rootPath from workspace_meta").all()
    );
    const deleteWorkspaceMeta = db.prepare("delete from workspace_meta where id = ?");
    const updateWorkspaceMeta = db.prepare("update workspace_meta set root_path = ? where id = ?");
    for (const row of workspaceMetaRows) {
      const rowId = stringValue(row.id);
      const rootPath = stringValue(row.rootPath);
      if (rowId && rowId !== workspace.id) {
        deleteWorkspaceMeta.run(rowId);
        continue;
      }

      if (rowId === workspace.id && rootPath !== workspace.rootPath) {
        updateWorkspaceMeta.run(workspace.rootPath, workspace.id);
      }
    }

    const sessionRows = coerceRows<WorkspaceScopedPayloadRow>(
      db.prepare("select id, workspace_id, payload from sessions").all()
    );
    const updateSession = db.prepare("update sessions set workspace_id = ?, payload = ? where id = ?");
    for (const row of sessionRows) {
      const payload = parseJson<Session>(row.payload);
      if (row.workspace_id === workspace.id && payload.workspaceId === workspace.id) {
        continue;
      }

      updateSession.run(
        workspace.id,
        serializeJson({
          ...payload,
          workspaceId: workspace.id
        }),
        row.id
      );
    }

    const runRows = coerceRows<WorkspaceScopedPayloadRow>(
      db.prepare("select id, workspace_id, payload from runs").all()
    );
    const updateRun = db.prepare("update runs set workspace_id = ?, payload = ? where id = ?");
    for (const row of runRows) {
      const payload = parseJson<Run>(row.payload);
      if (row.workspace_id === workspace.id && payload.workspaceId === workspace.id) {
        continue;
      }

      updateRun.run(
        workspace.id,
        serializeJson({
          ...payload,
          workspaceId: workspace.id
        }),
        row.id
      );
    }

    const historyRows = coerceRows<HistoryEventRow>(
      db.prepare("select id, workspace_id, entity_type, entity_id, op, payload, occurred_at from history_events").all()
    );
    const updateHistoryEvent = db.prepare("update history_events set workspace_id = ?, payload = ? where id = ?");
    for (const row of historyRows) {
      let nextPayload = row.payload;

      if (row.entity_type === "session") {
        const payload = parseJson<Session>(row.payload);
        if (payload.workspaceId !== workspace.id) {
          nextPayload = serializeJson({
            ...payload,
            workspaceId: workspace.id
          });
        }
      } else if (row.entity_type === "run") {
        const payload = parseJson<Run>(row.payload);
        if (payload.workspaceId !== workspace.id) {
          nextPayload = serializeJson({
            ...payload,
            workspaceId: workspace.id
          });
        }
      }

      if (row.workspace_id === workspace.id && nextPayload === row.payload) {
        continue;
      }

      updateHistoryEvent.run(workspace.id, nextPayload, row.id);
    }
  });
}

function runInTransaction(db: DatabaseSync, operation: () => void): void {
  db.exec("begin immediate");
  try {
    operation();
    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // Ignore rollback failures because the original error is more useful.
    }
    throw error;
  }
}

class SQLiteWorkspaceRepository implements WorkspaceRepository {
  readonly #items = new Map<string, WorkspaceRecord>();
  readonly #onUpsert: (workspace: WorkspaceRecord) => Promise<void>;
  readonly #onDelete: (workspaceId: string) => Promise<void>;

  constructor(options: {
    onUpsert: (workspace: WorkspaceRecord) => Promise<void>;
    onDelete: (workspaceId: string) => Promise<void>;
  }) {
    this.#onUpsert = options.onUpsert;
    this.#onDelete = options.onDelete;
  }

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    return this.upsert(input);
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.#items.set(input.id, input);
    await this.#onUpsert(input);
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
    this.#items.delete(id);
    await this.#onDelete(id);
  }
}

class SQLitePersistenceCoordinator {
  readonly #shadowRoot: string;
  readonly #workspaceRecords = new Map<string, WorkspaceRecord>();
  readonly #handles = new Map<string, DatabaseHandle>();
  readonly #sessionIndex = new Map<string, string>();
  readonly #runIndex = new Map<string, string>();

  constructor(shadowRoot: string) {
    this.#shadowRoot = shadowRoot;
  }

  async upsertWorkspace(workspace: WorkspaceRecord): Promise<void> {
    const existing = this.#handles.get(workspace.id);
    const nextDbPath = this.dbPathForWorkspace(workspace);
    if (existing && existing.dbPath !== nextDbPath) {
      existing.db.close();
      this.#handles.delete(workspace.id);
    }

    this.#workspaceRecords.set(workspace.id, workspace);
    const handle = await this.ensureHandle(workspace);
    handle.db
      .prepare(
        `insert into workspace_meta (id, root_path, kind, read_only, payload, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           root_path = excluded.root_path,
           kind = excluded.kind,
           read_only = excluded.read_only,
           payload = excluded.payload,
           updated_at = excluded.updated_at`
      )
      .run(
        workspace.id,
        workspace.rootPath,
        workspace.kind,
        workspace.readOnly ? 1 : 0,
        serializeJson(workspace),
        workspace.updatedAt
      );
    this.reindexWorkspace(handle.db, workspace.id);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.#workspaceRecords.get(workspaceId);
    this.#workspaceRecords.delete(workspaceId);
    this.deleteWorkspaceIndexes(workspaceId);

    const handle = this.#handles.get(workspaceId);
    if (handle) {
      handle.db.close();
      this.#handles.delete(workspaceId);
    }

    if (!workspace) {
      return;
    }

    const dbPath = this.dbPathForWorkspace(workspace);
    if (dbPath.startsWith(`${this.#shadowRoot}${path.sep}`) || dbPath === this.#shadowRoot) {
      await Promise.all([
        rm(path.dirname(dbPath), { recursive: true, force: true }),
        rm(`${dbPath}-shm`, { force: true }),
        rm(`${dbPath}-wal`, { force: true })
      ]);
    }
  }

  async close(): Promise<void> {
    for (const { db } of this.#handles.values()) {
      db.close();
    }
    this.#handles.clear();
  }

  async getWorkspaceHandle(workspaceId: string): Promise<DatabaseHandle> {
    const workspace = this.#workspaceRecords.get(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", `Workspace ${workspaceId} was not found.`);
    }

    return this.ensureHandle(workspace);
  }

  async getWorkspaceIdForSession(sessionId: string): Promise<string> {
    const indexed = this.#sessionIndex.get(sessionId);
    if (indexed) {
      return indexed;
    }

    for (const workspace of this.#workspaceRecords.values()) {
      const handle = await this.ensureHandle(workspace);
      const row = handle.db.prepare("select id from sessions where id = ? limit 1").get(sessionId) as IdRow | undefined;
      if (row?.id) {
        this.#sessionIndex.set(sessionId, workspace.id);
        return workspace.id;
      }
    }

    throw new AppError(404, "session_not_found", `Session ${sessionId} was not found.`);
  }

  async getWorkspaceIdForRun(runId: string): Promise<string> {
    const indexed = this.#runIndex.get(runId);
    if (indexed) {
      return indexed;
    }

    for (const workspace of this.#workspaceRecords.values()) {
      const handle = await this.ensureHandle(workspace);
      const row = handle.db.prepare("select id from runs where id = ? limit 1").get(runId) as IdRow | undefined;
      if (row?.id) {
        this.#runIndex.set(runId, workspace.id);
        return workspace.id;
      }
    }

    throw new AppError(404, "run_not_found", `Run ${runId} was not found.`);
  }

  async getSessionHandle(sessionId: string): Promise<DatabaseHandle> {
    return this.getWorkspaceHandle(await this.getWorkspaceIdForSession(sessionId));
  }

  async getRunHandle(runId: string): Promise<DatabaseHandle> {
    return this.getWorkspaceHandle(await this.getWorkspaceIdForRun(runId));
  }

  async listWorkspaceSnapshots(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]> {
    const snapshots: WorkspaceRecord[] = [];

    for (const workspace of candidates) {
      const dbPath = this.dbPathForWorkspace(workspace);
      try {
        const db = new DatabaseSync(dbPath);
        try {
          for (const statement of schemaStatements) {
            db.exec(statement);
          }
          const row = db
            .prepare("select payload from workspace_meta where id = ? limit 1")
            .get(workspace.id) as JsonRow | undefined;
          if (row?.payload) {
            snapshots.push(parseJson<WorkspaceRecord>(row.payload));
          }
        } finally {
          db.close();
        }
      } catch {
        // Ignore missing or invalid SQLite files and treat the workspace as fresh.
      }
    }

    return snapshots;
  }

  dbPathForWorkspace(workspace: Pick<WorkspaceRecord, "id" | "kind" | "readOnly" | "rootPath">): string {
    if (workspace.kind === "project" && !workspace.readOnly) {
      return defaultProjectDbPath(workspace);
    }

    return shadowDbPath(this.#shadowRoot, workspace.id);
  }

  async ensureHandle(workspace: WorkspaceRecord): Promise<DatabaseHandle> {
    const dbPath = this.dbPathForWorkspace(workspace);
    const cached = this.#handles.get(workspace.id);
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
    migrateLegacyMirrorSchemaIfNeeded(db);
    reconcilePersistedWorkspaceScope(db, workspace);
    normalizePersistedWorkspaceData(db);
    const handle = { dbPath, db };
    this.#handles.set(workspace.id, handle);
    this.reindexWorkspace(db, workspace.id);
    return handle;
  }

  reindexWorkspace(db: DatabaseSync, workspaceId: string): void {
    this.deleteWorkspaceIndexes(workspaceId);

    const sessionRows = coerceRows<IdRow>(db.prepare("select id from sessions where workspace_id = ?").all(workspaceId));
    for (const row of sessionRows) {
      this.#sessionIndex.set(row.id, workspaceId);
    }

    const runRows = coerceRows<IdRow>(db.prepare("select id from runs where workspace_id = ?").all(workspaceId));
    for (const row of runRows) {
      this.#runIndex.set(row.id, workspaceId);
    }
  }

  deleteWorkspaceIndexes(workspaceId: string): void {
    for (const [sessionId, indexedWorkspaceId] of this.#sessionIndex.entries()) {
      if (indexedWorkspaceId === workspaceId) {
        this.#sessionIndex.delete(sessionId);
      }
    }

    for (const [runId, indexedWorkspaceId] of this.#runIndex.entries()) {
      if (indexedWorkspaceId === workspaceId) {
        this.#runIndex.delete(runId);
      }
    }
  }

  indexSession(sessionId: string, workspaceId: string): void {
    this.#sessionIndex.set(sessionId, workspaceId);
  }

  forgetSession(sessionId: string): void {
    this.#sessionIndex.delete(sessionId);
  }

  indexRun(runId: string, workspaceId: string): void {
    this.#runIndex.set(runId, workspaceId);
  }
}

class SQLiteSessionRepository implements SessionRepository {
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
    this.#coordinator.indexSession(input.id, input.workspaceId);
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
    this.#coordinator.indexSession(input.id, input.workspaceId);
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
    const handle = await this.#coordinator.getSessionHandle(id);
    runInTransaction(handle.db, () => {
      handle.db.prepare("delete from messages where session_id = ?").run(id);
      handle.db.prepare("delete from sessions where id = ?").run(id);
    });
    this.#coordinator.forgetSession(id);
  }
}

class SQLiteMessageRepository implements MessageRepository {
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
    return input;
  }

  async getById(id: string): Promise<Message | null> {
    for (const workspace of await this.listKnownWorkspaces()) {
      const handle = await this.#coordinator.getWorkspaceHandle(workspace.id);
      const row = handle.db.prepare("select payload from messages where id = ? limit 1").get(id) as JsonRow | undefined;
      if (row?.payload) {
        return parseJson<Message>(row.payload);
      }
    }
    return null;
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
    const items: WorkspaceRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.workspaceRepository.list(100, cursor);
      items.push(...page);
      cursor = page.length === 100 ? String(parseCursor(cursor) + 100) : undefined;
    } while (cursor);
    return items;
  }

  workspaceRepository!: WorkspaceRepository;
}

class SQLiteRunRepository implements RunRepository {
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
        .run(
          input.id,
          input.workspaceId,
          input.sessionId ?? null,
          input.status,
          input.heartbeatAt ?? null,
          input.startedAt ?? null,
          input.createdAt,
          serializeJson(input)
        );
      appendHistoryEvent(handle.db, {
        workspaceId: input.workspaceId,
        entityType: "run",
        entityId: input.id,
        op: "upsert",
        payload: input as Record<string, unknown>,
        occurredAt: nowIso()
      });
    });
    this.#coordinator.indexRun(input.id, input.workspaceId);
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
        .run(
          input.sessionId ?? null,
          input.status,
          input.heartbeatAt ?? null,
          input.startedAt ?? null,
          input.createdAt,
          serializeJson(input),
          input.id
        );
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
    this.#coordinator.indexRun(input.id, input.workspaceId);
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
    const runs: Run[] = [];
    for (const workspace of await this.listKnownWorkspaces()) {
      const handle = await this.#coordinator.getWorkspaceHandle(workspace.id);
      const rows = coerceRows<JsonRow>(
        handle.db
          .prepare(
            `select payload from runs
             where status in ('running', 'waiting_tool')
               and coalesce(heartbeat_at, started_at, created_at) <= ?
             order by coalesce(heartbeat_at, started_at, created_at) asc, id asc
             limit ?`
          )
          .all(staleBefore, Math.max(1, limit))
      );
      runs.push(...rows.map((row) => parseJson<Run>(row.payload)));
    }

    return runs
      .sort((left, right) => {
        const leftTimestamp = left.heartbeatAt ?? left.startedAt ?? left.createdAt;
        const rightTimestamp = right.heartbeatAt ?? right.startedAt ?? right.createdAt;
        return leftTimestamp.localeCompare(rightTimestamp) || left.id.localeCompare(right.id);
      })
      .slice(0, Math.max(1, limit));
  }

  async listKnownWorkspaces(): Promise<WorkspaceRecord[]> {
    const items: WorkspaceRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.workspaceRepository.list(100, cursor);
      items.push(...page);
      cursor = page.length === 100 ? String(parseCursor(cursor) + 100) : undefined;
    } while (cursor);
    return items;
  }

  workspaceRepository!: WorkspaceRepository;
}

class SQLiteRunStepRepository implements RunStepRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: RunStep): Promise<RunStep> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare("insert into run_steps (id, run_id, seq, payload) values (?, ?, ?, ?)")
        .run(input.id, input.runId, input.seq, serializeJson(input));
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
      const result = handle.db
        .prepare("update run_steps set run_id = ?, seq = ?, payload = ? where id = ?")
        .run(input.runId, input.seq, serializeJson(input), input.id);
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
    const rows = coerceRows<JsonRow>(
      handle.db.prepare("select payload from run_steps where run_id = ? order by seq asc, id asc").all(runId)
    );
    return rows.map((row) => parseJson<RunStep>(row.payload));
  }
}

class SQLiteSessionEventStore implements SessionEventStore {
  readonly #coordinator: SQLitePersistenceCoordinator;
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const handle = await this.#coordinator.getSessionHandle(input.sessionId);
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
        .prepare(
          "insert into session_events (id, session_id, run_id, cursor, created_at, payload) values (?, ?, ?, ?, ?, ?)"
        )
        .run(
          created.id,
          created.sessionId,
          created.runId ?? null,
          nextCursor,
          created.createdAt,
          serializeJson(created)
        );
    });

    const event = created!;
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

class SQLiteToolCallAuditRepository implements ToolCallAuditRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare("insert into tool_calls (id, run_id, started_at, payload) values (?, ?, ?, ?)")
        .run(input.id, input.runId, input.startedAt, serializeJson(input));
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

class SQLiteHookRunAuditRepository implements HookRunAuditRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare("insert into hook_runs (id, run_id, started_at, payload) values (?, ?, ?, ?)")
        .run(input.id, input.runId, input.startedAt, serializeJson(input));
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

class SQLiteArtifactRepository implements ArtifactRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare("insert into artifacts (id, run_id, created_at, payload) values (?, ?, ?, ?)")
        .run(input.id, input.runId, input.createdAt, serializeJson(input));
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
    const rows = coerceRows<JsonRow>(
      handle.db.prepare("select payload from artifacts where run_id = ? order by created_at asc, id asc").all(runId)
    );
    return rows.map((row) => parseJson<ArtifactRecord>(row.payload));
  }
}

class SQLiteHistoryEventRepository implements HistoryEventRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    let created: HistoryEventRecord | undefined;
    runInTransaction(handle.db, () => {
      const result = handle.db
        .prepare(
          "insert into history_events (workspace_id, entity_type, entity_id, op, payload, occurred_at) values (?, ?, ?, ?, ?, ?)"
        )
        .run(
          input.workspaceId,
          input.entityType,
          input.entityId,
          input.op,
          serializeJson(input.payload),
          input.occurredAt
        );
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

function appendHistoryEvent(db: DatabaseSync, input: Omit<HistoryEventRecord, "id">): void {
  db.prepare(
    "insert into history_events (workspace_id, entity_type, entity_id, op, payload, occurred_at) values (?, ?, ?, ?, ?, ?)"
  ).run(
    input.workspaceId,
    input.entityType,
    input.entityId,
    input.op,
    serializeJson(input.payload),
    input.occurredAt
  );
}

export interface SQLiteRuntimePersistence {
  driver: "sqlite";
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  toolCallAuditRepository: ToolCallAuditRepository;
  hookRunAuditRepository: HookRunAuditRepository;
  artifactRepository: ArtifactRepository;
  historyEventRepository: HistoryEventRepository;
  listWorkspaceSnapshots(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]>;
  close(): Promise<void>;
}

export interface CreateSQLiteRuntimePersistenceOptions {
  shadowRoot: string;
}

export function sqliteWorkspaceHistoryDbPath(
  workspace: Pick<WorkspaceRecord, "id" | "kind" | "readOnly" | "rootPath">,
  options: CreateSQLiteRuntimePersistenceOptions
): string {
  if (workspace.kind === "project" && !workspace.readOnly) {
    return defaultProjectDbPath(workspace);
  }

  return shadowDbPath(options.shadowRoot, workspace.id);
}

export async function createSQLiteRuntimePersistence(
  options: CreateSQLiteRuntimePersistenceOptions
): Promise<SQLiteRuntimePersistence> {
  const coordinator = new SQLitePersistenceCoordinator(options.shadowRoot);
  const workspaceRepository = new SQLiteWorkspaceRepository({
    onUpsert: async (workspace) => {
      await coordinator.upsertWorkspace(workspace);
    },
    onDelete: async (workspaceId) => {
      await coordinator.deleteWorkspace(workspaceId);
    }
  });
  const sessionRepository = new SQLiteSessionRepository(coordinator);
  const messageRepository = new SQLiteMessageRepository(coordinator);
  const runRepository = new SQLiteRunRepository(coordinator);
  const runStepRepository = new SQLiteRunStepRepository(coordinator);
  const sessionEventStore = new SQLiteSessionEventStore(coordinator);
  const toolCallAuditRepository = new SQLiteToolCallAuditRepository(coordinator);
  const hookRunAuditRepository = new SQLiteHookRunAuditRepository(coordinator);
  const artifactRepository = new SQLiteArtifactRepository(coordinator);
  const historyEventRepository = new SQLiteHistoryEventRepository(coordinator);

  messageRepository.workspaceRepository = workspaceRepository;
  runRepository.workspaceRepository = workspaceRepository;

  return {
    driver: "sqlite",
    workspaceRepository,
    sessionRepository,
    messageRepository,
    runRepository,
    runStepRepository,
    sessionEventStore,
    toolCallAuditRepository,
    hookRunAuditRepository,
    artifactRepository,
    historyEventRepository,
    listWorkspaceSnapshots(candidates) {
      return coordinator.listWorkspaceSnapshots(candidates);
    },
    close() {
      return coordinator.close();
    }
  };
}
