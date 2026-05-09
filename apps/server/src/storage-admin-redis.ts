import { createClient } from "redis";

export type RedisInspectorClient = ReturnType<typeof createClient>;

const DEFAULT_REDIS_OVERVIEW_KEY_LIMIT = 200;

export function decodeJsonish(value: string): unknown {
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

export async function readRedisKeySize(client: RedisInspectorClient, key: string, type: string): Promise<number | undefined> {
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

export function resolveRedisOverviewKeyLimit(): number {
  const raw = process.env.OAH_STORAGE_ADMIN_REDIS_OVERVIEW_KEY_LIMIT?.trim();
  if (!raw) {
    return DEFAULT_REDIS_OVERVIEW_KEY_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : DEFAULT_REDIS_OVERVIEW_KEY_LIMIT;
}

export async function scanRedisKeysBounded(
  client: RedisInspectorClient,
  pattern: string,
  limit: number
): Promise<{ keys: string[]; truncated: boolean }> {
  const keys: string[] = [];
  const seen = new Set<string>();
  let cursor = "0";
  const count = String(Math.max(1, Math.min(limit, 1_000)));

  do {
    const response = (await client.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", count])) as [string, string[]];
    cursor = response[0];

    for (let index = 0; index < response[1].length; index += 1) {
      const key = response[1][index]!;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      keys.push(key);
      if (keys.length >= limit) {
        return {
          keys,
          truncated: cursor !== "0" || index < response[1].length - 1
        };
      }
    }
  } while (cursor !== "0");

  return {
    keys,
    truncated: false
  };
}

export function extractSessionId(key: string): string {
  const match = key.match(/:session:([^:]+):/u);
  return match?.[1] ?? "unknown";
}

export function isSessionQueueKey(key: string, keyPrefix: string): boolean {
  return key.startsWith(`${keyPrefix}:session:`) && key.endsWith(":queue");
}

export function isSessionLockKey(key: string, keyPrefix: string): boolean {
  return key.startsWith(`${keyPrefix}:session:`) && key.endsWith(":lock");
}
