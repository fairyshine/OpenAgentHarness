import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createClient } from "redis";

import { AppError } from "@oah/runtime-core";
import type {
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisDeleteKeyResponse,
  StorageRedisDeleteKeysResponse,
  StorageRedisKeyDetail,
  StorageRedisKeyPage,
  StorageRedisMaintenanceResponse
} from "@oah/api-contracts";

type RedisInspectorClient = ReturnType<typeof createClient>;
type PostgresTableConfigName = keyof typeof POSTGRES_TABLE_CONFIG;

const POSTGRES_TABLE_CONFIG = {
  workspaces: {
    orderBy: "updated_at desc, created_at desc, id asc",
    description: "Workspace registry and resolved catalog snapshots."
  },
  sessions: {
    orderBy: "updated_at desc, created_at desc, id asc",
    description: "Session headers per workspace."
  },
  runs: {
    orderBy: "created_at desc, id asc",
    description: "Run lifecycle records and status."
  },
  messages: {
    orderBy: "created_at desc, id asc",
    description: "Persisted session messages, with content stored in AI SDK-compatible message format."
  },
  run_steps: {
    orderBy: "coalesce(started_at, ended_at) desc nulls last, seq desc, id asc",
    description: "Per-run step audit trail. model_call steps snapshot AI SDK-facing request/response data plus OAH audit fields."
  },
  session_events: {
    orderBy: "cursor desc",
    description: "SSE/session event log. Transport/event stream only, not the canonical conversation store."
  },
  tool_calls: {
    orderBy: "started_at desc, id asc",
    description: "Tool call audit records."
  },
  hook_runs: {
    orderBy: "started_at desc, id asc",
    description: "Hook execution audit records."
  },
  artifacts: {
    orderBy: "created_at desc, id asc",
    description: "Artifact metadata emitted by runs."
  },
  history_events: {
    orderBy: "id desc",
    description: "History mirror event source for workspace mirror sync."
  },
  archives: {
    orderBy: "archived_at desc, id asc",
    description: "Deletion archive buffer before daily SQLite export."
  }
} satisfies Record<StoragePostgresTableName, { orderBy: string; description: string }>;

const POSTGRES_TABLE_FILTER_COLUMNS: Record<
  StoragePostgresTableName,
  {
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
  }
> = {
  workspaces: {
    workspaceId: "id"
  },
  sessions: {
    workspaceId: "workspace_id",
    sessionId: "id"
  },
  runs: {
    workspaceId: "workspace_id",
    sessionId: "session_id",
    runId: "id"
  },
  messages: {
    sessionId: "session_id",
    runId: "run_id"
  },
  run_steps: {
    runId: "run_id"
  },
  session_events: {
    sessionId: "session_id",
    runId: "run_id"
  },
  tool_calls: {
    runId: "run_id"
  },
  hook_runs: {
    runId: "run_id"
  },
  artifacts: {
    runId: "run_id"
  },
  history_events: {
    workspaceId: "workspace_id"
  },
  archives: {
    workspaceId: "workspace_id"
  }
};

function decodeJsonish(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null"
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  return value;
}

async function readRedisKeySize(client: RedisInspectorClient, key: string, type: string): Promise<number | undefined> {
  switch (type) {
    case "string":
      return client.strLen(key);
    case "list":
      return client.lLen(key);
    case "set":
      return client.sCard(key);
    case "hash":
      return client.hLen(key);
    case "zset":
      return client.zCard(key);
    default:
      return undefined;
  }
}

function extractSessionId(key: string): string {
  const match = key.match(/:session:([^:]+):/u);
  return match?.[1] ?? "unknown";
}

function isSessionQueueKey(key: string, keyPrefix: string): boolean {
  return key.startsWith(`${keyPrefix}:session:`) && key.endsWith(":queue");
}

function isSessionLockKey(key: string, keyPrefix: string): boolean {
  return key.startsWith(`${keyPrefix}:session:`) && key.endsWith(":lock");
}

function isArchiveBundleName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite$/u.test(fileName);
}

function isArchiveChecksumName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite\.sha256$/u.test(fileName);
}

