import path from "node:path";
import type { FSWatcher } from "node:fs";
import { access, rm } from "node:fs/promises";

import type { HealthReport, ReadinessReport } from "@oah/api-contracts";
import {
  deleteWorkspaceBlueprint,
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromBlueprint,
  listWorkspaceBlueprints,
  loadPlatformModels,
  loadServerConfig,
  resolveWorkspaceCreationRoot,
  uploadWorkspaceBlueprint
} from "@oah/config";
import type { ServerConfig } from "@oah/config";
import { AppError, RuntimeService, createId, parseCursor } from "@oah/runtime-core";
import type { RuntimeLogger, SandboxHostProviderKind, WorkspaceRecord } from "@oah/runtime-core";
import { AiSdkModelGateway } from "@oah/model-gateway";
import { createSQLiteRuntimePersistence, sqliteWorkspaceHistoryDbPath } from "@oah/storage-sqlite";
import {
  FanoutSessionEventStore,
  createRedisWorkerRegistry,
  createRedisWorkspacePlacementRegistry,
  createRedisWorkspaceLeaseRegistry,
  createRedisSessionEventBus,
  createRedisSessionRunQueue
} from "@oah/storage-redis";
import {
  WorkspaceMaterializationManager
} from "./bootstrap/workspace-materialization.js";
import type { SandboxHost } from "./bootstrap/sandbox-host.js";
import { createConfiguredSandboxHost } from "./bootstrap/configured-sandbox-host.js";
import { createWorkerRuntimeControl, type WorkerRuntimeStatus } from "./bootstrap/worker-runtime.js";
import { createDirectoryObjectStore, ObjectStorageMirrorController } from "./object-storage.js";
import { appendRuntimeLogEvent, buildRuntimeConsoleLogger } from "./runtime-console.js";
import { createSandboxBackedWorkspaceInitializer } from "./bootstrap/sandbox-backed-workspace-initializer.js";
import {
  buildSingleWorkspaceConfig,
  describeRuntimeProcess,
  type RuntimeProcessDescriptor,
  parseConfigPath,
  parseSingleWorkspaceOptions,
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
import { createBuiltInPlatformAgents } from "./platform-agents.js";
import { createStorageAdmin, type StorageAdmin } from "./storage-admin.js";
import { createServiceRoutedPostgresRuntimePersistence } from "./bootstrap/service-routed-postgres.js";

function resolveArchiveExportRoot(workspaceDir: string) {
  return path.join(workspaceDir, ".openharness", "archives");
}

function selectPlacementPreferredWorkerId(placement: {
  state?: "unassigned" | "active" | "idle" | "draining" | "evicted" | undefined;
  userId?: string | undefined;
  ownerWorkerId?: string | undefined;
  preferredWorkerId?: string | undefined;
} | null | undefined): string | undefined {
  const userId = placement?.userId?.trim();
  if (!userId) {
    return undefined;
  }

  const preferredWorkerId = placement?.preferredWorkerId?.trim();
  if (preferredWorkerId) {
    return preferredWorkerId;
  }

  if (placement?.state === "evicted" || placement?.state === "unassigned") {
    return undefined;
  }

  const ownerWorkerId = placement?.ownerWorkerId?.trim();
  if (ownerWorkerId) {
    return ownerWorkerId;
  }

  return undefined;
}

interface PlacementAwareSessionRunQueueLike {
  enqueue(
    sessionId: string,
    runId: string,
    input?: { priority?: "normal" | "subagent" | undefined; preferredWorkerId?: string | undefined }
  ): Promise<void>;
  claimNextSession(
    timeoutMs?: number | undefined,
    input?: { workerId?: string | undefined; runtimeInstanceId?: string | undefined }
  ): Promise<string | undefined>;
  readyQueueLength(): Promise<number>;
  inspectReadyQueue(nowMs?: number | undefined): Promise<{
    length: number;
    subagentLength: number;
    oldestReadyAgeMs: number;
    averageReadyAgeMs: number;
  }>;
  tryAcquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  renewSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, token: string): Promise<boolean>;
  dequeueRun(sessionId: string): Promise<string | undefined>;
  requeueSessionIfPending?(sessionId: string): Promise<boolean>;
  getSchedulingPressure?(): Promise<unknown>;
  getReadySessionCount?(): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createPlacementAwareSessionRunQueue<TQueue extends PlacementAwareSessionRunQueueLike>(options: {
  queue: TQueue;
  runRepository: {
    getById(runId: string): Promise<{ workspaceId: string } | null>;
  };
    workspacePlacementRegistry?: {
      getByWorkspaceId?(workspaceId: string): Promise<{
        state?: "unassigned" | "active" | "idle" | "draining" | "evicted" | undefined;
        userId?: string | undefined;
        ownerWorkerId?: string | undefined;
        preferredWorkerId?: string | undefined;
      } | undefined>;
  } | undefined;
}): TQueue {
  const queue = options.queue;
  const wrappedQueue: PlacementAwareSessionRunQueueLike = {
    async enqueue(
      sessionId: string,
      runId: string,
      input?: { priority?: "normal" | "subagent" | undefined; preferredWorkerId?: string | undefined }
    ) {
      let preferredWorkerId = input?.preferredWorkerId?.trim();

      if (!preferredWorkerId && options.workspacePlacementRegistry?.getByWorkspaceId) {
        const run = await options.runRepository.getById(runId);
        if (run?.workspaceId) {
          const placement = await options.workspacePlacementRegistry.getByWorkspaceId(run.workspaceId);
          preferredWorkerId = selectPlacementPreferredWorkerId(placement);
        }
      }

      await queue.enqueue(sessionId, runId, {
        ...input,
        ...(preferredWorkerId ? { preferredWorkerId } : {})
      });
    },
    claimNextSession(timeoutMs, input) {
      return queue.claimNextSession(timeoutMs, input);
    },
    readyQueueLength() {
      return queue.readyQueueLength();
    },
    inspectReadyQueue(nowMs) {
      return queue.inspectReadyQueue(nowMs);
    },
    tryAcquireSessionLock(sessionId, token, ttlMs) {
      return queue.tryAcquireSessionLock(sessionId, token, ttlMs);
    },
    renewSessionLock(sessionId, token, ttlMs) {
      return queue.renewSessionLock(sessionId, token, ttlMs);
    },
    releaseSessionLock(sessionId, token) {
      return queue.releaseSessionLock(sessionId, token);
    },
    dequeueRun(sessionId) {
      return queue.dequeueRun(sessionId);
    },
    ...(queue.requeueSessionIfPending
      ? {
          requeueSessionIfPending(sessionId: string) {
            return queue.requeueSessionIfPending!(sessionId);
          }
        }
      : {}),
    ...(queue.getSchedulingPressure
      ? {
          getSchedulingPressure() {
            return queue.getSchedulingPressure!();
          }
        }
      : {}),
    ...(queue.getReadySessionCount
      ? {
          getReadySessionCount() {
            return queue.getReadySessionCount!();
          }
        }
      : {}),
    ping() {
      return queue.ping();
    },
    close() {
      return queue.close();
    }
  };

  return wrappedQueue as TQueue;
}

export {
  buildSingleWorkspaceConfig,
  describeRuntimeProcess,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldStartEmbeddedWorker,
  shouldStartInlineWorker
} from "./bootstrap/runtime-process.js";
export { resolveEmbeddedWorkerPoolConfig, resolveWorkerMode } from "./bootstrap/worker-host.js";
export { findManagedWorkspaceIdsToDelete, reconcileDiscoveredWorkspaces } from "./bootstrap/workspace-registry.js";

export interface BootstrapOptions {
  argv?: string[] | undefined;
  startWorker?: boolean | undefined;
  processKind?: "api" | "worker" | undefined;
  platformAgents?: PlatformAgentRegistry | undefined;
  sandboxHostFactory?:
    | ((input: {
        config: Awaited<ReturnType<typeof loadServerConfig>>;
        processKind: "api" | "worker";
        workerId: string;
        ownerBaseUrl?: string | undefined;
        workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
      }) => Promise<SandboxHost | undefined> | SandboxHost | undefined)
    | undefined;
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
        workspaceKind: "project";
        rootPath: string;
      };
  listWorkspaceBlueprints?: () => Promise<Array<{ name: string }>>;
  uploadWorkspaceBlueprint?: (input: {
    blueprintName: string;
    zipBuffer: Buffer;
    overwrite?: boolean | undefined;
  }) => Promise<{ name: string }>;
  deleteWorkspaceBlueprint?: (input: { blueprintName: string }) => Promise<void>;
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
    kind?: "project";
    name?: string;
    externalRef?: string;
    ownerId?: string;
    serviceName?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  resolveWorkspaceOwnership?: (workspaceId: string) => Promise<{
    workspaceId: string;
    version: string;
    ownerWorkerId: string;
    ownerBaseUrl?: string | undefined;
    health: "healthy" | "late";
    lastActivityAt: string;
    localPath: string;
    remotePrefix?: string | undefined;
    isLocalOwner: boolean;
  } | undefined>;
  storageAdmin: StorageAdmin;
  sandboxHostProviderKind?: SandboxHostProviderKind | undefined;
  appendRuntimeLog(input: {
    sessionId: string;
    runId?: string | undefined;
    level: "debug" | "info" | "warn" | "error";
    category: "run" | "model" | "tool" | "hook" | "agent" | "http" | "system";
    message: string;
    details?: unknown;
    context?: import("@oah/api-contracts").RuntimeLogEventContext | undefined;
  }): Promise<void>;
  healthReport(): Promise<HealthReport>;
  readinessReport(): Promise<ReadinessReport>;
  beginDrain(): Promise<void>;
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

function isRemoteSandboxProvider(config: Pick<ServerConfig, "sandbox">): boolean {
  if (config.sandbox?.provider === "e2b") {
    return true;
  }

  const selfHostedBaseUrl = config.sandbox?.self_hosted?.base_url?.trim();
  return Boolean(selfHostedBaseUrl);
}

function resolveInternalBaseUrl(config: Pick<ServerConfig, "server">): string | undefined {
  const explicit = process.env.OAH_INTERNAL_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/u, "");
  }

  const host = config.server.host.trim();
  if (!host || host === "0.0.0.0" || host === "::") {
    return undefined;
  }

  return `http://${host}:${config.server.port}`;
}

