import path from "node:path";

import { resolveObjectStorageSyncManifestShardFileCount } from "./object-storage-config.js";
import {
  OBJECT_MTIME_METADATA_KEY,
  type DirectoryObjectStore,
  type DirectorySyncOptions,
  type LocalDirectorySnapshot,
  type ObjectStorageEntry
} from "./object-storage-types.js";

export interface DirectorySyncManifestFileEntry {
  size: number;
  mtimeMs: number;
}

export interface DirectorySyncManifestDocument {
  version: 1;
  files: Record<string, DirectorySyncManifestFileEntry>;
  emptyDirectories?: string[] | undefined;
  storageMode?: "objects" | "bundle" | undefined;
  manifestShards?: string[] | undefined;
}

export const INTERNAL_SYNC_MANIFEST_RELATIVE_PATH = ".oah-sync-manifest.json";
export const INTERNAL_SYNC_MANIFEST_SHARD_PREFIX = ".oah-sync-manifest-shards";
export const INTERNAL_SYNC_BUNDLE_RELATIVE_PATH = ".oah-sync-bundle.tar";

export function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

export function normalizeRelativePath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\/+|\/+$/g, "");
}

export function buildRemoteKey(prefix: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return prefix.length === 0 ? normalizedRelativePath : `${prefix}/${normalizedRelativePath}`;
}

export function relativePathFromRemoteKey(prefix: string, key: string): string | undefined {
  if (prefix.length === 0) {
    return normalizeRelativePath(key);
  }

  if (key === prefix) {
    return "";
  }

  if (!key.startsWith(`${prefix}/`)) {
    return undefined;
  }

  return normalizeRelativePath(key.slice(prefix.length + 1));
}

export function shouldIgnoreRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }

  if (normalized === INTERNAL_SYNC_MANIFEST_RELATIVE_PATH) {
    return true;
  }
  if (normalized === INTERNAL_SYNC_MANIFEST_SHARD_PREFIX || normalized.startsWith(`${INTERNAL_SYNC_MANIFEST_SHARD_PREFIX}/`)) {
    return true;
  }
  if (normalized === INTERNAL_SYNC_BUNDLE_RELATIVE_PATH) {
    return true;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "__pycache__")) {
    return true;
  }

  const basename = segments.at(-1) ?? normalized;
  return (
    basename === ".DS_Store" ||
    basename.endsWith(".pyc") ||
    basename.endsWith(".db-shm") ||
    basename.endsWith(".db-wal")
  );
}

export function parseObjectMtimeMs(metadata: Record<string, string> | undefined): number | undefined {
  const raw = metadata?.[OBJECT_MTIME_METADATA_KEY];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.trunc(parsed);
}

export function isDirectorySyncManifestFileEntry(value: unknown): value is DirectorySyncManifestFileEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    "mtimeMs" in value &&
    typeof value.mtimeMs === "number" &&
    Number.isFinite(value.mtimeMs) &&
    value.mtimeMs > 0
  );
}

export function buildDirectorySyncManifestFromFiles(
  files: Iterable<{ relativePath: string; size: number; mtimeMs: number }>,
  options?: {
    emptyDirectories?: Iterable<string> | undefined;
    storageMode?: "objects" | "bundle" | undefined;
  }
): DirectorySyncManifestDocument {
  const normalizedFiles = [...files]
    .map((file) => ({
      relativePath: normalizeRelativePath(file.relativePath),
      size: file.size,
      mtimeMs: Math.trunc(file.mtimeMs)
    }))
    .filter((file) => file.relativePath.length > 0 && !shouldIgnoreRelativePath(file.relativePath))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    version: 1,
    files: Object.fromEntries(
      normalizedFiles.map((file) => [
        file.relativePath,
        {
          size: file.size,
          mtimeMs: file.mtimeMs
        } satisfies DirectorySyncManifestFileEntry
      ])
    ),
    ...(options?.emptyDirectories
      ? {
          emptyDirectories: [...options.emptyDirectories]
            .map((relativePath) => normalizeRelativePath(relativePath))
            .filter((relativePath) => relativePath.length > 0 && !shouldIgnoreRelativePath(relativePath))
            .sort((left, right) => left.localeCompare(right))
        }
      : {}),
    ...(options?.storageMode ? { storageMode: options.storageMode } : {})
  };
}

