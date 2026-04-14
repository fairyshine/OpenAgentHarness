import path from "node:path";
import type { FSWatcher } from "node:fs";
import { access, rm } from "node:fs/promises";

import {
  deleteWorkspaceTemplate,
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromTemplate,
  listWorkspaceTemplates,
  loadPlatformModels,
  loadServerConfig,
  resolveWorkspaceCreationRoot,
  uploadWorkspaceTemplate
} from "@oah/config";
import type { ServerConfig } from "@oah/config";
import { AppError, RuntimeService, createId, parseCursor } from "@oah/runtime-core";
import type { RuntimeLogger, WorkspaceRecord } from "@oah/runtime-core";
import { AiSdkModelGateway } from "@oah/model-gateway";
import { createPostgresRuntimePersistence } from "@oah/storage-postgres";
import { createSQLiteRuntimePersistence, sqliteWorkspaceHistoryDbPath } from "@oah/storage-sqlite";
import {
  FanoutSessionEventStore,
  RedisRunWorkerPool,
  createRedisWorkerRegistry,
  createRedisSessionEventBus,
  createRedisSessionRunQueue
} from "@oah/storage-redis";
import { ObjectStorageMirrorController } from "./object-storage.js";
import { DualWriteSessionEventStore, appendRuntimeLogEvent, buildRuntimeConsoleLogger } from "./runtime-console.js";
import {
  buildSingleWorkspaceConfig,
  describeRuntimeProcess,
  type RuntimeProcessDescriptor,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldRunHistoryMirrorSync,
  shouldStartEmbeddedWorker
} from "./bootstrap/runtime-process.js";
import {
  ScopedRunRepository,
  ScopedSessionRepository,
  ScopedWorkspaceRepository
} from "./bootstrap/scoped-repositories.js";
import {
  discoverProjectWorkspaces,
  findManagedWorkspaceIdsToDelete,
  hasPersistedWorkspaceListing,
  hasWorkspaceSnapshotListing,
  isManagedWorkspace,
  isManagedWorkspaceRoot,
  listAllWorkspaces,
  openFsWatcher,
  reconcileDiscoveredWorkspaces,
  type PlatformAgentRegistry
} from "./bootstrap/workspace-registry.js";
import { HistoryEventCleaner, HistoryMirrorSyncer, inspectHistoryMirrorStatus } from "./history-mirror.js";
import { createBuiltInPlatformAgents } from "./platform-agents.js";
import { createStorageAdmin, type StorageAdmin } from "./storage-admin.js";

export {
  buildSingleWorkspaceConfig,
  describeRuntimeProcess,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldRunHistoryMirrorSync,
  shouldStartEmbeddedWorker,
  shouldStartInlineWorker
} from "./bootstrap/runtime-process.js";
export { findManagedWorkspaceIdsToDelete, reconcileDiscoveredWorkspaces } from "./bootstrap/workspace-registry.js";

export interface BootstrapOptions {
  argv?: string[] | undefined;
  startWorker?: boolean | undefined;
  processKind?: "api" | "worker" | undefined;
  platformAgents?: PlatformAgentRegistry | undefined;
}

function summarizeActiveWorkers(activeWorkers: Array<import("@oah/storage-redis").RedisWorkerRegistryEntry>) {
  return {
    active: activeWorkers.length,
    healthy: activeWorkers.filter((worker) => worker.health === "healthy").length,
    late: activeWorkers.filter((worker) => worker.health === "late").length,
    busy: activeWorkers.filter((worker) => worker.state === "busy").length,
    embedded: activeWorkers.filter((worker) => worker.processKind === "embedded").length,
    standalone: activeWorkers.filter((worker) => worker.processKind === "standalone").length
  };
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStaleRunRecoveryStrategyEnv(
  name: string,
  fallback: "fail" | "requeue_running" | "requeue_all"
): "fail" | "requeue_running" | "requeue_all" {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  return raw === "fail" || raw === "requeue_running" || raw === "requeue_all" ? raw : fallback;
}

function withManagedWorkspaceExternalRef(
  workspace: WorkspaceRecord,
  config: Awaited<ReturnType<typeof loadServerConfig>>,
  objectStorageMirror: ObjectStorageMirrorController | undefined
): WorkspaceRecord {
  if (!objectStorageMirror || workspace.externalRef) {
    return workspace;
  }

  const externalRef = objectStorageMirror.managedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config.paths);
  return externalRef ? { ...workspace, externalRef } : workspace;
}

