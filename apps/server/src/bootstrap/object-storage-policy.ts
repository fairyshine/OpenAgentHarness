import path from "node:path";

import {
  normalizeObjectStorageConfig,
  resolveObjectStorageMirrorPaths,
  resolveObjectStorageWorkspaceBackingStore,
  type ObjectStorageConfig,
  type ServerConfig
} from "@oah/config";

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll(path.sep, "/").replace(/^\/+|\/+$/g, "");
}

function resolveWorkspaceBackingKeyPrefix(config: ObjectStorageConfig): string {
  return normalizePrefix(resolveObjectStorageWorkspaceBackingStore(config).keyPrefix);
}

export function resolveMirroredObjectStoragePaths(
  config: ObjectStorageConfig
): NonNullable<ObjectStorageConfig["managed_paths"]> {
  return resolveObjectStorageMirrorPaths(config);
}

export function resolveObjectStorageMirrorConfig(config: ObjectStorageConfig): ObjectStorageConfig {
  const normalized = normalizeObjectStorageConfig(config);
  return {
    ...normalized,
    sync_on_boot: normalized.mirrors?.sync_on_boot ?? true,
    sync_on_change: normalized.mirrors?.sync_on_change ?? true,
    poll_interval_ms: normalized.mirrors?.poll_interval_ms ?? 5000,
    managed_paths: resolveMirroredObjectStoragePaths(normalized),
    key_prefixes: {
      ...(normalized.key_prefixes ?? {}),
      workspace: resolveWorkspaceBackingKeyPrefix(normalized),
      ...(normalized.mirrors?.key_prefixes ?? {})
    }
  };
}

export function objectStorageBacksManagedWorkspaces(config: Pick<ServerConfig, "object_storage">): boolean {
  const objectStorage = config.object_storage;
  if (!objectStorage) {
    return false;
  }
  return resolveObjectStorageWorkspaceBackingStore(objectStorage).enabled;
}

export function resolveManagedWorkspaceExternalRef(
  rootPath: string,
  kind: "project",
  config: Pick<ServerConfig, "paths" | "object_storage">
): string | undefined {
  if (kind !== "project" || !config.object_storage || !objectStorageBacksManagedWorkspaces(config)) {
    return undefined;
  }

  const relative = path.relative(config.paths.workspace_dir, rootPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  const workspacePrefix = resolveWorkspaceBackingKeyPrefix(config.object_storage);
  const normalizedRelative = normalizeRelativePath(relative);
  if (!normalizedRelative) {
    return undefined;
  }

  return `s3://${config.object_storage.bucket}/${workspacePrefix}/${normalizedRelative}`;
}

export function describeObjectStoragePolicy(config: Pick<ServerConfig, "object_storage">): {
  mirroredPaths: string[];
  workspaceBackingStoreEnabled: boolean;
} {
  const objectStorage = config.object_storage;
  return {
    mirroredPaths: objectStorage ? resolveMirroredObjectStoragePaths(objectStorage) : [],
    workspaceBackingStoreEnabled: objectStorageBacksManagedWorkspaces(config)
  };
}
