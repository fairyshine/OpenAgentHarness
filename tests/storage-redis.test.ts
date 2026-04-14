import { describe, expect, it, vi } from "vitest";

import { FanoutSessionEventStore, RedisRunWorker, RedisRunWorkerPool, RedisWorkerRegistry } from "@oah/storage-redis";

function createInMemoryRedisCommands() {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  const expiries = new Map<string, number>();

  const addSetMembers = (key: string, members: string[]) => {
    const next = new Set(sets.get(key) ?? []);
    for (const member of members) {
      next.add(member);
    }
    sets.set(key, next);
  };

  const removeSetMembers = (key: string, members: string[]) => {
    const existing = sets.get(key);
    if (!existing) {
      return;
    }

    for (const member of members) {
      existing.delete(member);
    }

    if (existing.size === 0) {
      sets.delete(key);
    }
  };

  const commands = {
    isOpen: true,
    async connect() {
      return undefined;
    },
    multi() {
      const operations: Array<() => void> = [];
      const transaction = {
        sAdd(key: string, members: string | string[]) {
          operations.push(() => {
            addSetMembers(key, Array.isArray(members) ? members : [members]);
          });
          return transaction;
        },
        hSet(key: string, values: Record<string, string>) {
          operations.push(() => {
            hashes.set(key, {
              ...(hashes.get(key) ?? {}),
              ...values
            });
          });
          return transaction;
        },
        hDel(key: string, fields: string | string[]) {
          operations.push(() => {
            const existing = hashes.get(key);
            if (!existing) {
              return;
            }

            for (const field of Array.isArray(fields) ? fields : [fields]) {
              delete existing[field];
            }
          });
          return transaction;
        },
        pExpire(key: string, ttlMs: number) {
          operations.push(() => {
            expiries.set(key, ttlMs);
          });
          return transaction;
        },
        sRem(key: string, members: string | string[]) {
          operations.push(() => {
            removeSetMembers(key, Array.isArray(members) ? members : [members]);
          });
          return transaction;
        },
        del(key: string) {
          operations.push(() => {
            hashes.delete(key);
            expiries.delete(key);
          });
          return transaction;
        },
        async exec() {
          for (const operation of operations) {
            operation();
          }
          return [];
        }
      };

      return transaction;
    },
    async sMembers(key: string) {
      return Array.from(sets.get(key) ?? []);
    },
    async hGetAll(key: string) {
      return { ...(hashes.get(key) ?? {}) };
    },
    async ping() {
      return "PONG";
    },
    async quit() {
      commands.isOpen = false;
      return undefined;
    }
  };

  return {
    commands: commands as never,
    hashes,
    expiries
  };
}

