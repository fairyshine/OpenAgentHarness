import path from "node:path";

import type { ServerConfig } from "@oah/config";
import type {
  ModelGateway,
  WorkspaceRecord
} from "@oah/engine-core";
import { ExecutionEngineService } from "@oah/engine-core";
import { EngineService } from "@oah/engine-core";
import type { ControlPlaneRuntimeOperations } from "@oah/engine-core";
import type { WorkspaceMaterializationManager } from "./bootstrap/workspace-materialization.js";
import type { SandboxHost } from "./bootstrap/sandbox-host.js";
import { LazyModelRuntime } from "./bootstrap/lazy-model-runtime.js";
import { createLazyStorageAdmin } from "./bootstrap/lazy-storage-admin.js";
import type { WorkerRuntimeStatus } from "./bootstrap/worker-runtime.js";
import { appendEngineLogEvent, buildRuntimeConsoleLogger } from "./engine-console.js";
import {
  describeObjectStoragePolicy,
  resolveObjectStorageMirrorConfig
} from "./bootstrap/object-storage-policy.js";
import {
  createPlatformModelCatalogService,
  type PlatformModelSnapshot
} from "./bootstrap/platform-model-service.js";
import { refreshDistributedPlatformModels } from "./bootstrap/platform-model-distributed-refresh.js";
import {
  buildSingleWorkspaceConfig,
  describeEngineProcess,
  formatSingleWorkspaceLegacyWarning,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldStartEmbeddedWorker
} from "./bootstrap/engine-process.js";
import type { PlatformAgentRegistry } from "./bootstrap/workspace-registry.js";
import {
  resolveArchiveExportRoot,
  resolvePostgresArchivePayloadRoot,
  resolveRuntimeStateDir,
  resolveSqliteShadowRoot,
  resolveWorkspaceMaterializationCacheRoot
} from "./bootstrap/engine-state-paths.js";
import {
  parsePositiveIntEnv,
  parsePositiveIntEnvWithMin,
  resolveObjectStorageMirrorBlockingInit,
  resolveWorkspaceMaterializationConfig,
  resolveWorkspacePrewarmConfig,
  resolveWorkspaceRegistryPollingConfig
} from "./bootstrap/bootstrap-config.js";
import { createLocalWorkspaceManagement } from "./bootstrap/local-workspace-management.js";
import {
  createPostgresMetadataRetentionService,
  createWorkerRuntimeService
} from "./bootstrap/runtime-background-services.js";
import { createRuntimeHealthReports } from "./bootstrap/runtime-health-reports.js";
import { createWorkspaceCoordinationApi } from "./bootstrap/workspace-coordination-api.js";
import {
  loadAdminCapabilitiesModule,
  loadConfigRuntimesModule,
  loadConfigServerConfigModule,
  loadConfigWorkspaceModule,
  loadConfiguredSandboxHostModule,
  loadControlPlaneRuntimeModule,
  loadMetadataRetentionModule,
  loadModelMetadataDiscoveryModule,
  loadNativeBridgeModule,
  loadObjectStorageModule,
  loadPlatformAgentsModule,
  loadRedisStorageModule,
  loadSQLiteStorageModule,
  loadSandboxBackedWorkspaceInitializerModule,
  loadServiceRoutedPostgresModule,
  loadStorageAdminModule,
  loadWorkerRuntimeModule,
  loadWorkspaceDefinitionHelpersModule,
  loadWorkspaceMaterializationModule
} from "./bootstrap/module-loaders.js";
import {
  createPlacementAwareSessionRunQueue,
  selectPlacementPreferredWorkerId
} from "./bootstrap/placement-aware-session-run-queue.js";
import {
  resolveRuntimeSourceDirForBootstrap,
  resolveRuntimeUploadCacheDir
} from "./bootstrap/runtime-upload-cache.js";
import {
  resolveRuntimeAssemblyProfile,
  resolveWorkspaceModelMetadataDiscoveryMode,
  shouldManageWorkspaceRegistry
} from "./bootstrap/runtime-assembly-profile.js";
import { createRuntimeManagement } from "./bootstrap/runtime-management-service.js";
import { createPlatformAssetManagement } from "./bootstrap/platform-asset-management-service.js";
import { createWorkspacePrewarmer } from "./bootstrap/workspace-prewarmer.js";
import {
  createConfiguredWorkspaceInitializer,
  createConfiguredWorkspaceDeletionHandler,
  createConfiguredWorkspaceLifecycle,
  createSandboxHostMaintenance,
  createSandboxWorkspaceActivityTracker,
  resolveSandboxBootstrapPlan,
  resolveSandboxWorkspaceServicePlan
} from "./bootstrap/configured-sandbox-services.js";
import { createObjectStorageWorkspaceEntryLister } from "./object-storage-workspace-list.js";
import { shouldExposeLocalWorkspaceManagement } from "./sandbox-capabilities.js";
import type { BootstrappedRuntime, BootstrapOptions } from "./bootstrap/bootstrap-runtime-types.js";
import {
  fileExists,
  isTruthyEnvValue,
  listRepositoryWorkspaces,
  parseStaleRunRecoveryStrategyEnv,
  resolveInternalBaseUrl,
  resolvePostgresMetadataRetentionConfig,
  resolvePostgresPoolConfig,
  resolveRuntimeInstanceId,
  runtimeHasPersistedWorkspaceListing,
  runtimeHasWorkspaceSnapshotListing,
  summarizeDisabledWorkerRuntimeStatus,
  withManagedWorkspaceExternalRef
} from "./bootstrap/bootstrap-runtime-helpers.js";

