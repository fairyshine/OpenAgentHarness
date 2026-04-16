import { describe, expect, it, vi } from "vitest";

import {
  FanoutSessionEventStore,
  RedisRunWorker,
  RedisRunWorkerPool,
  RedisWorkspaceLeaseRegistry,
  RedisWorkspacePlacementRegistry,
  RedisWorkerRegistry,
  appendRedisRunWorkerPoolDecision,
  buildRedisWorkerAffinitySummary,
  buildRedisRunWorkerPoolDecision,
  buildRedisRunWorkerPoolSnapshot,
  calculateRedisWorkerPoolSuggestion,
  createRedisSessionRunQueue,
  formatRedisRunWorkerPoolRebalanceLog,
  summarizeRedisRunWorkerPoolPressure,
  shouldLogRedisRunWorkerPoolRebalance,
  summarizeRedisWorkerLoad
} from "@oah/storage-redis";

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

function createInMemoryQueueRedisClients() {
  const lists = new Map<string, string[]>();
  const strings = new Map<string, string>();

  const commands = {
    isOpen: true,
    duplicate() {
      return blocking as never;
    },
    async connect() {
      return undefined;
    },
    async quit() {
      commands.isOpen = false;
      return undefined;
    },
    async ping() {
      return "PONG";
    },
    async lLen(key: string) {
      return lists.get(key)?.length ?? 0;
    },
    async lRange(key: string, start: number, end: number) {
      const values = lists.get(key) ?? [];
      const normalizedEnd = end < 0 ? values.length - 1 : end;
      return values.slice(start, normalizedEnd + 1);
    },
    async mGet(keys: string[]) {
      return keys.map((key) => strings.get(key) ?? null);
    },
    async eval(_script: string, input: { keys: string[]; arguments?: string[] }) {
      const args = input.arguments ?? [];

      if (input.keys.length === 5 && args.length === 5) {
        const [sessionQueueKey, readyQueueKey, readyAtKey, readyPriorityKey, preferredWorkerKey] = input.keys;
        const [runId, sessionId, readyAtMs, priority, preferredWorkerId] = args;
        const sessionQueue = lists.get(sessionQueueKey) ?? [];
        sessionQueue.push(runId);
        lists.set(sessionQueueKey, sessionQueue);

        if (preferredWorkerId) {
          strings.set(preferredWorkerKey, preferredWorkerId);
        } else {
          strings.delete(preferredWorkerKey);
        }

        if (sessionQueue.length === 1) {
          if (!strings.has(readyAtKey)) {
            strings.set(readyAtKey, readyAtMs);
          }
          strings.set(readyPriorityKey, priority);
          const readyQueue = lists.get(readyQueueKey) ?? [];
          if (!readyQueue.includes(sessionId)) {
            if (priority === "subagent") {
              readyQueue.unshift(sessionId);
            } else {
              readyQueue.push(sessionId);
            }
            lists.set(readyQueueKey, readyQueue);
          }
        }

        return sessionQueue.length;
      }

      if (input.keys.length === 1 && args.length === 4) {
        const [readyQueueKey] = input.keys;
        const [sessionPrefix, preferredSuffix, workerId, runtimeInstanceId] = args;
        const readyQueue = lists.get(readyQueueKey) ?? [];

        for (const sessionId of readyQueue) {
          const preferredWorkerId = strings.get(`${sessionPrefix}${sessionId}${preferredSuffix}`);
          if (
            !workerId ||
            !preferredWorkerId ||
            preferredWorkerId === workerId ||
            (runtimeInstanceId && preferredWorkerId === runtimeInstanceId)
          ) {
            const index = readyQueue.indexOf(sessionId);
            readyQueue.splice(index, 1);
            lists.set(readyQueueKey, readyQueue);
            return sessionId;
          }
        }

        return null;
      }

      if (input.keys.length === 4 && args.length === 0) {
        const [sessionQueueKey, readyAtKey, readyPriorityKey, preferredWorkerKey] = input.keys;
        const sessionQueue = lists.get(sessionQueueKey) ?? [];
        const runId = sessionQueue.shift();
        lists.set(sessionQueueKey, sessionQueue);
        if (!runId) {
          return null;
        }

        if (sessionQueue.length === 0) {
          strings.delete(readyAtKey);
          strings.delete(readyPriorityKey);
          strings.delete(preferredWorkerKey);
        }

        return runId;
      }

      throw new Error(`Unsupported eval invocation: keys=${input.keys.length} args=${args.length}`);
    }
  };

  const blocking = {
    ...commands,
    async quit() {
      return undefined;
    }
  };

  return {
    commands: commands as never,
    blocking: blocking as never
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
        runtimeInstanceId: "worker-pod-a",
        ownerBaseUrl: "http://worker-pod-a.internal:8787",
        processKind: "embedded",
        state: "busy",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        currentSessionId: "ses_1",
        currentRunId: "run_1",
        currentWorkspaceId: "ws_1"
      },
      6_000
    );

    const [entry] = await registry.listActive(Date.parse("2026-04-01T00:00:04.500Z"));

    expect(entry).toMatchObject({
      workerId: "worker_1",
      runtimeInstanceId: "worker-pod-a",
      ownerBaseUrl: "http://worker-pod-a.internal:8787",
      processKind: "embedded",
      state: "busy",
      currentSessionId: "ses_1",
      currentRunId: "run_1",
      currentWorkspaceId: "ws_1",
      leaseTtlMs: 6_000,
      expiresAt: "2026-04-01T00:00:06.000Z",
      lastSeenAgeMs: 4_500,
      health: "late"
    });
    expect(redis.hashes.get("test:worker:worker_1")).toMatchObject({
      ownerBaseUrl: "http://worker-pod-a.internal:8787",
      leaseTtlMs: "6000",
      expiresAt: "2026-04-01T00:00:06.000Z"
    });
    expect(redis.expiries.get("test:worker:worker_1")).toBe(6_000);
  });

  it("derives workspace ownership leases from registry heartbeats", async () => {
    const redis = createInMemoryRedisCommands();
    const registry = new RedisWorkspaceLeaseRegistry({
      url: "redis://unused",
      keyPrefix: "test",
      commands: redis.commands
    });

    await registry.heartbeat(
      {
        workspaceId: "ws_1",
        version: "live",
        ownerWorkerId: "worker_1",
        ownerBaseUrl: "http://worker-1.internal:8787",
        sourceKind: "object_store",
        localPath: "/tmp/materialized/ws_1",
        remotePrefix: "workspace/demo",
        dirty: true,
        refCount: 2,
        lastActivityAt: "2026-04-01T00:00:01.000Z",
        materializedAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-01T00:00:02.000Z"
      },
      9_000
    );

    const entry = await registry.getByWorkspaceId("ws_1", Date.parse("2026-04-01T00:00:05.000Z"));

    expect(entry).toMatchObject({
      workspaceId: "ws_1",
      version: "live",
      ownerWorkerId: "worker_1",
      ownerBaseUrl: "http://worker-1.internal:8787",
      sourceKind: "object_store",
      localPath: "/tmp/materialized/ws_1",
      remotePrefix: "workspace/demo",
      dirty: true,
      refCount: 2,
      leaseTtlMs: 9_000,
      expiresAt: "2026-04-01T00:00:11.000Z",
      lastSeenAgeMs: 3_000,
      health: "healthy"
    });
    expect(redis.expiries.get("test:workspace-lease:ws_1:live:worker_1")).toBe(9_000);
  });

  it("stores first-class workspace placement state and preserves assigned user affinity", async () => {
    const redis = createInMemoryRedisCommands();
    const registry = new RedisWorkspacePlacementRegistry({
      url: "redis://unused",
      keyPrefix: "test",
      commands: redis.commands
    });

    await registry.assignUser("ws_1", "user_1", {
      updatedAt: "2026-04-01T00:00:00.000Z"
    });
    await registry.upsert({
      workspaceId: "ws_1",
      version: "live",
      ownerWorkerId: "worker_1",
      ownerBaseUrl: "http://worker-1.internal:8787",
      state: "active",
      sourceKind: "object_store",
      localPath: "/tmp/materialized/ws_1",
      remotePrefix: "workspace/demo",
      dirty: true,
      refCount: 2,
      lastActivityAt: "2026-04-01T00:00:03.000Z",
      materializedAt: "2026-04-01T00:00:01.000Z",
      updatedAt: "2026-04-01T00:00:04.000Z"
    });
    await registry.assignUser("ws_1", "user_2", {
      overwrite: false,
      updatedAt: "2026-04-01T00:00:05.000Z"
    });
    await registry.upsert({
      workspaceId: "ws_1",
      state: "evicted",
      refCount: 0,
      dirty: false,
      updatedAt: "2026-04-01T00:00:06.000Z"
    });

    const entry = await registry.getByWorkspaceId("ws_1");

    expect(entry).toMatchObject({
      workspaceId: "ws_1",
      version: "live",
      userId: "user_1",
      ownerWorkerId: "worker_1",
      ownerBaseUrl: "http://worker-1.internal:8787",
      state: "evicted",
      sourceKind: "object_store",
      localPath: "/tmp/materialized/ws_1",
      remotePrefix: "workspace/demo",
      dirty: false,
      refCount: 0,
      materializedAt: "2026-04-01T00:00:01.000Z",
      updatedAt: "2026-04-01T00:00:06.000Z"
    });
    await expect(registry.listAll()).resolves.toEqual([entry]);
  });

  it("can release workspace ownership while preserving placement affinity metadata", async () => {
    const redis = createInMemoryRedisCommands();
    const registry = new RedisWorkspacePlacementRegistry({
      url: "redis://unused",
      keyPrefix: "test",
      commands: redis.commands
    });

    await registry.assignUser("ws_2", "user_2", {
      updatedAt: "2026-04-01T00:00:00.000Z"
    });
    await registry.upsert({
      workspaceId: "ws_2",
      version: "live",
      ownerWorkerId: "worker_2",
      ownerBaseUrl: "http://worker-2.internal:8787",
      state: "draining",
      sourceKind: "object_store",
      localPath: "/tmp/materialized/ws_2",
      remotePrefix: "workspace/demo-2",
      dirty: true,
      refCount: 3,
      lastActivityAt: "2026-04-01T00:00:03.000Z",
      materializedAt: "2026-04-01T00:00:01.000Z",
      updatedAt: "2026-04-01T00:00:04.000Z"
    });

    await registry.releaseOwnership("ws_2", {
      state: "unassigned",
      preferredWorkerId: "worker_2",
      preferredWorkerReason: "controller_target",
      updatedAt: "2026-04-01T00:00:05.000Z"
    });

    await expect(registry.getByWorkspaceId("ws_2")).resolves.toEqual({
      workspaceId: "ws_2",
      version: "live",
      userId: "user_2",
      preferredWorkerId: "worker_2",
      preferredWorkerReason: "controller_target",
      state: "unassigned",
      sourceKind: "object_store",
      remotePrefix: "workspace/demo-2",
      dirty: false,
      refCount: 0,
      lastActivityAt: "2026-04-01T00:00:03.000Z",
      updatedAt: "2026-04-01T00:00:05.000Z"
    });
  });

  it("can set a preferred worker hint without changing ownership truth", async () => {
    const redis = createInMemoryRedisCommands();
    const registry = new RedisWorkspacePlacementRegistry({
      url: "redis://unused",
      keyPrefix: "test",
      commands: redis.commands
    });

    await registry.upsert({
      workspaceId: "ws_hint",
      version: "live",
      state: "unassigned",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });
    await registry.setPreferredWorker("ws_hint", "worker_hint", {
      overwrite: true,
      updatedAt: "2026-04-01T00:00:01.000Z"
    });

    await expect(registry.getByWorkspaceId("ws_hint")).resolves.toEqual({
      workspaceId: "ws_hint",
      version: "live",
      preferredWorkerId: "worker_hint",
      preferredWorkerReason: "controller_target",
      state: "unassigned",
      updatedAt: "2026-04-01T00:00:01.000Z"
    });
  });

  it("prefers a workspace-affine worker when it still has idle slot capacity", () => {
    const affinity = buildRedisWorkerAffinitySummary({
      workspaceId: "ws_1",
      activeWorkers: [
        {
          workerId: "worker_1",
          processKind: "standalone",
          state: "busy",
          health: "healthy",
          currentWorkspaceId: "ws_1"
        },
        {
          workerId: "worker_2",
          processKind: "standalone",
          state: "idle",
          health: "healthy"
        }
      ],
      slots: [
        {
          workerId: "worker_1",
          state: "busy",
          currentWorkspaceId: "ws_1"
        },
        {
          workerId: "worker_1",
          state: "idle"
        },
        {
          workerId: "worker_2",
          state: "idle"
        }
      ]
    });

    expect(affinity.workspaceAffinityWorkerId).toBe("worker_1");
    expect(affinity.preferredWorkerId).toBe("worker_1");
    expect(affinity.candidates[0]).toMatchObject({
      workerId: "worker_1",
      matchingWorkspaceSlots: 1,
      idleSlots: 1
    });
    expect(affinity.candidates[0]?.reasons).toContain("same_workspace");
    expect(affinity.candidates[0]?.reasons).toContain("idle_slot_capacity");
  });

  it("prefers a healthy idle worker over a late workspace match", () => {
    const affinity = buildRedisWorkerAffinitySummary({
      workspaceId: "ws_1",
      activeWorkers: [
        {
          workerId: "worker_1",
          processKind: "standalone",
          state: "busy",
          health: "late",
          currentWorkspaceId: "ws_1"
        },
        {
          workerId: "worker_2",
          processKind: "embedded",
          state: "idle",
          health: "healthy"
        }
      ]
    });

    expect(affinity.workspaceAffinityWorkerId).toBe("worker_1");
    expect(affinity.preferredWorkerId).toBe("worker_2");
    expect(affinity.candidates.map((candidate) => candidate.workerId)).toEqual(["worker_2", "worker_1"]);
  });

  it("prefers a same-user worker when sibling workspaces already live there", () => {
    const affinity = buildRedisWorkerAffinitySummary({
      workspaceId: "ws_3",
      userId: "user_1",
      workerUserAffinities: [
        {
          workerId: "worker_1",
          workspaceCount: 2
        }
      ],
      activeWorkers: [
        {
          workerId: "worker_1",
          processKind: "standalone",
          state: "busy",
          health: "healthy"
        },
        {
          workerId: "worker_2",
          processKind: "standalone",
          state: "idle",
          health: "healthy"
        }
      ]
    });

    expect(affinity.userAffinityWorkerId).toBe("worker_1");
    expect(affinity.preferredWorkerId).toBe("worker_1");
    expect(affinity.candidates[0]).toMatchObject({
      workerId: "worker_1",
      matchingUserWorkspaces: 2
    });
    expect(affinity.candidates[0]?.reasons).toContain("same_user");
  });

  it("prefers a controller-target worker hint over generic idle capacity", () => {
    const affinity = buildRedisWorkerAffinitySummary({
      workspaceId: "ws_4",
      preferredWorkerId: "worker_2",
      activeWorkers: [
        {
          workerId: "worker_1",
          processKind: "standalone",
          state: "idle",
          health: "healthy"
        },
        {
          workerId: "worker_2",
          processKind: "standalone",
          state: "idle",
          health: "healthy"
        }
      ]
    });

    expect(affinity.controllerTargetWorkerId).toBe("worker_2");
    expect(affinity.preferredWorkerId).toBe("worker_2");
    expect(affinity.candidates[0]?.reasons).toContain("controller_target");
  });

  it("claims only sessions compatible with the current worker hint", async () => {
    const clients = createInMemoryQueueRedisClients();
    const queue = await createRedisSessionRunQueue({
      url: "redis://memory/0",
      commands: clients.commands,
      blocking: clients.blocking
    });

    await queue.enqueue("ses_targeted", "run_targeted", {
      preferredWorkerId: "worker_1"
    });
    await queue.enqueue("ses_shared", "run_shared");

    await expect(queue.claimNextSession(20, { workerId: "worker_2" })).resolves.toBe("ses_shared");
    await expect(queue.dequeueRun("ses_shared")).resolves.toBe("run_shared");
    await expect(queue.claimNextSession(20, { workerId: "worker_1" })).resolves.toBe("ses_targeted");
    await expect(queue.dequeueRun("ses_targeted")).resolves.toBe("run_targeted");
  });

  it("claims sessions pinned to the local runtime instance", async () => {
    const clients = createInMemoryQueueRedisClients();
    const queue = await createRedisSessionRunQueue({
      url: "redis://memory/0",
      commands: clients.commands,
      blocking: clients.blocking
    });

    await queue.enqueue("ses_runtime_targeted", "run_targeted", {
      preferredWorkerId: "api:pod-a"
    });

    await expect(
      queue.claimNextSession(20, {
        workerId: "worker_1",
        runtimeInstanceId: "api:pod-a"
      })
    ).resolves.toBe("ses_runtime_targeted");
    await expect(queue.dequeueRun("ses_runtime_targeted")).resolves.toBe("run_targeted");
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
      ownerBaseUrl?: string;
      processKind: "embedded" | "standalone";
      state: "starting" | "idle" | "busy" | "stopping";
      currentSessionId?: string;
      currentRunId?: string;
      currentWorkspaceId?: string;
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
      ownerBaseUrl: "http://embedded.internal:8787",
      registry: {
        async heartbeat(entry) {
          heartbeats.push({
            workerId: entry.workerId,
            ...(entry.ownerBaseUrl ? { ownerBaseUrl: entry.ownerBaseUrl } : {}),
            processKind: entry.processKind,
            state: entry.state,
            ...(entry.currentSessionId ? { currentSessionId: entry.currentSessionId } : {}),
            ...(entry.currentRunId ? { currentRunId: entry.currentRunId } : {}),
            ...(entry.currentWorkspaceId ? { currentWorkspaceId: entry.currentWorkspaceId } : {})
          });
        },
        async remove(workerId) {
          removed.push(workerId);
        }
      },
      runtimeService: {
        async describeQueuedRun() {
          return {
            workspaceId: "ws_1"
          };
        },
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
    expect(heartbeats.some((entry) => entry.ownerBaseUrl === "http://embedded.internal:8787")).toBe(true);
    expect(heartbeats.some((entry) => entry.state === "idle")).toBe(true);
    expect(
      heartbeats.some(
        (entry) =>
          entry.state === "busy" &&
          entry.currentSessionId === "ses_1" &&
          entry.currentRunId === "run_1" &&
          entry.currentWorkspaceId === "ws_1"
      )
    ).toBe(true);

    releaseProcessing?.();
    await worker.close();

    expect(heartbeats.some((entry) => entry.state === "stopping")).toBe(true);
    expect(removed).toHaveLength(1);
  });

  it("exposes local execution slots and session ownership in pool snapshots", async () => {
    let claimed = false;
    let returnedRun = false;
    let releaseProcessing: (() => void) | undefined;
    const processingBlocked = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });

    const queue = createQueueStub({
      async claimNextSession() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (claimed) {
          return undefined;
        }

        claimed = true;
        return "ses_1";
      },
      async dequeueRun() {
        if (returnedRun) {
          return undefined;
        }

        returnedRun = true;
        return "run_1";
      }
    });

    const pool = new RedisRunWorkerPool({
      queue,
      runtimeService: {
        async describeQueuedRun() {
          return {
            workspaceId: "ws_1"
          };
        },
        async processQueuedRun() {
          await processingBlocked;
        }
      },
      processKind: "embedded",
      minWorkers: 1,
      maxWorkers: 1,
      scaleIntervalMs: 40
    });

    pool.start();

    await waitForCondition(() => pool.snapshot().slots.some((slot) => slot.state === "busy" && slot.currentSessionId === "ses_1"));
    expect(pool.snapshot()).toMatchObject({
      sessionSerialBoundary: "session",
      slotCapacity: 1,
      activeWorkers: 1,
      busySlots: 1,
      idleSlots: 0,
      slots: [
        {
          processKind: "embedded",
          state: "busy",
          currentSessionId: "ses_1",
          currentRunId: "run_1",
          currentWorkspaceId: "ws_1"
        }
      ]
    });

    releaseProcessing?.();
    await pool.close();
  });

  it("derives worker load and sizing from extracted policy helpers", () => {
    const workerLoad = summarizeRedisWorkerLoad({
      activeWorkers: [
        {
          workerId: "local_1",
          state: "busy",
          health: "healthy"
        },
        {
          workerId: "remote_1",
          state: "busy",
          health: "healthy"
        },
        {
          workerId: "remote_2",
          state: "idle",
          health: "late"
        }
      ],
      localWorkerIds: ["local_1"],
      localActiveWorkers: 1,
      localBusyWorkers: 1
    });

    expect(workerLoad).toEqual({
      globalSuggestedWorkers: 0,
      globalActiveWorkers: 2,
      globalBusyWorkers: 2,
      remoteActiveWorkers: 1,
      remoteBusyWorkers: 1
    });

    expect(
      calculateRedisWorkerPoolSuggestion({
        minWorkers: 1,
        maxWorkers: 4,
        readySessionsPerCapacityUnit: 1,
        reservedSubagentCapacity: 1,
        localActiveWorkers: 1,
        localBusyWorkers: 1,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000,
        schedulingPressure: {
          readySessionCount: 3,
          oldestSchedulableReadyAgeMs: 3_500
        },
        globalWorkerLoad: workerLoad
      })
    ).toEqual({
      pressureWorkers: 3,
      saturatedWorkers: 5,
      reservedWorkers: 0,
      ageBoostWorkers: 3,
      globalSuggestedWorkers: 5,
      localSuggestedWorkers: 4
    });
  });

  it("deduplicates recent pool decisions with extracted observability helpers", () => {
    const repeated = buildRedisRunWorkerPoolDecision({
      timestamp: "2026-04-14T10:00:00.000Z",
      reason: "steady",
      suggestedWorkers: 2,
      reservedSubagentCapacity: 1,
      reservedWorkers: 2,
      availableIdleCapacity: 1,
      readySessionsPerActiveWorker: 0.5,
      subagentReserveTarget: 1,
      subagentReserveDeficit: 0,
      desiredWorkers: 2,
      activeWorkers: 2,
      busyWorkers: 1,
      readySessionCount: 1,
      readyQueueDepth: 1,
      subagentReadySessionCount: 1,
      subagentReadyQueueDepth: 1
    });

    expect(appendRedisRunWorkerPoolDecision([], repeated)).toEqual([repeated]);
    expect(appendRedisRunWorkerPoolDecision([repeated], { ...repeated, timestamp: "2026-04-14T10:00:01.000Z" })).toEqual([
      repeated
    ]);
  });

  it("formats rebalance logging and snapshot shaping through extracted observability helpers", () => {
    expect(
      summarizeRedisRunWorkerPoolPressure({
        activeWorkers: 3,
        busyWorkers: 2,
        reservedSubagentCapacity: 2,
        schedulingPressure: {
          readySessionCount: 4,
          subagentReadySessionCount: 1,
          subagentReadyQueueDepth: 1
        }
      })
    ).toEqual({
      availableIdleCapacity: 1,
      readySessionsPerActiveWorker: 1.33,
      subagentReserveTarget: 2,
      subagentReserveDeficit: 1
    });

    expect(
      shouldLogRedisRunWorkerPoolRebalance(
        {
          desiredWorkers: 2,
          activeWorkers: 2
        },
        {
          desiredWorkers: 2,
          activeWorkers: 2,
          reason: "steady"
        }
      )
    ).toBe(false);

    expect(
      formatRedisRunWorkerPoolRebalanceLog({
        reason: "scale_up",
        activeWorkers: 2,
        desiredWorkers: 4,
        suggestedWorkers: 4,
        globalSuggestedWorkers: 5,
        reservedSubagentCapacity: 1,
        reservedWorkers: 3,
        availableIdleCapacity: 0,
        readySessionsPerActiveWorker: 2,
        subagentReserveTarget: 1,
        subagentReserveDeficit: 1,
        globalActiveWorkers: 3,
        globalBusyWorkers: 2,
        remoteActiveWorkers: 1,
        remoteBusyWorkers: 1,
        busyWorkers: 2,
        minWorkers: 1,
        maxWorkers: 4,
        scaleUpPressureStreak: 2,
        scaleUpSampleSize: 2,
        scaleDownPressureStreak: 0,
        scaleDownSampleSize: 3,
        schedulingPressure: {
          readySessionCount: 4,
          readyQueueDepth: 4,
          uniqueReadySessionCount: 4,
          subagentReadySessionCount: 2,
          subagentReadyQueueDepth: 2,
          lockedReadySessionCount: 0,
          staleReadySessionCount: 0,
          oldestSchedulableReadyAgeMs: 3_000
        }
      })
    ).toContain("Redis worker pool rebalance (scale_up): active=2, desired=4");
    expect(
      formatRedisRunWorkerPoolRebalanceLog({
        reason: "scale_up",
        activeWorkers: 2,
        desiredWorkers: 4,
        suggestedWorkers: 4,
        reservedSubagentCapacity: 1,
        reservedWorkers: 3,
        availableIdleCapacity: 0,
        readySessionsPerActiveWorker: 2,
        subagentReserveTarget: 1,
        subagentReserveDeficit: 1,
        busyWorkers: 2,
        minWorkers: 1,
        maxWorkers: 4,
        scaleUpPressureStreak: 2,
        scaleUpSampleSize: 2,
        scaleDownPressureStreak: 0,
        scaleDownSampleSize: 3,
        schedulingPressure: {
          readySessionCount: 4,
          readyQueueDepth: 4,
          uniqueReadySessionCount: 4,
          subagentReadySessionCount: 2,
          subagentReadyQueueDepth: 2,
          lockedReadySessionCount: 0,
          staleReadySessionCount: 0,
          oldestSchedulableReadyAgeMs: 3_000
        }
      })
    ).toContain("subagentReserveDeficit=1");
    expect(
      formatRedisRunWorkerPoolRebalanceLog({
        reason: "scale_up",
        activeWorkers: 2,
        desiredWorkers: 4,
        suggestedWorkers: 4,
        reservedSubagentCapacity: 1,
        reservedWorkers: 3,
        availableIdleCapacity: 0,
        readySessionsPerActiveWorker: 2,
        subagentReserveTarget: 1,
        subagentReserveDeficit: 1,
        busyWorkers: 2,
        minWorkers: 1,
        maxWorkers: 4,
        scaleUpPressureStreak: 2,
        scaleUpSampleSize: 2,
        scaleDownPressureStreak: 0,
        scaleDownSampleSize: 3,
        schedulingPressure: {
          readySessionCount: 4,
          readyQueueDepth: 4,
          uniqueReadySessionCount: 4,
          subagentReadySessionCount: 2,
          subagentReadyQueueDepth: 2,
          lockedReadySessionCount: 0,
          staleReadySessionCount: 0,
          oldestSchedulableReadyAgeMs: 3_000
        }
      })
    ).toContain("subagentSchedulable=2, subagentDepth=2");

    expect(
      buildRedisRunWorkerPoolSnapshot({
        running: true,
        processKind: "embedded",
        minWorkers: 1,
        maxWorkers: 4,
        suggestedWorkers: 2,
        reservedSubagentCapacity: 1,
        reservedWorkers: 1,
        availableIdleCapacity: 1,
        readySessionsPerActiveWorker: 1,
        subagentReserveTarget: 1,
        subagentReserveDeficit: 0,
        desiredWorkers: 2,
        slots: [
          {
            slotId: "slot-1",
            workerId: "worker-1",
            processKind: "embedded",
            state: "busy",
            currentSessionId: "ses_1"
          },
          {
            slotId: "slot-2",
            workerId: "worker-2",
            processKind: "embedded",
            state: "idle"
          }
        ],
        readySessionsPerCapacityUnit: 1,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1_000,
        scaleDownCooldownMs: 15_000,
        scaleUpSampleSize: 2,
        scaleDownSampleSize: 3,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000,
        subagentReadySessionCount: 1,
        subagentReadyQueueDepth: 1,
        scaleUpPressureStreak: 0,
        scaleDownPressureStreak: 0,
        scaleUpCooldownRemainingMs: 0,
        scaleDownCooldownRemainingMs: 0,
        recentDecisions: []
      })
    ).toMatchObject({
      sessionSerialBoundary: "session",
      slotCapacity: 2,
      reservedSubagentCapacity: 1,
      reservedWorkers: 1,
      availableIdleCapacity: 1,
      readySessionsPerActiveWorker: 1,
      subagentReserveTarget: 1,
      subagentReserveDeficit: 0,
      activeWorkers: 2,
      busySlots: 1,
      idleSlots: 1,
      subagentReadySessionCount: 1,
      subagentReadyQueueDepth: 1,
      slots: [
        {
          currentSessionId: "ses_1"
        },
        {
          state: "idle"
        }
      ]
    });
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
      readySessionsPerCapacityUnit: 1,
      reservedSubagentCapacity: 1,
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
      subagentReadySessionCount: 0,
      subagentReadyQueueDepth: 0,
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
      readySessionsPerCapacityUnit: 1,
      reservedSubagentCapacity: 1,
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
      subagentReadySessionCount: 2,
      subagentReadyQueueDepth: 2,
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
      reservedSubagentCapacity: 1,
      reservedWorkers: 1,
      availableIdleCapacity: 4,
      readySessionsPerActiveWorker: 1,
      subagentReserveTarget: 1,
      subagentReserveDeficit: 0,
      subagentReadySessionCount: 2,
      subagentReadyQueueDepth: 2,
      remoteActiveWorkers: 0,
      remoteBusyWorkers: 0
    });

    await pool.close();
  });

  it("reserves idle capacity when subagent backlog appears", async () => {
    let pressure = {
      readySessionCount: 1,
      readyQueueDepth: 1,
      uniqueReadySessionCount: 1,
      subagentReadySessionCount: 1,
      subagentReadyQueueDepth: 1,
      lockedReadySessionCount: 0,
      staleReadySessionCount: 0,
      oldestSchedulableReadyAgeMs: 0
    };

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
      readySessionsPerCapacityUnit: 4,
      reservedSubagentCapacity: 2,
      scaleUpCooldownMs: 20,
      scaleDownCooldownMs: 20,
      scaleUpSampleSize: 1,
      scaleDownSampleSize: 1
    });

    pool.start();

    await waitForCondition(() => pool.snapshot().activeWorkers === 2, 1_500);
    expect(pool.snapshot()).toMatchObject({
      desiredWorkers: 2,
      suggestedWorkers: 2,
      reservedSubagentCapacity: 2,
      reservedWorkers: 2,
      availableIdleCapacity: 2,
      readySessionsPerActiveWorker: 0.5,
      subagentReserveTarget: 2,
      subagentReserveDeficit: 0,
      readySessionCount: 1,
      subagentReadySessionCount: 1
    });

    pressure = {
      ...pressure,
      subagentReadySessionCount: 0,
      subagentReadyQueueDepth: 0
    };

    await waitForCondition(() => pool.snapshot().activeWorkers === 1, 1_500);
    expect(pool.snapshot()).toMatchObject({
      desiredWorkers: 1,
      suggestedWorkers: 1,
      reservedSubagentCapacity: 2,
      reservedWorkers: 0,
      availableIdleCapacity: 1,
      readySessionsPerActiveWorker: 1,
      subagentReserveTarget: 0,
      subagentReserveDeficit: 0
    });

    await pool.close();
  });
});