export interface BootstrappedRuntime {
  config: Awaited<ReturnType<typeof loadServerConfig>>;
  runtimeService: RuntimeService;
  modelGateway: AiSdkModelGateway;
  process: RuntimeProcessDescriptor;
  workspaceMode:
    | {
        kind: "multi";
      }
    | {
        kind: "single";
        workspaceId: string;
        workspaceKind: "project" | "chat";
        rootPath: string;
      };
  listWorkspaceTemplates?: () => Promise<Array<{ name: string }>>;
  listPlatformModels?: () => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
      metadata?: Record<string, unknown>;
      isDefault: boolean;
    }>
  >;
  getPlatformModelSnapshot?: () => Promise<PlatformModelSnapshot>;
  subscribePlatformModelSnapshot?: (
    listener: (snapshot: PlatformModelSnapshot) => void
  ) => (() => void);
  importWorkspace?: (input: {
    rootPath: string;
    kind?: "project" | "chat";
    name?: string;
    externalRef?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  getWorkspaceHistoryMirrorStatus(workspace: import("@oah/runtime-core").WorkspaceRecord): Promise<
    import("./history-mirror.js").HistoryMirrorStatus
  >;
  rebuildWorkspaceHistoryMirror(workspace: import("@oah/runtime-core").WorkspaceRecord): Promise<
    import("./history-mirror.js").HistoryMirrorStatus
  >;
  storageAdmin: StorageAdmin;
  appendRuntimeLog(input: {
    sessionId: string;
    runId?: string | undefined;
    level: "debug" | "info" | "warn" | "error";
    category: "run" | "model" | "tool" | "hook" | "agent" | "http" | "system";
    message: string;
    details?: unknown;
    context?: import("@oah/api-contracts").RuntimeLogEventContext | undefined;
  }): Promise<void>;
  healthReport(): Promise<{
    status: "ok" | "degraded";
    storage: {
      primary: "postgres" | "sqlite";
      events: "redis" | "memory";
      runQueue: "redis" | "in_process";
    };
    process: RuntimeProcessDescriptor;
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
      historyMirror: "up" | "degraded" | "not_configured";
    };
    worker: {
      mode: "embedded" | "external" | "disabled";
      activeWorkers: Array<import("@oah/storage-redis").RedisWorkerRegistryEntry>;
      summary: {
        active: number;
        healthy: number;
        late: number;
        busy: number;
        embedded: number;
        standalone: number;
      };
      pool: import("@oah/storage-redis").RedisRunWorkerPoolSnapshot | null;
    };
    mirror: {
      worker: "running" | "disabled";
      enabledWorkspaces: number;
      idleWorkspaces: number;
      missingWorkspaces: number;
      errorWorkspaces: number;
    };
  }>;
  readinessReport(): Promise<{
    status: "ready" | "not_ready";
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
    };
  }>;
  close(): Promise<void>;
}

export interface WorkspaceLocalArtifactCleanupStatus {
  workspaceId: string;
  rootPath: string;
  mode: "workspace_root" | "history_db" | "shadow_history_db" | "none";
  removedPaths: string[];
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/iu.test(value.trim());
}

type PlatformModelRegistry = Awaited<ReturnType<typeof loadPlatformModels>>;
interface PlatformModelSnapshot {
  revision: number;
  items: ReturnType<typeof toPlatformModelItems>;
}

function toPlatformModelItems(models: PlatformModelRegistry, defaultModel: string) {
  return Object.entries(models).map(([id, definition]) => ({
    id,
    provider: definition.provider,
    modelName: definition.name,
    ...(definition.url ? { url: definition.url } : {}),
    hasKey: Boolean(definition.key),
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
    isDefault: defaultModel === id
  }));
}

function replacePlatformModels(target: PlatformModelRegistry, next: PlatformModelRegistry): void {
  for (const modelName of Object.keys(target)) {
    if (!(modelName in next)) {
      delete target[modelName];
    }
  }

  for (const [modelName, definition] of Object.entries(next)) {
    target[modelName] = definition;
  }
}

function serializePlatformModels(models: PlatformModelRegistry): string {
  return JSON.stringify(
    Object.entries(models)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => [name, definition])
  );
}

export async function cleanupWorkspaceLocalArtifacts(input: {
  workspace: WorkspaceRecord;
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "chat_dir">;
  sqliteShadowRoot: string;
}): Promise<WorkspaceLocalArtifactCleanupStatus> {
  const managedRootDir = input.workspace.kind === "chat" ? input.paths.chat_dir : input.paths.workspace_dir;
  if (isManagedWorkspaceRoot(input.workspace.rootPath, managedRootDir)) {
    await rm(input.workspace.rootPath, {
      recursive: true,
      force: true
    });
    return {
      workspaceId: input.workspace.id,
      rootPath: input.workspace.rootPath,
      mode: "workspace_root",
      removedPaths: [input.workspace.rootPath]
    };
  }

  const dbPath = sqliteWorkspaceHistoryDbPath(input.workspace, {
    shadowRoot: input.sqliteShadowRoot
  });
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(`${dbPath}-wal`, { force: true })
  ]);

  if (dbPath.startsWith(`${input.sqliteShadowRoot}${path.sep}`) || dbPath === input.sqliteShadowRoot) {
    await rm(path.dirname(dbPath), {
      recursive: true,
      force: true
    });
  }

  return {
    workspaceId: input.workspace.id,
    rootPath: input.workspace.rootPath,
    mode:
      dbPath.startsWith(`${input.sqliteShadowRoot}${path.sep}`) || dbPath === input.sqliteShadowRoot
        ? "shadow_history_db"
        : "history_db",
    removedPaths: [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]
  };
}

