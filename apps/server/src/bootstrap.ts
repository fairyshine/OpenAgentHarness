import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";

import {
  platformModelSnapshotSchema,
  type DistributedPlatformModelRefreshResult,
  type HealthReport,
  type ReadinessReport
} from "@oah/api-contracts";
import type { ServerConfig } from "@oah/config";
import type {
  EngineLogger,
  ModelGateway,
  SandboxHostProviderKind,
  WorkspacePrewarmer,
  WorkspaceRecord
} from "../../../packages/engine-core/src/types.js";
import { AppError } from "../../../packages/engine-core/src/errors.js";
import { ExecutionEngineService, type ExecutionRuntimeOperations } from "../../../packages/engine-core/src/execution-engine-service.js";
import { EngineService } from "../../../packages/engine-core/src/engine-service.js";
import { createId, nowIso } from "../../../packages/engine-core/src/utils.js";
import type { ControlPlaneRuntimeOperations } from "../../../packages/engine-core/src/control-plane-engine-service.js";
import type { WorkspaceMaterializationManager } from "./bootstrap/workspace-materialization.js";
import type { SandboxHost } from "./bootstrap/sandbox-host.js";
import { LazyModelRuntime } from "./bootstrap/lazy-model-runtime.js";
import { createLazyStorageAdmin } from "./bootstrap/lazy-storage-admin.js";
import { describeSandboxTopology } from "./sandbox-topology.js";
import type { WorkerRuntimeStatus } from "./bootstrap/worker-runtime.js";
import { appendEngineLogEvent, buildRuntimeConsoleLogger } from "./engine-console.js";
import {
  describeObjectStoragePolicy,
  objectStorageBacksManagedWorkspaces,
  resolveManagedWorkspaceExternalRef,
  resolveObjectStorageMirrorConfig
} from "./bootstrap/object-storage-policy.js";
import type { EngineAdminCapabilities } from "./bootstrap/admin-capabilities.js";
import {
  createPlatformModelCatalogService,
  type PlatformModelSnapshot
} from "./bootstrap/platform-model-service.js";
import {
  buildSingleWorkspaceConfig,
  describeEngineProcess,
  formatSingleWorkspaceLegacyWarning,
  type EngineProcessDescriptor,
  parseConfigPath,
  parseSingleWorkspaceOptions,
  shouldStartEmbeddedWorker
} from "./bootstrap/engine-process.js";
import type { PlatformAgentRegistry } from "./bootstrap/workspace-registry.js";
import {
  cleanupWorkspaceLocalArtifacts,
  resolveArchiveExportRoot,
  resolvePostgresArchivePayloadRoot,
  resolveRuntimeStateDir,
  resolveSqliteShadowRoot,
  resolveWorkspaceMaterializationCacheRoot,
  type WorkspaceLocalArtifactCleanupStatus
} from "./bootstrap/engine-state-paths.js";
import {
  parseBooleanEnv,
  parseNonNegativeIntEnv,
  parseOptionalPositiveIntEnv,
  parsePositiveIntEnv,
  parsePositiveIntEnvWithMin,
  resolveObjectStorageMirrorBlockingInit,
  resolveWorkspaceMaterializationConfig,
  resolveWorkspacePrewarmConfig,
  resolveWorkspaceRegistryPollingConfig
} from "./bootstrap/bootstrap-config.js";
import { evaluateWorkerDiskReadiness } from "./bootstrap/worker-disk-readiness.js";
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
  loadSandboxHostModule,
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

export { cleanupWorkspaceLocalArtifacts } from "./bootstrap/engine-state-paths.js";
export type { WorkspaceLocalArtifactCleanupStatus } from "./bootstrap/engine-state-paths.js";
export {
  resolveObjectStorageMirrorBlockingInit,
  resolveWorkspaceMaterializationConfig,
  resolveWorkspacePrewarmConfig
} from "./bootstrap/bootstrap-config.js";

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

export { createPlacementAwareSessionRunQueue } from "./bootstrap/placement-aware-session-run-queue.js";

