import type { Pool } from "pg";
import { createClient } from "redis";

import { AppError } from "@oah/runtime-core";
import type {
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisDeleteKeyResponse,
  StorageRedisKeyDetail,
  StorageRedisKeyPage
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
    description: "Persisted session messages."
  },
  run_steps: {
    orderBy: "coalesce(started_at, ended_at) desc nulls last, seq desc, id asc",
    description: "Per-run step audit trail, including model/tool/hook steps."
  },
  session_events: {
    orderBy: "cursor desc",
    description: "SSE/session event log."
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
  }
} satisfies Record<StoragePostgresTableName, { orderBy: string; description: string }>;

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

export interface StorageAdmin {
  overview(): Promise<StorageOverview>;
  postgresTable(table: StoragePostgresTableName, limit: number): Promise<StoragePostgresTablePage>;
  redisKeys(pattern: string, cursor: string | undefined, pageSize: number): Promise<StorageRedisKeyPage>;
  redisKeyDetail(key: string): Promise<StorageRedisKeyDetail>;
  deleteRedisKey(key: string): Promise<StorageRedisDeleteKeyResponse>;
  close(): Promise<void>;
}

export function createStorageAdmin(options: {
  postgresPool?: Pool | undefined;
  redisUrl?: string | undefined;
  redisAvailable: boolean;
  redisEventBusEnabled: boolean;
  redisRunQueueEnabled: boolean;
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

      const [databaseResult, tableSummaries] = postgresSummary ?? [];
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
          tables: tableSummaries ?? []
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

    async postgresTable(table, limit) {
      const pool = await requirePostgresPool();
      const config = POSTGRES_TABLE_CONFIG[table as PostgresTableConfigName];
      const safeLimit = Math.max(1, Math.min(200, limit));
      const [countResult, rowsResult] = await Promise.all([
        pool.query<{ count: string }>(`select count(*)::text as count from ${table}`),
        pool.query<Record<string, unknown>>(`select * from ${table} order by ${config.orderBy} limit ${safeLimit}`)
      ]);

      const columns = Array.from(new Set(rowsResult.fields.map((field) => field.name)));

      return {
        table,
        rowCount: Number.parseInt(countResult.rows[0]?.count ?? "0", 10),
        orderBy: config.orderBy,
        columns,
        rows: rowsResult.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Date ? value.toISOString() : value === undefined ? null : value
            ])
          )
        )
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

    async close() {
      const client = await getRedisClient();
      if (client?.isOpen) {
        await client.quit();
      }
    }
  };
}