async function summarizeArchiveExportDirectory(exportRoot: string): Promise<{
  exportRoot: string;
  bundleCount: number;
  checksumCount: number;
  totalBytes: number;
  latestArchiveDate?: string | undefined;
  leftoverTempFiles: number;
  unexpectedFiles: number;
  unexpectedDirectories: number;
  missingChecksums: number;
  orphanChecksums: number;
}> {
  const entries = await readdir(exportRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  const bundleNames = new Set<string>();
  const checksumNames = new Set<string>();
  let totalBytes = 0;
  let leftoverTempFiles = 0;
  let unexpectedFiles = 0;
  let unexpectedDirectories = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      unexpectedDirectories += 1;
      continue;
    }

    if (entry.name.endsWith(".tmp")) {
      leftoverTempFiles += 1;
      continue;
    }

    if (isArchiveBundleName(entry.name)) {
      bundleNames.add(entry.name);
      const fileStat = await stat(path.join(exportRoot, entry.name));
      totalBytes += fileStat.size;
      continue;
    }

    if (isArchiveChecksumName(entry.name)) {
      checksumNames.add(entry.name);
      continue;
    }

    unexpectedFiles += 1;
  }

  let missingChecksums = 0;
  for (const bundleName of bundleNames) {
    if (!checksumNames.has(`${bundleName}.sha256`)) {
      missingChecksums += 1;
    }
  }

  let orphanChecksums = 0;
  for (const checksumName of checksumNames) {
    if (!bundleNames.has(checksumName.replace(/\.sha256$/u, ""))) {
      orphanChecksums += 1;
    }
  }

  return {
    exportRoot,
    bundleCount: bundleNames.size,
    checksumCount: checksumNames.size,
    totalBytes,
    ...(bundleNames.size > 0
      ? {
          latestArchiveDate: Array.from(bundleNames)
            .map((name) => name.replace(/\.sqlite$/u, ""))
            .sort()
            .at(-1)
        }
      : {}),
    leftoverTempFiles,
    unexpectedFiles,
    unexpectedDirectories,
    missingChecksums,
    orphanChecksums
  };
}

export interface StorageAdmin {
  overview(): Promise<StorageOverview>;
  postgresTable(
    table: StoragePostgresTableName,
    options: {
      limit: number;
      offset?: number | undefined;
      q?: string | undefined;
      workspaceId?: string | undefined;
      sessionId?: string | undefined;
      runId?: string | undefined;
    }
  ): Promise<StoragePostgresTablePage>;
  redisKeys(pattern: string, cursor: string | undefined, pageSize: number): Promise<StorageRedisKeyPage>;
  redisKeyDetail(key: string): Promise<StorageRedisKeyDetail>;
  deleteRedisKey(key: string): Promise<StorageRedisDeleteKeyResponse>;
  deleteRedisKeys(keys: string[]): Promise<StorageRedisDeleteKeysResponse>;
  clearRedisSessionQueue(key: string): Promise<StorageRedisMaintenanceResponse>;
  releaseRedisSessionLock(key: string): Promise<StorageRedisMaintenanceResponse>;
  close(): Promise<void>;
}

