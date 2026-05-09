import {
  ownerBaseUrlMatches,
  workerRegistryMatchesPlacementOwner
} from "./bootstrap-runtime-helpers.js";

type PlacementRegistry = {
  assignOwnerAffinity(
    workspaceId: string,
    ownerId: string,
    options: { overwrite?: boolean | undefined; updatedAt: string }
  ): Promise<void>;
  releaseOwnership(
    workspaceId: string,
    options: { state: "unassigned" | "draining" | "evicted"; updatedAt: string }
  ): Promise<void>;
  getByWorkspaceId?(workspaceId: string): Promise<
    | {
        workspaceId: string;
        version: string;
        ownerWorkerId?: string | undefined;
        ownerBaseUrl?: string | undefined;
        state: string;
        lastActivityAt?: string | undefined;
        updatedAt: string;
        localPath?: string | undefined;
        remotePrefix?: string | undefined;
      }
    | undefined
  >;
};

type LeaseRegistry = {
  getByWorkspaceId?(workspaceId: string): Promise<
    | {
        workspaceId: string;
        version: string;
        ownerWorkerId: string;
        ownerBaseUrl?: string | undefined;
        health: "healthy" | "late";
        lastActivityAt: string;
        localPath?: string | undefined;
        remotePrefix?: string | undefined;
      }
    | undefined
  >;
};

type WorkerRegistry = {
  listActive?(): Promise<Array<{ workerId: string; runtimeInstanceId?: string | undefined }>>;
};

interface WorkspaceCoordinationApi {
  assignWorkspacePlacementOwnerAffinity?: ((input: {
    workspaceId: string;
    ownerId: string;
    overwrite?: boolean | undefined;
  }) => Promise<void>) | undefined;
  releaseWorkspacePlacement?: ((input: {
    workspaceId: string;
    state?: "unassigned" | "draining" | "evicted" | undefined;
  }) => Promise<void>) | undefined;
  resolveWorkspaceOwnership?: ((workspaceId: string) => Promise<{
    workspaceId: string;
    version: string;
    ownerWorkerId: string;
    ownerBaseUrl?: string | undefined;
    health: "healthy" | "late";
    lastActivityAt: string;
    localPath?: string | undefined;
    remotePrefix?: string | undefined;
    isLocalOwner: boolean;
  } | undefined>) | undefined;
}

export function createWorkspaceCoordinationApi(input: {
  redisWorkspaceLeaseRegistry: LeaseRegistry | undefined;
  redisWorkspacePlacementRegistry: PlacementRegistry | undefined;
  redisWorkerRegistry: WorkerRegistry | undefined;
  currentWorkerId: string;
  ownerBaseUrl?: string | undefined;
}): WorkspaceCoordinationApi {
  return {
    ...(input.redisWorkspacePlacementRegistry
      ? {
          assignWorkspacePlacementOwnerAffinity: async (request: {
            workspaceId: string;
            ownerId: string;
            overwrite?: boolean | undefined;
          }) => {
            await input.redisWorkspacePlacementRegistry!.assignOwnerAffinity(request.workspaceId, request.ownerId, {
              overwrite: request.overwrite,
              updatedAt: new Date().toISOString()
            });
          },
          releaseWorkspacePlacement: async (request: {
            workspaceId: string;
            state?: "unassigned" | "draining" | "evicted" | undefined;
          }) => {
            await input.redisWorkspacePlacementRegistry!.releaseOwnership(request.workspaceId, {
              state: request.state ?? "evicted",
              updatedAt: new Date().toISOString()
            });
          }
        }
      : {}),
    ...((input.redisWorkspaceLeaseRegistry || input.redisWorkspacePlacementRegistry)
      ? {
          resolveWorkspaceOwnership: async (workspaceId: string) => {
            const lease = await input.redisWorkspaceLeaseRegistry?.getByWorkspaceId?.(workspaceId);
            if (lease) {
              return {
                workspaceId: lease.workspaceId,
                version: lease.version,
                ownerWorkerId: lease.ownerWorkerId,
                ...(lease.ownerBaseUrl ? { ownerBaseUrl: lease.ownerBaseUrl } : {}),
                health: lease.health,
                lastActivityAt: lease.lastActivityAt,
                localPath: lease.localPath,
                ...(lease.remotePrefix ? { remotePrefix: lease.remotePrefix } : {}),
                isLocalOwner: lease.ownerWorkerId === input.currentWorkerId
              };
            }

            const placement = await input.redisWorkspacePlacementRegistry?.getByWorkspaceId?.(workspaceId);
            const ownerWorkerId = placement?.ownerWorkerId?.trim();
            const placementOwnerBaseUrl = placement?.ownerBaseUrl?.trim();
            if (
              !placement ||
              !ownerWorkerId ||
              !placementOwnerBaseUrl ||
              placement.state === "evicted" ||
              placement.state === "unassigned"
            ) {
              return undefined;
            }

            if (input.redisWorkerRegistry && typeof input.redisWorkerRegistry.listActive === "function") {
              const activeWorkers = await input.redisWorkerRegistry.listActive();
              const ownerWorker = activeWorkers.find((worker) =>
                workerRegistryMatchesPlacementOwner(worker, ownerWorkerId)
              );
              if (!ownerWorker) {
                return undefined;
              }
            }

            return {
              workspaceId: placement.workspaceId,
              version: placement.version,
              ownerWorkerId,
              ownerBaseUrl: placementOwnerBaseUrl,
              health: placement.state === "draining" ? "late" as const : "healthy" as const,
              lastActivityAt: placement.lastActivityAt ?? placement.updatedAt,
              ...(placement.localPath ? { localPath: placement.localPath } : {}),
              ...(placement.remotePrefix ? { remotePrefix: placement.remotePrefix } : {}),
              isLocalOwner:
                ownerWorkerId === input.currentWorkerId || ownerBaseUrlMatches(placementOwnerBaseUrl, input.ownerBaseUrl)
            };
          }
        }
      : {})
  };
}
