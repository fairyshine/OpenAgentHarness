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

export interface WorkerRuntimeStatus {
  mode: WorkerRuntimeMode;
  activeWorkers: RedisWorkerRegistryEntry[];
  summary: ReturnType<typeof summarizeActiveWorkers>;
  pool: RedisRunWorkerPoolSnapshot | null;
}

export interface WorkerRuntimeControl {
  mode: WorkerRuntimeMode;
  start(): void;
  getStatus(): Promise<WorkerRuntimeStatus>;
  close(): Promise<void>;
}

type WorkerHostFactory = (options: Parameters<typeof createWorkerHost>[0]) => WorkerHost;

export function summarizeWorkerRuntimeStatus(input: {
  mode: WorkerRuntimeMode;
  activeWorkers: RedisWorkerRegistryEntry[];
  pool: RedisRunWorkerPoolSnapshot | null;
}): WorkerRuntimeStatus {
  return {
    mode: input.mode,
    activeWorkers: input.activeWorkers,
    summary: summarizeActiveWorkers(input.activeWorkers),
    pool: input.pool
  };
}

export function createWorkerRuntimeControl(options: {
  startWorker: boolean;
  processKind: "api" | "worker";
  config: WorkerHostConfig;
  redisRunQueue?: SessionRunQueue | undefined;
  redisWorkerRegistry?: WorkerRegistry | undefined;
  runtimeService: {
    processQueuedRun(runId: string): Promise<void>;
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
    config: options.config,
    redisRunQueue: options.redisRunQueue,
    redisWorkerRegistry: options.redisWorkerRegistry,
    runtimeService: options.runtimeService,
    logger: options.logger
  });

  return {
    mode,
    start() {
      host.start();
    },
    async getStatus() {
      const activeWorkers =
        options.redisWorkerRegistry && typeof options.redisWorkerRegistry.listActive === "function"
          ? await options.redisWorkerRegistry.listActive()
          : [];

      return summarizeWorkerRuntimeStatus({
        mode,
        activeWorkers,
        pool: host.snapshot()
      });
    },
    async close() {
      await host.close();
    }
  };
}