function isDirectorySyncManifestDocument(value: unknown): value is DirectorySyncManifestDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "files" in value &&
    typeof value.files === "object" &&
    value.files !== null
  );
}

function buildRemoteDirectorySyncManifestShardKey(remotePrefix: string, shardIndex: number): string {
  return buildRemoteKey(remotePrefix, `${INTERNAL_SYNC_MANIFEST_SHARD_PREFIX}/${String(shardIndex).padStart(5, "0")}.json`);
}

function buildDirectorySyncManifestShardDocument(
  files: Iterable<readonly [string, DirectorySyncManifestFileEntry]>
): DirectorySyncManifestDocument {
  return {
    version: 1,
    files: Object.fromEntries(files)
  };
}

export async function loadRemoteDirectorySyncManifestDocument(
  store: DirectoryObjectStore,
  remotePrefix: string,
  remoteEntries?: Iterable<ObjectStorageEntry>
): Promise<DirectorySyncManifestDocument | undefined> {
  try {
    const manifestKey = buildRemoteKey(remotePrefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);
    if (remoteEntries) {
      let manifestPresent = false;
      for (const entry of remoteEntries) {
        if (entry.key === manifestKey) {
          manifestPresent = true;
          break;
        }
      }
      if (!manifestPresent) {
        return undefined;
      }
    }
    const manifestObject = await store.getObject(manifestKey);
    const parsed = JSON.parse(manifestObject.body.toString("utf8")) as Partial<DirectorySyncManifestDocument>;
    if (!isDirectorySyncManifestDocument(parsed)) {
      return undefined;
    }

    const manifestShards = (parsed.manifestShards ?? [])
      .map((key) => (typeof key === "string" ? key : ""))
      .filter((key) => key.length > 0);
    if (manifestShards.length === 0) {
      return parsed;
    }

    const files: Record<string, DirectorySyncManifestFileEntry> = { ...parsed.files };
    for (const shardKey of manifestShards) {
      const shardObject = await store.getObject(shardKey);
      const shard = JSON.parse(shardObject.body.toString("utf8")) as Partial<DirectorySyncManifestDocument>;
      if (!isDirectorySyncManifestDocument(shard)) {
        return undefined;
      }
      Object.assign(files, shard.files);
    }
    return {
      ...parsed,
      files,
      manifestShards
    };
  } catch {
    return undefined;
  }
}

export async function loadRemoteDirectorySyncManifest(
  store: DirectoryObjectStore,
  remotePrefix: string,
  remoteEntries?: Iterable<ObjectStorageEntry>
): Promise<Map<string, DirectorySyncManifestFileEntry>> {
  const document = await loadRemoteDirectorySyncManifestDocument(store, remotePrefix, remoteEntries);
  if (!document) {
    return new Map();
  }

  return new Map(
    Object.entries(document.files)
      .map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
      .filter(
        (entry): entry is readonly [string, DirectorySyncManifestFileEntry] =>
          entry[0].length > 0 && isDirectorySyncManifestFileEntry(entry[1])
      )
  );
}

