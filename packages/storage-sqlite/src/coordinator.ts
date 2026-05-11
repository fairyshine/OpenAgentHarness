import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import type { Run, WorkspaceRecord, WorkspaceRepository } from "@oah/engine-core";
import { AppError, nowIso, parseCursor } from "@oah/engine-core";
import type {
  DatabaseHandle,
  IdRow,
  JsonRow,
  MessageRegistryEntryRow,
  RecoverableRunRegistryRow,
  RegistryWorkspaceIdRow,
  RegistryWorkspaceRow,
  RunRegistryEntryRow,
  SessionEventRegistryEntryRow
} from "./shared.js";
import {
  applyPrimarySchema,
  coerceRows,
  defaultProjectDbPath,
  migrateLegacyMirrorSchemaIfNeeded,
  normalizePersistedWorkspaceData,
  reconcilePersistedWorkspaceScope,
  registrySchemaStatements,
  runInTransaction,
  schemaStatements,
  serializeJson,
  shadowDbPath,
  shouldPersistProjectDbInsideWorkspace
} from "./shared.js";

export class SQLiteWorkspaceRepository implements WorkspaceRepository {
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
    await this.#onUpsert(input);
    this.#items.set(input.id, input);
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
    await this.#onDelete(id);
    this.#items.delete(id);
  }
}

export class SQLitePersistenceCoordinator {
  readonly #shadowRoot: string;
  readonly #projectDbLocation: "shadow" | "workspace";
  readonly #registryDbPath: string;
  readonly #workspaceRecords = new Map<string, WorkspaceRecord>();
  readonly #handles = new Map<string, DatabaseHandle>();
  readonly #sessionIndex = new Map<string, string>();
  readonly #runIndex = new Map<string, string>();
  #registryDb: DatabaseSync | undefined;

