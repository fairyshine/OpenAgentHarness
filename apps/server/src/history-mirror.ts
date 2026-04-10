import path from "node:path";
import { access, mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRecord,
  HistoryEventRecord,
  HistoryEventRepository,
  HookRunAuditRecord,
  Message,
  RuntimeMessage,
  Run,
  RunStep,
  Session,
  ToolCallAuditRecord,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/runtime-core";
import { nowIso } from "@oah/runtime-core";

export interface HistoryMirrorLogger {
  info?(message: string): void;
  warn?(message: string, error?: unknown): void;
  error?(message: string, error?: unknown): void;
}

export interface HistoryMirrorSyncerOptions {
  workspaceRepository: WorkspaceRepository;
  historyEventRepository: HistoryEventRepository;
  snapshotSource?: HistoryMirrorSnapshotSource | undefined;
  pollIntervalMs?: number | undefined;
  batchSize?: number | undefined;
  maxConcurrentWorkspaces?: number | undefined;
  logger?: HistoryMirrorLogger | undefined;
}

export interface HistoryMirrorSnapshot {
  watermarkEventId: number;
  sessions: Session[];
  messages: Message[];
  runtimeMessages: RuntimeMessage[];
  runs: Run[];
  runSteps: RunStep[];
  toolCalls: ToolCallAuditRecord[];
  hookRuns: HookRunAuditRecord[];
  artifacts: ArtifactRecord[];
}

export interface HistoryMirrorSnapshotSource {
  readWorkspaceSnapshot(workspaceId: string): Promise<HistoryMirrorSnapshot>;
  readWorkspaceRuntimeMessages?(workspaceId: string): Promise<RuntimeMessage[]>;
}

export interface HistoryEventMaintenanceRepository extends HistoryEventRepository {
  pruneByWorkspace(workspaceId: string, maxEventId: number, occurredBefore: string): Promise<number>;
}

export interface HistoryEventCleanerOptions {
  workspaceRepository: WorkspaceRepository;
  historyEventRepository: HistoryEventMaintenanceRepository;
  retentionMs?: number | undefined;
  pollIntervalMs?: number | undefined;
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
  `create table if not exists workspaces (
    id text primary key,
    external_ref text,
    name text not null,
    root_path text not null,
    execution_policy text not null,
    status text not null,
    kind text not null,
    read_only integer not null,
    history_mirror_enabled integer not null,
    default_agent text,
    project_agents_md text,
    settings text not null,
    workspace_models text not null,
    agents text not null,
    actions text not null,
    skills text not null,
    mcp_servers text not null,
    hooks text not null,
    catalog text not null,
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists sessions (
    id text primary key,
    workspace_id text not null,
    parent_session_id text,
    subject_ref text not null,
    model_ref text,
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
    metadata text,
    created_at text not null
  )`,
  `create index if not exists messages_session_created_idx on messages (session_id, created_at)`,
  `create table if not exists runtime_messages (
    id text primary key,
    session_id text not null,
    run_id text,
    role text not null,
    kind text not null,
    content text not null,
    metadata text,
    created_at text not null
  )`,
  `create index if not exists runtime_messages_session_created_idx on runtime_messages (session_id, created_at, id)`,
  `create table if not exists runs (
    id text primary key,
    workspace_id text not null,
    session_id text,
    parent_run_id text,
    initiator_ref text,
    trigger_type text not null,
    trigger_ref text,
    agent_name text,
    effective_agent_name text not null,
    switch_count integer,
    status text not null,
    cancel_requested_at text,
    started_at text,
    heartbeat_at text,
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

  if (workspace.historyMirrorEnabled === false) {
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
  readonly #snapshotSource: HistoryMirrorSnapshotSource | undefined;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #maxConcurrentWorkspaces: number;
  readonly #logger: HistoryMirrorLogger;
  readonly #databases = new Map<string, MirrorDatabaseHandle>();
  readonly #unavailableWorkspaceRoots = new Map<string, string>();
  #activeOperation: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: HistoryMirrorSyncerOptions) {
    this.#workspaceRepository = options.workspaceRepository;
    this.#historyEventRepository = options.historyEventRepository;
    this.#snapshotSource = options.snapshotSource;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#batchSize = options.batchSize ?? 250;
    this.#maxConcurrentWorkspaces = Math.max(1, options.maxConcurrentWorkspaces ?? 4);
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
        await this.#syncWorkspacePage(workspaces);

        cursor = workspaces.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
      } while (cursor);
    });
  }

  async rebuildWorkspace(workspace: WorkspaceRecord): Promise<HistoryMirrorStatus> {
    if (workspace.kind !== "project" || workspace.historyMirrorEnabled === false) {
      return inspectHistoryMirrorStatus(workspace);
    }

    await this.#runExclusive(async () => {
      const dbPath = historyMirrorDbPath(workspace.rootPath);
      this.#closeMirrorDatabase(workspace.id);
      await Promise.all([
        rm(dbPath, { force: true }),
        rm(`${dbPath}-shm`, { force: true }),
        rm(`${dbPath}-wal`, { force: true })
      ]);
      if (this.#snapshotSource) {
        const handle = await this.#openMirrorDatabase(workspace);
        const snapshot = await this.#snapshotSource.readWorkspaceSnapshot(workspace.id);
        this.#replaceMirrorWithSnapshot(handle.db, workspace, snapshot);
        await this.#syncWorkspace(workspace);
      } else {
        await this.#syncWorkspace(workspace, {
          reset: true
        });
      }
    });

    return inspectHistoryMirrorStatus(workspace);
  }

  async #syncWorkspace(workspace: WorkspaceRecord, options?: { reset?: boolean | undefined }): Promise<void> {
    if (workspace.kind !== "project" || workspace.historyMirrorEnabled === false) {
      this.#unavailableWorkspaceRoots.delete(workspace.id);
      return;
    }

    if (!(await pathExists(workspace.rootPath))) {
      const previousRootPath = this.#unavailableWorkspaceRoots.get(workspace.id);
      if (previousRootPath !== workspace.rootPath) {
        this.#logger.warn?.(
          `History mirror skipped for workspace ${workspace.id}; root path is unavailable on this machine: ${workspace.rootPath}`
        );
        this.#unavailableWorkspaceRoots.set(workspace.id, workspace.rootPath);
      }
      return;
    }

    this.#unavailableWorkspaceRoots.delete(workspace.id);

    let handle: MirrorDatabaseHandle;
    try {
      handle = await this.#openMirrorDatabase(workspace);
    } catch (error) {
      this.#logger.warn?.(`History mirror database unavailable for workspace ${workspace.id}; skipping sync.`, error);
      return;
    }
    const previousState = options?.reset ? undefined : this.#readMirrorState(handle.db, workspace.id);
    if (this.#snapshotSource && (options?.reset || !previousState)) {
      const snapshot = await this.#snapshotSource.readWorkspaceSnapshot(workspace.id);
      this.#replaceMirrorWithSnapshot(handle.db, workspace, snapshot);
    } else {
      this.#runInTransaction(handle.db, () => {
        this.#upsertWorkspace(handle.db, workspace);
      });
    }
    let lastAppliedEventId =
      this.#readMirrorState(handle.db, workspace.id)?.lastEventId ??
      previousState?.lastEventId ??
      (options?.reset ? 0 : 0);
    let appliedEvents = false;

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
          const shouldWriteIdleState =
            options?.reset === true ||
            appliedEvents ||
            previousState?.status !== "idle" ||
            previousState?.lastEventId !== lastAppliedEventId ||
            previousState?.errorMessage !== null;
          if (shouldWriteIdleState) {
            this.#runInTransaction(handle.db, () => {
              this.#upsertWorkspace(handle.db, workspace);
              this.#writeMirrorState(handle.db, workspace.id, lastAppliedEventId, "idle", null);
            });
          }
          if (options?.reset || appliedEvents || this.#hasActiveRuns(handle.db, workspace.id)) {
            await this.#refreshRuntimeMessagesIfSupported(handle.db, workspace.id);
          }
          return;
        }

        this.#runInTransaction(handle.db, () => {
          this.#upsertWorkspace(handle.db, workspace);
          for (const event of events) {
            this.#applyHistoryEvent(handle.db, event);
          }

          const latestEventId = events.at(-1)?.id ?? lastAppliedEventId;
          this.#writeMirrorState(handle.db, workspace.id, latestEventId, "idle", null);
          lastAppliedEventId = latestEventId;
        });
        appliedEvents = true;
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

  async #syncWorkspacePage(workspaces: WorkspaceRecord[]): Promise<void> {
    if (workspaces.length === 0) {
      return;
    }

    let nextIndex = 0;
    const workerCount = Math.min(this.#maxConcurrentWorkspaces, workspaces.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < workspaces.length) {
          const workspace = workspaces[nextIndex];
          nextIndex += 1;
          if (!workspace) {
            return;
          }
          await this.#syncWorkspace(workspace);
        }
      })
    );
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
    this.#ensureMirrorSchemaColumns(db);

    const handle = { dbPath, db };
    this.#databases.set(workspace.id, handle);
    return handle;
  }

  #ensureMirrorSchemaColumns(db: DatabaseSync): void {
    this.#ensureTableColumn(db, "sessions", "parent_session_id", "text");
    this.#ensureTableColumn(db, "sessions", "model_ref", "text");
    this.#ensureTableColumn(db, "runs", "parent_run_id", "text");
    this.#ensureTableColumn(db, "runs", "heartbeat_at", "text");
  }

  #ensureTableColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
    const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: string }>;
    if (columns.some((row) => row.name === column)) {
      return;
    }

    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }

  #closeMirrorDatabase(workspaceId: string): void {
    const cached = this.#databases.get(workspaceId);
    if (!cached) {
      return;
    }

    cached.db.close();
    this.#databases.delete(workspaceId);
  }

  #hasActiveRuns(db: DatabaseSync, workspaceId: string): boolean {
    const row = db
      .prepare(
        `select count(*) as count
         from runs
         where workspace_id = ?
           and status in ('running', 'waiting_tool')`
      )
      .get(workspaceId) as { count?: number } | undefined;
    return (row?.count ?? 0) > 0;
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

  #replaceMirrorWithSnapshot(db: DatabaseSync, workspace: WorkspaceRecord, snapshot: HistoryMirrorSnapshot): void {
    this.#runInTransaction(db, () => {
      db.exec("delete from workspaces");
      db.exec("delete from sessions");
      db.exec("delete from messages");
      db.exec("delete from runtime_messages");
      db.exec("delete from runs");
      db.exec("delete from run_steps");
      db.exec("delete from tool_calls");
      db.exec("delete from hook_runs");
      db.exec("delete from artifacts");
      db.prepare("delete from mirror_state where workspace_id = ?").run(workspace.id);

      this.#upsertWorkspace(db, workspace);
      for (const session of snapshot.sessions) {
        this.#upsertSession(db, session);
      }
      for (const message of snapshot.messages) {
        this.#upsertMessage(db, message);
      }
      for (const runtimeMessage of snapshot.runtimeMessages) {
        this.#upsertRuntimeMessage(db, runtimeMessage);
      }
      for (const run of snapshot.runs) {
        this.#upsertRun(db, run);
      }
      for (const step of snapshot.runSteps) {
        this.#upsertRunStep(db, step);
      }
      for (const toolCall of snapshot.toolCalls) {
        this.#upsertToolCall(db, toolCall);
      }
      for (const hookRun of snapshot.hookRuns) {
        this.#upsertHookRun(db, hookRun);
      }
      for (const artifact of snapshot.artifacts) {
        this.#upsertArtifact(db, artifact);
      }

      this.#writeMirrorState(db, workspace.id, snapshot.watermarkEventId, "idle", null);
    });
  }

  #upsertWorkspace(db: DatabaseSync, workspace: WorkspaceRecord): void {
    this.#upsertRow(db, "workspaces", "id", {
      id: workspace.id,
      external_ref: workspace.externalRef ?? null,
      name: workspace.name,
      root_path: workspace.rootPath,
      execution_policy: workspace.executionPolicy,
      status: workspace.status,
      kind: workspace.kind,
      read_only: workspace.readOnly ? 1 : 0,
      history_mirror_enabled: workspace.historyMirrorEnabled ? 1 : 0,
      default_agent: workspace.defaultAgent ?? null,
      project_agents_md: workspace.projectAgentsMd ?? null,
      settings: JSON.stringify(workspace.settings),
      workspace_models: JSON.stringify(workspace.workspaceModels),
      agents: JSON.stringify(workspace.agents),
      actions: JSON.stringify(workspace.actions),
      skills: JSON.stringify(workspace.skills),
      mcp_servers: JSON.stringify(workspace.toolServers),
      hooks: JSON.stringify(workspace.hooks),
      catalog: JSON.stringify(workspace.catalog),
      created_at: workspace.createdAt,
      updated_at: workspace.updatedAt
    });
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
        this.#upsertSession(db, {
          id: this.#string(payload.id) ?? event.entityId,
          workspaceId: this.#string(payload.workspaceId) ?? event.workspaceId,
          ...(this.#string(payload.parentSessionId) ? { parentSessionId: this.#string(payload.parentSessionId)! } : {}),
          subjectRef: this.#requiredString(payload.subjectRef, "subjectRef", event),
          ...(this.#string(payload.modelRef) ? { modelRef: this.#string(payload.modelRef)! } : {}),
          ...(this.#string(payload.agentName) ? { agentName: this.#string(payload.agentName)! } : {}),
          activeAgentName: this.#requiredString(payload.activeAgentName, "activeAgentName", event),
          ...(this.#string(payload.title) ? { title: this.#string(payload.title)! } : {}),
          status: this.#requiredString(payload.status, "status", event),
          ...(this.#string(payload.lastRunAt) ? { lastRunAt: this.#string(payload.lastRunAt)! } : {}),
          createdAt: this.#requiredString(payload.createdAt, "createdAt", event),
          updatedAt: this.#requiredString(payload.updatedAt, "updatedAt", event)
        } as Session);
        return;
      case "message":
        this.#upsertMessage(db, {
          id: this.#string(payload.id) ?? event.entityId,
          sessionId: this.#requiredString(payload.sessionId, "sessionId", event),
          ...(this.#string(payload.runId) ? { runId: this.#string(payload.runId)! } : {}),
          role: this.#requiredString(payload.role, "role", event) as Message["role"],
          content: payload.content as Message["content"],
          ...(payload.metadata !== undefined ? { metadata: payload.metadata as Record<string, unknown> } : {}),
          createdAt: this.#requiredString(payload.createdAt, "createdAt", event)
        } as Message);
        return;
      case "run":
        this.#upsertRun(db, {
          id: this.#string(payload.id) ?? event.entityId,
          workspaceId: this.#string(payload.workspaceId) ?? event.workspaceId,
          ...(this.#string(payload.sessionId) ? { sessionId: this.#string(payload.sessionId)! } : {}),
          ...(this.#string(payload.parentRunId) ? { parentRunId: this.#string(payload.parentRunId)! } : {}),
          ...(this.#string(payload.initiatorRef) ? { initiatorRef: this.#string(payload.initiatorRef)! } : {}),
          triggerType: this.#requiredString(payload.triggerType, "triggerType", event),
          ...(this.#string(payload.triggerRef) ? { triggerRef: this.#string(payload.triggerRef)! } : {}),
          ...(this.#string(payload.agentName) ? { agentName: this.#string(payload.agentName)! } : {}),
          effectiveAgentName: this.#requiredString(payload.effectiveAgentName, "effectiveAgentName", event),
          ...(this.#integer(payload.switchCount) !== null ? { switchCount: this.#integer(payload.switchCount)! } : {}),
          status: this.#requiredString(payload.status, "status", event) as Run["status"],
          ...(this.#string(payload.cancelRequestedAt) ? { cancelRequestedAt: this.#string(payload.cancelRequestedAt)! } : {}),
          ...(this.#string(payload.startedAt) ? { startedAt: this.#string(payload.startedAt)! } : {}),
          ...(this.#string(payload.heartbeatAt) ? { heartbeatAt: this.#string(payload.heartbeatAt)! } : {}),
          ...(this.#string(payload.endedAt) ? { endedAt: this.#string(payload.endedAt)! } : {}),
          ...(this.#string(payload.errorCode) ? { errorCode: this.#string(payload.errorCode)! } : {}),
          ...(this.#string(payload.errorMessage) ? { errorMessage: this.#string(payload.errorMessage)! } : {}),
          ...(payload.metadata !== undefined ? { metadata: payload.metadata as Record<string, unknown> } : {}),
          createdAt: this.#requiredString(payload.createdAt, "createdAt", event)
        } as Run);
        return;
      case "run_step":
        this.#upsertRunStep(db, {
          id: this.#string(payload.id) ?? event.entityId,
          runId: this.#requiredString(payload.runId, "runId", event),
          seq: this.#requiredInteger(payload.seq, "seq", event),
          stepType: this.#requiredString(payload.stepType, "stepType", event),
          ...(this.#string(payload.name) ? { name: this.#string(payload.name)! } : {}),
          ...(this.#string(payload.agentName) ? { agentName: this.#string(payload.agentName)! } : {}),
          status: this.#requiredString(payload.status, "status", event) as RunStep["status"],
          ...(payload.input !== undefined ? { input: payload.input } : {}),
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          ...(this.#string(payload.startedAt) ? { startedAt: this.#string(payload.startedAt)! } : {}),
          ...(this.#string(payload.endedAt) ? { endedAt: this.#string(payload.endedAt)! } : {})
        } as RunStep);
        return;
      case "tool_call":
        this.#upsertToolCall(db, {
          id: this.#string(payload.id) ?? event.entityId,
          runId: this.#requiredString(payload.runId, "runId", event),
          ...(this.#string(payload.stepId) ? { stepId: this.#string(payload.stepId)! } : {}),
          sourceType: this.#requiredString(payload.sourceType, "sourceType", event) as ToolCallAuditRecord["sourceType"],
          toolName: this.#requiredString(payload.toolName, "toolName", event),
          ...(payload.request !== undefined ? { request: payload.request as Record<string, unknown> } : {}),
          ...(payload.response !== undefined ? { response: payload.response as Record<string, unknown> } : {}),
          status: this.#requiredString(payload.status, "status", event) as ToolCallAuditRecord["status"],
          ...(this.#integer(payload.durationMs) !== null ? { durationMs: this.#integer(payload.durationMs)! } : {}),
          startedAt: this.#requiredString(payload.startedAt, "startedAt", event),
          endedAt: this.#requiredString(payload.endedAt, "endedAt", event)
        });
        return;
      case "hook_run":
        this.#upsertHookRun(db, {
          id: this.#string(payload.id) ?? event.entityId,
          runId: this.#requiredString(payload.runId, "runId", event),
          hookName: this.#requiredString(payload.hookName, "hookName", event),
          eventName: this.#requiredString(payload.eventName, "eventName", event),
          capabilities: payload.capabilities as string[],
          ...(payload.patch !== undefined ? { patch: payload.patch as Record<string, unknown> } : {}),
          status: this.#requiredString(payload.status, "status", event) as HookRunAuditRecord["status"],
          startedAt: this.#requiredString(payload.startedAt, "startedAt", event),
          endedAt: this.#requiredString(payload.endedAt, "endedAt", event),
          ...(this.#string(payload.errorMessage) ? { errorMessage: this.#string(payload.errorMessage)! } : {})
        });
        return;
      case "artifact":
        this.#upsertArtifact(db, {
          id: this.#string(payload.id) ?? event.entityId,
          runId: this.#requiredString(payload.runId, "runId", event),
          type: this.#requiredString(payload.type, "type", event),
          ...(this.#string(payload.path) ? { path: this.#string(payload.path)! } : {}),
          ...(this.#string(payload.contentRef) ? { contentRef: this.#string(payload.contentRef)! } : {}),
          ...(payload.metadata !== undefined ? { metadata: payload.metadata as Record<string, unknown> } : {}),
          createdAt: this.#requiredString(payload.createdAt, "createdAt", event)
        });
        return;
      default:
        return;
    }
  }

  #upsertSession(db: DatabaseSync, session: Session): void {
    this.#upsertRow(db, "sessions", "id", {
      id: session.id,
      workspace_id: session.workspaceId,
      parent_session_id: session.parentSessionId ?? null,
      subject_ref: session.subjectRef,
      model_ref: session.modelRef ?? null,
      agent_name: session.agentName ?? null,
      active_agent_name: session.activeAgentName,
      title: session.title ?? null,
      status: session.status,
      last_run_at: session.lastRunAt ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt
    });
  }

  #upsertMessage(db: DatabaseSync, message: Message): void {
    this.#upsertRow(db, "messages", "id", {
      id: message.id,
      session_id: message.sessionId,
      run_id: message.runId ?? null,
      role: message.role,
      content: JSON.stringify(message.content),
      metadata: this.#json(message.metadata),
      created_at: message.createdAt
    });
  }

  #upsertRuntimeMessage(db: DatabaseSync, message: RuntimeMessage): void {
    this.#upsertRow(db, "runtime_messages", "id", {
      id: message.id,
      session_id: message.sessionId,
      run_id: message.runId ?? null,
      role: message.role,
      kind: message.kind,
      content: JSON.stringify(message.content),
      metadata: this.#json(message.metadata),
      created_at: message.createdAt
    });
  }

  #upsertRun(db: DatabaseSync, run: Run): void {
    this.#upsertRow(db, "runs", "id", {
      id: run.id,
      workspace_id: run.workspaceId,
      session_id: run.sessionId ?? null,
      parent_run_id: run.parentRunId ?? null,
      initiator_ref: run.initiatorRef ?? null,
      trigger_type: run.triggerType,
      trigger_ref: run.triggerRef ?? null,
      agent_name: run.agentName ?? null,
      effective_agent_name: run.effectiveAgentName,
      switch_count: run.switchCount ?? null,
      status: run.status,
      cancel_requested_at: run.cancelRequestedAt ?? null,
      started_at: run.startedAt ?? null,
      heartbeat_at: run.heartbeatAt ?? null,
      ended_at: run.endedAt ?? null,
      error_code: run.errorCode ?? null,
      error_message: run.errorMessage ?? null,
      metadata: this.#json(run.metadata),
      created_at: run.createdAt
    });
  }

  #upsertRunStep(db: DatabaseSync, step: RunStep): void {
    this.#upsertRow(db, "run_steps", "id", {
      id: step.id,
      run_id: step.runId,
      seq: step.seq,
      step_type: step.stepType,
      name: step.name ?? null,
      agent_name: step.agentName ?? null,
      status: step.status,
      input: this.#json(step.input),
      output: this.#json(step.output),
      started_at: step.startedAt ?? null,
      ended_at: step.endedAt ?? null
    });
  }

  #upsertToolCall(db: DatabaseSync, toolCall: ToolCallAuditRecord): void {
    this.#upsertRow(db, "tool_calls", "id", {
      id: toolCall.id,
      run_id: toolCall.runId,
      step_id: toolCall.stepId ?? null,
      source_type: toolCall.sourceType,
      tool_name: toolCall.toolName,
      request: this.#json(toolCall.request),
      response: this.#json(toolCall.response),
      status: toolCall.status,
      duration_ms: toolCall.durationMs ?? null,
      started_at: toolCall.startedAt,
      ended_at: toolCall.endedAt
    });
  }

  #upsertHookRun(db: DatabaseSync, hookRun: HookRunAuditRecord): void {
    this.#upsertRow(db, "hook_runs", "id", {
      id: hookRun.id,
      run_id: hookRun.runId,
      hook_name: hookRun.hookName,
      event_name: hookRun.eventName,
      capabilities: JSON.stringify(hookRun.capabilities),
      patch: this.#json(hookRun.patch),
      status: hookRun.status,
      started_at: hookRun.startedAt,
      ended_at: hookRun.endedAt,
      error_message: hookRun.errorMessage ?? null
    });
  }

  #upsertArtifact(db: DatabaseSync, artifact: ArtifactRecord): void {
    this.#upsertRow(db, "artifacts", "id", {
      id: artifact.id,
      run_id: artifact.runId,
      type: artifact.type,
      path: artifact.path ?? null,
      content_ref: artifact.contentRef ?? null,
      metadata: this.#json(artifact.metadata),
      created_at: artifact.createdAt
    });
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

  async #refreshRuntimeMessagesIfSupported(db: DatabaseSync, workspaceId: string): Promise<void> {
    if (!this.#snapshotSource?.readWorkspaceRuntimeMessages) {
      return;
    }

    const runtimeMessages = await this.#snapshotSource.readWorkspaceRuntimeMessages(workspaceId);
    this.#runInTransaction(db, () => {
      db.exec("delete from runtime_messages");
      for (const runtimeMessage of runtimeMessages) {
        this.#upsertRuntimeMessage(db, runtimeMessage);
      }
    });
  }
}

export class HistoryEventCleaner {
  readonly #workspaceRepository: WorkspaceRepository;
  readonly #historyEventRepository: HistoryEventMaintenanceRepository;
  readonly #retentionMs: number;
  readonly #pollIntervalMs: number;
  readonly #logger: HistoryMirrorLogger;
  #activeOperation: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: HistoryEventCleanerOptions) {
    this.#workspaceRepository = options.workspaceRepository;
    this.#historyEventRepository = options.historyEventRepository;
    this.#retentionMs = Math.max(60_000, options.retentionMs ?? 7 * 24 * 60 * 60 * 1000);
    this.#pollIntervalMs = Math.max(60_000, options.pollIntervalMs ?? 60 * 60 * 1000);
    this.#logger = options.logger ?? {};
  }

  start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.cleanupOnce();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
    void this.cleanupOnce();
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
        // Ignore cleanup failures during shutdown.
      }
    }
  }

  async cleanupOnce(): Promise<void> {
    if (this.#activeOperation) {
      return this.#activeOperation;
    }

    const task = (async () => {
      const occurredBefore = new Date(Date.now() - this.#retentionMs).toISOString();
      let cursor: string | undefined;
      do {
        const workspaces = await this.#workspaceRepository.list(100, cursor);
        for (const workspace of workspaces) {
          if (workspace.kind !== "project" || workspace.historyMirrorEnabled === false) {
            continue;
          }

          const status = await inspectHistoryMirrorStatus(workspace);
          if (!status.lastEventId || status.state === "missing" || status.state === "unsupported") {
            continue;
          }

          const deleted = await this.#historyEventRepository.pruneByWorkspace(workspace.id, status.lastEventId, occurredBefore);
          if (deleted > 0) {
            this.#logger.info?.(
              `Pruned ${deleted} history events for workspace ${workspace.id} up to event ${status.lastEventId}.`
            );
          }
        }

        cursor = workspaces.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
      } while (cursor);
    })();

    this.#activeOperation = task;
    try {
      await task;
    } finally {
      if (this.#activeOperation === task) {
        this.#activeOperation = undefined;
      }
    }
  }
}
