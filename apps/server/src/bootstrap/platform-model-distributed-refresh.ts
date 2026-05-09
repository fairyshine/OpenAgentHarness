import {
  platformModelSnapshotSchema,
  type DistributedPlatformModelRefreshResult
} from "@oah/api-contracts";
import type { PlatformModelSnapshot } from "./platform-model-service.js";

export async function refreshDistributedPlatformModels(input: {
  refreshLocalSnapshot(): Promise<PlatformModelSnapshot>;
  redisWorkerRegistry: { listActive(): Promise<Array<{ workerId: string; runtimeInstanceId?: string | undefined; ownerBaseUrl?: string | undefined }>> } | undefined;
  runtimeInstanceId: string;
  ownerBaseUrl?: string | undefined;
}): Promise<DistributedPlatformModelRefreshResult> {
  const snapshot = await input.refreshLocalSnapshot();
  const activeWorkers =
    input.redisWorkerRegistry && typeof input.redisWorkerRegistry.listActive === "function"
      ? await input.redisWorkerRegistry.listActive()
      : [];
  const localBaseUrl = input.ownerBaseUrl?.replace(/\/+$/u, "");
  const remoteTargets = new Map<string, { workerId: string; runtimeInstanceId?: string; ownerBaseUrl: string }>();

  for (const entry of activeWorkers) {
    const targetBaseUrl = entry.ownerBaseUrl?.trim().replace(/\/+$/u, "");
    if (!targetBaseUrl) {
      continue;
    }
    if (entry.runtimeInstanceId === input.runtimeInstanceId) {
      continue;
    }
    if (localBaseUrl && targetBaseUrl === localBaseUrl) {
      continue;
    }
    if (remoteTargets.has(targetBaseUrl)) {
      continue;
    }

    remoteTargets.set(targetBaseUrl, {
      workerId: entry.workerId,
      ...(entry.runtimeInstanceId ? { runtimeInstanceId: entry.runtimeInstanceId } : {}),
      ownerBaseUrl: targetBaseUrl
    });
  }

  const targets = await Promise.all(
    [...remoteTargets.values()].map(async (target) => {
      try {
        const response = await fetch(`${target.ownerBaseUrl}/internal/v1/platform-models/refresh`, {
          method: "POST"
        });

        if (!response.ok) {
          return {
            ...target,
            status: "failed" as const,
            error: `HTTP ${response.status}`
          };
        }

        return {
          ...target,
          status: "refreshed" as const,
          snapshot: platformModelSnapshotSchema.parse(await response.json())
        };
      } catch (error) {
        return {
          ...target,
          status: "failed" as const,
          error: error instanceof Error ? error.message : "Unknown refresh error."
        };
      }
    })
  );

  const succeeded = targets.filter((target) => target.status === "refreshed").length;

  return {
    snapshot,
    summary: {
      attempted: targets.length,
      succeeded,
      failed: targets.length - succeeded
    },
    targets
  };
}