  constructor(shadowRoot: string, options: { projectDbLocation?: "shadow" | "workspace" | undefined } = {}) {
    this.#shadowRoot = shadowRoot;
    this.#projectDbLocation = options.projectDbLocation ?? "workspace";
    this.#registryDbPath = path.join(shadowRoot, "workspace-registry.db");
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
      .run(workspace.id, workspace.rootPath, workspace.kind, workspace.readOnly ? 1 : 0, serializeJson(workspace), workspace.updatedAt);
    await this.reindexWorkspace(handle.db, workspace.id);

    const registryDb = await this.ensureRegistryDb();
    runInTransaction(registryDb, () => {
      registryDb
        .prepare("delete from workspace_registry where id = ? and (kind != ? or root_path != ?)")
        .run(workspace.id, workspace.kind, workspace.rootPath);
      registryDb
        .prepare(
          `insert into workspace_registry (kind, root_path, id, payload, updated_at)
           values (?, ?, ?, ?, ?)
           on conflict(kind, root_path) do update set
             id = excluded.id,
             payload = excluded.payload,
             updated_at = excluded.updated_at`
        )
        .run(workspace.kind, workspace.rootPath, workspace.id, serializeJson(workspace), workspace.updatedAt);
    });
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

    const registryDb = await this.ensureRegistryDb();
    runInTransaction(registryDb, () => {
      registryDb.prepare("delete from workspace_registry where id = ?").run(workspaceId);
      registryDb.prepare("delete from session_registry where workspace_id = ?").run(workspaceId);
      registryDb.prepare("delete from message_registry where workspace_id = ?").run(workspaceId);
      registryDb.prepare("delete from session_event_registry where workspace_id = ?").run(workspaceId);
      registryDb.prepare("delete from run_registry where workspace_id = ?").run(workspaceId);
    });

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
    this.#registryDb?.close();
    this.#registryDb = undefined;
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

    const persisted = await this.lookupWorkspaceIdInRegistry("session_registry", sessionId);
    if (persisted) {
      this.#sessionIndex.set(sessionId, persisted);
      return persisted;
    }

    for (const workspace of this.#workspaceRecords.values()) {
      const handle = await this.ensureHandle(workspace);
      const row = handle.db.prepare("select id from sessions where id = ? limit 1").get(sessionId) as IdRow | undefined;
      if (row?.id) {
        await this.indexSession(sessionId, workspace.id);
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

    const persisted = await this.lookupWorkspaceIdInRegistry("run_registry", runId);
    if (persisted) {
      this.#runIndex.set(runId, persisted);
      return persisted;
    }

    for (const workspace of this.#workspaceRecords.values()) {
      const handle = await this.ensureHandle(workspace);
      const row = handle.db
        .prepare("select id, status, heartbeat_at, started_at, created_at from runs where id = ? limit 1")
        .get(runId) as RunRegistryEntryRow | undefined;
      if (row?.id) {
        await this.indexRun({
          id: row.id,
          workspaceId: workspace.id,
          status: row.status,
          heartbeatAt: row.heartbeat_at ?? undefined,
          startedAt: row.started_at ?? undefined,
          createdAt: row.created_at
        });
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

  async listOpenHandles(): Promise<DatabaseHandle[]> {
    return [...this.#handles.values()];
  }

  async listWorkspaceSnapshots(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]> {
    const snapshots: WorkspaceRecord[] = [];
    const registryDb = await this.ensureRegistryDb();

    for (const workspace of candidates) {
      const registryRow = registryDb
        .prepare("select payload from workspace_registry where kind = ? and root_path = ? limit 1")
        .get(workspace.kind, workspace.rootPath) as JsonRow | undefined;
      if (registryRow?.payload) {
        snapshots.push(JSON.parse(registryRow.payload) as WorkspaceRecord);
        continue;
      }

      const dbPath = this.dbPathForWorkspace(workspace);
      try {
        const db = new DatabaseSync(dbPath);
        try {
          for (const statement of schemaStatements) {
            db.exec(statement);
          }
          const row = db
            .prepare("select payload from workspace_meta where id = ? or root_path = ? order by id = ? desc limit 1")
            .get(workspace.id, workspace.rootPath, workspace.id) as JsonRow | undefined;
          if (row?.payload) {
            snapshots.push(JSON.parse(row.payload) as WorkspaceRecord);
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

  async listPersistedWorkspaces(): Promise<WorkspaceRecord[]> {
    const registryDb = await this.ensureRegistryDb();
    const rows = coerceRows<RegistryWorkspaceRow>(
      registryDb.prepare("select payload from workspace_registry order by updated_at desc, id asc").all()
    );
    return rows.map((row) => JSON.parse(row.payload) as WorkspaceRecord);
  }

  dbPathForWorkspace(workspace: Pick<WorkspaceRecord, "id" | "kind" | "readOnly" | "rootPath">): string {
    if (this.#projectDbLocation === "workspace" && shouldPersistProjectDbInsideWorkspace(workspace)) {
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
    await this.reindexWorkspace(db, workspace.id);
    return handle;
  }

  listWorkspaceRecords(): WorkspaceRecord[] {
    return [...this.#workspaceRecords.values()];
  }

  async ensureRegistryDb(): Promise<DatabaseSync> {
    if (this.#registryDb) {
      return this.#registryDb;
    }

    await mkdir(path.dirname(this.#registryDbPath), { recursive: true });
    const db = new DatabaseSync(this.#registryDbPath);
    db.exec("pragma journal_mode = wal");
    db.exec("pragma busy_timeout = 5000");
    for (const statement of registrySchemaStatements) {
      db.exec(statement);
    }
    this.ensureRegistrySchema(db);
    this.#registryDb = db;
    return db;
  }

  async reindexWorkspace(db: DatabaseSync, workspaceId: string): Promise<void> {
    this.deleteWorkspaceIndexes(workspaceId);

    const sessionRows = coerceRows<IdRow>(db.prepare("select id from sessions where workspace_id = ?").all(workspaceId));
    for (const row of sessionRows) {
      this.#sessionIndex.set(row.id, workspaceId);
    }

    const messageRows = coerceRows<MessageRegistryEntryRow>(
      db.prepare("select id from messages where session_id in (select id from sessions where workspace_id = ?)").all(workspaceId)
    );
    const sessionEventRows = coerceRows<SessionEventRegistryEntryRow>(
      db.prepare("select id from session_events where session_id in (select id from sessions where workspace_id = ?)").all(workspaceId)
    );

    const runRows = coerceRows<RunRegistryEntryRow>(
      db.prepare("select id, status, heartbeat_at, started_at, created_at from runs where workspace_id = ?").all(workspaceId)
    );
    for (const row of runRows) {
      this.#runIndex.set(row.id, workspaceId);
    }

    const registryDb = await this.ensureRegistryDb();
    const indexedAt = nowIso();
    runInTransaction(registryDb, () => {
      registryDb.prepare("delete from session_registry where workspace_id = ?").run(workspaceId);
      registryDb.prepare("delete from message_registry where workspace_id = ?").run(workspaceId);
      registryDb.prepare("delete from session_event_registry where workspace_id = ?").run(workspaceId);
      registryDb.prepare("delete from run_registry where workspace_id = ?").run(workspaceId);

      const insertSession = registryDb.prepare(
        `insert into session_registry (id, workspace_id, updated_at)
         values (?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`
      );
      for (const row of sessionRows) {
        insertSession.run(row.id, workspaceId, indexedAt);
      }

      const insertMessage = registryDb.prepare(
        `insert into message_registry (id, workspace_id, updated_at)
         values (?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`
      );
      for (const row of messageRows) {
        insertMessage.run(row.id, workspaceId, indexedAt);
      }

      const insertSessionEvent = registryDb.prepare(
        `insert into session_event_registry (id, workspace_id, updated_at)
         values (?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`
      );
      for (const row of sessionEventRows) {
        insertSessionEvent.run(row.id, workspaceId, indexedAt);
      }

      const insertRun = registryDb.prepare(
        `insert into run_registry (id, workspace_id, status, recover_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           status = excluded.status,
           recover_at = excluded.recover_at,
           updated_at = excluded.updated_at`
      );
      for (const row of runRows) {
        insertRun.run(row.id, workspaceId, row.status, this.runRecoverAt(row), indexedAt);
      }
    });
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

  async indexSession(sessionId: string, workspaceId: string): Promise<void> {
    this.#sessionIndex.set(sessionId, workspaceId);
    const registryDb = await this.ensureRegistryDb();
    registryDb
      .prepare(
        `insert into session_registry (id, workspace_id, updated_at)
         values (?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`
      )
      .run(sessionId, workspaceId, nowIso());
  }

  async indexMessage(messageId: string, workspaceId: string): Promise<void> {
    const registryDb = await this.ensureRegistryDb();
    registryDb
      .prepare(
        `insert into message_registry (id, workspace_id, updated_at)
         values (?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`
      )
      .run(messageId, workspaceId, nowIso());
  }

  async indexSessionEvent(eventId: string, workspaceId: string): Promise<void> {
    const registryDb = await this.ensureRegistryDb();
    registryDb
      .prepare(
        `insert into session_event_registry (id, workspace_id, updated_at)
         values (?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`
      )
      .run(eventId, workspaceId, nowIso());
  }

  forgetSession(sessionId: string): void {
    this.#sessionIndex.delete(sessionId);
  }

  async indexRun(
    run:
      | Pick<Run, "id" | "workspaceId" | "status" | "createdAt"> & Partial<Pick<Run, "heartbeatAt" | "startedAt">>
      | { id: string; workspaceId: string; status: Run["status"]; createdAt: string; heartbeatAt?: string; startedAt?: string }
  ): Promise<void> {
    this.#runIndex.set(run.id, run.workspaceId);
    const registryDb = await this.ensureRegistryDb();
    registryDb
      .prepare(
        `insert into run_registry (id, workspace_id, status, recover_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           workspace_id = excluded.workspace_id,
           status = excluded.status,
           recover_at = excluded.recover_at,
           updated_at = excluded.updated_at`
      )
      .run(run.id, run.workspaceId, run.status, this.runRecoverAt(run), nowIso());
  }

  async lookupWorkspaceIdInRegistry(
    table: "session_registry" | "message_registry" | "session_event_registry" | "run_registry",
    id: string
  ): Promise<string | undefined> {
    const registryDb = await this.ensureRegistryDb();
    const row = registryDb
      .prepare(`select workspace_id as workspaceId from ${table} where id = ? limit 1`)
      .get(id) as RegistryWorkspaceIdRow | undefined;
    if (!row?.workspaceId) {
      return undefined;
    }

    if (this.#workspaceRecords.has(row.workspaceId)) {
      return row.workspaceId;
    }

    registryDb.prepare(`delete from ${table} where id = ?`).run(id);
    return undefined;
  }

  async deleteRegistryEntry(
    table: "session_registry" | "message_registry" | "session_event_registry" | "run_registry",
    id: string
  ): Promise<void> {
    const registryDb = await this.ensureRegistryDb();
    registryDb.prepare(`delete from ${table} where id = ?`).run(id);
  }

  async getWorkspaceIdForMessage(messageId: string): Promise<string> {
    const persisted = await this.lookupWorkspaceIdInRegistry("message_registry", messageId);
    if (persisted) {
      return persisted;
    }

    for (const workspace of this.#workspaceRecords.values()) {
      const handle = await this.ensureHandle(workspace);
      const row = handle.db.prepare("select id from messages where id = ? limit 1").get(messageId) as IdRow | undefined;
      if (row?.id) {
        await this.indexMessage(messageId, workspace.id);
        return workspace.id;
      }
    }

    throw new AppError(404, "message_not_found", `Message ${messageId} was not found.`);
  }

  async getWorkspaceIdForSessionEvent(eventId: string): Promise<string> {
    const persisted = await this.lookupWorkspaceIdInRegistry("session_event_registry", eventId);
    if (persisted) {
      return persisted;
    }

    for (const workspace of this.#workspaceRecords.values()) {
      const handle = await this.ensureHandle(workspace);
      const row = handle.db.prepare("select id from session_events where id = ? limit 1").get(eventId) as IdRow | undefined;
      if (row?.id) {
        await this.indexSessionEvent(eventId, workspace.id);
        return workspace.id;
      }
    }

    throw new AppError(404, "session_event_not_found", `Session event ${eventId} was not found.`);
  }

  listRecoverableRunIds(staleBefore: string, limit: number): string[] {
    if (limit <= 0) {
      return [];
    }

    if (!this.#registryDb) {
      return [];
    }

    const rows = coerceRows<RecoverableRunRegistryRow>(
      this.#registryDb
        .prepare(
          `select id from run_registry
           where status in ('running', 'waiting_tool')
             and recover_at is not null
             and recover_at <= ?
           order by recover_at asc, id asc
           limit ?`
        )
        .all(staleBefore, Math.max(1, limit))
    );
    return rows.map((row) => row.id);
  }

  ensureRegistrySchema(db: DatabaseSync): void {
    this.ensureRegistryTableColumn(db, "run_registry", "status", "text");
    this.ensureRegistryTableColumn(db, "run_registry", "recover_at", "text");
    db.exec("create index if not exists run_registry_recoverable_idx on run_registry (status, recover_at, id asc)");
  }

  ensureRegistryTableColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
    const rows = coerceRows<{ name?: unknown }>(db.prepare(`pragma table_info(${table})`).all());
    if (rows.some((row) => row.name === column)) {
      return;
    }

    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }

  runRecoverAt(
    run: {
      createdAt?: string | undefined;
      created_at?: string | undefined;
      heartbeatAt?: string | undefined;
      heartbeat_at?: string | null | undefined;
      startedAt?: string | undefined;
      started_at?: string | null | undefined;
    }
  ): string {
    const resolved = run.heartbeat_at ?? run.heartbeatAt ?? run.started_at ?? run.startedAt ?? run.created_at ?? run.createdAt;
    if (!resolved) {
      throw new Error("Run recovery timestamp is required.");
    }

    return resolved;
  }
}
