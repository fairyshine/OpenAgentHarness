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
  ToolCallAuditRecord,
  ToolCallAuditRepository
} from "@oah/engine-core";
import { AppError, nowIso } from "@oah/engine-core";

import type { SQLitePersistenceCoordinator } from "./coordinator.js";
import type { HistoryEventRow, JsonRow } from "./shared.js";
import { appendHistoryEvent, coerceRows, hasErrorCode, parseJson, runInTransaction, serializeJson } from "./shared.js";

export class SQLiteToolCallAuditRepository implements ToolCallAuditRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("insert into tool_calls (id, run_id, started_at, payload) values (?, ?, ?, ?)").run(input.id, input.runId, input.startedAt, serializeJson(input));
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

export class SQLiteHookRunAuditRepository implements HookRunAuditRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("insert into hook_runs (id, run_id, started_at, payload) values (?, ?, ?, ?)").run(input.id, input.runId, input.startedAt, serializeJson(input));
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

export class SQLiteArtifactRepository implements ArtifactRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    const workspaceId = await this.#coordinator.getWorkspaceIdForRun(input.runId);
    const handle = await this.#coordinator.getWorkspaceHandle(workspaceId);
    runInTransaction(handle.db, () => {
      handle.db.prepare("insert into artifacts (id, run_id, created_at, payload) values (?, ?, ?, ?)").run(input.id, input.runId, input.createdAt, serializeJson(input));
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
    const rows = coerceRows<JsonRow>(handle.db.prepare("select payload from artifacts where run_id = ? order by created_at asc, id asc").all(runId));
    return rows.map((row) => parseJson<ArtifactRecord>(row.payload));
  }
}

export class SQLiteAgentTaskRepository implements AgentTaskRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async upsert(input: AgentTaskRecord): Promise<AgentTaskRecord> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare(
          "insert or replace into agent_tasks (task_id, workspace_id, parent_session_id, child_run_id, status, updated_at, payload) values (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          input.taskId,
          input.workspaceId,
          input.parentSessionId,
          input.childRunId,
          input.status,
          input.updatedAt,
          serializeJson(input)
        );
    });
    return input;
  }

  async getByTaskId(taskId: string): Promise<AgentTaskRecord | null> {
    try {
      const handle = await this.#coordinator.getSessionHandle(taskId);
      const row = handle.db.prepare("select payload from agent_tasks where task_id = ? limit 1").get(taskId) as
        | JsonRow
        | undefined;
      if (row?.payload) {
        return parseJson<AgentTaskRecord>(row.payload);
      }
    } catch (error) {
      if (!hasErrorCode(error, "session_not_found")) {
        throw error;
      }
    }

    for (const workspace of this.#coordinator.listWorkspaceRecords()) {
      const handle = await this.#coordinator.getWorkspaceHandle(workspace.id);
      const row = handle.db.prepare("select payload from agent_tasks where task_id = ? limit 1").get(taskId) as
        | JsonRow
        | undefined;
      if (row?.payload) {
        return parseJson<AgentTaskRecord>(row.payload);
      }
    }

    return null;
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
    const existing = await this.getByTaskId(input.taskId);
    if (!existing) {
      throw new AppError(404, "agent_task_not_found", `Agent task ${input.taskId} was not found.`);
    }

    const next: AgentTaskRecord = {
      ...existing,
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
    };
    const handle = await this.#coordinator.getWorkspaceHandle(next.workspaceId);
    runInTransaction(handle.db, () => {
      const result = handle.db
        .prepare(
          "update agent_tasks set parent_session_id = ?, child_run_id = ?, status = ?, updated_at = ?, payload = ? where task_id = ?"
        )
        .run(next.parentSessionId, next.childRunId, next.status, next.updatedAt, serializeJson(next), next.taskId);
      if (result.changes === 0) {
        throw new AppError(404, "agent_task_not_found", `Agent task ${input.taskId} was not found.`);
      }
    });

    return next;
  }
}

export class SQLiteAgentTaskNotificationRepository implements AgentTaskNotificationRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async create(input: AgentTaskNotificationRecord): Promise<AgentTaskNotificationRecord> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    runInTransaction(handle.db, () => {
      handle.db
        .prepare(
          "insert or replace into agent_task_notifications (id, workspace_id, parent_session_id, status, created_at, payload) values (?, ?, ?, ?, ?, ?)"
        )
        .run(input.id, input.workspaceId, input.parentSessionId, input.status, input.createdAt, serializeJson(input));
    });
    return input;
  }

  async listPendingBySessionId(parentSessionId: string): Promise<AgentTaskNotificationRecord[]> {
    const handle = await this.#coordinator.getSessionHandle(parentSessionId);
    const rows = coerceRows<JsonRow>(
      handle.db
        .prepare(
          "select payload from agent_task_notifications where parent_session_id = ? and status = ? order by created_at asc, id asc"
        )
        .all(parentSessionId, "pending")
    );
    return rows.map((row) => parseJson<AgentTaskNotificationRecord>(row.payload));
  }

  async markConsumed(input: { ids: string[]; consumedAt: string }): Promise<void> {
    if (input.ids.length === 0) {
      return;
    }

    for (const workspace of this.#coordinator.listWorkspaceRecords()) {
      const handle = await this.#coordinator.getWorkspaceHandle(workspace.id);
      runInTransaction(handle.db, () => {
        const select = handle.db.prepare("select payload from agent_task_notifications where id = ? limit 1");
        const update = handle.db.prepare("update agent_task_notifications set status = ?, payload = ? where id = ?");
        for (const id of input.ids) {
          const row = select.get(id) as JsonRow | undefined;
          if (!row?.payload) {
            continue;
          }

          const existing = parseJson<AgentTaskNotificationRecord>(row.payload);
          const next: AgentTaskNotificationRecord = {
            ...existing,
            status: "consumed",
            consumedAt: input.consumedAt
          };
          update.run(next.status, serializeJson(next), id);
        }
      });
    }
  }
}

export class SQLiteHistoryEventRepository implements HistoryEventRepository {
  readonly #coordinator: SQLitePersistenceCoordinator;

  constructor(coordinator: SQLitePersistenceCoordinator) {
    this.#coordinator = coordinator;
  }

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    const handle = await this.#coordinator.getWorkspaceHandle(input.workspaceId);
    let created: HistoryEventRecord | undefined;
    runInTransaction(handle.db, () => {
      const result = handle.db
        .prepare("insert into history_events (workspace_id, entity_type, entity_id, op, payload, occurred_at) values (?, ?, ?, ?, ?, ?)")
        .run(input.workspaceId, input.entityType, input.entityId, input.op, serializeJson(input.payload), input.occurredAt);
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