export async function writeRemoteDirectorySyncManifest(input: {
  store: DirectoryObjectStore;
  remotePrefix: string;
  files: Iterable<{ relativePath: string; size: number; mtimeMs: number }>;
  emptyDirectories?: Iterable<string> | undefined;
  storageMode?: "objects" | "bundle" | undefined;
  existingManifest?: Map<string, DirectorySyncManifestFileEntry> | undefined;
  existingManifestDocument?: DirectorySyncManifestDocument | undefined;
}): Promise<void> {
  const manifest = buildDirectorySyncManifestFromFiles(input.files, {
    emptyDirectories: input.emptyDirectories,
    storageMode: input.storageMode
  });
  const normalizedEntries = new Map(
    Object.entries(manifest.files).map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
  );
  const manifestKey = buildRemoteKey(input.remotePrefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);

  const existingShardKeys = input.existingManifestDocument?.manifestShards ?? [];
  if (normalizedEntries.size === 0 && (manifest.emptyDirectories?.length ?? 0) === 0) {
    await input.store.deleteObjects([manifestKey, ...existingShardKeys]);
    return;
  }

  if (
    input.existingManifestDocument &&
    isEquivalentDirectorySyncManifestDocument(input.existingManifestDocument, manifest)
  ) {
    return;
  }

  const shardFileCount = resolveObjectStorageSyncManifestShardFileCount();
  const shouldShard = normalizedEntries.size > shardFileCount;
  if (shouldShard) {
    const sortedEntries = [...normalizedEntries.entries()].sort(([left], [right]) => left.localeCompare(right));
    const shardKeys: string[] = [];
    for (let index = 0; index < sortedEntries.length; index += shardFileCount) {
      const shardIndex = Math.floor(index / shardFileCount);
      const shardKey = buildRemoteDirectorySyncManifestShardKey(input.remotePrefix, shardIndex);
      shardKeys.push(shardKey);
      const shardDocument = buildDirectorySyncManifestShardDocument(sortedEntries.slice(index, index + shardFileCount));
      await input.store.putObject(shardKey, Buffer.from(`${JSON.stringify(shardDocument)}\n`, "utf8"));
    }

    const manifestDocument: DirectorySyncManifestDocument = {
      version: 1,
      files: {},
      ...(manifest.emptyDirectories ? { emptyDirectories: manifest.emptyDirectories } : {}),
      ...(manifest.storageMode ? { storageMode: manifest.storageMode } : {}),
      manifestShards: shardKeys
    };
    await input.store.putObject(manifestKey, Buffer.from(`${JSON.stringify(manifestDocument)}\n`, "utf8"));
    const staleShardKeys = existingShardKeys.filter((key) => !shardKeys.includes(key));
    if (staleShardKeys.length > 0) {
      await input.store.deleteObjects(staleShardKeys);
    }
    return;
  }

  await input.store.putObject(
    manifestKey,
    Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8")
  );
  if (existingShardKeys.length > 0) {
    await input.store.deleteObjects(existingShardKeys);
  }
}

export function isEquivalentDirectorySyncManifestDocument(
  left: DirectorySyncManifestDocument | undefined,
  right: DirectorySyncManifestDocument | undefined
): boolean {
  if (!left || !right) {
    return false;
  }

  const leftEntries = new Map(
    Object.entries(left.files)
      .map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
      .filter(
        (entry): entry is readonly [string, DirectorySyncManifestFileEntry] =>
          entry[0].length > 0 && isDirectorySyncManifestFileEntry(entry[1])
      )
  );
  const rightEntries = new Map(
    Object.entries(right.files)
      .map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
      .filter(
        (entry): entry is readonly [string, DirectorySyncManifestFileEntry] =>
          entry[0].length > 0 && isDirectorySyncManifestFileEntry(entry[1])
      )
  );

  if (leftEntries.size !== rightEntries.size) {
    return false;
  }

  for (const [relativePath, entry] of rightEntries.entries()) {
    const existing = leftEntries.get(relativePath);
    if (existing?.size !== entry.size || existing.mtimeMs !== entry.mtimeMs) {
      return false;
    }
  }

  const normalizeEmptyDirectories = (document: DirectorySyncManifestDocument): string[] =>
    (document.emptyDirectories ?? [])
      .map((relativePath) => normalizeRelativePath(relativePath))
      .filter((relativePath) => relativePath.length > 0 && !shouldIgnoreRelativePath(relativePath))
      .sort((a, b) => a.localeCompare(b));

  const leftEmptyDirectories = normalizeEmptyDirectories(left);
  const rightEmptyDirectories = normalizeEmptyDirectories(right);
  if (
    leftEmptyDirectories.length !== rightEmptyDirectories.length ||
    leftEmptyDirectories.some((relativePath, index) => relativePath !== rightEmptyDirectories[index])
  ) {
    return false;
  }

  return (left.storageMode ?? "objects") === (right.storageMode ?? "objects");
}

