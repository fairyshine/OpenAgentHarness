import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeRuntimeProcess,
  parseSingleWorkspaceOptions,
  resolveEmbeddedWorkerPoolConfig,
  resolveWorkerMode,
  shouldStartEmbeddedWorker
} from "../apps/server/src/bootstrap.ts";
import {
  createWorkerRuntimeControl,
  summarizeWorkerRuntimeStatus
} from "../apps/server/src/bootstrap/worker-runtime.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server runtime process modes", () => {
  it("defaults the api process to an embedded worker", () => {
    expect(shouldStartEmbeddedWorker([])).toBe(true);
    expect(
      describeRuntimeProcess({
        processKind: "api",
        startWorker: true,
        hasRedisRunQueue: true
      })
    ).toEqual({
      mode: "api_embedded_worker",
      label: "API + embedded worker",
      execution: "redis_queue"
    });
  });

  it("supports explicit api-only mode without an embedded worker", () => {
    expect(shouldStartEmbeddedWorker(["--api-only"])).toBe(false);
    expect(
      describeRuntimeProcess({
        processKind: "api",
        startWorker: false,
        hasRedisRunQueue: true
      })
    ).toEqual({
      mode: "api_only",
      label: "API only",
      execution: "redis_queue"
    });
  });

  it("keeps local inline execution when api-only runs without redis", () => {
    expect(
      describeRuntimeProcess({
        processKind: "api",
        startWorker: false,
        hasRedisRunQueue: false
      })
    ).toEqual({
      mode: "api_only",
      label: "API only",
      execution: "local_inline"
    });
  });

  it("reports the standalone worker process distinctly", () => {
    expect(
      describeRuntimeProcess({
        processKind: "worker",
        startWorker: true,
        hasRedisRunQueue: true
      })
    ).toEqual({
      mode: "standalone_worker",
      label: "standalone worker",
      execution: "redis_queue"
    });
  });

  it("derives worker mode independently from runtime process labels", () => {
    expect(
      resolveWorkerMode({
        processKind: "api",
        startWorker: true,
        hasRedisRunQueue: true
      })
    ).toBe("embedded");
    expect(
      resolveWorkerMode({
        processKind: "worker",
        startWorker: true,
        hasRedisRunQueue: false
      })
    ).toBe("external");
    expect(
      resolveWorkerMode({
        processKind: "api",
        startWorker: false,
        hasRedisRunQueue: true
      })
    ).toBe("external");
  });

  it("summarizes worker runtime status from registry entries", () => {
    expect(
      summarizeWorkerRuntimeStatus({
        mode: "embedded",
        activeWorkers: [
          {
            workerId: "worker-1",
            processKind: "embedded",
            state: "busy",
            lastSeenAt: "2026-04-14T08:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T08:00:05.000Z",
            lastSeenAgeMs: 200,
            health: "healthy",
            currentSessionId: "sess-1"
          },
          {
            workerId: "worker-2",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T08:00:01.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T08:00:06.000Z",
            lastSeenAgeMs: 100,
            health: "late"
          }
        ],
        pool: null
      })
    ).toMatchObject({
      mode: "embedded",
      sessionSerialBoundary: "session",
      localSlots: [],
      summary: {
        active: 2,
        healthy: 1,
        late: 1,
        busy: 1,
        embedded: 1,
        standalone: 1
      },
      pool: null
    });
  });

  it("builds a worker runtime control around the shared host lifecycle", async () => {
    const host = {
      start: vi.fn(),
      snapshot: vi.fn(() => ({
        running: true,
        sessionSerialBoundary: "session",
        processKind: "embedded",
        minWorkers: 1,
        maxWorkers: 2,
        suggestedWorkers: 1,
        reservedSubagentCapacity: 1,
        desiredWorkers: 1,
        slotCapacity: 1,
        slots: [],
        busySlots: 0,
        idleSlots: 1,
        activeWorkers: 1,
        busyWorkers: 0,
        idleWorkers: 1,
        readySessionsPerWorker: 1,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1_000,
        scaleDownCooldownMs: 15_000,
        scaleUpSampleSize: 2,
        scaleDownSampleSize: 3,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000,
        scaleUpPressureStreak: 0,
        scaleDownPressureStreak: 0,
        scaleUpCooldownRemainingMs: 0,
        scaleDownCooldownRemainingMs: 0,
        recentDecisions: []
      })),
      close: vi.fn(async () => undefined)
    };
    const registry = {
      heartbeat: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      listActive: vi.fn(async () => [
        {
          workerId: "embedded-1",
          processKind: "embedded" as const,
          state: "idle" as const,
          lastSeenAt: "2026-04-14T08:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-14T08:00:05.000Z",
          lastSeenAgeMs: 50,
          health: "healthy" as const
        }
      ])
    };

    const workerRuntime = createWorkerRuntimeControl({
      startWorker: true,
      processKind: "api",
      config: {
        storage: {
          redis_url: "redis://local/0"
        }
      },
      redisRunQueue: {} as never,
      redisWorkerRegistry: registry,
      runtimeService: {
        async processQueuedRun() {
          return undefined;
        }
      },
      hostFactory: () => host
    });

    expect(workerRuntime.mode).toBe("embedded");
    workerRuntime.start();
    expect(host.start).toHaveBeenCalledTimes(1);
    await expect(workerRuntime.getStatus()).resolves.toMatchObject({
      mode: "embedded",
      sessionSerialBoundary: "session",
      localSlots: [],
      summary: {
        active: 1,
        healthy: 1,
        late: 0,
        busy: 0,
        embedded: 1,
        standalone: 0
      },
      pool: {
        running: true,
        activeWorkers: 1,
        sessionSerialBoundary: "session",
        slotCapacity: 1
      }
    });
    await workerRuntime.close();
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("reads embedded worker pool defaults from server config", () => {
    expect(
      resolveEmbeddedWorkerPoolConfig({
        processKind: "api",
        config: {
          storage: {
            redis_url: "redis://local/0"
          },
          workers: {
            embedded: {
              min_count: 2,
              max_count: 6,
              scale_interval_ms: 1_500,
              scale_up_window: 3,
              scale_down_window: 4,
              cooldown_ms: 2_500,
              reserved_capacity_for_subagent: 2
            }
          }
        }
      })
    ).toEqual({
      minWorkers: 2,
      maxWorkers: 6,
      scaleIntervalMs: 1_500,
      readySessionsPerWorker: 1,
      reservedSubagentCapacity: 2,
      scaleUpCooldownMs: 2_500,
      scaleDownCooldownMs: 2_500,
      scaleUpSampleSize: 3,
      scaleDownSampleSize: 4,
      scaleUpBusyRatioThreshold: 0.75,
      scaleUpMaxReadyAgeMs: 2_000
    });
  });

  it("lets env vars override embedded worker pool config values", () => {
    vi.stubEnv("OAH_EMBEDDED_WORKER_MIN", "4");
    vi.stubEnv("OAH_EMBEDDED_WORKER_MAX", "8");
    vi.stubEnv("OAH_EMBEDDED_WORKER_SCALE_INTERVAL_MS", "900");
    vi.stubEnv("OAH_EMBEDDED_WORKER_SCALE_UP_COOLDOWN_MS", "700");
    vi.stubEnv("OAH_EMBEDDED_WORKER_SCALE_DOWN_COOLDOWN_MS", "1900");
    vi.stubEnv("OAH_EMBEDDED_WORKER_SCALE_UP_SAMPLE_SIZE", "5");
    vi.stubEnv("OAH_EMBEDDED_WORKER_SCALE_DOWN_SAMPLE_SIZE", "6");
    vi.stubEnv("OAH_EMBEDDED_WORKER_READY_SESSIONS_PER_WORKER", "2");
    vi.stubEnv("OAH_EMBEDDED_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT", "3");
    vi.stubEnv("OAH_EMBEDDED_WORKER_SCALE_UP_BUSY_RATIO_PERCENT", "90");
    vi.stubEnv("OAH_EMBEDDED_WORKER_SCALE_UP_MAX_READY_AGE_MS", "3200");

    expect(
      resolveEmbeddedWorkerPoolConfig({
        processKind: "worker",
        config: {
          storage: {
            redis_url: "redis://local/0"
          },
          workers: {
            embedded: {
              min_count: 1,
              max_count: 2,
              scale_interval_ms: 1_500,
              scale_up_window: 3,
              scale_down_window: 4,
              cooldown_ms: 2_500,
              reserved_capacity_for_subagent: 1
            }
          }
        }
      })
    ).toEqual({
      minWorkers: 4,
      maxWorkers: 8,
      scaleIntervalMs: 900,
      readySessionsPerWorker: 2,
      reservedSubagentCapacity: 3,
      scaleUpCooldownMs: 700,
      scaleDownCooldownMs: 1_900,
      scaleUpSampleSize: 5,
      scaleDownSampleSize: 6,
      scaleUpBusyRatioThreshold: 0.9,
      scaleUpMaxReadyAgeMs: 3_200
    });
  });

  it("parses single-workspace startup flags", () => {
    expect(
      parseSingleWorkspaceOptions([
        "--workspace",
        "./demo",
        "--workspace-kind",
        "chat",
        "--model-dir",
        "./models",
        "--default-model",
        "openai-default",
        "--tool-dir",
        "./tools",
        "--skill-dir",
        "./skills",
        "--host",
        "127.0.0.1",
        "--port",
        "8788"
      ])
    ).toMatchObject({
      rootPath: expect.stringMatching(/demo$/),
      kind: "chat",
      modelDir: expect.stringMatching(/models$/),
      defaultModel: "openai-default",
      toolDir: expect.stringMatching(/tools$/),
      skillDir: expect.stringMatching(/skills$/),
      host: "127.0.0.1",
      port: 8788
    });
  });
});
