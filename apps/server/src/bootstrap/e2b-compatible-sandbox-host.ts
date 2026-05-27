import path from "node:path";
import { Readable } from "node:stream";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";

import {
  SANDBOX_ROOT_PATH,
  createSandboxHttpClient,
  type EnsureSandboxForWorkspaceRequest,
  type Sandbox,
  type SandboxHttpTransport
} from "@oah/api-contracts";
import type {
  WorkspaceBackgroundCommandExecutionResult,
  WorkspaceCommandExecutor,
  WorkspaceExecutionLease,
  WorkspaceExecutionProvider,
  WorkspaceFileAccessLease,
  WorkspaceFileAccessProvider,
  WorkspaceFileStat,
  WorkspaceFileSystem,
  WorkspaceFileSystemEntry,
  WorkspaceForegroundCommandExecutionResult,
  WorkspaceRecord
} from "@oah/engine-core";

import type { SandboxHost } from "./sandbox-host.js";
import type { WorkspaceMaterializationManager, WorkspaceMaterializationLease } from "./workspace-materialization.js";
import { describeSandboxTopology } from "../sandbox-capabilities.js";
import { shouldExcludeWorkspaceBackingStoreRelativePath } from "../object-storage.js";

const VIRTUAL_SANDBOX_ROOT = "/__oah_sandbox__";
const SANDBOX_LIST_PAGE_SIZE = 200;
const MATERIALIZED_SANDBOX_SYNC_CONCURRENCY = 8;

export interface E2BCompatibleSandboxLease {
  sandboxId: string;
  rootPath: string;
  release(options?: { dirty?: boolean | undefined }): Promise<void> | void;
}

