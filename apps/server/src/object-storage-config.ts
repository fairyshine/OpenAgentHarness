export const DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_DIRECTORY_SYNC_CONCURRENCY = 8;
const DEFAULT_OBJECT_STORAGE_BUNDLE_MODE = "auto";
const DEFAULT_OBJECT_STORAGE_BUNDLE_MIN_FILE_COUNT = 16;
const DEFAULT_OBJECT_STORAGE_BUNDLE_MIN_TOTAL_BYTES = 128 * 1024;
const DEFAULT_NATIVE_INLINE_UPLOAD_THRESHOLD_BYTES = 128 * 1024;
const DEFAULT_OBJECT_STORAGE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_OBJECT_STORAGE_MAX_ATTEMPTS = 3;
const DEFAULT_OBJECT_STORAGE_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DEFAULT_OBJECT_STORAGE_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OBJECT_STORAGE_SYNC_MANIFEST_SHARD_FILE_COUNT = 10_000;

const trustedManagedObjectStoragePrefixes = new Set<string>();

export interface LocalDirectorySyncBudgetSnapshot {
  files: Map<string, { size: number }>;
  emptyDirectories: Set<string>;
}

export function resolveDirectorySyncConcurrency(): number {
  const raw = process.env.OAH_OBJECT_STORAGE_SYNC_CONCURRENCY;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_DIRECTORY_SYNC_CONCURRENCY;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIRECTORY_SYNC_CONCURRENCY;
}

function resolveObjectStorageBundleMode(): "off" | "auto" | "force" {
  const raw = process.env.OAH_OBJECT_STORAGE_SYNC_BUNDLE?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_OBJECT_STORAGE_BUNDLE_MODE as "auto";
  }

  if (["0", "false", "off", "no", "disabled"].includes(raw)) {
    return "off";
  }

  if (["1", "true", "on", "yes", "enabled", "force"].includes(raw)) {
    return "force";
  }

  return "auto";
}

function resolvePositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveObjectStorageRequestTimeoutMs(): number {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_REQUEST_TIMEOUT_MS") ?? DEFAULT_OBJECT_STORAGE_REQUEST_TIMEOUT_MS;
}

export function resolveObjectStorageMaxAttempts(): number {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_MAX_ATTEMPTS") ?? DEFAULT_OBJECT_STORAGE_MAX_ATTEMPTS;
}

export function resolveObjectStorageMultipartThresholdBytes(): number {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_MULTIPART_THRESHOLD_BYTES") ?? DEFAULT_OBJECT_STORAGE_MULTIPART_THRESHOLD_BYTES;
}

export function resolveObjectStorageMultipartPartSizeBytes(): number {
  const minimumPartSize = 5 * 1024 * 1024;
  return Math.max(
    minimumPartSize,
    resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_MULTIPART_PART_SIZE_BYTES") ?? DEFAULT_OBJECT_STORAGE_MULTIPART_PART_SIZE_BYTES
  );
}

function resolveObjectStorageSyncMaxObjects(): number | undefined {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_SYNC_MAX_OBJECTS");
}

function resolveObjectStorageSyncMaxBytes(): number | undefined {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_SYNC_MAX_BYTES");
}

function resolveObjectStorageSyncMaxFileBytes(): number | undefined {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_SYNC_MAX_FILE_BYTES");
}

export function hasObjectStorageSyncBudgetPolicy(): boolean {
  return (
    resolveObjectStorageSyncMaxObjects() !== undefined ||
    resolveObjectStorageSyncMaxBytes() !== undefined ||
    resolveObjectStorageSyncMaxFileBytes() !== undefined
  );
}

export function resolveObjectStorageSyncManifestShardFileCount(): number {
  return (
    resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_SYNC_MANIFEST_SHARD_FILE_COUNT") ??
    DEFAULT_OBJECT_STORAGE_SYNC_MANIFEST_SHARD_FILE_COUNT
  );
}

export function createObjectStorageSyncBudget(label: string): {
  observeObject(count?: number): void;
  observeBytes(count: number): void;
  observeFile(relativePath: string, size: number): void;
} {
  const maxObjects = resolveObjectStorageSyncMaxObjects();
  const maxBytes = resolveObjectStorageSyncMaxBytes();
  const maxFileBytes = resolveObjectStorageSyncMaxFileBytes();
  let objectCount = 0;
  let byteCount = 0;

  return {
    observeObject(count = 1): void {
      objectCount += count;
      if (maxObjects !== undefined && objectCount > maxObjects) {
        throw new Error(`${label} exceeded object storage sync object limit ${maxObjects}.`);
      }
    },
    observeBytes(count: number): void {
      if (!Number.isFinite(count) || count <= 0) {
        return;
      }
      byteCount += count;
      if (maxBytes !== undefined && byteCount > maxBytes) {
        throw new Error(`${label} exceeded object storage sync byte limit ${maxBytes}.`);
      }
    },
    observeFile(relativePath: string, size: number): void {
      if (!Number.isFinite(size) || size < 0) {
        return;
      }
      if (maxFileBytes !== undefined && size > maxFileBytes) {
        throw new Error(
          `${label} file ${relativePath || "."} exceeded object storage sync single-file limit ${maxFileBytes}.`
        );
      }
    }
  };
}

export function enforceLocalDirectorySyncBudget(snapshot: LocalDirectorySyncBudgetSnapshot, label: string): void {
  const budget = createObjectStorageSyncBudget(label);
  for (const [relativePath, file] of snapshot.files.entries()) {
    budget.observeObject();
    budget.observeBytes(file.size);
    budget.observeFile(relativePath, file.size);
  }

  budget.observeObject(snapshot.emptyDirectories.size);
}

export function resolveObjectStorageBundleConfig(): {
  mode: "off" | "auto" | "force";
  minFileCount: number;
  minTotalBytes: number;
  layout: "sidecar" | "primary";
} {
  const layout = process.env.OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT?.trim().toLowerCase() === "primary" ? "primary" : "sidecar";
  return {
    mode: resolveObjectStorageBundleMode(),
    minFileCount: resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_MIN_FILE_COUNT") ?? DEFAULT_OBJECT_STORAGE_BUNDLE_MIN_FILE_COUNT,
    minTotalBytes: resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_MIN_TOTAL_BYTES") ?? DEFAULT_OBJECT_STORAGE_BUNDLE_MIN_TOTAL_BYTES,
    layout
  };
}

export function shouldTrustManagedObjectStoragePrefixes(): boolean {
  const raw = process.env.OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES?.trim().toLowerCase();
  return raw ? ["1", "true", "on", "yes", "enabled"].includes(raw) : false;
}

export function shouldAssumeEmptyTrustedManagedObjectStoragePrefix(remotePrefix: string): boolean {
  if (!shouldTrustManagedObjectStoragePrefixes() || trustedManagedObjectStoragePrefixes.has(remotePrefix)) {
    return false;
  }
  trustedManagedObjectStoragePrefixes.add(remotePrefix);
  return true;
}

export function resolveNativeInlineUploadThresholdBytes(): number {
  return (
    resolvePositiveIntegerEnv("OAH_NATIVE_WORKSPACE_SYNC_INLINE_UPLOAD_THRESHOLD_BYTES") ??
    DEFAULT_NATIVE_INLINE_UPLOAD_THRESHOLD_BYTES
  );
}

export function resolveObjectStorageBundleTimeoutMs(): number {
  const raw = process.env.OAH_OBJECT_STORAGE_SYNC_BUNDLE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS;
}
