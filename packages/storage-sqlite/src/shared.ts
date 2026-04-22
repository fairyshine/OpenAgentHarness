import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRecord,
  HistoryEventRecord,
  HookRunAuditRecord,
  Message,
  Run,
  RunStep,
  Session,
  ToolCallAuditRecord,
  WorkspaceRecord
} from "@oah/engine-core";
import {
  isMessageContentForRole,
  isMessageRole,
  normalizePersistedMessageRecord,
  normalizePersistedMessages,
  normalizePersistedRunStep,
  nowIso
} from "@oah/engine-core";

export interface DatabaseHandle {
  dbPath: string;
  db: DatabaseSync;
}

export interface JsonRow {
  payload: string;
}

export interface IdRow {
  id: string;
}

export interface WorkspaceMessageRow {
  session_id: string;
  payload: string;
}

export interface WorkspaceScopedPayloadRow {
  id: string;
  workspace_id: string;
  payload: string;
}

export interface WorkspaceRunStepRow {
  id: string;
  payload: string;
}

export interface CursorRow {
  maxCursor: number | null;
}

export interface HistoryEventRow {
  id: number;
  workspace_id: string;
  entity_type: HistoryEventRecord["entityType"];
  entity_id: string;
  op: HistoryEventRecord["op"];
  payload: string;
  occurred_at: string;
}

export interface TableInfoRow {
  name: string;
}

export interface RegistryWorkspaceRow {
  payload: string;
}

export interface RegistryWorkspaceIdRow {
  workspaceId: string;
}

export interface MessageRegistryEntryRow {
  id: string;
}

export interface SessionEventRegistryEntryRow {
  id: string;
}

export interface RunRegistryEntryRow {
  id: string;
  status: Run["status"];
  heartbeat_at: string | null;
  started_at: string | null;
  created_at: string;
}

export interface RecoverableRunRegistryRow {
  id: string;
}

export const schemaStatements = [
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
  `create table if not exists runtime_messages (
    id text primary key,
    session_id text not null,
    run_id text,
    created_at text not null,
    payload text not null
  )`,
  `create index if not exists runtime_messages_session_created_idx on runtime_messages (session_id, created_at asc, id asc)`,
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
  `create table if not exists session_pending_runs (
    run_id text primary key,
    session_id text not null,
    position integer not null,
    created_at text not null
  )`,
  `create index if not exists session_pending_runs_session_position_idx on session_pending_runs (session_id, position asc, created_at asc, run_id asc)`,
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

export const registrySchemaStatements = [
  `create table if not exists workspace_registry (
    kind text not null,
    root_path text not null,
    id text not null,
    payload text not null,
    updated_at text not null,
    primary key (kind, root_path)
  )`,
  `create unique index if not exists workspace_registry_id_idx on workspace_registry (id)`,
  `create index if not exists workspace_registry_updated_idx on workspace_registry (updated_at desc, id asc)`,
  `create table if not exists session_registry (
    id text primary key,
    workspace_id text not null,
    updated_at text not null
  )`,
  `create index if not exists session_registry_workspace_idx on session_registry (workspace_id, updated_at desc, id asc)`,
  `create table if not exists message_registry (
    id text primary key,
    workspace_id text not null,
    updated_at text not null
  )`,
  `create index if not exists message_registry_workspace_idx on message_registry (workspace_id, updated_at desc, id asc)`,
  `create table if not exists session_event_registry (
    id text primary key,
    workspace_id text not null,
    updated_at text not null
  )`,
  `create index if not exists session_event_registry_workspace_idx on session_event_registry (workspace_id, updated_at desc, id asc)`,
  `create table if not exists run_registry (
    id text primary key,
    workspace_id text not null,
    status text,
    recover_at text,
    updated_at text not null
  )`,
  `create index if not exists run_registry_workspace_idx on run_registry (workspace_id, updated_at desc, id asc)`,
  `create index if not exists run_registry_recoverable_idx on run_registry (status, recover_at, id asc)`
];

export function defaultProjectDbPath(workspace: Pick<WorkspaceRecord, "rootPath">): string {
  return path.join(workspace.rootPath, ".openharness", "data", "history.db");
}

export function shadowDbPath(shadowRoot: string, workspaceId: string): string {
  return path.join(shadowRoot, workspaceId, "history.db");
}

export function shouldPersistProjectDbInsideWorkspace(
  workspace: Pick<WorkspaceRecord, "kind" | "readOnly" | "rootPath">
): boolean {
  if (workspace.kind !== "project" || workspace.readOnly) {
    return false;
  }

  const normalizedRootPath = workspace.rootPath.replaceAll("\\", "/");
  if (normalizedRootPath === "/workspace" || normalizedRootPath.startsWith("/workspace/")) {
    return false;
  }

  if (normalizedRootPath === "/__oah_sandbox__" || normalizedRootPath.startsWith("/__oah_sandbox__/")) {
    return false;
  }

  return true;
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function coerceRows<T>(value: unknown): T[] {
  return value as T[];
}

export function parseJsonish(value: unknown): unknown {
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

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("select name from sqlite_master where type = 'table' and name = ? limit 1")
    .get(tableName) as TableInfoRow | undefined;
  return Boolean(row?.name);
}

export function parseLegacyMessage(row: Record<string, unknown>): Message {
  const roleValue = stringValue(row.role);
  const role: Message["role"] = isMessageRole(roleValue) ? roleValue : "assistant";
  const content = parseJsonish(row.content);
  const metadata = parseJsonish(row.metadata);
  const base = {
    id: stringValue(row.id) ?? "",
    sessionId: stringValue(row.session_id) ?? "",
    createdAt: stringValue(row.created_at) ?? nowIso(),
    ...(stringValue(row.run_id) ? { runId: stringValue(row.run_id) } : {}),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {})
  };

  switch (role) {
    case "system":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, content) ? content : ""
      };
    case "user":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, content) ? content : ""
      };
    case "assistant":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, content) ? content : ""
      };
    case "tool":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, content) ? content : []
      };
  }
}

