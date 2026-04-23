import path from "node:path";
import type { FSWatcher } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";

import {
  platformModelSnapshotSchema,
  type DistributedPlatformModelRefreshResult,
  type HealthReport,
  type ReadinessReport
} from "@oah/api-contracts";
import {
  deleteWorkspaceRuntime,
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromRuntime,
  listWorkspaceRuntimes,
  loadServerConfig,
  resolveWorkspaceCreationRoot,
  uploadWorkspaceRuntime
} from "@oah/config";
import type { ServerConfig } from "@oah/config";
import {
  AppError,
  ControlPlaneEngineService,
  ExecutionEngineService,
  EngineService,
  createId
} from "@oah/engine-core";
import type {
  ControlPlaneRuntimeOperations,
  ExecutionRuntimeOperations,
  EngineLogger,
  SandboxHostProviderKind,
  WorkspacePrewarmer,
  WorkspaceRecord
} from "@oah/engine-core";
import { AiSdkModelGateway } from "@oah/model-gateway";
import { createSQLiteRuntimePersistence } from "@oah/storage-sqlite";
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
import { describeSandboxTopology } from "./sandbox-topology.js";
import {
  createWorkerRuntimeControl,
  summarizeWorkerRuntimeStatus,
  type WorkerRuntimeStatus
} from "./bootstrap/worker-runtime.js";
import {
  createDirectoryObjectStore,
  deleteWorkspaceExternalRefFromObjectStore,
  ObjectStorageMirrorController,
  seedWorkspaceRootToExternalRef
} from "./object-storage.js";
import { appendEngineLogEvent, buildRuntimeConsoleLogger } from "./engine-console.js";
import { createSandboxBackedWorkspaceInitializer } from "./bootstrap/sandbox-backed-workspace-initializer.js";
import {
  describeObjectStoragePolicy,
  objectStorageBacksManagedWorkspaces,
  resolveManagedWorkspaceExternalRef,
  resolveObjectStorageMirrorConfig
} from "./bootstrap/object-storage-policy.js";
import {
  createEngineAdminCapabilities,
  type EngineAdminCapabilities
} from "./bootstrap/admin-capabilities.js";
import {
  createPlatformModelCatalogService,
  type PlatformModelSnapshot
} from "./bootstrap/platform-model-service.js";
import { enrichWorkspaceModelsWithDiscoveredMetadata } from "./bootstrap/model-metadata-discovery.js";
import {
  buildSingleWorkspaceConfig,
  describeEngineProcess,
  type EngineProcessDescriptor,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldStartEmbeddedWorker
} from "./bootstrap/engine-process.js";
import {
  describeQueuedRunWithScopedVisibility,
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
import { createStorageAdmin } from "./storage-admin.js";
import { createServiceRoutedPostgresRuntimePersistence } from "./bootstrap/service-routed-postgres.js";
import {
  cleanupWorkspaceLocalArtifacts,
  resolveArchiveExportRoot,
  resolveRuntimeStateDir,
  resolveSqliteShadowRoot,
  resolveWorkspaceMaterializationCacheRoot,
  type WorkspaceLocalArtifactCleanupStatus
} from "./bootstrap/engine-state-paths.js";

export { cleanupWorkspaceLocalArtifacts } from "./bootstrap/engine-state-paths.js";
export type { WorkspaceLocalArtifactCleanupStatus } from "./bootstrap/engine-state-paths.js";

function hasRemoteErrorCode(error: unknown, code: string): boolean {
  if (error instanceof AppError) {
    return error.code === code;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  try {
    const payload = JSON.parse(error.message) as {
      error?: {
        code?: unknown;
      };
    };
    return payload.error?.code === code;
  } catch {
    return false;
  }
}

async function clearWorkspaceRootContents(input: {
  sandboxHost: SandboxHost;
  workspace: WorkspaceRecord;
}): Promise<void> {
  let lease: Awaited<ReturnType<typeof input.sandboxHost.workspaceFileAccessProvider.acquire>> | undefined;

  try {
    lease = await input.sandboxHost.workspaceFileAccessProvider.acquire({
      workspace: input.workspace,
      access: "write"
    });
    const rootPath = lease.workspace.rootPath;
    const entries = await input.sandboxHost.workspaceFileSystem.readdir(rootPath);
    console.info(
      `[oah-bootstrap] Clearing sandbox workspace root for ${input.workspace.id} at ${rootPath} (${entries.length} top-level entr${
        entries.length === 1 ? "y" : "ies"
      })`
    );
    await Promise.all(
      entries.map((entry) =>
        input.sandboxHost.workspaceFileSystem.rm(path.posix.join(rootPath, entry.name), {
          recursive: true,
          force: true
        })
      )
    );
    console.info(`[oah-bootstrap] Cleared sandbox workspace root contents for ${input.workspace.id} at ${rootPath}`);
  } catch (error) {
    if (hasRemoteErrorCode(error, "workspace_not_found")) {
      console.warn(
        `[oah-bootstrap] Remote sandbox cleanup skipped for ${input.workspace.id}; workspace was already missing during deletion`
      );
      return;
    }
    throw error;
  } finally {
    await lease?.release();
  }
}

function selectPlacementPreferredWorkerId(placement: {
  state?: "unassigned" | "active" | "idle" | "draining" | "evicted" | undefined;
  ownerId?: string | undefined;
  ownerWorkerId?: string | undefined;
  preferredWorkerId?: string | undefined;
} | null | undefined): string | undefined {
  const ownerId = placement?.ownerId?.trim();
  if (!ownerId) {
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
        ownerId?: string | undefined;
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
  describeEngineProcess,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldStartEmbeddedWorker,
  shouldStartInlineWorker
} from "./bootstrap/engine-process.js";
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

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  return fallback;
}

export function resolveObjectStorageMirrorBlockingInit(): boolean {
  const latencyFirst = parseBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false);
  return parseBooleanEnv("OAH_OBJECT_STORAGE_MIRROR_BLOCKING_INIT", !latencyFirst);
}

export function resolveWorkspacePrewarmConfig(): { enabled: boolean; delayMs: number; coalesceWindowMs: number } {
  const latencyFirst = parseBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false);
  return {
    enabled: parseBooleanEnv("OAH_WORKSPACE_PREWARM_ENABLED", true),
    delayMs: parseNonNegativeIntEnv("OAH_WORKSPACE_PREWARM_DELAY_MS", latencyFirst ? 250 : 0),
    coalesceWindowMs: parseNonNegativeIntEnv("OAH_WORKSPACE_PREWARM_COALESCE_MS", latencyFirst ? 1_000 : 0)
  };
}