export { cleanupWorkspaceLocalArtifacts } from "./bootstrap/engine-state-paths.js";
export type { WorkspaceLocalArtifactCleanupStatus } from "./bootstrap/engine-state-paths.js";
export type { BootstrappedRuntime, BootstrapOptions } from "./bootstrap/bootstrap-runtime-types.js";
export {
  resolveObjectStorageMirrorBlockingInit,
  resolveWorkspaceMaterializationConfig,
  resolveWorkspacePrewarmConfig
} from "./bootstrap/bootstrap-config.js";
export {
  resolveRuntimeAssemblyProfile,
  resolveWorkspaceModelMetadataDiscoveryMode,
  shouldManageWorkspaceRegistry
} from "./bootstrap/runtime-assembly-profile.js";
export { createWorkspacePrewarmer } from "./bootstrap/workspace-prewarmer.js";
export { installSignalHandlers } from "./bootstrap/signal-handlers.js";
export { createPlacementAwareSessionRunQueue } from "./bootstrap/placement-aware-session-run-queue.js";
export {
  buildSingleWorkspaceConfig,
  describeEngineProcess,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldStartEmbeddedWorker,
  shouldStartInlineWorker
} from "./bootstrap/engine-process.js";
export { resolveEmbeddedWorkerPoolConfig, resolveWorkerMode } from "./bootstrap/worker-host.js";
export { resolveRuntimeUploadCacheDir } from "./bootstrap/runtime-upload-cache.js";

async function runRuntimeCloseTasks(tasks: Array<{ label: string; run: () => Promise<unknown> | unknown }>): Promise<void> {
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      await task.run();
    })
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(`[oah-bootstrap] Failed to close ${tasks[index]!.label}.`, result.reason);
    }
  });
}

