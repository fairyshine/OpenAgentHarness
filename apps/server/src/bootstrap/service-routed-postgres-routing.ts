import path from "node:path";

import type { Pool } from "pg";

import type { Run, Session, WorkspaceRecord } from "@oah/engine-core";
import type { CreatePostgresRuntimePersistenceOptions, PostgresRuntimePersistence } from "@oah/storage-postgres";
export {
  ensureServiceRoutingRegistrySchema,
  migrateServiceRoutingRegistry
} from "./service-routed-postgres-registry-schema.js";

interface RecordRow extends Record<string, unknown> {}

export interface WorkspaceRegistryEntry {
  workspaceId: string;
  serviceName?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface PostgresPersistenceFactory {
  (options: CreatePostgresRuntimePersistenceOptions): Promise<PostgresRuntimePersistence>;
}

const DEFAULT_SERVICE_ROUTING_REGISTRY_READ_LIMIT = 5_000;
const MAX_SERVICE_ROUTING_REGISTRY_READ_LIMIT = 100_000;

export function normalizeServiceName(serviceName: string | undefined): string | undefined {
  const normalized = serviceName?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveServiceRoutingRegistryReadLimit(envName: string, fallback = DEFAULT_SERVICE_ROUTING_REGISTRY_READ_LIMIT): number {
  const raw = process.env[envName]?.trim() || process.env.OAH_SERVICE_ROUTING_REGISTRY_READ_LIMIT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_SERVICE_ROUTING_REGISTRY_READ_LIMIT);
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
    ...(optionalRowString(row, "parent_session_id") ? { parentSessionId: rowString(row, "parent_session_id") } : {}),
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

export class PostgresServiceRoutingRegistry {
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
         parent_session_id,
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
         parent_session_id,
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

  async listChildSessions(parentSessionId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const result = await this.pool.query(
      `select
         id,
         workspace_id,
         parent_session_id,
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
       where parent_session_id = $1
       order by updated_at desc, created_at desc, id asc
       limit $2 offset $3`,
      [parentSessionId, pageSize, Number.isFinite(offset) && offset > 0 ? offset : 0]
    );

    return result.rows.map((row) => toSessionRegistryEntry(row as RecordRow));
  }

  async upsertSession(input: Session, serviceName: string | undefined): Promise<void> {
    await this.pool.query(
      `insert into session_registry (
         id,
         workspace_id,
         parent_session_id,
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
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do update set
         workspace_id = excluded.workspace_id,
         parent_session_id = excluded.parent_session_id,
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
        input.parentSessionId ?? null,
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
    const limit = resolveServiceRoutingRegistryReadLimit("OAH_SERVICE_ROUTING_SESSION_RUN_READ_LIMIT");
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
       order by created_at desc, id desc
       limit $2`,
      [sessionId, limit]
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

export class ServiceBackendRouter {
  readonly #defaultBackend: PostgresRuntimePersistence;
  readonly #connectionString: string;
  readonly #archivePayloadRoot: string | undefined;
  readonly #poolConfig: CreatePostgresRuntimePersistenceOptions["poolConfig"] | undefined;
  readonly #persistenceFactory: PostgresPersistenceFactory;
  readonly #registry: PostgresServiceRoutingRegistry;
  readonly #serviceBackends = new Map<string, Promise<PostgresRuntimePersistence>>();

  constructor(input: {
    defaultBackend: PostgresRuntimePersistence;
    connectionString: string;
    archivePayloadRoot?: string | undefined;
    poolConfig?: CreatePostgresRuntimePersistenceOptions["poolConfig"] | undefined;
    persistenceFactory: PostgresPersistenceFactory;
    registry: PostgresServiceRoutingRegistry;
  }) {
    this.#defaultBackend = input.defaultBackend;
    this.#connectionString = input.connectionString;
    this.#archivePayloadRoot = input.archivePayloadRoot;
    this.#poolConfig = input.poolConfig;
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
        connectionString: buildServiceDatabaseConnectionString(this.#connectionString, normalizedServiceName),
        ...(this.#poolConfig ? { poolConfig: this.#poolConfig } : {}),
        ...(this.#archivePayloadRoot
          ? { archivePayloadRoot: path.join(this.#archivePayloadRoot, normalizedServiceName) }
          : {})
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