export function resolveWorkspaceMaterializationConfig(
  config: Pick<ServerConfig, "workspace">
): { idleTtlMs: number; maintenanceIntervalMs: number } {
  return {
    idleTtlMs: parsePositiveIntEnv(
      "OAH_WORKSPACE_MATERIALIZATION_IDLE_TTL_MS",
      config.workspace?.materialization?.idle_ttl_ms ?? 1_800_000
    ),
    maintenanceIntervalMs: parsePositiveIntEnv(
      "OAH_WORKSPACE_MATERIALIZATION_MAINTENANCE_INTERVAL_MS",
      config.workspace?.materialization?.maintenance_interval_ms ?? 5_000
    )
  };
}

export function resolveWorkspaceRegistryPollingConfig(): { enabled: boolean; intervalMs: number } {
  const latencyFirst = parseBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false);
  const intervalMs = parseNonNegativeIntEnv(
    "OAH_WORKSPACE_REGISTRY_POLL_INTERVAL_MS",
    latencyFirst ? 2_000 : 15_000
  );
  return {
    enabled: intervalMs > 0,
    intervalMs
  };
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
  if (workspace.externalRef) {
    return workspace;
  }

  const externalRef =
    resolveManagedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config) ??
    objectStorageMirror?.managedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config.paths);
  return externalRef ? { ...workspace, externalRef } : workspace;
}

