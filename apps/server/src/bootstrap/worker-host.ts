import {
  RedisRunWorkerPool,
  createRedisSessionRunQueue,
  type RedisRunWorkerLogger,
  type RedisRunWorkerPoolSnapshot,
  type RedisWorkerRegistryEntry,
  type SessionRunQueue,
  type WorkerRegistry
} from "@oah/storage-redis";
import type { ExecutionRuntimeOperations } from "@oah/runtime-core";

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
      reserved_capacity_for_subagent?: number | undefined;
    } | undefined;
  } | undefined;
}

export interface WorkerPoolLike {
  start(): void;
  snapshot(): RedisRunWorkerPoolSnapshot | null;
  close(): Promise<void>;
}

export interface WorkerHost {
  start(): void;
  snapshot(): RedisRunWorkerPoolSnapshot | null;
  isDraining(): boolean;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface EmbeddedWorkerPoolConfig {
  minWorkers: number;
  maxWorkers: number;
  scaleIntervalMs: number;
  readySessionsPerCapacityUnit: number;
  reservedSubagentCapacity: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
}

export interface WorkerDrainConfig {
  timeoutMs?: number | undefined;
  strategy: "wait_forever" | "fail" | "requeue_running" | "requeue_all";
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveWorkerDrainConfig(): WorkerDrainConfig {
  const timeoutRaw = process.env.OAH_WORKER_DRAIN_TIMEOUT_MS;
  const parsedTimeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;
  const strategyRaw = process.env.OAH_WORKER_DRAIN_TIMEOUT_STRATEGY?.trim();
  const strategy =
    strategyRaw === "fail" ||
    strategyRaw === "requeue_running" ||
    strategyRaw === "requeue_all" ||
    strategyRaw === "wait_forever"
      ? strategyRaw
      : "wait_forever";

  return {
    timeoutMs,
    strategy
  };
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
    readySessionsPerCapacityUnit: readPositiveIntEnv("OAH_EMBEDDED_WORKER_READY_SESSIONS_PER_CAPACITY_UNIT", 1),
    reservedSubagentCapacity: readNonNegativeIntEnv(
      "OAH_EMBEDDED_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT",
      embedded?.reserved_capacity_for_subagent ?? 1
    ),
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
  runtimeInstanceId?: string | undefined;
  ownerBaseUrl?: string | undefined;
  config: WorkerHostConfig;
  redisRunQueue?: SessionRunQueue | undefined;
  redisWorkerRegistry?: WorkerRegistry | undefined;
  runtimeService: ExecutionRuntimeOperations;
  logger?: RedisRunWorkerLogger | undefined;
  poolFactory?: ((options: ConstructorParameters<typeof RedisRunWorkerPool>[0]) => WorkerPoolLike) | undefined;
}): WorkerHost {
  if (!options.startWorker || !options.redisRunQueue || !options.config.storage.redis_url) {
    return {
      start() {
        return undefined;
      },
      snapshot() {
        return null;
      },
      isDraining() {
        return false;
      },
      async beginDrain() {
        return undefined;
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
  const poolOptions: ConstructorParameters<typeof RedisRunWorkerPool>[0] = {
    queue: options.redisRunQueue,
    queueFactory: () =>
      createRedisSessionRunQueue({
        url: options.config.storage.redis_url as string
      }),
    runtimeService: {
      processQueuedRun: (runId) => options.runtimeService.processQueuedRun(runId),
      ...(options.runtimeService.getRun
        ? {
            describeQueuedRun: async (runId: string) => {
              const run = await options.runtimeService.getRun!(runId);
              return run ? { workspaceId: run.workspaceId } : undefined;
            }
          }
        : {}),
      ...(options.runtimeService.recoverStaleRuns
        ? {
            recoverStaleRuns: (input?: { staleBefore?: string | undefined; limit?: number | undefined }) =>
              options.runtimeService.recoverStaleRuns!(input)
          }
        : {})
    },
    processKind: options.processKind === "worker" ? "standalone" : "embedded",
    ...(options.runtimeInstanceId ? { runtimeInstanceId: options.runtimeInstanceId } : {}),
    ...(options.ownerBaseUrl ? { ownerBaseUrl: options.ownerBaseUrl } : {}),
    registry: options.redisWorkerRegistry,
    minWorkers: poolConfig.minWorkers,
    maxWorkers: poolConfig.maxWorkers,
    scaleIntervalMs: poolConfig.scaleIntervalMs,
    readySessionsPerCapacityUnit: poolConfig.readySessionsPerCapacityUnit,
    reservedSubagentCapacity: poolConfig.reservedSubagentCapacity,
    scaleUpCooldownMs: poolConfig.scaleUpCooldownMs,
    scaleDownCooldownMs: poolConfig.scaleDownCooldownMs,
    scaleUpSampleSize: poolConfig.scaleUpSampleSize,
    scaleDownSampleSize: poolConfig.scaleDownSampleSize,
    scaleUpBusyRatioThreshold: poolConfig.scaleUpBusyRatioThreshold,
    scaleUpMaxReadyAgeMs: poolConfig.scaleUpMaxReadyAgeMs,
    logger: options.logger
  };
  const pool = (options.poolFactory ? options.poolFactory(poolOptions) : new RedisRunWorkerPool(poolOptions)) satisfies WorkerPoolLike;
  let draining = false;
  let closePromise: Promise<void> | undefined;
  const drainConfig = resolveWorkerDrainConfig();

  const closePool = () => {
    if (!closePromise) {
      draining = true;
      const gracefulClose = pool.close();
      gracefulClose.catch((error) => {
        options.logger?.warn("Worker pool close failed during drain.", error);
      });
      const timeoutStrategy = drainConfig.strategy;

      if (
        timeoutStrategy === "wait_forever" ||
        !drainConfig.timeoutMs ||
        !options.runtimeService.recoverRunAfterDrainTimeout
      ) {
        closePromise = gracefulClose;
      } else {
        closePromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            void forceRecoverActiveRunsOnDrainTimeout({
              pool,
              strategy: timeoutStrategy,
              recoverRunAfterDrainTimeout: options.runtimeService.recoverRunAfterDrainTimeout!,
              logger: options.logger
            }).finally(resolve);
          }, drainConfig.timeoutMs);
          timeout.unref?.();

          gracefulClose.then(
            () => {
              clearTimeout(timeout);
              resolve();
            },
            (error) => {
              clearTimeout(timeout);
              reject(error);
            }
          );
        });
      }
    }

    return closePromise;
  };

