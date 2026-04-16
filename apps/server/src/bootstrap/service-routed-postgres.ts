import type { Pool } from "pg";

import { AppError } from "@oah/runtime-core";
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
  RuntimeMessage,
  RuntimeMessageRepository,
  Session,
  SessionEvent,
  SessionEventStore,
  SessionRepository,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceArchiveRecord,
  WorkspaceArchiveRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/runtime-core";
import {
  createPostgresRuntimePersistence,
  type CreatePostgresRuntimePersistenceOptions,
  type PostgresRuntimePersistence
} from "@oah/storage-postgres";

interface RecordRow extends Record<string, unknown> {}

interface WorkspaceRegistryEntry {
  workspaceId: string;
  serviceName?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceRoutedPostgresRuntimePersistence {
  pool: PostgresRuntimePersistence["pool"];
  workspaceRepository: WorkspaceRepository;
  workspaceArchiveRepository: WorkspaceArchiveRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runtimeMessageRepository: RuntimeMessageRepository;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  toolCallAuditRepository: ToolCallAuditRepository;
  hookRunAuditRepository: HookRunAuditRepository;
  artifactRepository: ArtifactRepository;
  historyEventRepository: HistoryEventRepository;
  close(): Promise<void>;
}

interface PostgresPersistenceFactory {
  (options: CreatePostgresRuntimePersistenceOptions): Promise<PostgresRuntimePersistence>;
}

export interface CreateServiceRoutedPostgresRuntimePersistenceOptions {
  connectionString: string;
  persistenceFactory?: PostgresPersistenceFactory | undefined;
}

function normalizeServiceName(serviceName: string | undefined): string | undefined {
  const normalized = serviceName?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function assertDatabaseName(pathname: string): string {
  const databaseName = decodeURIComponent(pathname.replace(/^\/+/, ""));
  if (!databaseName) {
    throw new Error("PostgreSQL connection string must include a database name to enable service routing.");
  }

  return databaseName;
}

function rowString(row: RecordRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalRowString(row: RecordRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalRowNumber(row: RecordRow, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = trimmed
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/u, "$1:00")
    .replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function toWorkspaceRegistryEntry(row: RecordRow): WorkspaceRegistryEntry {
  return {
    workspaceId: rowString(row, "workspace_id"),
    ...(normalizeServiceName(optionalRowString(row, "service_name"))
      ? { serviceName: normalizeServiceName(optionalRowString(row, "service_name")) }
      : {}),
    createdAt: normalizeTimestamp(rowString(row, "created_at")) ?? rowString(row, "created_at"),
    updatedAt: normalizeTimestamp(rowString(row, "updated_at")) ?? rowString(row, "updated_at")
  };
}

function toSessionRegistryEntry(row: RecordRow): Session {
  return {
    id: rowString(row, "id"),
    workspaceId: rowString(row, "workspace_id"),
    subjectRef: rowString(row, "subject_ref"),
    ...(optionalRowString(row, "model_ref") ? { modelRef: rowString(row, "model_ref") } : {}),
    ...(optionalRowString(row, "agent_name") ? { agentName: rowString(row, "agent_name") } : {}),
    activeAgentName: rowString(row, "active_agent_name"),
    ...(optionalRowString(row, "title") ? { title: rowString(row, "title") } : {}),
    status: rowString(row, "status") as Session["status"],
    ...(optionalRowString(row, "last_run_at")
      ? { lastRunAt: normalizeTimestamp(rowString(row, "last_run_at")) ?? rowString(row, "last_run_at") }
      : {}),
    createdAt: normalizeTimestamp(rowString(row, "created_at")) ?? rowString(row, "created_at"),
    updatedAt: normalizeTimestamp(rowString(row, "updated_at")) ?? rowString(row, "updated_at")
  };
}

function toRunRegistryEntry(row: RecordRow): Run {
  return {
    id: rowString(row, "id"),
    workspaceId: rowString(row, "workspace_id"),
    ...(optionalRowString(row, "session_id") ? { sessionId: rowString(row, "session_id") } : {}),
    ...(optionalRowString(row, "parent_run_id") ? { parentRunId: rowString(row, "parent_run_id") } : {}),
    ...(optionalRowString(row, "initiator_ref") ? { initiatorRef: rowString(row, "initiator_ref") } : {}),
    triggerType: rowString(row, "trigger_type") as Run["triggerType"],
    ...(optionalRowString(row, "trigger_ref") ? { triggerRef: rowString(row, "trigger_ref") } : {}),
    ...(optionalRowString(row, "agent_name") ? { agentName: rowString(row, "agent_name") } : {}),
    effectiveAgentName: rowString(row, "effective_agent_name"),
    ...(optionalRowNumber(row, "switch_count") !== undefined ? { switchCount: optionalRowNumber(row, "switch_count") } : {}),
    status: rowString(row, "status") as Run["status"],
    ...(optionalRowString(row, "cancel_requested_at")
      ? { cancelRequestedAt: normalizeTimestamp(rowString(row, "cancel_requested_at")) ?? rowString(row, "cancel_requested_at") }
      : {}),
    ...(optionalRowString(row, "started_at") ? { startedAt: normalizeTimestamp(rowString(row, "started_at")) ?? rowString(row, "started_at") } : {}),
    ...(optionalRowString(row, "heartbeat_at")
      ? { heartbeatAt: normalizeTimestamp(rowString(row, "heartbeat_at")) ?? rowString(row, "heartbeat_at") }
      : {}),
    ...(optionalRowString(row, "ended_at") ? { endedAt: normalizeTimestamp(rowString(row, "ended_at")) ?? rowString(row, "ended_at") } : {}),
    ...(optionalRowString(row, "error_code") ? { errorCode: rowString(row, "error_code") } : {}),
    ...(optionalRowString(row, "error_message") ? { errorMessage: rowString(row, "error_message") } : {}),
    ...(row.metadata !== undefined && row.metadata !== null ? { metadata: row.metadata as Run["metadata"] } : {}),
    createdAt: normalizeTimestamp(rowString(row, "created_at")) ?? rowString(row, "created_at")
  };
}

async function ensureServiceRoutingRegistrySchema(pool: Pool): Promise<void> {
  const statements = [
    `create table if not exists workspace_registry (
      workspace_id text primary key,
      service_name text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )`,
    `create index if not exists workspace_registry_service_name_idx on workspace_registry (service_name)`,
    `create index if not exists workspace_registry_updated_idx on workspace_registry (updated_at desc, created_at desc, workspace_id asc)`,
    `create table if not exists session_registry (
      id text primary key,
      workspace_id text not null,
      service_name text,
      subject_ref text not null,
      model_ref text,
      agent_name text,
      active_agent_name text not null,
      title text,
      status text not null,
      last_run_at timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )`,
    `create index if not exists session_registry_workspace_idx on session_registry (workspace_id, updated_at desc, created_at desc, id asc)`,
    `create index if not exists session_registry_service_name_idx on session_registry (service_name)`,
    `create table if not exists run_registry (
      id text primary key,
      workspace_id text not null,
      session_id text,
      service_name text,
      parent_run_id text,
      initiator_ref text,
      trigger_type text not null,
      trigger_ref text,
      agent_name text,
      effective_agent_name text not null,
      switch_count integer,
      status text not null,
      cancel_requested_at timestamptz,
      started_at timestamptz,
      heartbeat_at timestamptz,
      ended_at timestamptz,
      error_code text,
      error_message text,
      metadata jsonb,
      created_at timestamptz not null
    )`,
    `create index if not exists run_registry_session_idx on run_registry (session_id, created_at desc, id desc)`,
    `create index if not exists run_registry_workspace_idx on run_registry (workspace_id, created_at desc, id desc)`,
    `create index if not exists run_registry_recoverable_idx on run_registry (status, heartbeat_at, started_at, created_at)`
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }
}

async function migrateServiceRoutingRegistry(pool: Pool): Promise<void> {
  await pool.query(
    `insert into workspace_registry (workspace_id, service_name, created_at, updated_at)
     select
       w.id,
       nullif(lower(btrim(w.service_name)), ''),
       w.created_at,
       w.updated_at
     from workspaces w
     on conflict (workspace_id) do update set
       service_name = excluded.service_name,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`
  );
  await pool.query(
    `insert into session_registry (
       id,
       workspace_id,
       service_name,
       subject_ref,
       model_ref,
       agent_name,
       active_agent_name,
       title,
       status,
       last_run_at,
       created_at,
       updated_at
     )
     select
       s.id,
       s.workspace_id,
       nullif(lower(btrim(w.service_name)), ''),
       s.subject_ref,
       s.model_ref,
       s.agent_name,
       s.active_agent_name,
       s.title,
       s.status,
       s.last_run_at,
       s.created_at,
       s.updated_at
     from sessions s
     join workspaces w on w.id = s.workspace_id
     on conflict (id) do update set
       workspace_id = excluded.workspace_id,
       service_name = excluded.service_name,
       subject_ref = excluded.subject_ref,
       model_ref = excluded.model_ref,
       agent_name = excluded.agent_name,
       active_agent_name = excluded.active_agent_name,
       title = excluded.title,
       status = excluded.status,
       last_run_at = excluded.last_run_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`
  );
  await pool.query(
    `insert into run_registry (
       id,
       workspace_id,
       session_id,
       service_name,
       parent_run_id,
       initiator_ref,
       trigger_type,
       trigger_ref,
       agent_name,
       effective_agent_name,
       switch_count,
       status,
       cancel_requested_at,
       started_at,
       heartbeat_at,
       ended_at,
       error_code,
       error_message,
       metadata,
       created_at
     )
     select
       r.id,
       r.workspace_id,
       r.session_id,
       nullif(lower(btrim(w.service_name)), ''),
       r.parent_run_id,
       r.initiator_ref,
       r.trigger_type,
       r.trigger_ref,
       r.agent_name,
       r.effective_agent_name,
       r.switch_count,
       r.status,
       r.cancel_requested_at,
       r.started_at,
       r.heartbeat_at,
       r.ended_at,
       r.error_code,
       r.error_message,
       r.metadata,
       r.created_at
     from runs r
     join workspaces w on w.id = r.workspace_id
     on conflict (id) do update set
       workspace_id = excluded.workspace_id,
       session_id = excluded.session_id,
       service_name = excluded.service_name,
       parent_run_id = excluded.parent_run_id,
       initiator_ref = excluded.initiator_ref,
       trigger_type = excluded.trigger_type,
       trigger_ref = excluded.trigger_ref,
       agent_name = excluded.agent_name,
       effective_agent_name = excluded.effective_agent_name,
       switch_count = excluded.switch_count,
       status = excluded.status,
       cancel_requested_at = excluded.cancel_requested_at,
       started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at,
       ended_at = excluded.ended_at,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       metadata = excluded.metadata,
       created_at = excluded.created_at`
  );
  await pool.query(`delete from workspaces where nullif(lower(btrim(service_name)), '') is not null`);
}

class PostgresServiceRoutingRegistry {
  constructor(private readonly pool: Pool) {}

  async getWorkspace(workspaceId: string): Promise<WorkspaceRegistryEntry | null> {
    const result = await this.pool.query(
      `select workspace_id, service_name, created_at::text, updated_at::text
       from workspace_registry
       where workspace_id = $1
       limit 1`,
      [workspaceId]
    );

    return result.rows[0] ? toWorkspaceRegistryEntry(result.rows[0] as RecordRow) : null;
  }

  async listWorkspaces(pageSize: number, cursor?: string): Promise<WorkspaceRegistryEntry[]> {
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const result = await this.pool.query(
      `select workspace_id, service_name, created_at::text, updated_at::text
       from workspace_registry
       order by updated_at desc, created_at desc, workspace_id asc
       limit $1 offset $2`,
      [pageSize, Number.isFinite(offset) && offset > 0 ? offset : 0]
    );

    return result.rows.map((row) => toWorkspaceRegistryEntry(row as RecordRow));
  }

  async upsertWorkspace(input: {
    workspaceId: string;
    serviceName?: string | undefined;
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `insert into workspace_registry (workspace_id, service_name, created_at, updated_at)
       values ($1, $2, $3, $4)
       on conflict (workspace_id) do update set
         service_name = excluded.service_name,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [input.workspaceId, normalizeServiceName(input.serviceName) ?? null, input.createdAt, input.updatedAt]
    );
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.pool.query(`delete from run_registry where workspace_id = $1`, [workspaceId]);
    await this.pool.query(`delete from session_registry where workspace_id = $1`, [workspaceId]);
    await this.pool.query(`delete from workspace_registry where workspace_id = $1`, [workspaceId]);
  }

  async listKnownServiceNames(): Promise<string[]> {
    const result = await this.pool.query(
      `select distinct service_name
       from workspace_registry
       where service_name is not null
       order by service_name asc`
    );
    return result.rows.map((row) => rowString(row as RecordRow, "service_name"));
  }

  async getSession(sessionId: string): Promise<(Session & { serviceName?: string | undefined }) | null> {
    const result = await this.pool.query(
      `select
         id,
         workspace_id,
         service_name,
         subject_ref,
         model_ref,
         agent_name,
         active_agent_name,
         title,
         status,
         last_run_at::text,
         created_at::text,
         updated_at::text
       from session_registry
       where id = $1
       limit 1`,
      [sessionId]
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0] as RecordRow;
    return {
      ...toSessionRegistryEntry(row),
      ...(normalizeServiceName(optionalRowString(row, "service_name"))
        ? { serviceName: normalizeServiceName(optionalRowString(row, "service_name")) }
        : {})
    };
  }

  async listSessionsByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const result = await this.pool.query(
      `select
         id,
         workspace_id,
         subject_ref,
         model_ref,
         agent_name,
         active_agent_name,
         title,
         status,
         last_run_at::text,
         created_at::text,
         updated_at::text
       from session_registry
       where workspace_id = $1
       order by updated_at desc, created_at desc, id asc
       limit $2 offset $3`,
      [workspaceId, pageSize, Number.isFinite(offset) && offset > 0 ? offset : 0]
    );

    return result.rows.map((row) => toSessionRegistryEntry(row as RecordRow));
  }

  async upsertSession(input: Session, serviceName: string | undefined): Promise<void> {
    await this.pool.query(
      `insert into session_registry (
         id,
         workspace_id,
         service_name,
         subject_ref,
         model_ref,
         agent_name,
         active_agent_name,
         title,
         status,
         last_run_at,
         created_at,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (id) do update set
         workspace_id = excluded.workspace_id,
         service_name = excluded.service_name,
         subject_ref = excluded.subject_ref,
         model_ref = excluded.model_ref,
         agent_name = excluded.agent_name,
         active_agent_name = excluded.active_agent_name,
         title = excluded.title,
         status = excluded.status,
         last_run_at = excluded.last_run_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.workspaceId,
        normalizeServiceName(serviceName) ?? null,
        input.subjectRef,
        input.modelRef ?? null,
        input.agentName ?? null,
        input.activeAgentName,
        input.title ?? null,
        input.status,
        input.lastRunAt ?? null,
        input.createdAt,
        input.updatedAt
      ]
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query(`delete from run_registry where session_id = $1`, [sessionId]);
    await this.pool.query(`delete from session_registry where id = $1`, [sessionId]);
  }

  async getRun(runId: string): Promise<(Run & { serviceName?: string | undefined }) | null> {
    const result = await this.pool.query(
      `select
         id,
         workspace_id,
         session_id,
         service_name,
         parent_run_id,
         initiator_ref,
         trigger_type,
         trigger_ref,
         agent_name,
         effective_agent_name,
         switch_count,
         status,
         cancel_requested_at::text,
         started_at::text,
         heartbeat_at::text,
         ended_at::text,
         error_code,
         error_message,
         metadata,
         created_at::text
       from run_registry
       where id = $1
       limit 1`,
      [runId]
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0] as RecordRow;
    return {
      ...toRunRegistryEntry(row),
      ...(normalizeServiceName(optionalRowString(row, "service_name"))
        ? { serviceName: normalizeServiceName(optionalRowString(row, "service_name")) }
        : {})
    };
  }

  async listRunsBySessionId(sessionId: string): Promise<Run[]> {
    const result = await this.pool.query(
      `select
         id,
         workspace_id,
         session_id,
         parent_run_id,
         initiator_ref,
         trigger_type,
         trigger_ref,
         agent_name,
         effective_agent_name,
         switch_count,
         status,
         cancel_requested_at::text,
         started_at::text,
         heartbeat_at::text,
         ended_at::text,
         error_code,
         error_message,
         metadata,
         created_at::text
       from run_registry
       where session_id = $1
       order by created_at desc, id desc`,
      [sessionId]
    );

    return result.rows.map((row) => toRunRegistryEntry(row as RecordRow));
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    const result = await this.pool.query(
      `select
         id,
         workspace_id,
         session_id,
         parent_run_id,
         initiator_ref,
         trigger_type,
         trigger_ref,
         agent_name,
         effective_agent_name,
         switch_count,
         status,
         cancel_requested_at::text,
         started_at::text,
         heartbeat_at::text,
         ended_at::text,
         error_code,
         error_message,
         metadata,
         created_at::text
       from run_registry
       where status = any($1::text[])
         and coalesce(heartbeat_at, started_at, created_at) <= $2::timestamptz
       order by coalesce(heartbeat_at, started_at, created_at) asc, id asc
       limit $3`,
      [["running", "waiting_tool"], staleBefore, Math.max(1, limit)]
    );

    return result.rows.map((row) => toRunRegistryEntry(row as RecordRow));
  }

  async upsertRun(input: Run, serviceName: string | undefined): Promise<void> {
    await this.pool.query(
      `insert into run_registry (
         id,
         workspace_id,
         session_id,
         service_name,
         parent_run_id,
         initiator_ref,
         trigger_type,
         trigger_ref,
         agent_name,
         effective_agent_name,
         switch_count,
         status,
         cancel_requested_at,
         started_at,
         heartbeat_at,
         ended_at,
         error_code,
         error_message,
         metadata,
         created_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       on conflict (id) do update set
         workspace_id = excluded.workspace_id,
         session_id = excluded.session_id,
         service_name = excluded.service_name,
         parent_run_id = excluded.parent_run_id,
         initiator_ref = excluded.initiator_ref,
         trigger_type = excluded.trigger_type,
         trigger_ref = excluded.trigger_ref,
         agent_name = excluded.agent_name,
         effective_agent_name = excluded.effective_agent_name,
         switch_count = excluded.switch_count,
         status = excluded.status,
         cancel_requested_at = excluded.cancel_requested_at,
         started_at = excluded.started_at,
         heartbeat_at = excluded.heartbeat_at,
         ended_at = excluded.ended_at,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         metadata = excluded.metadata,
         created_at = excluded.created_at`,
      [
        input.id,
        input.workspaceId,
        input.sessionId ?? null,
        normalizeServiceName(serviceName) ?? null,
        input.parentRunId ?? null,
        input.initiatorRef ?? null,
        input.triggerType,
        input.triggerRef ?? null,
        input.agentName ?? null,
        input.effectiveAgentName,
        input.switchCount ?? null,
        input.status,
        input.cancelRequestedAt ?? null,
        input.startedAt ?? null,
        input.heartbeatAt ?? null,
        input.endedAt ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.metadata ?? null,
        input.createdAt
      ]
    );
  }

  async deleteRunsByWorkspaceId(workspaceId: string): Promise<void> {
    await this.pool.query(`delete from run_registry where workspace_id = $1`, [workspaceId]);
  }
}

export function buildServiceDatabaseConnectionString(connectionString: string, serviceName: string): string {
  const normalizedServiceName = normalizeServiceName(serviceName);
  if (!normalizedServiceName) {
    return connectionString;
  }

  const url = new URL(connectionString);
  const baseDatabaseName = assertDatabaseName(url.pathname);
  url.pathname = `/${encodeURIComponent(`${baseDatabaseName}-${normalizedServiceName}`)}`;
  return url.toString();
}

class ServiceBackendRouter {
  readonly #defaultBackend: PostgresRuntimePersistence;
  readonly #connectionString: string;
  readonly #persistenceFactory: PostgresPersistenceFactory;
  readonly #registry: PostgresServiceRoutingRegistry;
  readonly #serviceBackends = new Map<string, Promise<PostgresRuntimePersistence>>();

  constructor(input: {
    defaultBackend: PostgresRuntimePersistence;
    connectionString: string;
    persistenceFactory: PostgresPersistenceFactory;
    registry: PostgresServiceRoutingRegistry;
  }) {
    this.#defaultBackend = input.defaultBackend;
    this.#connectionString = input.connectionString;
    this.#persistenceFactory = input.persistenceFactory;
    this.#registry = input.registry;
  }

  defaultBackend(): PostgresRuntimePersistence {
    return this.#defaultBackend;
  }

  registry(): PostgresServiceRoutingRegistry {
    return this.#registry;
  }

  registerServiceName(serviceName: string | undefined): void {
    const normalizedServiceName = normalizeServiceName(serviceName);
    if (!normalizedServiceName || this.#serviceBackends.has(normalizedServiceName)) {
      return;
    }

    this.#serviceBackends.set(
      normalizedServiceName,
      this.#persistenceFactory({
        connectionString: buildServiceDatabaseConnectionString(this.#connectionString, normalizedServiceName)
      })
    );
  }

  async getBackendForServiceName(serviceName: string | undefined): Promise<PostgresRuntimePersistence> {
    const normalizedServiceName = normalizeServiceName(serviceName);
    if (!normalizedServiceName) {
      return this.#defaultBackend;
    }

    this.registerServiceName(normalizedServiceName);
    return this.#serviceBackends.get(normalizedServiceName)!;
  }

  async getWorkspaceRegistry(workspaceId: string): Promise<WorkspaceRegistryEntry | null> {
    return this.#registry.getWorkspace(workspaceId);
  }

  async getWorkspaceServiceName(workspaceId: string): Promise<string | undefined> {
    return (await this.#registry.getWorkspace(workspaceId))?.serviceName;
  }

  async getSessionRegistry(sessionId: string): Promise<(Session & { serviceName?: string | undefined }) | null> {
    return this.#registry.getSession(sessionId);
  }

  async getRunRegistry(runId: string): Promise<(Run & { serviceName?: string | undefined }) | null> {
    return this.#registry.getRun(runId);
  }

  async getBackendForWorkspaceId(workspaceId: string): Promise<PostgresRuntimePersistence> {
    return this.getBackendForServiceName(await this.getWorkspaceServiceName(workspaceId));
  }

  async getBackendForSessionId(sessionId: string): Promise<PostgresRuntimePersistence> {
    return this.getBackendForServiceName((await this.getSessionRegistry(sessionId))?.serviceName);
  }

  async getBackendForRunId(runId: string): Promise<PostgresRuntimePersistence> {
    return this.getBackendForServiceName((await this.getRunRegistry(runId))?.serviceName);
  }

  async listKnownBackends(): Promise<PostgresRuntimePersistence[]> {
    const serviceNames = await this.#registry.listKnownServiceNames();
    const serviceBackends = await Promise.all(serviceNames.map((serviceName) => this.getBackendForServiceName(serviceName)));
    return [this.#defaultBackend, ...serviceBackends];
  }

  async findAcrossKnownBackends<T>(finder: (backend: PostgresRuntimePersistence) => Promise<T | null>): Promise<T | null> {
    for (const backend of await this.listKnownBackends()) {
      const match = await finder(backend);
      if (match !== null) {
        return match;
      }
    }

    return null;
  }

  async fanOutKnownBackends(operation: (backend: PostgresRuntimePersistence) => Promise<void>): Promise<void> {
    for (const backend of await this.listKnownBackends()) {
      await operation(backend);
    }
  }

  async close(): Promise<void> {
    const serviceResults = await Promise.allSettled(this.#serviceBackends.values());
    const backends = serviceResults
      .filter((result): result is PromiseFulfilledResult<PostgresRuntimePersistence> => result.status === "fulfilled")
      .map((result) => result.value);

    await Promise.allSettled([this.#defaultBackend.close(), ...backends.map((backend) => backend.close())]);
  }
}

class RoutedWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const serviceName = normalizeServiceName(input.serviceName);
    const backend = await this.router.getBackendForServiceName(serviceName);
    const created = await backend.workspaceRepository.create({
      ...input,
      ...(serviceName ? { serviceName } : {})
    });

    await this.router.registry().upsertWorkspace({
      workspaceId: created.id,
      serviceName,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    });

    return created;
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const existing = await this.router.getWorkspaceRegistry(input.id);
    const existingServiceName = normalizeServiceName(existing?.serviceName);
    const nextServiceName = normalizeServiceName(input.serviceName) ?? existingServiceName;

    if (existing && normalizeServiceName(input.serviceName) && existingServiceName !== normalizeServiceName(input.serviceName)) {
      throw new AppError(
        409,
        "workspace_service_name_immutable",
        `Workspace ${input.id} serviceName cannot be changed after the workspace has been created.`
      );
    }

    const backend = await this.router.getBackendForServiceName(nextServiceName);
    const updated = await backend.workspaceRepository.upsert({
      ...input,
      ...(nextServiceName ? { serviceName: nextServiceName } : {})
    });

    await this.router.registry().upsertWorkspace({
      workspaceId: updated.id,
      serviceName: nextServiceName,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    });

    return updated;
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    const registryEntry = await this.router.getWorkspaceRegistry(id);
    if (!registryEntry) {
      return null;
    }

    return (await this.router.getBackendForServiceName(registryEntry.serviceName)).workspaceRepository.getById(id);
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const entries = await this.router.registry().listWorkspaces(pageSize, cursor);
    const items = await Promise.all(
      entries.map(async (entry) =>
        (await this.router.getBackendForServiceName(entry.serviceName)).workspaceRepository.getById(entry.workspaceId)
      )
    );

    return items.filter((item): item is WorkspaceRecord => item !== null);
  }

  async delete(id: string): Promise<void> {
    const registryEntry = await this.router.getWorkspaceRegistry(id);
    if (registryEntry) {
      await (await this.router.getBackendForServiceName(registryEntry.serviceName)).workspaceRepository.delete(id);
    }

    await this.router.registry().deleteWorkspace(id);
  }
}

class RoutedSessionRepository implements SessionRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: Session): Promise<Session> {
    const serviceName = await this.router.getWorkspaceServiceName(input.workspaceId);
    const created = await (await this.router.getBackendForServiceName(serviceName)).sessionRepository.create(input);
    await this.router.registry().upsertSession(created, serviceName);
    return created;
  }

  async getById(id: string): Promise<Session | null> {
    const session = await this.router.getSessionRegistry(id);
    if (!session) {
      return null;
    }

    const { serviceName: _serviceName, ...entry } = session;
    return entry;
  }

  async update(input: Session): Promise<Session> {
    const existing = await this.router.getSessionRegistry(input.id);
    const serviceName = existing?.serviceName ?? (await this.router.getWorkspaceServiceName(input.workspaceId));
    const updated = await (await this.router.getBackendForServiceName(serviceName)).sessionRepository.update(input);
    await this.router.registry().upsertSession(updated, serviceName);
    return updated;
  }

  listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    return this.router.registry().listSessionsByWorkspaceId(workspaceId, pageSize, cursor);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.router.getSessionRegistry(id);
    if (existing) {
      await (await this.router.getBackendForServiceName(existing.serviceName)).sessionRepository.delete(id);
    }

    await this.router.registry().deleteSession(id);
  }
}

class RoutedRunRepository implements RunRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: Run): Promise<Run> {
    const serviceName = await this.router.getWorkspaceServiceName(input.workspaceId);
    const created = await (await this.router.getBackendForServiceName(serviceName)).runRepository.create(input);
    await this.router.registry().upsertRun(created, serviceName);
    return created;
  }

  async getById(id: string): Promise<Run | null> {
    const run = await this.router.getRunRegistry(id);
    if (!run) {
      return null;
    }

    const { serviceName: _serviceName, ...entry } = run;
    return entry;
  }

  async update(input: Run): Promise<Run> {
    const existing = await this.router.getRunRegistry(input.id);
    const serviceName = existing?.serviceName ?? (await this.router.getWorkspaceServiceName(input.workspaceId));
    const updated = await (await this.router.getBackendForServiceName(serviceName)).runRepository.update(input);
    await this.router.registry().upsertRun(updated, serviceName);
    return updated;
  }

  listBySessionId(sessionId: string): Promise<Run[]> {
    return this.router.registry().listRunsBySessionId(sessionId);
  }

  listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    return this.router.registry().listRecoverableActiveRuns(staleBefore, limit);
  }
}