export interface E2BCompatibleSandboxService {
  acquireExecution(input: {
    workspace: WorkspaceRecord;
    run: { id: string; sessionId?: string | undefined };
    session?: { id: string } | undefined;
  }): Promise<E2BCompatibleSandboxLease>;
  acquireFileAccess(input: {
    workspace: WorkspaceRecord;
    access: "read" | "write";
    path?: string | undefined;
  }): Promise<E2BCompatibleSandboxLease>;
  runCommand(input: {
    sandboxId: string;
    rootPath: string;
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runProcess(input: {
    sandboxId: string;
    rootPath: string;
    executable: string;
    args: string[];
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runBackground(input: {
    sandboxId: string;
    rootPath: string;
    command: string;
    sessionId: string;
    description?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<WorkspaceBackgroundCommandExecutionResult>;
  stat(input: { sandboxId: string; path: string }): Promise<WorkspaceFileStat>;
  readFile(input: { sandboxId: string; path: string }): Promise<Buffer>;
  openReadStream?(input: { sandboxId: string; path: string }): Readable;
  readdir(input: { sandboxId: string; path: string }): Promise<WorkspaceFileSystemEntry[]>;
  readdirPage?(input: {
    sandboxId: string;
    path: string;
    pageSize: number;
    cursor?: string | undefined;
    sortBy?: "name" | "type" | undefined;
    sortOrder?: "asc" | "desc" | undefined;
    includeMetadata?: boolean | undefined;
    includeDirectoryDescendantUpdatedAt?: boolean | undefined;
  }): Promise<{ items: WorkspaceFileSystemEntry[]; nextCursor?: string | undefined }>;
  mkdir(input: { sandboxId: string; path: string; recursive?: boolean | undefined }): Promise<void>;
  writeFile(input: { sandboxId: string; path: string; data: Buffer; mtimeMs?: number | undefined }): Promise<void>;
  rm(input: {
    sandboxId: string;
    path: string;
    recursive?: boolean | undefined;
    force?: boolean | undefined;
  }): Promise<void>;
  rename(input: { sandboxId: string; sourcePath: string; targetPath: string }): Promise<void>;
  realpath?(input: { sandboxId: string; path: string }): Promise<string>;
  deleteWorkspace?(workspace: WorkspaceRecord): Promise<void> | void;
  diagnostics?(): Record<string, unknown>;
  maintain?(options: { idleBefore: string }): Promise<void>;
  beginDrain?(): Promise<void>;
  close(): Promise<void>;
}

interface LocalToSandboxSyncFile {
  localPath: string;
  remotePath: string;
  size: number;
  mtimeMs: number;
}

interface SandboxToLocalSyncFile {
  remotePath: string;
  localPath: string;
  size?: number | undefined;
  mtimeMs?: number | undefined;
}

function normalizeSyncRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/").replace(/^\/+|\/+$/gu, "");
}

function remoteChildPath(parent: string, name: string): string {
  return path.posix.join(parent, name);
}

async function runWithSyncConcurrency<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const concurrency = Math.max(1, Math.min(MATERIALIZED_SANDBOX_SYNC_CONCURRENCY, items.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        await worker(items[index]!);
      }
    })
  );
}

async function collectLocalToSandboxSyncPlan(input: {
  localRoot: string;
  remoteRoot: string;
  currentLocalPath?: string | undefined;
  currentRemotePath?: string | undefined;
}): Promise<{ directories: string[]; files: LocalToSandboxSyncFile[] }> {
  const currentLocalPath = input.currentLocalPath ?? input.localRoot;
  const currentRemotePath = input.currentRemotePath ?? input.remoteRoot;
  const directories: string[] = [];
  const files: LocalToSandboxSyncFile[] = [];
  const entries = await readdir(currentLocalPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const localPath = path.join(currentLocalPath, entry.name);
    const relativePath = normalizeSyncRelativePath(path.relative(input.localRoot, localPath));
    if (shouldExcludeWorkspaceBackingStoreRelativePath(relativePath)) {
      continue;
    }

    const remotePath = remoteChildPath(currentRemotePath, entry.name);
    if (entry.isDirectory()) {
      directories.push(remotePath);
      const nested = await collectLocalToSandboxSyncPlan({
        ...input,
        currentLocalPath: localPath,
        currentRemotePath: remotePath
      });
      directories.push(...nested.directories);
      files.push(...nested.files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileStat = await stat(localPath);
    files.push({
      localPath,
      remotePath,
      size: fileStat.size,
      mtimeMs: Math.trunc(fileStat.mtimeMs)
    });
  }

  return { directories, files };
}

async function collectSandboxEntries(input: {
  service: E2BCompatibleSandboxService;
  sandboxId: string;
  remoteRoot: string;
  currentRemotePath?: string | undefined;
}): Promise<Map<string, WorkspaceFileSystemEntry>> {
  const currentRemotePath = input.currentRemotePath ?? input.remoteRoot;
  const entriesByPath = new Map<string, WorkspaceFileSystemEntry>();
  const entries = await input.service.readdir({
    sandboxId: input.sandboxId,
    path: currentRemotePath
  });

  for (const entry of entries) {
    const childPath = remoteChildPath(currentRemotePath, entry.name);
    const relativePath = path.posix.relative(input.remoteRoot, childPath);
    if (shouldExcludeWorkspaceBackingStoreRelativePath(relativePath)) {
      continue;
    }

    entriesByPath.set(childPath, entry);
    if (entry.kind === "directory") {
      const nested = await collectSandboxEntries({
        ...input,
        currentRemotePath: childPath
      });
      for (const [nestedPath, nestedEntry] of nested) {
        entriesByPath.set(nestedPath, nestedEntry);
      }
    }
  }

  return entriesByPath;
}

function parseEntryMtimeMs(entry: WorkspaceFileSystemEntry | undefined): number | undefined {
  if (!entry?.updatedAt) {
    return undefined;
  }

  const parsed = Date.parse(entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isMtimeClose(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }

  return Math.abs(left - right) < 1_000;
}

async function syncLocalDirectoryToSandbox(input: {
  service: E2BCompatibleSandboxService;
  sandboxId: string;
  localRoot: string;
  remoteRoot: string;
  logger?: ((message: string) => void) | undefined;
  label?: string | undefined;
}): Promise<void> {
  input.logger?.(`[sandbox-materialization] hydrating ${input.label ?? input.remoteRoot} into sandbox ${input.sandboxId}`);
  await input.service.mkdir({
    sandboxId: input.sandboxId,
    path: input.remoteRoot,
    recursive: true
  });

  const [plan, remoteEntries] = await Promise.all([
    collectLocalToSandboxSyncPlan({
      localRoot: input.localRoot,
      remoteRoot: input.remoteRoot
    }),
    collectSandboxEntries({
      service: input.service,
      sandboxId: input.sandboxId,
      remoteRoot: input.remoteRoot
    })
  ]);
  const expectedRemotePaths = new Set<string>([...plan.directories, ...plan.files.map((file) => file.remotePath)]);
  const unexpectedRemotePaths = [...remoteEntries.entries()]
    .filter(([remotePath]) => !expectedRemotePaths.has(remotePath))
    .sort((left, right) => right[0].length - left[0].length);

  await runWithSyncConcurrency(unexpectedRemotePaths, async ([remotePath, entry]) => {
    await input.service.rm({
      sandboxId: input.sandboxId,
      path: remotePath,
      recursive: entry.kind === "directory",
      force: true
    });
  });

  await runWithSyncConcurrency(plan.directories, async (remotePath) => {
    await input.service.mkdir({
      sandboxId: input.sandboxId,
      path: remotePath,
      recursive: true
    });
  });

  await runWithSyncConcurrency(plan.files, async (file) => {
    const remoteEntry = remoteEntries.get(file.remotePath);
    if (
      remoteEntry?.kind === "file" &&
      remoteEntry.sizeBytes === file.size &&
      isMtimeClose(parseEntryMtimeMs(remoteEntry), file.mtimeMs)
    ) {
      return;
    }

    await input.service.writeFile({
      sandboxId: input.sandboxId,
      path: file.remotePath,
      data: await readFile(file.localPath),
      mtimeMs: file.mtimeMs
    });
  });
}

async function collectLocalEntries(input: {
  localRoot: string;
  currentLocalPath?: string | undefined;
}): Promise<Map<string, { kind: "file" | "directory"; size?: number | undefined; mtimeMs?: number | undefined }>> {
  const currentLocalPath = input.currentLocalPath ?? input.localRoot;
  const entriesByRelativePath = new Map<string, { kind: "file" | "directory"; size?: number | undefined; mtimeMs?: number | undefined }>();
  const entries = await readdir(currentLocalPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const localPath = path.join(currentLocalPath, entry.name);
    const relativePath = normalizeSyncRelativePath(path.relative(input.localRoot, localPath));
    if (shouldExcludeWorkspaceBackingStoreRelativePath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      entriesByRelativePath.set(relativePath, { kind: "directory" });
      const nested = await collectLocalEntries({
        ...input,
        currentLocalPath: localPath
      });
      for (const [nestedPath, nestedEntry] of nested) {
        entriesByRelativePath.set(nestedPath, nestedEntry);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileStat = await stat(localPath);
    entriesByRelativePath.set(relativePath, {
      kind: "file",
      size: fileStat.size,
      mtimeMs: Math.trunc(fileStat.mtimeMs)
    });
  }

  return entriesByRelativePath;
}

function sandboxEntriesToLocalPlan(input: {
  remoteRoot: string;
  localRoot: string;
  entries: Map<string, WorkspaceFileSystemEntry>;
}): { directories: string[]; files: SandboxToLocalSyncFile[]; expectedRelativePaths: Set<string> } {
  const directories: string[] = [];
  const files: SandboxToLocalSyncFile[] = [];
  const expectedRelativePaths = new Set<string>();

  for (const [remotePath, entry] of input.entries) {
    const relativePath = path.posix.relative(input.remoteRoot, remotePath);
    if (!relativePath || shouldExcludeWorkspaceBackingStoreRelativePath(relativePath)) {
      continue;
    }

    expectedRelativePaths.add(relativePath);
    const localPath = path.join(input.localRoot, ...relativePath.split("/"));
    if (entry.kind === "directory") {
      directories.push(localPath);
      continue;
    }

    files.push({
      remotePath,
      localPath,
      size: entry.sizeBytes,
      mtimeMs: parseEntryMtimeMs(entry)
    });
  }

  return { directories, files, expectedRelativePaths };
}

async function syncSandboxDirectoryToLocal(input: {
  service: E2BCompatibleSandboxService;
  sandboxId: string;
  remoteRoot: string;
  localRoot: string;
  logger?: ((message: string) => void) | undefined;
  label?: string | undefined;
}): Promise<void> {
  input.logger?.(`[sandbox-materialization] flushing ${input.label ?? input.remoteRoot} from sandbox ${input.sandboxId}`);
  await mkdir(input.localRoot, { recursive: true });
  const [remoteEntries, localEntries] = await Promise.all([
    collectSandboxEntries({
      service: input.service,
      sandboxId: input.sandboxId,
      remoteRoot: input.remoteRoot
    }),
    collectLocalEntries({
      localRoot: input.localRoot
    })
  ]);
  const plan = sandboxEntriesToLocalPlan({
    remoteRoot: input.remoteRoot,
    localRoot: input.localRoot,
    entries: remoteEntries
  });
  const unexpectedLocalEntries = [...localEntries.keys()]
    .filter((relativePath) => !plan.expectedRelativePaths.has(relativePath))
    .sort((left, right) => right.length - left.length);

  await runWithSyncConcurrency(unexpectedLocalEntries, async (relativePath) => {
    await rm(path.join(input.localRoot, ...relativePath.split("/")), { recursive: true, force: true });
  });

  await runWithSyncConcurrency(plan.directories, async (localPath) => {
    await mkdir(localPath, { recursive: true });
  });

  await runWithSyncConcurrency(plan.files, async (file) => {
    const relativePath = normalizeSyncRelativePath(path.relative(input.localRoot, file.localPath));
    const localEntry = localEntries.get(relativePath);
    if (
      localEntry?.kind === "file" &&
      localEntry.size === file.size &&
      isMtimeClose(localEntry.mtimeMs, file.mtimeMs)
    ) {
      return;
    }

    await mkdir(path.dirname(file.localPath), { recursive: true });
    await writeFile(file.localPath, await input.service.readFile({
      sandboxId: input.sandboxId,
      path: file.remotePath
    }));
    if (file.mtimeMs !== undefined) {
      const mtime = new Date(file.mtimeMs);
      await utimes(file.localPath, mtime, mtime).catch(() => undefined);
    }
  });
}

export function createMaterializedE2BCompatibleSandboxService(options: {
  service: E2BCompatibleSandboxService;
  materializationManager: WorkspaceMaterializationManager;
  logger?: ((message: string) => void) | undefined;
}): E2BCompatibleSandboxService {
  const hydratedSandboxWorkspaceKeys = new Set<string>();
  const hydrationInFlightByKey = new Map<string, Promise<void>>();

  const hydrationKey = (sandboxId: string, workspaceId: string) => `${encodeURIComponent(sandboxId)}:${encodeURIComponent(workspaceId)}`;

  const ensureSandboxHydrated = async (input: {
    sandboxLease: E2BCompatibleSandboxLease;
    materializedLease: WorkspaceMaterializationLease;
    workspace: WorkspaceRecord;
  }): Promise<void> => {
    const key = hydrationKey(input.sandboxLease.sandboxId, input.workspace.id);
    if (hydratedSandboxWorkspaceKeys.has(key)) {
      return;
    }

    let inFlight = hydrationInFlightByKey.get(key);
    if (!inFlight) {
      inFlight = syncLocalDirectoryToSandbox({
        service: options.service,
        sandboxId: input.sandboxLease.sandboxId,
        localRoot: input.materializedLease.localPath,
        remoteRoot: input.sandboxLease.rootPath,
        logger: options.logger,
        label: input.workspace.id
      })
        .then(() => {
          hydratedSandboxWorkspaceKeys.add(key);
        })
        .finally(() => {
          hydrationInFlightByKey.delete(key);
        });
      hydrationInFlightByKey.set(key, inFlight);
    }

    await inFlight;
  };

  const wrapAcquire = async <T extends E2BCompatibleSandboxLease>(
    workspace: WorkspaceRecord,
    acquire: () => Promise<T>
  ): Promise<E2BCompatibleSandboxLease> => {
    const materializedLease = await options.materializationManager.acquireWorkspace({
      workspace
    });
    let sandboxLease: T | undefined;

    try {
      sandboxLease = await acquire();
      await ensureSandboxHydrated({
        sandboxLease,
        materializedLease,
        workspace
      });
    } catch (error) {
      await Promise.allSettled([
        sandboxLease?.release({ dirty: false }) ?? Promise.resolve(),
        materializedLease.release({ dirty: false })
      ]);
      throw error;
    }

    let released = false;
    const releaseMaterializedLease = async (lease: WorkspaceMaterializationLease, dirty: boolean | undefined) => {
      await lease.release({ dirty });
      if (dirty) {
        await options.materializationManager.flushWorkspaceCopies(workspace.id);
      }
    };

    return {
      sandboxId: sandboxLease.sandboxId,
      rootPath: sandboxLease.rootPath,
      async release(releaseOptions?: { dirty?: boolean | undefined }) {
        if (released) {
          return;
        }

        released = true;
        const dirty = releaseOptions?.dirty === true;
        let materializedReleased = false;
        try {
          if (dirty) {
            await syncSandboxDirectoryToLocal({
              service: options.service,
              sandboxId: sandboxLease!.sandboxId,
              remoteRoot: sandboxLease!.rootPath,
              localRoot: materializedLease.localPath,
              logger: options.logger,
              label: workspace.id
            });
          }

          await releaseMaterializedLease(materializedLease, dirty);
          materializedReleased = true;
        } finally {
          if (!materializedReleased) {
            await materializedLease.release({ dirty: false }).catch(() => undefined);
          }
          await sandboxLease!.release(releaseOptions);
        }
      }
    };
  };

  const wrapped: E2BCompatibleSandboxService = {
    acquireExecution(input) {
      return wrapAcquire(input.workspace, () => options.service.acquireExecution(input));
    },
    acquireFileAccess(input) {
      return wrapAcquire(input.workspace, () => options.service.acquireFileAccess(input));
    },
    runCommand(input) {
      return options.service.runCommand(input);
    },
    runProcess(input) {
      return options.service.runProcess(input);
    },
    runBackground(input) {
      return options.service.runBackground(input);
    },
    stat(input) {
      return options.service.stat(input);
    },
    readFile(input) {
      return options.service.readFile(input);
    },
    readdir(input) {
      return options.service.readdir(input);
    },
    mkdir(input) {
      return options.service.mkdir(input);
    },
    writeFile(input) {
      return options.service.writeFile(input);
    },
    rm(input) {
      return options.service.rm(input);
    },
    rename(input) {
      return options.service.rename(input);
    },
    diagnostics() {
      return {
        ...(options.service.diagnostics?.() ?? {}),
        materialization: options.materializationManager.diagnostics()
      };
    },
    async maintain(input) {
      await options.service.maintain?.(input);
      await options.materializationManager.refreshLeases();
      await options.materializationManager.flushIdleCopies(input);
      await options.materializationManager.evictIdleCopies(input);
    },
    async beginDrain() {
      await options.materializationManager.beginDrain();
      await options.service.beginDrain?.();
    },
    async close() {
      try {
        await options.materializationManager.close();
      } finally {
        hydratedSandboxWorkspaceKeys.clear();
        hydrationInFlightByKey.clear();
        await options.service.close();
      }
    }
  };

  if (options.service.openReadStream) {
    wrapped.openReadStream = (input) => options.service.openReadStream!(input);
  }
  if (options.service.readdirPage) {
    wrapped.readdirPage = (input) => options.service.readdirPage!(input);
  }
  if (options.service.realpath) {
    wrapped.realpath = (input) => options.service.realpath!(input);
  }
  wrapped.deleteWorkspace = async (workspace) => {
    await options.service.deleteWorkspace?.(workspace);
    for (const key of [...hydratedSandboxWorkspaceKeys]) {
      if (key.endsWith(`:${encodeURIComponent(workspace.id)}`)) {
        hydratedSandboxWorkspaceKeys.delete(key);
      }
    }
    await options.materializationManager.deleteWorkspaceCopies(workspace.id);
  };

  return wrapped;
}

export interface HttpE2BCompatibleSandboxServiceOptions {
  baseUrl: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  resolveCreateBaseUrl?: ((workspace: WorkspaceRecord) => Promise<string | undefined>) | undefined;
}

type WorkspaceSandboxHttpClient = ReturnType<typeof createSandboxHttpClient> & {
  ensureSandboxForWorkspace(input: EnsureSandboxForWorkspaceRequest): Promise<Sandbox>;
};

async function resolveHttpHeaders(
  input: HttpE2BCompatibleSandboxServiceOptions["headers"]
): Promise<Record<string, string> | undefined> {
  if (!input) {
    return undefined;
  }

  return typeof input === "function" ? await input() : input;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `Sandbox backend request failed with status ${response.status}.`);
  }

  return JSON.parse(raw) as T;
}

function sandboxErrorHasCode(error: unknown, expectedCode: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  try {
    const payload = JSON.parse(error.message) as {
      error?: {
        code?: string | undefined;
      } | undefined;
    };
    return payload.error?.code === expectedCode;
  } catch {
    return false;
  }
}

function parseSandboxHttpBaseUrl(input: string): { baseUrl: string; routePrefix: "/api/v1" | "/internal/v1" | "" } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const routePrefix = url.pathname.endsWith("/internal/v1")
      ? "/internal/v1"
      : url.pathname.endsWith("/api/v1")
        ? "/api/v1"
        : "";
    const normalizedPath = routePrefix ? url.pathname.slice(0, -routePrefix.length).replace(/\/+$/u, "") : url.pathname.replace(/\/+$/u, "");
    return {
      baseUrl: `${url.origin}${normalizedPath}`,
      routePrefix
    };
  } catch {
    const routePrefix = trimmed.endsWith("/internal/v1")
      ? "/internal/v1"
      : trimmed.endsWith("/api/v1")
        ? "/api/v1"
        : "";
    return {
      baseUrl: routePrefix ? trimmed.slice(0, -routePrefix.length).replace(/\/+$/u, "") : trimmed.replace(/\/+$/u, ""),
      routePrefix
    };
  }
}

function normalizeHttpSandboxPath(rootPath: string, targetPath: string): string {
  const normalizedRoot = path.posix.normalize(rootPath);
  const normalizedTarget = path.posix.normalize(targetPath);
  if (normalizedTarget === normalizedRoot) {
    return normalizedRoot;
  }

  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget;
  }

  return path.posix.join(normalizedRoot, normalizedTarget.replace(/^\/+/u, ""));
}

export function createHttpE2BCompatibleSandboxService(
  options: HttpE2BCompatibleSandboxServiceOptions
): E2BCompatibleSandboxService {
  const clientBySandboxId = new Map<string, WorkspaceSandboxHttpClient>();

  const createClient = (inputBaseUrl: string) => {
    const { baseUrl, routePrefix } = parseSandboxHttpBaseUrl(inputBaseUrl);
    const mapRequestPath = (requestPath: string) =>
      routePrefix ? requestPath.replace(/^\/api\/v1(?=\/|$)/u, routePrefix) : requestPath;

    const transport: SandboxHttpTransport = {
      async requestJson<T>(requestPath: string, init?: RequestInit) {
        const headers = new Headers(await resolveHttpHeaders(options.headers));
        const inputHeaders = new Headers(init?.headers);
        for (const [name, value] of inputHeaders.entries()) {
          headers.set(name, value);
        }

        const response = await fetch(`${baseUrl}${mapRequestPath(requestPath)}`, {
          ...init,
          headers
        });
        return readJsonResponse<T>(response);
      },
      async requestBytes(requestPath: string, init?: RequestInit) {
        const headers = new Headers(await resolveHttpHeaders(options.headers));
        const inputHeaders = new Headers(init?.headers);
        for (const [name, value] of inputHeaders.entries()) {
          headers.set(name, value);
        }

        const response = await fetch(`${baseUrl}${mapRequestPath(requestPath)}`, {
          ...init,
          headers
        });
        if (!response.ok) {
          throw new Error((await response.text()) || `Sandbox backend request failed with status ${response.status}.`);
        }

        return new Uint8Array(await response.arrayBuffer());
      }
    };

    return createSandboxHttpClient(transport) as WorkspaceSandboxHttpClient;
  };

  const defaultClient = createClient(options.baseUrl);
  const clientForSandbox = (sandboxId: string) => clientBySandboxId.get(sandboxId) ?? defaultClient;

  async function resolveSandboxForWorkspace(workspace: WorkspaceRecord) {
    const targetBaseUrl = (await options.resolveCreateBaseUrl?.(workspace)) ?? options.baseUrl;
    const createClientForWorkspace =
      targetBaseUrl.trim() === options.baseUrl.trim() ? defaultClient : createClient(targetBaseUrl);
    const runtime = workspace.runtime ?? workspace.settings.runtime;
    const sandbox = await createClientForWorkspace.ensureSandboxForWorkspace({
      workspaceId: workspace.id,
      ...(workspace.name ? { name: workspace.name } : {}),
      ...(runtime ? { runtime } : {}),
      ...(workspace.externalRef ? { externalRef: workspace.externalRef } : {}),
      ...(workspace.ownerId ? { ownerId: workspace.ownerId } : {}),
      ...(workspace.serviceName ? { serviceName: workspace.serviceName } : {}),
      executionPolicy: workspace.executionPolicy
    });
    if (sandbox.ownerBaseUrl?.trim()) {
      clientBySandboxId.set(sandbox.id, createClient(sandbox.ownerBaseUrl));
    } else if (targetBaseUrl.trim()) {
      clientBySandboxId.set(sandbox.id, createClientForWorkspace);
    }
    return sandbox;
  }

  async function ensureWorkspaceRoot(sandboxId: string, rootPath: string) {
    const client = clientForSandbox(sandboxId);

    try {
      await client.getFileStat(sandboxId, {
        path: rootPath
      });
      return;
    } catch (error) {
      if (
        !sandboxErrorHasCode(error, "workspace_not_found") &&
        !sandboxErrorHasCode(error, "workspace_entry_not_found") &&
        !sandboxErrorHasCode(error, "workspace_directory_not_found")
      ) {
        throw error;
      }
    }

    try {
      await client.createDirectory(sandboxId, {
        path: rootPath,
        createParents: true
      });
      return;
    } catch (error) {
      if (!sandboxErrorHasCode(error, "workspace_root_mutation_not_allowed")) {
        throw error;
      }
    }

    await client.createDirectory(sandboxId, {
      path: path.posix.join(rootPath, ".openharness"),
      createParents: true
    });
  }

  function relativeToSandboxRoot(rootPath: string, targetPath: string) {
    return normalizeHttpSandboxPath(rootPath, targetPath);
  }

  return {
    async acquireExecution(input) {
      const sandbox = await resolveSandboxForWorkspace(input.workspace);
      await ensureWorkspaceRoot(sandbox.id, sandbox.rootPath);
      return {
        sandboxId: sandbox.id,
        rootPath: sandbox.rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async acquireFileAccess(input) {
      const sandbox = await resolveSandboxForWorkspace(input.workspace);
      await ensureWorkspaceRoot(sandbox.id, sandbox.rootPath);
      return {
        sandboxId: sandbox.id,
        rootPath: sandbox.rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async runCommand(input) {
      return clientForSandbox(input.sandboxId).runForegroundCommand(input.sandboxId, {
        command: input.command,
        ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      });
    },
    async runProcess(input) {
      return clientForSandbox(input.sandboxId).runProcessCommand(input.sandboxId, {
        executable: input.executable,
        args: input.args,
        ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      });
    },
    async runBackground(input) {
      return clientForSandbox(input.sandboxId).runBackgroundCommand(input.sandboxId, {
        command: input.command,
        sessionId: input.sessionId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
        ...(input.env ? { env: input.env } : {})
      });
    },
    async stat(input) {
      return clientForSandbox(input.sandboxId).getFileStat(input.sandboxId, {
        path: input.path
      });
    },
    async readFile(input) {
      return Buffer.from(
        await clientForSandbox(input.sandboxId).downloadFile(input.sandboxId, {
          path: input.path
        })
      );
    },
    async readdir(input) {
      const items = [];
      let cursor: string | undefined;

      do {
        const page = await clientForSandbox(input.sandboxId).listEntries(input.sandboxId, {
          path: input.path,
          pageSize: SANDBOX_LIST_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          sortBy: "name",
          sortOrder: "asc"
        });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);

      return items.map((entry) => ({
        name: path.posix.basename(entry.path),
        kind: entry.type,
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {})
      }));
    },
    async readdirPage(input) {
      const page = await clientForSandbox(input.sandboxId).listEntries(input.sandboxId, {
        path: input.path,
        pageSize: input.pageSize,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        sortBy: input.sortBy ?? "name",
        sortOrder: input.sortOrder ?? "asc",
        includeEntryMetadata: input.includeMetadata,
        includeDirectoryDescendantUpdatedAt: input.includeDirectoryDescendantUpdatedAt
      });

      return {
        items: page.items.map((entry) => ({
          name: path.posix.basename(entry.path),
          kind: entry.type,
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
          ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {})
        })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      };
    },
    async mkdir(input) {
      await clientForSandbox(input.sandboxId).createDirectory(input.sandboxId, {
        path: input.path,
        createParents: input.recursive ?? true
      });
    },
    async writeFile(input) {
      await clientForSandbox(input.sandboxId).uploadFile(input.sandboxId, {
        path: input.path,
        overwrite: true,
        data: input.data,
        contentType: "application/octet-stream",
        ...(typeof input.mtimeMs === "number" ? { mtimeMs: input.mtimeMs } : {})
      });
    },
    async rm(input) {
      await clientForSandbox(input.sandboxId).deleteEntry(input.sandboxId, {
        path: input.path,
        recursive: input.recursive ?? false
      });
    },
    async rename(input) {
      await clientForSandbox(input.sandboxId).moveEntry(input.sandboxId, {
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        overwrite: true
      });
    },
    async realpath(input) {
      return normalizeHttpSandboxPath(SANDBOX_ROOT_PATH, input.path);
    },
    async deleteWorkspace() {
      return undefined;
    },
    diagnostics() {
      return {
        transport: "http"
      };
    },
    async close() {
      return undefined;
    }
  };
}

function toVirtualWorkspaceRoot(lease: E2BCompatibleSandboxLease): string {
  const normalizedRoot = lease.rootPath.startsWith("/")
    ? path.posix.normalize(lease.rootPath)
    : path.posix.join("/", lease.rootPath);
  return path.posix.join(VIRTUAL_SANDBOX_ROOT, encodeURIComponent(lease.sandboxId), normalizedRoot);
}

function parseVirtualSandboxPath(targetPath: string): { sandboxId: string; remotePath: string } {
  const normalized = path.posix.normalize(targetPath);
  if (!normalized.startsWith(`${VIRTUAL_SANDBOX_ROOT}/`)) {
    throw new Error(`Path ${targetPath} is not an E2B-compatible sandbox path.`);
  }

  const parts = normalized.split("/").filter((part) => part.length > 0);
  const encodedSandboxId = parts[1];
  if (!encodedSandboxId) {
    throw new Error(`Path ${targetPath} is missing a sandbox id.`);
  }

  return {
    sandboxId: decodeURIComponent(encodedSandboxId),
    remotePath: `/${parts.slice(2).join("/")}`
  };
}

function decodeWorkspaceContext(workspace: WorkspaceRecord, cwd?: string | undefined) {
  const root = parseVirtualSandboxPath(workspace.rootPath);
  const currentPath = cwd ? parseVirtualSandboxPath(cwd) : root;
  if (currentPath.sandboxId !== root.sandboxId) {
    throw new Error(`Path ${cwd} does not belong to sandbox ${root.sandboxId}.`);
  }

  return {
    sandboxId: root.sandboxId,
    rootPath: root.remotePath,
    cwd: currentPath.remotePath
  };
}

function createE2BCompatibleWorkspaceCommandExecutor(service: E2BCompatibleSandboxService): WorkspaceCommandExecutor {
  return {
    async runForeground(input) {
      const context = decodeWorkspaceContext(input.workspace, input.cwd);
      return service.runCommand({
        ...context,
        command: input.command,
        env: {
          OPENHARNESS_WORKSPACE_ROOT: input.workspace.rootPath,
          ...(input.env ?? {})
        },
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    },
    async runProcess(input) {
      const context = decodeWorkspaceContext(input.workspace, input.cwd);
      return service.runProcess({
        ...context,
        executable: input.executable,
        args: input.args,
        env: {
          OPENHARNESS_WORKSPACE_ROOT: input.workspace.rootPath,
          ...(input.env ?? {})
        },
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    },
    async runBackground(input) {
      const context = decodeWorkspaceContext(input.workspace, input.cwd);
      return service.runBackground({
        ...context,
        command: input.command,
        sessionId: input.sessionId,
        ...(input.description ? { description: input.description } : {}),
        env: {
          OPENHARNESS_WORKSPACE_ROOT: input.workspace.rootPath,
          ...(input.env ?? {})
        }
      });
    }
  };
}

function createE2BCompatibleWorkspaceFileSystem(service: E2BCompatibleSandboxService): WorkspaceFileSystem {
  return {
    async realpath(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      if (service.realpath) {
        const resolved = await service.realpath({
          sandboxId: parsed.sandboxId,
          path: parsed.remotePath
        });
        return path.posix.join(VIRTUAL_SANDBOX_ROOT, encodeURIComponent(parsed.sandboxId), resolved);
      }

      return targetPath;
    },
    async stat(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      return service.stat({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath
      });
    },
    async readFile(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      return service.readFile({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath
      });
    },
    openReadStream(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      if (service.openReadStream) {
        return service.openReadStream({
          sandboxId: parsed.sandboxId,
          path: parsed.remotePath
        });
      }

      return Readable.from(
        (async function* () {
          yield await service.readFile({
            sandboxId: parsed.sandboxId,
            path: parsed.remotePath
          });
        })()
      );
    },
    async readdir(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      return service.readdir({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath
      });
    },
    async readdirPage(targetPath, input) {
      const parsed = parseVirtualSandboxPath(targetPath);
      if (service.readdirPage) {
        return service.readdirPage({
          sandboxId: parsed.sandboxId,
          path: parsed.remotePath,
          pageSize: input.pageSize,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
          includeMetadata: input.includeMetadata,
          includeDirectoryDescendantUpdatedAt: input.includeDirectoryDescendantUpdatedAt
        });
      }

      const entries = await service.readdir({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath
      });
      const startIndex = Number.parseInt(input.cursor ?? "0", 10);
      const sortedEntries = [...entries].sort((left, right) => {
        const typeComparison =
          input.sortBy === "type" ? (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1) : 0;
        const comparison = typeComparison || left.name.localeCompare(right.name);
        return input.sortOrder === "desc" ? comparison * -1 : comparison;
      });
      const items = sortedEntries.slice(startIndex, startIndex + input.pageSize);
      const nextCursor = startIndex + input.pageSize < sortedEntries.length ? String(startIndex + input.pageSize) : undefined;
      return nextCursor ? { items, nextCursor } : { items };
    },
    async mkdir(targetPath, options) {
      const parsed = parseVirtualSandboxPath(targetPath);
      await service.mkdir({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath,
        recursive: options?.recursive
      });
    },
    async writeFile(targetPath, data, options) {
      const parsed = parseVirtualSandboxPath(targetPath);
      await service.writeFile({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath,
        data,
        ...(typeof options?.mtimeMs === "number" ? { mtimeMs: options.mtimeMs } : {})
      });
    },
    async rm(targetPath, options) {
      const parsed = parseVirtualSandboxPath(targetPath);
      await service.rm({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath,
        recursive: options?.recursive,
        force: options?.force
      });
    },
    async rename(sourcePath, targetPath) {
      const source = parseVirtualSandboxPath(sourcePath);
      const target = parseVirtualSandboxPath(targetPath);
      if (source.sandboxId !== target.sandboxId) {
        throw new Error("Cross-sandbox rename is not supported.");
      }

      await service.rename({
        sandboxId: source.sandboxId,
        sourcePath: source.remotePath,
        targetPath: target.remotePath
      });
    }
  };
}

export function createE2BCompatibleSandboxHost(options: {
  service: E2BCompatibleSandboxService;
  diagnostics?: Record<string, unknown> | undefined;
  providerKind?: "self_hosted" | "e2b" | undefined;
}): SandboxHost {
  const workspaceCommandExecutor = createE2BCompatibleWorkspaceCommandExecutor(options.service);
  const workspaceFileSystem = createE2BCompatibleWorkspaceFileSystem(options.service);
  const providerKind = options.providerKind ?? "e2b";
  const workspaceExecutionProvider: WorkspaceExecutionProvider = {
    async acquire(input) {
      const lease = await options.service.acquireExecution(input);
      return {
        workspace: {
          ...input.workspace,
          rootPath: toVirtualWorkspaceRoot(lease)
        },
        async release(releaseOptions?: { dirty?: boolean | undefined }) {
          await lease.release(releaseOptions);
        }
      } satisfies WorkspaceExecutionLease;
    }
  };
  const workspaceFileAccessProvider: WorkspaceFileAccessProvider = {
    async acquire(input) {
      const lease = await options.service.acquireFileAccess(input);
      return {
        workspace: {
          ...input.workspace,
          rootPath: toVirtualWorkspaceRoot(lease)
        },
        async release(releaseOptions?: { dirty?: boolean | undefined }) {
          await lease.release(releaseOptions);
        }
      } satisfies WorkspaceFileAccessLease;
    }
  };

  return {
    providerKind,
    workspaceCommandExecutor,
    workspaceFileSystem,
    workspaceExecutionProvider,
    workspaceFileAccessProvider,
    diagnostics() {
      const topology = describeSandboxTopology(providerKind);
      return {
        executionModel: topology.executionModel,
        workerPlacement: topology.workerPlacement,
        ...(options.diagnostics ?? {}),
        ...(options.service.diagnostics ? options.service.diagnostics() : {})
      };
    },
    async maintain({ idleBefore }) {
      await options.service.maintain?.({ idleBefore });
    },
    async beginDrain() {
      await options.service.beginDrain?.();
    },
    async close() {
      await options.service.close();
    },
    async deleteWorkspace(workspace) {
      await options.service.deleteWorkspace?.(workspace);
    }
  };
}
