import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";

import type { ServerConfig } from "@oah/config";
import { parseCursor } from "@oah/engine-core";
import type { WorkspaceRecord, WorkspaceRepository } from "@oah/engine-core";

export type PlatformAgentRegistry = Record<string, import("@oah/config").DiscoveredAgent>;
type DiscoveredWorkspace = import("@oah/config").DiscoveredWorkspace;

let workspaceConfigModulePromise: Promise<typeof import("@oah/config")> | undefined;

function loadWorkspaceConfigModule(): Promise<typeof import("@oah/config")> {
  workspaceConfigModulePromise ??= import("@oah/config");
  return workspaceConfigModulePromise;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function workspaceDiscoveryKey(workspace: Pick<WorkspaceRecord, "kind" | "rootPath">): string {
  return `${workspace.kind}:${path.resolve(workspace.rootPath)}`;
}

function isManagedDirectoryWorkspaceName(workspace: Pick<WorkspaceRecord, "name" | "rootPath">): boolean {
  const rootName = path.basename(path.resolve(workspace.rootPath));
  return workspace.name === rootName && /^ws_[a-f0-9]{32}$/i.test(workspace.name);
}

function resolveReconciledWorkspaceName(discovered: WorkspaceRecord, persisted: WorkspaceRecord): string {
  if (isManagedDirectoryWorkspaceName(persisted) && !isManagedDirectoryWorkspaceName(discovered)) {
    return discovered.name;
  }

  return persisted.name;
}

export function isManagedWorkspace(
  workspace: Pick<WorkspaceRecord, "kind" | "rootPath">,
  paths: Pick<ServerConfig["paths"], "workspace_dir">
): boolean {
  return isManagedWorkspaceRoot(workspace.rootPath, paths.workspace_dir);
}

export function hasPersistedWorkspaceListing(
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

export function hasWorkspaceSnapshotListing(
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

export async function listAllWorkspaces(repository: WorkspaceRepository): Promise<WorkspaceRecord[]> {
  const workspaces: WorkspaceRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await repository.list(100, cursor);
    workspaces.push(...page);
    cursor = page.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
  } while (cursor);

  return workspaces;
}

export function reconcileDiscoveredWorkspaces(
  discoveredWorkspaces: WorkspaceRecord[],
  persistedWorkspaces: WorkspaceRecord[]
): WorkspaceRecord[] {
  const persistedByKey = new Map<string, WorkspaceRecord[]>();
  for (const workspace of persistedWorkspaces) {
    const key = workspaceDiscoveryKey(workspace);
    const existing = persistedByKey.get(key) ?? [];
    existing.push(workspace);
    persistedByKey.set(key, existing);
  }

  return discoveredWorkspaces.map((workspace) => {
    const persistedGroup = persistedByKey.get(workspaceDiscoveryKey(workspace)) ?? [];
    const persisted = persistedGroup.find((candidate) => candidate.id === workspace.id) ?? persistedGroup[0];
    if (!persisted) {
      return workspace;
    }

    return {
      ...workspace,
      id: persisted.id,
      name: resolveReconciledWorkspaceName(workspace, persisted),
      executionPolicy: persisted.executionPolicy,
      status: persisted.status,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      ...(persisted.ownerId ? { ownerId: persisted.ownerId } : {}),
      ...(persisted.serviceName ? { serviceName: persisted.serviceName } : {}),
      ...(persisted.runtime ? { runtime: persisted.runtime } : {}),
      ...(persisted.externalRef ? { externalRef: persisted.externalRef } : {})
    };
  });
}

export function findManagedWorkspaceIdsToDelete(
  discoveredWorkspaces: WorkspaceRecord[],
  persistedWorkspaces: WorkspaceRecord[],
  paths: Pick<ServerConfig["paths"], "workspace_dir">
): string[] {
  const discoveredKeys = new Set(discoveredWorkspaces.map((workspace) => workspaceDiscoveryKey(workspace)));
  const canonicalWorkspaceIds = new Set(
    reconcileDiscoveredWorkspaces(discoveredWorkspaces, persistedWorkspaces).map((workspace) => workspace.id)
  );

  return persistedWorkspaces
    .filter((workspace) => isManagedWorkspace(workspace, paths))
    .filter((workspace) => {
      const key = workspaceDiscoveryKey(workspace);
      return !discoveredKeys.has(key) || !canonicalWorkspaceIds.has(workspace.id);
    })
    .map((workspace) => workspace.id);
}

export function isManagedWorkspaceRoot(workspaceRoot: string, managedWorkspaceDir: string): boolean {
  const relativePath = path.relative(path.resolve(managedWorkspaceDir), path.resolve(workspaceRoot));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

const PRUNABLE_MANAGED_WORKSPACE_ROOT_TOP_LEVEL_NAMES = new Set([".openharness", "AGENTS.md"]);

export async function isPrunableManagedWorkspaceRootShell(workspaceRoot: string): Promise<boolean> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);
  return entries.every((entry) => PRUNABLE_MANAGED_WORKSPACE_ROOT_TOP_LEVEL_NAMES.has(entry.name));
}

export async function pruneOrphanedManagedWorkspaceRootShells(input: {
  workspaceDir: string;
  persistedWorkspaces: Pick<WorkspaceRecord, "id" | "rootPath">[];
}): Promise<string[]> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const persistedRootPaths = new Set(
    input.persistedWorkspaces
      .filter((workspace) => isManagedWorkspaceRoot(workspace.rootPath, workspaceDir))
      .map((workspace) => path.resolve(workspace.rootPath))
  );
  const persistedWorkspaceIds = new Set(input.persistedWorkspaces.map((workspace) => workspace.id));
  const entries = await readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  const removedPaths: string[] = [];

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ws_"))
      .map(async (entry) => {
        const rootPath = path.join(workspaceDir, entry.name);
        if (persistedRootPaths.has(path.resolve(rootPath)) || persistedWorkspaceIds.has(entry.name)) {
          return;
        }

        if (!(await isPrunableManagedWorkspaceRootShell(rootPath))) {
          return;
        }

        await rm(rootPath, { recursive: true, force: true });
        removedPaths.push(rootPath);
      })
  );

  return removedPaths.sort((left, right) => left.localeCompare(right));
}

