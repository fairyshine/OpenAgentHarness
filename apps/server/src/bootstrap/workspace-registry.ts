import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";

import { discoverWorkspace, type DiscoveredWorkspace } from "@oah/config";
import type { ServerConfig } from "@oah/config";
import { parseCursor } from "@oah/runtime-core";
import type { WorkspaceRecord, WorkspaceRepository } from "@oah/runtime-core";

export type PlatformAgentRegistry = Record<string, import("@oah/config").DiscoveredAgent>;

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function workspaceDiscoveryKey(workspace: Pick<WorkspaceRecord, "kind" | "rootPath">): string {
  return `${workspace.kind}:${path.resolve(workspace.rootPath)}`;
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
      name: persisted.name,
      executionPolicy: persisted.executionPolicy,
      status: persisted.status,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
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

export async function discoverProjectWorkspaces(input: {
  workspaceDir: string;
  models: Awaited<ReturnType<typeof import("@oah/config").loadPlatformModels>>;
  platformAgents: PlatformAgentRegistry;
  platformSkillDir: string;
  platformToolDir: string;
  onError?: ((input: { rootPath: string; kind: "project"; error: unknown }) => void) | undefined;
}): Promise<DiscoveredWorkspace[]> {
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

export function openFsWatcher(targetPath: string, onChange: () => void, recursive = false): FSWatcher | undefined {
  try {
    return watch(
      targetPath,
      {
        persistent: false,
        ...(recursive ? { recursive: true } : {})
      },
      () => onChange()
    );
  } catch {
    if (!recursive) {
      return undefined;
    }

    try {
      return watch(
        targetPath,
        {
          persistent: false
        },
        () => onChange()
      );
    } catch {
      return undefined;
    }
  }
}
