import type { ServerConfig } from "./types.js";

export type ObjectStorageConfig = NonNullable<ServerConfig["object_storage"]>;
export type ObjectStorageManagedPath = NonNullable<ObjectStorageConfig["managed_paths"]>[number];
export type ObjectStorageMirrorPath = Exclude<ObjectStorageManagedPath, "workspace">;

const DEFAULT_OBJECT_STORAGE_MANAGED_PATHS = ["workspace", "runtime", "model", "tool", "skill"] as const;
const DEFAULT_OBJECT_STORAGE_MIRROR_PATHS = ["runtime", "model", "tool", "skill"] as const;

function normalizeObjectStoragePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function configuredLegacyObjectStorageManagedPaths(config: ObjectStorageConfig): ObjectStorageManagedPath[] {
  return [...(config.managed_paths ?? DEFAULT_OBJECT_STORAGE_MANAGED_PATHS)];
}

export function usesLegacyObjectStorageCompatibilityFields(config: ObjectStorageConfig): boolean {
  return (
    config.managed_paths !== undefined ||
    config.key_prefixes !== undefined ||
    config.sync_on_boot !== undefined ||
    config.sync_on_change !== undefined ||
    config.poll_interval_ms !== undefined
  );
}

function usesExplicitObjectStorageWorkspaceBackingStore(config: ObjectStorageConfig): boolean {
  return config.workspace_backing_store !== undefined;
}

function usesExplicitObjectStorageMirrors(config: ObjectStorageConfig): boolean {
  return config.mirrors !== undefined;
}

function resolveObjectStorageWorkspaceBackingStore(config: ObjectStorageConfig): {
  enabled: boolean;
  keyPrefix: string;
} {
  if (usesExplicitObjectStorageWorkspaceBackingStore(config)) {
    return {
      enabled: config.workspace_backing_store?.enabled ?? true,
      keyPrefix: normalizeObjectStoragePrefix(config.workspace_backing_store?.key_prefix ?? config.key_prefixes?.workspace ?? "workspace")
    };
  }

  if (config.managed_paths) {
    return {
      enabled: configuredLegacyObjectStorageManagedPaths(config).includes("workspace"),
      keyPrefix: normalizeObjectStoragePrefix(config.key_prefixes?.workspace ?? "workspace")
    };
  }

  if (usesExplicitObjectStorageMirrors(config)) {
    return {
      enabled: false,
      keyPrefix: normalizeObjectStoragePrefix(config.key_prefixes?.workspace ?? "workspace")
    };
  }

  return {
    enabled: true,
    keyPrefix: normalizeObjectStoragePrefix(config.key_prefixes?.workspace ?? "workspace")
  };
}

function resolveObjectStorageMirrorPaths(config: ObjectStorageConfig): ObjectStorageMirrorPath[] {
  if (usesExplicitObjectStorageMirrors(config)) {
    return [...(config.mirrors?.paths ?? DEFAULT_OBJECT_STORAGE_MIRROR_PATHS)];
  }

  if (config.managed_paths) {
    return configuredLegacyObjectStorageManagedPaths(config).filter(
      (managedPath): managedPath is ObjectStorageMirrorPath => managedPath !== "workspace"
    );
  }

  if (usesExplicitObjectStorageWorkspaceBackingStore(config)) {
    return [];
  }

  return [...DEFAULT_OBJECT_STORAGE_MIRROR_PATHS];
}

export function normalizeObjectStorageConfig(config: ObjectStorageConfig): ObjectStorageConfig {
  const workspaceBackingStore = resolveObjectStorageWorkspaceBackingStore(config);
  const mirrorPaths = resolveObjectStorageMirrorPaths(config);
  const legacyKeyPrefixes = config.key_prefixes ?? {};
  const explicitMirrorKeyPrefixes = config.mirrors?.key_prefixes ?? {};

  return {
    ...config,
    workspace_backing_store: {
      enabled: workspaceBackingStore.enabled,
      key_prefix: workspaceBackingStore.keyPrefix
    },
    mirrors: {
      paths: mirrorPaths,
      sync_on_boot: config.mirrors?.sync_on_boot ?? config.sync_on_boot ?? true,
      sync_on_change: config.mirrors?.sync_on_change ?? config.sync_on_change ?? true,
      poll_interval_ms: config.mirrors?.poll_interval_ms ?? config.poll_interval_ms ?? 5000,
      key_prefixes: {
        runtime: normalizeObjectStoragePrefix(explicitMirrorKeyPrefixes.runtime ?? legacyKeyPrefixes.runtime ?? "runtime"),
        model: normalizeObjectStoragePrefix(explicitMirrorKeyPrefixes.model ?? legacyKeyPrefixes.model ?? "model"),
        tool: normalizeObjectStoragePrefix(explicitMirrorKeyPrefixes.tool ?? legacyKeyPrefixes.tool ?? "tool"),
        skill: normalizeObjectStoragePrefix(explicitMirrorKeyPrefixes.skill ?? legacyKeyPrefixes.skill ?? "skill")
      }
    }
  };
}
