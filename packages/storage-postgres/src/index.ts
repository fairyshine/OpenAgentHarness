import { Pool, type PoolConfig } from "pg";

import type { WorkspaceRecord } from "@oah/engine-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";

import { ensurePostgresSchema } from "./schema-management.js";
import { oahPostgresSchema, type OahDatabase, workspaces } from "./schema.js";
import { toWorkspaceRecord } from "./row-mappers.js";
import {
  PostgresArtifactRepository,
  PostgresAgentTaskNotificationRepository,
  PostgresAgentTaskRepository,
  PostgresHistoryEventRepository,
  PostgresHookRunAuditRepository,
  PostgresMessageRepository,
  PostgresSessionCurrentStateRepository,
  PostgresRunRepository,
  PostgresRunStepRepository,
  PostgresEngineMessageRepository,
  PostgresSessionPendingRunQueueRepository,
  PostgresSessionEventStore,
  PostgresSessionRepository,
  PostgresToolCallAuditRepository,
  PostgresWorkspaceArchiveRepository,
  PostgresWorkspaceRepository
} from "./repositories.js";

export interface PostgresRuntimePersistence {
  pool: Pool;
  db: OahDatabase;
  workspaceRepository: PostgresWorkspaceRepository;
  workspaceArchiveRepository: PostgresWorkspaceArchiveRepository;
  sessionRepository: PostgresSessionRepository;
  messageRepository: PostgresMessageRepository;
  engineMessageRepository: PostgresEngineMessageRepository;
  runRepository: PostgresRunRepository;
  runStepRepository: PostgresRunStepRepository;
  sessionEventStore: PostgresSessionEventStore;
  sessionCurrentStateRepository: PostgresSessionCurrentStateRepository;
  sessionPendingRunQueueRepository: PostgresSessionPendingRunQueueRepository;
  toolCallAuditRepository: PostgresToolCallAuditRepository;
  hookRunAuditRepository: PostgresHookRunAuditRepository;
  artifactRepository: PostgresArtifactRepository;
  agentTaskRepository: PostgresAgentTaskRepository;
  agentTaskNotificationRepository: PostgresAgentTaskNotificationRepository;
  historyEventRepository: PostgresHistoryEventRepository;
  listWorkspaceSnapshots(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]>;
  close(): Promise<void>;
}

export interface CreatePostgresRuntimePersistenceOptions {
  connectionString?: string | undefined;
  pool?: Pool | undefined;
  poolConfig?: PoolConfig | undefined;
  ensureSchema?: boolean | undefined;
  archivePayloadRoot?: string | undefined;
}

export async function createPostgresRuntimePersistence(
  options: CreatePostgresRuntimePersistenceOptions
): Promise<PostgresRuntimePersistence> {
  const ownPool = !options.pool;
  const pool =
    options.pool ??
    new Pool({
      ...(options.connectionString ? { connectionString: options.connectionString } : {}),
      ...(options.poolConfig ?? {})
    });

  if (options.ensureSchema !== false) {
    await ensurePostgresSchema(pool);
  }

  const db = drizzle(pool, {
    schema: oahPostgresSchema
  });

  return {
    pool,
    db,
    workspaceRepository: new PostgresWorkspaceRepository(db),
    workspaceArchiveRepository: new PostgresWorkspaceArchiveRepository(db, {
      payloadRoot: options.archivePayloadRoot
    }),
    sessionRepository: new PostgresSessionRepository(db),
    messageRepository: new PostgresMessageRepository(db),
    engineMessageRepository: new PostgresEngineMessageRepository(db),
    runRepository: new PostgresRunRepository(db),
    runStepRepository: new PostgresRunStepRepository(db),
    sessionEventStore: new PostgresSessionEventStore(db),
    sessionCurrentStateRepository: new PostgresSessionCurrentStateRepository(db),
    sessionPendingRunQueueRepository: new PostgresSessionPendingRunQueueRepository(db),
    toolCallAuditRepository: new PostgresToolCallAuditRepository(db),
    hookRunAuditRepository: new PostgresHookRunAuditRepository(db),
    artifactRepository: new PostgresArtifactRepository(db),
    agentTaskRepository: new PostgresAgentTaskRepository(db),
    agentTaskNotificationRepository: new PostgresAgentTaskNotificationRepository(db),
    historyEventRepository: new PostgresHistoryEventRepository(db),
    async listWorkspaceSnapshots(candidates) {
      const snapshots = new Map<string, WorkspaceRecord>();

      for (const candidate of candidates) {
        const [byId] = await db.select().from(workspaces).where(eq(workspaces.id, candidate.id)).limit(1);
        const row =
          byId ??
          (
            await db
              .select()
              .from(workspaces)
              .where(and(eq(workspaces.rootPath, candidate.rootPath), eq(workspaces.kind, candidate.kind)))
              .limit(1)
          )[0];

        if (row) {
          snapshots.set(row.id, toWorkspaceRecord(row));
        }
      }

      return [...snapshots.values()];
    },
    async close() {
      if (ownPool) {
        await pool.end();
      }
    }
  };
}

export { ensurePostgresSchema } from "./schema-management.js";
export type { OahDatabase, OahExecutor, OahTransaction } from "./schema.js";
export {
  PostgresArtifactRepository,
  PostgresAgentTaskRepository,
  PostgresHistoryEventRepository,
  PostgresHookRunAuditRepository,
  PostgresMessageRepository,
  PostgresRunRepository,
  PostgresRunStepRepository,
  PostgresEngineMessageRepository,
  PostgresSessionCurrentStateRepository,
  PostgresSessionPendingRunQueueRepository,
  PostgresSessionEventStore,
  PostgresSessionRepository,
  PostgresToolCallAuditRepository,
  PostgresWorkspaceArchiveRepository,
  PostgresWorkspaceRepository
} from "./repositories.js";