function ownerBaseUrlMatches(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = left?.trim().replace(/\/+$/u, "");
  const normalizedRight = right?.trim().replace(/\/+$/u, "");
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
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

export interface BootstrapOptions {
  argv?: string[] | undefined;
  startWorker?: boolean | undefined;
  processKind?: "api" | "worker" | undefined;
  platformAgents?: PlatformAgentRegistry | undefined;
      sandboxHostFactory?:
    | ((input: {
        config: ServerConfig;
        processKind: "api" | "worker";
        workerId: string;
        ownerBaseUrl?: string | undefined;
        workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
      }) => Promise<SandboxHost | undefined> | SandboxHost | undefined)
    | undefined;
}

export function resolveRuntimeUploadCacheDir(paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">): string {
  return resolveRuntimeUploadCacheDirs(paths)[0]!;
}

function resolveRuntimeUploadCacheDirs(paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">): string[] {
  const assetRoot = process.env.OAH_DEPLOY_ROOT?.trim() || process.env.OAH_HOME?.trim();
  const candidates = [
    ...(process.env.OAH_DEPLOY_ROOT?.trim() ? [path.join(path.resolve(process.env.OAH_DEPLOY_ROOT.trim()), "runtimes")] : []),
    ...(process.env.OAH_HOME?.trim() ? [path.join(path.resolve(process.env.OAH_HOME.trim()), "runtimes")] : []),
    path.join(resolveRuntimeStateDir(paths), "runtimes")
  ];

  if (assetRoot) {
    return [...new Set(candidates)];
  }

  return [path.join(resolveRuntimeStateDir(paths), "runtimes")];
}

async function prepareRuntimeUploadCacheDir(paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">): Promise<string> {
  let lastError: unknown;
  for (const candidate of resolveRuntimeUploadCacheDirs(paths)) {
    try {
      await mkdir(candidate, { recursive: true });
      await access(candidate, fsConstants.W_OK);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to prepare a writable runtime upload cache directory: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function pathExistsForBootstrap(targetPath: string): Promise<boolean> {
  return stat(targetPath)
    .then(() => true)
    .catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

async function runtimeExistsInUploadCache(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">,
  runtimeName: string
): Promise<boolean> {
  for (const runtimeCacheDir of resolveRuntimeUploadCacheDirs(paths)) {
    if (await pathExistsForBootstrap(path.join(runtimeCacheDir, runtimeName))) {
      return true;
    }
  }

  return false;
}

async function removeRuntimeFromUploadCaches(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">,
  runtimeName: string
): Promise<void> {
  await Promise.all(
    resolveRuntimeUploadCacheDirs(paths).map(async (runtimeCacheDir) => {
      await rm(path.join(runtimeCacheDir, runtimeName), { recursive: true, force: true });
    })
  );
}

async function resolveRuntimeSourceDirForBootstrap(
  runtimeName: string,
  paths: Pick<ServerConfig["paths"], "runtime_dir" | "workspace_dir" | "runtime_state_dir">,
  useRuntimeUploadCache: boolean,
  objectStorage: ServerConfig["object_storage"] | undefined,
  objectStorageModule: typeof import("./object-storage.js") | undefined
): Promise<string> {
  if (useRuntimeUploadCache) {
    for (const runtimeCacheDir of resolveRuntimeUploadCacheDirs(paths)) {
      if (await pathExistsForBootstrap(path.join(runtimeCacheDir, runtimeName))) {
        return runtimeCacheDir;
      }
    }
  }

  if (objectStorage) {
    const runtimeCacheDir = await prepareRuntimeUploadCacheDir(paths);
    const runtimeCacheTarget = path.join(runtimeCacheDir, runtimeName);
    await objectStorageModule!.syncRuntimeDirectoryFromObjectStore(objectStorage, runtimeName, runtimeCacheTarget, (message) => {
      console.info(`[oah-object-storage] ${message}`);
    });
    return runtimeCacheDir;
  }

  return paths.runtime_dir;
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

function workerRegistryMatchesPlacementOwner(
  worker: { workerId: string; runtimeInstanceId?: string | undefined },
  ownerWorkerId: string
): boolean {
  return worker.workerId === ownerWorkerId || worker.runtimeInstanceId === ownerWorkerId;
}

function withManagedWorkspaceExternalRef(
  workspace: WorkspaceRecord,
  config: ServerConfig,
  objectStorageMirror: import("./object-storage.js").ObjectStorageMirrorController | undefined
): WorkspaceRecord {
  if (workspace.externalRef) {
    return workspace;
  }

  const externalRef =
    resolveManagedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config) ??
    objectStorageMirror?.managedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config.paths);
  return externalRef ? { ...workspace, externalRef } : workspace;
}

async function resolveLocalWorkspaceRoot(rootPath: string): Promise<string> {
  const resolvedRoot = path.resolve(rootPath);
  let info;
  try {
    info = await stat(resolvedRoot);
  } catch {
    throw new AppError(400, "workspace_path_not_found", `Workspace root does not exist: ${rootPath}`);
  }
  if (!info.isDirectory()) {
    throw new AppError(400, "workspace_path_not_directory", `Workspace root must be a directory: ${rootPath}`);
  }
  return realpath(resolvedRoot);
}

function localWorkspaceExternalRef(rootPath: string): string {
  return `local:path:${rootPath.replaceAll("\\", "/")}`;
}

export interface BootstrappedRuntime {
  config: ServerConfig;
  controlPlaneEngineService: ControlPlaneRuntimeOperations;
  executionEngineService: ExecutionRuntimeOperations;
  runtimeService: EngineService;
  modelGateway: ModelGateway;
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
    requireExisting?: boolean | undefined;
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
  registerLocalWorkspace?: (input: {
    rootPath: string;
    name?: string;
    runtime?: string;
    ownerId?: string;
    serviceName?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  repairLocalWorkspace?: (input: {
    workspaceId: string;
    rootPath: string;
    name?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  resolveWorkspaceOwnership?: (workspaceId: string) => Promise<{
    workspaceId: string;
    version: string;
    ownerWorkerId: string;
    ownerBaseUrl?: string | undefined;
    health: "healthy" | "late";
    lastActivityAt: string;
    localPath?: string | undefined;
    remotePrefix?: string | undefined;
    isLocalOwner: boolean;
  } | undefined>;
  clearWorkspaceCoordination?: (workspaceId: string) => Promise<void>;
  adminCapabilities?: EngineAdminCapabilities | undefined;
  sandboxHostProviderKind?: SandboxHostProviderKind | undefined;
  localOwnerBaseUrl?: string | undefined;
  touchWorkspaceActivity?: (workspaceId: string) => Promise<void>;
  workspaceLifecycle?: {
    execute(input: {
      workspaceId: string;
      operation: "hydrate" | "flush" | "evict" | "delete" | "repair_placement";
      force?: boolean | undefined;
    }): Promise<{
      workspaceId: string;
      operation: "hydrate" | "flush" | "evict" | "delete" | "repair_placement";
      status: "completed" | "not_available";
      hydrated?: unknown[] | undefined;
      flushed?: unknown[] | undefined;
      evicted?: unknown[] | undefined;
      skipped?: unknown[] | undefined;
      repaired?: unknown[] | undefined;
    }>;
  };
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

function resolvePostgresMetadataRetentionConfig(input: { processKind: "api" | "worker"; startWorker: boolean }) {
  const role = process.env.OAH_METADATA_RETENTION_ROLE?.trim().toLowerCase() || "auto";
  const processRole =
    input.processKind === "worker" ? "worker" : input.startWorker ? "embedded_worker" : "api";
  const defaultEnabled =
    role === "all" ||
    role === processRole ||
    (role === "worker" && processRole === "embedded_worker") ||
    (role === "auto" && process.env.OAH_PROCESS_ROLE?.trim().toLowerCase() === "controller");
  return {
    enabled: parseBooleanEnv("OAH_METADATA_RETENTION_ENABLED", defaultEnabled),
    intervalMs: parsePositiveIntEnv("OAH_METADATA_RETENTION_INTERVAL_MS", 60 * 60 * 1000),
    batchLimit: parsePositiveIntEnv("OAH_METADATA_RETENTION_BATCH_LIMIT", 1_000),
    historyEventRetentionDays: parseNonNegativeIntEnv("OAH_HISTORY_EVENT_RETENTION_DAYS", 7),
    sessionEventRetentionDays: parseNonNegativeIntEnv("OAH_SESSION_EVENT_RETENTION_DAYS", 14),
    runRetentionDays: parseNonNegativeIntEnv("OAH_RUN_RETENTION_DAYS", 0)
  };
}

function resolvePostgresPoolConfig(input: { processKind: "api" | "worker"; startWorker: boolean }) {
  const roleDefault =
    input.processKind === "api" && !input.startWorker
      ? 5
      : input.processKind === "worker"
        ? 3
        : 8;
  return {
    max: parsePositiveIntEnv("OAH_POSTGRES_POOL_MAX", roleDefault),
    idleTimeoutMillis: parsePositiveIntEnv("OAH_POSTGRES_POOL_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: parsePositiveIntEnv("OAH_POSTGRES_POOL_CONNECTION_TIMEOUT_MS", 5_000)
  };
}

async function resolveRedisReadyQueueDepth(input: {
  redisRunQueue: unknown;
}): Promise<number | undefined> {
  const queue = input.redisRunQueue as { readyQueueLength?: unknown; getReadySessionCount?: unknown } | undefined;
  if (typeof queue?.readyQueueLength === "function") {
    return await (queue.readyQueueLength as () => Promise<number>)();
  }
  if (typeof queue?.getReadySessionCount === "function") {
    return await (queue.getReadySessionCount as () => Promise<number>)();
  }
  return undefined;
}

function resolveRedisReadyQueueReadinessLimit(): number | undefined {
  return parseOptionalPositiveIntEnv("OAH_REDIS_READY_QUEUE_READINESS_LIMIT");
}

function isRemoteSandboxProvider(config: Pick<ServerConfig, "sandbox">): boolean {
  const provider = config.sandbox?.provider ?? (config.sandbox?.self_hosted?.base_url?.trim() ? "self_hosted" : "embedded");
  return provider === "self_hosted" || provider === "e2b";
}

function runtimeHasPersistedWorkspaceListing(
  value: unknown
): value is {
  listPersistedWorkspaces(): Promise<WorkspaceRecord[]>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listPersistedWorkspaces?: unknown }).listPersistedWorkspaces === "function"
  );
}

function runtimeHasWorkspaceSnapshotListing(
  value: unknown
): value is {
  listWorkspaceSnapshots(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listWorkspaceSnapshots?: unknown }).listWorkspaceSnapshots === "function"
  );
}

async function listRepositoryWorkspaces(
  repository: Pick<import("@oah/engine-core").WorkspaceRepository, "list">
): Promise<WorkspaceRecord[]> {
  const workspaces: WorkspaceRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await repository.list(100, cursor);
    workspaces.push(...page);
    cursor = page.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
  } while (cursor);

  return workspaces;
}

export interface RuntimeAssemblyProfile {
  id: "api_control_plane" | "api_embedded_runtime" | "worker_executor";
  executionServicesMode: "eager" | "lazy";
  enablePlatformModelLiveReload: boolean;
  enableWorkerRuntime: boolean;
  enableAdminCapabilities: boolean;
  enableControlPlaneFacade: boolean;
}

export type WorkspaceModelMetadataDiscoveryMode = "eager" | "background" | "manual";

export function resolveRuntimeAssemblyProfile(options: {
  processKind: "api" | "worker";
  startWorker: boolean;
  remoteSandboxProvider: boolean;
}): RuntimeAssemblyProfile {
  void options.remoteSandboxProvider;

  if (options.processKind === "worker") {
    return {
      id: "worker_executor",
      executionServicesMode: "lazy",
      enablePlatformModelLiveReload: false,
      enableWorkerRuntime: true,
      enableAdminCapabilities: false,
      enableControlPlaneFacade: false
    };
  }

  if (!options.startWorker) {
    return {
      id: "api_control_plane",
      executionServicesMode: "lazy",
      enablePlatformModelLiveReload: false,
      enableWorkerRuntime: false,
      enableAdminCapabilities: true,
      enableControlPlaneFacade: true
    };
  }

  return {
    id: "api_embedded_runtime",
    executionServicesMode: "eager",
    enablePlatformModelLiveReload: false,
    enableWorkerRuntime: true,
    enableAdminCapabilities: true,
    enableControlPlaneFacade: true
  };
}

function summarizeDisabledWorkerRuntimeStatus(): WorkerRuntimeStatus {
  return {
    mode: "disabled",
    draining: false,
    acceptsNewRuns: true,
    sessionSerialBoundary: "session",
    localSlots: [],
    activeWorkers: [],
    summary: {
      active: 0,
      healthy: 0,
      late: 0,
      busy: 0,
      embedded: 0,
      standalone: 0
    },
    pool: null
  };
}

export function shouldManageWorkspaceRegistry(options: {
  processKind: "api" | "worker";
  hasSingleWorkspace: boolean;
  remoteSandboxProvider: boolean;
}): boolean {
  return options.processKind !== "worker" && !options.hasSingleWorkspace && !options.remoteSandboxProvider;
}

export function resolveWorkspaceModelMetadataDiscoveryMode(options: {
  processKind: "api" | "worker";
  hasSingleWorkspace: boolean;
  managesWorkspaceRegistry: boolean;
}): WorkspaceModelMetadataDiscoveryMode {
  if (options.processKind !== "api") {
    return "eager";
  }

  if (options.hasSingleWorkspace || !options.managesWorkspaceRegistry) {
    return "eager";
  }

  // Multi-workspace API boot favors a lighter control-plane footprint. Keep
  // workspace discovery live, but only enrich workspace model metadata when a
  // refresh path explicitly needs it.
  return "manual";
}

function resolveInternalBaseUrl(
  config: Pick<ServerConfig, "server">,
  options?: { processKind?: "api" | "worker" | undefined }
): string | undefined {
  const explicit = process.env.OAH_INTERNAL_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/u, "");
  }

  const host = config.server.host.trim();
  if (!host || host === "0.0.0.0" || host === "::") {
    if (options?.processKind === "worker") {
      const hostname = process.env.HOSTNAME?.trim();
      if (hostname) {
        return `http://${hostname}:${config.server.port}`;
      }
    }
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
  const canDeferEmbeddedSandboxMaterialization =
    !remoteSandboxProvider &&
    Boolean(config.object_storage) &&
    processKind === "api" &&
    !startWorker &&
    !options.sandboxHostFactory;
  workspaceMaterializationManager = canDeferEmbeddedSandboxMaterialization
    ? undefined
    : !remoteSandboxProvider && config.object_storage
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
    if (canDeferEmbeddedSandboxMaterialization) {
      const [{ createLazySandboxHost, createMaterializationSandboxHost }, { WorkspaceMaterializationManager }] =
        await Promise.all([loadSandboxHostModule(), loadWorkspaceMaterializationModule()]);
      sandboxHost = createLazySandboxHost({
        providerKind: "embedded",
        createHost: () => {
          workspaceMaterializationManager ??= new WorkspaceMaterializationManager({
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
          return createMaterializationSandboxHost({
            materializationManager: workspaceMaterializationManager
          });
        },
        diagnostics: () => ({
          provider: "embedded",
          executionModel: "local_embedded",
          workerPlacement: "api_process",
          materialization: workspaceMaterializationManager?.diagnostics()
        })
      });
    } else {
      sandboxHost = await (await loadConfiguredSandboxHostModule()).createConfiguredSandboxHost({
        config,
        ...(workspaceMaterializationManager ? { workspaceMaterializationManager } : {}),
        ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
        ...(redisWorkerRegistry ? { workerRegistry: redisWorkerRegistry } : {})
      });
    }
  }
  const selfHostedSandboxOptions =
    sandboxHost?.providerKind === "self_hosted" && config.sandbox?.self_hosted?.base_url?.trim()
      ? {
          baseUrl: config.sandbox.self_hosted.base_url.trim(),
          headers: config.sandbox.self_hosted.headers,
          maxWorkspacesPerSandbox: config.sandbox.fleet?.max_workspaces_per_sandbox,
          resourceCpuPressureThreshold: (
            config.sandbox.fleet as { resource_cpu_pressure_threshold?: number | undefined } | undefined
          )?.resource_cpu_pressure_threshold,
          resourceMemoryPressureThreshold: (
            config.sandbox.fleet as { resource_memory_pressure_threshold?: number | undefined } | undefined
          )?.resource_memory_pressure_threshold,
          resourceDiskPressureThreshold: (
            config.sandbox.fleet as { resource_disk_pressure_threshold?: number | undefined } | undefined
          )?.resource_disk_pressure_threshold,
          ...(redisWorkspacePlacementRegistry ? { workspacePlacementRegistry: redisWorkspacePlacementRegistry } : {}),
          ...(redisWorkerRegistry ? { workerRegistry: redisWorkerRegistry } : {})
        }
      : undefined;
  const useSelfHostedWorkspaceDelegatingInitializer =
    processKind === "api" && !startWorker && remoteSandboxProvider && Boolean(selfHostedSandboxOptions);
  const useSandboxBackedWorkspaceInitializer =
    remoteSandboxProvider &&
    sandboxHost &&
    !useSelfHostedWorkspaceDelegatingInitializer &&
    !objectStorageBacksManagedWorkspaces(config);
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
  if (sandboxHost) {
    const workspaceMaterializationConfig = resolveWorkspaceMaterializationConfig(config);
    const runSandboxHostMaintenance = () => {
      const idleBefore = new Date(
        Date.now() - workspaceMaterializationConfig.idleTtlMs
      ).toISOString();
      void sandboxHost
        .maintain({ idleBefore })
        .catch((error: unknown) => {
          console.warn("Sandbox host maintenance failed.", error);
        });
    };
    runSandboxHostMaintenance();
    workspaceMaterializationMaintenanceTimer = setInterval(runSandboxHostMaintenance, workspaceMaterializationConfig.maintenanceIntervalMs);
    workspaceMaterializationMaintenanceTimer.unref?.();
  }
  const runtimeService = new EngineService({
    defaultModel: config.llm.default_model,
    modelGateway: resolvedModelGateway,
    logger: runtimeDebugLogger,
    ...((workspaceMaterializationManager || canDeferEmbeddedSandboxMaterialization)
      ? {
          workspaceActivityTracker: {
            async touchWorkspace(workspaceId: string) {
              await workspaceMaterializationManager?.touchWorkspaceActivity(workspaceId);
            }
          }
        }
      : {}),
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
    ...(singleWorkspace === undefined
      ? {
          workspaceDeletionHandler: {
            async deleteWorkspace(workspace) {
              console.info(
                `[oah-bootstrap] Deleting workspace ${workspace.id} (rootPath=${workspace.rootPath}, externalRef=${workspace.externalRef ?? "none"})`
              );

              if (useSelfHostedWorkspaceDelegatingInitializer) {
                throw new AppError(
                  409,
                  "workspace_delete_requires_worker",
                  `Workspace ${workspace.id} must be deleted by a self-hosted worker in API-only mode.`
                );
              }

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
                await objectStorageModule!.deleteWorkspaceExternalRefFromObjectStore(config.object_storage, workspaceExternalRef, (message) => {
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
            initialize: useSelfHostedWorkspaceDelegatingInitializer
              ? (await loadSandboxBackedWorkspaceInitializerModule()).createSelfHostedWorkspaceDelegatingInitializer({
                  selfHosted: selfHostedSandboxOptions!,
                  getWorkspaceRecord: async (workspaceId: string) => (await workspaceRepository.getById(workspaceId)) ?? undefined
                }).initialize
              : useSandboxBackedWorkspaceInitializer
                ? (await loadSandboxBackedWorkspaceInitializerModule()).createSandboxBackedWorkspaceInitializer({
                    runtimeDir: config.paths.runtime_dir,
                    platformToolDir: config.paths.tool_dir,
                    platformSkillDir: config.paths.skill_dir,
                    toolDir,
                    platformModels: models,
                    platformAgents: await getPlatformAgents(),
                    sandboxHost: sandboxHost!,
                    ...(selfHostedSandboxOptions ? { selfHosted: selfHostedSandboxOptions } : {})
                  }).initialize
                : async (input) => {
                  const { resolveWorkspaceCreationRoot } = await loadConfigWorkspaceModule();
                  const { initializeWorkspaceFromRuntime } = await loadConfigRuntimesModule();
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

                  const runtimeDir = await resolveRuntimeSourceDirForBootstrap(
                    input.runtime,
                    config.paths,
                    useRuntimeObjectStorageManagement,
                    config.object_storage,
                    objectStorageModule
                  );

                  await initializeWorkspaceFromRuntime(
                    {
                      runtimeDir,
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
                  const targetExternalRef = input.externalRef ?? inferredExternalRef;
                  if (config.object_storage && targetExternalRef) {
                    await objectStorageModule!.seedWorkspaceRootToExternalRef(
                      config.object_storage,
                      targetExternalRef,
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
                    ...(targetExternalRef ? { externalRef: targetExternalRef } : {})
                  } as WorkspaceRecord;
                }
          }
        }
      : {})
  });
  const workspacePrewarmConfig = resolveWorkspacePrewarmConfig();
  const touchWorkspaceActivity = workspaceMaterializationManager || canDeferEmbeddedSandboxMaterialization
    ? async (workspaceId: string) => {
        await workspaceMaterializationManager?.touchWorkspaceActivity(workspaceId);
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
  const controlPlaneEngineService: ControlPlaneRuntimeOperations = controlPlaneRuntime
    ? controlPlaneRuntime.createControlPlaneEngineService({
        runtimeService,
        ...(touchWorkspaceActivity ? { touchWorkspaceActivity } : {}),
        ...(workspacePrewarmer ? { workspacePrewarmer } : {}),
        ...(runtimeDebugLogger ? { logger: runtimeDebugLogger } : {})
      })
    : runtimeService;
  const executionEngineService = new ExecutionEngineService(runtimeService);
  const workspaceLifecycle = sandboxHost
    ? {
        async execute(input: {
          workspaceId: string;
          operation: "hydrate" | "flush" | "evict" | "delete" | "repair_placement";
          force?: boolean | undefined;
        }) {
          if (input.operation === "delete") {
            try {
              await runtimeService.deleteWorkspace(input.workspaceId);
            } catch (error) {
              if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "workspace_not_found") {
                throw error;
              }
            }
            await clearWorkspaceCoordination(input.workspaceId);
            return {
              workspaceId: input.workspaceId,
              operation: input.operation,
              status: "completed" as const
            };
          }

          if (input.operation === "hydrate") {
            const workspace = await runtimeService.getWorkspaceRecord(input.workspaceId);
            if (workspaceMaterializationManager) {
              const hydrated = await workspaceMaterializationManager.hydrateWorkspace(workspace);
              return {
                workspaceId: input.workspaceId,
                operation: input.operation,
                status: "completed" as const,
                hydrated
              };
            }

            const lease = await sandboxHost.workspaceFileAccessProvider.acquire({
              workspace,
              access: "read"
            });
            await lease.release();
            return {
              workspaceId: input.workspaceId,
              operation: input.operation,
              status: "completed" as const,
              hydrated: []
            };
          }

          if (input.operation === "flush") {
            const flushed = (await workspaceMaterializationManager?.flushWorkspaceCopies(input.workspaceId)) ?? [];
            return {
              workspaceId: input.workspaceId,
              operation: input.operation,
              status: "completed" as const,
              flushed
            };
          }

          if (input.operation === "evict") {
            const result =
              (await workspaceMaterializationManager?.evictWorkspaceCopies(input.workspaceId, {
                force: input.force
              })) ?? {
                evicted: [],
                skipped: []
              };
            return {
              workspaceId: input.workspaceId,
              operation: input.operation,
              status: "completed" as const,
              evicted: result.evicted,
              skipped: result.skipped
            };
          }

          const repaired = (await workspaceMaterializationManager?.repairWorkspacePlacement(input.workspaceId)) ?? [];
          if (repaired.length === 0) {
            await touchWorkspaceActivity?.(input.workspaceId);
          }
          return {
            workspaceId: input.workspaceId,
            operation: input.operation,
            status: "completed" as const,
            repaired
          };
        }
      }
    : undefined;
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
  const workerRuntime = assemblyProfile.enableWorkerRuntime
    ? (await loadWorkerRuntimeModule()).createWorkerRuntimeControl({
        startWorker,
        processKind,
        runtimeInstanceId,
        ownerBaseUrl,
        config,
        redisRunQueue,
        redisWorkerRegistry,
        runtimeService: executionEngineService,
        describeQueuedRun,
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
  const postgresMetadataRetentionService =
    postgresMetadataRetentionConfig.enabled && "pool" in persistence
      ? new (await loadMetadataRetentionModule()).PostgresMetadataRetentionService({
          pool: persistence.pool,
          intervalMs: postgresMetadataRetentionConfig.intervalMs,
          batchLimit: postgresMetadataRetentionConfig.batchLimit,
          historyEventRetentionDays: postgresMetadataRetentionConfig.historyEventRetentionDays,
          sessionEventRetentionDays: postgresMetadataRetentionConfig.sessionEventRetentionDays,
          runRetentionDays: postgresMetadataRetentionConfig.runRetentionDays,
          logger: {
            info(message) {
              console.info(message);
            },
            warn(message, error) {
              console.warn(message, error);
            }
          }
        })
      : undefined;
  postgresMetadataRetentionService?.start();
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

    return summarizeDisabledWorkerRuntimeStatus();
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
    refreshPlatformModels: () => platformModelService.refresh(),
    ...(assemblyProfile.enableControlPlaneFacade
      ? {
          listPlatformModels: () => platformModelService.listModels(),
          getPlatformModelSnapshot: () => platformModelService.getSnapshot(),
          refreshDistributedPlatformModels,
          subscribePlatformModelSnapshot: (listener: (snapshot: PlatformModelSnapshot) => void) =>
            platformModelService.subscribe(listener)
        }
      : {}),
    ...(singleWorkspace === undefined
      ? {
          listWorkspaceRuntimes: async () => {
            const { listWorkspaceRuntimes } = await loadConfigRuntimesModule();
            const runtimesByName = new Map<string, { name: string }>();

            if (useRuntimeObjectStorageManagement) {
              for (const runtimeName of await objectStorageModule!.listRuntimeNamesFromObjectStore(config.object_storage!)) {
                runtimesByName.set(runtimeName, { name: runtimeName });
              }

              for (const runtimeCacheDir of resolveRuntimeUploadCacheDirs(config.paths)) {
                for (const runtime of await listWorkspaceRuntimes(runtimeCacheDir)) {
                  runtimesByName.set(runtime.name, runtime);
                }
              }
            } else {
              for (const runtime of await listWorkspaceRuntimes(config.paths.runtime_dir)) {
                runtimesByName.set(runtime.name, runtime);
              }
            }

            return [...runtimesByName.values()].sort((left, right) => left.name.localeCompare(right.name));
          },
          uploadWorkspaceRuntime: async (input: {
            runtimeName: string;
            zipBuffer: Buffer;
            overwrite?: boolean | undefined;
            requireExisting?: boolean | undefined;
          }) => {
            const { uploadWorkspaceRuntime } = await loadConfigRuntimesModule();
            if (useRuntimeObjectStorageManagement) {
              const runtimeCacheDir = await prepareRuntimeUploadCacheDir(config.paths);
              const runtimeCacheTarget = path.join(runtimeCacheDir, input.runtimeName);
              const objectStorageRuntimeExists = (
                await objectStorageModule!.listRuntimeNamesFromObjectStore(config.object_storage!)
              ).includes(input.runtimeName);
              const cachedRuntimeExists = await runtimeExistsInUploadCache(config.paths, input.runtimeName);
              const runtimeExists = objectStorageRuntimeExists || cachedRuntimeExists;

              if (!runtimeExists && input.requireExisting) {
                throw new AppError(404, "runtime_not_found", `Runtime "${input.runtimeName}" does not exist`);
              }

              if (runtimeExists && !input.overwrite) {
                throw new AppError(409, "runtime_already_exists", `Runtime "${input.runtimeName}" already exists`);
              }

              await mkdir(runtimeCacheDir, { recursive: true });
              const runtime = await uploadWorkspaceRuntime({
                runtimeDir: runtimeCacheDir,
                runtimeName: input.runtimeName,
                zipBuffer: input.zipBuffer,
                overwrite: true
              });
              await objectStorageModule!.syncRuntimeDirectoryToObjectStore(
                config.object_storage!,
                input.runtimeName,
                runtimeCacheTarget,
                (message) => {
                  console.info(`[oah-object-storage] ${message}`);
                }
              );
              return runtime;
            }

            return uploadWorkspaceRuntime({
              runtimeDir: config.paths.runtime_dir,
              runtimeName: input.runtimeName,
              zipBuffer: input.zipBuffer,
              ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
              ...(input.requireExisting !== undefined ? { requireExisting: input.requireExisting } : {})
            });
          },
          deleteWorkspaceRuntime: async (input: { runtimeName: string }) => {
            const { deleteWorkspaceRuntime } = await loadConfigRuntimesModule();
            if (useRuntimeObjectStorageManagement) {
              const objectStorageRuntimeExists = (
                await objectStorageModule!.listRuntimeNamesFromObjectStore(config.object_storage!)
              ).includes(input.runtimeName);
              const cachedRuntimeExists = await runtimeExistsInUploadCache(config.paths, input.runtimeName);

              if (!objectStorageRuntimeExists && !cachedRuntimeExists) {
                throw new AppError(404, "runtime_not_found", `Runtime "${input.runtimeName}" does not exist`);
              }

              await removeRuntimeFromUploadCaches(config.paths, input.runtimeName);
              await objectStorageModule!.deleteRuntimeFromObjectStore(config.object_storage!, input.runtimeName, (message) => {
                console.info(`[oah-object-storage] ${message}`);
              });
              return;
            }

            return deleteWorkspaceRuntime({
              runtimeDir: config.paths.runtime_dir,
              runtimeName: input.runtimeName
            });
          },
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
                },
                async registerLocalWorkspace(input) {
                  const rootPath = await resolveLocalWorkspaceRoot(input.rootPath);
                  if (input.runtime) {
                    const { applyWorkspaceRuntimeToExistingRoot } = await loadConfigRuntimesModule();
                    const runtimeDir = await resolveRuntimeSourceDirForBootstrap(
                      input.runtime,
                      config.paths,
                      useRuntimeObjectStorageManagement,
                      config.object_storage,
                      objectStorageModule
                    );
                    await applyWorkspaceRuntimeToExistingRoot({
                      runtimeDir,
                      runtimeName: input.runtime,
                      rootPath,
                      platformToolDir: config.paths.tool_dir,
                      platformSkillDir: config.paths.skill_dir
                    });
                  }
                  const discovered = await discoverWorkspaceWithEnrichedModels(rootPath, "project");
                  const existing = await workspaceRepository.getById(discovered.id);
                  const persisted = await workspaceRepository.upsert({
                    ...discovered,
                    rootPath,
                    name: input.name ?? existing?.name ?? discovered.name,
                    createdAt: existing?.createdAt ?? discovered.createdAt,
                    externalRef: existing?.externalRef ?? localWorkspaceExternalRef(rootPath),
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
                },
                async repairLocalWorkspace(input) {
                  const rootPath = await resolveLocalWorkspaceRoot(input.rootPath);
                  const existing = await workspaceRepository.getById(input.workspaceId);
                  if (!existing) {
                    throw new AppError(404, "workspace_not_found", `Workspace ${input.workspaceId} was not found.`);
                  }

                  const discovered = await discoverWorkspaceWithEnrichedModels(rootPath, "project");
                  const conflicting = await workspaceRepository.getById(discovered.id);
                  if (conflicting && conflicting.id !== existing.id) {
                    throw new AppError(
                      409,
                      "workspace_repair_target_conflict",
                      `Target path is already registered as workspace ${conflicting.id}. Delete that workspace before repairing ${existing.id}.`
                    );
                  }

                  const persisted = await workspaceRepository.upsert({
                    ...discovered,
                    id: existing.id,
                    rootPath,
                    name: input.name ?? existing.name ?? discovered.name,
                    createdAt: existing.createdAt,
                    updatedAt: nowIso(),
                    externalRef: localWorkspaceExternalRef(rootPath),
                    catalog: {
                      ...discovered.catalog,
                      workspaceId: existing.id
                    },
                    ...(existing.ownerId ? { ownerId: existing.ownerId } : {}),
                    ...(existing.serviceName ? { serviceName: existing.serviceName } : {})
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
    ...((redisWorkspaceLeaseRegistry || redisWorkspacePlacementRegistry)
      ? {
          resolveWorkspaceOwnership: async (workspaceId: string) => {
            const lease = await redisWorkspaceLeaseRegistry?.getByWorkspaceId?.(workspaceId);
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
                isLocalOwner: lease.ownerWorkerId === currentWorkerId
              };
            }

            const placement = await redisWorkspacePlacementRegistry?.getByWorkspaceId?.(workspaceId);
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

            if (redisWorkerRegistry && typeof redisWorkerRegistry.listActive === "function") {
              const activeWorkers = await redisWorkerRegistry.listActive();
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
              health: placement.state === "draining" ? "late" : "healthy",
              lastActivityAt: placement.lastActivityAt ?? placement.updatedAt,
              ...(placement.localPath ? { localPath: placement.localPath } : {}),
              ...(placement.remotePrefix ? { remotePrefix: placement.remotePrefix } : {}),
              isLocalOwner:
                ownerWorkerId === currentWorkerId || ownerBaseUrlMatches(placementOwnerBaseUrl, ownerBaseUrl)
            };
          }
        }
      : {}),
    ...(adminCapabilities ? { adminCapabilities } : {}),
    ...(sandboxHost ? { sandboxHostProviderKind: sandboxHost.providerKind } : {}),
    ...(ownerBaseUrl ? { localOwnerBaseUrl: ownerBaseUrl } : {}),
    ...(touchWorkspaceActivity ? { touchWorkspaceActivity } : {}),
    ...(workspaceLifecycle ? { workspaceLifecycle } : {}),
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
      const workerDiskReadiness =
        runtimeProcess.mode === "api_only"
          ? undefined
          : evaluateWorkerDiskReadiness({
              paths: [
                config.paths.workspace_dir,
                resolveRuntimeStateDir(config.paths),
                resolveWorkspaceMaterializationCacheRoot(config.paths)
              ]
            });
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck()
      };
      const readyQueueDepth = await resolveRedisReadyQueueDepth({ redisRunQueue });
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
    },
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
      await Promise.all([
        workerRuntime?.close() ?? Promise.resolve(),
        postgresMetadataRetentionService?.close() ?? Promise.resolve(),
        adminCapabilities?.close() ?? Promise.resolve(),
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
      if (workspaceMaterializationMaintenanceTimer) {
        clearInterval(workspaceMaterializationMaintenanceTimer);
      }
      await controlPlaneRuntime?.close();
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