export async function bootstrapRuntime(options: BootstrapOptions = {}): Promise<BootstrappedRuntime> {
  const argv = options.argv ?? process.argv.slice(2);
  const startWorker = options.startWorker ?? false;
  const processKind = options.processKind ?? "api";
  const singleWorkspace = parseSingleWorkspaceOptions(argv);
  const requestedConfig = parseConfigPath(argv);
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
  const objectStorageMirror = config.object_storage
    ? new ObjectStorageMirrorController(config.object_storage, config.paths, (message) => {
        console.info(`[oah-object-storage] ${message}`);
      })
    : undefined;
  if (objectStorageMirror) {
    await objectStorageMirror.initialize();
  }
  const modelDir = config.paths.model_dir;
  const toolDir = config.paths.tool_dir;
  const logModelLoadError = (filePath: string, error: unknown): void => {
    console.error(`[oah-bootstrap] Failed to load model definition from ${filePath}; skipping entry.`, error);
  };
  const logWorkspaceDiscoveryError = (rootPath: string, kind: "project" | "chat", error: unknown): void => {
    console.error(`[oah-bootstrap] Failed to discover ${kind} workspace at ${rootPath}; skipping workspace.`, error);
  };
  const models = await loadPlatformModels(modelDir, {
    onError: ({ filePath, error }: { filePath: string; error: unknown }) => {
      logModelLoadError(filePath, error);
    }
  });
  const platformAgents: PlatformAgentRegistry = {
    ...createBuiltInPlatformAgents(),
    ...(options.platformAgents ?? {})
  };
  const discoveredWorkspaces =
    singleWorkspace !== undefined
      ? [
          withManagedWorkspaceExternalRef(
            await discoverWorkspace(singleWorkspace.rootPath, singleWorkspace.kind, {
              platformModels: models,
              platformAgents,
              platformSkillDir: config.paths.skill_dir,
              platformToolDir: toolDir
            } as Parameters<typeof discoverWorkspace>[2]) as WorkspaceRecord,
            config,
            objectStorageMirror
          )
        ]
      : (
          await discoverWorkspaces({
            paths: config.paths,
            platformModels: models,
            platformAgents,
            onError: ({ rootPath, kind, error }: { rootPath: string; kind: "project" | "chat"; error: unknown }) => {
              logWorkspaceDiscoveryError(rootPath, kind, error);
            }
          } as Parameters<typeof discoverWorkspaces>[0])
        ).map((workspace) =>
          withManagedWorkspaceExternalRef(workspace as WorkspaceRecord, config, objectStorageMirror)
        );
  const postgresConfigured = Boolean(config.storage.postgres_url && config.storage.postgres_url.trim().length > 0);
  const sqliteShadowRoot = path.join(config.paths.workspace_dir, ".openharness", "data", "workspace-state");
  const persistence = postgresConfigured
    ? await createPostgresRuntimePersistence({
        connectionString: config.storage.postgres_url
      }).catch((error) => {
        throw new Error(
          `Configured PostgreSQL persistence is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
        );
      })
    : await createSQLiteRuntimePersistence({
        shadowRoot: sqliteShadowRoot
      });
  const primaryStorageMode = "driver" in persistence && persistence.driver === "sqlite" ? "sqlite" : "postgres";
  const redisBus =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisSessionEventBus({
          url: config.storage.redis_url
        }).catch((error) => {
          console.warn(
            `Redis event bus unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without Redis fanout.`
          );
          return undefined;
        })
      : undefined;
  const redisRunQueue =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisSessionRunQueue({
          url: config.storage.redis_url
        }).catch((error) => {
          console.warn(
            `Redis run queue unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing with in-process scheduling.`
          );
          return undefined;
        })
      : undefined;
  const redisWorkerRegistry =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisWorkerRegistry({
          url: config.storage.redis_url
        }).catch((error) => {
          console.warn(
            `Redis worker registry unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without worker leases.`
          );
          return undefined;
        })
      : undefined;
  const redisConfigured = Boolean(config.storage.redis_url && config.storage.redis_url.trim().length > 0);
  const storageAdmin = createStorageAdmin({
    ...("pool" in persistence ? { postgresPool: persistence.pool } : {}),
    redisUrl: config.storage.redis_url,
    redisAvailable: redisConfigured,
    redisEventBusEnabled: Boolean(redisBus),
    redisRunQueueEnabled: Boolean(redisRunQueue),
    historyEventCleanupEnabled:
      primaryStorageMode === "postgres" &&
      shouldRunHistoryMirrorSync({
        processKind,
        startWorker,
        hasRedisRunQueue: Boolean(redisRunQueue)
      }) &&
      "historyEventRepository" in persistence &&
      persistence.historyEventRepository &&
      "pruneByWorkspace" in persistence.historyEventRepository &&
      typeof persistence.historyEventRepository.pruneByWorkspace === "function",
    historyEventRetentionDays: (() => {
      const retentionDays = Number.parseInt(process.env.OAH_HISTORY_EVENT_RETENTION_DAYS ?? "7", 10);
      return Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 7;
    })(),
    archiveExportEnabled: false,
    archiveExportRoot: config.paths.archive_dir
  });
  const runtimeProcess = describeRuntimeProcess({
    processKind,
    startWorker,
    hasRedisRunQueue: Boolean(redisRunQueue)
  });
  const workerMode = startWorker ? (processKind === "worker" ? "external" : "embedded") : redisRunQueue ? "external" : "disabled";
  const persistedWorkspaceSnapshots = hasPersistedWorkspaceListing(persistence)
    ? await persistence.listPersistedWorkspaces()
    : hasWorkspaceSnapshotListing(persistence)
      ? await persistence.listWorkspaceSnapshots(discoveredWorkspaces as WorkspaceRecord[])
      : await listAllWorkspaces(persistence.workspaceRepository);
  const bootWorkspaceCandidates =
    singleWorkspace === undefined
      ? [
          ...discoveredWorkspaces,
          ...persistedWorkspaceSnapshots.filter((workspace) => !isManagedWorkspace(workspace, config.paths))
        ]
      : discoveredWorkspaces;
  const reconciledWorkspaces = reconcileDiscoveredWorkspaces(bootWorkspaceCandidates, persistedWorkspaceSnapshots).map((workspace) =>
    withManagedWorkspaceExternalRef(workspace, config, objectStorageMirror)
  );
  const visibleWorkspaceIds = new Set<string>();
  const workspaceRepository = new ScopedWorkspaceRepository(persistence.workspaceRepository, visibleWorkspaceIds);
  const sessionRepository = new ScopedSessionRepository(persistence.sessionRepository, visibleWorkspaceIds);
  const runRepository = new ScopedRunRepository(persistence.runRepository, visibleWorkspaceIds);
  const primarySessionEventStore =
    primaryStorageMode === "postgres"
      ? new DualWriteSessionEventStore({
          primary: persistence.sessionEventStore,
          sessionRepository,
          workspaceRepository,
          logger: {
            warn(message, error) {
              console.warn(message, error);
            }
          }
        })
      : persistence.sessionEventStore;
  const sessionEventStore = redisBus
    ? new FanoutSessionEventStore(primarySessionEventStore, redisBus)
    : primarySessionEventStore;
  const runtimeDebugLogger = buildRuntimeConsoleLogger({
    enabled: true,
    echoToStdout: isTruthyEnvValue(process.env.OAH_RUNTIME_DEBUG),
    sessionEventStore: primarySessionEventStore,
    now: () => new Date().toISOString()
  });
  const modelGateway = new AiSdkModelGateway({
    defaultModelName: config.llm.default_model,
    models,
    logger: runtimeDebugLogger
  });
  let platformModelRevision = 0;
  const platformModelSnapshotListeners = new Set<(snapshot: PlatformModelSnapshot) => void>();
  const getPlatformModelSnapshot = async (): Promise<PlatformModelSnapshot> => ({
    revision: platformModelRevision,
    items: toPlatformModelItems(models, config.llm.default_model)
  });
  const publishPlatformModelSnapshot = async (): Promise<void> => {
    if (platformModelSnapshotListeners.size === 0) {
      return;
    }

    const snapshot = await getPlatformModelSnapshot();
    for (const listener of platformModelSnapshotListeners) {
      listener(snapshot);
    }
  };
  let workspaceRegistrySyncPromise: Promise<void> | undefined;
  let lastWorkspaceRegistrySyncAt = 0;
  let workspaceRegistryPollTimer: NodeJS.Timeout | undefined;
  let watchedProjectRoots = new Map<string, FSWatcher>();
  const rootWorkspaceWatcher =
    singleWorkspace === undefined ? openFsWatcher(config.paths.workspace_dir, scheduleWorkspaceRegistrySync) : undefined;
  let workspaceSyncTimer: NodeJS.Timeout | undefined;
  let platformModelsReloadPromise: Promise<void> | undefined;
  let lastPlatformModelsReloadAt = 0;
  let platformModelsPollTimer: NodeJS.Timeout | undefined;
  let platformModelsReloadTimer: NodeJS.Timeout | undefined;

  reconciledWorkspaces.forEach((workspace) => {
    visibleWorkspaceIds.add(workspace.id);
  });
  await Promise.all(reconciledWorkspaces.map((workspace) => workspaceRepository.upsert(workspace)));

  const syncWorkspaceRegistry =
    singleWorkspace === undefined
      ? async () => {
          const now = Date.now();
          if (workspaceRegistrySyncPromise) {
            return workspaceRegistrySyncPromise;
          }
          if (now - lastWorkspaceRegistrySyncAt < 200) {
            return;
          }

          workspaceRegistrySyncPromise = (async () => {
            const latestProjectWorkspaces = (
              await discoverProjectWorkspaces({
                workspaceDir: config.paths.workspace_dir,
                models,
                platformAgents,
                platformSkillDir: config.paths.skill_dir,
                platformToolDir: toolDir,
                onError: ({ rootPath, error }: { rootPath: string; kind: "project"; error: unknown }) => {
                  logWorkspaceDiscoveryError(rootPath, "project", error);
                }
              })
            ).map((workspace) => withManagedWorkspaceExternalRef(workspace as WorkspaceRecord, config, objectStorageMirror));
            const persistedWorkspaces = await listAllWorkspaces(persistence.workspaceRepository);
            const staticWorkspaces = persistedWorkspaces.filter(
              (workspace) => workspace.kind === "chat" || !isManagedWorkspace(workspace, config.paths)
            );
            const latestDiscoveredWorkspaces = [...latestProjectWorkspaces, ...staticWorkspaces];
            const staleWorkspaceIds = findManagedWorkspaceIdsToDelete(latestDiscoveredWorkspaces, persistedWorkspaces, config.paths);
            const staleWorkspaces = persistedWorkspaces.filter((workspace) => staleWorkspaceIds.includes(workspace.id));

            await Promise.all(
              staleWorkspaces.map(async (workspace) => {
                const cleanup = await cleanupWorkspaceLocalArtifacts({
                  workspace,
                  paths: config.paths,
                  sqliteShadowRoot
                });
                console.info(
                  `[oah-bootstrap] Cleaned local artifacts for stale workspace ${workspace.id} (${cleanup.mode}): ${cleanup.removedPaths.join(", ")}`
                );
                await persistence.workspaceRepository.delete(workspace.id);
              })
            );

            const latestPersistedWorkspaces =
              staleWorkspaceIds.length > 0 ? await listAllWorkspaces(persistence.workspaceRepository) : persistedWorkspaces;
            const latestReconciledWorkspaces = reconcileDiscoveredWorkspaces(
              latestDiscoveredWorkspaces,
              latestPersistedWorkspaces
            ).map((workspace) => withManagedWorkspaceExternalRef(workspace, config, objectStorageMirror));

            await Promise.all(latestReconciledWorkspaces.map(async (workspace) => persistence.workspaceRepository.upsert(workspace)));

            visibleWorkspaceIds.clear();
            latestReconciledWorkspaces.forEach((workspace) => {
              visibleWorkspaceIds.add(workspace.id);
            });
            updateWatchedProjectRoots(latestReconciledWorkspaces);
            lastWorkspaceRegistrySyncAt = Date.now();
          })().finally(() => {
            workspaceRegistrySyncPromise = undefined;
          });

          return workspaceRegistrySyncPromise;
        }
      : undefined;

  function updateWatchedProjectRoots(workspaces: WorkspaceRecord[]): void {
    if (singleWorkspace !== undefined) {
      return;
    }

    const nextRoots = new Set(
      workspaces
        .filter((workspace) => workspace.kind === "project" && isManagedWorkspaceRoot(workspace.rootPath, config.paths.workspace_dir))
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

  function scheduleWorkspaceRegistrySync(): void {
    if (!syncWorkspaceRegistry) {
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
    }, 150);
    workspaceSyncTimer.unref?.();
  }

  async function refreshWorkspaceDefinitionsForPlatformModels(): Promise<void> {
    const currentWorkspaces = await listAllWorkspaces(persistence.workspaceRepository);
    const refreshedWorkspaces = await Promise.all(
      currentWorkspaces.map(async (workspace) => {
        try {
          const discovered = await discoverWorkspace(workspace.rootPath, workspace.kind, {
            platformModels: models,
            platformAgents,
            platformSkillDir: config.paths.skill_dir,
            platformToolDir: toolDir
          } as Parameters<typeof discoverWorkspace>[2]);

          return {
            ...discovered,
            id: workspace.id,
            name: workspace.name,
            executionPolicy: workspace.executionPolicy,
            status: workspace.status,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
            historyMirrorEnabled: workspace.historyMirrorEnabled,
            ...(workspace.externalRef ? { externalRef: workspace.externalRef } : {})
          } as WorkspaceRecord;
        } catch (error) {
          console.warn(`[oah-bootstrap] Failed to refresh workspace ${workspace.id} after platform model reload.`, error);
          return workspace;
        }
      })
    ).then((workspaces) => workspaces.map((workspace) => withManagedWorkspaceExternalRef(workspace, config, objectStorageMirror)));

    await Promise.all(refreshedWorkspaces.map(async (workspace) => persistence.workspaceRepository.upsert(workspace)));
    visibleWorkspaceIds.clear();
    refreshedWorkspaces.forEach((workspace) => {
      visibleWorkspaceIds.add(workspace.id);
    });
    updateWatchedProjectRoots(refreshedWorkspaces);
  }

  async function reloadPlatformModels(): Promise<void> {
    const now = Date.now();
    if (platformModelsReloadPromise) {
      return platformModelsReloadPromise;
    }
    if (now - lastPlatformModelsReloadAt < 200) {
      return;
    }

    platformModelsReloadPromise = (async () => {
      const currentSnapshot = serializePlatformModels(models);
      const nextModels = await loadPlatformModels(modelDir, {
        onError: ({ filePath, error }: { filePath: string; error: unknown }) => {
          logModelLoadError(filePath, error);
        }
      });
      const nextSnapshot = serializePlatformModels(nextModels);
      lastPlatformModelsReloadAt = Date.now();

      if (currentSnapshot === nextSnapshot) {
        return;
      }

      replacePlatformModels(models, nextModels);
      (modelGateway as AiSdkModelGateway & { clearModelCache?: () => void }).clearModelCache?.();
      await refreshWorkspaceDefinitionsForPlatformModels();
      platformModelRevision += 1;
      await publishPlatformModelSnapshot();
    })()
      .catch((error) => {
        console.warn("Platform model reload failed.", error);
      })
      .finally(() => {
        platformModelsReloadPromise = undefined;
      });

    return platformModelsReloadPromise;
  }

  function schedulePlatformModelsReload(): void {
    if (platformModelsReloadTimer) {
      clearTimeout(platformModelsReloadTimer);
    }

    platformModelsReloadTimer = setTimeout(() => {
      platformModelsReloadTimer = undefined;
      void reloadPlatformModels();
    }, 150);
    platformModelsReloadTimer.unref?.();
  }
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
  updateWatchedProjectRoots(reconciledWorkspaces);
  if (syncWorkspaceRegistry) {
    await syncWorkspaceRegistry();
    workspaceRegistryPollTimer = setInterval(() => {
      void syncWorkspaceRegistry().catch((error) => {
        console.warn("Workspace registry poll sync failed.", error);
      });
    }, 2_000);
    workspaceRegistryPollTimer.unref?.();
  }
  const platformModelsWatcher = openFsWatcher(modelDir, schedulePlatformModelsReload);
  platformModelsPollTimer = setInterval(() => {
    void reloadPlatformModels();
  }, 2_000);
  platformModelsPollTimer.unref?.();
  const runtimeService = new RuntimeService({
    defaultModel: config.llm.default_model,
    modelGateway,
    logger: runtimeDebugLogger,
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
    ...(singleWorkspace === undefined
      ? {
          workspaceDeletionHandler: {
            async deleteWorkspace(workspace) {
              const cleanup = await cleanupWorkspaceLocalArtifacts({
                workspace,
                paths: config.paths,
                sqliteShadowRoot
              });
              console.info(
                `[oah-bootstrap] Cleaned local artifacts for deleted workspace ${workspace.id} (${cleanup.mode}): ${cleanup.removedPaths.join(", ")}`
              );
            }
          }
        }
      : {}),
    ...(singleWorkspace === undefined
      ? {
          workspaceInitializer: {
            async initialize(input) {
              const workspaceId = createId("ws");
              const workspaceRoot = resolveWorkspaceCreationRoot({
                workspaceDir: config.paths.workspace_dir,
                name: input.name,
                workspaceId,
                rootPath: input.rootPath
              });

              await initializeWorkspaceFromTemplate(
                {
                  templateDir: config.paths.template_dir,
                  templateName: input.template,
                  rootPath: workspaceRoot,
                  platformToolDir: config.paths.tool_dir,
                  platformSkillDir: config.paths.skill_dir,
                  agentsMd: input.agentsMd,
                  toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
                  skills: input.skills
                } as Parameters<typeof initializeWorkspaceFromTemplate>[0]
              );

              const discovered = await discoverWorkspace(workspaceRoot, "project", {
                platformModels: models,
                platformAgents,
                platformSkillDir: config.paths.skill_dir,
                platformToolDir: toolDir
              } as Parameters<typeof discoverWorkspace>[2]);

              return {
                ...discovered,
                id: workspaceId
              } as WorkspaceRecord;
            }
          }
        }
      : {})
  });
  const embeddedWorkerMin =
    processKind === "worker" ? 1 : parsePositiveIntEnv("OAH_EMBEDDED_WORKER_MIN", config.storage.redis_url ? 2 : 1);
  const embeddedWorkerMax = Math.max(embeddedWorkerMin, parsePositiveIntEnv("OAH_EMBEDDED_WORKER_MAX", embeddedWorkerMin));
  const embeddedWorkerScaleIntervalMs = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_INTERVAL_MS", 5_000);
  const embeddedWorkerReadySessionsPerWorker = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_READY_SESSIONS_PER_WORKER", 1);
  const embeddedWorkerScaleUpCooldownMs = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_UP_COOLDOWN_MS", 1_000);
  const embeddedWorkerScaleDownCooldownMs = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_DOWN_COOLDOWN_MS", 15_000);
  const embeddedWorkerScaleUpSampleSize = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_UP_SAMPLE_SIZE", 2);
  const embeddedWorkerScaleDownSampleSize = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_DOWN_SAMPLE_SIZE", 3);
  const embeddedWorkerScaleUpBusyRatioPercent = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_UP_BUSY_RATIO_PERCENT", 75);
  const embeddedWorkerScaleUpBusyRatioThreshold = Math.min(1, Math.max(0, embeddedWorkerScaleUpBusyRatioPercent / 100));
  const embeddedWorkerScaleUpMaxReadyAgeMs = parsePositiveIntEnv("OAH_EMBEDDED_WORKER_SCALE_UP_MAX_READY_AGE_MS", 2_000);
  const redisRunWorkerPool =
    startWorker && redisRunQueue && config.storage.redis_url
      ? new RedisRunWorkerPool({
          queue: redisRunQueue,
          queueFactory: () =>
            createRedisSessionRunQueue({
              url: config.storage.redis_url as string
            }),
          runtimeService,
          processKind: processKind === "worker" ? "standalone" : "embedded",
          registry: redisWorkerRegistry,
          minWorkers: embeddedWorkerMin,
          maxWorkers: embeddedWorkerMax,
          scaleIntervalMs: embeddedWorkerScaleIntervalMs,
          readySessionsPerWorker: embeddedWorkerReadySessionsPerWorker,
          scaleUpCooldownMs: embeddedWorkerScaleUpCooldownMs,
          scaleDownCooldownMs: embeddedWorkerScaleDownCooldownMs,
          scaleUpSampleSize: embeddedWorkerScaleUpSampleSize,
          scaleDownSampleSize: embeddedWorkerScaleDownSampleSize,
          scaleUpBusyRatioThreshold: embeddedWorkerScaleUpBusyRatioThreshold,
          scaleUpMaxReadyAgeMs: embeddedWorkerScaleUpMaxReadyAgeMs,
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
        })
      : undefined;
  redisRunWorkerPool?.start();
  const historyMirrorSyncer =
    primaryStorageMode === "postgres" &&
    shouldRunHistoryMirrorSync({
      processKind,
      startWorker,
      hasRedisRunQueue: Boolean(redisRunQueue)
    }) &&
    "historyEventRepository" in persistence &&
    persistence.historyEventRepository
      ? new HistoryMirrorSyncer({
          workspaceRepository,
          historyEventRepository: persistence.historyEventRepository,
          ...("historyMirrorSnapshotSource" in persistence && persistence.historyMirrorSnapshotSource
            ? { snapshotSource: persistence.historyMirrorSnapshotSource }
            : {}),
          logger: {
            warn(message, error) {
              console.warn(message, error);
            },
            error(message, error) {
              console.error(message, error);
            }
          }
        })
      : undefined;
  historyMirrorSyncer?.start();
  const historyEventCleaner =
    primaryStorageMode === "postgres" &&
    shouldRunHistoryMirrorSync({
      processKind,
      startWorker,
      hasRedisRunQueue: Boolean(redisRunQueue)
    }) &&
    "historyEventRepository" in persistence &&
    persistence.historyEventRepository &&
    "pruneByWorkspace" in persistence.historyEventRepository &&
    typeof persistence.historyEventRepository.pruneByWorkspace === "function"
      ? (() => {
          const retentionDays = Number.parseInt(process.env.OAH_HISTORY_EVENT_RETENTION_DAYS ?? "7", 10);
          const retentionMs =
            Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

          return new HistoryEventCleaner({
            workspaceRepository,
            historyEventRepository: persistence.historyEventRepository,
            retentionMs,
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
        })()
      : undefined;
  historyEventCleaner?.start();
  const closePersistence =
    "close" in persistence && typeof persistence.close === "function" ? () => persistence.close() : async () => undefined;

  async function postgresCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!postgresConfigured) {
      return "not_configured";
    }

    if (primaryStorageMode !== "postgres" || !("pool" in persistence)) {
      return "down";
    }

    try {
      await persistence.pool.query("select 1");
      return "up";
    } catch {
      return "down";
    }
  }

  async function redisEventsCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!redisConfigured) {
      return "not_configured";
    }

    if (!redisBus) {
      return "down";
    }

    return (await redisBus.ping()) ? "up" : "down";
  }

  async function redisRunQueueCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!redisConfigured) {
      return "not_configured";
    }

    if (!redisRunQueue) {
      return "down";
    }

    return (await redisRunQueue.ping()) ? "up" : "down";
  }

  async function historyMirrorSummary(): Promise<{
    check: "up" | "degraded" | "not_configured";
    worker: "running" | "disabled";
    enabledWorkspaces: number;
    idleWorkspaces: number;
    missingWorkspaces: number;
    errorWorkspaces: number;
  }> {
    if (primaryStorageMode !== "postgres") {
      return {
        check: "not_configured",
        worker: "disabled",
        enabledWorkspaces: 0,
        idleWorkspaces: 0,
        missingWorkspaces: 0,
        errorWorkspaces: 0
      };
    }

    const workspaces: import("@oah/runtime-core").WorkspaceRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await workspaceRepository.list(100, cursor);
      workspaces.push(...page);
      cursor = page.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
    } while (cursor);

    const enabledWorkspaces = workspaces.filter(
      (workspace) => workspace.kind === "project" && workspace.historyMirrorEnabled !== false
    );

    if (enabledWorkspaces.length === 0) {
      return {
        check: "not_configured",
        worker: historyMirrorSyncer ? "running" : "disabled",
        enabledWorkspaces: 0,
        idleWorkspaces: 0,
        missingWorkspaces: 0,
        errorWorkspaces: 0
      };
    }

    const statuses = await Promise.all(enabledWorkspaces.map((workspace) => inspectHistoryMirrorStatus(workspace)));
    const idleWorkspaces = statuses.filter((status) => status.state === "idle").length;
    const missingWorkspaces = statuses.filter((status) => status.state === "missing").length;
    const errorWorkspaces = statuses.filter((status) => status.state === "error").length;
    const degraded = !historyMirrorSyncer || missingWorkspaces > 0 || errorWorkspaces > 0;

    return {
      check: degraded ? "degraded" : "up",
      worker: historyMirrorSyncer ? "running" : "disabled",
      enabledWorkspaces: enabledWorkspaces.length,
      idleWorkspaces,
      missingWorkspaces,
      errorWorkspaces
    };
  }

  return {
    config,
    runtimeService,
    modelGateway,
    process: runtimeProcess,
    workspaceMode,
    listPlatformModels: async () => toPlatformModelItems(models, config.llm.default_model),
    getPlatformModelSnapshot,
    subscribePlatformModelSnapshot(listener) {
      platformModelSnapshotListeners.add(listener);
      return () => {
        platformModelSnapshotListeners.delete(listener);
      };
    },
    ...(singleWorkspace === undefined
      ? {
          listWorkspaceTemplates: () => listWorkspaceTemplates(config.paths.template_dir),
          uploadWorkspaceTemplate: (input: { templateName: string; zipBuffer: Buffer; overwrite?: boolean | undefined }) =>
            uploadWorkspaceTemplate({
              templateDir: config.paths.template_dir,
              templateName: input.templateName,
              zipBuffer: input.zipBuffer,
              ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {})
            }),
          deleteWorkspaceTemplate: (input: { templateName: string }) =>
            deleteWorkspaceTemplate({
              templateDir: config.paths.template_dir,
              templateName: input.templateName
            }),
          async importWorkspace(input) {
            const allowedDir = input.kind === "chat" ? config.paths.chat_dir : config.paths.workspace_dir;
            const resolvedRoot = path.resolve(input.rootPath);
            const relativeToAllowed = path.relative(allowedDir, resolvedRoot);
            if (relativeToAllowed.startsWith("..") || path.isAbsolute(relativeToAllowed)) {
              throw new AppError(
                403,
                "workspace_path_not_allowed",
                `rootPath "${input.rootPath}" resolves outside the allowed directory. ` +
                  `Workspace imports must target paths within the configured ${input.kind === "chat" ? "chat_dir" : "workspace_dir"}.`
              );
            }

            const discovered = await discoverWorkspace(input.rootPath, input.kind ?? "project", {
              platformModels: models,
              platformAgents,
              platformSkillDir: config.paths.skill_dir,
              platformToolDir: toolDir
            } as Parameters<typeof discoverWorkspace>[2]);
            const existing = await workspaceRepository.getById(discovered.id);
            const inferredExternalRef =
              objectStorageMirror?.managedWorkspaceExternalRef(input.rootPath, input.kind ?? "project", config.paths);
            const persisted = await workspaceRepository.upsert({
              ...discovered,
              name: input.name ?? existing?.name ?? discovered.name,
              createdAt: existing?.createdAt ?? discovered.createdAt,
              externalRef: input.externalRef ?? existing?.externalRef ?? inferredExternalRef
            });
            return runtimeService.getWorkspace(persisted.id);
          }
        }
      : {}),
    async getWorkspaceHistoryMirrorStatus(workspace) {
      if (primaryStorageMode !== "postgres") {
        return {
          workspaceId: workspace.id,
          supported: false,
          enabled: false,
          state: "unsupported"
        };
      }

      return inspectHistoryMirrorStatus(workspace);
    },
    rebuildWorkspaceHistoryMirror(workspace) {
      if (!historyMirrorSyncer) {
        throw new Error("History mirror rebuild is unavailable because the mirror sync worker is not running.");
      }

      return historyMirrorSyncer.rebuildWorkspace(workspace);
    },
    storageAdmin,
    appendRuntimeLog(input) {
      return appendRuntimeLogEvent(primarySessionEventStore, {
        ...input,
        timestamp: new Date().toISOString()
      });
    },
    async healthReport() {
      const activeWorkers = redisWorkerRegistry ? await redisWorkerRegistry.listActive() : [];
      const workerSummary = summarizeActiveWorkers(activeWorkers);
      const workerPool = redisRunWorkerPool?.snapshot() ?? null;
      const mirror = await historyMirrorSummary();
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck(),
        historyMirror: mirror.check
      };

      return {
        status: Object.values(checks).some((value) => value === "down" || value === "degraded") ? "degraded" : "ok",
        storage: {
          primary: primaryStorageMode,
          events: redisBus ? "redis" : "memory",
          runQueue: redisRunQueue ? "redis" : "in_process"
        },
        process: runtimeProcess,
        checks,
        worker: {
          mode: workerMode,
          activeWorkers,
          summary: workerSummary,
          pool: workerPool
        },
        mirror
      };
    },
    async readinessReport() {
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck()
      };

      return {
        status: Object.values(checks).includes("down") ? "not_ready" : "ready",
        checks
      };
    },
    async close() {
      await Promise.all([
        historyMirrorSyncer?.close() ?? Promise.resolve(),
        historyEventCleaner?.close() ?? Promise.resolve(),
        redisRunWorkerPool?.close() ?? Promise.resolve(),
        storageAdmin.close(),
        redisBus?.close() ?? Promise.resolve(),
        redisWorkerRegistry?.close() ?? Promise.resolve(),
        redisRunQueue?.close() ?? Promise.resolve()
      ]);
      await closePersistence();
      await objectStorageMirror?.close();
      if (workspaceSyncTimer) {
        clearTimeout(workspaceSyncTimer);
      }
      if (platformModelsReloadTimer) {
        clearTimeout(platformModelsReloadTimer);
      }
      if (workspaceRegistryPollTimer) {
        clearInterval(workspaceRegistryPollTimer);
      }
      if (platformModelsPollTimer) {
        clearInterval(platformModelsPollTimer);
      }
      rootWorkspaceWatcher?.close();
      platformModelsWatcher?.close();
      for (const watcher of watchedProjectRoots.values()) {
        watcher.close();
      }
      watchedProjectRoots.clear();
    }
  };
}

export function installSignalHandlers(close: () => Promise<void>): void {
  let closing: Promise<void> | undefined;

  const shutdown = () => {
    if (!closing) {
      closing = close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    }

    return closing;
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit());
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit());
  });
}