export function countManifestFileMutations(
  snapshot: LocalDirectorySnapshot,
  existingManifestDocument?: DirectorySyncManifestDocument
): number {
  const existingEntries = existingManifestDocument
    ? new Map(
        Object.entries(existingManifestDocument.files)
          .map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
          .filter(
            (entry): entry is readonly [string, DirectorySyncManifestFileEntry] =>
              entry[0].length > 0 && isDirectorySyncManifestFileEntry(entry[1])
          )
      )
    : undefined;

  let count = 0;
  for (const [relativePath, file] of snapshot.files.entries()) {
    const existing = existingEntries?.get(relativePath);
    if (!existing || existing.size !== file.size || existing.mtimeMs !== Math.trunc(file.mtimeMs)) {
      count += 1;
    }
  }
  return count;
}

export function countManifestDeletedFiles(
  snapshot: LocalDirectorySnapshot,
  existingManifestDocument?: DirectorySyncManifestDocument
): number {
  if (!existingManifestDocument) {
    return 0;
  }

  const localPaths = new Set(snapshot.files.keys());
  return Object.entries(existingManifestDocument.files)
    .map(([relativePath]) => normalizeRelativePath(relativePath))
    .filter((relativePath) => relativePath.length > 0 && !shouldIgnoreRelativePath(relativePath) && !localPaths.has(relativePath))
    .length;
}

export function countManifestCreatedEmptyDirectories(
  snapshot: LocalDirectorySnapshot,
  existingManifestDocument?: DirectorySyncManifestDocument
): number {
  if (!existingManifestDocument) {
    return snapshot.emptyDirectories.size;
  }

  const existingDirectories = new Set(
    (existingManifestDocument.emptyDirectories ?? [])
      .map((relativePath) => normalizeRelativePath(relativePath))
      .filter((relativePath) => relativePath.length > 0 && !shouldIgnoreRelativePath(relativePath))
  );
  let count = 0;
  for (const relativePath of snapshot.emptyDirectories) {
    if (!existingDirectories.has(relativePath)) {
      count += 1;
    }
  }
  return count;
}

export function buildSyntheticRemoteEntriesFromManifestDocument(
  remotePrefix: string,
  manifestDocument: DirectorySyncManifestDocument,
  options?: DirectorySyncOptions,
  includeBundleMarker?: boolean | undefined
): ObjectStorageEntry[] {
  const entries: ObjectStorageEntry[] = [];

  for (const [relativePath, entry] of Object.entries(manifestDocument.files)) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || !isDirectorySyncManifestFileEntry(entry) || shouldIgnoreRelativePath(normalized)) {
      continue;
    }
    if (options?.excludeRelativePath?.(normalized)) {
      continue;
    }

    entries.push({
      key: buildRemoteKey(remotePrefix, normalized),
      size: entry.size,
      lastModified: new Date(entry.mtimeMs)
    });
  }

  for (const relativePath of manifestDocument.emptyDirectories ?? []) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || shouldIgnoreRelativePath(normalized)) {
      continue;
    }
    if (options?.excludeRelativePath?.(normalized)) {
      continue;
    }

    entries.push({
      key: `${buildRemoteKey(remotePrefix, normalized)}/`,
      size: 0
    });
  }

  if (includeBundleMarker && manifestDocument.storageMode === "bundle") {
    entries.push({
      key: buildRemoteKey(remotePrefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH),
      size: 0
    });
  }

  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export function buildManagedRemoteKeysFromManifestDocument(
  remotePrefix: string,
  manifestDocument: DirectorySyncManifestDocument,
  options?: DirectorySyncOptions
): string[] {
  const keys = new Set(
    buildSyntheticRemoteEntriesFromManifestDocument(remotePrefix, manifestDocument, options, true).map((entry) => entry.key)
  );
  if (manifestDocument.storageMode === "bundle") {
    keys.add(buildRemoteKey(remotePrefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH));
  }
  for (const shardKey of manifestDocument.manifestShards ?? []) {
    keys.add(shardKey);
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}
