import { createClient, type RedisClientType } from "redis";

import { createId, type RunQueue, type RunQueuePriority, type SessionEvent, type SessionEventStore } from "@oah/runtime-core";
import { calculateRedisWorkerPoolSuggestion, summarizeRedisWorkerLoad } from "./worker-pool-policy.js";

export {
  calculateRedisWorkerPoolSuggestion,
  summarizeRedisWorkerLoad,
  type RedisRunWorkerPoolSizingInput,
  type RedisRunWorkerPoolSizingResult,
  type RedisWorkerLoadSummary
} from "./worker-pool-policy.js";

export interface SessionEventBus {
  publish(event: SessionEvent): Promise<void>;
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): Promise<() => Promise<void> | void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SessionRunQueue extends RunQueue {
  claimNextSession(timeoutMs?: number): Promise<string | undefined>;
  readyQueueLength(): Promise<number>;
  inspectReadyQueue(nowMs?: number): Promise<{
    length: number;
    subagentLength: number;
    oldestReadyAgeMs: number;
    averageReadyAgeMs: number;
  }>;
  tryAcquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  renewSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, token: string): Promise<boolean>;
  dequeueRun(sessionId: string): Promise<string | undefined>;
  requeueSessionIfPending?(sessionId: string): Promise<boolean>;
  getSchedulingPressure?(): Promise<SessionRunQueuePressure>;
  getReadySessionCount?(): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SessionRunQueuePressure {
  readySessionCount: number;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
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

export interface CreateRedisWorkerRegistryOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
}

export interface RedisRunWorkerLogger {
  info?(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface RedisWorkerLeaseInput {
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  lastSeenAt: string;
  currentSessionId?: string | undefined;
}

export interface RedisWorkerRegistryEntry extends RedisWorkerLeaseInput {
  leaseTtlMs: number;
  expiresAt: string;
  lastSeenAgeMs: number;
  health: "healthy" | "late";
}

export interface WorkerRegistry {
  heartbeat(entry: RedisWorkerLeaseInput, ttlMs: number): Promise<void>;
  remove(workerId: string): Promise<void>;
  listActive?(nowMs?: number): Promise<RedisWorkerRegistryEntry[]>;
}

export interface RedisRunWorkerOptions {
  queue: SessionRunQueue;
  runtimeService: {
    processQueuedRun(runId: string): Promise<void>;
    recoverStaleRuns?(options?: {
      staleBefore?: string | undefined;
      limit?: number | undefined;
    }): Promise<{ recoveredRunIds: string[]; requeuedRunIds?: string[] }>;
  };
  workerId?: string | undefined;
  processKind?: "embedded" | "standalone" | undefined;
  lockTtlMs?: number | undefined;
  pollTimeoutMs?: number | undefined;
  recoveryGraceMs?: number | undefined;
  registry?: WorkerRegistry | undefined;
  recoverOnStart?: boolean | undefined;
  logger?: RedisRunWorkerLogger | undefined;
  onStateChange?:
    | ((entry: {
        workerId: string;
        state: "starting" | "idle" | "busy" | "stopping";
        currentSessionId?: string | undefined;
      }) => void)
    | undefined;
}

export interface RedisRunWorkerPoolOptions extends Omit<RedisRunWorkerOptions, "workerId" | "queue"> {
  queue: SessionRunQueue;
  queueFactory?: (() => Promise<SessionRunQueue>) | undefined;
  minWorkers?: number | undefined;
  maxWorkers?: number | undefined;
  scaleIntervalMs?: number | undefined;
  readySessionsPerWorker?: number | undefined;
  scaleUpCooldownMs?: number | undefined;
  scaleDownCooldownMs?: number | undefined;
  scaleUpSampleSize?: number | undefined;
  scaleDownSampleSize?: number | undefined;
  scaleUpBusyRatioThreshold?: number | undefined;
  scaleUpMaxReadyAgeMs?: number | undefined;
}

export interface RedisRunWorkerPoolDecision {
  timestamp: string;
  reason: "startup" | "steady" | "scale_up" | "scale_down" | "cooldown_hold" | "shutdown";
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  desiredWorkers: number;
  activeWorkers: number;
  busyWorkers?: number | undefined;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface RedisRunWorkerPoolSlotSnapshot {
  slotId: string;
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  currentSessionId?: string | undefined;
}

export interface RedisRunWorkerPoolSnapshot {
  running: boolean;
  processKind: "embedded" | "standalone";
  sessionSerialBoundary: "session";
  minWorkers: number;
  maxWorkers: number;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  desiredWorkers: number;
  slotCapacity: number;
  slots: RedisRunWorkerPoolSlotSnapshot[];
  activeWorkers: number;
  busySlots: number;
  idleSlots: number;
  busyWorkers: number;
  idleWorkers: number;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionsPerWorker: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
  lastRebalanceAt?: string | undefined;
  lastRebalanceReason?:
    | "startup"
    | "steady"
    | "scale_up"
    | "scale_down"
    | "cooldown_hold"
    | "shutdown"
    | undefined;
  scaleUpPressureStreak: number;
  scaleDownPressureStreak: number;
  scaleUpCooldownRemainingMs: number;
  scaleDownCooldownRemainingMs: number;
  recentDecisions: RedisRunWorkerPoolDecision[];
}

const compareAndDeleteScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const enqueueSessionRunScript = `
local queueLength = redis.call("rpush", KEYS[1], ARGV[1])
if queueLength == 1 then
  redis.call("set", KEYS[3], ARGV[3], "NX")
  redis.call("set", KEYS[4], ARGV[4])
  local alreadyReady = false
  local readyEntries = redis.call("lrange", KEYS[2], 0, -1)
  for _, readySessionId in ipairs(readyEntries) do
    if readySessionId == ARGV[2] then
      alreadyReady = true
      break
    end
  end
  if not alreadyReady then
    if ARGV[4] == "subagent" then
      redis.call("lpush", KEYS[2], ARGV[2])
    else
      redis.call("rpush", KEYS[2], ARGV[2])
    end
  end
end
return queueLength
`;

const DEFAULT_WORKER_LEASE_TTL_MS = 5_000;

function deriveRedisWorkerRegistryEntry(
  entry: RedisWorkerLeaseInput & {
    leaseTtlMs?: number | undefined;
    expiresAt?: string | undefined;
  },
  nowMs: number
): RedisWorkerRegistryEntry {
  const parsedLastSeenAtMs = Date.parse(entry.lastSeenAt);
  const lastSeenAtMs = Number.isFinite(parsedLastSeenAtMs) ? parsedLastSeenAtMs : 0;
  const leaseTtlMs =
    typeof entry.leaseTtlMs === "number" && Number.isFinite(entry.leaseTtlMs) && entry.leaseTtlMs > 0
      ? Math.floor(entry.leaseTtlMs)
      : DEFAULT_WORKER_LEASE_TTL_MS;
  const parsedExpiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  const expiresAtMs =
    Number.isFinite(parsedExpiresAtMs) && parsedExpiresAtMs >= lastSeenAtMs
      ? parsedExpiresAtMs
      : lastSeenAtMs + leaseTtlMs;
  const lastSeenAgeMs = Math.max(0, nowMs - lastSeenAtMs);
  const lateThresholdMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));

  return {
    workerId: entry.workerId,
    processKind: entry.processKind,
    state: entry.state,
    lastSeenAt: new Date(lastSeenAtMs).toISOString(),
    leaseTtlMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    lastSeenAgeMs,
    health: expiresAtMs - nowMs <= lateThresholdMs ? "late" : "healthy",
    ...(entry.currentSessionId ? { currentSessionId: entry.currentSessionId } : {})
  };
}

function calculateWorkerLeaseTtlMs(lockTtlMs: number, pollTimeoutMs: number): number {
  return Math.max(DEFAULT_WORKER_LEASE_TTL_MS, lockTtlMs * 2, pollTimeoutMs * 4);
}

export class RedisWorkerRegistry implements WorkerRegistry {
  readonly #commands: RedisClientType;
  readonly #ownsCommands: boolean;
  readonly #keyPrefix: string;

