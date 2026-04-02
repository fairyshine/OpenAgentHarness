import { describe, expect, it, vi } from "vitest";

import { FanoutSessionEventStore, RedisRunWorker } from "@oah/storage-redis";

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

    const queue = {
      async enqueue() {
        return undefined;
      },
      async claimNextSession() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        claims += 1;
        return claims === 1 ? "ses_1" : undefined;
      },
      async tryAcquireSessionLock() {
        return true;
      },
      async renewSessionLock() {
        return true;
      },
      async releaseSessionLock() {
        released += 1;
        return true;
      },
      async dequeueRun() {
        return dequeuedRuns.shift();
      },
      async close() {
        return undefined;
      }
    };

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

  it("runs stale-run recovery once before entering the worker loop", async () => {
    let claims = 0;
    const recoveredAtStartup: Array<{ staleBefore?: string }> = [];
    const queue = {
      async enqueue() {
        return undefined;
      },
      async claimNextSession() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        claims += 1;
        return undefined;
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
      async close() {
        return undefined;
      }
    };

    const worker = new RedisRunWorker({
      queue,
      runtimeService: {
        async processQueuedRun() {
          return undefined;
        },
        async recoverStaleRuns(options) {
          recoveredAtStartup.push({ staleBefore: options?.staleBefore });
          return { recoveredRunIds: [] };
        }
      },
      pollTimeoutMs: 250,
      lockTtlMs: 2_000,
      recoveryGraceMs: 4_000
    });

    worker.start();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.close();

    expect(recoveredAtStartup).toHaveLength(1);
    expect(typeof recoveredAtStartup[0]?.staleBefore).toBe("string");
    expect(claims).toBeGreaterThan(0);
  });
});
