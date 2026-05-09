import { constants as fsConstants } from "node:fs";
import { access, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ServerConfig } from "@oah/config";

import { resolveRuntimeStateDir } from "./engine-state-paths.js";

export function resolveRuntimeUploadCacheDir(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">
): string {
  return resolveRuntimeUploadCacheDirs(paths)[0]!;
}

export function resolveRuntimeUploadCacheDirs(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">
): string[] {
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

export async function prepareRuntimeUploadCacheDir(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">
): Promise<string> {
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

export async function runtimeExistsInUploadCache(
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

export async function removeRuntimeFromUploadCaches(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "runtime_state_dir">,
  runtimeName: string
): Promise<void> {
  await Promise.all(
    resolveRuntimeUploadCacheDirs(paths).map(async (runtimeCacheDir) => {
      await rm(path.join(runtimeCacheDir, runtimeName), { recursive: true, force: true });
    })
  );
}

export async function resolveRuntimeSourceDirForBootstrap(
  runtimeName: string,
  paths: Pick<ServerConfig["paths"], "runtime_dir" | "workspace_dir" | "runtime_state_dir">,
  useRuntimeUploadCache: boolean,
  objectStorage: ServerConfig["object_storage"] | undefined,
  objectStorageModule: typeof import("../object-storage.js") | undefined
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