export async function discoverProjectWorkspaces(input: {
  workspaceDir: string;
  models: Awaited<ReturnType<typeof import("@oah/config").loadPlatformModels>>;
  platformAgents: PlatformAgentRegistry;
  platformSkillDir: string;
  platformToolDir: string;
  onError?: ((input: { rootPath: string; kind: "project"; error: unknown }) => void) | undefined;
}): Promise<DiscoveredWorkspace[]> {
  const { discoverWorkspace } = await loadWorkspaceConfigModule();
  const entries = await readdir(input.workspaceDir, {
    withFileTypes: true
  }).catch(() => []);

  const discovered = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const rootPath = path.join(input.workspaceDir, entry.name);
        try {
          return await discoverWorkspace(rootPath, "project", {
            platformModels: input.models,
            platformAgents: input.platformAgents,
            platformSkillDir: input.platformSkillDir,
            platformToolDir: input.platformToolDir
          } as Parameters<typeof discoverWorkspace>[2]);
        } catch (error) {
          if (!input.onError) {
            throw error;
          }

          input.onError({
            rootPath,
            kind: "project",
            error
          });
          return undefined;
        }
      })
  );

  return discovered
    .filter(isDefined)
    .sort((left, right) => left.rootPath.localeCompare(right.rootPath));
}

export interface FsWatcherErrorDetails {
  targetPath: string;
  error: unknown;
  recoverable: boolean;
}

export interface OpenFsWatcherOptions {
  recursive?: boolean | undefined;
  onError?: ((details: FsWatcherErrorDetails) => void) | undefined;
}

const RECOVERABLE_FS_WATCHER_ERROR_CODES = new Set(["ENOENT", "ENOTDIR", "EPERM", "EACCES", "EBUSY"]);

function fsWatcherErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function isRecoverableFsWatcherError(error: unknown): boolean {
  const code = fsWatcherErrorCode(error);
  return code !== undefined && RECOVERABLE_FS_WATCHER_ERROR_CODES.has(code);
}

export function closeFsWatcher(watcher: FSWatcher | undefined): void {
  try {
    watcher?.close();
  } catch {
    // Closing an already-failed watcher can throw on some platforms.
  }
}

function notifyFsWatcherChange(targetPath: string, onChange: () => void): void {
  try {
    onChange();
  } catch (error) {
    console.warn(`[oah-bootstrap] File watcher change handler failed for ${targetPath}.`, error);
  }
}

export function attachFsWatcherSafetyHandlers(
  watcher: FSWatcher,
  targetPath: string,
  onChange: () => void,
  onError?: ((details: FsWatcherErrorDetails) => void) | undefined
): FSWatcher {
  watcher.on("error", (error) => {
    const recoverable = isRecoverableFsWatcherError(error);
    closeFsWatcher(watcher);

    try {
      onError?.({
        targetPath,
        error,
        recoverable
      });
    } catch (handlerError) {
      console.warn(`[oah-bootstrap] File watcher error handler failed for ${targetPath}.`, handlerError);
    }

    if (!recoverable) {
      console.warn(`[oah-bootstrap] File watcher failed for ${targetPath}.`, error);
    }

    notifyFsWatcherChange(targetPath, onChange);
  });

  return watcher;
}

export function openFsWatcher(
  targetPath: string,
  onChange: () => void,
  options: OpenFsWatcherOptions | boolean = {}
): FSWatcher | undefined {
  const resolvedOptions: OpenFsWatcherOptions = typeof options === "boolean" ? { recursive: options } : options;
  const recursive = resolvedOptions.recursive ?? false;
  const createWatcher = (watchRecursive: boolean): FSWatcher => {
    const watcher = attachFsWatcherSafetyHandlers(
      watch(
        targetPath,
        {
          persistent: false,
          ...(watchRecursive ? { recursive: true } : {})
        },
        () => notifyFsWatcherChange(targetPath, onChange)
      ),
      targetPath,
      onChange,
      resolvedOptions.onError
    );

    void access(targetPath).catch((error) => {
      if (!isRecoverableFsWatcherError(error)) {
        return;
      }

      closeFsWatcher(watcher);
      try {
        resolvedOptions.onError?.({
          targetPath,
          error,
          recoverable: true
        });
      } catch (handlerError) {
        console.warn(`[oah-bootstrap] File watcher error handler failed for ${targetPath}.`, handlerError);
      }
      notifyFsWatcherChange(targetPath, onChange);
    });

    return watcher;
  };

  try {
    return createWatcher(recursive);
  } catch (error) {
    if (!isRecoverableFsWatcherError(error)) {
      console.warn(`[oah-bootstrap] File watcher failed to open for ${targetPath}.`, error);
    }
    if (!recursive) {
      return undefined;
    }

    try {
      return createWatcher(false);
    } catch (fallbackError) {
      if (!isRecoverableFsWatcherError(fallbackError)) {
        console.warn(`[oah-bootstrap] File watcher failed to open for ${targetPath}.`, fallbackError);
      }
      return undefined;
    }
  }
}