function createQueueStub(overrides: Record<string, unknown> = {}) {
  return {
    async enqueue() {
      return undefined;
    },
    async claimNextSession() {
      return undefined;
    },
    async readyQueueLength() {
      return 0;
    },
    async inspectReadyQueue() {
      return {
        length: 0,
        subagentLength: 0,
        oldestReadyAgeMs: 0,
        averageReadyAgeMs: 0
      };
    },
    async tryAcquireSessionLock() {
      return true;
    },
    async renewSessionLock() {
      return true;
    },
    async releaseSessionLock() {
      return true;
    },
    async dequeueRun() {
      return undefined;
    },
    async ping() {
      return true;
    },
    async close() {
      return undefined;
    },
    ...overrides
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition.");
}

describe("storage redis", () => {
  it("publishes persisted events to the secondary bus", async () => {
    const published: Array<{ id: string }> = [];
    const primary = {
      async append() {
        return {
          id: "evt_1",
          cursor: "0",
          sessionId: "ses_1",
          runId: "run_1",
          event: "run.queued" as const,
          data: { status: "queued" },
          createdAt: "2026-04-01T00:00:00.000Z"
        };
      },
      async listSince() {
        return [];
      },
      async deleteById() {
        return undefined;
      },
      subscribe() {
        return () => undefined;
      }
    };
    const bus = {
      publish: vi.fn(async (event) => {
        published.push({ id: event.id });
      }),
      async subscribe() {
        return () => undefined;
      },
      async close() {
        return undefined;
      }
    };

    const store = new FanoutSessionEventStore(primary, bus);
    const event = await store.append({
      sessionId: "ses_1",
      runId: "run_1",
      event: "run.queued",
      data: { status: "queued" }
    });

    expect(event.id).toBe("evt_1");
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(published).toEqual([{ id: "evt_1" }]);
  });

  it("deduplicates primary and bus deliveries for subscribers", async () => {
    let primaryListener: ((event: import("@oah/runtime-core").SessionEvent) => void) | undefined;
    let busListener: ((event: import("@oah/runtime-core").SessionEvent) => void) | undefined;

    const primary = {
      async append() {
        throw new Error("not used");
      },
      async listSince() {
        return [];
      },
      async deleteById() {
        return undefined;
      },
      subscribe(_sessionId: string, listener: (event: import("@oah/runtime-core").SessionEvent) => void) {
        primaryListener = listener;
        return () => {
          primaryListener = undefined;
        };
      }
    };
    const bus = {
      async publish() {
        return undefined;
      },
      async subscribe(_sessionId: string, listener: (event: import("@oah/runtime-core").SessionEvent) => void) {
        busListener = listener;
        return () => {
          busListener = undefined;
        };
      },
      async close() {
        return undefined;
      }
    };

    const store = new FanoutSessionEventStore(primary, bus);
    const received: string[] = [];
    const unsubscribe = store.subscribe("ses_1", (event) => {
      received.push(event.id);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const sharedEvent = {
      id: "evt_1",
      cursor: "0",
      sessionId: "ses_1",
      runId: "run_1",
      event: "run.started" as const,
      data: {},
      createdAt: "2026-04-01T00:00:00.000Z"
    };

    primaryListener?.(sharedEvent);
    busListener?.(sharedEvent);

    expect(received).toEqual(["evt_1"]);

    unsubscribe();
  });

  it("drains queued runs through the Redis worker contract", async () => {
    const dequeuedRuns = ["run_1", "run_2"];
    let claims = 0;
    let released = 0;
    const processed: string[] = [];

    const queue = createQueueStub({
      async claimNextSession() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        claims += 1;
        return claims === 1 ? "ses_1" : undefined;
      },
      async releaseSessionLock() {
        released += 1;
        return true;
      },
      async dequeueRun() {
        return dequeuedRuns.shift();
      }
    });

    const worker = new RedisRunWorker({
      queue,
      runtimeService: {
        async processQueuedRun(runId: string) {
          processed.push(runId);
        }
      },
      pollTimeoutMs: 250,
      lockTtlMs: 2_000
    });

    worker.start();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.close();

    expect(processed).toEqual(["run_1", "run_2"]);
    expect(released).toBe(1);
  });

  it("restores a claimed session when lock contention rejects the claim", async () => {
    const readySessions = ["ses_1"];
    const sessionRuns = new Map<string, string[]>([["ses_1", ["run_1"]]]);
    const processed: string[] = [];
    let acquireAttempts = 0;
    let restoredClaims = 0;

    const queue = createQueueStub({
      async claimNextSession() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return readySessions.shift();
      },
      async tryAcquireSessionLock() {
        acquireAttempts += 1;
        return acquireAttempts > 1;
      },
      async dequeueRun(sessionId: string) {
        return sessionRuns.get(sessionId)?.shift();
      },
      async requeueSessionIfPending(sessionId: string) {
        if ((sessionRuns.get(sessionId)?.length ?? 0) === 0) {
          return false;
        }

        readySessions.push(sessionId);
        restoredClaims += 1;
        return true;
      }
    });

    const worker = new RedisRunWorker({
      queue,
      runtimeService: {
        async processQueuedRun(runId) {
          processed.push(runId);
        }
      },
      pollTimeoutMs: 250,
      lockTtlMs: 2_000
    });

    worker.start();

    await waitForCondition(() => processed.length === 1);
    await worker.close();

    expect(processed).toEqual(["run_1"]);
    expect(restoredClaims).toBe(1);
  });

  it("derives worker lease health from registry heartbeats", async () => {
    const redis = createInMemoryRedisCommands();
    const registry = new RedisWorkerRegistry({
      url: "redis://unused",
      keyPrefix: "test",
      commands: redis.commands
    });

    await registry.heartbeat(
      {
        workerId: "worker_1",
        processKind: "embedded",
        state: "busy",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        currentSessionId: "ses_1"
      },
      6_000
    );

    const [entry] = await registry.listActive(Date.parse("2026-04-01T00:00:04.500Z"));

    expect(entry).toMatchObject({
      workerId: "worker_1",
      processKind: "embedded",
      state: "busy",
      currentSessionId: "ses_1",
      leaseTtlMs: 6_000,
      expiresAt: "2026-04-01T00:00:06.000Z",
      lastSeenAgeMs: 4_500,
      health: "late"
    });
    expect(redis.hashes.get("test:worker:worker_1")).toMatchObject({
      leaseTtlMs: "6000",
      expiresAt: "2026-04-01T00:00:06.000Z"
    });
    expect(redis.expiries.get("test:worker:worker_1")).toBe(6_000);
  });

  it("publishes worker leases and removes them on shutdown", async () => {
    let claims = 0;
    const dequeuedRuns = ["run_1"];
    let releaseProcessing: (() => void) | undefined;
    const processingBlocked = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    const heartbeats: Array<{
      workerId: string;
      processKind: "embedded" | "standalone";
      state: "starting" | "idle" | "busy" | "stopping";
      currentSessionId?: string;
    }> = [];
    const removed: string[] = [];

    const queue = createQueueStub({
      async claimNextSession() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        claims += 1;
        return claims === 1 ? "ses_1" : undefined;
      },
      async dequeueRun() {
        return dequeuedRuns.shift();
      }
    });

    const worker = new RedisRunWorker({
      queue,
      processKind: "embedded",
      registry: {
        async heartbeat(entry) {
          heartbeats.push({
            workerId: entry.workerId,
            processKind: entry.processKind,
            state: entry.state,
            ...(entry.currentSessionId ? { currentSessionId: entry.currentSessionId } : {})
          });
        },
        async remove(workerId) {
          removed.push(workerId);
        }
      },
      runtimeService: {
        async processQueuedRun() {
          await processingBlocked;
        }
      },
      pollTimeoutMs: 250,
      lockTtlMs: 2_000
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(heartbeats.some((entry) => entry.state === "starting")).toBe(true);
    expect(heartbeats.some((entry) => entry.state === "idle")).toBe(true);
    expect(heartbeats.some((entry) => entry.state === "busy" && entry.currentSessionId === "ses_1")).toBe(true);

    releaseProcessing?.();
    await worker.close();

    expect(heartbeats.some((entry) => entry.state === "stopping")).toBe(true);
    expect(removed).toHaveLength(1);
  });

  it("rebalances the worker pool from ready-session pressure and only logs changes", async () => {
    let readySessions = 0;
    let claims = 0;
    const heartbeats: Array<{ workerId: string; state: string }> = [];
    const infoLogs: string[] = [];

    const createQueue = () =>
      createQueueStub({
        async claimNextSession() {
          await new Promise((resolve) => setTimeout(resolve, 5));
          claims += 1;
          return undefined;
        },
        async getReadySessionCount() {
          return readySessions;
        },
        async getSchedulingPressure() {
          return {
            readySessionCount: readySessions
          };
        }
      });

    const pool = new RedisRunWorkerPool({
      queue: createQueue(),
      queueFactory: async () => createQueue(),
      runtimeService: {
        async processQueuedRun() {
          return undefined;
        }
      },
      processKind: "embedded",
      minWorkers: 2,
      maxWorkers: 4,
      scaleIntervalMs: 40,
      readySessionsPerWorker: 1,
      scaleUpCooldownMs: 20,
      scaleDownCooldownMs: 500,
      scaleUpSampleSize: 2,
      scaleDownSampleSize: 2,
      registry: {
        async heartbeat(entry) {
          heartbeats.push({
            workerId: entry.workerId,
            state: entry.state
          });
        },
        async remove() {
          return undefined;
        }
      },
      logger: {
        info(message) {
          infoLogs.push(message);
        },
        warn() {
          return undefined;
        },
        error() {
          return undefined;
        }
      }
    });

    pool.start();

    await waitForCondition(() => new Set(heartbeats.map((entry) => entry.workerId)).size >= 2);
    expect(infoLogs.filter((entry) => entry.includes("desired=2"))).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(infoLogs.filter((entry) => entry.includes("desired=2"))).toHaveLength(1);

    readySessions = 4;
    await waitForCondition(() => new Set(heartbeats.map((entry) => entry.workerId)).size >= 4);
    expect(infoLogs.filter((entry) => entry.includes("desired=4"))).toHaveLength(1);
    expect(pool.snapshot().lastRebalanceReason).toBe("scale_up");

    readySessions = 0;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pool.snapshot().activeWorkers).toBe(4);
    expect(pool.snapshot().scaleDownCooldownRemainingMs).toBeGreaterThan(0);
    await waitForCondition(
      () => pool.snapshot().activeWorkers === 2 && pool.snapshot().lastRebalanceReason === "scale_down",
      4_000
    );

    await pool.close();

    expect(infoLogs.filter((entry) => entry.includes("desired=2"))).toHaveLength(2);
    expect(infoLogs.filter((entry) => entry.includes("desired=4"))).toHaveLength(1);
    expect(infoLogs.filter((entry) => entry.includes("(shutdown)"))).toHaveLength(1);
    expect(claims).toBeGreaterThan(0);
  });

  it("uses global worker load to avoid local over-scaling when remote workers already cover demand", async () => {
    let pressure = {
      readySessionCount: 1,
      readyQueueDepth: 1,
      uniqueReadySessionCount: 1,
      lockedReadySessionCount: 0,
      staleReadySessionCount: 0,
      oldestSchedulableReadyAgeMs: 0
    };
    let remoteWorkers = [
      {
        workerId: "remote_1",
        processKind: "embedded" as const,
        state: "idle" as const,
        lastSeenAt: "2026-04-12T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-12T00:00:05.000Z",
        lastSeenAgeMs: 50,
        health: "healthy" as const
      },
      {
        workerId: "remote_2",
        processKind: "embedded" as const,
        state: "busy" as const,
        lastSeenAt: "2026-04-12T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-12T00:00:05.000Z",
        lastSeenAgeMs: 50,
        health: "healthy" as const
      },
      {
        workerId: "remote_3",
        processKind: "standalone" as const,
        state: "busy" as const,
        lastSeenAt: "2026-04-12T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-12T00:00:05.000Z",
        lastSeenAgeMs: 50,
        health: "healthy" as const
      }
    ];

    const createQueue = () =>
      createQueueStub({
        async claimNextSession() {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return undefined;
        },
        async getSchedulingPressure() {
          return pressure;
        }
      });

    const pool = new RedisRunWorkerPool({
      queue: createQueue(),
      queueFactory: async () => createQueue(),
      runtimeService: {
        async processQueuedRun() {
          return undefined;
        }
      },
      processKind: "embedded",
      minWorkers: 1,
      maxWorkers: 4,
      scaleIntervalMs: 40,
      readySessionsPerWorker: 1,
      scaleUpCooldownMs: 20,
      scaleDownCooldownMs: 20,
      scaleUpSampleSize: 1,
      scaleDownSampleSize: 1,
      registry: {
        async heartbeat() {
          return undefined;
        },
        async remove() {
          return undefined;
        },
        async listActive() {
          return remoteWorkers;
        }
      }
    });

    pool.start();

    await waitForCondition(() => pool.snapshot().activeWorkers === 1, 1_000);
    expect(pool.snapshot()).toMatchObject({
      activeWorkers: 1,
      desiredWorkers: 1,
      suggestedWorkers: 1,
      globalSuggestedWorkers: 3,
      remoteActiveWorkers: 3,
      remoteBusyWorkers: 2,
      globalActiveWorkers: 4,
      globalBusyWorkers: 2
    });

    remoteWorkers = [];
    pressure = {
      readySessionCount: 4,
      readyQueueDepth: 4,
      uniqueReadySessionCount: 4,
      lockedReadySessionCount: 0,
      staleReadySessionCount: 0,
      oldestSchedulableReadyAgeMs: 0
    };

    await waitForCondition(() => pool.snapshot().activeWorkers === 4, 2_500);
    expect(pool.snapshot()).toMatchObject({
      activeWorkers: 4,
      desiredWorkers: 4,
      suggestedWorkers: 4,
      globalSuggestedWorkers: 4,
      remoteActiveWorkers: 0,
      remoteBusyWorkers: 0
    });

    await pool.close();
  });
});