class RoutedMessageRepository implements MessageRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: Message): Promise<Message> {
    return (await this.router.getBackendForSessionId(input.sessionId)).messageRepository.create(input);
  }

  async getById(id: string): Promise<Message | null> {
    return this.router.findAcrossKnownBackends((backend) => backend.messageRepository.getById(id));
  }

  async update(input: Message): Promise<Message> {
    return (await this.router.getBackendForSessionId(input.sessionId)).messageRepository.update(input);
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    return (await this.router.getBackendForSessionId(sessionId)).messageRepository.listBySessionId(sessionId);
  }
}

class RoutedRuntimeMessageRepository implements RuntimeMessageRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async replaceBySessionId(sessionId: string, messages: RuntimeMessage[]): Promise<void> {
    await (await this.router.getBackendForSessionId(sessionId)).runtimeMessageRepository.replaceBySessionId(sessionId, messages);
  }

  async listBySessionId(sessionId: string): Promise<RuntimeMessage[]> {
    return (await this.router.getBackendForSessionId(sessionId)).runtimeMessageRepository.listBySessionId(sessionId);
  }
}

class RoutedRunStepRepository implements RunStepRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: RunStep): Promise<RunStep> {
    return (await this.router.getBackendForRunId(input.runId)).runStepRepository.create(input);
  }

  async update(input: RunStep): Promise<RunStep> {
    return (await this.router.getBackendForRunId(input.runId)).runStepRepository.update(input);
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    return (await this.router.getBackendForRunId(runId)).runStepRepository.listByRunId(runId);
  }
}