function resolveRuntimeInstanceId(processKind: "api" | "worker"): string {
  const explicit = process.env.OAH_RUNTIME_INSTANCE_ID?.trim();
  if (explicit) {
    return explicit;
  }

  const hostname = process.env.HOSTNAME?.trim();
  if (hostname) {
    return `${processKind}:${hostname}`;
  }

  return `${processKind}:${process.pid}`;
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
  paths: Pick<ServerConfig["paths"], "workspace_dir">;
  sqliteShadowRoot: string;
}): Promise<WorkspaceLocalArtifactCleanupStatus> {
  if (isManagedWorkspaceRoot(input.workspace.rootPath, input.paths.workspace_dir)) {
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
  const runtimeInstanceId = resolveRuntimeInstanceId(processKind);
  const currentWorkerId = runtimeInstanceId;
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
  const ownerBaseUrl = resolveInternalBaseUrl(config);
  if (objectStorageMirror) {
    await objectStorageMirror.initialize();
  }
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
            onError: ({ rootPath, kind, error }: { rootPath: string; kind: "project"; error: unknown }) => {
              logWorkspaceDiscoveryError(rootPath, kind, error);
            }
          } as Parameters<typeof discoverWorkspaces>[0])
        ).map((workspace) =>
          withManagedWorkspaceExternalRef(workspace as WorkspaceRecord, config, objectStorageMirror)
        );
  const postgresConfigured = Boolean(config.storage.postgres_url && config.storage.postgres_url.trim().length > 0);
  const sqliteShadowRoot = path.join(config.paths.workspace_dir, ".openharness", "data", "workspace-state");
  const persistence = postgresConfigured
    ? await createServiceRoutedPostgresRuntimePersistence({
        connectionString: config.storage.postgres_url!
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
  const redisRawRunQueue =
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
  const redisWorkspaceLeaseRegistry =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisWorkspaceLeaseRegistry({
          url: config.storage.redis_url
        }).catch((error: unknown) => {
          console.warn(
            `Redis workspace lease registry unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without workspace ownership leases.`
          );
          return undefined;
        })
      : undefined;
  const redisWorkspacePlacementRegistry =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisWorkspacePlacementRegistry({
          url: config.storage.redis_url
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
  workspaceMaterializationManager = config.object_storage
    ? new WorkspaceMaterializationManager({
        cacheRoot: path.join(config.paths.workspace_dir, ".openharness", "__materialized__"),
        workerId: currentWorkerId,
        ...(ownerBaseUrl ? { ownerBaseUrl } : {}),
        store: createDirectoryObjectStore(config.object_storage),
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
    sandboxHost = await createConfiguredSandboxHost({
      config,
      ...(workspaceMaterializationManager ? { workspaceMaterializationManager } : {})
    });
  }
  const redisConfigured = Boolean(config.storage.redis_url && config.storage.redis_url.trim().length > 0);
  const storageAdmin = createStorageAdmin({
    ...("pool" in persistence ? { postgresPool: persistence.pool } : {}),
    ...(config.storage.postgres_url ? { postgresConnectionString: config.storage.postgres_url } : {}),
    redisUrl: config.storage.redis_url,
    redisAvailable: redisConfigured,
    redisEventBusEnabled: Boolean(redisBus),
    redisRunQueueEnabled: Boolean(redisRunQueue),
    ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
    archiveExportEnabled: false,
    archiveExportRoot: resolveArchiveExportRoot(config.paths.workspace_dir)
  });
  const runtimeProcess = describeRuntimeProcess({
    processKind,
    startWorker,
    hasRedisRunQueue: Boolean(redisRunQueue)
  });
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
  const primarySessionEventStore = persistence.sessionEventStore;
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
  let workspaceMaterializationMaintenanceTimer: NodeJS.Timeout | undefined;

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
            const staticWorkspaces = persistedWorkspaces.filter((workspace) => !isManagedWorkspace(workspace, config.paths));
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
            ...(workspace.serviceName ? { serviceName: workspace.serviceName } : {}),
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
  if (sandboxHost) {
    workspaceMaterializationMaintenanceTimer = setInterval(() => {
      const idleBefore = new Date(
        Date.now() - parsePositiveIntEnv("OAH_WORKSPACE_MATERIALIZATION_IDLE_TTL_MS", 60_000)
      ).toISOString();
      void sandboxHost
        .maintain({ idleBefore })
        .catch((error: unknown) => {
          console.warn("Workspace materialization maintenance failed.", error);
        });
    }, parsePositiveIntEnv("OAH_WORKSPACE_MATERIALIZATION_MAINTENANCE_INTERVAL_MS", 5_000));
    workspaceMaterializationMaintenanceTimer.unref?.();
  }
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
    ...(sandboxHost
      ? {
          workspaceCommandExecutor: sandboxHost.workspaceCommandExecutor,
          workspaceFileSystem: sandboxHost.workspaceFileSystem,
          workspaceExecutionProvider: sandboxHost.workspaceExecutionProvider,
          workspaceFileAccessProvider: sandboxHost.workspaceFileAccessProvider
        }
      : {}),
    ...(singleWorkspace === undefined && !isRemoteSandboxProvider(config)
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
            initialize: isRemoteSandboxProvider(config) && sandboxHost
              ? createSandboxBackedWorkspaceInitializer({
                  blueprintDir: config.paths.blueprint_dir,
                  platformToolDir: config.paths.tool_dir,
                  platformSkillDir: config.paths.skill_dir,
                  toolDir,
                  platformModels: models,
                  platformAgents,
                  sandboxHost
                }).initialize
              : async initialize(input) {
                  const workspaceId = createId("ws");
                  const workspaceRoot = resolveWorkspaceCreationRoot({
                    workspaceDir: config.paths.workspace_dir,
                    name: input.name,
                    workspaceId,
                    rootPath: input.rootPath
                  });

                  await initializeWorkspaceFromBlueprint(
                    {
                      blueprintDir: config.paths.blueprint_dir,
                      blueprintName: input.blueprint,
                      rootPath: workspaceRoot,
                      platformToolDir: config.paths.tool_dir,
                      platformSkillDir: config.paths.skill_dir,
                      agentsMd: input.agentsMd,
                      toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
                      skills: input.skills
                    } as Parameters<typeof initializeWorkspaceFromBlueprint>[0]
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
  const workerRuntime = createWorkerRuntimeControl({
    startWorker,
    processKind,
    runtimeInstanceId,
    ownerBaseUrl,
    config,
    redisRunQueue,
    redisWorkerRegistry,
    runtimeService,
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
  workerRuntime.start();
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
    ...(singleWorkspace === undefined && !isRemoteSandboxProvider(config)
      ? {
          listWorkspaceBlueprints: () => listWorkspaceBlueprints(config.paths.blueprint_dir),
          uploadWorkspaceBlueprint: (input: { blueprintName: string; zipBuffer: Buffer; overwrite?: boolean | undefined }) =>
            uploadWorkspaceBlueprint({
              blueprintDir: config.paths.blueprint_dir,
              blueprintName: input.blueprintName,
              zipBuffer: input.zipBuffer,
              ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {})
            }),
          deleteWorkspaceBlueprint: (input: { blueprintName: string }) =>
            deleteWorkspaceBlueprint({
              blueprintDir: config.paths.blueprint_dir,
              blueprintName: input.blueprintName
            }),
          async importWorkspace(input) {
            const resolvedRoot = path.resolve(input.rootPath);
            const relativeToAllowed = path.relative(config.paths.workspace_dir, resolvedRoot);
            if (relativeToAllowed.startsWith("..") || path.isAbsolute(relativeToAllowed)) {
              throw new AppError(
                403,
                "workspace_path_not_allowed",
                `rootPath "${input.rootPath}" resolves outside the allowed directory. ` +
                  "Workspace imports must target paths within the configured workspace_dir."
              );
            }

            const discovered = await discoverWorkspace(input.rootPath, "project", {
              platformModels: models,
              platformAgents,
              platformSkillDir: config.paths.skill_dir,
              platformToolDir: toolDir
            } as Parameters<typeof discoverWorkspace>[2]);
            const existing = await workspaceRepository.getById(discovered.id);
            const inferredExternalRef = objectStorageMirror?.managedWorkspaceExternalRef(input.rootPath, "project", config.paths);
            const persisted = await workspaceRepository.upsert({
              ...discovered,
              name: input.name ?? existing?.name ?? discovered.name,
              createdAt: existing?.createdAt ?? discovered.createdAt,
              externalRef: input.externalRef ?? existing?.externalRef ?? inferredExternalRef,
              ...(input.serviceName ? { serviceName: input.serviceName } : existing?.serviceName ? { serviceName: existing.serviceName } : {})
            });
            return runtimeService.getWorkspace(persisted.id);
          }
        }
      : {}),
    ...(redisWorkspacePlacementRegistry
      ? {
          assignWorkspacePlacementUser: async (input: {
            workspaceId: string;
            userId: string;
            overwrite?: boolean | undefined;
          }) => {
            await redisWorkspacePlacementRegistry.assignUser(input.workspaceId, input.userId, {
              overwrite: input.overwrite,
              updatedAt: new Date().toISOString()
            });
          }
        }
      : {}),
    ...(redisWorkspaceLeaseRegistry
      ? {
          resolveWorkspaceOwnership: async (workspaceId: string) => {
            const lease = await redisWorkspaceLeaseRegistry.getByWorkspaceId?.(workspaceId);
            return lease
              ? {
                  workspaceId: lease.workspaceId,
                  version: lease.version,
                  ownerWorkerId: lease.ownerWorkerId,
                  ...(lease.ownerBaseUrl ? { ownerBaseUrl: lease.ownerBaseUrl } : {}),
                  health: lease.health,
                  lastActivityAt: lease.lastActivityAt,
                  localPath: lease.localPath,
                  ...(lease.remotePrefix ? { remotePrefix: lease.remotePrefix } : {}),
                  isLocalOwner: lease.ownerWorkerId === currentWorkerId
                }
              : undefined;
          }
        }
      : {}),
    storageAdmin,
    ...(sandboxHost ? { sandboxHostProviderKind: sandboxHost.providerKind } : {}),
    appendRuntimeLog(input) {
      return appendRuntimeLogEvent(primarySessionEventStore, {
        ...input,
        timestamp: new Date().toISOString()
      });
    },
    async healthReport() {
      const workerStatus = await workerRuntime.getStatus();
      const materializationDiagnostics = sandboxHost?.diagnostics().materialization;
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
          primary: primaryStorageMode,
          events: redisBus ? "redis" : "memory",
          runQueue: redisRunQueue ? "redis" : "in_process"
        },
        process: runtimeProcess,
        checks,
        worker: {
          ...workerStatus,
          ...(materializationDiagnostics ? { materialization: materializationDiagnostics } : {})
        }
      };
    },
    async readinessReport() {
      const workerStatus = await workerRuntime.getStatus();
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck()
      };

      return {
        status: workerStatus.draining || Object.values(checks).includes("down") ? "not_ready" : "ready",
        ...(workerStatus.draining ? { reason: "draining" as const, draining: true } : {}),
        ...(!workerStatus.draining && Object.values(checks).includes("down") ? { reason: "checks_down" as const } : {}),
        checks
      };
    },
    async beginDrain() {
      if (workspaceMaterializationMaintenanceTimer) {
        clearInterval(workspaceMaterializationMaintenanceTimer);
        workspaceMaterializationMaintenanceTimer = undefined;
      }
      await sandboxHost?.beginDrain();
      await workerRuntime.beginDrain();
    },
    async close() {
      await Promise.all([
        workerRuntime.close(),
        storageAdmin.close(),
        redisBus?.close() ?? Promise.resolve(),
        redisWorkerRegistry?.close() ?? Promise.resolve(),
        redisWorkspaceLeaseRegistry?.close() ?? Promise.resolve(),
        redisWorkspacePlacementRegistry?.close() ?? Promise.resolve(),
        redisRunQueue?.close() ?? Promise.resolve()
      ]);
      await sandboxHost?.close();
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
      if (workspaceMaterializationMaintenanceTimer) {
        clearInterval(workspaceMaterializationMaintenanceTimer);
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

export function installSignalHandlers(options: { close: () => Promise<void>; beginDrain?: (() => Promise<void>) | undefined }): void {
  let closing: Promise<void> | undefined;

  const shutdown = () => {
    if (!closing) {
      closing = (async () => {
        try {
          await options.beginDrain?.();
          await options.close();
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        }
      })();
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