export function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const rows = coerceRows<{ name?: unknown }>(db.prepare(`pragma table_info(${tableName})`).all());
  return rows.some((row) => row.name === columnName);
}

export function applyPrimarySchema(db: DatabaseSync): void {
  for (const statement of schemaStatements) {
    db.exec(statement);
  }
}

export function migrateLegacyMirrorSchemaIfNeeded(db: DatabaseSync): void {
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
        const payload = parseLegacyMessage(row);

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

export function normalizePersistedWorkspaceData(db: DatabaseSync): void {
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
        insertStatement.run(message.id, message.sessionId, message.runId ?? null, message.createdAt, serializeJson(message));
      }
    }

    const runStepRows = coerceRows<WorkspaceRunStepRow>(db.prepare("select id, payload from run_steps").all());
    const updateRunStep = db.prepare("update run_steps set run_id = ?, seq = ?, payload = ? where id = ?");
    for (const row of runStepRows) {
      const normalized = normalizePersistedRunStep(parseJson<RunStep>(row.payload));
      if (!normalized.changed) {
        continue;
      }

      updateRunStep.run(normalized.step.runId, normalized.step.seq, serializeJson(normalized.step), normalized.step.id);
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

export function reconcilePersistedWorkspaceScope(db: DatabaseSync, workspace: Pick<WorkspaceRecord, "id" | "rootPath">): void {
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

    const sessionRows = coerceRows<WorkspaceScopedPayloadRow>(db.prepare("select id, workspace_id, payload from sessions").all());
    const updateSession = db.prepare("update sessions set workspace_id = ?, payload = ? where id = ?");
    for (const row of sessionRows) {
      const payload = parseJson<Session>(row.payload);
      if (row.workspace_id === workspace.id && payload.workspaceId === workspace.id) {
        continue;
      }

      updateSession.run(workspace.id, serializeJson({ ...payload, workspaceId: workspace.id }), row.id);
    }

    const runRows = coerceRows<WorkspaceScopedPayloadRow>(db.prepare("select id, workspace_id, payload from runs").all());
    const updateRun = db.prepare("update runs set workspace_id = ?, payload = ? where id = ?");
    for (const row of runRows) {
      const payload = parseJson<Run>(row.payload);
      if (row.workspace_id === workspace.id && payload.workspaceId === workspace.id) {
        continue;
      }

      updateRun.run(workspace.id, serializeJson({ ...payload, workspaceId: workspace.id }), row.id);
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
          nextPayload = serializeJson({ ...payload, workspaceId: workspace.id });
        }
      } else if (row.entity_type === "run") {
        const payload = parseJson<Run>(row.payload);
        if (payload.workspaceId !== workspace.id) {
          nextPayload = serializeJson({ ...payload, workspaceId: workspace.id });
        }
      }

      if (row.workspace_id === workspace.id && nextPayload === row.payload) {
        continue;
      }

      updateHistoryEvent.run(workspace.id, nextPayload, row.id);
    }
  });
}

export function runInTransaction(db: DatabaseSync, operation: () => void): void {
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

export function appendHistoryEvent(db: DatabaseSync, input: Omit<HistoryEventRecord, "id">): void {
  db.prepare(
    "insert into history_events (workspace_id, entity_type, entity_id, op, payload, occurred_at) values (?, ?, ?, ?, ?, ?)"
  ).run(input.workspaceId, input.entityType, input.entityId, input.op, serializeJson(input.payload), input.occurredAt);
}

export function appendHistoryDeleteEvents(
  db: DatabaseSync,
  workspaceId: string,
  entities: Array<{ entityType: HistoryEventRecord["entityType"]; entityId: string }>,
  occurredAt: string
): void {
  for (const entity of entities) {
    appendHistoryEvent(db, {
      workspaceId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      op: "delete",
      payload: {},
      occurredAt
    });
  }
}