  constructor(options: CreateRedisWorkerRegistryOptions) {
    this.#commands = options.commands ?? createClient({ url: options.url });
    this.#ownsCommands = !options.commands;
    this.#keyPrefix = options.keyPrefix ?? "oah";
  }

  async connect(): Promise<void> {
    if (!this.#commands.isOpen) {
      await this.#commands.connect();
    }
  }

  async heartbeat(entry: RedisWorkerLeaseInput, ttlMs: number): Promise<void> {
    const leaseTtlMs = Math.max(1_000, Math.floor(ttlMs));
    const lastSeenAtMs = Number.isFinite(Date.parse(entry.lastSeenAt)) ? Date.parse(entry.lastSeenAt) : 0;
    const expiresAt = new Date(lastSeenAtMs + leaseTtlMs).toISOString();
    const transaction = this.#commands
      .multi()
      .sAdd(this.#registrySetKey(), entry.workerId)
      .hSet(this.#workerKey(entry.workerId), {
        workerId: entry.workerId,
        processKind: entry.processKind,
        state: entry.state,
        lastSeenAt: entry.lastSeenAt,
        leaseTtlMs: String(leaseTtlMs),
        expiresAt,
        ...(entry.currentSessionId ? { currentSessionId: entry.currentSessionId } : {})
      });
    if (!entry.currentSessionId) {
      transaction.hDel(this.#workerKey(entry.workerId), "currentSessionId");
    }
    await transaction.pExpire(this.#workerKey(entry.workerId), leaseTtlMs).exec();
  }

  async remove(workerId: string): Promise<void> {
    await this.#commands.multi().sRem(this.#registrySetKey(), workerId).del(this.#workerKey(workerId)).exec();
  }

  async listActive(nowMs = Date.now()): Promise<RedisWorkerRegistryEntry[]> {
    const workerIds = await this.#commands.sMembers(this.#registrySetKey());
    if (workerIds.length === 0) {
      return [];
    }

    const records = await Promise.all(
      workerIds.map(async (workerId) => ({
        workerId,
        fields: await this.#commands.hGetAll(this.#workerKey(workerId))
      }))
    );

    const activeEntries: RedisWorkerRegistryEntry[] = [];
    const missingWorkerIds: string[] = [];

    for (const record of records) {
      if (Object.keys(record.fields).length === 0) {
        missingWorkerIds.push(record.workerId);
        continue;
      }

      const entry: RedisWorkerRegistryEntry = {
        ...deriveRedisWorkerRegistryEntry(
          {
            workerId: record.fields.workerId ?? record.workerId,
            processKind: record.fields.processKind === "standalone" ? "standalone" : "embedded",
            state:
              record.fields.state === "starting" ||
              record.fields.state === "busy" ||
              record.fields.state === "stopping"
                ? record.fields.state
                : "idle",
            lastSeenAt: record.fields.lastSeenAt ?? new Date(0).toISOString(),
            leaseTtlMs: record.fields.leaseTtlMs ? Number(record.fields.leaseTtlMs) : undefined,
            expiresAt: record.fields.expiresAt,
            ...(record.fields.currentSessionId ? { currentSessionId: record.fields.currentSessionId } : {})
          },
          nowMs
        )
      };
      activeEntries.push(entry);
    }

    if (missingWorkerIds.length > 0) {
      await this.#commands.sRem(this.#registrySetKey(), missingWorkerIds);
    }

    return activeEntries.sort((left, right) => left.workerId.localeCompare(right.workerId));
  }

  async close(): Promise<void> {
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

  #registrySetKey(): string {
    return `${this.#keyPrefix}:workers:registry`;
  }

  #workerKey(workerId: string): string {
    return `${this.#keyPrefix}:worker:${workerId}`;
  }
}

const compareAndExpireScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const requeuePendingSessionScript = `
if redis.call("llen", KEYS[1]) > 0 then
  local readyEntries = redis.call("lrange", KEYS[2], 0, -1)
  for _, readySessionId in ipairs(readyEntries) do
    if readySessionId == ARGV[1] then
      return 0
    end
  end
  redis.call("rpush", KEYS[2], ARGV[1])
  return 1
end
return 0
`;

const inspectSchedulingPressureScript = `
local readyEntries = redis.call("lrange", KEYS[1], 0, -1)
local readyQueueDepth = #readyEntries
local uniqueReady = 0
local schedulable = 0
local lockedReady = 0
local staleReady = 0
local oldestSchedulableReadyAgeMs = 0
local seen = {}

for _, sessionId in ipairs(readyEntries) do
  if not seen[sessionId] then
    seen[sessionId] = true
    uniqueReady = uniqueReady + 1

    local sessionQueueKey = ARGV[1] .. sessionId .. ARGV[2]
    local pendingRunCount = redis.call("llen", sessionQueueKey)

    if pendingRunCount <= 0 then
      staleReady = staleReady + 1
    else
      local sessionLockKey = ARGV[1] .. sessionId .. ARGV[3]
      if redis.call("exists", sessionLockKey) == 1 then
        lockedReady = lockedReady + 1
      else
        schedulable = schedulable + 1
        local readyAtKey = ARGV[1] .. sessionId .. ARGV[4]
        local readyAtMs = tonumber(redis.call("get", readyAtKey))
        if readyAtMs ~= nil then
          local waitAgeMs = tonumber(ARGV[5]) - readyAtMs
          if waitAgeMs > oldestSchedulableReadyAgeMs then
            oldestSchedulableReadyAgeMs = waitAgeMs
          end
        end
      end
    end
  end
end

return { schedulable, readyQueueDepth, uniqueReady, lockedReady, staleReady, oldestSchedulableReadyAgeMs }
`;

const dequeueSessionRunScript = `
local runId = redis.call("lpop", KEYS[1])
if not runId then
  return false
end
if redis.call("llen", KEYS[1]) == 0 then
  redis.call("del", KEYS[2], KEYS[3])
end
return runId
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

  async enqueue(sessionId: string, runId: string, options?: { priority?: RunQueuePriority | undefined }): Promise<void> {
    const priority = options?.priority ?? "normal";
    const queueLength = Number(
      await this.#commands.eval(enqueueSessionRunScript, {
        keys: [
          this.#sessionQueueKey(sessionId),
          this.#readyQueueKey(),
          this.#readyAtKey(sessionId),
          this.#readyPriorityKey(sessionId)
        ],
        arguments: [runId, sessionId, String(Date.now()), priority]
      })
    );
    if (queueLength === 1) {
      return;
    }
  }

  async claimNextSession(timeoutMs = 1_000): Promise<string | undefined> {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
    const entry = await this.#blocking.blPop(this.#readyQueueKey(), timeoutSeconds);
    return entry?.element;
  }

  async readyQueueLength(): Promise<number> {
    return this.#commands.lLen(this.#readyQueueKey());
  }

  async inspectReadyQueue(nowMs = Date.now()): Promise<{
    length: number;
    subagentLength: number;
    oldestReadyAgeMs: number;
    averageReadyAgeMs: number;
  }> {
    const sessionIds = await this.#commands.lRange(this.#readyQueueKey(), 0, -1);
    if (sessionIds.length === 0) {
      return {
        length: 0,
        subagentLength: 0,
        oldestReadyAgeMs: 0,
        averageReadyAgeMs: 0
      };
    }

    const [readySinceValues, readyPriorityValues] = await Promise.all([
      this.#commands.mGet(sessionIds.map((sessionId) => this.#readyAtKey(sessionId))),
      this.#commands.mGet(sessionIds.map((sessionId) => this.#readyPriorityKey(sessionId)))
    ]);
    const ages = readySinceValues
      .map((value) => {
        if (!value) {
          return undefined;
        }

        const readySinceMs = Number.parseInt(value, 10);
        return Number.isFinite(readySinceMs) ? Math.max(0, nowMs - readySinceMs) : undefined;
      })
      .filter((value): value is number => value !== undefined);

    if (ages.length === 0) {
      return {
        length: sessionIds.length,
        subagentLength: readyPriorityValues.filter((value) => value === "subagent").length,
        oldestReadyAgeMs: 0,
        averageReadyAgeMs: 0
      };
    }

    const totalAgeMs = ages.reduce((sum, ageMs) => sum + ageMs, 0);
    return {
      length: sessionIds.length,
      subagentLength: readyPriorityValues.filter((value) => value === "subagent").length,
      oldestReadyAgeMs: Math.max(...ages),
      averageReadyAgeMs: Math.round(totalAgeMs / ages.length)
    };
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
    const runId = await this.#commands.eval(dequeueSessionRunScript, {
      keys: [this.#sessionQueueKey(sessionId), this.#readyAtKey(sessionId), this.#readyPriorityKey(sessionId)]
    });

    return typeof runId === "string" ? runId : undefined;
  }

  async requeueSessionIfPending(sessionId: string): Promise<boolean> {
    const result = await this.#commands.eval(requeuePendingSessionScript, {
      keys: [this.#sessionQueueKey(sessionId), this.#readyQueueKey()],
      arguments: [sessionId]
    });

    return Number(result) === 1;
  }

  async getSchedulingPressure(): Promise<SessionRunQueuePressure> {
    const [
      readySessionCount,
      readyQueueDepth,
      uniqueReadySessionCount,
      lockedReadySessionCount,
      staleReadySessionCount,
      oldestSchedulableReadyAgeMs
    ] = (
      await this.#commands.eval(inspectSchedulingPressureScript, {
        keys: [this.#readyQueueKey()],
        arguments: [`${this.#keyPrefix}:session:`, ":queue", ":lock", ":ready_at", String(Date.now())]
      })
    ) as number[];

    return {
      readySessionCount: Number(readySessionCount),
      readyQueueDepth: Number(readyQueueDepth),
      uniqueReadySessionCount: Number(uniqueReadySessionCount),
      lockedReadySessionCount: Number(lockedReadySessionCount),
      staleReadySessionCount: Number(staleReadySessionCount)
      ,
      oldestSchedulableReadyAgeMs: Number(oldestSchedulableReadyAgeMs)
    };
  }

  async getReadySessionCount(): Promise<number> {
    return await this.#commands.lLen(this.#readyQueueKey());
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

  #readyPriorityKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:ready-priority`;
  }

  #readyAtKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:ready_at`;
  }
}