  return {
    start() {
      if (draining) {
        return;
      }

      pool.start();
    },
    snapshot() {
      return pool.snapshot();
    },
    isDraining() {
      return draining;
    },
    async beginDrain() {
      await closePool();
    },
    async close() {
      await closePool();
    }
  };
}

async function forceRecoverActiveRunsOnDrainTimeout(input: {
  pool: WorkerPoolLike;
  strategy: Exclude<WorkerDrainConfig["strategy"], "wait_forever">;
  recoverRunAfterDrainTimeout: (
    runId: string,
    strategy: Exclude<WorkerDrainConfig["strategy"], "wait_forever">
  ) => Promise<"failed" | "requeued" | "ignored">;
  logger?: RedisRunWorkerLogger | undefined;
}): Promise<void> {
  const slots = input.pool.snapshot()?.slots ?? [];
  const activeRunIds = [...new Set(slots.filter((slot) => slot.state === "busy" && slot.currentRunId).map((slot) => slot.currentRunId!))];

  input.logger?.warn(
    `Worker drain timed out; applying ${input.strategy} recovery to ${activeRunIds.length} active run(s).`
  );

  await Promise.all(
    activeRunIds.map(async (runId) => {
      try {
        await input.recoverRunAfterDrainTimeout(runId, input.strategy);
      } catch (error) {
        input.logger?.warn(`Failed to recover run ${runId} after worker drain timeout.`, error);
      }
    })
  );
}