class RoutedSessionEventStore implements SessionEventStore {
  constructor(private readonly router: ServiceBackendRouter) {}

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    return (await this.router.getBackendForSessionId(input.sessionId)).sessionEventStore.append(input);
  }

  async deleteById(eventId: string): Promise<void> {
    await this.router.fanOutKnownBackends((backend) => backend.sessionEventStore.deleteById(eventId));
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    return (await this.router.getBackendForSessionId(sessionId)).sessionEventStore.listSince(sessionId, cursor, runId);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    let unsubscribed = false;
    let unsubscribe: () => void = () => {};

    void this.router.getBackendForSessionId(sessionId).then((backend) => {
      if (unsubscribed) {
        return;
      }

      unsubscribe = backend.sessionEventStore.subscribe(sessionId, listener);
    });

    return () => {
      unsubscribed = true;
      unsubscribe();
    };
  }
}

class RoutedToolCallAuditRepository implements ToolCallAuditRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    return (await this.router.getBackendForRunId(input.runId)).toolCallAuditRepository.create(input);
  }
}

class RoutedHookRunAuditRepository implements HookRunAuditRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    return (await this.router.getBackendForRunId(input.runId)).hookRunAuditRepository.create(input);
  }
}

class RoutedArtifactRepository implements ArtifactRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    return (await this.router.getBackendForRunId(input.runId)).artifactRepository.create(input);
  }

  async listByRunId(runId: string): Promise<ArtifactRecord[]> {
    return (await this.router.getBackendForRunId(runId)).artifactRepository.listByRunId(runId);
  }
}