export class RedisRunWorker {
  readonly #queue: SessionRunQueue;
  readonly #runtimeService: RedisRunWorkerOptions["runtimeService"];
  readonly #workerId: string;
  readonly #processKind: "embedded" | "standalone";
  readonly #lockTtlMs: number;
  readonly #pollTimeoutMs: number;
  readonly #recoveryGraceMs: number;
  readonly #leaseTtlMs: number;
  readonly #registry?: WorkerRegistry | undefined;
  readonly #recoverOnStart: boolean;
  readonly #logger?: RedisRunWorkerLogger | undefined;
  readonly #onStateChange:
    | ((entry: {
        workerId: string;
        state: "starting" | "idle" | "busy" | "stopping";
        currentSessionId?: string | undefined;
      }) => void)
    | undefined;
  #loop: Promise<void> | undefined;
  #active = false;
  #state: "starting" | "idle" | "busy" | "stopping" = "starting";
  #currentSessionId: string | undefined;

  constructor(options: RedisRunWorkerOptions) {
    this.#queue = options.queue;
    this.#runtimeService = options.runtimeService;
    this.#workerId = options.workerId ?? createId("worker");
    this.#processKind = options.processKind ?? "embedded";
    this.#lockTtlMs = Math.max(1_000, options.lockTtlMs ?? 30_000);
    this.#pollTimeoutMs = Math.max(250, options.pollTimeoutMs ?? 1_000);
    this.#recoveryGraceMs = Math.max(this.#lockTtlMs, options.recoveryGraceMs ?? this.#lockTtlMs * 2);
    this.#leaseTtlMs = calculateWorkerLeaseTtlMs(this.#lockTtlMs, this.#pollTimeoutMs);
    this.#registry = options.registry;
    this.#recoverOnStart = options.recoverOnStart ?? true;
    this.#logger = options.logger;
    this.#onStateChange = options.onStateChange;
  }