export async function bootstrapRuntime(options: BootstrapOptions = {}): Promise<BootstrappedRuntime> {
  const argv = options.argv ?? process.argv.slice(2);
  const startWorker = options.startWorker ?? false;
  const processKind = options.processKind ?? "api";
  const runtimeInstanceId = resolveRuntimeInstanceId(processKind);
  const currentWorkerId = runtimeInstanceId;
  const singleWorkspace = parseSingleWorkspaceOptions(argv);
  if (singleWorkspace !== undefined) {
    console.warn(formatSingleWorkspaceLegacyWarning(singleWorkspace));
  }
  const requestedConfig = parseConfigPath(argv);
  const { loadServerConfig } = await loadConfigServerConfigModule();
  const config =
    singleWorkspace !== undefined
      ? buildSingleWorkspaceConfig(
          (await fileExists(requestedConfig.path))
            ? await loadServerConfig(requestedConfig.path)
            : requestedConfig.explicit
              ? await loadServerConfig(requestedConfig.path)
              : undefined,
          singleWorkspace
        )
      : await loadServerConfig(
          (await fileExists(requestedConfig.path))
            ? requestedConfig.path
            : requestedConfig.explicit
              ? requestedConfig.path
              : path.resolve(process.cwd(), "server.example.yaml")
        );
  const sandboxBootstrapPlan = resolveSandboxBootstrapPlan({
    config,
    processKind,
    startWorker,
    hasSandboxHostFactory: Boolean(options.sandboxHostFactory)
  });
  const remoteSandboxProvider = sandboxBootstrapPlan.remoteSandboxProvider;
  const selfHostedWorkerProcess = sandboxBootstrapPlan.selfHostedWorkerProcess;
  const assemblyProfile = resolveRuntimeAssemblyProfile({
    processKind,
    startWorker,
    remoteSandboxProvider
  });
  const managesWorkspaceRegistry = shouldManageWorkspaceRegistry({
    processKind,
    hasSingleWorkspace: singleWorkspace !== undefined,
    remoteSandboxProvider
  });
  const workspaceModelMetadataDiscoveryMode = resolveWorkspaceModelMetadataDiscoveryMode({
    processKind,
    hasSingleWorkspace: singleWorkspace !== undefined,
    managesWorkspaceRegistry
  });
  const objectStorageMirrorConfig = config.object_storage
    ? resolveObjectStorageMirrorConfig(config.object_storage)
    : undefined;
  if (config.object_storage) {
    const policy = describeObjectStoragePolicy(config);
    console.info(
      `[oah-object-storage] mirrored paths: ${policy.mirroredPaths.length > 0 ? policy.mirroredPaths.join(", ") : "none"}; ` +
        `workspace backing store: ${policy.workspaceBackingStoreEnabled ? "enabled" : "disabled"}`
    );
    if (policy.workspaceBackingStoreEnabled && (objectStorageMirrorConfig?.sync_on_change ?? true)) {
      console.info(
        "[oah-object-storage] active workspace writes are not mirrored by sync_on_change; " +
          "workspace flush uses materialization idle/drain lifecycle."
      );
    }
  }
  const objectStorageModule =
    config.object_storage || objectStorageMirrorConfig ? await loadObjectStorageModule() : undefined;
  const objectStorageMirror = objectStorageMirrorConfig
    ? (objectStorageMirrorConfig.managed_paths?.length ?? 0) > 0
      ? new objectStorageModule!.ObjectStorageMirrorController(objectStorageMirrorConfig, config.paths, (message) => {
          console.info(`[oah-object-storage] ${message}`);
        })
      : undefined
    : undefined;
  const ownerBaseUrl = resolveInternalBaseUrl(config, { processKind });
  if (objectStorageMirror) {
    const blockingMirrorInit = resolveObjectStorageMirrorBlockingInit();
    await objectStorageMirror.initialize({
      awaitInitialSync: blockingMirrorInit
    });
    if (!blockingMirrorInit) {
      console.info("[oah-object-storage] mirror initialization continues in background after readiness");
    }
  }
  const nativeBridge = await loadNativeBridgeModule();
  if (nativeBridge.isNativeWorkspaceSyncEnabled()) {
    await nativeBridge.ensureNativeWorkspaceSyncWorkerPoolReady();
  }
  const useRuntimeObjectStorageManagement = config.object_storage !== undefined;
  let workspaceMaterializationManager: WorkspaceMaterializationManager | undefined;
  let sandboxHost: SandboxHost | undefined;
  const modelDir = config.paths.model_dir;
  const toolDir = config.paths.tool_dir;
  const logModelLoadError = (filePath: string, error: unknown): void => {
    console.error(`[oah-bootstrap] Failed to load model definition from ${filePath}; skipping entry.`, error);
  };
  const logWorkspaceDiscoveryError = (rootPath: string, kind: "project", error: unknown): void => {
    console.error(`[oah-bootstrap] Failed to discover ${kind} workspace at ${rootPath}; skipping workspace.`, error);
  };
  let modelGateway: (ModelGateway & { clearModelCache?: (modelNames?: string[]) => void }) | undefined;
  let refreshWorkspaceDefinitionsForPlatformModels = async (): Promise<void> => undefined;
  const platformModelService = await createPlatformModelCatalogService({
    modelDir,
    stateDir: path.join(resolveRuntimeStateDir(config.paths), "platform-models"),
    defaultModel: config.llm.default_model,
    // Prefer cached metadata on boot and let live discovery hydrate after readiness.
    metadataDiscovery: "background",
    onLoadError: ({ filePath, error }) => {
      logModelLoadError(filePath, error);
    },
    onModelsChanged: async () => {
      modelGateway?.clearModelCache?.();
      if (assemblyProfile.enableControlPlaneFacade) {
        await refreshWorkspaceDefinitionsForPlatformModels();
      }
    }
  });
  const models = platformModelService.definitions;
  let platformAgents: PlatformAgentRegistry | undefined;
  async function getPlatformAgents(): Promise<PlatformAgentRegistry> {
    platformAgents ??= {
      ...(await loadPlatformAgentsModule()).createBuiltInPlatformAgents(),
      ...(options.platformAgents ?? {})
    };
    return platformAgents;
  }
  async function discoverWorkspaceDefinition(
    rootPath: string,
    kind: "project",
    options?: { enrichModelMetadata?: boolean | undefined }
  ): Promise<WorkspaceRecord> {
    const { discoverWorkspace } = await loadConfigWorkspaceModule();
    const discovered = (await discoverWorkspace(rootPath, kind, {
      platformModels: models,
      platformAgents: await getPlatformAgents(),
      platformSkillDir: config.paths.skill_dir,
      platformToolDir: toolDir
    } as Parameters<typeof discoverWorkspace>[2])) as WorkspaceRecord;

    if (!options?.enrichModelMetadata) {
      return discovered;
    }

    return (await loadModelMetadataDiscoveryModule()).enrichWorkspaceModelsWithDiscoveredMetadata(discovered);
  }

  async function discoverWorkspaceWithEnrichedModels(rootPath: string, kind: "project") {
    return discoverWorkspaceDefinition(rootPath, kind, {
      enrichModelMetadata: true
    });
  }

  async function enrichBootWorkspaceModels(workspaces: WorkspaceRecord[]): Promise<WorkspaceRecord[]> {
    const { enrichWorkspaceModelsWithDiscoveredMetadata } = await loadModelMetadataDiscoveryModule();
    return Promise.all(workspaces.map((workspace) => enrichWorkspaceModelsWithDiscoveredMetadata(workspace)));
  }

  async function withWorkspaceDefinitionTimestamp(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    const { readLatestWorkspaceDefinitionMtimeMs } = await loadWorkspaceDefinitionHelpersModule();
    const latestDefinitionMtimeMs = await readLatestWorkspaceDefinitionMtimeMs(workspace.rootPath);
    if (latestDefinitionMtimeMs === undefined) {
      return workspace;
    }

    const currentUpdatedAtMs = Date.parse(workspace.updatedAt);
    if (Number.isFinite(currentUpdatedAtMs) && latestDefinitionMtimeMs <= currentUpdatedAtMs) {
      return workspace;
    }

    return {
      ...workspace,
      updatedAt: new Date(latestDefinitionMtimeMs).toISOString()
    };
  }

  const discoveredWorkspaces =
    singleWorkspace !== undefined
      ? [
          withManagedWorkspaceExternalRef(
            (await discoverWorkspaceWithEnrichedModels(singleWorkspace.rootPath, singleWorkspace.kind)) as WorkspaceRecord,
            config,
            objectStorageMirror
          )
        ]
      : !managesWorkspaceRegistry
        ? []
      : (
          await (async () => {
            const { discoverWorkspaces } = await loadConfigWorkspaceModule();
            return discoverWorkspaces({
              paths: config.paths,
              platformModels: models,
              platformAgents: await getPlatformAgents(),
              onError: ({ rootPath, kind, error }: { rootPath: string; kind: "project"; error: unknown }) => {
                logWorkspaceDiscoveryError(rootPath, kind, error);
              }
            } as Parameters<typeof discoverWorkspaces>[0]);
          })().then(async (workspaces) => {
            if (workspaceModelMetadataDiscoveryMode === "eager" || workspaces.length === 1) {
              return enrichBootWorkspaceModels(workspaces as WorkspaceRecord[]);
            }

            return workspaces as WorkspaceRecord[];
          })
        ).map((workspace) =>
          withManagedWorkspaceExternalRef(workspace as WorkspaceRecord, config, objectStorageMirror)
        );
  const postgresConfigured = Boolean(config.storage.postgres_url && config.storage.postgres_url.trim().length > 0);
  const redisConfigured = Boolean(config.storage.redis_url && config.storage.redis_url.trim().length > 0);
  const sqliteShadowRoot = resolveSqliteShadowRoot(config.paths);
  const sqliteStorageModule = postgresConfigured ? undefined : await loadSQLiteStorageModule();
  const redisStorageModule = redisConfigured ? await loadRedisStorageModule() : undefined;
  const persistence = postgresConfigured
    ? await (await loadServiceRoutedPostgresModule()).createServiceRoutedPostgresRuntimePersistence({
        connectionString: config.storage.postgres_url!,
        poolConfig: resolvePostgresPoolConfig({ processKind, startWorker }),
        archivePayloadRoot: resolvePostgresArchivePayloadRoot(config.paths)
      }).catch((error) => {
        throw new Error(
          `Configured PostgreSQL persistence is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
        );
      })
    : await sqliteStorageModule!.createSQLiteRuntimePersistence({
        shadowRoot: sqliteShadowRoot,
        projectDbLocation: config.storage.sqlite?.project_db_location
      });
  const primaryStorageMode = "driver" in persistence && persistence.driver === "sqlite" ? "sqlite" : "postgres";
  const postgresMetadataRetentionConfig = resolvePostgresMetadataRetentionConfig({
    processKind,
    startWorker
  });
  const redisBus =
    redisConfigured
      ? await redisStorageModule!.createRedisSessionEventBus({
          url: config.storage.redis_url!
        }).catch((error) => {
          console.warn(
            `Redis event bus unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without Redis fanout.`
          );
          return undefined;
        })
      : undefined;
  const redisRawRunQueue =
    redisConfigured
      ? await redisStorageModule!.createRedisSessionRunQueue({
          url: config.storage.redis_url!
        }).catch((error) => {
          console.warn(
            `Redis run queue unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing with in-process scheduling.`
          );
          return undefined;
        })
      : undefined;
  const redisWorkerRegistry =
    redisConfigured
      ? await redisStorageModule!.createRedisWorkerRegistry({
          url: config.storage.redis_url!
        }).catch((error) => {
          console.warn(
            `Redis worker registry unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without worker leases.`
          );
          return undefined;
        })
      : undefined;
  const redisWorkspaceLeaseRegistry =
    redisConfigured
      ? await redisStorageModule!.createRedisWorkspaceLeaseRegistry({
          url: config.storage.redis_url!
        }).catch((error: unknown) => {
          console.warn(
            `Redis workspace lease registry unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without workspace ownership leases.`
          );
          return undefined;
        })
      : undefined;
  const redisWorkspacePlacementRegistry =
    redisConfigured
      ? await redisStorageModule!.createRedisWorkspacePlacementRegistry({
          url: config.storage.redis_url!
        }).catch((error: unknown) => {
          console.warn(
            `Redis workspace placement registry unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without workspace placement state.`
          );
          return undefined;
        })
      : undefined;
  const redisRunQueue =
    redisRawRunQueue && redisWorkspacePlacementRegistry
      ? createPlacementAwareSessionRunQueue({
          queue: redisRawRunQueue,
          runRepository: persistence.runRepository,
          workspacePlacementRegistry: redisWorkspacePlacementRegistry
        })
      : redisRawRunQueue;
  workspaceMaterializationManager = sandboxBootstrapPlan.canDeferEmbeddedSandboxMaterialization
    ? undefined
    : sandboxBootstrapPlan.shouldUseWorkspaceMaterialization && config.object_storage
      ? new (await loadWorkspaceMaterializationModule()).WorkspaceMaterializationManager({
          cacheRoot: resolveWorkspaceMaterializationCacheRoot(config.paths),
          workspaceRoot: config.paths.workspace_dir,
          workerId: currentWorkerId,
          ...(ownerBaseUrl ? { ownerBaseUrl } : {}),
          store: objectStorageModule!.createDirectoryObjectStore(config.object_storage),
          leaseRegistry: redisWorkspaceLeaseRegistry,
          placementRegistry: redisWorkspacePlacementRegistry,
          logger: (message) => {
            console.info(message);
          }
        })
      : undefined;
  sandboxHost = options.sandboxHostFactory
    ? await options.sandboxHostFactory({
        config,
        processKind,
        workerId: currentWorkerId,
        ...(ownerBaseUrl ? { ownerBaseUrl } : {}),
        ...(workspaceMaterializationManager ? { workspaceMaterializationManager } : {})
      })
    : undefined;
  if (!sandboxHost) {
    const configuredSandboxHostModule = await loadConfiguredSandboxHostModule();
    const lazyWorkspaceMaterializationManagerClass = sandboxBootstrapPlan.canDeferEmbeddedSandboxMaterialization
      ? (await loadWorkspaceMaterializationModule()).WorkspaceMaterializationManager
      : undefined;
    sandboxHost = await configuredSandboxHostModule.createConfiguredSandboxHost({
      config,
      ...(workspaceMaterializationManager ? { workspaceMaterializationManager } : {}),
      ...(sandboxBootstrapPlan.canDeferEmbeddedSandboxMaterialization
        ? {
            createWorkspaceMaterializationManager: () => {
              workspaceMaterializationManager ??= new lazyWorkspaceMaterializationManagerClass!({
                cacheRoot: resolveWorkspaceMaterializationCacheRoot(config.paths),
                workspaceRoot: config.paths.workspace_dir,
                workerId: currentWorkerId,
                ...(ownerBaseUrl ? { ownerBaseUrl } : {}),
                store: objectStorageModule!.createDirectoryObjectStore(config.object_storage!),
                leaseRegistry: redisWorkspaceLeaseRegistry,
                placementRegistry: redisWorkspacePlacementRegistry,
                logger: (message) => {
                  console.info(message);
                }
              });
              return workspaceMaterializationManager;
            }
          }
        : {}),
      selfHostedWorkerProcess,
      ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
      ...(redisWorkerRegistry ? { workerRegistry: redisWorkerRegistry } : {})
    });
  }
  const sandboxWorkspaceServicePlan = resolveSandboxWorkspaceServicePlan({
    config,
    remoteSandboxProvider,
    sandboxHost,
    processKind,
    startWorker,
    ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
    ...(redisWorkerRegistry ? { workerRegistry: redisWorkerRegistry } : {})
  });
  const adminCapabilities = assemblyProfile.enableAdminCapabilities
    ? (await loadAdminCapabilitiesModule()).createEngineAdminCapabilities({
        storageAdmin: createLazyStorageAdmin(async () => {
          return (await loadStorageAdminModule()).createStorageAdmin({
            ...("pool" in persistence ? { postgresPool: persistence.pool } : {}),
            ...(config.storage.postgres_url ? { postgresConnectionString: config.storage.postgres_url } : {}),
            redisUrl: config.storage.redis_url,
            redisAvailable: redisConfigured,
            redisEventBusEnabled: Boolean(redisBus),
            redisRunQueueEnabled: Boolean(redisRunQueue),
            ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
            historyEventCleanupEnabled:
              postgresMetadataRetentionConfig.enabled && postgresMetadataRetentionConfig.historyEventRetentionDays > 0,
            historyEventRetentionDays: Math.max(1, postgresMetadataRetentionConfig.historyEventRetentionDays || 7),
            archiveExportEnabled: false,
            archiveExportRoot: resolveArchiveExportRoot(config.paths)
          });
        })
      })
    : undefined;
  const runtimeProcess = describeEngineProcess({
    processKind,
    startWorker,
    hasRedisRunQueue: Boolean(redisRunQueue)
  });
  const workspaceRegistryPolling = resolveWorkspaceRegistryPollingConfig();
  const controlPlaneRuntime =
    assemblyProfile.enableControlPlaneFacade || managesWorkspaceRegistry
      ? await (await loadControlPlaneRuntimeModule()).prepareControlPlaneRuntime({
          config,
          persistence: {
            ...persistence,
            ...(runtimeHasPersistedWorkspaceListing(persistence)
              ? { listPersistedWorkspaces: () => persistence.listPersistedWorkspaces() }
              : {}),
            ...(runtimeHasWorkspaceSnapshotListing(persistence)
              ? { listWorkspaceSnapshots: (candidates: WorkspaceRecord[]) => persistence.listWorkspaceSnapshots(candidates) }
              : {})
          },
          discoveredWorkspaces: discoveredWorkspaces as WorkspaceRecord[],
          managesWorkspaceRegistry,
          enableControlPlaneFacade: assemblyProfile.enableControlPlaneFacade,
          remoteSandboxProvider,
          singleWorkspaceDefined: singleWorkspace !== undefined,
          models,
          toolDir,
          sqliteShadowRoot,
          ...(sandboxHost ? { sandboxHost } : {}),
          ...(redisWorkspaceLeaseRegistry ? { redisWorkspaceLeaseRegistry } : {}),
          ...(redisWorkspacePlacementRegistry ? { redisWorkspacePlacementRegistry } : {}),
          pollingConfig: workspaceRegistryPolling,
          workspaceModelMetadataDiscovery: workspaceModelMetadataDiscoveryMode,
          getPlatformAgents,
          logWorkspaceDiscoveryError,
          discoverWorkspaceWithEnrichedModels: (rootPath: string, kind: "project") =>
            discoverWorkspaceWithEnrichedModels(rootPath, kind) as Promise<WorkspaceRecord>,
          applyManagedWorkspaceExternalRef: (workspace: WorkspaceRecord) =>
            withManagedWorkspaceExternalRef(workspace, config, objectStorageMirror),
          withWorkspaceDefinitionTimestamp,
          listRepositoryWorkspaces
        })
      : undefined;
  const reconciledWorkspaces = controlPlaneRuntime?.reconciledWorkspaces ?? (discoveredWorkspaces as WorkspaceRecord[]);
  const visibleWorkspaceIds = controlPlaneRuntime?.visibleWorkspaceIds ?? new Set<string>();
  const workspaceRepository = controlPlaneRuntime?.workspaceRepository ?? persistence.workspaceRepository;
  const sessionRepository = controlPlaneRuntime?.sessionRepository ?? persistence.sessionRepository;
  const runRepository = controlPlaneRuntime?.runRepository ?? persistence.runRepository;
  const primarySessionEventStore = persistence.sessionEventStore;
  const sessionEventStore = redisBus
    ? new redisStorageModule!.FanoutSessionEventStore(primarySessionEventStore, redisBus)
    : primarySessionEventStore;
  const runtimeDebugLogger = buildRuntimeConsoleLogger({
    enabled: true,
    echoToStdout: isTruthyEnvValue(process.env.OAH_RUNTIME_DEBUG),
    sessionEventStore: primarySessionEventStore,
    now: () => new Date().toISOString()
  });
  const resolvedModelGateway = new LazyModelRuntime({
    defaultModelName: config.llm.default_model,
    models,
    logger: runtimeDebugLogger
  });
  modelGateway = resolvedModelGateway;
  let workspaceMaterializationMaintenanceTimer: NodeJS.Timeout | undefined;
  refreshWorkspaceDefinitionsForPlatformModels =
    controlPlaneRuntime?.refreshWorkspaceDefinitionsForPlatformModels ?? (async (): Promise<void> => undefined);

  async function clearWorkspaceCoordination(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (normalizedWorkspaceId.length === 0) {
      return;
    }

    const results = await Promise.allSettled([
      redisWorkspaceLeaseRegistry?.removeWorkspace(normalizedWorkspaceId) ?? Promise.resolve(),
      redisWorkspacePlacementRegistry?.removeWorkspace(normalizedWorkspaceId) ?? Promise.resolve()
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      console.warn(
        `[oah-bootstrap] Failed to clear coordination state for workspace ${normalizedWorkspaceId}.`,
        failures.map((failure) => failure.reason)
      );
    }
  }
  await controlPlaneRuntime?.initialize();
  const workspaceMode =
    singleWorkspace !== undefined
      ? {
          kind: "single" as const,
          workspaceId: reconciledWorkspaces[0]!.id,
          workspaceKind: reconciledWorkspaces[0]!.kind,
          rootPath: reconciledWorkspaces[0]!.rootPath
        }
      : {
          kind: "multi" as const
        };
  const sandboxWorkspaceActivityTracker = createSandboxWorkspaceActivityTracker({
    workspaceMaterializationManager,
    canDeferEmbeddedSandboxMaterialization: sandboxBootstrapPlan.canDeferEmbeddedSandboxMaterialization
  });
  workspaceMaterializationMaintenanceTimer = createSandboxHostMaintenance({
    sandboxHost,
    ...resolveWorkspaceMaterializationConfig(config)
  }).start();
  const workspaceInitializer =
    singleWorkspace === undefined
      ? await createConfiguredWorkspaceInitializer({
          plan: sandboxWorkspaceServicePlan,
          config,
          toolDir,
          useRuntimeObjectStorageManagement,
          objectStorageModule,
          loadConfigWorkspaceModule,
          loadConfigRuntimesModule,
          loadSandboxBackedWorkspaceInitializerModule,
          discoverWorkspaceWithEnrichedModels: (rootPath: string, kind: "project") =>
            discoverWorkspaceWithEnrichedModels(rootPath, kind) as Promise<WorkspaceRecord>,
          getWorkspaceRecord: async (workspaceId: string) => (await workspaceRepository.getById(workspaceId)) ?? undefined,
          getPlatformAgents,
          platformModels: models,
          ...(sandboxHost ? { sandboxHost } : {})
        })
      : undefined;
  const workspaceDeletionHandler =
    singleWorkspace === undefined
      ? createConfiguredWorkspaceDeletionHandler({
          plan: sandboxWorkspaceServicePlan,
          config,
          remoteSandboxProvider,
          sandboxHost,
          workspaceMaterializationManager,
          objectStorageModule,
          objectStorageMirror,
          sqliteShadowRoot,
          clearWorkspaceCoordination,
          ...(controlPlaneRuntime ? { closeWorkspaceWatcher: controlPlaneRuntime.closeWorkspaceWatcher } : {})
        })
      : undefined;
  const runtimeService = new EngineService({
    defaultModel: config.llm.default_model,
    modelGateway: resolvedModelGateway,
    logger: runtimeDebugLogger,
    ...(sandboxWorkspaceActivityTracker ? { workspaceActivityTracker: sandboxWorkspaceActivityTracker } : {}),
    executionServicesMode: assemblyProfile.executionServicesMode,
    runHeartbeatIntervalMs: parsePositiveIntEnvWithMin("OAH_RUN_HEARTBEAT_INTERVAL_MS", 5_000, 50),
    staleRunTimeoutMs: parsePositiveIntEnvWithMin("OAH_STALE_RUN_TIMEOUT_MS", 120_000, 50),
    staleRunRecovery: {
      strategy: parseStaleRunRecoveryStrategyEnv(
        "OAH_STALE_RUN_RECOVERY_STRATEGY",
        config.storage.redis_url ? "requeue_running" : "fail"
      ),
      maxAttempts: parsePositiveIntEnv("OAH_STALE_RUN_RECOVERY_MAX_ATTEMPTS", 1)
    },
    platformModels: models,
    ...persistence,
    workspaceRepository,
    sessionRepository,
    runRepository,
    sessionEventStore,
    runQueue: redisRunQueue,
    ...(sandboxHost
      ? {
          workspaceCommandExecutor: sandboxHost.workspaceCommandExecutor,
          workspaceFileSystem: sandboxHost.workspaceFileSystem,
          workspaceExecutionProvider: sandboxHost.workspaceExecutionProvider,
          workspaceFileAccessProvider: sandboxHost.workspaceFileAccessProvider
        }
      : {}),
    ...(workspaceDeletionHandler ? { workspaceDeletionHandler } : {}),
    ...(singleWorkspace === undefined && workspaceInitializer
      ? {
          workspaceInitializer
        }
      : {})
  });
  const workspacePrewarmConfig = resolveWorkspacePrewarmConfig();
  const touchWorkspaceActivity = sandboxWorkspaceActivityTracker
    ? async (workspaceId: string) => {
        await sandboxWorkspaceActivityTracker.touchWorkspace(workspaceId);
      }
    : undefined;
  const workspacePrewarmer = assemblyProfile.enableControlPlaneFacade && sandboxHost
    ? workspacePrewarmConfig.enabled
      ? createWorkspacePrewarmer({
          sandboxHost,
          getWorkspaceRecord: (workspaceId: string) => runtimeService.getWorkspaceRecord(workspaceId),
          delayMs: workspacePrewarmConfig.delayMs,
          coalesceWindowMs: workspacePrewarmConfig.coalesceWindowMs
        })
      : undefined
    : undefined;
  const objectStoreWorkspaceListStore =
    config.object_storage && objectStorageModule ? objectStorageModule.createDirectoryObjectStore(config.object_storage) : undefined;
  const listWorkspaceEntriesFast = objectStoreWorkspaceListStore
    ? createObjectStorageWorkspaceEntryLister({
        store: objectStoreWorkspaceListStore,
        getWorkspaceRecord: async (workspaceId: string) => (await workspaceRepository.getById(workspaceId)) ?? undefined,
        shouldUseObjectStoreList: (workspaceId: string) =>
          !workspaceMaterializationManager
            ?.snapshot()
            .some((entry) => entry.workspaceId === workspaceId && entry.sourceKind === "object_store" && entry.materializedAt),
        prewarmWorkspace: workspacePrewarmer
          ? (workspaceId: string) => {
              void workspacePrewarmer.prewarmWorkspace(workspaceId);
            }
          : undefined,
        logger: (message: string) => {
          console.info(message);
        }
      })
    : undefined;
  const controlPlaneEngineService: ControlPlaneRuntimeOperations = controlPlaneRuntime
    ? controlPlaneRuntime.createControlPlaneEngineService({
        runtimeService,
        ...(touchWorkspaceActivity ? { touchWorkspaceActivity } : {}),
        ...(workspacePrewarmer ? { workspacePrewarmer } : {}),
        ...(runtimeDebugLogger ? { logger: runtimeDebugLogger } : {})
      })
    : runtimeService;
  const executionEngineService = new ExecutionEngineService(runtimeService);
  const workspaceLifecycle = createConfiguredWorkspaceLifecycle({
    sandboxHost,
    runtimeService,
    workspaceMaterializationManager,
    ...(touchWorkspaceActivity ? { touchWorkspaceActivity } : {}),
    clearWorkspaceCoordination
  });
  const describeQueuedRun = controlPlaneRuntime
    ? (runId: string) =>
        import("./bootstrap/scoped-repositories.js").then(({ describeQueuedRunWithScopedVisibility }) =>
          describeQueuedRunWithScopedVisibility(
            persistence.runRepository,
            visibleWorkspaceIds,
            runId,
            redisWorkspacePlacementRegistry
          )
        )
    : async (runId: string) => {
        const run = await persistence.runRepository.getById(runId);
        if (!run) {
          return undefined;
        }

        const placement = await redisWorkspacePlacementRegistry?.getByWorkspaceId(run.workspaceId);
        const preferredWorkerId = selectPlacementPreferredWorkerId(placement);
        return {
          workspaceId: run.workspaceId,
          ...(preferredWorkerId ? { preferredWorkerId } : {})
        };
      };
  const workerRuntime = await createWorkerRuntimeService({
    enabled: assemblyProfile.enableWorkerRuntime,
    loadWorkerRuntimeModule,
    startWorker,
    processKind,
    runtimeInstanceId,
    ownerBaseUrl,
    config,
    redisRunQueue,
    redisWorkerRegistry,
    runtimeService: executionEngineService,
    describeQueuedRun
  });
  workerRuntime?.start();
  const postgresMetadataRetentionService = await createPostgresMetadataRetentionService({
    enabled: postgresMetadataRetentionConfig.enabled,
    persistence,
    config: postgresMetadataRetentionConfig,
    loadMetadataRetentionModule
  });
  postgresMetadataRetentionService?.start();
  const closePersistence =
    "close" in persistence && typeof persistence.close === "function" ? () => persistence.close() : async () => undefined;

  async function getWorkerStatus(): Promise<WorkerRuntimeStatus> {
    if (workerRuntime) {
      return workerRuntime.getStatus();
    }

    return summarizeDisabledWorkerRuntimeStatus();
  }
  const runtimeHealthReports = createRuntimeHealthReports({
    config,
    runtimeProcess,
    primaryStorageMode,
    postgresConfigured,
    redisConfigured,
    persistence,
    redisBus,
    redisRunQueue,
    sandboxHost,
    getWorkerStatus
  });

  return {
    config,
    controlPlaneEngineService,
    executionEngineService,
    runtimeService,
    modelGateway: resolvedModelGateway,
    process: runtimeProcess,
    workspaceMode,
    refreshPlatformModels: () => platformModelService.refresh(),
    ...(assemblyProfile.enableControlPlaneFacade
      ? {
          listPlatformModels: () => platformModelService.listModels(),
          getPlatformModelSnapshot: () => platformModelService.getSnapshot(),
          refreshDistributedPlatformModels: () => refreshDistributedPlatformModels({
            refreshLocalSnapshot: () => platformModelService.refresh(),
            redisWorkerRegistry,
            runtimeInstanceId,
            ownerBaseUrl
          }),
          subscribePlatformModelSnapshot: (listener: (snapshot: PlatformModelSnapshot) => void) =>
            platformModelService.subscribe(listener)
        }
      : {}),
    ...(singleWorkspace === undefined
      ? {
          ...createRuntimeManagement({
            config,
            useRuntimeObjectStorageManagement,
            objectStorageModule,
            loadConfigRuntimesModule
          }),
          ...createPlatformAssetManagement({
            config,
            loadConfigWorkspaceModule,
            onPlatformModelsChanged: () => platformModelService.refresh()
          }),
          ...(shouldExposeLocalWorkspaceManagement({ remoteSandboxProvider })
            ? createLocalWorkspaceManagement({
                config,
                workspaceRepository,
                runtimeService,
                objectStorageModule,
                objectStorageMirror,
                useRuntimeObjectStorageManagement,
                discoverWorkspaceWithEnrichedModels: (rootPath: string, kind: "project") =>
                  discoverWorkspaceWithEnrichedModels(rootPath, kind) as Promise<WorkspaceRecord>,
                loadConfigRuntimesModule
              })
            : {})
        }
      : {}),
    ...createWorkspaceCoordinationApi({
      redisWorkspaceLeaseRegistry,
      redisWorkspacePlacementRegistry,
      redisWorkerRegistry,
      currentWorkerId,
      ownerBaseUrl
    }),
    ...((redisWorkspaceLeaseRegistry || redisWorkspacePlacementRegistry)
      ? {
          clearWorkspaceCoordination
        }
      : {}),
    ...(adminCapabilities ? { adminCapabilities } : {}),
    ...(sandboxHost ? { sandboxHostProviderKind: sandboxHost.providerKind } : {}),
    ...(ownerBaseUrl ? { localOwnerBaseUrl: ownerBaseUrl } : {}),
    ...(touchWorkspaceActivity ? { touchWorkspaceActivity } : {}),
    ...(listWorkspaceEntriesFast ? { listWorkspaceEntriesFast } : {}),
    ...(workspaceLifecycle ? { workspaceLifecycle } : {}),
    appendEngineLog(input) {
      return appendEngineLogEvent(primarySessionEventStore, {
        ...input,
        timestamp: new Date().toISOString()
      });
    },
    healthReport: runtimeHealthReports.healthReport,
    readinessReport: runtimeHealthReports.readinessReport,
    async beginDrain() {
      if (workspaceMaterializationMaintenanceTimer) {
        clearInterval(workspaceMaterializationMaintenanceTimer);
        workspaceMaterializationMaintenanceTimer = undefined;
      }
      await sandboxHost?.beginDrain();
      await workerRuntime?.beginDrain();
      await postgresMetadataRetentionService?.close();
    },
    async close() {
      const closeObjectStoreWorkspaceListStore = async () => {
        if (
          objectStoreWorkspaceListStore &&
          "close" in objectStoreWorkspaceListStore &&
          typeof objectStoreWorkspaceListStore.close === "function"
        ) {
          await objectStoreWorkspaceListStore.close();
        }
      };

      await runRuntimeCloseTasks([
        { label: "worker runtime", run: () => workerRuntime?.close() },
        { label: "metadata retention service", run: () => postgresMetadataRetentionService?.close() },
        { label: "admin capabilities", run: () => adminCapabilities?.close() },
        { label: "redis event bus", run: () => redisBus?.close() },
        { label: "redis worker registry", run: () => redisWorkerRegistry?.close() },
        { label: "redis workspace lease registry", run: () => redisWorkspaceLeaseRegistry?.close() },
        { label: "redis workspace placement registry", run: () => redisWorkspacePlacementRegistry?.close() },
        { label: "redis run queue", run: () => redisRunQueue?.close() },
        { label: "sandbox host", run: () => sandboxHost?.close() },
        { label: "persistence", run: () => closePersistence() },
        { label: "object-store workspace list store", run: closeObjectStoreWorkspaceListStore },
        { label: "object storage mirror", run: () => objectStorageMirror?.close() },
        { label: "platform model service", run: () => platformModelService.close() },
        { label: "native workspace sync worker pool", run: () => nativeBridge.shutdownNativeWorkspaceSyncWorkerPool() },
        { label: "control plane runtime", run: () => controlPlaneRuntime?.close() }
      ]);
      if (workspaceMaterializationMaintenanceTimer) {
        clearInterval(workspaceMaterializationMaintenanceTimer);
        workspaceMaterializationMaintenanceTimer = undefined;
      }
    }
  };
}
