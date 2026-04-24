import type { FSWatcher } from "node:fs";
import type { ServerConfig } from "@oah/config";

import { ControlPlaneEngineService, type ControlPlaneRuntimeOperations } from "../../../../packages/engine-core/src/control-plane-engine-service.js";
import type { EngineService } from "../../../../packages/engine-core/src/engine-service.js";
import type {
  EngineLogger,
  RunRepository,
  SessionRepository,
  WorkspacePrewarmer,
  WorkspaceRecord,
  WorkspaceRepository
} from "../../../../packages/engine-core/src/types.js";
import { cleanupWorkspaceLocalArtifacts } from "./engine-state-paths.js";
import { ScopedRunRepository, ScopedSessionRepository, ScopedWorkspaceRepository } from "./scoped-repositories.js";
import type { SandboxHost } from "./sandbox-host.js";
import {
  discoverProjectWorkspaces,
  findManagedWorkspaceIdsToDelete,
  isManagedWorkspace,
  isManagedWorkspaceRoot,
  openFsWatcher,
  reconcileDiscoveredWorkspaces,
  type PlatformAgentRegistry
} from "./workspace-registry.js";

let workspaceDefinitionHelpersPromise: Promise<typeof import("./workspace-definition-helpers.js")> | undefined;
let modelMetadataDiscoveryModulePromise: Promise<typeof import("./model-metadata-discovery.js")> | undefined;

function loadWorkspaceDefinitionHelpersModule(): Promise<typeof import("./workspace-definition-helpers.js")> {
  workspaceDefinitionHelpersPromise ??= import("./workspace-definition-helpers.js");
  return workspaceDefinitionHelpersPromise;
}

function loadModelMetadataDiscoveryModule(): Promise<typeof import("./model-metadata-discovery.js")> {
  modelMetadataDiscoveryModulePromise ??= import("./model-metadata-discovery.js");
  return modelMetadataDiscoveryModulePromise;
}

function mergeRefreshedWorkspaceRecord(
  workspace: WorkspaceRecord,
  discovered: WorkspaceRecord,
  updatedAt: string
): WorkspaceRecord {
  return {
    ...discovered,
    id: workspace.id,
    name: workspace.name,
    executionPolicy: workspace.executionPolicy,
    status: workspace.status,
    createdAt: workspace.createdAt,
    updatedAt,
    historyMirrorEnabled: workspace.historyMirrorEnabled,
    ...(workspace.ownerId ? { ownerId: workspace.ownerId } : {}),
    ...(workspace.serviceName ? { serviceName: workspace.serviceName } : {}),
    ...(workspace.runtime ? { runtime: workspace.runtime } : {}),
    ...(workspace.externalRef ? { externalRef: workspace.externalRef } : {})
  } as WorkspaceRecord;
}

interface WorkspaceLeaseRegistryLike {
  listActive(): Promise<Array<{ workspaceId: string }>>;
  removeWorkspace(workspaceId: string): Promise<void>;
}

interface WorkspacePlacementRegistryLike {
  listAll(): Promise<Array<{ workspaceId: string }>>;
  removeWorkspace(workspaceId: string): Promise<void>;
}

interface PersistenceLike {
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  runRepository: RunRepository;
  listPersistedWorkspaces?(): Promise<WorkspaceRecord[]>;
  listWorkspaceSnapshots?(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]>;
}

export interface PreparedControlPlaneRuntime {
  visibleWorkspaceIds: Set<string>;
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  runRepository: RunRepository;
  reconciledWorkspaces: WorkspaceRecord[];
  initialize(): Promise<void>;
  refreshWorkspaceDefinitionsForPlatformModels(): Promise<void>;
  createControlPlaneEngineService(input: {
    runtimeService: EngineService;
    touchWorkspaceActivity?: ((workspaceId: string) => Promise<void>) | undefined;
    workspacePrewarmer?: WorkspacePrewarmer | undefined;
    logger?: EngineLogger | undefined;
  }): ControlPlaneRuntimeOperations;
  close(): Promise<void>;
}

