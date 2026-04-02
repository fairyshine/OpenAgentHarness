import { createClient, type RedisClientType } from "redis";

import { createId, type RunQueue, type SessionEvent, type SessionEventStore } from "@oah/runtime-core";

export interface SessionEventBus {
  publish(event: SessionEvent): Promise<void>;
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): Promise<() => Promise<void> | void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SessionRunQueue extends RunQueue {
  claimNextSession(timeoutMs?: number): Promise<string | undefined>;
  tryAcquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  renewSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, token: string): Promise<boolean>;
  dequeueRun(sessionId: string): Promise<string | undefined>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateRedisSessionEventBusOptions {
  url: string;
  keyPrefix?: string | undefined;
  eventBufferSize?: number | undefined;
  publisher?: RedisClientType | undefined;
  subscriber?: RedisClientType | undefined;
}

export interface CreateRedisSessionRunQueueOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
  blocking?: RedisClientType | undefined;
}

export interface RedisRunWorkerLogger {
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface RedisRunWorkerOptions {
  queue: SessionRunQueue;
  runtimeService: {
    processQueuedRun(runId: string): Promise<void>;
    recoverStaleRuns?(options?: { staleBefore?: string | undefined; limit?: number | undefined }): Promise<{ recoveredRunIds: string[] }>;
  };
  workerId?: string | undefined;
  lockTtlMs?: number | undefined;
  pollTimeoutMs?: number | undefined;
  recoveryGraceMs?: number | undefined;
  logger?: RedisRunWorkerLogger | undefined;
}

const compareAndDeleteScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const compareAndExpireScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

export class RedisSessionEventBus implements SessionEventBus {
  readonly #publisher: RedisClientType;
  readonly #subscriber: RedisClientType;
  readonly #ownsPublisher: boolean;
  readonly #ownsSubscriber: boolean;
  readonly #keyPrefix: string;
  readonly #eventBufferSize: number;

  constructor(options: CreateRedisSessionEventBusOptions) {
    this.#publisher = options.publisher ?? createClient({ url: options.url });
    this.#subscriber = options.subscriber ?? this.#publisher.duplicate();
    this.#ownsPublisher = !options.publisher;
    this.#ownsSubscriber = !options.subscriber;
    this.#keyPrefix = options.keyPrefix ?? "oah";
    this.#eventBufferSize = Math.max(1, options.eventBufferSize ?? 200);
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

    await this.#publisher
      .multi()
      .rPush(eventsKey, payload)
      .lTrim(eventsKey, -this.#eventBufferSize, -1)
      .publish(channel, payload)
      .exec();
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

export class RedisSessionRunQueue implements SessionRunQueue {
  readonly #commands: RedisClientType;
  readonly #blocking: RedisClientType;
  readonly #ownsCommands: boolean;
  readonly #ownsBlocking: boolean;
  readonly #keyPrefix: string;

  constructor(options: CreateRedisSessionRunQueueOptions) {
    this.#commands = options.commands ?? createClient({ url: options.url });
    this.#blocking = options.blocking ?? this.#commands.duplicate();
    this.#ownsCommands = !options.commands;
    this.#ownsBlocking = !options.blocking;
    this.#keyPrefix = options.keyPrefix ?? "oah";
  }

  async connect(): Promise<void> {
    if (!this.#commands.isOpen) {
      await this.#commands.connect();
    }

    if (!this.#blocking.isOpen) {
      await this.#blocking.connect();
    }
  }

  async enqueue(sessionId: string, runId: string): Promise<void> {
    const queueLength = await this.#commands.rPush(this.#sessionQueueKey(sessionId), runId);
    if (queueLength === 1) {
      await this.#commands.rPush(this.#readyQueueKey(), sessionId);
    }
  }

  async claimNextSession(timeoutMs = 1_000): Promise<string | undefined> {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
    const entry = await this.#blocking.blPop(this.#readyQueueKey(), timeoutSeconds);
    return entry?.element;
  }

  async tryAcquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.#commands.set(this.#lockKey(sessionId), token, {
      NX: true,
      PX: ttlMs
    });

    return result === "OK";
  }

  async renewSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.#commands.eval(compareAndExpireScript, {
      keys: [this.#lockKey(sessionId)],
      arguments: [token, String(ttlMs)]
    });

    return Number(result) === 1;
  }

  async releaseSessionLock(sessionId: string, token: string): Promise<boolean> {
    const result = await this.#commands.eval(compareAndDeleteScript, {
      keys: [this.#lockKey(sessionId)],
      arguments: [token]
    });

    return Number(result) === 1;
  }

  async dequeueRun(sessionId: string): Promise<string | undefined> {
    return (await this.#commands.lPop(this.#sessionQueueKey(sessionId))) ?? undefined;
  }

  async close(): Promise<void> {
    if (this.#ownsBlocking && this.#blocking.isOpen) {
      await this.#blocking.quit();
    }

    if (this.#ownsCommands && this.#commands.isOpen) {
      await this.#commands.quit();
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.#commands.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  #readyQueueKey(): string {
    return `${this.#keyPrefix}:runs:ready`;
  }

  #sessionQueueKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:queue`;
  }

  #lockKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:lock`;
  }
}