export interface BootstrappedRuntime {
  config: Awaited<ReturnType<typeof loadServerConfig>>;
  controlPlaneEngineService: ControlPlaneRuntimeOperations;
  executionEngineService: ExecutionRuntimeOperations;
  runtimeService: EngineService;
  modelGateway: AiSdkModelGateway;
  process: EngineProcessDescriptor;
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
  listWorkspaceRuntimes?: () => Promise<Array<{ name: string }>>;
  uploadWorkspaceRuntime?: (input: {
    runtimeName: string;
    zipBuffer: Buffer;
    overwrite?: boolean | undefined;
  }) => Promise<{ name: string }>;
  deleteWorkspaceRuntime?: (input: { runtimeName: string }) => Promise<void>;
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
  refreshPlatformModels?: () => Promise<PlatformModelSnapshot>;
  refreshDistributedPlatformModels?: () => Promise<DistributedPlatformModelRefreshResult>;
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
  clearWorkspaceCoordination?: (workspaceId: string) => Promise<void>;
  adminCapabilities: EngineAdminCapabilities;
  sandboxHostProviderKind?: SandboxHostProviderKind | undefined;
  localOwnerBaseUrl?: string | undefined;
  appendEngineLog(input: {
    sessionId: string;
    runId?: string | undefined;
    level: "debug" | "info" | "warn" | "error";
    category: "run" | "model" | "tool" | "hook" | "agent" | "http" | "system";
    message: string;
    details?: unknown;
    context?: import("@oah/api-contracts").EngineLogEventContext | undefined;
  }): Promise<void>;
  healthReport(): Promise<HealthReport>;
  readinessReport(): Promise<ReadinessReport>;
  beginDrain(): Promise<void>;
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

function isRemoteSandboxProvider(config: Pick<ServerConfig, "sandbox">): boolean {
  const provider = config.sandbox?.provider ?? (config.sandbox?.self_hosted?.base_url?.trim() ? "self_hosted" : "embedded");
  return provider === "self_hosted" || provider === "e2b";
}

export interface RuntimeAssemblyProfile {
  id: "api_control_plane" | "api_embedded_runtime" | "worker_executor";
  executionServicesMode: "eager" | "lazy";
  enablePlatformModelLiveReload: boolean;
  enableWorkerRuntime: boolean;
}

export function resolveRuntimeAssemblyProfile(options: {
  processKind: "api" | "worker";
  startWorker: boolean;
  remoteSandboxProvider: boolean;
}): RuntimeAssemblyProfile {
  if (options.processKind === "worker") {
    return {
      id: "worker_executor",
      executionServicesMode: "eager",
      enablePlatformModelLiveReload: false,
      enableWorkerRuntime: true
    };
  }

  if (!options.startWorker && options.remoteSandboxProvider) {
    return {
      id: "api_control_plane",
      executionServicesMode: "lazy",
      enablePlatformModelLiveReload: false,
      enableWorkerRuntime: false
    };
  }

  return {
    id: "api_embedded_runtime",
    executionServicesMode: "eager",
    enablePlatformModelLiveReload: false,
    enableWorkerRuntime: true
  };
}

export function shouldManageWorkspaceRegistry(options: {
  processKind: "api" | "worker";
  hasSingleWorkspace: boolean;
  remoteSandboxProvider: boolean;
}): boolean {
  return options.processKind !== "worker" && !options.hasSingleWorkspace && !options.remoteSandboxProvider;
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

export function createWorkspacePrewarmer(options: {
  sandboxHost: SandboxHost;
  getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord>;
  delayMs?: number | undefined;
  coalesceWindowMs?: number | undefined;
}): WorkspacePrewarmer {
  const inFlightByWorkspaceId = new Map<string, Promise<void>>();
  const lastCompletedAtByWorkspaceId = new Map<string, number>();

  return {
    async prewarmWorkspace(workspaceId: string): Promise<void> {
      const normalizedWorkspaceId = workspaceId.trim();
      if (normalizedWorkspaceId.length === 0) {
        return;
      }

      const coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? 0);
      const lastCompletedAt = lastCompletedAtByWorkspaceId.get(normalizedWorkspaceId);
      if (
        coalesceWindowMs > 0 &&
        typeof lastCompletedAt === "number" &&
        Date.now() - lastCompletedAt < coalesceWindowMs
      ) {
        return;
      }

      const existingTask = inFlightByWorkspaceId.get(normalizedWorkspaceId);
      if (existingTask) {
        await existingTask;
        return;
      }

      let task: Promise<void>;
      task = (async () => {
        if ((options.delayMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        const workspace = await options.getWorkspaceRecord(normalizedWorkspaceId);
        const lease = await options.sandboxHost.workspaceFileAccessProvider.acquire({
          workspace,
          access: "read"
        });
        await lease.release();
        lastCompletedAtByWorkspaceId.set(normalizedWorkspaceId, Date.now());
      })().finally(() => {
        if (inFlightByWorkspaceId.get(normalizedWorkspaceId) === task) {
          inFlightByWorkspaceId.delete(normalizedWorkspaceId);
        }
      });

      inFlightByWorkspaceId.set(normalizedWorkspaceId, task);
      await task;
    }
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
  const remoteSandboxProvider = isRemoteSandboxProvider(config);
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
  const objectStorageMirror = objectStorageMirrorConfig
    ? (objectStorageMirrorConfig.managed_paths?.length ?? 0) > 0
      ? new ObjectStorageMirrorController(objectStorageMirrorConfig, config.paths, (message) => {
        console.info(`[oah-object-storage] ${message}`);
      })
      : undefined
    : undefined;
  const ownerBaseUrl = resolveInternalBaseUrl(config);
  if (objectStorageMirror) {
    const blockingMirrorInit = resolveObjectStorageMirrorBlockingInit();
    await objectStorageMirror.initialize({
      awaitInitialSync: blockingMirrorInit
    });
    if (!blockingMirrorInit) {
      console.info("[oah-object-storage] mirror initialization continues in background after readiness");
    }
  }
  let workspaceMaterializationManager: WorkspaceMaterializationManager | undefined;
  let sandboxHost: SandboxHost | undefined;
  const modelDir = config.paths.model_dir;
  const toolDir = config.paths.tool_dir;
  const workspaceDefinitionRefreshes = new Map<string, Promise<void>>();
  const logModelLoadError = (filePath: string, error: unknown): void => {
    console.error(`[oah-bootstrap] Failed to load model definition from ${filePath}; skipping entry.`, error);
  };
  const logWorkspaceDiscoveryError = (rootPath: string, kind: "project", error: unknown): void => {
    console.error(`[oah-bootstrap] Failed to discover ${kind} workspace at ${rootPath}; skipping workspace.`, error);
  };
  let modelGateway: AiSdkModelGateway | undefined;
  const platformModelService = await createPlatformModelCatalogService({
    modelDir,
    stateDir: path.join(resolveRuntimeStateDir(config.paths), "platform-models"),
    defaultModel: config.llm.default_model,
    onLoadError: ({ filePath, error }) => {
      logModelLoadError(filePath, error);
    },
    onModelsChanged: async () => {
      (modelGateway as (AiSdkModelGateway & { clearModelCache?: () => void }) | undefined)?.clearModelCache?.();
      await refreshWorkspaceDefinitionsForPlatformModels();
    }
  });
  const models = platformModelService.definitions;
  const platformAgents: PlatformAgentRegistry = {
    ...createBuiltInPlatformAgents(),
    ...(options.platformAgents ?? {})
  };
  async function discoverWorkspaceWithEnrichedModels(rootPath: string, kind: "project") {
    return enrichWorkspaceModelsWithDiscoveredMetadata(
      await discoverWorkspace(rootPath, kind, {
        platformModels: models,
        platformAgents,
        platformSkillDir: config.paths.skill_dir,
        platformToolDir: toolDir
      } as Parameters<typeof discoverWorkspace>[2])
    );
  }

  async function readLatestPathMtimeMs(targetPath: string): Promise<number | undefined> {
    const entry = await stat(targetPath).catch(() => null);
    if (!entry) {
      return undefined;
    }

    let latest = Number(entry.mtimeMs);
    if (!entry.isDirectory()) {
      return latest;
    }

    const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
    for (const child of entries) {
      const childLatest = await readLatestPathMtimeMs(path.join(targetPath, child.name));
      if (typeof childLatest === "number" && Number.isFinite(childLatest) && childLatest > latest) {
        latest = childLatest;
      }
    }

    return latest;
  }

  async function readLatestWorkspaceDefinitionMtimeMs(rootPath: string): Promise<number | undefined> {
    const candidates = [
      path.join(rootPath, "AGENTS.md"),
      path.join(rootPath, ".openharness", "settings.yaml"),
      path.join(rootPath, ".openharness", "agents"),
      path.join(rootPath, ".openharness", "actions"),
      path.join(rootPath, ".openharness", "skills"),
      path.join(rootPath, ".openharness", "tools"),
      path.join(rootPath, ".openharness", "hooks"),
      path.join(rootPath, ".openharness", "models")
    ];
    let latest: number | undefined;

    for (const candidate of candidates) {
      const candidateLatest = await readLatestPathMtimeMs(candidate);
      if (typeof candidateLatest === "number" && Number.isFinite(candidateLatest) && (latest === undefined || candidateLatest > latest)) {
        latest = candidateLatest;
      }
    }

    return latest;
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

  async function withWorkspaceDefinitionTimestamp(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
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

  async function refreshWorkspaceDefinitionIfNeeded(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (normalizedWorkspaceId.length === 0 || remoteSandboxProvider) {
      return;
    }

    const existingRefresh = workspaceDefinitionRefreshes.get(normalizedWorkspaceId);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshTask = (async () => {
      const workspace = await persistence.workspaceRepository.getById(normalizedWorkspaceId);
      if (!workspace || workspace.kind !== "project") {
        return;
      }

      const latestDefinitionMtimeMs = await readLatestWorkspaceDefinitionMtimeMs(workspace.rootPath);
      if (latestDefinitionMtimeMs === undefined) {
        return;
      }

      const currentUpdatedAtMs = Date.parse(workspace.updatedAt);
      if (Number.isFinite(currentUpdatedAtMs) && latestDefinitionMtimeMs <= currentUpdatedAtMs) {
        return;
      }

      const discovered = await discoverWorkspaceWithEnrichedModels(workspace.rootPath, workspace.kind);
      const refreshed = withManagedWorkspaceExternalRef(
        mergeRefreshedWorkspaceRecord(workspace, discovered as WorkspaceRecord, new Date(latestDefinitionMtimeMs).toISOString()),
        config,
        objectStorageMirror
      );
      await persistence.workspaceRepository.upsert(refreshed);
      visibleWorkspaceIds.add(refreshed.id);
    })().finally(() => {
      workspaceDefinitionRefreshes.delete(normalizedWorkspaceId);
    });

    workspaceDefinitionRefreshes.set(normalizedWorkspaceId, refreshTask);
    await refreshTask;
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
          await discoverWorkspaces({
            paths: config.paths,
            platformModels: models,
            platformAgents,
            onError: ({ rootPath, kind, error }: { rootPath: string; kind: "project"; error: unknown }) => {
              logWorkspaceDiscoveryError(rootPath, kind, error);
            }
          } as Parameters<typeof discoverWorkspaces>[0]).then((workspaces) =>
            Promise.all(workspaces.map((workspace) => enrichWorkspaceModelsWithDiscoveredMetadata(workspace)))
          )
        ).map((workspace) =>
          withManagedWorkspaceExternalRef(workspace as WorkspaceRecord, config, objectStorageMirror)
        );
  const postgresConfigured = Boolean(config.storage.postgres_url && config.storage.postgres_url.trim().length > 0);
  const sqliteShadowRoot = resolveSqliteShadowRoot(config.paths);
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
  workspaceMaterializationManager = !remoteSandboxProvider && config.object_storage
    ? new WorkspaceMaterializationManager({
        cacheRoot: resolveWorkspaceMaterializationCacheRoot(config.paths),
        workspaceRoot: config.paths.workspace_dir,
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
      ...(workspaceMaterializationManager ? { workspaceMaterializationManager } : {}),
      ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
      ...(redisWorkerRegistry ? { workerRegistry: redisWorkerRegistry } : {})
    });
  }
  const redisConfigured = Boolean(config.storage.redis_url && config.storage.redis_url.trim().length > 0);
  const useSandboxBackedWorkspaceInitializer =
    remoteSandboxProvider && sandboxHost && !objectStorageBacksManagedWorkspaces(config);
  const adminCapabilities = createEngineAdminCapabilities({
    storageAdmin: createStorageAdmin({
      ...("pool" in persistence ? { postgresPool: persistence.pool } : {}),
      ...(config.storage.postgres_url ? { postgresConnectionString: config.storage.postgres_url } : {}),
      redisUrl: config.storage.redis_url,
      redisAvailable: redisConfigured,
      redisEventBusEnabled: Boolean(redisBus),
      redisRunQueueEnabled: Boolean(redisRunQueue),
      ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
      archiveExportEnabled: false,
      archiveExportRoot: resolveArchiveExportRoot(config.paths)
    })
  });
  const runtimeProcess = describeEngineProcess({
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
      ? !managesWorkspaceRegistry
        ? persistedWorkspaceSnapshots
        : [
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
  const resolvedModelGateway = new AiSdkModelGateway({
    defaultModelName: config.llm.default_model,
    models,
    logger: runtimeDebugLogger
  });
  modelGateway = resolvedModelGateway;
  let workspaceRegistrySyncPromise: Promise<void> | undefined;
  let lastWorkspaceRegistrySyncAt = 0;
  let workspaceRegistryPollTimer: NodeJS.Timeout | undefined;
  let watchedProjectRoots = new Map<string, FSWatcher>();
  const rootWorkspaceWatcher =
    managesWorkspaceRegistry
      ? openFsWatcher(config.paths.workspace_dir, scheduleWorkspaceRegistrySync)
      : undefined;
  let workspaceSyncTimer: NodeJS.Timeout | undefined;
  let workspaceMaterializationMaintenanceTimer: NodeJS.Timeout | undefined;

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

  async function clearOrphanedWorkspaceCoordination(
    workspaces: Iterable<Pick<WorkspaceRecord, "id">>,
    reason: string
  ): Promise<void> {
    if (!redisWorkspaceLeaseRegistry && !redisWorkspacePlacementRegistry) {
      return;
    }

    const knownWorkspaceIds = new Set([...workspaces].map((workspace) => workspace.id));
    const orphanWorkspaceIds = new Set<string>();

    if (redisWorkspacePlacementRegistry) {
      for (const placement of await redisWorkspacePlacementRegistry.listAll()) {
        if (!knownWorkspaceIds.has(placement.workspaceId)) {
          orphanWorkspaceIds.add(placement.workspaceId);
        }
      }
    }

    if (redisWorkspaceLeaseRegistry) {
      for (const lease of await redisWorkspaceLeaseRegistry.listActive()) {
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

  reconciledWorkspaces.forEach((workspace) => {
    visibleWorkspaceIds.add(workspace.id);
  });
  await Promise.all(reconciledWorkspaces.map((workspace) => workspaceRepository.upsert(workspace)));
  await clearOrphanedWorkspaceCoordination(reconciledWorkspaces, "bootstrap");

  const syncWorkspaceRegistry =
    managesWorkspaceRegistry
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
              }).then((workspaces) =>
                Promise.all(workspaces.map((workspace) => enrichWorkspaceModelsWithDiscoveredMetadata(workspace)))
              )
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
            const latestReconciledWorkspaces = await Promise.all(
              reconcileDiscoveredWorkspaces(latestDiscoveredWorkspaces, latestPersistedWorkspaces).map(async (workspace) =>
                withManagedWorkspaceExternalRef(await withWorkspaceDefinitionTimestamp(workspace), config, objectStorageMirror)
              )
            );

            await Promise.all(latestReconciledWorkspaces.map(async (workspace) => persistence.workspaceRepository.upsert(workspace)));

            visibleWorkspaceIds.clear();
            latestReconciledWorkspaces.forEach((workspace) => {
              visibleWorkspaceIds.add(workspace.id);
            });
            await clearOrphanedWorkspaceCoordination(latestReconciledWorkspaces, "workspace_registry_sync");
            updateWatchedProjectRoots(latestReconciledWorkspaces);
            lastWorkspaceRegistrySyncAt = Date.now();
          })().finally(() => {
            workspaceRegistrySyncPromise = undefined;
          });

          return workspaceRegistrySyncPromise;
        }
      : undefined;

  function updateWatchedProjectRoots(workspaces: WorkspaceRecord[]): void {
    if (!managesWorkspaceRegistry) {
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
    if (remoteSandboxProvider) {
      return;
    }

    const currentWorkspaces = await listAllWorkspaces(persistence.workspaceRepository);
    const refreshedWorkspaces = await Promise.all(
      currentWorkspaces.map(async (workspace) => {
        try {
          const discovered = await discoverWorkspaceWithEnrichedModels(workspace.rootPath, workspace.kind);

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
    const workspaceRegistryPolling = resolveWorkspaceRegistryPollingConfig();
    await syncWorkspaceRegistry();
    if (workspaceRegistryPolling.enabled) {
      workspaceRegistryPollTimer = setInterval(() => {
        void syncWorkspaceRegistry().catch((error) => {
          console.warn("Workspace registry poll sync failed.", error);
        });
      }, workspaceRegistryPolling.intervalMs);
      workspaceRegistryPollTimer.unref?.();
    }
  }
  if (sandboxHost) {
    const workspaceMaterializationConfig = resolveWorkspaceMaterializationConfig(config);
    workspaceMaterializationMaintenanceTimer = setInterval(() => {
      const idleBefore = new Date(
        Date.now() - workspaceMaterializationConfig.idleTtlMs
      ).toISOString();
      void sandboxHost
        .maintain({ idleBefore })
        .catch((error: unknown) => {
          console.warn("Workspace materialization maintenance failed.", error);
        });
    }, workspaceMaterializationConfig.maintenanceIntervalMs);
    workspaceMaterializationMaintenanceTimer.unref?.();
  }
  const runtimeService = new EngineService({
    defaultModel: config.llm.default_model,
    modelGateway: resolvedModelGateway,
    logger: runtimeDebugLogger,
    ...(workspaceMaterializationManager
      ? {
          workspaceActivityTracker: {
            async touchWorkspace(workspaceId: string) {
              await workspaceMaterializationManager.touchWorkspaceActivity(workspaceId);
            }
          }
        }
      : {}),
    executionServicesMode: assemblyProfile.executionServicesMode,
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
    ...(singleWorkspace === undefined
      ? {
          workspaceDeletionHandler: {
            async deleteWorkspace(workspace) {
              console.info(
                `[oah-bootstrap] Deleting workspace ${workspace.id} (rootPath=${workspace.rootPath}, externalRef=${workspace.externalRef ?? "none"})`
              );

              if (remoteSandboxProvider && sandboxHost) {
                await clearWorkspaceRootContents({
                  sandboxHost,
                  workspace
                });
              } else {
                console.info(`[oah-bootstrap] No remote sandbox cleanup needed for workspace ${workspace.id}`);
              }

              const workspaceExternalRef =
                workspace.externalRef ??
                resolveManagedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config) ??
                objectStorageMirror?.managedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config.paths);
              if (config.object_storage && workspaceExternalRef) {
                console.info(
                  `[oah-object-storage] Deleting workspace backing store for ${workspace.id} using ${workspaceExternalRef}`
                );
                await deleteWorkspaceExternalRefFromObjectStore(config.object_storage, workspaceExternalRef, (message) => {
                  console.info(`[oah-object-storage] ${message}`);
                });
                console.info(`[oah-object-storage] Deleted workspace backing store for ${workspace.id}`);
              } else if (config.object_storage) {
                console.warn(
                  `[oah-object-storage] Skipping backing-store deletion for workspace ${workspace.id}; no externalRef could be resolved`
                );
              } else {
                console.info(`[oah-object-storage] No object storage configured; skipping backing-store deletion for ${workspace.id}`);
              }

              const deletedCopies = await workspaceMaterializationManager?.deleteWorkspaceCopies(workspace.id);
              const cleanup = await cleanupWorkspaceLocalArtifacts({
                workspace,
                paths: config.paths,
                sqliteShadowRoot
              });
              await clearWorkspaceCoordination(workspace.id);
              console.info(
                `[oah-bootstrap] Cleaned local artifacts for deleted workspace ${workspace.id} (${cleanup.mode}): ${cleanup.removedPaths.join(", ")}${
                  deletedCopies && deletedCopies.length > 0 ? `; evicted copies: ${deletedCopies.map((copy) => copy.localPath).join(", ")}` : ""
                }`
              );
            }
          }
        }
      : {}),
    ...(singleWorkspace === undefined
      ? {
          workspaceInitializer: {
            initialize: useSandboxBackedWorkspaceInitializer
              ? createSandboxBackedWorkspaceInitializer({
                  runtimeDir: config.paths.runtime_dir,
                  platformToolDir: config.paths.tool_dir,
                  platformSkillDir: config.paths.skill_dir,
                  toolDir,
                  platformModels: models,
                  platformAgents,
                  sandboxHost: sandboxHost!,
                  ...(sandboxHost?.providerKind === "self_hosted" && config.sandbox?.self_hosted?.base_url?.trim()
                    ? {
                        selfHosted: {
                          baseUrl: config.sandbox.self_hosted.base_url.trim(),
                          headers: config.sandbox.self_hosted.headers
                        }
                      }
                    : {})
                }).initialize
              : async (input) => {
                  const workspaceId = (
                    input as typeof input & {
                      workspaceId?: string | undefined;
                    }
                  ).workspaceId?.trim() || createId("ws");
                  const workspaceRoot = resolveWorkspaceCreationRoot({
                    workspaceDir: config.paths.workspace_dir,
                    name: input.name,
                    workspaceId,
                    rootPath: input.rootPath
                  });

                  await initializeWorkspaceFromRuntime(
                    {
                      runtimeDir: config.paths.runtime_dir,
                      runtimeName: input.runtime,
                      rootPath: workspaceRoot,
                      platformToolDir: config.paths.tool_dir,
                      platformSkillDir: config.paths.skill_dir,
                      agentsMd: input.agentsMd,
                      toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
                      skills: input.skills
                    } as Parameters<typeof initializeWorkspaceFromRuntime>[0]
                  );

                  const inferredExternalRef = resolveManagedWorkspaceExternalRef(workspaceRoot, "project", config);
                  if (config.object_storage && inferredExternalRef) {
                    await seedWorkspaceRootToExternalRef(
                      config.object_storage,
                      inferredExternalRef,
                      workspaceRoot,
                      (message) => {
                        console.info(`[oah-object-storage] ${message}`);
                      }
                    );
                  }

                  const discovered = await discoverWorkspaceWithEnrichedModels(workspaceRoot, "project");

                  return {
                    ...discovered,
                    id: workspaceId,
                    ...(inferredExternalRef ? { externalRef: inferredExternalRef } : {})
                  } as WorkspaceRecord;
                }
          }
        }
      : {})
  });
  const workspacePrewarmConfig = resolveWorkspacePrewarmConfig();
  const workspacePrewarmer = sandboxHost
    ? workspacePrewarmConfig.enabled
      ? createWorkspacePrewarmer({
          sandboxHost,
          getWorkspaceRecord: (workspaceId: string) => runtimeService.getWorkspaceRecord(workspaceId),
          delayMs: workspacePrewarmConfig.delayMs,
          coalesceWindowMs: workspacePrewarmConfig.coalesceWindowMs
        })
      : undefined
    : undefined;
  const controlPlaneEngineService = new ControlPlaneEngineService(runtimeService, {
    workspaceDefinitionRefresher: {
      async refreshWorkspaceDefinition(workspaceId: string) {
        await refreshWorkspaceDefinitionIfNeeded(workspaceId);
      }
    },
    ...(workspaceMaterializationManager
      ? {
          workspaceActivityTracker: {
            async touchWorkspace(workspaceId: string) {
              await workspaceMaterializationManager.touchWorkspaceActivity(workspaceId);
            }
          }
        }
      : {}),
    ...(workspacePrewarmer ? { workspacePrewarmer } : {}),
    ...(runtimeDebugLogger ? { logger: runtimeDebugLogger } : {})
  });
  const executionEngineService = new ExecutionEngineService(runtimeService);
  const workerRuntime = assemblyProfile.enableWorkerRuntime
    ? createWorkerRuntimeControl({
        startWorker,
        processKind,
        runtimeInstanceId,
        ownerBaseUrl,
        config,
        redisRunQueue,
        redisWorkerRegistry,
        runtimeService: executionEngineService,
        describeQueuedRun: (runId) =>
          describeQueuedRunWithScopedVisibility(persistence.runRepository, visibleWorkspaceIds, runId),
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
  workerRuntime?.start();
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

  async function getWorkerStatus(): Promise<WorkerRuntimeStatus> {
    if (workerRuntime) {
      return workerRuntime.getStatus();
    }

    return summarizeWorkerRuntimeStatus({
      mode: "disabled",
      activeWorkers: [],
      pool: null
    });
  }

  async function refreshDistributedPlatformModels(): Promise<DistributedPlatformModelRefreshResult> {
    const snapshot = await platformModelService.refresh();
    const activeWorkers =
      redisWorkerRegistry && typeof redisWorkerRegistry.listActive === "function"
        ? await redisWorkerRegistry.listActive()
        : [];
    const localBaseUrl = ownerBaseUrl?.replace(/\/+$/u, "");
    const remoteTargets = new Map<string, { workerId: string; runtimeInstanceId?: string; ownerBaseUrl: string }>();

    for (const entry of activeWorkers) {
      const targetBaseUrl = entry.ownerBaseUrl?.trim().replace(/\/+$/u, "");
      if (!targetBaseUrl) {
        continue;
      }
      if (entry.runtimeInstanceId === runtimeInstanceId) {
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

  return {
    config,
    controlPlaneEngineService,
    executionEngineService,
    runtimeService,
    modelGateway: resolvedModelGateway,
    process: runtimeProcess,
    workspaceMode,
    listPlatformModels: () => platformModelService.listModels(),
    getPlatformModelSnapshot: () => platformModelService.getSnapshot(),
    refreshPlatformModels: () => platformModelService.refresh(),
    refreshDistributedPlatformModels,
    subscribePlatformModelSnapshot: (listener) => platformModelService.subscribe(listener),
    ...(singleWorkspace === undefined
      ? {
          listWorkspaceRuntimes: () => listWorkspaceRuntimes(config.paths.runtime_dir),
          uploadWorkspaceRuntime: (input: { runtimeName: string; zipBuffer: Buffer; overwrite?: boolean | undefined }) =>
            uploadWorkspaceRuntime({
              runtimeDir: config.paths.runtime_dir,
              runtimeName: input.runtimeName,
              zipBuffer: input.zipBuffer,
              ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {})
            }),
          deleteWorkspaceRuntime: (input: { runtimeName: string }) =>
            deleteWorkspaceRuntime({
              runtimeDir: config.paths.runtime_dir,
              runtimeName: input.runtimeName
            }),
          ...(!remoteSandboxProvider
            ? {
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

                  const discovered = await discoverWorkspaceWithEnrichedModels(input.rootPath, "project");
                  const existing = await workspaceRepository.getById(discovered.id);
                  const inferredExternalRef =
                    resolveManagedWorkspaceExternalRef(input.rootPath, "project", config) ??
                    objectStorageMirror?.managedWorkspaceExternalRef(input.rootPath, "project", config.paths);
                  const persisted = await workspaceRepository.upsert({
                    ...discovered,
                    name: input.name ?? existing?.name ?? discovered.name,
                    createdAt: existing?.createdAt ?? discovered.createdAt,
                    externalRef: input.externalRef ?? existing?.externalRef ?? inferredExternalRef,
                    ...(input.ownerId
                      ? { ownerId: input.ownerId }
                      : existing?.ownerId
                        ? { ownerId: existing.ownerId }
                        : {}),
                    ...(input.serviceName
                      ? { serviceName: input.serviceName }
                      : existing?.serviceName
                        ? { serviceName: existing.serviceName }
                        : {})
                  });
                  return runtimeService.getWorkspace(persisted.id);
                }
              }
            : {})
        }
      : {}),
    ...(redisWorkspacePlacementRegistry
      ? {
          assignWorkspacePlacementOwnerAffinity: async (input: {
            workspaceId: string;
            ownerId: string;
            overwrite?: boolean | undefined;
          }) => {
            await redisWorkspacePlacementRegistry.assignOwnerAffinity(input.workspaceId, input.ownerId, {
              overwrite: input.overwrite,
              updatedAt: new Date().toISOString()
            });
          },
          releaseWorkspacePlacement: async (input: {
            workspaceId: string;
            state?: "unassigned" | "draining" | "evicted" | undefined;
          }) => {
            await redisWorkspacePlacementRegistry.releaseOwnership(input.workspaceId, {
              state: input.state ?? "evicted",
              updatedAt: new Date().toISOString()
            });
          }
        }
      : {}),
    ...((redisWorkspaceLeaseRegistry || redisWorkspacePlacementRegistry)
      ? {
          clearWorkspaceCoordination
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
    adminCapabilities,
    ...(sandboxHost ? { sandboxHostProviderKind: sandboxHost.providerKind } : {}),
    ...(ownerBaseUrl ? { localOwnerBaseUrl: ownerBaseUrl } : {}),
    appendEngineLog(input) {
      return appendEngineLogEvent(primarySessionEventStore, {
        ...input,
        timestamp: new Date().toISOString()
      });
    },
    async healthReport() {
      const workerStatus = await getWorkerStatus();
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
        sandbox: describeSandboxTopology(sandboxHost?.providerKind),
        checks,
        worker: {
          ...workerStatus,
          ...(materializationDiagnostics ? { materialization: materializationDiagnostics } : {})
        }
      };
    },
    async readinessReport() {
      const workerStatus = await getWorkerStatus();
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
      await workerRuntime?.beginDrain();
    },
    async close() {
      await Promise.all([
        workerRuntime?.close() ?? Promise.resolve(),
        adminCapabilities.close(),
        redisBus?.close() ?? Promise.resolve(),
        redisWorkerRegistry?.close() ?? Promise.resolve(),
        redisWorkspaceLeaseRegistry?.close() ?? Promise.resolve(),
        redisWorkspacePlacementRegistry?.close() ?? Promise.resolve(),
        redisRunQueue?.close() ?? Promise.resolve()
      ]);
      await sandboxHost?.close();
      await closePersistence();
      await objectStorageMirror?.close();
      await platformModelService.close();
      if (workspaceSyncTimer) {
        clearTimeout(workspaceSyncTimer);
      }
      if (workspaceRegistryPollTimer) {
        clearInterval(workspaceRegistryPollTimer);
      }
      if (workspaceMaterializationMaintenanceTimer) {
        clearInterval(workspaceMaterializationMaintenanceTimer);
      }
      rootWorkspaceWatcher?.close();
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
