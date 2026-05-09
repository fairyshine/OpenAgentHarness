import type { ServerConfig } from "@oah/config";
import type { HealthReport, ReadinessReport } from "@oah/api-contracts";
import { describeSandboxTopology } from "../sandbox-topology.js";
import {
  resolveRuntimeStateDir,
  resolveWorkspaceMaterializationCacheRoot
} from "./engine-state-paths.js";
import { evaluateWorkerDiskReadiness } from "./worker-disk-readiness.js";
import type { EngineProcessDescriptor } from "./engine-process.js";
import type { SandboxHost } from "./sandbox-host.js";
import type { WorkerRuntimeStatus } from "./worker-runtime.js";
import {
  resolveRedisReadyQueueDepth,
  resolveRedisReadyQueueReadinessLimit
} from "./bootstrap-runtime-helpers.js";

type CheckStatus = "up" | "down" | "not_configured";
type RedisRunQueueHealthProbe = {
  ping(): Promise<boolean>;
  readyQueueLength?: (() => Promise<number>) | undefined;
  getReadySessionCount?: (() => Promise<number>) | undefined;
};

export function createRuntimeHealthReports(input: {
  config: ServerConfig;
  runtimeProcess: EngineProcessDescriptor;
  primaryStorageMode: "sqlite" | "postgres";
  postgresConfigured: boolean;
  redisConfigured: boolean;
  persistence: unknown;
  redisBus: { ping(): Promise<boolean> } | undefined;
  redisRunQueue: RedisRunQueueHealthProbe | undefined;
  sandboxHost: SandboxHost | undefined;
  getWorkerStatus(): Promise<WorkerRuntimeStatus>;
}): {
  healthReport(): Promise<HealthReport>;
  readinessReport(): Promise<ReadinessReport>;
} {
  async function postgresCheck(): Promise<CheckStatus> {
    if (!input.postgresConfigured) {
      return "not_configured";
    }

    if (
      input.primaryStorageMode !== "postgres" ||
      typeof input.persistence !== "object" ||
      input.persistence === null ||
      !("pool" in input.persistence)
    ) {
      return "down";
    }

    try {
      await (input.persistence.pool as { query(sql: string): Promise<unknown> }).query("select 1");
      return "up";
    } catch {
      return "down";
    }
  }

  async function redisEventsCheck(): Promise<CheckStatus> {
    if (!input.redisConfigured) {
      return "not_configured";
    }

    if (!input.redisBus) {
      return "down";
    }

    return (await input.redisBus.ping()) ? "up" : "down";
  }

  async function redisRunQueueCheck(): Promise<CheckStatus> {
    if (!input.redisConfigured) {
      return "not_configured";
    }

    if (!input.redisRunQueue) {
      return "down";
    }

    return (await input.redisRunQueue.ping()) ? "up" : "down";
  }

  return {
    async healthReport() {
      const workerStatus = await input.getWorkerStatus();
      const materializationDiagnostics = input.sandboxHost?.diagnostics().materialization;
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck()
      };

      return {
        status:
          Object.values(checks).some((value) => value === "down") || (materializationDiagnostics?.failureCount ?? 0) > 0
            ? "degraded"
            : "ok",
        storage: {
          primary: input.primaryStorageMode,
          events: input.redisBus ? "redis" : "memory",
          runQueue: input.redisRunQueue ? "redis" : "in_process"
        },
        process: input.runtimeProcess,
        sandbox: describeSandboxTopology(input.sandboxHost?.providerKind),
        checks,
        worker: {
          ...workerStatus,
          ...(materializationDiagnostics ? { materialization: materializationDiagnostics } : {})
        }
      };
    },

    async readinessReport() {
      const workerStatus = await input.getWorkerStatus();
      const workerDiskReadiness =
        input.runtimeProcess.mode === "api_only"
          ? undefined
          : evaluateWorkerDiskReadiness({
              paths: [
                input.config.paths.workspace_dir,
                resolveRuntimeStateDir(input.config.paths),
                resolveWorkspaceMaterializationCacheRoot(input.config.paths)
              ]
            });
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck()
      };
      const readyQueueDepth = await resolveRedisReadyQueueDepth({ redisRunQueue: input.redisRunQueue });
      const readyQueueLimit = resolveRedisReadyQueueReadinessLimit();
      const checksDown = Object.values(checks).includes("down");
      const workerDiskPressure = workerDiskReadiness?.status === "pressure";
      const redisReadyQueuePressure =
        readyQueueDepth !== undefined && readyQueueLimit !== undefined && readyQueueDepth >= readyQueueLimit;

      return {
        status: workerStatus.draining || workerDiskPressure || redisReadyQueuePressure || checksDown ? "not_ready" : "ready",
        ...(workerStatus.draining ? { reason: "draining" as const, draining: true } : {}),
        ...(!workerStatus.draining && workerDiskPressure ? { reason: "worker_disk_pressure" as const } : {}),
        ...(!workerStatus.draining && !workerDiskPressure && redisReadyQueuePressure
          ? { reason: "redis_ready_queue_pressure" as const }
          : {}),
        ...(!workerStatus.draining && !workerDiskPressure && !redisReadyQueuePressure && checksDown
          ? { reason: "checks_down" as const }
          : {}),
        checks,
        ...(workerDiskReadiness && workerDiskPressure ? { resources: { workerDisk: workerDiskReadiness } } : {}),
        ...(readyQueueDepth !== undefined
          ? {
              queue: {
                readySessionDepth: readyQueueDepth,
                ...(readyQueueLimit !== undefined ? { readinessLimit: readyQueueLimit } : {})
              }
            }
          : {})
      };
    }
  };
}
