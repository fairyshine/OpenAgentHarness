import type { RedisClientType } from "redis";

export interface CreateRedisSessionEventBusOptions {
  url: string;
  keyPrefix?: string | undefined;
  eventBufferSize?: number | undefined;
  eventBufferTtlMs?: number | undefined;
  publisher?: RedisClientType | undefined;
  subscriber?: RedisClientType | undefined;
}

export interface CreateRedisSessionRunQueueOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
  blocking?: RedisClientType | undefined;
}