  start(): void {
    if (this.#loop) {
      return;
    }

    this.#active = true;
    this.#notifyStateChange();
    this.#loop = this.#runLoop();
  }

  async close(): Promise<void> {
    this.#active = false;
    this.#setState("stopping");
    await this.#publishLease();
    await this.#loop;
  }

  async #runLoop(): Promise<void> {
    await this.#publishLease();
    const leaseHeartbeat = setInterval(() => {
      void this.#publishLease();
    }, Math.max(1_000, Math.floor(this.#leaseTtlMs / 3)));
    leaseHeartbeat.unref?.();

    if (this.#recoverOnStart && this.#runtimeService.recoverStaleRuns) {
      try {
        await this.#runtimeService.recoverStaleRuns({
          staleBefore: new Date(Date.now() - this.#recoveryGraceMs).toISOString()
        });
      } catch (error) {
        this.#logger?.warn("Failed to recover stale runs during worker startup.", error);
      }
    }

    this.#setState("idle");
    await this.#publishLease();

    try {
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
          await this.#restoreClaimedSession(sessionId);
          continue;
        }

        this.#setState("busy", sessionId);
        await this.#publishLease();

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
          this.#setState(this.#active ? "idle" : "stopping");
          await this.#publishLease();
          try {
            await this.#queue.releaseSessionLock(sessionId, lockToken);
          } catch (error) {
            this.#logger?.warn(`Failed to release Redis session lock for ${sessionId}.`, error);
          }
        }
      }
    } finally {
      clearInterval(leaseHeartbeat);
      await this.#registry?.remove(this.#workerId).catch((error) => {
        this.#logger?.warn(`Failed to remove worker lease for ${this.#workerId}.`, error);
      });
    }
  }

  async #publishLease(): Promise<void> {
    if (!this.#registry) {
      return;
    }

    try {
      await this.#registry.heartbeat(
        {
          workerId: this.#workerId,
          processKind: this.#processKind,
          state: this.#state,
          lastSeenAt: new Date().toISOString(),
          ...(this.#currentSessionId ? { currentSessionId: this.#currentSessionId } : {})
        },
        this.#leaseTtlMs
      );
    } catch (error) {
      this.#logger?.warn(`Failed to publish worker lease for ${this.#workerId}.`, error);
    }
  }

  async #restoreClaimedSession(sessionId: string): Promise<void> {
    if (typeof this.#queue.requeueSessionIfPending !== "function") {
      return;
    }

    try {
      await this.#queue.requeueSessionIfPending(sessionId);
    } catch (error) {
      this.#logger?.warn(`Failed to restore claimed Redis session ${sessionId} back to the ready queue.`, error);
    }
  }

  #setState(nextState: "starting" | "idle" | "busy" | "stopping", currentSessionId?: string): void {
    if (this.#state === nextState && this.#currentSessionId === currentSessionId) {
      return;
    }

    this.#state = nextState;
    this.#currentSessionId = currentSessionId;
    this.#notifyStateChange();
  }

  #notifyStateChange(): void {
    this.#onStateChange?.({
      workerId: this.#workerId,
      state: this.#state,
      ...(this.#currentSessionId ? { currentSessionId: this.#currentSessionId } : {})
    });
  }
}

