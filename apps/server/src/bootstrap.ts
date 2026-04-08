import path from "node:path";
import type { FSWatcher } from "node:fs";
import { access, rm } from "node:fs/promises";

import {
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromTemplate,
  listWorkspaceTemplates,
  loadPlatformModels,
  loadServerConfig,
  resolveWorkspaceCreationRoot
} from "@oah/config";
import type { ServerConfig } from "@oah/config";
import { AppError, RuntimeService, createId, parseCursor } from "@oah/runtime-core";
import type { RuntimeLogger, WorkspaceRecord } from "@oah/runtime-core";
import { AiSdkModelGateway } from "@oah/model-gateway";
import { createPostgresRuntimePersistence } from "@oah/storage-postgres";
import { createSQLiteRuntimePersistence } from "@oah/storage-sqlite";
import {
  FanoutSessionEventStore,
  RedisRunWorker,
  createRedisSessionEventBus,
  createRedisSessionRunQueue
} from "@oah/storage-redis";
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
import { HistoryMirrorSyncer, inspectHistoryMirrorStatus } from "./history-mirror.js";
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

function buildRuntimeDebugLogger(enabled: boolean): RuntimeLogger | undefined {
  if (!enabled) {
    return undefined;
  }

  return {
    debug(message, details) {
      if (details) {
        console.debug(`[oah-runtime-debug] ${message}`, details);
        return;
      }

      console.debug(`[oah-runtime-debug] ${message}`);
    },
    warn(message, details) {
      if (details) {
        console.warn(`[oah-runtime-debug] ${message}`, details);
        return;
      }

      console.warn(`[oah-runtime-debug] ${message}`);
    },
    error(message, details) {
      if (details) {
        console.error(`[oah-runtime-debug] ${message}`, details);
        return;
      }

      console.error(`[oah-runtime-debug] ${message}`);
    }
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
          await discoverWorkspace(singleWorkspace.rootPath, singleWorkspace.kind, {
            platformModels: models,
            platformAgents,
            platformSkillDir: config.paths.skill_dir,
            platformToolDir: toolDir
          } as Parameters<typeof discoverWorkspace>[2])
        ]
      : await discoverWorkspaces({
          paths: config.paths,
          platformModels: models,
          platformAgents,
          onError: ({ rootPath, kind, error }: { rootPath: string; kind: "project" | "chat"; error: unknown }) => {
            logWorkspaceDiscoveryError(rootPath, kind, error);
          }
        } as Parameters<typeof discoverWorkspaces>[0]);
  const runtimeDebugLogger = buildRuntimeDebugLogger(isTruthyEnvValue(process.env.OAH_RUNTIME_DEBUG));
  const modelGateway = new AiSdkModelGateway({
    defaultModelName: config.llm.default_model,
    models,
    logger: runtimeDebugLogger
  });
  const postgresConfigured = Boolean(config.storage.postgres_url && config.storage.postgres_url.trim().length > 0);
  const persistence = postgresConfigured
    ? await createPostgresRuntimePersistence({
        connectionString: config.storage.postgres_url
      }).catch((error) => {
        throw new Error(
          `Configured PostgreSQL persistence is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
        );
      })
    : await createSQLiteRuntimePersistence({
        shadowRoot: path.join(config.paths.workspace_dir, ".openharness", "data", "workspace-state")
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
  const redisConfigured = Boolean(config.storage.redis_url && config.storage.redis_url.trim().length > 0);
  const storageAdmin = createStorageAdmin({
    ...("pool" in persistence ? { postgresPool: persistence.pool } : {}),
    redisUrl: config.storage.redis_url,
    redisAvailable: redisConfigured,
    redisEventBusEnabled: Boolean(redisBus),
    redisRunQueueEnabled: Boolean(redisRunQueue)
  });
  const runtimeProcess = describeRuntimeProcess({
    processKind,
    startWorker,
    hasRedisRunQueue: Boolean(redisRunQueue)
  });
  const workerMode = startWorker ? "embedded" : redisRunQueue ? "external" : "disabled";
  const sessionEventStore = redisBus
    ? new FanoutSessionEventStore(persistence.sessionEventStore, redisBus)
    : persistence.sessionEventStore;
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
  const reconciledWorkspaces = reconcileDiscoveredWorkspaces(
    bootWorkspaceCandidates,
    persistedWorkspaceSnapshots
  );
  const visibleWorkspaceIds = new Set<string>();
  const workspaceRepository = new ScopedWorkspaceRepository(persistence.workspaceRepository, visibleWorkspaceIds);
  const sessionRepository = new ScopedSessionRepository(persistence.sessionRepository, visibleWorkspaceIds);
  const runRepository = new ScopedRunRepository(persistence.runRepository, visibleWorkspaceIds);
  let workspaceRegistrySyncPromise: Promise<void> | undefined;
  let lastWorkspaceRegistrySyncAt = 0;
  let workspaceRegistryPollTimer: NodeJS.Timeout | undefined;
  let watchedProjectRoots = new Map<string, FSWatcher>();
  const rootWorkspaceWatcher =
    singleWorkspace === undefined ? openFsWatcher(config.paths.workspace_dir, scheduleWorkspaceRegistrySync) : undefined;
  let workspaceSyncTimer: NodeJS.Timeout | undefined;

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
            const latestProjectWorkspaces = await discoverProjectWorkspaces({
              workspaceDir: config.paths.workspace_dir,
              models,
              platformAgents,
              platformSkillDir: config.paths.skill_dir,
              platformToolDir: toolDir,
              onError: ({ rootPath, error }: { rootPath: string; kind: "project"; error: unknown }) => {
                logWorkspaceDiscoveryError(rootPath, "project", error);
              }
            });
            const persistedWorkspaces = await listAllWorkspaces(persistence.workspaceRepository);
            const staticWorkspaces = persistedWorkspaces.filter(
              (workspace) => workspace.kind === "chat" || !isManagedWorkspace(workspace, config.paths)
            );
            const latestDiscoveredWorkspaces = [...latestProjectWorkspaces, ...staticWorkspaces];
            const staleWorkspaceIds = findManagedWorkspaceIdsToDelete(latestDiscoveredWorkspaces, persistedWorkspaces, config.paths);

            await Promise.all(staleWorkspaceIds.map(async (workspaceId) => persistence.workspaceRepository.delete(workspaceId)));

            const latestPersistedWorkspaces =
              staleWorkspaceIds.length > 0 ? await listAllWorkspaces(persistence.workspaceRepository) : persistedWorkspaces;
            const latestReconciledWorkspaces = reconcileDiscoveredWorkspaces(
              latestDiscoveredWorkspaces,
              latestPersistedWorkspaces
            );

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
  const runtimeService = new RuntimeService({
    defaultModel: config.llm.default_model,
    modelGateway,
    logger: runtimeDebugLogger,
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
              if (workspace.kind !== "project") {
                return;
              }

              if (!isManagedWorkspaceRoot(workspace.rootPath, config.paths.workspace_dir)) {
                return;
              }

              await rm(workspace.rootPath, {
                recursive: true,
                force: true
              });
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
              };
            }
          }
        }
      : {})
  });
  const redisRunWorker =
    startWorker && redisRunQueue
      ? new RedisRunWorker({
          queue: redisRunQueue,
          runtimeService,
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
  redisRunWorker?.start();
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

    const enabledWorkspaces = workspaces.filter((workspace) => workspace.kind === "project");

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
    listPlatformModels: async () =>
      Object.entries(models).map(([id, definition]) => ({
        id,
        provider: definition.provider,
        modelName: definition.name,
        ...(definition.url ? { url: definition.url } : {}),
        hasKey: Boolean(definition.key),
        ...(definition.metadata ? { metadata: definition.metadata } : {}),
        isDefault: config.llm.default_model === id
      })),
    ...(singleWorkspace === undefined
      ? {
          listWorkspaceTemplates: () => listWorkspaceTemplates(config.paths.template_dir),
          async importWorkspace(input) {
            const discovered = await discoverWorkspace(input.rootPath, input.kind ?? "project", {
              platformModels: models,
              platformAgents,
              platformSkillDir: config.paths.skill_dir,
              platformToolDir: toolDir
            } as Parameters<typeof discoverWorkspace>[2]);
            const existing = await workspaceRepository.getById(discovered.id);
            const persisted = await workspaceRepository.upsert({
              ...discovered,
              name: input.name ?? existing?.name ?? discovered.name,
              createdAt: existing?.createdAt ?? discovered.createdAt,
              externalRef: input.externalRef ?? existing?.externalRef
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
    async healthReport() {
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
          mode: workerMode
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
        redisRunWorker?.close() ?? Promise.resolve(),
        storageAdmin.close(),
        closePersistence(),
        redisBus?.close() ?? Promise.resolve(),
        redisRunQueue?.close() ?? Promise.resolve()
      ]);
      if (workspaceSyncTimer) {
        clearTimeout(workspaceSyncTimer);
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
