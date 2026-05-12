import type { ServerConfig } from "@oah/config";
import type { ExecutionRuntimeOperations } from "@oah/engine-core";
import type { WorkerRuntimeControl } from "./worker-runtime.js";

type WorkerRuntimeModule = Awaited<ReturnType<typeof import("./module-loaders.js").loadWorkerRuntimeModule>>;
type MetadataRetentionModule = Awaited<ReturnType<typeof import("./module-loaders.js").loadMetadataRetentionModule>>;

export async function createWorkerRuntimeService(input: {
  enabled: boolean;
  loadWorkerRuntimeModule: () => Promise<WorkerRuntimeModule>;
  startWorker: boolean;
  processKind: "api" | "worker";
  runtimeInstanceId: string;
  ownerBaseUrl?: string | undefined;
  config: ServerConfig;
  redisRunQueue: unknown;
  redisWorkerRegistry: unknown;
  runtimeService: ExecutionRuntimeOperations;
  describeQueuedRun: (runId: string) => Promise<{ workspaceId?: string | undefined; preferredWorkerId?: string | undefined } | undefined>;
}): Promise<WorkerRuntimeControl | undefined> {
  if (!input.enabled) {
    return undefined;
  }

  return (await input.loadWorkerRuntimeModule()).createWorkerRuntimeControl({
    startWorker: input.startWorker,
    processKind: input.processKind,
    runtimeInstanceId: input.runtimeInstanceId,
    ownerBaseUrl: input.ownerBaseUrl,
    config: input.config,
    redisRunQueue: input.redisRunQueue as Parameters<WorkerRuntimeModule["createWorkerRuntimeControl"]>[0]["redisRunQueue"],
    redisWorkerRegistry: input.redisWorkerRegistry as Parameters<WorkerRuntimeModule["createWorkerRuntimeControl"]>[0]["redisWorkerRegistry"],
    runtimeService: input.runtimeService,
    describeQueuedRun: input.describeQueuedRun,
    logger: {
      info(message) {
        console.info(message);
      },
      warn(message, error) {
        console.warn(message, error);
      },
      error(message, error) {
        console.error(message, error);
      }
    }
  });
}

export async function createPostgresMetadataRetentionService(input: {
  enabled: boolean;
  persistence: unknown;
  config: {
    intervalMs: number;
    batchLimit: number;
    historyEventRetentionDays: number;
    sessionEventRetentionDays: number;
    runRetentionDays: number;
  };
  loadMetadataRetentionModule: () => Promise<MetadataRetentionModule>;
}): Promise<InstanceType<MetadataRetentionModule["PostgresMetadataRetentionService"]> | undefined> {
  if (!input.enabled || typeof input.persistence !== "object" || input.persistence === null || !("pool" in input.persistence)) {
    return undefined;
  }

  return new (await input.loadMetadataRetentionModule()).PostgresMetadataRetentionService({
    pool: input.persistence.pool as ConstructorParameters<MetadataRetentionModule["PostgresMetadataRetentionService"]>[0]["pool"],
    intervalMs: input.config.intervalMs,
    batchLimit: input.config.batchLimit,
    historyEventRetentionDays: input.config.historyEventRetentionDays,
    sessionEventRetentionDays: input.config.sessionEventRetentionDays,
    runRetentionDays: input.config.runRetentionDays,
    logger: {
      info(message) {
        console.info(message);
      },
      warn(message, error) {
        console.warn(message, error);
      }
    }
  });
}
