import { createClient, type RedisClientType } from "redis";

import type { SessionEvent, SessionEventBus } from "@oah/engine-core";
import type { CreateRedisSessionEventBusOptions } from "./coordination-types.js";

export class RedisSessionEventBus implements SessionEventBus {
  readonly #publisher: RedisClientType;
  readonly #subscriber: RedisClientType;
  readonly #ownsPublisher: boolean;
  readonly #ownsSubscriber: boolean;
  readonly #keyPrefix: string;
  readonly #eventBufferSize: number;
  readonly #eventBufferTtlMs: number;

  constructor(options: CreateRedisSessionEventBusOptions) {
    this.#publisher = options.publisher ?? createClient({ url: options.url });
    this.#subscriber = options.subscriber ?? this.#publisher.duplicate();
    this.#ownsPublisher = !options.publisher;
    this.#ownsSubscriber = !options.subscriber;
    this.#keyPrefix = options.keyPrefix ?? "oah";
    this.#eventBufferSize = Math.max(1, options.eventBufferSize ?? 200);
    this.#eventBufferTtlMs = resolveEventBufferTtlMs(options.eventBufferTtlMs);
  }

  async connect(): Promise<void> {
    if (!this.#publisher.isOpen) {
      await this.#publisher.connect();
    }

    if (!this.#subscriber.isOpen) {
      await this.#subscriber.connect();
    }
  }

  async publish(event: SessionEvent): Promise<void> {
    const payload = JSON.stringify(event);
    const eventsKey = this.#eventsKey(event.sessionId);
    const channel = this.#channel(event.sessionId);

    const transaction = this.#publisher
      .multi()
      .rPush(eventsKey, payload)
      .lTrim(eventsKey, -this.#eventBufferSize, -1);

    if (shouldDeleteEventBufferAfterPublish(event)) {
      transaction.del(eventsKey);
    } else {
      transaction.pExpire(eventsKey, this.#eventBufferTtlMs);
    }

    await transaction.publish(channel, payload).exec();
  }

  async subscribe(sessionId: string, listener: (event: SessionEvent) => void): Promise<() => Promise<void>> {
    const channel = this.#channel(sessionId);
    const handler = (message: string) => {
      listener(JSON.parse(message) as SessionEvent);
    };

    await this.#subscriber.subscribe(channel, handler);

    return async () => {
      if (this.#subscriber.isOpen) {
        await this.#subscriber.unsubscribe(channel, handler);
      }
    };
  }

  async close(): Promise<void> {
    if (this.#ownsSubscriber && this.#subscriber.isOpen) {
      await this.#subscriber.quit();
    }

    if (this.#ownsPublisher && this.#publisher.isOpen) {
      await this.#publisher.quit();
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.#publisher.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  #eventsKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:events`;
  }

  #channel(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:events:pubsub`;
  }
}

function shouldDeleteEventBufferAfterPublish(event: SessionEvent): boolean {
  return event.event === "run.completed" || event.event === "run.failed" || event.event === "run.cancelled";
}

function resolveEventBufferTtlMs(configuredTtlMs: number | undefined): number {
  if (typeof configuredTtlMs === "number" && Number.isFinite(configuredTtlMs) && configuredTtlMs > 0) {
    return Math.floor(configuredTtlMs);
  }

  const raw = process.env.OAH_REDIS_SESSION_EVENT_BUFFER_TTL_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }

  return 7 * 24 * 60 * 60 * 1_000;
}

export async function createRedisSessionEventBus(
  options: CreateRedisSessionEventBusOptions
): Promise<RedisSessionEventBus> {
  const bus = new RedisSessionEventBus(options);
  await bus.connect();
  return bus;
}
