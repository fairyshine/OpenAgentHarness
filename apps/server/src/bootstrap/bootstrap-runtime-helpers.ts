import path from "node:path";
import { access, realpath, stat } from "node:fs/promises";

import type { ServerConfig } from "@oah/config";
import type { WorkspaceRecord } from "@oah/engine-core";
import type { WorkspaceRepository } from "@oah/engine-core";
import { AppError } from "@oah/engine-core";
import type { SandboxHost } from "./sandbox-host.js";
import type { WorkerRuntimeStatus } from "./worker-runtime.js";
import { resolveManagedWorkspaceExternalRef } from "./object-storage-policy.js";
import { parseBooleanEnv, parseNonNegativeIntEnv, parseOptionalPositiveIntEnv, parsePositiveIntEnv } from "./bootstrap-config.js";

export function hasRemoteErrorCode(error: unknown, code: string): boolean {
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

export async function clearWorkspaceRootContents(input: {
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

export function ownerBaseUrlMatches(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = left?.trim().replace(/\/+$/u, "");
  const normalizedRight = right?.trim().replace(/\/+$/u, "");
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function parseStaleRunRecoveryStrategyEnv(
  name: string,
  fallback: "fail" | "requeue_running" | "requeue_all"
): "fail" | "requeue_running" | "requeue_all" {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  return raw === "fail" || raw === "requeue_running" || raw === "requeue_all" ? raw : fallback;
}

export function workerRegistryMatchesPlacementOwner(
  worker: { workerId: string; runtimeInstanceId?: string | undefined },
  ownerWorkerId: string
): boolean {
  return worker.workerId === ownerWorkerId || worker.runtimeInstanceId === ownerWorkerId;
}

export function withManagedWorkspaceExternalRef(
  workspace: WorkspaceRecord,
  config: ServerConfig,
  objectStorageMirror: import("../object-storage.js").ObjectStorageMirrorController | undefined
): WorkspaceRecord {
  if (workspace.externalRef) {
    return workspace;
  }

  const externalRef =
    resolveManagedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config) ??
    objectStorageMirror?.managedWorkspaceExternalRef(workspace.rootPath, workspace.kind, config.paths);
  return externalRef ? { ...workspace, externalRef } : workspace;
}

export async function resolveLocalWorkspaceRoot(rootPath: string): Promise<string> {
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

export function localWorkspaceExternalRef(rootPath: string): string {
  return `local:path:${rootPath.replaceAll("\\", "/")}`;
}

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function isTruthyEnvValue(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/iu.test(value.trim());
}

export function resolvePostgresMetadataRetentionConfig(input: { processKind: "api" | "worker"; startWorker: boolean }) {
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

export function resolvePostgresPoolConfig(input: { processKind: "api" | "worker"; startWorker: boolean }) {
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

export async function resolveRedisReadyQueueDepth(input: {
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

export function resolveRedisReadyQueueReadinessLimit(): number | undefined {
  return parseOptionalPositiveIntEnv("OAH_REDIS_READY_QUEUE_READINESS_LIMIT");
}

export function isRemoteSandboxProvider(config: Pick<ServerConfig, "sandbox">): boolean {
  const provider = config.sandbox?.provider ?? (config.sandbox?.self_hosted?.base_url?.trim() ? "self_hosted" : "embedded");
  return provider === "self_hosted" || provider === "e2b";
}

export function runtimeHasPersistedWorkspaceListing(
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

export function runtimeHasWorkspaceSnapshotListing(
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

export async function listRepositoryWorkspaces(
  repository: Pick<WorkspaceRepository, "list">
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

export function summarizeDisabledWorkerRuntimeStatus(): WorkerRuntimeStatus {
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

export function resolveInternalBaseUrl(
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

export function resolveRuntimeInstanceId(processKind: "api" | "worker"): string {
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