export class RedisRunWorkerPool {
  readonly #queue: SessionRunQueue;
  readonly #queueFactory?: (() => Promise<SessionRunQueue>) | undefined;
  readonly #runtimeService: RedisRunWorkerOptions["runtimeService"];
  readonly #processKind: "embedded" | "standalone";
  readonly #lockTtlMs: number;
  readonly #pollTimeoutMs: number;
  readonly #recoveryGraceMs: number;
  readonly #registry?: WorkerRegistry | undefined;
  readonly #logger?: RedisRunWorkerLogger | undefined;
  readonly #minWorkers: number;
  readonly #maxWorkers: number;
  readonly #scaleIntervalMs: number;
  readonly #readySessionsPerWorker: number;
  readonly #scaleUpCooldownMs: number;
  readonly #scaleDownCooldownMs: number;
  readonly #scaleUpSampleSize: number;
  readonly #scaleDownSampleSize: number;
  readonly #scaleUpBusyRatioThreshold: number;
  readonly #scaleUpMaxReadyAgeMs: number;
  readonly #workers: Array<{
    workerId: string;
    worker: RedisRunWorker;
    queue: SessionRunQueue;
    ownsQueue: boolean;
  }> = [];
  readonly #workerSlots = new Map<string, RedisRunWorkerPoolSlotSnapshot>();
  #active = false;
  #scaleTimer: NodeJS.Timeout | undefined;
  #rebalancePromise: Promise<void> | undefined;
  #lastLoggedState:
    | {
        desiredWorkers: number;
        activeWorkers: number;
      }
    | undefined;
  #lastReadySessionCount: number | undefined;
  #lastReadyQueueDepth: number | undefined;
  #lastUniqueReadySessionCount: number | undefined;
  #lastLockedReadySessionCount: number | undefined;
  #lastStaleReadySessionCount: number | undefined;
  #lastOldestSchedulableReadyAgeMs: number | undefined;
  #lastGlobalSuggestedWorkers: number | undefined;
  #lastGlobalActiveWorkers: number | undefined;
  #lastGlobalBusyWorkers: number | undefined;
  #lastRemoteActiveWorkers: number | undefined;
  #lastRemoteBusyWorkers: number | undefined;
  #lastRebalanceAtMs: number | undefined;
  #lastRebalanceReason: RedisRunWorkerPoolSnapshot["lastRebalanceReason"];
  #lastScaleUpAtMs: number | undefined;
  #lastScaleDownAtMs: number | undefined;
  #scaleUpPressureStreak = 0;
  #scaleDownPressureStreak = 0;
  #suggestedWorkers = 0;
  #desiredWorkers = 0;
  #recentDecisions: RedisRunWorkerPoolDecision[] = [];

  constructor(options: RedisRunWorkerPoolOptions) {
    this.#queue = options.queue;
    this.#queueFactory = options.queueFactory;
    this.#runtimeService = options.runtimeService;
    this.#processKind = options.processKind ?? "embedded";
    this.#lockTtlMs = Math.max(1_000, options.lockTtlMs ?? 30_000);
    this.#pollTimeoutMs = Math.max(250, options.pollTimeoutMs ?? 1_000);
    this.#recoveryGraceMs = Math.max(this.#lockTtlMs, options.recoveryGraceMs ?? this.#lockTtlMs * 2);
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#minWorkers = Math.max(1, Math.floor(options.minWorkers ?? 1));
    this.#maxWorkers = Math.max(this.#minWorkers, Math.floor(options.maxWorkers ?? this.#minWorkers));
    this.#scaleIntervalMs = Math.max(1_000, Math.floor(options.scaleIntervalMs ?? 5_000));
    this.#readySessionsPerWorker = Math.max(1, Math.floor(options.readySessionsPerWorker ?? 1));
    this.#scaleUpCooldownMs = Math.max(0, Math.floor(options.scaleUpCooldownMs ?? 1_000));
    this.#scaleDownCooldownMs = Math.max(0, Math.floor(options.scaleDownCooldownMs ?? 15_000));
    this.#scaleUpSampleSize = Math.max(1, Math.floor(options.scaleUpSampleSize ?? 2));
    this.#scaleDownSampleSize = Math.max(1, Math.floor(options.scaleDownSampleSize ?? 3));
    this.#scaleUpBusyRatioThreshold = Math.min(1, Math.max(0, options.scaleUpBusyRatioThreshold ?? 0.75));
    this.#scaleUpMaxReadyAgeMs = Math.max(0, Math.floor(options.scaleUpMaxReadyAgeMs ?? 2_000));
  }

  start(): void {
    if (this.#active) {
      return;
    }

    this.#active = true;
    void this.#scheduleRebalance("startup");
    this.#scaleTimer = setInterval(() => {
      void this.#scheduleRebalance("interval");
    }, this.#scaleIntervalMs);
    this.#scaleTimer.unref?.();
  }

  async close(): Promise<void> {
    this.#active = false;
    if (this.#scaleTimer) {
      clearInterval(this.#scaleTimer);
      this.#scaleTimer = undefined;
    }

    await this.#rebalancePromise;

    const workers = this.#workers.splice(0, this.#workers.length).reverse();
    await Promise.all(
      workers.map(async ({ worker, queue, ownsQueue }) => {
        await worker.close();
        if (ownsQueue) {
          await queue.close();
        }
      })
    );
    this.#workerSlots.clear();

    this.#desiredWorkers = 0;
    this.#lastRebalanceAtMs = Date.now();
    this.#lastRebalanceReason = "shutdown";
    this.#recordDecision("shutdown");
    this.#logRebalanceIfChanged(0, "shutdown");
  }

  snapshot(nowMs = Date.now()): RedisRunWorkerPoolSnapshot {
    const scaleDownCooldownReferenceMs = this.#lastCapacityChangeAtMs();
    const slots = this.#slotSnapshots();
    const busySlots = slots.filter((slot) => slot.state === "busy").length;
    const idleSlots = slots.filter((slot) => slot.state === "idle").length;
    return {
      running: this.#active,
      processKind: this.#processKind,
      sessionSerialBoundary: "session",
      minWorkers: this.#minWorkers,
      maxWorkers: this.#maxWorkers,
      suggestedWorkers: this.#suggestedWorkers,
      ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
      desiredWorkers: this.#desiredWorkers,
      slotCapacity: this.#workers.length,
      slots,
      activeWorkers: this.#workers.length,
      busySlots,
      idleSlots,
      busyWorkers: busySlots,
      idleWorkers: idleSlots,
      ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
      ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
      ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
      ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
      readySessionsPerWorker: this.#readySessionsPerWorker,
      scaleIntervalMs: this.#scaleIntervalMs,
      scaleUpCooldownMs: this.#scaleUpCooldownMs,
      scaleDownCooldownMs: this.#scaleDownCooldownMs,
      scaleUpSampleSize: this.#scaleUpSampleSize,
      scaleDownSampleSize: this.#scaleDownSampleSize,
      scaleUpBusyRatioThreshold: this.#scaleUpBusyRatioThreshold,
      scaleUpMaxReadyAgeMs: this.#scaleUpMaxReadyAgeMs,
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : {}),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {}),
      ...(this.#lastRebalanceAtMs ? { lastRebalanceAt: new Date(this.#lastRebalanceAtMs).toISOString() } : {}),
      ...(this.#lastRebalanceReason ? { lastRebalanceReason: this.#lastRebalanceReason } : {}),
      scaleUpPressureStreak: this.#scaleUpPressureStreak,
      scaleDownPressureStreak: this.#scaleDownPressureStreak,
      scaleUpCooldownRemainingMs: this.#cooldownRemainingMs(this.#lastScaleUpAtMs, this.#scaleUpCooldownMs, nowMs),
      scaleDownCooldownRemainingMs: this.#cooldownRemainingMs(scaleDownCooldownReferenceMs, this.#scaleDownCooldownMs, nowMs),
      recentDecisions: [...this.#recentDecisions]
    };
  }

  async #scheduleRebalance(reason: "startup" | "interval"): Promise<void> {
    if (this.#rebalancePromise) {
      return this.#rebalancePromise;
    }

    const task = this.#rebalance(reason).finally(() => {
      if (this.#rebalancePromise === task) {
        this.#rebalancePromise = undefined;
      }
    });
    this.#rebalancePromise = task;
    return task;
  }

  async #rebalance(reason: "startup" | "interval"): Promise<void> {
    const schedulingPressure = await this.#readSchedulingPressure();
    const readySessionCount = schedulingPressure?.readySessionCount;
    const globalWorkerLoad = await this.#readGlobalWorkerLoad();
    const currentWorkers = this.#workers.length;
    const suggestedWorkers = this.#rawDesiredWorkerCount(schedulingPressure, globalWorkerLoad);
    this.#suggestedWorkers = suggestedWorkers;
    const desiredWorkers = this.#desiredWorkerCount(suggestedWorkers, currentWorkers, reason);
    this.#desiredWorkers = desiredWorkers;
    this.#lastReadySessionCount = readySessionCount;
    this.#lastReadyQueueDepth = schedulingPressure?.readyQueueDepth;
    this.#lastUniqueReadySessionCount = schedulingPressure?.uniqueReadySessionCount;
    this.#lastLockedReadySessionCount = schedulingPressure?.lockedReadySessionCount;
    this.#lastStaleReadySessionCount = schedulingPressure?.staleReadySessionCount;
    this.#lastOldestSchedulableReadyAgeMs = schedulingPressure?.oldestSchedulableReadyAgeMs;
    this.#lastGlobalSuggestedWorkers = globalWorkerLoad?.globalSuggestedWorkers;
    this.#lastGlobalActiveWorkers = globalWorkerLoad?.globalActiveWorkers;
    this.#lastGlobalBusyWorkers = globalWorkerLoad?.globalBusyWorkers;
    this.#lastRemoteActiveWorkers = globalWorkerLoad?.remoteActiveWorkers;
    this.#lastRemoteBusyWorkers = globalWorkerLoad?.remoteBusyWorkers;

    while (this.#active && this.#workers.length < desiredWorkers) {
      const queue = this.#queueFactory ? await this.#queueFactory() : this.#queue;
      const ownsQueue = Boolean(this.#queueFactory);
      const workerId = createId("worker");
      const worker = new RedisRunWorker({
        workerId,
        queue,
        runtimeService: this.#runtimeService,
        processKind: this.#processKind,
        lockTtlMs: this.#lockTtlMs,
        pollTimeoutMs: this.#pollTimeoutMs,
        recoveryGraceMs: this.#recoveryGraceMs,
        registry: this.#registry,
        recoverOnStart: this.#workers.length === 0,
        logger: this.#logger,
        onStateChange: ({ workerId: stateWorkerId, state, currentSessionId }) => {
          this.#workerSlots.set(stateWorkerId, {
            slotId: stateWorkerId,
            workerId: stateWorkerId,
            processKind: this.#processKind,
            state,
            ...(currentSessionId ? { currentSessionId } : {})
          });
        }
      });
      this.#workers.push({
        workerId,
        worker,
        queue,
        ownsQueue
      });
      worker.start();
    }

    let scaledDown = false;
    while (this.#workers.length > desiredWorkers) {
      const removed = this.#workers.pop();
      if (!removed) {
        break;
      }

      await removed.worker.close();
      if (removed.ownsQueue) {
        await removed.queue.close();
      }
      this.#workerSlots.delete(removed.workerId);
      scaledDown = true;
    }

    const activeWorkers = this.#workers.length;
    const rebalanceReason =
      reason === "startup"
        ? "startup"
        : activeWorkers > currentWorkers
          ? "scale_up"
          : scaledDown
            ? "scale_down"
            : desiredWorkers !== suggestedWorkers
              ? "cooldown_hold"
              : "steady";
    const nowMs = Date.now();
    if (activeWorkers > currentWorkers) {
      this.#lastScaleUpAtMs = nowMs;
    }
    if (scaledDown) {
      this.#lastScaleDownAtMs = nowMs;
    }
    this.#lastRebalanceAtMs = nowMs;
    this.#lastRebalanceReason = rebalanceReason;
    if (globalWorkerLoad) {
      this.#lastGlobalActiveWorkers = globalWorkerLoad.remoteActiveWorkers + activeWorkers;
      this.#lastGlobalBusyWorkers = globalWorkerLoad.remoteBusyWorkers + this.#busyWorkerCount();
    }
    this.#recordDecision(rebalanceReason);
    this.#logRebalanceIfChanged(desiredWorkers, rebalanceReason, schedulingPressure);
  }

  async #readSchedulingPressure(): Promise<SessionRunQueuePressure | undefined> {
    if (typeof this.#queue.getSchedulingPressure === "function") {
      try {
        return await this.#queue.getSchedulingPressure();
      } catch (error) {
        this.#logger?.warn("Failed to read Redis scheduling pressure for worker pool rebalance.", error);
      }
    }

    if (typeof this.#queue.getReadySessionCount !== "function") {
      return undefined;
    }

    try {
      return {
        readySessionCount: await this.#queue.getReadySessionCount()
      };
    } catch (error) {
      this.#logger?.warn("Failed to read Redis ready-session depth for worker pool rebalance.", error);
      return undefined;
    }
  }

  async #readGlobalWorkerLoad():
    Promise<
      | {
          globalSuggestedWorkers: number;
          globalActiveWorkers: number;
          globalBusyWorkers: number;
          remoteActiveWorkers: number;
          remoteBusyWorkers: number;
        }
      | undefined
    > {
    if (typeof this.#registry?.listActive !== "function") {
      return undefined;
    }

    try {
      const activeWorkers = await this.#registry.listActive(Date.now());
      return summarizeRedisWorkerLoad({
        activeWorkers,
        localWorkerIds: this.#workers.map((entry) => entry.workerId),
        localActiveWorkers: this.#workers.length,
        localBusyWorkers: this.#busyWorkerCount()
      });
    } catch (error) {
      this.#logger?.warn("Failed to read global Redis worker load for worker pool rebalance.", error);
      return undefined;
    }
  }

  #desiredWorkerCount(suggestedWorkers: number, currentWorkers: number, reason: "startup" | "interval"): number {
    if (!this.#queueFactory) {
      return 1;
    }

    if (suggestedWorkers > currentWorkers) {
      this.#scaleUpPressureStreak += 1;
    } else {
      this.#scaleUpPressureStreak = 0;
    }
    if (suggestedWorkers < currentWorkers) {
      this.#scaleDownPressureStreak += 1;
    } else {
      this.#scaleDownPressureStreak = 0;
    }

    const targetWorkers =
      suggestedWorkers > currentWorkers
        ? this.#scaleUpPressureStreak >= this.#scaleUpSampleSize
          ? suggestedWorkers
          : currentWorkers
        : suggestedWorkers < currentWorkers
          ? this.#scaleDownPressureStreak >= this.#scaleDownSampleSize
            ? suggestedWorkers
            : currentWorkers
          : suggestedWorkers;
    if (reason === "startup") {
      return suggestedWorkers;
    }

    const nowMs = Date.now();
    if (targetWorkers > currentWorkers && this.#cooldownRemainingMs(this.#lastScaleUpAtMs, this.#scaleUpCooldownMs, nowMs) > 0) {
      return currentWorkers;
    }
    if (targetWorkers < currentWorkers && this.#cooldownRemainingMs(this.#lastCapacityChangeAtMs(), this.#scaleDownCooldownMs, nowMs) > 0) {
      return currentWorkers;
    }

    return targetWorkers;
  }

  #rawDesiredWorkerCount(
    schedulingPressure: SessionRunQueuePressure | undefined,
    globalWorkerLoad?:
      | {
          globalSuggestedWorkers: number;
          globalActiveWorkers: number;
          globalBusyWorkers: number;
          remoteActiveWorkers: number;
          remoteBusyWorkers: number;
        }
      | undefined
  ): number {
    const sizing = calculateRedisWorkerPoolSuggestion({
      minWorkers: this.#minWorkers,
      maxWorkers: this.#maxWorkers,
      readySessionsPerWorker: this.#readySessionsPerWorker,
      localActiveWorkers: this.#workers.length,
      localBusyWorkers: this.#busyWorkerCount(),
      scaleUpBusyRatioThreshold: this.#scaleUpBusyRatioThreshold,
      scaleUpMaxReadyAgeMs: this.#scaleUpMaxReadyAgeMs,
      schedulingPressure,
      globalWorkerLoad
    });
    if (globalWorkerLoad) {
      globalWorkerLoad.globalSuggestedWorkers = sizing.globalSuggestedWorkers;
    }

    return sizing.localSuggestedWorkers;
  }

  #cooldownRemainingMs(lastChangeAtMs: number | undefined, cooldownMs: number, nowMs: number): number {
    if (!lastChangeAtMs || cooldownMs <= 0) {
      return 0;
    }

    return Math.max(0, lastChangeAtMs + cooldownMs - nowMs);
  }

  #lastCapacityChangeAtMs(): number | undefined {
    const lastScaleUpAtMs = this.#lastScaleUpAtMs ?? 0;
    const lastScaleDownAtMs = this.#lastScaleDownAtMs ?? 0;
    const latest = Math.max(lastScaleUpAtMs, lastScaleDownAtMs);
    return latest > 0 ? latest : undefined;
  }

  #recordDecision(reason: NonNullable<RedisRunWorkerPoolSnapshot["lastRebalanceReason"]>): void {
    const decision: RedisRunWorkerPoolDecision = {
      timestamp: new Date(this.#lastRebalanceAtMs ?? Date.now()).toISOString(),
      reason,
      suggestedWorkers: this.#suggestedWorkers,
      ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
      desiredWorkers: this.#desiredWorkers,
      activeWorkers: this.#workers.length,
      ...(this.#busyWorkerCount() > 0 ? { busyWorkers: this.#busyWorkerCount() } : {}),
      ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
      ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
      ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
      ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : {}),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {})
    };
    const lastDecision = this.#recentDecisions.at(-1);
    if (
      lastDecision &&
      lastDecision.reason === decision.reason &&
      lastDecision.suggestedWorkers === decision.suggestedWorkers &&
      lastDecision.globalSuggestedWorkers === decision.globalSuggestedWorkers &&
      lastDecision.desiredWorkers === decision.desiredWorkers &&
      lastDecision.activeWorkers === decision.activeWorkers &&
      lastDecision.readySessionCount === decision.readySessionCount &&
      lastDecision.readyQueueDepth === decision.readyQueueDepth &&
      lastDecision.uniqueReadySessionCount === decision.uniqueReadySessionCount &&
      lastDecision.lockedReadySessionCount === decision.lockedReadySessionCount &&
      lastDecision.staleReadySessionCount === decision.staleReadySessionCount &&
      lastDecision.busyWorkers === decision.busyWorkers &&
      lastDecision.globalActiveWorkers === decision.globalActiveWorkers &&
      lastDecision.globalBusyWorkers === decision.globalBusyWorkers &&
      lastDecision.remoteActiveWorkers === decision.remoteActiveWorkers &&
      lastDecision.remoteBusyWorkers === decision.remoteBusyWorkers &&
      lastDecision.oldestSchedulableReadyAgeMs === decision.oldestSchedulableReadyAgeMs
    ) {
      return;
    }

    this.#recentDecisions.push(decision);
    if (this.#recentDecisions.length > 8) {
      this.#recentDecisions.splice(0, this.#recentDecisions.length - 8);
    }
  }

  #logRebalanceIfChanged(
    desiredWorkers: number,
    reason: NonNullable<RedisRunWorkerPoolSnapshot["lastRebalanceReason"]>,
    schedulingPressure?: SessionRunQueuePressure
  ): void {
    const activeWorkers = this.#workers.length;
    if (
      this.#lastLoggedState?.desiredWorkers === desiredWorkers &&
      this.#lastLoggedState.activeWorkers === activeWorkers &&
      reason !== "shutdown"
    ) {
      return;
    }

    this.#lastLoggedState = {
      desiredWorkers,
      activeWorkers
    };
    this.#logger?.info?.(
      `Redis worker pool rebalance (${reason}): active=${activeWorkers}, desired=${desiredWorkers}, suggested=${this.#suggestedWorkers}, globalSuggested=${
        typeof this.#lastGlobalSuggestedWorkers === "number" ? this.#lastGlobalSuggestedWorkers : "n/a"
      }, globalActive=${typeof this.#lastGlobalActiveWorkers === "number" ? this.#lastGlobalActiveWorkers : "n/a"}, globalBusy=${
        typeof this.#lastGlobalBusyWorkers === "number" ? this.#lastGlobalBusyWorkers : "n/a"
      }, remoteActive=${typeof this.#lastRemoteActiveWorkers === "number" ? this.#lastRemoteActiveWorkers : "n/a"}, remoteBusy=${
        typeof this.#lastRemoteBusyWorkers === "number" ? this.#lastRemoteBusyWorkers : "n/a"
      }, schedulableSessions=${
        typeof schedulingPressure?.readySessionCount === "number" ? schedulingPressure.readySessionCount : "n/a"
      }, busyWorkers=${this.#busyWorkerCount()}, readyDepth=${typeof schedulingPressure?.readyQueueDepth === "number" ? schedulingPressure.readyQueueDepth : "n/a"}, uniqueReady=${
        typeof schedulingPressure?.uniqueReadySessionCount === "number" ? schedulingPressure.uniqueReadySessionCount : "n/a"
      }, lockedReady=${typeof schedulingPressure?.lockedReadySessionCount === "number" ? schedulingPressure.lockedReadySessionCount : "n/a"}, staleReady=${
        typeof schedulingPressure?.staleReadySessionCount === "number" ? schedulingPressure.staleReadySessionCount : "n/a"
      }, oldestReadyAgeMs=${typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number" ? schedulingPressure.oldestSchedulableReadyAgeMs : "n/a"}, upStreak=${this.#scaleUpPressureStreak}/${this.#scaleUpSampleSize}, downStreak=${this.#scaleDownPressureStreak}/${this.#scaleDownSampleSize}, min=${this.#minWorkers}, max=${this.#maxWorkers}.`
    );
  }

  #busyWorkerCount(): number {
    return this.#slotSnapshots().filter((slot) => slot.state === "busy").length;
  }

  #idleWorkerCount(): number {
    return this.#slotSnapshots().filter((slot) => slot.state === "idle").length;
  }

  #slotSnapshots(): RedisRunWorkerPoolSlotSnapshot[] {
    return [...this.#workerSlots.values()].sort((left, right) => left.slotId.localeCompare(right.slotId));
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

  async deleteById(eventId: string): Promise<void> {
    await this.#primary.deleteById(eventId);
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

export async function createRedisWorkerRegistry(
  options: CreateRedisWorkerRegistryOptions
): Promise<RedisWorkerRegistry> {
  const registry = new RedisWorkerRegistry(options);
  await registry.connect();
  return registry;
}