export async function prepareControlPlaneRuntime(options: {
  config: ServerConfig;
  persistence: PersistenceLike;
  discoveredWorkspaces: WorkspaceRecord[];
  managesWorkspaceRegistry: boolean;
  enableControlPlaneFacade: boolean;
  remoteSandboxProvider: boolean;
  singleWorkspaceDefined: boolean;
  models: Awaited<ReturnType<typeof import("@oah/config").loadPlatformModels>>;
  toolDir: string;
  sqliteShadowRoot: string;
  sandboxHost?: SandboxHost | undefined;
  redisWorkspaceLeaseRegistry?: WorkspaceLeaseRegistryLike | undefined;
  redisWorkspacePlacementRegistry?: WorkspacePlacementRegistryLike | undefined;
  pollingConfig: { enabled: boolean; intervalMs: number };
  workspaceModelMetadataDiscovery: "eager" | "background";
  getPlatformAgents(): Promise<PlatformAgentRegistry>;
  logWorkspaceDiscoveryError(rootPath: string, kind: "project", error: unknown): void;
  discoverWorkspaceWithEnrichedModels(rootPath: string, kind: "project"): Promise<WorkspaceRecord>;
  applyManagedWorkspaceExternalRef(workspace: WorkspaceRecord): WorkspaceRecord;
  withWorkspaceDefinitionTimestamp(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  listRepositoryWorkspaces(repository: WorkspaceRepository): Promise<WorkspaceRecord[]>;
}): Promise<PreparedControlPlaneRuntime> {
  const persistedWorkspaceSnapshots =
    typeof options.persistence.listPersistedWorkspaces === "function"
      ? await options.persistence.listPersistedWorkspaces()
      : typeof options.persistence.listWorkspaceSnapshots === "function"
        ? await options.persistence.listWorkspaceSnapshots(options.discoveredWorkspaces)
        : await options.listRepositoryWorkspaces(options.persistence.workspaceRepository);

  const bootWorkspaceCandidates =
    options.singleWorkspaceDefined
      ? options.discoveredWorkspaces
      : !options.managesWorkspaceRegistry
        ? persistedWorkspaceSnapshots
        : [
            ...options.discoveredWorkspaces,
            ...persistedWorkspaceSnapshots.filter((workspace) => !isManagedWorkspace(workspace, options.config.paths))
          ];

  const reconciledWorkspaces = reconcileDiscoveredWorkspaces(
    bootWorkspaceCandidates,
    persistedWorkspaceSnapshots
  ).map((workspace) => options.applyManagedWorkspaceExternalRef(workspace));

  const visibleWorkspaceIds = new Set<string>();
  const workspaceRepository = new ScopedWorkspaceRepository(options.persistence.workspaceRepository, visibleWorkspaceIds);
  const sessionRepository = new ScopedSessionRepository(options.persistence.sessionRepository, visibleWorkspaceIds);
  const runRepository = new ScopedRunRepository(options.persistence.runRepository, visibleWorkspaceIds);
  const workspaceDefinitionRefreshes = new Map<string, Promise<void>>();
  const workspaceRegistrySyncDebounceMs = 200;
  let workspaceRegistrySyncPromise: Promise<void> | undefined;
  let lastWorkspaceRegistrySyncAt = 0;
  let workspaceRegistryPollTimer: NodeJS.Timeout | undefined;
  let workspaceMetadataHydrationTimer: NodeJS.Timeout | undefined;
  let workspaceMetadataHydrationPromise: Promise<void> | undefined;
  let workspaceSyncTimer: NodeJS.Timeout | undefined;
  let watchedProjectRoots = new Map<string, FSWatcher>();

  async function clearWorkspaceCoordination(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (normalizedWorkspaceId.length === 0) {
      return;
    }

    const results = await Promise.allSettled([
      options.redisWorkspaceLeaseRegistry?.removeWorkspace(normalizedWorkspaceId) ?? Promise.resolve(),
      options.redisWorkspacePlacementRegistry?.removeWorkspace(normalizedWorkspaceId) ?? Promise.resolve()
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      console.warn(
        `[oah-bootstrap] Failed to clear coordination state for workspace ${normalizedWorkspaceId}.`,
        failures.map((failure) => failure.reason)
      );
    }
  }

  async function clearOrphanedWorkspaceCoordination(
    workspaces: Iterable<Pick<WorkspaceRecord, "id">>,
    reason: string
  ): Promise<void> {
    if (!options.redisWorkspaceLeaseRegistry && !options.redisWorkspacePlacementRegistry) {
      return;
    }

    const knownWorkspaceIds = new Set([...workspaces].map((workspace) => workspace.id));
    const orphanWorkspaceIds = new Set<string>();

    if (options.redisWorkspacePlacementRegistry) {
      for (const placement of await options.redisWorkspacePlacementRegistry.listAll()) {
        if (!knownWorkspaceIds.has(placement.workspaceId)) {
          orphanWorkspaceIds.add(placement.workspaceId);
        }
      }
    }

    if (options.redisWorkspaceLeaseRegistry) {
      for (const lease of await options.redisWorkspaceLeaseRegistry.listActive()) {
        if (!knownWorkspaceIds.has(lease.workspaceId)) {
          orphanWorkspaceIds.add(lease.workspaceId);
        }
      }
    }

    if (orphanWorkspaceIds.size === 0) {
      return;
    }

    await Promise.all([...orphanWorkspaceIds].map(async (workspaceId) => clearWorkspaceCoordination(workspaceId)));
    console.info(
      `[oah-bootstrap] Cleared orphaned workspace coordination for ${orphanWorkspaceIds.size} workspace(s) during ${reason}: ${[
        ...orphanWorkspaceIds
      ].join(", ")}`
    );
  }

  async function refreshWorkspaceDefinitionsForPlatformModelsNow(): Promise<void> {
    if (options.remoteSandboxProvider || !options.enableControlPlaneFacade) {
      return;
    }

    const currentWorkspaces = await options.listRepositoryWorkspaces(options.persistence.workspaceRepository);
    const refreshedWorkspaces = await Promise.all(
      currentWorkspaces.map(async (workspace) => {
        try {
          const discovered = await options.discoverWorkspaceWithEnrichedModels(workspace.rootPath, workspace.kind);
          return {
            ...discovered,
            id: workspace.id,
            name: workspace.name,
            executionPolicy: workspace.executionPolicy,
            status: workspace.status,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
            historyMirrorEnabled: workspace.historyMirrorEnabled,
            ...(workspace.serviceName ? { serviceName: workspace.serviceName } : {}),
            ...(workspace.externalRef ? { externalRef: workspace.externalRef } : {})
          } as WorkspaceRecord;
        } catch (error) {
          console.warn(`[oah-bootstrap] Failed to refresh workspace ${workspace.id} after platform model reload.`, error);
          return workspace;
        }
      })
    ).then((workspaces) => workspaces.map((workspace) => options.applyManagedWorkspaceExternalRef(workspace)));

    await Promise.all(refreshedWorkspaces.map(async (workspace) => options.persistence.workspaceRepository.upsert(workspace)));
    visibleWorkspaceIds.clear();
    refreshedWorkspaces.forEach((workspace) => {
      visibleWorkspaceIds.add(workspace.id);
    });
    updateWatchedProjectRoots(refreshedWorkspaces);
  }

  function scheduleWorkspaceModelMetadataHydration(delayMs = 0): void {
    if (options.workspaceModelMetadataDiscovery !== "background") {
      return;
    }

    if (options.remoteSandboxProvider || !options.enableControlPlaneFacade) {
      return;
    }

    if (workspaceMetadataHydrationTimer || workspaceMetadataHydrationPromise) {
      return;
    }

    workspaceMetadataHydrationTimer = setTimeout(() => {
      workspaceMetadataHydrationTimer = undefined;
      workspaceMetadataHydrationPromise = refreshWorkspaceDefinitionsForPlatformModelsNow()
        .catch((error) => {
          console.warn("Workspace model metadata hydration failed.", error);
        })
        .finally(() => {
          workspaceMetadataHydrationPromise = undefined;
        });
    }, Math.max(0, delayMs));
    workspaceMetadataHydrationTimer.unref?.();
  }

  async function refreshWorkspaceDefinitionIfNeeded(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (normalizedWorkspaceId.length === 0) {
      return;
    }

    const existingRefresh = workspaceDefinitionRefreshes.get(normalizedWorkspaceId);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshTask = (async () => {
      const {
        copyWorkspaceDefinitionSnapshot,
        readLatestWorkspaceDefinitionMtimeMs,
        readLiveWorkspaceSkillNames
      } = await loadWorkspaceDefinitionHelpersModule();
      const workspace = await options.persistence.workspaceRepository.getById(normalizedWorkspaceId);
      if (!workspace || workspace.kind !== "project") {
        return;
      }

      const liveSkillNames = await readLiveWorkspaceSkillNames({
        workspace,
        workspaceFileAccessProvider: options.sandboxHost?.workspaceFileAccessProvider,
        workspaceFileSystem: options.sandboxHost?.workspaceFileSystem
      });
      const cachedSkillNames = Object.keys(workspace.skills).sort((left, right) => left.localeCompare(right));
      const skillNamesChanged =
        liveSkillNames.length !== cachedSkillNames.length ||
        liveSkillNames.some((name, index) => name !== cachedSkillNames[index]);

      const latestDefinitionMtimeMs = await readLatestWorkspaceDefinitionMtimeMs(workspace.rootPath);
      if (!skillNamesChanged && latestDefinitionMtimeMs === undefined) {
        return;
      }

      const currentUpdatedAtMs = Date.parse(workspace.updatedAt);
      if (
        !skillNamesChanged &&
        Number.isFinite(currentUpdatedAtMs) &&
        latestDefinitionMtimeMs !== undefined &&
        latestDefinitionMtimeMs <= currentUpdatedAtMs
      ) {
        return;
      }

      const discoveryRoot =
        options.remoteSandboxProvider
          ? await copyWorkspaceDefinitionSnapshot({
              workspace,
              workspaceFileAccessProvider: options.sandboxHost?.workspaceFileAccessProvider,
              workspaceFileSystem: options.sandboxHost?.workspaceFileSystem
            })
          : workspace.rootPath;

      try {
        const discovered = await options.discoverWorkspaceWithEnrichedModels(discoveryRoot, workspace.kind);
        const refreshed = options.applyManagedWorkspaceExternalRef(
          mergeRefreshedWorkspaceRecord(workspace, discovered, new Date().toISOString())
        );
        await options.persistence.workspaceRepository.upsert(refreshed);
        visibleWorkspaceIds.add(refreshed.id);
      } finally {
        if (options.remoteSandboxProvider) {
          const { rm } = await import("node:fs/promises");
          await rm(discoveryRoot, { recursive: true, force: true });
        }
      }
    })().finally(() => {
      workspaceDefinitionRefreshes.delete(normalizedWorkspaceId);
    });

    workspaceDefinitionRefreshes.set(normalizedWorkspaceId, refreshTask);
    await refreshTask;
  }

  async function syncWorkspaceRegistry(): Promise<void> {
    const now = Date.now();
    if (workspaceRegistrySyncPromise) {
      return workspaceRegistrySyncPromise;
    }
    if (now - lastWorkspaceRegistrySyncAt < workspaceRegistrySyncDebounceMs) {
      scheduleWorkspaceRegistrySync(workspaceRegistrySyncDebounceMs - (now - lastWorkspaceRegistrySyncAt) + 25);
      return;
    }

    workspaceRegistrySyncPromise = (async () => {
      const latestProjectWorkspaces = (
        await discoverProjectWorkspaces({
          workspaceDir: options.config.paths.workspace_dir,
          models: options.models,
          platformAgents: await options.getPlatformAgents(),
          platformSkillDir: options.config.paths.skill_dir,
          platformToolDir: options.toolDir,
          onError: ({ rootPath, error }: { rootPath: string; kind: "project"; error: unknown }) => {
            options.logWorkspaceDiscoveryError(rootPath, "project", error);
          }
        }).then(async (workspaces) => {
          if (options.workspaceModelMetadataDiscovery !== "eager") {
            return workspaces;
          }

          const { enrichWorkspaceModelsWithDiscoveredMetadata } = await loadModelMetadataDiscoveryModule();
          return Promise.all(workspaces.map((workspace) => enrichWorkspaceModelsWithDiscoveredMetadata(workspace)));
        })
      ).map((workspace) => options.applyManagedWorkspaceExternalRef(workspace as WorkspaceRecord));
      const persistedWorkspaces = await options.listRepositoryWorkspaces(options.persistence.workspaceRepository);
      const staticWorkspaces = persistedWorkspaces.filter((workspace) => !isManagedWorkspace(workspace, options.config.paths));
      const latestDiscoveredWorkspaces = [...latestProjectWorkspaces, ...staticWorkspaces];
      const staleWorkspaceIds = findManagedWorkspaceIdsToDelete(
        latestDiscoveredWorkspaces,
        persistedWorkspaces,
        options.config.paths
      );
      const staleWorkspaces = persistedWorkspaces.filter((workspace) => staleWorkspaceIds.includes(workspace.id));

      await Promise.all(
        staleWorkspaces.map(async (workspace) => {
          const cleanup = await cleanupWorkspaceLocalArtifacts({
            workspace,
            paths: options.config.paths,
            sqliteShadowRoot: options.sqliteShadowRoot
          });
          console.info(
            `[oah-bootstrap] Cleaned local artifacts for stale workspace ${workspace.id} (${cleanup.mode}): ${cleanup.removedPaths.join(", ")}`
          );
          await options.persistence.workspaceRepository.delete(workspace.id);
        })
      );

      const latestPersistedWorkspaces =
        staleWorkspaceIds.length > 0
          ? await options.listRepositoryWorkspaces(options.persistence.workspaceRepository)
          : persistedWorkspaces;
      const latestReconciledWorkspaces = await Promise.all(
        reconcileDiscoveredWorkspaces(latestDiscoveredWorkspaces, latestPersistedWorkspaces).map(async (workspace) =>
          options.applyManagedWorkspaceExternalRef(await options.withWorkspaceDefinitionTimestamp(workspace))
        )
      );

      await Promise.all(
        latestReconciledWorkspaces.map(async (workspace) => options.persistence.workspaceRepository.upsert(workspace))
      );

      visibleWorkspaceIds.clear();
      latestReconciledWorkspaces.forEach((workspace) => {
        visibleWorkspaceIds.add(workspace.id);
      });
      await clearOrphanedWorkspaceCoordination(latestReconciledWorkspaces, "workspace_registry_sync");
      updateWatchedProjectRoots(latestReconciledWorkspaces);
      scheduleWorkspaceModelMetadataHydration();
      lastWorkspaceRegistrySyncAt = Date.now();
    })().finally(() => {
      workspaceRegistrySyncPromise = undefined;
    });

    return workspaceRegistrySyncPromise;
  }

  function updateWatchedProjectRoots(workspaces: WorkspaceRecord[]): void {
    if (!options.managesWorkspaceRegistry) {
      return;
    }

    const nextRoots = new Set(
      workspaces
        .filter(
          (workspace) =>
            workspace.kind === "project" &&
            isManagedWorkspaceRoot(workspace.rootPath, options.config.paths.workspace_dir)
        )
        .map((workspace) => workspace.rootPath)
    );

    for (const [rootPath, watcher] of watchedProjectRoots.entries()) {
      if (nextRoots.has(rootPath)) {
        continue;
      }

      watcher.close();
      watchedProjectRoots.delete(rootPath);
    }

    for (const rootPath of nextRoots) {
      if (watchedProjectRoots.has(rootPath)) {
        continue;
      }

      const watcher = openFsWatcher(rootPath, scheduleWorkspaceRegistrySync, true);
      if (watcher) {
        watchedProjectRoots.set(rootPath, watcher);
      }
    }
  }

  function scheduleWorkspaceRegistrySync(delayMs = 150): void {
    if (!options.managesWorkspaceRegistry) {
      return;
    }

    if (workspaceSyncTimer) {
      clearTimeout(workspaceSyncTimer);
    }

    workspaceSyncTimer = setTimeout(() => {
      workspaceSyncTimer = undefined;
      void syncWorkspaceRegistry().catch((error) => {
        console.warn("Workspace registry sync failed.", error);
      });
    }, Math.max(0, delayMs));
    workspaceSyncTimer.unref?.();
  }

  const rootWorkspaceWatcher = options.managesWorkspaceRegistry
    ? openFsWatcher(options.config.paths.workspace_dir, scheduleWorkspaceRegistrySync)
    : undefined;

  return {
    visibleWorkspaceIds,
    workspaceRepository,
    sessionRepository,
    runRepository,
    reconciledWorkspaces,
    async initialize() {
      reconciledWorkspaces.forEach((workspace) => {
        visibleWorkspaceIds.add(workspace.id);
      });
      await Promise.all(reconciledWorkspaces.map((workspace) => workspaceRepository.upsert(workspace)));
      await clearOrphanedWorkspaceCoordination(reconciledWorkspaces, "bootstrap");
      updateWatchedProjectRoots(reconciledWorkspaces);

      if (options.managesWorkspaceRegistry) {
        await syncWorkspaceRegistry();
        if (options.pollingConfig.enabled) {
          workspaceRegistryPollTimer = setInterval(() => {
            void syncWorkspaceRegistry().catch((error) => {
              console.warn("Workspace registry poll sync failed.", error);
            });
          }, options.pollingConfig.intervalMs);
          workspaceRegistryPollTimer.unref?.();
        }
      }
      scheduleWorkspaceModelMetadataHydration();
    },
    async refreshWorkspaceDefinitionsForPlatformModels() {
      await refreshWorkspaceDefinitionsForPlatformModelsNow();
    },
    createControlPlaneEngineService(input) {
      if (!options.enableControlPlaneFacade) {
        return input.runtimeService;
      }

      return new ControlPlaneEngineService(input.runtimeService, {
        workspaceDefinitionRefresher: {
          async refreshWorkspaceDefinition(workspaceId: string) {
            await refreshWorkspaceDefinitionIfNeeded(workspaceId);
          }
        },
        ...(input.touchWorkspaceActivity
          ? {
              workspaceActivityTracker: {
                async touchWorkspace(workspaceId: string) {
                  await input.touchWorkspaceActivity!(workspaceId);
                }
              }
            }
          : {}),
        ...(input.workspacePrewarmer ? { workspacePrewarmer: input.workspacePrewarmer } : {}),
        ...(input.logger ? { logger: input.logger } : {})
      });
    },
    async close() {
      if (workspaceSyncTimer) {
        clearTimeout(workspaceSyncTimer);
      }
      if (workspaceMetadataHydrationTimer) {
        clearTimeout(workspaceMetadataHydrationTimer);
      }
      if (workspaceRegistryPollTimer) {
        clearInterval(workspaceRegistryPollTimer);
      }
      rootWorkspaceWatcher?.close();
      for (const watcher of watchedProjectRoots.values()) {
        watcher.close();
      }
      watchedProjectRoots.clear();
    }
  };
}
