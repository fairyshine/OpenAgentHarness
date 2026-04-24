import type { RedisClientType } from "redis";

export interface CreateRedisSessionRunQueueOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
  blocking?: RedisClientType | undefined;
}