export function createStorageAdmin(options: {
  postgresPool?: Pool | undefined;
  redisUrl?: string | undefined;
  redisAvailable: boolean;
  redisEventBusEnabled: boolean;
  redisRunQueueEnabled: boolean;
  historyEventCleanupEnabled?: boolean | undefined;
  historyEventRetentionDays?: number | undefined;
  archiveExportEnabled?: boolean | undefined;
  archiveExportRoot?: string | undefined;
  keyPrefix?: string | undefined;
}): StorageAdmin {
  const keyPrefix = options.keyPrefix ?? "oah";
  const postgresPool = options.postgresPool;
  const postgresConfigured = Boolean(postgresPool);
  const postgresPrimary = Boolean(postgresPool);
  let redisClientPromise: Promise<RedisInspectorClient | undefined> | undefined;

  async function getRedisClient(): Promise<RedisInspectorClient | undefined> {
    if (!options.redisUrl) {
      return undefined;
    }

    if (!redisClientPromise) {
      redisClientPromise = (async () => {
        const redisUrl = options.redisUrl;
        if (!redisUrl) {
          return undefined;
        }
        const client = createClient({
          url: redisUrl
        });
        await client.connect();
        return client;
      })().catch(() => undefined);
    }

    return redisClientPromise;
  }

  async function requirePostgresPool(): Promise<Pool> {
    if (!postgresPool) {
      throw new AppError(501, "postgres_storage_unavailable", "Postgres storage inspector is unavailable on this server.");
    }

    return postgresPool;
  }

  async function requireRedisClient(): Promise<RedisInspectorClient> {
    const client = await getRedisClient();
    if (!client) {
      throw new AppError(501, "redis_storage_unavailable", "Redis storage inspector is unavailable on this server.");
    }

    return client;
  }

  return {
    async overview() {
      const postgresSummary = postgresPool
        ? await Promise.all([
            postgresPool.query<{ database: string }>("select current_database() as database"),
            Promise.all(
              (Object.keys(POSTGRES_TABLE_CONFIG) as StoragePostgresTableName[]).map(async (table) => {
                const count = await postgresPool.query<{ count: string }>(`select count(*)::text as count from ${table}`);
                const tableKey = table as PostgresTableConfigName;
                return {
                  name: table,
                  rowCount: Number.parseInt(count.rows[0]?.count ?? "0", 10),
                  orderBy: POSTGRES_TABLE_CONFIG[tableKey].orderBy,
                  description: POSTGRES_TABLE_CONFIG[tableKey].description
                };
              })
            ),
            postgresPool.query<{ count: string; oldestOccurredAt: string | null; newestOccurredAt: string | null }>(
              `select
                 count(*)::text as count,
                 min(occurred_at)::text as "oldestOccurredAt",
                 max(occurred_at)::text as "newestOccurredAt"
               from history_events`
            ),
            postgresPool.query<{ rowCount: string; pendingExports: string; exportedRows: string; oldestPendingArchiveDate: string | null; newestExportedAt: string | null }>(
              `select
                 count(*)::text as "rowCount",
                 count(*) filter (where exported_at is null)::text as "pendingExports",
                 count(*) filter (where exported_at is not null)::text as "exportedRows",
                 min(archive_date) filter (where exported_at is null) as "oldestPendingArchiveDate",
                 max(exported_at)::text as "newestExportedAt"
               from archives`
            )
          ])
        : undefined;

      const redisClient = await getRedisClient();
      const redisSummary =
        redisClient && options.redisAvailable
          ? await Promise.all([
              redisClient.dbSize(),
              redisClient.lLen(`${keyPrefix}:runs:ready`),
              redisClient.keys(`${keyPrefix}:session:*:queue`),
              redisClient.keys(`${keyPrefix}:session:*:lock`),
              redisClient.keys(`${keyPrefix}:session:*:events`)
            ])
          : undefined;

      const archiveExportDirectory =
        postgresSummary && options.archiveExportRoot ? await summarizeArchiveExportDirectory(options.archiveExportRoot) : undefined;

      const [databaseResult, tableSummaries, historyEventStats, archiveStats] = postgresSummary ?? [];
      const [dbSize, readyQueueLength, sessionQueueKeys = [], sessionLockKeys = [], eventBufferKeys = []] = redisSummary ?? [];
      const readyQueue = redisSummary
        ? {
            key: `${keyPrefix}:runs:ready`,
            length: readyQueueLength ?? 0
          }
        : undefined;

      return {
        postgres: {
          configured: postgresConfigured,
          available: Boolean(postgresSummary),
          primaryStorage: postgresPrimary,
          ...(databaseResult?.rows[0]?.database ? { database: databaseResult.rows[0].database } : {}),
          tables: tableSummaries ?? [],
          ...(historyEventStats?.rows[0]
            ? {
                historyEvents: {
                  cleanupEnabled: options.historyEventCleanupEnabled ?? false,
                  retentionDays: Math.max(1, options.historyEventRetentionDays ?? 7),
                  rowCount: Number.parseInt(historyEventStats.rows[0].count ?? "0", 10),
                  ...(historyEventStats.rows[0].oldestOccurredAt ? { oldestOccurredAt: historyEventStats.rows[0].oldestOccurredAt } : {}),
                  ...(historyEventStats.rows[0].newestOccurredAt ? { newestOccurredAt: historyEventStats.rows[0].newestOccurredAt } : {})
                }
              }
            : {}),
          ...(archiveStats?.rows[0]
            ? {
                archives: {
                  exportEnabled: options.archiveExportEnabled ?? false,
                  rowCount: Number.parseInt(archiveStats.rows[0].rowCount ?? "0", 10),
                  pendingExports: Number.parseInt(archiveStats.rows[0].pendingExports ?? "0", 10),
                  exportedRows: Number.parseInt(archiveStats.rows[0].exportedRows ?? "0", 10),
                  ...(archiveStats.rows[0].oldestPendingArchiveDate
                    ? { oldestPendingArchiveDate: archiveStats.rows[0].oldestPendingArchiveDate }
                    : {}),
                  ...(archiveStats.rows[0].newestExportedAt ? { newestExportedAt: archiveStats.rows[0].newestExportedAt } : {}),
                  ...(archiveExportDirectory
                    ? {
                        exportRoot: archiveExportDirectory.exportRoot,
                        bundleCount: archiveExportDirectory.bundleCount,
                        checksumCount: archiveExportDirectory.checksumCount,
                        totalBytes: archiveExportDirectory.totalBytes,
                        leftoverTempFiles: archiveExportDirectory.leftoverTempFiles,
                        unexpectedFiles: archiveExportDirectory.unexpectedFiles,
                        unexpectedDirectories: archiveExportDirectory.unexpectedDirectories,
                        missingChecksums: archiveExportDirectory.missingChecksums,
                        orphanChecksums: archiveExportDirectory.orphanChecksums,
                        ...(archiveExportDirectory.latestArchiveDate
                          ? { latestArchiveDate: archiveExportDirectory.latestArchiveDate }
                          : {})
                      }
                    : {})
                }
              }
            : {})
        },
        redis: {
          configured: Boolean(options.redisUrl),
          available: Boolean(redisSummary),
          keyPrefix,
          eventBusEnabled: options.redisEventBusEnabled,
          runQueueEnabled: options.redisRunQueueEnabled,
          ...(redisSummary ? { dbSize } : {}),
          ...(readyQueue ? { readyQueue } : {}),
          sessionQueues: redisSummary
            ? await Promise.all(
                sessionQueueKeys.map(async (key) => ({
                  key,
                  sessionId: extractSessionId(key),
                  length: await redisClient!.lLen(key)
                }))
              )
            : [],
          sessionLocks: redisSummary
            ? await Promise.all(
                sessionLockKeys.map(async (key) => ({
                  key,
                  sessionId: extractSessionId(key),
                  ...(await redisClient!.pTTL(key)).valueOf() >= 0 ? { ttlMs: await redisClient!.pTTL(key) } : {},
                  ...(await redisClient!.get(key)) ? { owner: (await redisClient!.get(key)) ?? undefined } : {}
                }))
              )
            : [],
          eventBuffers: redisSummary
            ? await Promise.all(
                eventBufferKeys.map(async (key) => ({
                  key,
                  sessionId: extractSessionId(key),
                  length: await redisClient!.lLen(key)
                }))
              )
            : []
        }
      };
    },

    async postgresTable(table, options) {
      const pool = await requirePostgresPool();
      const config = POSTGRES_TABLE_CONFIG[table as PostgresTableConfigName];
      const filterColumns = POSTGRES_TABLE_FILTER_COLUMNS[table];
      const safeLimit = Math.max(1, Math.min(200, options.limit));
      const safeOffset = Math.max(0, options.offset ?? 0);
      const whereClauses: string[] = [];
      const values: string[] = [];
      const pushFilter = (column: string | undefined, value: string | undefined) => {
        if (!column || !value?.trim()) {
          return;
        }

        values.push(value.trim());
        whereClauses.push(`${column} = $${values.length}`);
      };

      pushFilter(filterColumns.workspaceId, options.workspaceId);
      pushFilter(filterColumns.sessionId, options.sessionId);
      pushFilter(filterColumns.runId, options.runId);

      if (options.q?.trim()) {
        values.push(`%${options.q.trim()}%`);
        whereClauses.push(`row_to_json(${table})::text ilike $${values.length}`);
      }

      const whereSql = whereClauses.length > 0 ? ` where ${whereClauses.join(" and ")}` : "";
      const [countResult, rowsResult] = await Promise.all([
        pool.query<{ count: string }>(`select count(*)::text as count from ${table}${whereSql}`, values),
        pool.query<Record<string, unknown>>(
          `select * from ${table}${whereSql} order by ${config.orderBy} limit ${safeLimit} offset ${safeOffset}`,
          values
        )
      ]);

      const columns = Array.from(new Set(rowsResult.fields.map((field) => field.name)));
      const rowCount = Number.parseInt(countResult.rows[0]?.count ?? "0", 10);

      return {
        table,
        rowCount,
        orderBy: config.orderBy,
        offset: safeOffset,
        limit: safeLimit,
        columns,
        rows: rowsResult.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Date ? value.toISOString() : value === undefined ? null : value
            ])
          )
        ),
        ...(options.q?.trim() || options.workspaceId?.trim() || options.sessionId?.trim() || options.runId?.trim()
          ? {
              appliedFilters: {
                ...(options.q?.trim() ? { q: options.q.trim() } : {}),
                ...(options.workspaceId?.trim() ? { workspaceId: options.workspaceId.trim() } : {}),
                ...(options.sessionId?.trim() ? { sessionId: options.sessionId.trim() } : {}),
                ...(options.runId?.trim() ? { runId: options.runId.trim() } : {})
              }
            }
          : {})
        ,
        ...(safeOffset + rowsResult.rows.length < rowCount ? { nextOffset: safeOffset + rowsResult.rows.length } : {})
      };
    },

    async redisKeys(pattern, cursor, pageSize) {
      const client = await requireRedisClient();
      const match = pattern.trim() || `${keyPrefix}:*`;
      const count = Math.max(1, Math.min(200, pageSize));
      const scanCursor = cursor?.trim() || "0";
      const response = (await client.sendCommand([
        "SCAN",
        scanCursor,
        "MATCH",
        match,
        "COUNT",
        String(count)
      ])) as [string, string[]];
      const [nextCursor, keys] = response;
      const items = await Promise.all(
        keys.map(async (key) => {
          const type = await client.type(key);
          const ttl = await client.pTTL(key);
          const size = await readRedisKeySize(client, key, type);
          return {
            key,
            type,
            ...(ttl >= 0 ? { ttlMs: ttl } : {}),
            ...(size !== undefined ? { size } : {})
          };
        })
      );

      return {
        pattern: match,
        items,
        ...(nextCursor !== "0" ? { nextCursor } : {})
      };
    },

    async redisKeyDetail(key) {
      const client = await requireRedisClient();
      const type = await client.type(key);
      if (type === "none") {
        throw new AppError(404, "redis_key_not_found", `Redis key ${key} was not found.`);
      }

      const ttl = await client.pTTL(key);
      const size = await readRedisKeySize(client, key, type);
      let value: unknown;

      switch (type) {
        case "string":
          value = decodeJsonish((await client.get(key)) ?? "");
          break;
        case "list":
          value = (await client.lRange(key, 0, 99)).map((entry) => decodeJsonish(entry));
          break;
        case "hash":
          value = await client.hGetAll(key);
          break;
        case "set":
          value = await client.sMembers(key);
          break;
        case "zset":
          value = await client.zRangeWithScores(key, 0, 99);
          break;
        default:
          value = undefined;
          break;
      }

      return {
        key,
        type,
        ...(ttl >= 0 ? { ttlMs: ttl } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(value !== undefined ? { value } : {})
      };
    },

    async deleteRedisKey(key) {
      const client = await requireRedisClient();
      const deleted = (await client.del(key)) > 0;
      return {
        key,
        deleted
      };
    },

    async deleteRedisKeys(keys) {
      const client = await requireRedisClient();
      const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].slice(0, 200);
      if (uniqueKeys.length === 0) {
        return {
          items: []
        };
      }

      return {
        items: await Promise.all(
          uniqueKeys.map(async (key) => ({
            key,
            deleted: (await client.del(key)) > 0
          }))
        )
      };
    },

    async clearRedisSessionQueue(key) {
      const client = await requireRedisClient();
      if (!isSessionQueueKey(key, keyPrefix)) {
        throw new AppError(400, "invalid_redis_queue_key", `Redis key ${key} is not a session queue key.`);
      }

      const sessionId = extractSessionId(key);
      const [deleted, readyRemoved] = await Promise.all([
        client.del(key),
        client.lRem(`${keyPrefix}:runs:ready`, 0, sessionId)
      ]);

      return {
        key,
        changed: deleted > 0 || readyRemoved > 0
      };
    },

    async releaseRedisSessionLock(key) {
      const client = await requireRedisClient();
      if (!isSessionLockKey(key, keyPrefix)) {
        throw new AppError(400, "invalid_redis_lock_key", `Redis key ${key} is not a session lock key.`);
      }

      return {
        key,
        changed: (await client.del(key)) > 0
      };
    },

    async close() {
      const client = await getRedisClient();
      if (client?.isOpen) {
        await client.quit();
      }
    }
  };
}
