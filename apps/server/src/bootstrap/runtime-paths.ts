import path from "node:path";
import { rm } from "node:fs/promises";

import type { ServerConfig } from "@oah/config";
import { sqliteWorkspaceHistoryDbPath } from "@oah/storage-sqlite";
import type { WorkspaceRecord } from "@oah/runtime-core";

import { isManagedWorkspaceRoot } from "./workspace-registry.js";

export interface WorkspaceLocalArtifactCleanupStatus {
  workspaceId: string;
  rootPath: string;
  mode: "workspace_root" | "history_db" | "shadow_history_db" | "none";
  removedPaths: string[];
}

export function resolveRuntimeStateDir(paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">): string {
  return path.resolve(paths.runtime_state_dir ?? path.join(path.dirname(paths.workspace_dir), ".openharness"));
}

export function resolveArchiveExportRoot(paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">): string {
  return path.join(resolveRuntimeStateDir(paths), "archives");
}

export function resolveSqliteShadowRoot(paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">): string {
  return path.join(resolveRuntimeStateDir(paths), "data", "workspace-state");
}

export function resolveWorkspaceMaterializationCacheRoot(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">
): string {
  return path.join(resolveRuntimeStateDir(paths), "__materialized__");
}

export function resolveLegacyWorkspaceMaterializationCacheRoot(workspaceDir: string, workspaceId: string): string {
  return path.join(workspaceDir, ".openharness", "__materialized__", workspaceId);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((targetPath) => path.resolve(targetPath)))];
}

export function resolveWorkspaceLocalCleanupPaths(input: {
  workspace: Pick<WorkspaceRecord, "id" | "rootPath" | "externalRef">;
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">;
}): string[] {
  const cleanupPaths: string[] = [];
  if (isManagedWorkspaceRoot(input.workspace.rootPath, input.paths.workspace_dir)) {
    cleanupPaths.push(input.workspace.rootPath);
  }

  if (input.workspace.externalRef) {
    cleanupPaths.push(path.join(input.paths.workspace_dir, input.workspace.id));
    cleanupPaths.push(path.join(resolveWorkspaceMaterializationCacheRoot(input.paths), input.workspace.id));
    cleanupPaths.push(resolveLegacyWorkspaceMaterializationCacheRoot(input.paths.workspace_dir, input.workspace.id));
  }

  return uniquePaths(cleanupPaths);
}

export async function cleanupWorkspaceLocalArtifacts(input: {
  workspace: WorkspaceRecord;
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">;
  sqliteShadowRoot: string;
}): Promise<WorkspaceLocalArtifactCleanupStatus> {
  const removedPaths: string[] = [];
  const workspaceLocalCleanupPaths = resolveWorkspaceLocalCleanupPaths(input);
  if (workspaceLocalCleanupPaths.length > 0) {
    await Promise.all(
      workspaceLocalCleanupPaths.map(async (targetPath) => {
        await rm(targetPath, {
          recursive: true,
          force: true
        });
        removedPaths.push(targetPath);
      })
    );
  }

  const dbPath = sqliteWorkspaceHistoryDbPath(input.workspace, {
    shadowRoot: input.sqliteShadowRoot
  });
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(`${dbPath}-wal`, { force: true })
  ]);

  const removedShadowDirectory = dbPath.startsWith(`${input.sqliteShadowRoot}${path.sep}`) || dbPath === input.sqliteShadowRoot;
  if (removedShadowDirectory) {
    await rm(path.dirname(dbPath), {
      recursive: true,
      force: true
    });
  }

  removedPaths.push(dbPath, `${dbPath}-shm`, `${dbPath}-wal`);

  return {
    workspaceId: input.workspace.id,
    rootPath: input.workspace.rootPath,
    mode:
      workspaceLocalCleanupPaths.length > 0
        ? "workspace_root"
        : removedShadowDirectory
          ? "shadow_history_db"
          : "history_db",
    removedPaths: uniquePaths(removedPaths)
  };
}
