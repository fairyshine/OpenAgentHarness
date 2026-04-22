import { Pool, type PoolConfig } from "pg";

import { drizzle } from "drizzle-orm/node-postgres";

import { ensurePostgresSchema } from "./schema-management.js";
import { oahPostgresSchema, type OahDatabase } from "./schema.js";
import {
  PostgresArtifactRepository,
  PostgresHistoryEventRepository,
  PostgresHookRunAuditRepository,
  PostgresMessageRepository,
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
  sessionPendingRunQueueRepository: PostgresSessionPendingRunQueueRepository;
  toolCallAuditRepository: PostgresToolCallAuditRepository;
  hookRunAuditRepository: PostgresHookRunAuditRepository;
  artifactRepository: PostgresArtifactRepository;
  historyEventRepository: PostgresHistoryEventRepository;
  close(): Promise<void>;
}

export interface CreatePostgresRuntimePersistenceOptions {
  connectionString?: string | undefined;
  pool?: Pool | undefined;
  poolConfig?: PoolConfig | undefined;
  ensureSchema?: boolean | undefined;
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
    workspaceArchiveRepository: new PostgresWorkspaceArchiveRepository(db),
    sessionRepository: new PostgresSessionRepository(db),
    messageRepository: new PostgresMessageRepository(db),
    engineMessageRepository: new PostgresEngineMessageRepository(db),
    runRepository: new PostgresRunRepository(db),
    runStepRepository: new PostgresRunStepRepository(db),
    sessionEventStore: new PostgresSessionEventStore(db),
    sessionPendingRunQueueRepository: new PostgresSessionPendingRunQueueRepository(db),
    toolCallAuditRepository: new PostgresToolCallAuditRepository(db),
    hookRunAuditRepository: new PostgresHookRunAuditRepository(db),
    artifactRepository: new PostgresArtifactRepository(db),
    historyEventRepository: new PostgresHistoryEventRepository(db),
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
  PostgresHistoryEventRepository,
  PostgresHookRunAuditRepository,
  PostgresMessageRepository,
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
