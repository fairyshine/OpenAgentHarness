import type {
  RedisRunWorkerLogger,
  RedisRunWorkerPoolSnapshot,
  RedisWorkerRegistryEntry,
  SessionRunQueue,
  WorkerRegistry
} from "@oah/storage-redis";

import { createWorkerHost, resolveWorkerMode, summarizeActiveWorkers, type WorkerHost } from "./worker-host.js";

interface WorkerHostConfig {
  storage: {
    redis_url?: string | undefined;
  };
  workers?: {
    embedded?: {
      min_count?: number | undefined;
      max_count?: number | undefined;
      scale_interval_ms?: number | undefined;
      scale_up_window?: number | undefined;
      scale_down_window?: number | undefined;
      cooldown_ms?: number | undefined;
    } | undefined;
  } | undefined;
}

export type WorkerRuntimeMode = "embedded" | "external" | "disabled";

export interface WorkerRuntimeSlot {
  slotId: string;
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  currentSessionId?: string | undefined;
  currentRunId?: string | undefined;
  currentWorkspaceId?: string | undefined;
}

export interface WorkerRuntimeStatus {
  mode: WorkerRuntimeMode;
  draining: boolean;
  acceptsNewRuns: boolean;
  drainStartedAt?: string | undefined;
  sessionSerialBoundary: "session";
  localSlots: WorkerRuntimeSlot[];
  activeWorkers: RedisWorkerRegistryEntry[];
  summary: ReturnType<typeof summarizeActiveWorkers>;
  pool: RedisRunWorkerPoolSnapshot | null;
}

export interface WorkerRuntimeControl {
  mode: WorkerRuntimeMode;
  start(): void;
  beginDrain(): Promise<void>;
  getStatus(): Promise<WorkerRuntimeStatus>;
  close(): Promise<void>;
}

type WorkerHostFactory = (options: Parameters<typeof createWorkerHost>[0]) => WorkerHost;

function localSlotsFromPool(pool: RedisRunWorkerPoolSnapshot | null): WorkerRuntimeSlot[] {
  const slots = (pool as (RedisRunWorkerPoolSnapshot & { slots?: WorkerRuntimeSlot[] }) | null)?.slots;
  return Array.isArray(slots) ? slots : [];
}

export function summarizeWorkerRuntimeStatus(input: {
  mode: WorkerRuntimeMode;
  draining?: boolean | undefined;
  drainStartedAt?: string | undefined;
  activeWorkers: RedisWorkerRegistryEntry[];
  pool: RedisRunWorkerPoolSnapshot | null;
}): WorkerRuntimeStatus {
  return {
    mode: input.mode,
    draining: input.draining ?? false,
    acceptsNewRuns: !(input.draining ?? false),
    ...(input.drainStartedAt ? { drainStartedAt: input.drainStartedAt } : {}),
    sessionSerialBoundary: "session",
    localSlots: localSlotsFromPool(input.pool),
    activeWorkers: input.activeWorkers,
    summary: summarizeActiveWorkers(input.activeWorkers),
    pool: input.pool
  };
}

export function createWorkerRuntimeControl(options: {
  startWorker: boolean;
  processKind: "api" | "worker";
  runtimeInstanceId?: string | undefined;
  config: WorkerHostConfig;
  redisRunQueue?: SessionRunQueue | undefined;
  redisWorkerRegistry?: WorkerRegistry | undefined;
  runtimeService: {
    processQueuedRun(runId: string): Promise<void>;
    getRun?(runId: string): Promise<{ workspaceId: string }>;
    recoverStaleRuns?(options?: {
      staleBefore?: string | undefined;
      limit?: number | undefined;
    }): Promise<{ recoveredRunIds: string[]; requeuedRunIds?: string[] }>;
  };
  logger?: RedisRunWorkerLogger | undefined;
  hostFactory?: WorkerHostFactory | undefined;
}): WorkerRuntimeControl {
  const mode = resolveWorkerMode({
    startWorker: options.startWorker,
    processKind: options.processKind,
    hasRedisRunQueue: Boolean(options.redisRunQueue)
  });
  const host = (options.hostFactory ?? createWorkerHost)({
    startWorker: options.startWorker,
    processKind: options.processKind,
    ...(options.runtimeInstanceId ? { runtimeInstanceId: options.runtimeInstanceId } : {}),
    config: options.config,
    redisRunQueue: options.redisRunQueue,
    redisWorkerRegistry: options.redisWorkerRegistry,
    runtimeService: options.runtimeService,
    logger: options.logger
  });
  let drainStartedAt: string | undefined;
  let drainPromise: Promise<void> | undefined;

  return {
    mode,
    start() {
      host.start();
    },
    async beginDrain() {
      if (!drainPromise) {
        drainStartedAt = new Date().toISOString();
        drainPromise = host.beginDrain();
      }

      await drainPromise;
    },
    async getStatus() {
      const activeWorkers =
        options.redisWorkerRegistry && typeof options.redisWorkerRegistry.listActive === "function"
          ? await options.redisWorkerRegistry.listActive()
          : [];

      return summarizeWorkerRuntimeStatus({
        mode,
        draining: host.isDraining(),
        ...(drainStartedAt ? { drainStartedAt } : {}),
        activeWorkers,
        pool: host.snapshot()
      });
    },
    async close() {
      if (!drainPromise && host.isDraining()) {
        drainPromise = host.close();
      }

      await host.close();
    }
  };
}
