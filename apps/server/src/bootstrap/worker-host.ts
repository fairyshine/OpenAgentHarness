import {
  RedisRunWorkerPool,
  createRedisSessionRunQueue,
  type RedisRunWorkerLogger,
  type RedisRunWorkerPoolSnapshot,
  type RedisWorkerRegistryEntry,
  type SessionRunQueue,
  type WorkerRegistry
} from "@oah/storage-redis";

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

export interface WorkerHost {
  start(): void;
  snapshot(): RedisRunWorkerPoolSnapshot | null;
  close(): Promise<void>;
}

export interface EmbeddedWorkerPoolConfig {
  minWorkers: number;
  maxWorkers: number;
  scaleIntervalMs: number;
  readySessionsPerWorker: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function summarizeActiveWorkers(activeWorkers: RedisWorkerRegistryEntry[]) {
  return {
    active: activeWorkers.length,
    healthy: activeWorkers.filter((worker) => worker.health === "healthy").length,
    late: activeWorkers.filter((worker) => worker.health === "late").length,
    busy: activeWorkers.filter((worker) => worker.state === "busy").length,
    embedded: activeWorkers.filter((worker) => worker.processKind === "embedded").length,
    standalone: activeWorkers.filter((worker) => worker.processKind === "standalone").length
  };
}

export function resolveWorkerMode(options: {
  startWorker: boolean;
  processKind: "api" | "worker";
  hasRedisRunQueue: boolean;
}): "embedded" | "external" | "disabled" {
  if (options.startWorker) {
    return options.processKind === "worker" ? "external" : "embedded";
  }

  return options.hasRedisRunQueue ? "external" : "disabled";
}

export function resolveEmbeddedWorkerPoolConfig(options: {
  config: WorkerHostConfig;
  processKind: "api" | "worker";
}): EmbeddedWorkerPoolConfig {
  const embedded = options.config.workers?.embedded;
  const defaultMinWorkers = options.processKind === "worker" ? 1 : options.config.storage.redis_url ? 2 : 1;
  const minWorkers = readPositiveIntEnv("OAH_EMBEDDED_WORKER_MIN", embedded?.min_count ?? defaultMinWorkers);
  const maxWorkers = Math.max(
    minWorkers,
    readPositiveIntEnv("OAH_EMBEDDED_WORKER_MAX", embedded?.max_count ?? minWorkers)
  );
  const scaleIntervalMs = readPositiveIntEnv(
    "OAH_EMBEDDED_WORKER_SCALE_INTERVAL_MS",
    embedded?.scale_interval_ms ?? 5_000
  );
  const scaleUpCooldownMs = readPositiveIntEnv(
    "OAH_EMBEDDED_WORKER_SCALE_UP_COOLDOWN_MS",
    embedded?.cooldown_ms ?? 1_000
  );
  const scaleDownCooldownMs = readPositiveIntEnv(
    "OAH_EMBEDDED_WORKER_SCALE_DOWN_COOLDOWN_MS",
    embedded?.cooldown_ms ?? 15_000
  );
  const scaleUpSampleSize = readPositiveIntEnv(
    "OAH_EMBEDDED_WORKER_SCALE_UP_SAMPLE_SIZE",
    embedded?.scale_up_window ?? 2
  );
  const scaleDownSampleSize = readPositiveIntEnv(
    "OAH_EMBEDDED_WORKER_SCALE_DOWN_SAMPLE_SIZE",
    embedded?.scale_down_window ?? 3
  );
  const scaleUpBusyRatioThreshold = Math.min(
    1,
    Math.max(
      0,
      readPositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_UP_BUSY_RATIO_PERCENT", 75) / 100
    )
  );
  const scaleUpMaxReadyAgeMs = readPositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_UP_MAX_READY_AGE_MS", 2_000);

  return {
    minWorkers,
    maxWorkers,
    scaleIntervalMs,
    readySessionsPerWorker: readPositiveIntEnv("OAH_EMBEDDED_WORKER_READY_SESSIONS_PER_WORKER", 1),
    scaleUpCooldownMs,
    scaleDownCooldownMs,
    scaleUpSampleSize,
    scaleDownSampleSize,
    scaleUpBusyRatioThreshold,
    scaleUpMaxReadyAgeMs
  };
}

export function createWorkerHost(options: {
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
}): WorkerHost {
  if (!options.startWorker || !options.redisRunQueue || !options.config.storage.redis_url) {
    return {
      start() {
        return undefined;
      },
      snapshot() {
        return null;
      },
      async close() {
        return undefined;
      }
    };
  }

  const poolConfig = resolveEmbeddedWorkerPoolConfig({
    config: options.config,
    processKind: options.processKind
  });
  const pool = new RedisRunWorkerPool({
    queue: options.redisRunQueue,
    queueFactory: () =>
      createRedisSessionRunQueue({
        url: options.config.storage.redis_url as string
      }),
    runtimeService: options.runtimeService,
    processKind: options.processKind === "worker" ? "standalone" : "embedded",
    registry: options.redisWorkerRegistry,
    minWorkers: poolConfig.minWorkers,
    maxWorkers: poolConfig.maxWorkers,
    scaleIntervalMs: poolConfig.scaleIntervalMs,
    readySessionsPerWorker: poolConfig.readySessionsPerWorker,
    scaleUpCooldownMs: poolConfig.scaleUpCooldownMs,
    scaleDownCooldownMs: poolConfig.scaleDownCooldownMs,
    scaleUpSampleSize: poolConfig.scaleUpSampleSize,
    scaleDownSampleSize: poolConfig.scaleDownSampleSize,
    scaleUpBusyRatioThreshold: poolConfig.scaleUpBusyRatioThreshold,
    scaleUpMaxReadyAgeMs: poolConfig.scaleUpMaxReadyAgeMs,
    logger: options.logger
  });

  return {
    start() {
      pool.start();
    },
    snapshot() {
      return pool.snapshot();
    },
    async close() {
      await pool.close();
    }
  };
}