export class RedisRunWorker {
  readonly #queue: SessionRunQueue;
  readonly #runtimeService: RedisRunWorkerOptions["runtimeService"];
  readonly #workerId: string;
  readonly #lockTtlMs: number;
  readonly #pollTimeoutMs: number;
  readonly #recoveryGraceMs: number;
  readonly #logger?: RedisRunWorkerLogger | undefined;
  #loop: Promise<void> | undefined;
  #active = false;

  constructor(options: RedisRunWorkerOptions) {
    this.#queue = options.queue;
    this.#runtimeService = options.runtimeService;
    this.#workerId = options.workerId ?? createId("worker");
    this.#lockTtlMs = Math.max(1_000, options.lockTtlMs ?? 30_000);
    this.#pollTimeoutMs = Math.max(250, options.pollTimeoutMs ?? 1_000);
    this.#recoveryGraceMs = Math.max(this.#lockTtlMs, options.recoveryGraceMs ?? this.#lockTtlMs * 2);
    this.#logger = options.logger;
  }

  start(): void {
    if (this.#loop) {
      return;
    }

    this.#active = true;
    this.#loop = this.#runLoop();
  }

  async close(): Promise<void> {
    this.#active = false;
    await this.#loop;
  }

  async #runLoop(): Promise<void> {
    if (this.#runtimeService.recoverStaleRuns) {
      try {
        await this.#runtimeService.recoverStaleRuns({
          staleBefore: new Date(Date.now() - this.#recoveryGraceMs).toISOString()
        });
      } catch (error) {
        this.#logger?.warn("Failed to recover stale runs during worker startup.", error);
      }
    }

    while (this.#active) {
      let sessionId: string | undefined;
      try {
        sessionId = await this.#queue.claimNextSession(this.#pollTimeoutMs);
      } catch (error) {
        this.#logger?.warn("Failed to claim next Redis run queue item.", error);
        continue;
      }

      if (!sessionId) {
        continue;
      }

      const lockToken = `${this.#workerId}:${createId("lock")}`;
      let acquired = false;
      try {
        acquired = await this.#queue.tryAcquireSessionLock(sessionId, lockToken, this.#lockTtlMs);
      } catch (error) {
        this.#logger?.warn(`Failed to acquire Redis session lock for ${sessionId}.`, error);
        continue;
      }

      if (!acquired) {
        continue;
      }

      const heartbeat = setInterval(() => {
        void this.#queue.renewSessionLock(sessionId, lockToken, this.#lockTtlMs).then(
          (renewed) => {
            if (!renewed) {
              this.#logger?.warn(`Redis session lock renewal lost for ${sessionId}.`);
            }
          },
          (error) => {
            this.#logger?.warn(`Failed to renew Redis session lock for ${sessionId}.`, error);
          }
        );
      }, Math.max(1_000, Math.floor(this.#lockTtlMs / 3)));
      heartbeat.unref?.();

      try {
        while (this.#active) {
          const runId = await this.#queue.dequeueRun(sessionId);
          if (!runId) {
            break;
          }

          try {
            await this.#runtimeService.processQueuedRun(runId);
          } catch (error) {
            this.#logger?.error(`Failed to process queued run ${runId}.`, error);
          }
        }
      } finally {
        clearInterval(heartbeat);
        try {
          await this.#queue.releaseSessionLock(sessionId, lockToken);
        } catch (error) {
          this.#logger?.warn(`Failed to release Redis session lock for ${sessionId}.`, error);
        }
      }
    }
  }
}

export class FanoutSessionEventStore implements SessionEventStore {
  readonly #primary: SessionEventStore;
  readonly #bus: SessionEventBus;

  constructor(primary: SessionEventStore, bus: SessionEventBus) {
    this.#primary = primary;
    this.#bus = bus;
  }

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.#primary.append(input);
    await this.#bus.publish(event);
    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    return this.#primary.listSince(sessionId, cursor, runId);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const seen = new Set<string>();
    const order: string[] = [];
    let active = true;
    let unsubscribeSecondary: (() => Promise<void> | void) | undefined;

    const forward = (event: SessionEvent) => {
      if (!active || event.sessionId !== sessionId || seen.has(event.id)) {
        return;
      }

      seen.add(event.id);
      order.push(event.id);
      if (order.length > 1024) {
        const oldest = order.shift();
        if (oldest) {
          seen.delete(oldest);
        }
      }

      listener(event);
    };

    const unsubscribePrimary = this.#primary.subscribe(sessionId, forward);

    void this.#bus.subscribe(sessionId, forward).then(
      (unsubscribe) => {
        if (!active) {
          void unsubscribe();
          return;
        }

        unsubscribeSecondary = unsubscribe;
      },
      () => undefined
    );

    return () => {
      active = false;
      unsubscribePrimary();
      void unsubscribeSecondary?.();
    };
  }
}

export async function createRedisSessionEventBus(
  options: CreateRedisSessionEventBusOptions
): Promise<RedisSessionEventBus> {
  const bus = new RedisSessionEventBus(options);
  await bus.connect();
  return bus;
}

export async function createRedisSessionRunQueue(
  options: CreateRedisSessionRunQueueOptions
): Promise<RedisSessionRunQueue> {
  const queue = new RedisSessionRunQueue(options);
  await queue.connect();
  return queue;
}
