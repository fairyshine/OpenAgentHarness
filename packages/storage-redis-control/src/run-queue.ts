import { createClient, type RedisClientType } from "redis";

import type { RunQueuePriority, SessionRunQueue, SessionRunQueuePressure } from "./contracts.js";
import type { CreateRedisSessionRunQueueOptions } from "./coordination-types.js";

const compareAndDeleteScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const enqueueSessionRunScript = `
local queueLength = redis.call("rpush", KEYS[1], ARGV[1])
if ARGV[5] ~= "" then
  redis.call("set", KEYS[5], ARGV[5])
else
  redis.call("del", KEYS[5])
end
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

const claimCompatibleSessionScript = `
local workerId = ARGV[3]
local runtimeInstanceId = ARGV[4]
local readyEntries = redis.call("lrange", KEYS[1], 0, -1)

for _, sessionId in ipairs(readyEntries) do
  local preferredWorkerId = redis.call("get", ARGV[1] .. sessionId .. ARGV[2])
  if workerId == "" or preferredWorkerId == false or preferredWorkerId == "" or preferredWorkerId == workerId or (runtimeInstanceId ~= "" and preferredWorkerId == runtimeInstanceId) then
    redis.call("lrem", KEYS[1], 1, sessionId)
    return sessionId
  end
end

return false
`;

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
local subagentReadyQueueDepth = 0
local subagentSchedulable = 0
local lockedReady = 0
local staleReady = 0
local oldestSchedulableReadyAgeMs = 0
local seen = {}

for _, sessionId in ipairs(readyEntries) do
  local readyPriorityKey = ARGV[1] .. sessionId .. ARGV[5]
  local isSubagent = redis.call("get", readyPriorityKey) == "subagent"
  if isSubagent then
    subagentReadyQueueDepth = subagentReadyQueueDepth + 1
  end

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
        if isSubagent then
          subagentSchedulable = subagentSchedulable + 1
        end
        local readyAtKey = ARGV[1] .. sessionId .. ARGV[4]
        local readyAtMs = tonumber(redis.call("get", readyAtKey))
        if readyAtMs ~= nil then
          local waitAgeMs = tonumber(ARGV[6]) - readyAtMs
          if waitAgeMs > oldestSchedulableReadyAgeMs then
            oldestSchedulableReadyAgeMs = waitAgeMs
          end
        end
      end
    end
  end
end

return { schedulable, readyQueueDepth, uniqueReady, subagentSchedulable, subagentReadyQueueDepth, lockedReady, staleReady, oldestSchedulableReadyAgeMs }
`;

const dequeueSessionRunScript = `
local runId = redis.call("lpop", KEYS[1])
if not runId then
  return false
end
if redis.call("llen", KEYS[1]) == 0 then
  redis.call("del", KEYS[2], KEYS[3], KEYS[4])
end
return runId
`;

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

  async enqueue(
    sessionId: string,
    runId: string,
    options?: { priority?: RunQueuePriority | undefined; preferredWorkerId?: string | undefined }
  ): Promise<void> {
    const priority = options?.priority ?? "normal";
    const preferredWorkerId = options?.preferredWorkerId?.trim() ?? "";
    const queueLength = Number(
      await this.#commands.eval(enqueueSessionRunScript, {
        keys: [
          this.#sessionQueueKey(sessionId),
          this.#readyQueueKey(),
          this.#readyAtKey(sessionId),
          this.#readyPriorityKey(sessionId),
          this.#preferredWorkerKey(sessionId)
        ],
        arguments: [runId, sessionId, String(Date.now()), priority, preferredWorkerId]
      })
    );
    if (queueLength === 1) {
      return;
    }
  }

  async claimNextSession(
    timeoutMs = 1_000,
    options?: { workerId?: string | undefined; runtimeInstanceId?: string | undefined }
  ): Promise<string | undefined> {
    const workerId = options?.workerId?.trim() ?? "";
    const runtimeInstanceId = options?.runtimeInstanceId?.trim() ?? "";
    const deadline = Date.now() + Math.max(1, timeoutMs);

    while (Date.now() < deadline) {
      const claimed = await this.#commands.eval(claimCompatibleSessionScript, {
        keys: [this.#readyQueueKey()],
        arguments: [`${this.#keyPrefix}:session:`, ":preferred-worker", workerId, runtimeInstanceId]
      });
      if (typeof claimed === "string" && claimed.length > 0) {
        return claimed;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
    }

    return undefined;
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
      this.#commands.mGet(sessionIds.map((sessionId: string) => this.#readyAtKey(sessionId))),
      this.#commands.mGet(sessionIds.map((sessionId: string) => this.#readyPriorityKey(sessionId)))
    ]);
    const ages = readySinceValues
      .map((value: string | null) => {
        if (!value) {
          return undefined;
        }

        const readySinceMs = Number.parseInt(value, 10);
        return Number.isFinite(readySinceMs) ? Math.max(0, nowMs - readySinceMs) : undefined;
      })
      .filter((value: number | undefined): value is number => value !== undefined);

    if (ages.length === 0) {
      return {
        length: sessionIds.length,
        subagentLength: readyPriorityValues.filter((value: string | null) => value === "subagent").length,
        oldestReadyAgeMs: 0,
        averageReadyAgeMs: 0
      };
    }

    const totalAgeMs = ages.reduce((sum: number, ageMs: number) => sum + ageMs, 0);
    return {
      length: sessionIds.length,
      subagentLength: readyPriorityValues.filter((value: string | null) => value === "subagent").length,
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
      keys: [
        this.#sessionQueueKey(sessionId),
        this.#readyAtKey(sessionId),
        this.#readyPriorityKey(sessionId),
        this.#preferredWorkerKey(sessionId)
      ]
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
      subagentReadySessionCount,
      subagentReadyQueueDepth,
      lockedReadySessionCount,
      staleReadySessionCount,
      oldestSchedulableReadyAgeMs
    ] = (
      await this.#commands.eval(inspectSchedulingPressureScript, {
        keys: [this.#readyQueueKey()],
        arguments: [`${this.#keyPrefix}:session:`, ":queue", ":lock", ":ready_at", ":ready-priority", String(Date.now())]
      })
    ) as number[];

    return {
      readySessionCount: Number(readySessionCount),
      readyQueueDepth: Number(readyQueueDepth),
      uniqueReadySessionCount: Number(uniqueReadySessionCount),
      subagentReadySessionCount: Number(subagentReadySessionCount),
      subagentReadyQueueDepth: Number(subagentReadyQueueDepth),
      lockedReadySessionCount: Number(lockedReadySessionCount),
      staleReadySessionCount: Number(staleReadySessionCount),
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

  #preferredWorkerKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:preferred-worker`;
  }
}

export async function createRedisSessionRunQueue(
  options: CreateRedisSessionRunQueueOptions
): Promise<RedisSessionRunQueue> {
  const queue = new RedisSessionRunQueue(options);
  await queue.connect();
  return queue;
}
