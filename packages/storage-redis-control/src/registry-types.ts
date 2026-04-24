import type { RedisClientType } from "redis";

export interface CreateRedisWorkerRegistryOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
}

export interface CreateRedisWorkspacePlacementRegistryOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
}