class RoutedHistoryEventRepository implements HistoryEventRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    return (await this.router.getBackendForWorkspaceId(input.workspaceId)).historyEventRepository.append(input);
  }

  async listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]> {
    return (await this.router.getBackendForWorkspaceId(workspaceId)).historyEventRepository.listByWorkspaceId(
      workspaceId,
      limit,
      afterId
    );
  }
}

class RoutedWorkspaceArchiveRepository implements WorkspaceArchiveRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async archiveWorkspace(input: {
    workspace: WorkspaceRecord;
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord> {
    return (await this.router.getBackendForServiceName(input.workspace.serviceName)).workspaceArchiveRepository.archiveWorkspace(input);
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
    return (await this.router.getBackendForServiceName(input.workspace.serviceName)).workspaceArchiveRepository.archiveSessionTree(input);
  }

  async listPendingArchiveDates(beforeArchiveDate: string, limit: number): Promise<string[]> {
    const dates = new Set<string>();
    for (const backend of await this.router.listKnownBackends()) {
      for (const archiveDate of await backend.workspaceArchiveRepository.listPendingArchiveDates(beforeArchiveDate, limit)) {
        dates.add(archiveDate);
      }
    }

    return [...dates].sort((left, right) => left.localeCompare(right)).slice(0, limit);
  }

  async listByArchiveDate(archiveDate: string): Promise<WorkspaceArchiveRecord[]> {
    const items = (
      await Promise.all(
        (await this.router.listKnownBackends()).map((backend) => backend.workspaceArchiveRepository.listByArchiveDate(archiveDate))
      )
    ).flat();

    return items.sort((left, right) => {
      if (left.archivedAt !== right.archivedAt) {
        return left.archivedAt.localeCompare(right.archivedAt);
      }

      return left.id.localeCompare(right.id);
    });
  }

  async markExported(ids: string[], input: { exportedAt: string; exportPath: string }): Promise<void> {
    await this.router.fanOutKnownBackends((backend) => backend.workspaceArchiveRepository.markExported(ids, input));
  }

  async pruneExportedBefore(beforeArchiveDate: string, limit: number): Promise<number> {
    let remaining = Math.max(0, limit);
    let pruned = 0;

    for (const backend of await this.router.listKnownBackends()) {
      if (remaining <= 0) {
        break;
      }

      const deleted = await backend.workspaceArchiveRepository.pruneExportedBefore(beforeArchiveDate, remaining);
      pruned += deleted;
      remaining -= deleted;
    }

    return pruned;
  }
}

export async function createServiceRoutedPostgresRuntimePersistence(
  options: CreateServiceRoutedPostgresRuntimePersistenceOptions
): Promise<ServiceRoutedPostgresRuntimePersistence> {
  const persistenceFactory = options.persistenceFactory ?? createPostgresRuntimePersistence;
  const defaultBackend = await persistenceFactory({
    connectionString: options.connectionString
  });
  await ensureServiceRoutingRegistrySchema(defaultBackend.pool);
  await migrateServiceRoutingRegistry(defaultBackend.pool);

  const router = new ServiceBackendRouter({
    defaultBackend,
    connectionString: options.connectionString,
    persistenceFactory,
    registry: new PostgresServiceRoutingRegistry(defaultBackend.pool)
  });

  return {
    pool: defaultBackend.pool,
    workspaceRepository: new RoutedWorkspaceRepository(router),
    workspaceArchiveRepository: new RoutedWorkspaceArchiveRepository(router),
    sessionRepository: new RoutedSessionRepository(router),
    messageRepository: new RoutedMessageRepository(router),
    runtimeMessageRepository: new RoutedRuntimeMessageRepository(router),
    runRepository: new RoutedRunRepository(router),
    runStepRepository: new RoutedRunStepRepository(router),
    sessionEventStore: new RoutedSessionEventStore(router),
    toolCallAuditRepository: new RoutedToolCallAuditRepository(router),
    hookRunAuditRepository: new RoutedHookRunAuditRepository(router),
    artifactRepository: new RoutedArtifactRepository(router),
    historyEventRepository: new RoutedHistoryEventRepository(router),
    close() {
      return router.close();
    }
  };
}
