import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { normalizeObjectStorageConfig, type ServerConfig } from "@oah/config";
import {
  computeNativeDirectoryFingerprint,
  computeNativeDirectoryFingerprintBatch,
  isNativeWorkspaceSyncEnabled,
  planNativeLocalToRemote,
  planNativeRemoteToLocal,
  scanNativeLocalTree,
  syncNativeLocalToRemote,
  syncNativeRemoteToLocal,
  type NativeSyncBundleConfig,
  type NativeWorkspaceSyncObjectStoreConfig
} from "@oah/native-bridge";

import {
  observeNativeWorkspaceSyncOperation,
  recordNativeWorkspaceSyncFallback
} from "./observability/native-workspace-sync.js";
import { recordObjectStorageOperation, type ObjectStorageMetricOperation } from "./observability/object-storage.js";
import {
  DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS,
  createObjectStorageSyncBudget,
  enforceLocalDirectorySyncBudget,
  hasObjectStorageSyncBudgetPolicy,
  resolveDirectorySyncConcurrency,
  resolveNativeInlineUploadThresholdBytes,
  resolveObjectStorageBundleConfig,
  resolveObjectStorageBundleTimeoutMs,
  resolveObjectStorageMaxAttempts,
  resolveObjectStorageMultipartPartSizeBytes,
  resolveObjectStorageMultipartThresholdBytes,
  resolveObjectStorageRequestTimeoutMs,
  resolveObjectStorageSyncManifestShardFileCount,
  shouldAssumeEmptyTrustedManagedObjectStoragePrefix,
  shouldTrustManagedObjectStoragePrefixes
} from "./object-storage-config.js";

type AwsS3Module = typeof import("@aws-sdk/client-s3");
type AwsS3ModuleImport = AwsS3Module | { default?: AwsS3Module | undefined };
type AwsS3ClientLike = {
  send(command: unknown, options?: { abortSignal?: AbortSignal | undefined }): Promise<unknown>;
  destroy(): void;
};

export type ManagedPathKey = "workspace" | "runtime" | "model" | "tool" | "skill";
type ObjectStorageConfig = NonNullable<ServerConfig["object_storage"]> & {
  managed_paths?: ManagedPathKey[] | undefined;
};

interface ObjectStorageEntry {
  key: string;
  size: number;
  lastModified?: Date | undefined;
}

export interface DirectoryObjectStore {
  listEntries(prefix: string): Promise<ObjectStorageEntry[]>;
  listEntriesPaged?(prefix: string): AsyncIterable<ObjectStorageEntry[]>;
  getObjectInfo?(
    key: string
  ): Promise<{ size?: number | undefined; lastModified?: Date | undefined; metadata?: Record<string, string> | undefined }>;
  getObject(key: string): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }>;
  getObjectStream?(key: string): Promise<{ body: NodeJS.ReadableStream; metadata?: Record<string, string> | undefined }>;
  getObjectToFile?(key: string, targetPath: string): Promise<{ metadata?: Record<string, string> | undefined }>;
  putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void>;
  putObjectFromStream?(key: string, body: NodeJS.ReadableStream, options?: { mtimeMs?: number | undefined }): Promise<void>;
  putObjectFromFile?(key: string, filePath: string, options?: { mtimeMs?: number | undefined }): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  deletePrefix?(prefix: string): Promise<number>;
  getNativeWorkspaceSyncConfig?(): NativeWorkspaceSyncObjectStoreConfig | undefined;
  bucket?: string | undefined;
}

export interface DirectorySyncResult {
  localFingerprint: string;
  uploadedFileCount: number;
  deletedRemoteCount: number;
  createdEmptyDirectoryCount: number;
  requestCounts?: ObjectStoreRequestCounts | undefined;
  phaseTimings?: DirectorySyncPhaseTimings | undefined;
  bridgeTimings?: DirectorySyncBridgeTimings | undefined;
  workerTimings?: DirectorySyncWorkerTimings | undefined;
  wrapperTimings?: DirectorySyncWrapperTimings | undefined;
}

export interface RemoteToLocalDirectorySyncResult {
  localFingerprint?: string | undefined;
  removedPathCount: number;
  createdDirectoryCount: number;
  downloadedFileCount: number;
  requestCounts?: ObjectStoreRequestCounts | undefined;
  phaseTimings?: RemoteToLocalDirectorySyncPhaseTimings | undefined;
}

export interface ObjectStoreRequestCounts {
  listRequests: number;
  getRequests: number;
  headRequests: number;
  putRequests: number;
  deleteRequests: number;
}

export interface DirectorySyncPhaseTimings {
  scanMs: number;
  fingerprintMs: number;
  clientCreateMs: number;
  manifestReadMs: number;
  bundleBuildMs: number;
  bundleBodyPrepareMs: number;
  bundleUploadMs: number;
  bundleTransport: "none" | "memory" | "tempfile";
  bundleBytes: number;
  manifestWriteMs: number;
  deleteMs: number;
  totalPrimaryPathMs: number;
  totalCommandMs: number;
}

export interface RemoteToLocalDirectorySyncPhaseTimings {
  scanMs: number;
  clientCreateMs: number;
  listingMs: number;
  manifestReadMs: number;
  planMs: number;
  removeMs: number;
  mkdirMs: number;
  bundleGetMs: number;
  bundleBodyReadMs: number;
  bundleExtractMs: number;
  bundleExtractMkdirUs: number;
  bundleExtractReplaceUs: number;
  bundleExtractFileCreateUs: number;
  bundleExtractFileWriteUs: number;
  bundleExtractFileMtimeUs: number;
  bundleExtractChmodUs: number;
  bundleExtractTargetCheckUs: number;
  bundleExtractFileCount: number;
  bundleExtractDirectoryCount: number;
  bundleTransport: "none" | "memory" | "tempfile";
  bundleExtractor: "none" | "rust-ustar" | "rust-ustar-stream" | "tar";
  bundleBytes: number;
  downloadMs: number;
  infoCheckMs: number;
  fingerprintMs: number;
  totalCommandMs: number;
}

export interface DirectorySyncWrapperTimings {
  nativeCallMs: number;
  pruneEmptyDirectoriesMs: number;
  totalNativeWrapperMs: number;
}

export interface DirectorySyncBridgeTimings {
  mode: "persistent" | "oneshot";
  poolInitMs: number;
  queueWaitMs: number;
  writeMs: number;
  responseWaitMs: number;
  totalBridgeMs: number;
}

export interface DirectorySyncWorkerTimings {
  receiveDelayMs: number;
  parseMs: number;
  handleMs: number;
  serializeMs: number;
  writeMs: number;
  totalWorkerMs: number;
}

interface LocalDirectorySnapshot {
  files: Map<string, { absolutePath: string; size: number; mtimeMs: number }>;
  emptyDirectories: Set<string>;
}

interface DirectorySyncOptions {
  excludeRelativePath?: ((relativePath: string) => boolean) | undefined;
  preserveTopLevelNames?: string[] | undefined;
}

interface DirectorySyncManifestFileEntry {
  size: number;
  mtimeMs: number;
}

interface DirectorySyncManifestDocument {
  version: 1;
  files: Record<string, DirectorySyncManifestFileEntry>;
  emptyDirectories?: string[] | undefined;
  storageMode?: "objects" | "bundle" | undefined;
  manifestShards?: string[] | undefined;
}

interface ManagedPathMapping {
  key: ManagedPathKey;
  localDir: string;
  remotePrefix: string;
}

const DEFAULT_KEY_PREFIXES: Record<ManagedPathKey, string> = {
  workspace: "workspace",
  runtime: "runtime",
  model: "model",
  tool: "tool",
  skill: "skill"
};
const OBJECT_MTIME_METADATA_KEY = "oah-mtime-ms";
const INTERNAL_SYNC_MANIFEST_RELATIVE_PATH = ".oah-sync-manifest.json";
const INTERNAL_SYNC_MANIFEST_SHARD_PREFIX = ".oah-sync-manifest-shards";
const INTERNAL_SYNC_BUNDLE_RELATIVE_PATH = ".oah-sync-bundle.tar";

const DEFAULT_MANAGED_PATHS = Object.keys(DEFAULT_KEY_PREFIXES) as ManagedPathKey[];
let awsS3ModulePromise: Promise<AwsS3Module> | undefined;

export function normalizeAwsS3Module(module: AwsS3ModuleImport): AwsS3Module {
  if (typeof (module as AwsS3Module).S3Client === "function") {
    return module as AwsS3Module;
  }

  const defaultExport = (module as { default?: AwsS3Module | undefined }).default;
  if (defaultExport && typeof defaultExport.S3Client === "function") {
    return defaultExport;
  }

  throw new TypeError("Failed to load @aws-sdk/client-s3: S3Client export is unavailable.");
}

function loadAwsS3Module(): Promise<AwsS3Module> {
  awsS3ModulePromise ??= import("@aws-sdk/client-s3").then(normalizeAwsS3Module);
  return awsS3ModulePromise;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\/+|\/+$/g, "");
}

function buildRemoteKey(prefix: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return prefix.length === 0 ? normalizedRelativePath : `${prefix}/${normalizedRelativePath}`;
}

function resolveManagedPathMapping(
  mappings: readonly ManagedPathMapping[],
  key: ManagedPathKey
): ManagedPathMapping | undefined {
  return mappings.find((candidate) => candidate.key === key);
}

async function collectObjectStorageEntries(store: DirectoryObjectStore, prefix: string): Promise<ObjectStorageEntry[]> {
  const budget = createObjectStorageSyncBudget(`object storage prefix ${(prefix || ".").trim() || "."}`);
  if (!store.listEntriesPaged) {
    const entries = await store.listEntries(prefix);
    for (const entry of entries) {
      budget.observeObject();
      budget.observeBytes(entry.size);
    }
    return entries;
  }

  const entries: ObjectStorageEntry[] = [];
  for await (const page of store.listEntriesPaged(prefix)) {
    for (const entry of page) {
      budget.observeObject();
      budget.observeBytes(entry.size);
    }
    entries.push(...page);
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

async function deleteObjectStorageKeysInChunks(store: DirectoryObjectStore, keys: Iterable<string>): Promise<number> {
  let deletedCount = 0;
  let chunk: string[] = [];

  const flush = async (): Promise<void> => {
    if (chunk.length === 0) {
      return;
    }
    await store.deleteObjects(chunk);
    deletedCount += chunk.length;
    chunk = [];
  };

  for (const key of keys) {
    if (!key) {
      continue;
    }
    chunk.push(key);
    if (chunk.length >= 1000) {
      await flush();
    }
  }

  await flush();
  return deletedCount;
}

async function deleteRemoteEntriesMatching(input: {
  store: DirectoryObjectStore;
  remotePrefix: string;
  shouldDelete(entry: ObjectStorageEntry): boolean;
}): Promise<number> {
  const budget = createObjectStorageSyncBudget(`object storage prefix ${(input.remotePrefix || ".").trim() || "."}`);
  if (!input.store.listEntriesPaged) {
    const entries = await input.store.listEntries(input.remotePrefix);
    for (const entry of entries) {
      budget.observeObject();
      budget.observeBytes(entry.size);
    }
    return deleteObjectStorageKeysInChunks(
      input.store,
      entries.filter((entry) => input.shouldDelete(entry)).map((entry) => entry.key)
    );
  }

  let deletedCount = 0;
  for await (const page of input.store.listEntriesPaged(input.remotePrefix)) {
    for (const entry of page) {
      budget.observeObject();
      budget.observeBytes(entry.size);
    }
    deletedCount += await deleteObjectStorageKeysInChunks(
      input.store,
      page.filter((entry) => input.shouldDelete(entry)).map((entry) => entry.key)
    );
  }
  return deletedCount;
}

function relativePathFromRemoteKey(prefix: string, key: string): string | undefined {
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

function shouldIgnoreRelativePath(relativePath: string): boolean {
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

function parseObjectMtimeMs(metadata: Record<string, string> | undefined): number | undefined {
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

function isDirectorySyncManifestFileEntry(value: unknown): value is DirectorySyncManifestFileEntry {
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

function buildDirectorySyncManifestFromFiles(
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

async function loadRemoteDirectorySyncManifestDocument(
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

async function loadRemoteDirectorySyncManifest(
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

async function writeRemoteDirectorySyncManifest(input: {
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

function isEquivalentDirectorySyncManifestDocument(
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

function countManifestFileMutations(
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

function countManifestDeletedFiles(
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

function countManifestCreatedEmptyDirectories(
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

function shouldAttemptObjectStorageBundle(input: {
  files: Iterable<{ size: number }>;
}): boolean {
  const config = resolveObjectStorageBundleConfig();
  const mode = config.mode;
  if (mode === "off") {
    return false;
  }

  let fileCount = 0;
  let totalBytes = 0;
  for (const file of input.files) {
    fileCount += 1;
    totalBytes += file.size;
  }

  if (fileCount === 0) {
    return false;
  }
  if (mode === "force") {
    return true;
  }

  return fileCount >= config.minFileCount || totalBytes >= config.minTotalBytes;
}

async function isDirectoryEmpty(rootDir: string): Promise<boolean> {
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (!rootExists) {
    return true;
  }
  if (!rootExists.isDirectory()) {
    return false;
  }

  return (await readdir(rootDir)).length === 0;
}

async function withObjectStorageBundleFile<T>(
  input: {
    localDir: string;
    snapshot: LocalDirectorySnapshot;
  },
  useBundle: (bundlePath: string) => Promise<T>
): Promise<T> {
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-object-store-bundle-"));
  const listPath = path.join(bundleRoot, "bundle-files.txt");
  const bundlePath = path.join(bundleRoot, "bundle.tar");
  const timeoutMs = resolveObjectStorageBundleTimeoutMs();
  const startedAt = performance.now();

  try {
    const fileList = [
      ...[...input.snapshot.files.keys()].sort((left, right) => left.localeCompare(right)),
      ...[...input.snapshot.emptyDirectories].sort((left, right) => left.localeCompare(right))
    ];
    await writeFile(listPath, Buffer.from(fileList.join("\0"), "utf8"));
    await runLocalProcess({
      executable: "tar",
      args: ["-C", input.localDir, "-cf", bundlePath, "--null", "-T", listPath],
      timeoutMs
    });
    recordObjectStorageOperation({
      operation: "bundle_create",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    });
    return await useBundle(bundlePath);
  } finally {
    await rm(bundleRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withObjectStorageBundleStream<T>(
  input: {
    localDir: string;
    snapshot: LocalDirectorySnapshot;
  },
  useBundle: (bundle: NodeJS.ReadableStream) => Promise<T>
): Promise<T> {
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-object-store-bundle-stream-"));
  const listPath = path.join(bundleRoot, "bundle-files.txt");
  const timeoutMs = resolveObjectStorageBundleTimeoutMs();
  const startedAt = performance.now();

  try {
    const fileList = [
      ...[...input.snapshot.files.keys()].sort((left, right) => left.localeCompare(right)),
      ...[...input.snapshot.emptyDirectories].sort((left, right) => left.localeCompare(right))
    ];
    await writeFile(listPath, Buffer.from(fileList.join("\0"), "utf8"));

    const child = spawn("tar", ["-C", input.localDir, "-cf", "-", "--null", "-T", listPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let timeoutTriggered = false;
    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });

    const closePromise = new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (timeoutTriggered) {
          reject(new Error(`Process timed out after ${timeoutMs}ms.`));
          return;
        }
        if ((code ?? 0) !== 0) {
          reject(new Error(stderr.trim() || `Process exited with code ${code ?? 0}.`));
          return;
        }
        resolve();
      });
    });

    if (!child.stdout) {
      child.kill("SIGTERM");
      throw new Error("tar stdout stream is unavailable.");
    }

    const result = await Promise.all([
      useBundle(child.stdout).catch((error) => {
        child.kill("SIGTERM");
        throw error;
      }),
      closePromise
    ]).then(([value]) => value);
    recordObjectStorageOperation({
      operation: "bundle_create",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    });
    return result;
  } finally {
    await rm(bundleRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function putLocalFileObject(input: {
  store: DirectoryObjectStore;
  key: string;
  filePath: string;
  mtimeMs?: number | undefined;
}): Promise<boolean> {
  if (input.store.putObjectFromFile) {
    await input.store.putObjectFromFile(input.key, input.filePath, { mtimeMs: input.mtimeMs });
    return true;
  }

  const body = await readFile(input.filePath).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (!body) {
    return false;
  }

  await input.store.putObject(input.key, body, { mtimeMs: input.mtimeMs });
  return true;
}

async function maybeWriteObjectStorageBundle(input: {
  store: DirectoryObjectStore;
  remotePrefix: string;
  localDir: string;
  options?: DirectorySyncOptions | undefined;
  logger?: ((message: string) => void) | undefined;
  skipWrite?: boolean | undefined;
}): Promise<void> {
  if (input.skipWrite) {
    return;
  }

  const nativeSnapshot = await collectNativeSnapshotIfAvailable(input.localDir, input.options);
  const snapshot = nativeSnapshot?.snapshot ?? (await collectLocalDirectorySnapshot(input.localDir, input.options));
  enforceLocalDirectorySyncBudget(
    snapshot,
    `local directory ${input.localDir} for object storage prefix ${(input.remotePrefix || ".").trim() || "."}`
  );
  const files = [...snapshot.files.entries()].map(([relativePath, file]) => ({
    relativePath,
    size: file.size,
    mtimeMs: file.mtimeMs
  }));
  if (!shouldAttemptObjectStorageBundle({ files })) {
    await input.store.deleteObjects([buildRemoteKey(input.remotePrefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH)]).catch(() => undefined);
    return;
  }

  const bundleKey = buildRemoteKey(input.remotePrefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
  if (input.store.putObjectFromStream) {
    await withObjectStorageBundleStream(
      {
        localDir: input.localDir,
        snapshot
      },
      async (bundle) => {
        await input.store.putObjectFromStream!(bundleKey, bundle);
      }
    );
  } else {
    await withObjectStorageBundleFile(
      {
        localDir: input.localDir,
        snapshot
      },
      async (bundlePath) => {
        if (input.store.putObjectFromFile) {
          await input.store.putObjectFromFile(bundleKey, bundlePath);
          return;
        }
        await input.store.putObject(bundleKey, await readFile(bundlePath));
      }
    );
  }
  input.logger?.(
    `[oah-object-storage] wrote sync bundle ${INTERNAL_SYNC_BUNDLE_RELATIVE_PATH} for ${(input.remotePrefix || ".").trim() || "."}`
  );
}

async function maybeHydrateFromObjectStorageBundle(input: {
  store: DirectoryObjectStore;
  remotePrefix: string;
  localDir: string;
  remoteEntries: ObjectStorageEntry[];
  manifestDocument?: DirectorySyncManifestDocument | undefined;
  requireEmptyLocalDir?: boolean | undefined;
  logger?: ((message: string) => void) | undefined;
}): Promise<boolean> {
  const bundleEntry = input.remoteEntries.find(
    (entry) => entry.key === buildRemoteKey(input.remotePrefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH)
  );
  if (!bundleEntry) {
    return false;
  }
  const shouldHydratePrimaryBundle = input.manifestDocument?.storageMode === "bundle";
  if (
    !shouldHydratePrimaryBundle &&
    !shouldAttemptObjectStorageBundle({ files: input.remoteEntries.filter((entry) => !entry.key.endsWith("/")) })
  ) {
    return false;
  }
  if ((input.requireEmptyLocalDir ?? true) && !(await isDirectoryEmpty(input.localDir))) {
    return false;
  }

  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-object-store-bundle-extract-"));
  const bundlePath = path.join(bundleRoot, "bundle.tar");
  const timeoutMs = resolveObjectStorageBundleTimeoutMs();
  const startedAt = performance.now();
  try {
    await mkdir(input.localDir, { recursive: true });
    if (input.store.getObjectStream) {
      const bundle = await input.store.getObjectStream(bundleEntry.key);
      await extractTarStreamToDirectory({
        bundle: bundle.body,
        localDir: input.localDir,
        timeoutMs
      });
    } else if (input.store.getObjectToFile) {
      await input.store.getObjectToFile(bundleEntry.key, bundlePath);
      await runLocalProcess({
        executable: "tar",
        args: ["-xf", bundlePath, "-C", input.localDir],
        timeoutMs
      });
    } else {
      const bundle = await input.store.getObject(bundleEntry.key);
      await writeFile(bundlePath, bundle.body);
      await runLocalProcess({
        executable: "tar",
        args: ["-xf", bundlePath, "-C", input.localDir],
        timeoutMs
      });
    }
    recordObjectStorageOperation({
      operation: "bundle_extract",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      bytesDownloaded: bundleEntry.size
    });
    input.logger?.(
      `[oah-object-storage] hydrated ${(input.remotePrefix || ".").trim() || "."} from sync bundle ${INTERNAL_SYNC_BUNDLE_RELATIVE_PATH}`
    );
    return true;
  } catch {
    await rm(input.localDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(input.localDir, { recursive: true }).catch(() => undefined);
    return false;
  } finally {
    await rm(bundleRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildSyntheticRemoteEntriesFromManifestDocument(
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

function buildManagedRemoteKeysFromManifestDocument(
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

function countRemoteMaterializedFiles(
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[],
  options?: DirectorySyncOptions,
  manifestDocument?: DirectorySyncManifestDocument | undefined
): number {
  if (manifestDocument?.storageMode === "bundle") {
    return Object.entries(manifestDocument.files).filter(([relativePath, entry]) => {
      return (
        normalizeRelativePath(relativePath).length > 0 &&
        isDirectorySyncManifestFileEntry(entry) &&
        !shouldIgnoreRelativePath(relativePath) &&
        !options?.excludeRelativePath?.(normalizeRelativePath(relativePath))
      );
    }).length;
  }

  let count = 0;
  for (const entry of remoteEntries) {
    if (entry.key.endsWith("/")) {
      continue;
    }

    const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
    if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    if (options?.excludeRelativePath?.(relativePath)) {
      continue;
    }

    count += 1;
  }

  return count;
}

function hasDirectorySyncMutations(input: {
  uploadedFileCount: number;
  deletedRemoteCount: number;
  createdEmptyDirectoryCount: number;
}): boolean {
  return input.uploadedFileCount > 0 || input.deletedRemoteCount > 0 || input.createdEmptyDirectoryCount > 0;
}

function resolveDirectorySyncConcurrency(): number {
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

function resolveObjectStorageRequestTimeoutMs(): number {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_REQUEST_TIMEOUT_MS") ?? DEFAULT_OBJECT_STORAGE_REQUEST_TIMEOUT_MS;
}

function resolveObjectStorageMaxAttempts(): number {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_MAX_ATTEMPTS") ?? DEFAULT_OBJECT_STORAGE_MAX_ATTEMPTS;
}

function resolveObjectStorageMultipartThresholdBytes(): number {
  return resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_MULTIPART_THRESHOLD_BYTES") ?? DEFAULT_OBJECT_STORAGE_MULTIPART_THRESHOLD_BYTES;
}

function resolveObjectStorageMultipartPartSizeBytes(): number {
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

function hasObjectStorageSyncBudgetPolicy(): boolean {
  return (
    resolveObjectStorageSyncMaxObjects() !== undefined ||
    resolveObjectStorageSyncMaxBytes() !== undefined ||
    resolveObjectStorageSyncMaxFileBytes() !== undefined
  );
}

function resolveObjectStorageSyncManifestShardFileCount(): number {
  return (
    resolvePositiveIntegerEnv("OAH_OBJECT_STORAGE_SYNC_MANIFEST_SHARD_FILE_COUNT") ??
    DEFAULT_OBJECT_STORAGE_SYNC_MANIFEST_SHARD_FILE_COUNT
  );
}

function createObjectStorageSyncBudget(label: string): {
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

function enforceLocalDirectorySyncBudget(snapshot: LocalDirectorySnapshot, label: string): void {
  const budget = createObjectStorageSyncBudget(label);
  for (const [relativePath, file] of snapshot.files.entries()) {
    budget.observeObject();
    budget.observeBytes(file.size);
    budget.observeFile(relativePath, file.size);
  }

  budget.observeObject(snapshot.emptyDirectories.size);
}

function resolveObjectStorageBundleConfig(): {
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

function shouldTrustManagedObjectStoragePrefixes(): boolean {
  const raw = process.env.OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES?.trim().toLowerCase();
  return raw ? ["1", "true", "on", "yes", "enabled"].includes(raw) : false;
}

function shouldAssumeEmptyTrustedManagedObjectStoragePrefix(remotePrefix: string): boolean {
  if (!shouldTrustManagedObjectStoragePrefixes() || trustedManagedObjectStoragePrefixes.has(remotePrefix)) {
    return false;
  }
  trustedManagedObjectStoragePrefixes.add(remotePrefix);
  return true;
}

function resolveNativeInlineUploadThresholdBytes(): number {
  return (
    resolvePositiveIntegerEnv("OAH_NATIVE_WORKSPACE_SYNC_INLINE_UPLOAD_THRESHOLD_BYTES") ??
    DEFAULT_NATIVE_INLINE_UPLOAD_THRESHOLD_BYTES
  );
}

function resolveObjectStorageBundleTimeoutMs(): number {
  const raw = process.env.OAH_OBJECT_STORAGE_SYNC_BUNDLE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS;
}

async function runLocalProcess(input: {
  executable: string;
  args: string[];
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let timeoutTriggered = false;
    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, input.timeoutMs ?? DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timeoutTriggered) {
        reject(new Error(`Process timed out after ${input.timeoutMs ?? DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS}ms.`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(stderr.trim() || `Process exited with code ${code ?? 0}.`));
        return;
      }
      resolve();
    });
  });
}

async function extractTarStreamToDirectory(input: {
  bundle: NodeJS.ReadableStream;
  localDir: string;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", "-", "-C", input.localDir], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let timeoutTriggered = false;
    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timeoutTriggered) {
        reject(new Error(`Process timed out after ${input.timeoutMs}ms.`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(stderr.trim() || `Process exited with code ${code ?? 0}.`));
        return;
      }
      resolve();
    });

    if (!child.stdin) {
      child.kill("SIGTERM");
      reject(new Error("tar stdin stream is unavailable."));
      return;
    }

    pipeline(input.bundle, child.stdin).catch((error) => {
      child.kill("SIGTERM");
      reject(error);
    });
  });
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(items.length, concurrency));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
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

function shouldPreserveTopLevelName(relativePath: string, options?: DirectorySyncOptions): boolean {
  if (!options?.preserveTopLevelNames || options.preserveTopLevelNames.length === 0) {
    return false;
  }

  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }

  const topLevelName = normalized.split("/")[0];
  return topLevelName ? options.preserveTopLevelNames.includes(topLevelName) : false;
}

function addDirectoryWithParents(relativePath: string, directories: Set<string>): void {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return;
  }

  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(0, index + 1).join("/");
    if (candidate) {
      directories.add(candidate);
    }
  }
}

async function collectLocalDirectorySnapshot(rootDir: string, options?: DirectorySyncOptions): Promise<LocalDirectorySnapshot> {
  const files = new Map<string, { absolutePath: string; size: number; mtimeMs: number }>();
  const emptyDirectories = new Set<string>();
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });

  if (!rootExists?.isDirectory()) {
    return { files, emptyDirectories };
  }

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!entries) {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    let visibleChildren = 0;
    let suppressedChildren = false;

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
      if (shouldIgnoreRelativePath(relativePath)) {
        suppressedChildren = true;
        continue;
      }
      if (options?.excludeRelativePath?.(relativePath)) {
        suppressedChildren = true;
        continue;
      }

      visibleChildren += 1;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        const entryStat = await stat(absolutePath).catch((error) => {
          if (isNotFoundError(error)) {
            return null;
          }
          throw error;
        });
        if (!entryStat?.isFile()) {
          continue;
        }

        files.set(relativePath, {
          absolutePath,
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs
        });
      }
    }

    const relativeDirectory = normalizeRelativePath(path.relative(rootDir, directory));
    if (visibleChildren === 0 && relativeDirectory && !suppressedChildren) {
      emptyDirectories.add(relativeDirectory);
    }
  };

  await walk(rootDir);
  return { files, emptyDirectories };
}

function createSnapshotFromNativeScan(input: Awaited<ReturnType<typeof scanNativeLocalTree>>): LocalDirectorySnapshot {
  return {
    files: new Map(
      input.files.map((file) => [
        file.relativePath,
        {
          absolutePath: file.absolutePath,
          size: file.size,
          mtimeMs: file.mtimeMs
        }
      ])
    ),
    emptyDirectories: new Set(input.emptyDirectories)
  };
}

function createDirectoryFingerprint(snapshot: LocalDirectorySnapshot): string {
  const hash = createHash("sha1");
  for (const [relativePath, file] of [...snapshot.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`file:${relativePath}:${file.size}:${Math.trunc(file.mtimeMs)}\n`);
  }
  for (const relativePath of [...snapshot.emptyDirectories].sort((left, right) => left.localeCompare(right))) {
    hash.update(`dir:${relativePath}\n`);
  }
  return hash.digest("hex");
}

function createDirectoryFingerprintFromEntries(input: {
  files: Array<{ relativePath: string; size: number; mtimeMs: number }>;
  emptyDirectories: Iterable<string>;
}): string {
  const hash = createHash("sha1");
  for (const file of [...input.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(`file:${file.relativePath}:${file.size}:${Math.trunc(file.mtimeMs)}\n`);
  }
  for (const relativePath of [...input.emptyDirectories].sort((left, right) => left.localeCompare(right))) {
    hash.update(`dir:${relativePath}\n`);
  }
  return hash.digest("hex");
}

function resolveEmptyRemoteDirectories(input: {
  explicitDirectories: Iterable<string>;
  filePaths: Iterable<string>;
}): string[] {
  const explicitDirectories = [...input.explicitDirectories]
    .map((relativePath) => normalizeRelativePath(relativePath))
    .filter((relativePath) => relativePath.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const filePaths = [...input.filePaths]
    .map((relativePath) => normalizeRelativePath(relativePath))
    .filter((relativePath) => relativePath.length > 0);

  return explicitDirectories.filter((candidate) => {
    const childPrefix = `${candidate}/`;
    return (
      !filePaths.some((relativePath) => relativePath.startsWith(childPrefix)) &&
      !explicitDirectories.some((relativePath) => relativePath !== candidate && relativePath.startsWith(childPrefix))
    );
  });
}

function resolveNativeFingerprintExcludes(options?: DirectorySyncOptions): string[] | undefined {
  const exclude = options?.excludeRelativePath;
  if (!exclude) {
    return [];
  }

  if (exclude === shouldExcludeWorkspaceMirrorRelativePath) {
    return [".openharness"];
  }

  if (exclude === shouldExcludeWorkspaceBackingStoreRelativePath) {
    return [".openharness/state", ".openharness/__materialized__"];
  }

  return undefined;
}

function resolveMirrorFingerprintOptions(mapping?: ManagedPathMapping): DirectorySyncOptions | undefined {
  return mapping?.key === "workspace"
    ? {
        excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath
      }
    : undefined;
}

function buildNormalizedRemoteEntryMap(
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[],
  options?: DirectorySyncOptions
): Map<string, ObjectStorageEntry> {
  const remoteByRelativePath = new Map<string, ObjectStorageEntry>();
  for (const entry of remoteEntries) {
    const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
    if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    if (options?.excludeRelativePath?.(relativePath)) {
      continue;
    }
    remoteByRelativePath.set(relativePath || "/", entry);
  }

  return remoteByRelativePath;
}

export async function computeLocalDirectoryFingerprint(rootDir: string, options?: DirectorySyncOptions): Promise<string> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (isNativeWorkspaceSyncEnabled() && nativeExcludes !== undefined) {
    try {
      const result = await observeNativeWorkspaceSyncOperation({
        operation: "fingerprint",
        implementation: "rust",
        target: rootDir,
        logFailure: false,
        action: () =>
          computeNativeDirectoryFingerprint({
            rootDir,
            ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {})
          })
      });
      return result.fingerprint;
    } catch (error) {
      recordNativeWorkspaceSyncFallback({
        operation: "fingerprint",
        target: rootDir,
        error
      });
    }
  }

  return observeNativeWorkspaceSyncOperation({
    operation: "fingerprint",
    implementation: "ts",
    target: rootDir,
    logSuccess: false,
    logFailure: false,
    action: async () => createDirectoryFingerprint(await collectLocalDirectorySnapshot(rootDir, options))
  });
}

async function collectNativeSnapshotIfAvailable(
  rootDir: string,
  options?: DirectorySyncOptions
): Promise<{ snapshot: LocalDirectorySnapshot; fingerprint: string } | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  try {
    const result = await observeNativeWorkspaceSyncOperation({
      operation: "scan",
      implementation: "rust",
      target: rootDir,
      logFailure: false,
      action: () =>
        scanNativeLocalTree({
          rootDir,
          ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {})
        })
    });
    return {
      snapshot: createSnapshotFromNativeScan(result),
      fingerprint: result.fingerprint
    };
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "scan",
      target: rootDir,
      error
    });
    return undefined;
  }
}

async function collectNativeLocalToRemotePlanIfAvailable(
  localDir: string,
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[],
  options?: DirectorySyncOptions
): Promise<Awaited<ReturnType<typeof planNativeLocalToRemote>> | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  try {
    return await observeNativeWorkspaceSyncOperation({
      operation: "plan_local_to_remote",
      implementation: "rust",
      target: localDir,
      logFailure: false,
      action: () =>
        planNativeLocalToRemote({
          rootDir: localDir,
          ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {}),
          remoteEntries: remoteEntries
            .map((entry) => {
              const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
              if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
                return undefined;
              }
              if (options?.excludeRelativePath?.(relativePath)) {
                return undefined;
              }
              return {
                relativePath: relativePath || "/",
                key: entry.key,
                size: entry.size,
                ...(entry.lastModified ? { lastModifiedMs: entry.lastModified.getTime() } : {}),
                isDirectory: entry.key.endsWith("/")
              };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        })
    });
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "plan_local_to_remote",
      target: localDir,
      error
    });
    return undefined;
  }
}

async function syncNativeLocalDirectoryToRemoteIfAvailable(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  label: string | undefined,
  options?: DirectorySyncOptions
): Promise<DirectorySyncResult | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  const nativeObjectStore = store.getNativeWorkspaceSyncConfig?.();
  if (!nativeObjectStore) {
    return undefined;
  }

  try {
    if (hasObjectStorageSyncBudgetPolicy()) {
      const nativeSnapshot = await collectNativeSnapshotIfAvailable(localDir, options);
      const snapshot = nativeSnapshot?.snapshot ?? (await collectLocalDirectorySnapshot(localDir, options));
      enforceLocalDirectorySyncBudget(
        snapshot,
        `local directory ${localDir} for object storage prefix ${((label ?? remotePrefix) || ".").trim() || "."}`
      );
    }

    const concurrency = resolveDirectorySyncConcurrency();
    const bundleConfig = resolveObjectStorageBundleConfig();
    const syncBundle = {
      ...bundleConfig,
      trustManagedPrefixes:
        bundleConfig.layout === "primary" &&
        shouldTrustManagedObjectStoragePrefixes() &&
        (process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT?.trim().toLowerCase() === "1" ||
          process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT?.trim().toLowerCase() === "true" ||
          process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT?.trim().toLowerCase() === "yes" ||
          process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT?.trim().toLowerCase() === "on")
    } as NativeSyncBundleConfig;
    const nativeCallStartedAt = performance.now();
    const result = await observeNativeWorkspaceSyncOperation({
      operation: "sync_local_to_remote",
      implementation: "rust",
      target: localDir,
      logFailure: false,
      metadata: {
        remotePrefix,
        maxConcurrency: concurrency
      },
      action: () =>
        syncNativeLocalToRemote({
          rootDir: localDir,
          remotePrefix,
          objectStore: nativeObjectStore,
          maxConcurrency: concurrency,
          inlineUploadThresholdBytes: resolveNativeInlineUploadThresholdBytes(),
          syncBundle,
          ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {})
        })
    });
    const nativeCallMs = Math.max(0, Math.round(performance.now() - nativeCallStartedAt));
    return {
      localFingerprint: result.localFingerprint,
      uploadedFileCount: result.uploadedFileCount,
      deletedRemoteCount: result.deletedRemoteCount,
      createdEmptyDirectoryCount: result.createdEmptyDirectoryCount,
      ...(result.requestCounts ? { requestCounts: result.requestCounts } : {}),
      ...(result.phaseTimings ? { phaseTimings: result.phaseTimings } : {}),
      ...(result.bridgeTimings ? { bridgeTimings: result.bridgeTimings } : {}),
      ...(result.workerTimings ? { workerTimings: result.workerTimings } : {}),
      wrapperTimings: {
        nativeCallMs,
        pruneEmptyDirectoriesMs: 0,
        totalNativeWrapperMs: nativeCallMs
      }
    };
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "sync_local_to_remote",
      target: localDir,
      error,
      metadata: { remotePrefix }
    });
    return undefined;
  }
}

async function collectNativeRemoteToLocalPlanIfAvailable(
  localDir: string,
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[],
  options?: DirectorySyncOptions
): Promise<Awaited<ReturnType<typeof planNativeRemoteToLocal>> | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  try {
    return await observeNativeWorkspaceSyncOperation({
      operation: "plan_remote_to_local",
      implementation: "rust",
      target: localDir,
      logFailure: false,
      metadata: {
        remotePrefix
      },
      action: () =>
        planNativeRemoteToLocal({
          rootDir: localDir,
          ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {}),
          ...(options?.preserveTopLevelNames ? { preserveTopLevelNames: options.preserveTopLevelNames } : {}),
          remoteEntries: remoteEntries
            .map((entry) => {
              const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
              if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
                return undefined;
              }
              if (options?.excludeRelativePath?.(relativePath)) {
                return undefined;
              }
              return {
                relativePath: relativePath || "/",
                key: entry.key,
                size: entry.size,
                ...(entry.lastModified ? { lastModifiedMs: entry.lastModified.getTime() } : {}),
                isDirectory: entry.key.endsWith("/")
              };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        })
    });
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "plan_remote_to_local",
      target: localDir,
      error,
      metadata: { remotePrefix }
    });
    return undefined;
  }
}

async function syncNativeRemotePrefixToLocalIfAvailable(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  options?: DirectorySyncOptions,
  prefetchedEntries?: ObjectStorageEntry[]
): Promise<RemoteToLocalDirectorySyncResult | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  const nativeObjectStore = store.getNativeWorkspaceSyncConfig?.();
  if (!nativeObjectStore) {
    return undefined;
  }

  try {
    const concurrency = resolveDirectorySyncConcurrency();
    const syncBundle = resolveObjectStorageBundleConfig();
    const nativeRemoteEntries = prefetchedEntries
      ?.map((entry) => {
        const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
        if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
          return undefined;
        }
        if (options?.excludeRelativePath?.(relativePath)) {
          return undefined;
        }
        return {
          relativePath: relativePath || "/",
          key: entry.key,
          size: entry.size,
          ...(entry.lastModified ? { lastModifiedMs: entry.lastModified.getTime() } : {}),
          isDirectory: entry.key.endsWith("/")
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const hasSyncManifest = prefetchedEntries?.some(
      (entry) => entry.key === buildRemoteKey(remotePrefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH)
    );
    const bundleEntry = prefetchedEntries
      ?.map((entry) => {
        const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
        if (relativePath !== INTERNAL_SYNC_BUNDLE_RELATIVE_PATH) {
          return undefined;
        }
        return {
          relativePath,
          key: entry.key,
          size: entry.size,
          ...(entry.lastModified ? { lastModifiedMs: entry.lastModified.getTime() } : {}),
          isDirectory: false
        };
      })
      .find((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const result = await observeNativeWorkspaceSyncOperation({
      operation: "sync_remote_to_local",
      implementation: "rust",
      target: localDir,
      logFailure: false,
      metadata: {
        remotePrefix,
        maxConcurrency: concurrency
      },
      action: () =>
        syncNativeRemoteToLocal({
          rootDir: localDir,
          remotePrefix,
          objectStore: nativeObjectStore,
          maxConcurrency: concurrency,
          ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {}),
          ...(options?.preserveTopLevelNames ? { preserveTopLevelNames: options.preserveTopLevelNames } : {}),
          ...(nativeRemoteEntries ? { remoteEntries: nativeRemoteEntries } : {}),
          ...(typeof hasSyncManifest === "boolean" ? { hasSyncManifest } : {}),
          ...(bundleEntry ? { bundleEntry } : {}),
          syncBundle
        })
    });
    const remotePhaseTimings = (result as { phaseTimings?: RemoteToLocalDirectorySyncPhaseTimings | undefined })
      .phaseTimings;
    return {
      ...("localFingerprint" in result && typeof result.localFingerprint === "string"
        ? { localFingerprint: result.localFingerprint }
        : {}),
      removedPathCount: result.removedPathCount,
      createdDirectoryCount: result.createdDirectoryCount,
      downloadedFileCount: result.downloadedFileCount,
      ...(result.requestCounts ? { requestCounts: result.requestCounts } : {}),
      ...(remotePhaseTimings ? { phaseTimings: remotePhaseTimings } : {})
    };
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "sync_remote_to_local",
      target: localDir,
      error,
      metadata: { remotePrefix }
    });
    return undefined;
  }
}

async function removeUnexpectedLocalEntries(
  rootDir: string,
  remoteFiles: Set<string>,
  remoteDirectories: Set<string>,
  options?: DirectorySyncOptions
): Promise<number> {
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (!rootExists?.isDirectory()) {
    await mkdir(rootDir, { recursive: true });
    return 0;
  }

  let removedCount = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!entries) {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));

      if (options?.excludeRelativePath?.(relativePath)) {
        continue;
      }

      if (shouldIgnoreRelativePath(relativePath)) {
        await rm(absolutePath, { recursive: true, force: true });
        removedCount += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (shouldPreserveTopLevelName(relativePath, options)) {
          continue;
        }

        await walk(absolutePath);
        if (shouldPreserveTopLevelName(relativePath, options) || remoteDirectories.has(relativePath)) {
          continue;
        }

        const remainingEntries = await readdir(absolutePath).catch((error) => {
          if (isNotFoundError(error)) {
            return null;
          }
          throw error;
        });
        if (remainingEntries && remainingEntries.length === 0) {
          await rm(absolutePath, { recursive: true, force: true });
          removedCount += 1;
        }
        continue;
      }

      if (shouldPreserveTopLevelName(relativePath, options)) {
        continue;
      }

      if (!remoteFiles.has(relativePath)) {
        await rm(absolutePath, { recursive: true, force: true });
        removedCount += 1;
      }
    }
  };

  await walk(rootDir);
  return removedCount;
}

async function statIfExists(targetPath: string) {
  return stat(targetPath).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
}

function resolveTargetMtimeMs(input: {
  metadata?: Record<string, string> | undefined;
  lastModified?: Date | undefined;
}): number | undefined {
  return parseObjectMtimeMs(input.metadata) ?? (input.lastModified ? Math.trunc(input.lastModified.getTime()) : undefined);
}

function isMaterializedMtimeMatch(currentMtimeMs: number, targetMtimeMs: number): boolean {
  return Math.abs(currentMtimeMs - targetMtimeMs) < 1;
}

function shouldExcludeWorkspaceMirrorRelativePath(relativePath: string): boolean {
  return relativePath === ".openharness" || relativePath.startsWith(".openharness/");
}

export function shouldExcludeWorkspaceBackingStoreRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return (
    normalized === ".openharness/state" ||
    normalized.startsWith(".openharness/state/") ||
    normalized === ".openharness/__materialized__" ||
    normalized.startsWith(".openharness/__materialized__/")
  );
}

async function pruneEmptyDirectories(rootDir: string): Promise<void> {
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (!rootExists?.isDirectory()) {
    return;
  }

  const walk = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!entries) {
      return false;
    }

    let hasChildren = false;
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const keep = await walk(absolutePath);
        if (!keep) {
          await rm(absolutePath, { recursive: true, force: true });
          continue;
        }
      }

      hasChildren = true;
    }

    return hasChildren;
  };

  await walk(rootDir);
}

async function streamBodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function writeStreamBodyToFile(body: unknown, targetPath: string): Promise<void> {
  if (!body) {
    await writeFile(targetPath, Buffer.alloc(0));
    return;
  }

  if (typeof body === "string" || body instanceof Uint8Array) {
    await writeFile(targetPath, body);
    return;
  }

  if (typeof body === "object" && body !== null && "pipe" in body && typeof body.pipe === "function") {
    await pipeline(body as NodeJS.ReadableStream, createWriteStream(targetPath));
    return;
  }

  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    await writeFile(targetPath, bytes);
    return;
  }

  await pipeline(Readable.from(body as AsyncIterable<Uint8Array | Buffer | string>), createWriteStream(targetPath));
}

function readableFromStreamBody(body: unknown): NodeJS.ReadableStream {
  if (!body) {
    return Readable.from([]);
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    return Readable.from([body]);
  }
  if (typeof body === "object" && body !== null && "pipe" in body && typeof body.pipe === "function") {
    return body as NodeJS.ReadableStream;
  }
  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    return Readable.from(
      (async function* () {
        yield await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      })()
    );
  }
  return Readable.from(body as AsyncIterable<Uint8Array | Buffer | string>);
}

function objectStorageErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as { name?: unknown; code?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number | undefined } };
  return String(record.code ?? record.Code ?? record.name ?? "").toLowerCase();
}

function objectStorageHttpStatus(error: unknown): number | undefined {
  return error && typeof error === "object"
    ? (error as { $metadata?: { httpStatusCode?: number | undefined } }).$metadata?.httpStatusCode
    : undefined;
}

function isTimeoutLikeObjectStorageError(error: unknown): boolean {
  const code = objectStorageErrorCode(error);
  return code.includes("abort") || code.includes("timeout") || code.includes("timedout");
}

function isThrottlingObjectStorageError(error: unknown): boolean {
  const code = objectStorageErrorCode(error);
  const status = objectStorageHttpStatus(error);
  return status === 429 || code.includes("throttl") || code.includes("slowdown") || code.includes("toomanyrequests");
}

function isRetryableObjectStorageError(error: unknown): boolean {
  const status = objectStorageHttpStatus(error);
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

class S3DirectoryStore implements DirectoryObjectStore {
  readonly #bucket: string;
  readonly #config: ObjectStorageConfig;
  #clientPromise: Promise<AwsS3ClientLike> | undefined;

  constructor(config: ObjectStorageConfig) {
    this.#config = config;
    this.#bucket = config.bucket;
  }

  get bucket(): string {
    return this.#bucket;
  }

  async #getClient(): Promise<AwsS3ClientLike> {
    if (!this.#clientPromise) {
      this.#clientPromise = loadAwsS3Module()
        .then(({ S3Client }) => {
          return new S3Client({
            region: this.#config.region,
            ...(this.#config.endpoint ? { endpoint: this.#config.endpoint } : {}),
            ...(this.#config.force_path_style !== undefined ? { forcePathStyle: this.#config.force_path_style } : {}),
            ...(this.#config.access_key || this.#config.secret_key || this.#config.session_token
              ? {
                  credentials: {
                    accessKeyId: this.#config.access_key ?? "",
                    secretAccessKey: this.#config.secret_key ?? "",
                    ...(this.#config.session_token ? { sessionToken: this.#config.session_token } : {})
                  }
                }
              : {})
          }) as AwsS3ClientLike;
        })
        .catch((error) => {
          this.#clientPromise = undefined;
          throw error;
        });
    }

    return this.#clientPromise;
  }

  async #send<TResponse>(
    command: unknown,
    operation: ObjectStorageMetricOperation
  ): Promise<{ response: TResponse; retries: number }> {
    const client = await this.#getClient();
    const maxAttempts = Math.max(1, resolveObjectStorageMaxAttempts());
    const timeoutMs = resolveObjectStorageRequestTimeoutMs();
    let retries = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = (await client.send(command, { abortSignal: controller.signal })) as TResponse;
        clearTimeout(timeoutHandle);
        return { response, retries };
      } catch (error) {
        clearTimeout(timeoutHandle);
        const timeout = controller.signal.aborted || isTimeoutLikeObjectStorageError(error);
        const throttled = isThrottlingObjectStorageError(error);
        const retryable = timeout || throttled || isRetryableObjectStorageError(error);
        if (retryable) {
          recordObjectStorageOperation({
            operation,
            countOperation: false,
            ...(timeout ? { timeout: true } : {}),
            ...(throttled ? { throttled: true } : {})
          });
        }
        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }
        retries += 1;
        recordObjectStorageOperation({
          operation,
          countOperation: false,
          retries: 1
        });
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 50 * 2 ** (attempt - 1))));
      }
    }

    throw new Error("unreachable object storage retry state");
  }

  #metadataFromOptions(options?: { mtimeMs?: number | undefined }): Record<string, string> | undefined {
    return typeof options?.mtimeMs === "number" && Number.isFinite(options.mtimeMs) && options.mtimeMs > 0
      ? {
          [OBJECT_MTIME_METADATA_KEY]: String(Math.trunc(options.mtimeMs))
        }
      : undefined;
  }

  async #putObjectStreamMultipart(
    key: string,
    body: NodeJS.ReadableStream,
    options?: { mtimeMs?: number | undefined }
  ): Promise<void> {
    const {
      AbortMultipartUploadCommand,
      CompleteMultipartUploadCommand,
      CreateMultipartUploadCommand,
      PutObjectCommand,
      UploadPartCommand
    } = await loadAwsS3Module();
    const partSize = resolveObjectStorageMultipartPartSizeBytes();
    const startedAt = performance.now();
    let uploadId: string | undefined;
    let retries = 0;
    let uploadedBytes = 0;
    const completedParts: Array<{ ETag?: string | undefined; PartNumber: number }> = [];

    const metadata = this.#metadataFromOptions(options);
    const uploadPart = async (partNumber: number, partBody: Buffer): Promise<void> => {
      const { response, retries: partRetries } = await this.#send<{ ETag?: string | undefined }>(
        new UploadPartCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: partBody,
          ContentLength: partBody.length
        }),
        "multipart_upload"
      );
      retries += partRetries;
      uploadedBytes += partBody.length;
      completedParts.push({
        PartNumber: partNumber,
        ...(response.ETag ? { ETag: response.ETag } : {})
      });
    };

    try {
      const createResult = await this.#send<{ UploadId?: string | undefined }>(
        new CreateMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          ...(metadata ? { Metadata: metadata } : {})
        }),
        "multipart_upload"
      );
      retries += createResult.retries;
      uploadId = createResult.response.UploadId;
      if (!uploadId) {
        throw new Error(`S3 multipart upload for ${key} did not return an upload id.`);
      }

      let pending = Buffer.alloc(0);
      let partNumber = 1;
      for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
        const buffer = Buffer.from(chunk);
        pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
        while (pending.length >= partSize) {
          const part = pending.subarray(0, partSize);
          pending = pending.subarray(partSize);
          await uploadPart(partNumber, part);
          partNumber += 1;
        }
      }

      if (pending.length > 0) {
        await uploadPart(partNumber, pending);
      }

      if (completedParts.length === 0) {
        const putStartedAt = performance.now();
        const { retries: putRetries } = await this.#send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            Body: Buffer.alloc(0),
            ContentLength: 0,
            ...(metadata ? { Metadata: metadata } : {})
          }),
          "put"
        );
        recordObjectStorageOperation({
          operation: "put",
          durationMs: Math.max(0, Math.round(performance.now() - putStartedAt)),
          retries: putRetries,
          objectsUploaded: 1
        });
        return;
      }

      const completeResult = await this.#send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: completedParts
          }
        }),
        "multipart_upload"
      );
      retries += completeResult.retries;
      recordObjectStorageOperation({
        operation: "multipart_upload",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        bytesUploaded: uploadedBytes,
        objectsUploaded: 1
      });
    } catch (error) {
      if (uploadId) {
        await this.#send(
          new AbortMultipartUploadCommand({
            Bucket: this.#bucket,
            Key: key,
            UploadId: uploadId
          }),
          "multipart_upload"
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  getNativeWorkspaceSyncConfig(): NativeWorkspaceSyncObjectStoreConfig {
    return {
      bucket: this.#config.bucket,
      region: this.#config.region,
      ...(this.#config.endpoint ? { endpoint: this.#config.endpoint } : {}),
      ...(this.#config.force_path_style !== undefined ? { forcePathStyle: this.#config.force_path_style } : {}),
      ...(this.#config.access_key ? { accessKey: this.#config.access_key } : {}),
      ...(this.#config.secret_key ? { secretKey: this.#config.secret_key } : {}),
      ...(this.#config.session_token ? { sessionToken: this.#config.session_token } : {})
    };
  }

  async *listEntriesPaged(prefix: string): AsyncIterable<ObjectStorageEntry[]> {
    const { ListObjectsV2Command } = await loadAwsS3Module();
    const normalizedPrefix = normalizePrefix(prefix);
    let continuationToken: string | undefined;

    do {
      const startedAt = performance.now();
      const { response, retries } = await this.#send<{
        Contents?: Array<{ Key?: string | undefined; Size?: number | undefined; LastModified?: Date | undefined }>;
        IsTruncated?: boolean | undefined;
        NextContinuationToken?: string | undefined;
      }>(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ...(normalizedPrefix ? { Prefix: `${normalizedPrefix}/` } : {}),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        }),
        "list"
      );

      const page: ObjectStorageEntry[] = [];
      for (const item of response.Contents ?? []) {
        if (!item.Key) {
          continue;
        }

        page.push({
          key: item.Key,
          size: item.Size ?? 0,
          ...(item.LastModified ? { lastModified: item.LastModified } : {})
        });
      }
      recordObjectStorageOperation({
        operation: "list",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsListed: page.length
      });

      if (page.length > 0) {
        yield page.sort((left, right) => left.key.localeCompare(right.key));
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async listEntries(prefix: string): Promise<ObjectStorageEntry[]> {
    return collectObjectStorageEntries(this, prefix);
  }

  async getObject(key: string): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }> {
    const { GetObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      Body?: unknown;
      Metadata?: Record<string, string> | undefined;
      ContentLength?: number | undefined;
    }>(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "get"
    );
    const body = await streamBodyToBuffer(response.Body);
    recordObjectStorageOperation({
      operation: "get",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesDownloaded: body.length,
      objectsDownloaded: 1
    });
    return {
      body,
      metadata: response.Metadata
    };
  }

  async getObjectStream(key: string): Promise<{ body: NodeJS.ReadableStream; metadata?: Record<string, string> | undefined }> {
    const { GetObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      Body?: unknown;
      Metadata?: Record<string, string> | undefined;
      ContentLength?: number | undefined;
    }>(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "get"
    );
    recordObjectStorageOperation({
      operation: "get",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesDownloaded: response.ContentLength,
      objectsDownloaded: 1
    });
    return {
      body: readableFromStreamBody(response.Body),
      metadata: response.Metadata
    };
  }

  async getObjectToFile(key: string, targetPath: string): Promise<{ metadata?: Record<string, string> | undefined }> {
    const { GetObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      Body?: unknown;
      Metadata?: Record<string, string> | undefined;
      ContentLength?: number | undefined;
    }>(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "get"
    );
    await writeStreamBodyToFile(response.Body, targetPath);
    const fileStat = await stat(targetPath).catch(() => undefined);
    recordObjectStorageOperation({
      operation: "get",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesDownloaded: fileStat?.size ?? response.ContentLength,
      objectsDownloaded: 1
    });
    return {
      metadata: response.Metadata
    };
  }

  async getObjectInfo(
    key: string
  ): Promise<{ size?: number | undefined; lastModified?: Date | undefined; metadata?: Record<string, string> | undefined }> {
    const { HeadObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      ContentLength?: number | undefined;
      LastModified?: Date | undefined;
      Metadata?: Record<string, string> | undefined;
    }>(
      new HeadObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "head"
    );
    recordObjectStorageOperation({
      operation: "head",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries
    });

    return {
      ...(typeof response.ContentLength === "number" ? { size: response.ContentLength } : {}),
      ...(response.LastModified ? { lastModified: response.LastModified } : {}),
      ...(response.Metadata ? { metadata: response.Metadata } : {})
    };
  }

  async putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void> {
    const { PutObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { retries } = await this.#send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ...(this.#metadataFromOptions(options) ? { Metadata: this.#metadataFromOptions(options) } : {})
      }),
      "put"
    );
    recordObjectStorageOperation({
      operation: "put",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesUploaded: body.length,
      objectsUploaded: 1
    });
  }

  async putObjectFromStream(key: string, body: NodeJS.ReadableStream, options?: { mtimeMs?: number | undefined }): Promise<void> {
    await this.#putObjectStreamMultipart(key, body, options);
  }

  async putObjectFromFile(key: string, filePath: string, options?: { mtimeMs?: number | undefined }): Promise<void> {
    const fileStat = await stat(filePath);
    if (fileStat.size >= resolveObjectStorageMultipartThresholdBytes()) {
      await this.#putObjectStreamMultipart(key, createReadStream(filePath), options);
      return;
    }

    const { PutObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { retries } = await this.#send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: fileStat.size,
        ...(this.#metadataFromOptions(options) ? { Metadata: this.#metadataFromOptions(options) } : {})
      }),
      "put"
    );
    recordObjectStorageOperation({
      operation: "put",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesUploaded: fileStat.size,
      objectsUploaded: 1
    });
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    const { DeleteObjectsCommand } = await loadAwsS3Module();
    for (let index = 0; index < keys.length; index += 1000) {
      const chunk = keys.slice(index, index + 1000);
      const startedAt = performance.now();
      const { retries } = await this.#send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: {
            Objects: chunk.map((key) => ({ Key: key })),
            Quiet: true
          }
        }),
        "delete"
      );
      recordObjectStorageOperation({
        operation: "delete",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsDeleted: chunk.length
      });
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const normalizedPrefix = normalizePrefix(prefix);
    if (!normalizedPrefix) {
      throw new Error("Refusing to delete an empty object storage prefix.");
    }

    const { DeleteObjectsCommand, ListObjectsV2Command } = await loadAwsS3Module();
    let deletedCount = 0;
    const deleteChunk = async (keys: string[]): Promise<void> => {
      if (keys.length === 0) {
        return;
      }
      const startedAt = performance.now();
      const { retries } = await this.#send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: {
            Objects: keys.map((key) => ({ Key: key })),
            Quiet: true
          }
        }),
        "delete"
      );
      recordObjectStorageOperation({
        operation: "delete",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsDeleted: keys.length
      });
      deletedCount += keys.length;
    };

    let continuationToken: string | undefined;
    do {
      const startedAt = performance.now();
      const { response, retries } = await this.#send<{
        Contents?: Array<{ Key?: string | undefined }>;
        IsTruncated?: boolean | undefined;
        NextContinuationToken?: string | undefined;
      }>(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: `${normalizedPrefix}/`,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        }),
        "list"
      );
      const keys = (response.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key));
      recordObjectStorageOperation({
        operation: "list",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsListed: keys.length
      });
      await deleteChunk(keys);
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    await deleteChunk([normalizedPrefix, `${normalizedPrefix}/`]);
    return deletedCount;
  }

  async close(): Promise<void> {
    const client = await this.#clientPromise?.catch(() => undefined);
    client?.destroy();
  }
}

export function createDirectoryObjectStore(config: ObjectStorageConfig): DirectoryObjectStore {
  return new S3DirectoryStore(config);
}

export class ObjectStorageMirrorController {
  readonly #store: DirectoryObjectStore & { close(): Promise<void> };
  readonly #mappings: ManagedPathMapping[];
  readonly #pollIntervalMs: number;
  readonly #syncOnBoot: boolean;
  readonly #syncOnChange: boolean;
  readonly #fingerprints = new Map<ManagedPathKey, string>();
  readonly #logger: (message: string) => void;
  #pollTimer: NodeJS.Timeout | undefined;
  #syncInFlight: Promise<void> | undefined;
  #localPreparationPromise: Promise<void> | undefined;
  #initializationPromise: Promise<void> | undefined;
  #backgroundInitializationObserved = false;
  #initializationError: unknown;

  constructor(
    config: ObjectStorageConfig,
    paths: ServerConfig["paths"],
    logger?: (message: string) => void,
    options?: {
      store?: (DirectoryObjectStore & { close(): Promise<void> }) | undefined;
    }
  ) {
    this.#store = options?.store ?? new S3DirectoryStore(config);
    this.#pollIntervalMs = config.poll_interval_ms ?? 5000;
    this.#syncOnBoot = config.sync_on_boot ?? true;
    this.#syncOnChange = config.sync_on_change ?? true;
    this.#logger = logger ?? (() => undefined);

    const configuredPrefixes = config.key_prefixes ?? {};
    const managedPaths: ManagedPathKey[] = config.managed_paths ?? DEFAULT_MANAGED_PATHS;
    this.#mappings = managedPaths.map((key: ManagedPathKey) => ({
      key,
      localDir: paths[`${key}_dir` as keyof ServerConfig["paths"]] as string,
      remotePrefix: normalizePrefix(configuredPrefixes[key] ?? DEFAULT_KEY_PREFIXES[key])
    }));
  }

  get enabled(): boolean {
    return this.#mappings.length > 0;
  }

  hasManagedPath(key: ManagedPathKey): boolean {
    return resolveManagedPathMapping(this.#mappings, key) !== undefined;
  }

  managedWorkspaceExternalRef(rootPath: string, kind: "project", paths: Pick<ServerConfig["paths"], "workspace_dir">): string | undefined {
    const mapping = this.#mappings.find((candidate) => candidate.key === "workspace");
    if (!mapping) {
      return undefined;
    }

    const baseDir = paths.workspace_dir;
    const relative = path.relative(baseDir, rootPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }

    const normalizedRelative = normalizeRelativePath(relative);
    const key = buildRemoteKey(mapping.remotePrefix, normalizedRelative);
    return `s3://${this.#store.bucket}/${key}`;
  }

  async initialize(options?: { awaitInitialSync?: boolean | undefined }): Promise<void> {
    const awaitInitialSync = options?.awaitInitialSync ?? true;
    const localPreparation = this.#ensureLocalPreparation();
    const initialization = this.#ensureInitialization();

    if (awaitInitialSync) {
      await initialization;
      return;
    }

    if (!this.#backgroundInitializationObserved) {
      this.#backgroundInitializationObserved = true;
      void initialization.catch((error) => {
        this.#logger(
          `background mirror initialization failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }

    await localPreparation;
  }

  async close(): Promise<void> {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }

    await this.#initializationPromise?.catch(() => undefined);
    if (this.#initializationError === undefined) {
      await this.syncChangedMappings();
    }
    await this.#store.close();
  }

  async syncChangedMappings(): Promise<void> {
    await this.#initializationPromise;

    if (this.#syncInFlight) {
      return this.#syncInFlight;
    }

    this.#syncInFlight = (async () => {
      try {
        const nextFingerprints = await this.#captureFingerprints(this.#mappings);
        for (const mapping of this.#mappings) {
          const nextFingerprint = nextFingerprints.get(mapping.key) ?? (await this.#captureFingerprint(mapping.localDir));
          const previousFingerprint = this.#fingerprints.get(mapping.key);
          if (previousFingerprint === nextFingerprint) {
            continue;
          }

          await this.#syncLocalToRemote(mapping);
          this.#fingerprints.set(mapping.key, await this.#captureFingerprint(mapping.localDir));
        }
      } finally {
        this.#syncInFlight = undefined;
      }
    })();

    return this.#syncInFlight;
  }

  async syncManagedPathSubdirectoryToRemote(
    key: ManagedPathKey,
    relativePath: string,
    localDir: string
  ): Promise<DirectorySyncResult> {
    await this.#initializationPromise;

    const mapping = resolveManagedPathMapping(this.#mappings, key);
    if (!mapping) {
      throw new Error(`Object storage mirror is not configured for managed path "${key}".`);
    }

    const normalizedRelativePath = normalizeRelativePath(relativePath);
    if (
      !normalizedRelativePath ||
      normalizedRelativePath === ".." ||
      normalizedRelativePath.startsWith("../") ||
      normalizedRelativePath.split("/").includes("..")
    ) {
      throw new Error(`Invalid managed path relative path: ${relativePath}`);
    }

    return syncLocalDirectoryToRemote(
      this.#store,
      buildRemoteKey(mapping.remotePrefix, normalizedRelativePath),
      localDir,
      this.#logger,
      `${key}/${normalizedRelativePath}`,
      key === "workspace"
        ? {
            excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath
          }
        : undefined
    );
  }

  async deleteManagedPathSubdirectoryFromRemote(key: ManagedPathKey, relativePath: string): Promise<void> {
    await this.#initializationPromise;

    const mapping = resolveManagedPathMapping(this.#mappings, key);
    if (!mapping) {
      throw new Error(`Object storage mirror is not configured for managed path "${key}".`);
    }

    const normalizedRelativePath = normalizeRelativePath(relativePath);
    if (
      !normalizedRelativePath ||
      normalizedRelativePath === ".." ||
      normalizedRelativePath.startsWith("../") ||
      normalizedRelativePath.split("/").includes("..")
    ) {
      throw new Error(`Invalid managed path relative path: ${relativePath}`);
    }

    await deleteRemotePrefixFromObjectStore(
      this.#store,
      buildRemoteKey(mapping.remotePrefix, normalizedRelativePath),
      this.#logger,
      `${key}/${normalizedRelativePath}`
    );
  }

  async #captureFingerprint(directory: string): Promise<string> {
    const mapping = this.#mappings.find((candidate) => candidate.localDir === directory);
    return computeLocalDirectoryFingerprint(directory, resolveMirrorFingerprintOptions(mapping));
  }

  async #captureFingerprints(mappings: readonly ManagedPathMapping[]): Promise<Map<ManagedPathKey, string>> {
    const fingerprints = new Map<ManagedPathKey, string>();
    if (mappings.length === 0) {
      return fingerprints;
    }

    const nativeInputs = mappings
      .map((mapping) => {
        const nativeExcludes = resolveNativeFingerprintExcludes(resolveMirrorFingerprintOptions(mapping));
        if (nativeExcludes === undefined) {
          return undefined;
        }

        return {
          mapping,
          input: {
            rootDir: mapping.localDir,
            ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {})
          }
        };
      });

    if (isNativeWorkspaceSyncEnabled() && nativeInputs.every((entry) => entry !== undefined)) {
      try {
        const resolvedInputs = nativeInputs;
        const result = await observeNativeWorkspaceSyncOperation({
          operation: "fingerprint_batch",
          implementation: "rust",
          target: "object-storage-mirror",
          logFailure: false,
          metadata: {
            directoryCount: resolvedInputs.length
          },
          action: () =>
            computeNativeDirectoryFingerprintBatch({
              directories: resolvedInputs.map((entry) => entry.input)
            })
        });
        for (let index = 0; index < resolvedInputs.length; index += 1) {
          const nativeInput = resolvedInputs[index];
          const nativeResult = result.results[index];
          if (!nativeInput || !nativeResult || nativeResult.rootDir !== nativeInput.mapping.localDir) {
            continue;
          }

          fingerprints.set(nativeInput.mapping.key, nativeResult.fingerprint);
        }

        if (fingerprints.size === mappings.length) {
          return fingerprints;
        }
      } catch (error) {
        recordNativeWorkspaceSyncFallback({
          operation: "fingerprint_batch",
          target: "object-storage-mirror",
          error,
          metadata: {
            directoryCount: mappings.length
          }
        });
      }
    }

    for (const mapping of mappings) {
      fingerprints.set(mapping.key, await this.#captureFingerprint(mapping.localDir));
    }

    return fingerprints;
  }

  async #syncRemoteToLocal(mapping: ManagedPathMapping): Promise<void> {
    await syncRemotePrefixToLocal(
      this.#store,
      mapping.remotePrefix,
      mapping.localDir,
      this.#logger,
      mapping.key,
      mapping.key === "workspace"
        ? {
            excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath,
            preserveTopLevelNames: [".openharness"]
          }
        : undefined
    );
  }

  async #syncLocalToRemote(mapping: ManagedPathMapping): Promise<void> {
    await syncLocalDirectoryToRemote(
      this.#store,
      mapping.remotePrefix,
      mapping.localDir,
      this.#logger,
      mapping.key,
      mapping.key === "workspace"
        ? {
            excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath
          }
        : undefined
    );
  }

  #ensureLocalPreparation(): Promise<void> {
    if (!this.#localPreparationPromise) {
      this.#localPreparationPromise = (async () => {
        for (const mapping of this.#mappings) {
          await mkdir(mapping.localDir, { recursive: true });
        }
      })();
    }

    return this.#localPreparationPromise;
  }

  #ensureInitialization(): Promise<void> {
    if (!this.#initializationPromise) {
      this.#initializationPromise = (async () => {
        await this.#ensureLocalPreparation();

        if (this.#syncOnBoot) {
          for (const mapping of this.#mappings) {
            await this.#syncRemoteToLocal(mapping);
          }
        }

        for (const [key, fingerprint] of await this.#captureFingerprints(this.#mappings)) {
          this.#fingerprints.set(key, fingerprint);
        }

        if (this.#syncOnChange && !this.#pollTimer) {
          this.#pollTimer = setInterval(() => {
            void this.syncChangedMappings();
          }, this.#pollIntervalMs);
          this.#pollTimer.unref();
        }
      })().catch((error) => {
        this.#initializationError = error;
        throw error;
      });
    }

    return this.#initializationPromise;
  }
}

export async function syncWorkspaceRootToObjectStore(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  logger?: (message: string) => void,
  label?: string
): Promise<DirectorySyncResult> {
  return syncLocalDirectoryToRemote(store, remotePrefix, localDir, logger, label, {
    excludeRelativePath: shouldExcludeWorkspaceBackingStoreRelativePath
  });
}

export function resolveRuntimeRemotePrefix(config: ObjectStorageConfig, runtimeName: string): string {
  const normalizedConfig = normalizeObjectStorageConfig(config);
  return buildRemoteKey(normalizePrefix(normalizedConfig.mirrors?.key_prefixes?.runtime ?? "runtime"), runtimeName);
}

export async function syncRuntimeDirectoryToObjectStore(
  config: ObjectStorageConfig,
  runtimeName: string,
  localDir: string,
  logger?: (message: string) => void
): Promise<DirectorySyncResult> {
  const store = new S3DirectoryStore(config);
  try {
    return syncLocalDirectoryToRemote(
      store,
      resolveRuntimeRemotePrefix(config, runtimeName),
      localDir,
      logger,
      `runtime/${runtimeName}`
    );
  } finally {
    await store.close();
  }
}

export async function syncRuntimeDirectoryFromObjectStore(
  config: ObjectStorageConfig,
  runtimeName: string,
  localDir: string,
  logger?: (message: string) => void
): Promise<RemoteToLocalDirectorySyncResult> {
  const store = new S3DirectoryStore(config);
  const remotePrefix = resolveRuntimeRemotePrefix(config, runtimeName);
  try {
    const entries = await collectObjectStorageEntries(store, remotePrefix);
    if (entries.length === 0) {
      const err = new Error(`Runtime "${runtimeName}" does not exist in object storage.`);
      (err as Error & { statusCode?: number }).statusCode = 404;
      (err as Error & { code?: string }).code = "runtime_not_found";
      throw err;
    }

    return syncRemotePrefixToLocal(store, remotePrefix, localDir, logger, `runtime/${runtimeName}`);
  } finally {
    await store.close();
  }
}

export async function listRuntimeNamesFromObjectStore(
  config: ObjectStorageConfig,
  options?: { store?: DirectoryObjectStore | undefined }
): Promise<string[]> {
  const store = options?.store ?? new S3DirectoryStore(config);
  const normalizedConfig = normalizeObjectStorageConfig(config);
  const runtimePrefix = normalizePrefix(normalizedConfig.mirrors?.key_prefixes?.runtime ?? "runtime");

  try {
    const entries = await collectObjectStorageEntries(store, runtimePrefix);
    const names = new Set<string>();
    const prefixWithSlash = runtimePrefix ? `${runtimePrefix}/` : "";

    for (const entry of entries) {
      const relativeKey = prefixWithSlash && entry.key.startsWith(prefixWithSlash)
        ? entry.key.slice(prefixWithSlash.length)
        : entry.key;
      const runtimeName = relativeKey.split("/")[0]?.trim() ?? "";
      if (runtimeName && !runtimeName.startsWith(".")) {
        names.add(runtimeName);
      }
    }

    return [...names].sort((left, right) => left.localeCompare(right));
  } finally {
    if (!options?.store) {
      await (store as S3DirectoryStore).close();
    }
  }
}

export async function deleteRuntimeFromObjectStore(
  config: ObjectStorageConfig,
  runtimeName: string,
  logger?: (message: string) => void
): Promise<void> {
  const store = new S3DirectoryStore(config);
  try {
    await deleteRemotePrefixFromObjectStore(store, resolveRuntimeRemotePrefix(config, runtimeName), logger, `runtime/${runtimeName}`);
  } finally {
    await store.close();
  }
}

export async function deleteRemotePrefixFromObjectStore(
  store: DirectoryObjectStore,
  remotePrefix: string,
  logger?: (message: string) => void,
  label?: string
): Promise<void> {
  const normalizedPrefix = normalizePrefix(remotePrefix);
  if (!normalizedPrefix) {
    throw new Error("Refusing to delete an empty object storage prefix.");
  }

  logger?.(`scanning object storage prefix ${(label ?? normalizedPrefix) || "."} for deletion`);
  if (store.deletePrefix) {
    const deletedCount = await store.deletePrefix(normalizedPrefix);
    logger?.(
      `deleted ${deletedCount} object storage entr${deletedCount === 1 ? "y" : "ies"} from ${(label ?? normalizedPrefix) || "."}`
    );
    return;
  }

  let deletedCount = await deleteObjectStorageKeysInChunks(store, [normalizedPrefix, `${normalizedPrefix}/`]);
  deletedCount += await deleteRemoteEntriesMatching({
    store,
    remotePrefix: normalizedPrefix,
    shouldDelete: (entry) => entry.key === normalizedPrefix || entry.key === `${normalizedPrefix}/` || entry.key.startsWith(`${normalizedPrefix}/`)
  });
  logger?.(
    `deleted ${deletedCount} object storage entr${deletedCount === 1 ? "y" : "ies"} from ${(label ?? normalizedPrefix) || "."}`
  );
}

export async function deleteWorkspaceExternalRefFromObjectStore(
  config: ObjectStorageConfig,
  externalRef: string,
  logger?: (message: string) => void
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(externalRef);
  } catch {
    return false;
  }

  if (parsed.protocol !== "s3:") {
    return false;
  }

  if (parsed.hostname && parsed.hostname !== config.bucket) {
    throw new Error(
      `Workspace externalRef bucket ${parsed.hostname} does not match configured object storage bucket ${config.bucket}.`
    );
  }

  const remotePrefix = normalizePrefix(parsed.pathname);
  if (!remotePrefix) {
    throw new Error(`Workspace externalRef ${externalRef} does not resolve to a deletable object storage prefix.`);
  }

  const store = new S3DirectoryStore(config);
  try {
    await deleteRemotePrefixFromObjectStore(store, remotePrefix, logger, path.basename(remotePrefix) || remotePrefix);
    return true;
  } finally {
    await store.close();
  }
}

export async function seedWorkspaceRootToExternalRef(
  config: ObjectStorageConfig,
  externalRef: string,
  localDir: string,
  logger?: (message: string) => void
): Promise<void> {
  const parsed = new URL(externalRef);
  if (parsed.protocol !== "s3:") {
    return;
  }

  if (parsed.hostname && parsed.hostname !== config.bucket) {
    throw new Error(
      `Workspace externalRef bucket ${parsed.hostname} does not match configured object storage bucket ${config.bucket}.`
    );
  }

  const remotePrefix = normalizePrefix(parsed.pathname);
  const store = new S3DirectoryStore(config);
  try {
    await syncWorkspaceRootToObjectStore(store, remotePrefix, localDir, logger, path.basename(localDir) || remotePrefix);
  } finally {
    await store.close();
  }
}

export async function syncRemotePrefixToLocal(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  logger?: (message: string) => void,
  label?: string,
  options?: DirectorySyncOptions
): Promise<RemoteToLocalDirectorySyncResult> {
  logger?.(`syncing ${(label ?? remotePrefix) || "."} from object storage into ${localDir}`);
  const nativeResult = await syncNativeRemotePrefixToLocalIfAvailable(store, remotePrefix, localDir, options);
  if (nativeResult) {
    return nativeResult;
  }

  const bundleConfig = resolveObjectStorageBundleConfig();
  let prefetchedEntries: ObjectStorageEntry[] | undefined;
  let syncManifestDocument: DirectorySyncManifestDocument | undefined;

  if (bundleConfig.layout === "primary") {
    syncManifestDocument = await loadRemoteDirectorySyncManifestDocument(store, remotePrefix);
    if (syncManifestDocument?.storageMode === "bundle") {
      prefetchedEntries = buildSyntheticRemoteEntriesFromManifestDocument(remotePrefix, syncManifestDocument, options, true);
    }
  }

  if (!prefetchedEntries && store.listEntriesPaged) {
    syncManifestDocument = await loadRemoteDirectorySyncManifestDocument(store, remotePrefix);
    if (syncManifestDocument) {
      prefetchedEntries = buildSyntheticRemoteEntriesFromManifestDocument(remotePrefix, syncManifestDocument, options, true);
    }
  }

  if (!prefetchedEntries) {
    prefetchedEntries = await collectObjectStorageEntries(store, remotePrefix);
    const hasVisibleRemoteEntries = prefetchedEntries.some((entry) => {
      if (entry.key.endsWith("/")) {
        return true;
      }
      const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
      if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
        return false;
      }
      return !options?.excludeRelativePath?.(relativePath);
    });
    syncManifestDocument = hasVisibleRemoteEntries ? undefined : await loadRemoteDirectorySyncManifestDocument(store, remotePrefix, prefetchedEntries);
  }
  const hydratedFromBundle = await maybeHydrateFromObjectStorageBundle({
    store,
    remotePrefix,
    localDir,
    remoteEntries: prefetchedEntries,
    manifestDocument: syncManifestDocument,
    logger
  });
  if (hydratedFromBundle) {
    return {
      localFingerprint: await computeLocalDirectoryFingerprint(localDir, options),
      removedPathCount: 0,
      createdDirectoryCount: 0,
      downloadedFileCount: countRemoteMaterializedFiles(remotePrefix, prefetchedEntries, options, syncManifestDocument)
    };
  }

  return observeNativeWorkspaceSyncOperation({
    operation: "sync_remote_to_local",
    implementation: "ts",
    target: localDir,
    logSuccess: false,
    logFailure: false,
    metadata: {
      remotePrefix
    },
    action: async (): Promise<RemoteToLocalDirectorySyncResult> => {
      const entries = prefetchedEntries;
      const remoteEntriesForSync =
        syncManifestDocument?.storageMode === "bundle"
          ? buildSyntheticRemoteEntriesFromManifestDocument(remotePrefix, syncManifestDocument, options)
          : entries;
      const syncManifest = syncManifestDocument
        ? new Map(
            Object.entries(syncManifestDocument.files)
              .map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
              .filter(
                (entry): entry is readonly [string, DirectorySyncManifestFileEntry] =>
                  entry[0].length > 0 && isDirectorySyncManifestFileEntry(entry[1])
              )
          )
        : await loadRemoteDirectorySyncManifest(store, remotePrefix, entries);
      await mkdir(localDir, { recursive: true });

      const remoteDirectories = new Set<string>();
      const explicitRemoteDirectories = new Set<string>();
      const remoteFiles = new Map<string, ObjectStorageEntry>();

      for (const entry of remoteEntriesForSync) {
        const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
        if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
          continue;
        }
        if (options?.excludeRelativePath?.(relativePath)) {
          continue;
        }

        if (!relativePath) {
          continue;
        }

        if (entry.key.endsWith("/")) {
          addDirectoryWithParents(relativePath, remoteDirectories);
          explicitRemoteDirectories.add(relativePath);
          continue;
        }

        remoteFiles.set(relativePath, entry);
        const parentDirectory = normalizeRelativePath(path.posix.dirname(relativePath));
        if (parentDirectory && parentDirectory !== ".") {
          addDirectoryWithParents(parentDirectory, remoteDirectories);
        }
      }

      const concurrency = resolveDirectorySyncConcurrency();
      const nativePlan = await collectNativeRemoteToLocalPlanIfAvailable(localDir, remotePrefix, remoteEntriesForSync, options);
      let removedPathCount = 0;
      if (nativePlan) {
        await runWithConcurrency(nativePlan.removePaths, concurrency, async (targetPath) => {
          await rm(targetPath, { recursive: true, force: true });
        });
        removedPathCount = nativePlan.removePaths.length;
      } else {
        removedPathCount = await removeUnexpectedLocalEntries(localDir, new Set(remoteFiles.keys()), remoteDirectories, options);
      }

      const orderedDirectories = nativePlan?.directoriesToCreate ?? [...remoteDirectories].sort((left, right) => {
        const depthDifference = left.split("/").length - right.split("/").length;
        return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
      });
      let createdDirectoryCount = 0;
      await runWithConcurrency(orderedDirectories, concurrency, async (relativePath) => {
        const targetPath = path.join(localDir, relativePath);
        const existing = await statIfExists(targetPath);
        if (existing && !existing.isDirectory()) {
          await rm(targetPath, { recursive: true, force: true });
        }
        if (!existing?.isDirectory()) {
          createdDirectoryCount += 1;
        }
        await mkdir(targetPath, { recursive: true });
      });

      if (syncManifestDocument?.storageMode === "bundle") {
        const hydratedFromPrimaryBundle = await maybeHydrateFromObjectStorageBundle({
          store,
          remotePrefix,
          localDir,
          remoteEntries: prefetchedEntries,
          manifestDocument: syncManifestDocument,
          requireEmptyLocalDir: false,
          logger
        });
        if (!hydratedFromPrimaryBundle) {
          throw new Error(`failed to hydrate bundle-primary prefix ${(remotePrefix || ".").trim() || "."} from sync bundle`);
        }

        return {
          localFingerprint: await computeLocalDirectoryFingerprint(localDir, options),
          removedPathCount,
          createdDirectoryCount,
          downloadedFileCount: countRemoteMaterializedFiles(remotePrefix, prefetchedEntries, options, syncManifestDocument)
        };
      }

      const fingerprintFiles: Array<{ relativePath: string; size: number; mtimeMs: number }> = [];
      let downloadedFileCount = 0;

      const syncRemoteFile = async (input: {
        relativePath: string;
        targetPath: string;
        entry: ObjectStorageEntry;
      }): Promise<void> => {
        const existing = await statIfExists(input.targetPath);
        if (existing && !existing.isFile()) {
          await rm(input.targetPath, { recursive: true, force: true });
        }

        await mkdir(path.dirname(input.targetPath), { recursive: true });

        const currentFile = existing?.isFile() ? existing : null;
        let resolvedMtimeMs: number | undefined;
        if (currentFile && currentFile.size === input.entry.size) {
          const manifestEntry = syncManifest.get(input.relativePath);
          if (
            manifestEntry &&
            manifestEntry.size === input.entry.size &&
            isMaterializedMtimeMatch(currentFile.mtimeMs, manifestEntry.mtimeMs)
          ) {
            fingerprintFiles.push({
              relativePath: input.relativePath,
              size: input.entry.size,
              mtimeMs: Math.trunc(currentFile.mtimeMs)
            });
            return;
          }

          const objectInfo = await store.getObjectInfo?.(input.entry.key);
          resolvedMtimeMs = resolveTargetMtimeMs({
            metadata: objectInfo?.metadata,
            lastModified: objectInfo?.lastModified ?? input.entry.lastModified
          });
          if (typeof resolvedMtimeMs === "number" && isMaterializedMtimeMatch(currentFile.mtimeMs, resolvedMtimeMs)) {
            fingerprintFiles.push({
              relativePath: input.relativePath,
              size: input.entry.size,
              mtimeMs: Math.trunc(currentFile.mtimeMs)
            });
            return;
          }
        }

        const object = store.getObjectToFile
          ? await store.getObjectToFile(input.entry.key, input.targetPath)
          : await store.getObject(input.entry.key).then(async (downloaded) => {
              await writeFile(input.targetPath, downloaded.body);
              return downloaded;
            });
        downloadedFileCount += 1;
        resolvedMtimeMs =
          resolveTargetMtimeMs({
            metadata: object.metadata,
            lastModified: input.entry.lastModified
          }) ?? Math.trunc(input.entry.lastModified?.getTime() ?? Date.now());
        if (typeof resolvedMtimeMs === "number") {
          const preservedDate = new Date(resolvedMtimeMs);
          await utimes(input.targetPath, preservedDate, preservedDate);
        }
        const materializedFile = await stat(input.targetPath);
        fingerprintFiles.push({
          relativePath: input.relativePath,
          size: materializedFile.size,
          mtimeMs: Math.trunc(materializedFile.mtimeMs)
        });
      };

      const nativeDownloadCandidates =
        nativePlan?.downloadCandidates.map((candidate) => ({
          relativePath: candidate.relativePath,
          targetPath: candidate.targetPath,
          entry: remoteFiles.get(candidate.relativePath)
        })) ??
        [...remoteFiles.entries()].map(([relativePath, entry]) => ({
          relativePath,
          targetPath: path.join(localDir, relativePath),
          entry
        }));

      await runWithConcurrency(nativeDownloadCandidates, concurrency, async ({ relativePath, targetPath, entry }) => {
        if (!entry || !relativePath) {
          return;
        }
        await syncRemoteFile({ relativePath, targetPath, entry });
      });

      if (nativePlan) {
        await runWithConcurrency(nativePlan.infoCheckCandidates, concurrency, async (candidate) => {
          const entry = remoteFiles.get(candidate.relativePath);
          if (!entry) {
            return;
          }
          await syncRemoteFile({
            relativePath: candidate.relativePath,
            targetPath: candidate.targetPath,
            entry
          });
        });
      }

      return {
        localFingerprint: createDirectoryFingerprintFromEntries({
          files: fingerprintFiles,
          emptyDirectories: resolveEmptyRemoteDirectories({
            explicitDirectories: explicitRemoteDirectories,
            filePaths: remoteFiles.keys()
          })
        }),
        removedPathCount,
        createdDirectoryCount,
        downloadedFileCount
      };
    }
  });
}

export async function syncLocalDirectoryToRemote(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  logger?: (message: string) => void,
  label?: string,
  options?: DirectorySyncOptions
): Promise<DirectorySyncResult> {
  logger?.(`syncing local changes in ${localDir} back to object storage (${(label ?? remotePrefix) || "."})`);
  const nativeSyncResult = await syncNativeLocalDirectoryToRemoteIfAvailable(store, remotePrefix, localDir, label, options);
  if (nativeSyncResult) {
    return nativeSyncResult;
  }

  let bundleWriteHandledInPrimaryPath = false;
  const result = await observeNativeWorkspaceSyncOperation({
    operation: "sync_local_to_remote",
    implementation: "ts",
    target: localDir,
    logSuccess: false,
    logFailure: false,
    metadata: {
      remotePrefix
    },
    action: async () => {
      let uploadedFileCount = 0;
      let createdEmptyDirectoryCount = 0;
      const concurrency = resolveDirectorySyncConcurrency();
      const nativeSnapshot = await collectNativeSnapshotIfAvailable(localDir, options);
      const snapshot = nativeSnapshot?.snapshot ?? (await collectLocalDirectorySnapshot(localDir, options));
      enforceLocalDirectorySyncBudget(
        snapshot,
        `local directory ${localDir} for object storage prefix ${((label ?? remotePrefix) || ".").trim() || "."}`
      );
      const localFingerprint = nativeSnapshot?.fingerprint ?? createDirectoryFingerprint(snapshot);
      const snapshotFiles = [...snapshot.files.entries()].map(([relativePath, file]) => ({
        relativePath,
        size: file.size,
        mtimeMs: Math.trunc(file.mtimeMs)
      }));
      const bundleConfig = resolveObjectStorageBundleConfig();
      const bundlePrimaryEnabled = bundleConfig.layout === "primary" && shouldAttemptObjectStorageBundle({ files: snapshotFiles });
      const desiredPrimaryManifest = bundlePrimaryEnabled
        ? buildDirectorySyncManifestFromFiles(snapshotFiles, {
            emptyDirectories: snapshot.emptyDirectories,
            storageMode: "bundle"
          })
        : undefined;

      if (bundlePrimaryEnabled) {
        bundleWriteHandledInPrimaryPath = true;
        const assumeEmptyTrustedPrefix = shouldAssumeEmptyTrustedManagedObjectStoragePrefix(remotePrefix);
        const existingManifestDocument = assumeEmptyTrustedPrefix
          ? undefined
          : await loadRemoteDirectorySyncManifestDocument(store, remotePrefix);
        const syncManifest = existingManifestDocument
          ? new Map(
              Object.entries(existingManifestDocument.files)
                .map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
                .filter(
                  (entry): entry is readonly [string, DirectorySyncManifestFileEntry] =>
                    entry[0].length > 0 && isDirectorySyncManifestFileEntry(entry[1])
                )
            )
          : new Map<string, DirectorySyncManifestFileEntry>();
        uploadedFileCount = countManifestFileMutations(snapshot, existingManifestDocument);
        const manifestDeletedRemoteCount = countManifestDeletedFiles(snapshot, existingManifestDocument);
        createdEmptyDirectoryCount = countManifestCreatedEmptyDirectories(snapshot, existingManifestDocument);
        const manifestChanged = !isEquivalentDirectorySyncManifestDocument(existingManifestDocument, desiredPrimaryManifest);
        let deletedRemoteCount = manifestDeletedRemoteCount;

        if (manifestChanged) {
          await maybeWriteObjectStorageBundle({
            store,
            remotePrefix,
            localDir,
            options,
            logger
          });

          let keysToDelete: string[] = [];
          if (existingManifestDocument && existingManifestDocument.storageMode !== "bundle") {
            keysToDelete = buildManagedRemoteKeysFromManifestDocument(remotePrefix, existingManifestDocument, options).filter(
              (key) => key !== buildRemoteKey(remotePrefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH)
            );
          } else if (!existingManifestDocument && !shouldTrustManagedObjectStoragePrefixes()) {
            deletedRemoteCount = await deleteRemoteEntriesMatching({
              store,
              remotePrefix,
              shouldDelete: (entry) => {
                const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
                if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
                  return false;
                }
                return true;
              }
            });
          }

          if (keysToDelete.length > 0) {
            await store.deleteObjects(keysToDelete);
            deletedRemoteCount = keysToDelete.length;
          }

          await writeRemoteDirectorySyncManifest({
            store,
            remotePrefix,
            existingManifest: syncManifest,
            existingManifestDocument,
            files: snapshotFiles,
            emptyDirectories: snapshot.emptyDirectories,
            storageMode: "bundle"
          });
        }

        return {
          localFingerprint,
          uploadedFileCount,
          deletedRemoteCount,
          createdEmptyDirectoryCount
        };
      }

      const existingManifestDocument = store.listEntriesPaged
        ? await loadRemoteDirectorySyncManifestDocument(store, remotePrefix)
        : undefined;
      const remoteEntries = existingManifestDocument
        ? buildSyntheticRemoteEntriesFromManifestDocument(remotePrefix, existingManifestDocument, options, true)
        : await collectObjectStorageEntries(store, remotePrefix);
      const resolvedManifestDocument =
        existingManifestDocument ?? (await loadRemoteDirectorySyncManifestDocument(store, remotePrefix, remoteEntries));
      const syncManifest = resolvedManifestDocument
        ? new Map(
            Object.entries(resolvedManifestDocument.files)
              .map(([relativePath, entry]) => [normalizeRelativePath(relativePath), entry] as const)
              .filter(
                (entry): entry is readonly [string, DirectorySyncManifestFileEntry] =>
                  entry[0].length > 0 && isDirectorySyncManifestFileEntry(entry[1])
              )
          )
        : await loadRemoteDirectorySyncManifest(store, remotePrefix, remoteEntries);
      const remoteByRelativePath = buildNormalizedRemoteEntryMap(remotePrefix, remoteEntries, options);

      const nativePlan = await collectNativeLocalToRemotePlanIfAvailable(localDir, remotePrefix, remoteEntries, options);

      if (nativePlan) {
        await runWithConcurrency(nativePlan.uploadCandidates, concurrency, async (candidate) => {
          if (
            await putLocalFileObject({
              store,
              key: buildRemoteKey(remotePrefix, candidate.relativePath),
              filePath: candidate.absolutePath,
              mtimeMs: candidate.mtimeMs
            })
          ) {
            uploadedFileCount += 1;
          }
        });

        await runWithConcurrency(nativePlan.infoCheckCandidates, concurrency, async (candidate) => {
          const remoteEntry = remoteByRelativePath.get(candidate.relativePath);
          if (!remoteEntry || remoteEntry.key.endsWith("/")) {
            if (
              await putLocalFileObject({
                store,
                key: buildRemoteKey(remotePrefix, candidate.relativePath),
                filePath: candidate.absolutePath,
                mtimeMs: candidate.mtimeMs
              })
            ) {
              uploadedFileCount += 1;
            }
            return;
          }

          const manifestEntry = syncManifest.get(candidate.relativePath);
          if (
            manifestEntry &&
            manifestEntry.size === candidate.size &&
            manifestEntry.mtimeMs === Math.trunc(candidate.mtimeMs)
          ) {
            return;
          }

          const remoteInfo = await store.getObjectInfo?.(remoteEntry.key);
          const remoteMtimeMs = resolveTargetMtimeMs({
            metadata: remoteInfo?.metadata,
            lastModified: remoteInfo?.lastModified ?? remoteEntry.lastModified
          });
          if (typeof remoteMtimeMs === "number" && remoteMtimeMs === Math.trunc(candidate.mtimeMs)) {
            return;
          }
          if (!remoteInfo && remoteEntry.lastModified && remoteEntry.lastModified.getTime() >= Math.trunc(candidate.mtimeMs)) {
            return;
          }

          if (
            await putLocalFileObject({
              store,
              key: buildRemoteKey(remotePrefix, candidate.relativePath),
              filePath: candidate.absolutePath,
              mtimeMs: candidate.mtimeMs
            })
          ) {
            uploadedFileCount += 1;
          }
        });

        await runWithConcurrency(nativePlan.emptyDirectoriesToCreate, concurrency, async (relativePath) => {
          await store.putObject(`${buildRemoteKey(remotePrefix, relativePath)}/`, Buffer.alloc(0));
          createdEmptyDirectoryCount += 1;
        });

        if (nativePlan.keysToDelete.length > 0) {
          await store.deleteObjects(nativePlan.keysToDelete);
        }

        await writeRemoteDirectorySyncManifest({
          store,
          remotePrefix,
          existingManifest: syncManifest,
          existingManifestDocument: resolvedManifestDocument,
          files: snapshotFiles,
          emptyDirectories: snapshot.emptyDirectories,
          storageMode: "objects"
        });
        return {
          localFingerprint: nativePlan.fingerprint,
          uploadedFileCount,
          deletedRemoteCount: nativePlan.keysToDelete.length,
          createdEmptyDirectoryCount
        };
      }

      const seenRemoteRelativePaths = new Set<string>();

      await runWithConcurrency([...snapshot.files.entries()], concurrency, async ([relativePath, file]) => {
        const remoteEntry = remoteByRelativePath.get(relativePath);
        seenRemoteRelativePaths.add(relativePath);
        if (remoteEntry && !remoteEntry.key.endsWith("/") && remoteEntry.size === file.size) {
          const manifestEntry = syncManifest.get(relativePath);
          if (
            manifestEntry &&
            manifestEntry.size === file.size &&
            manifestEntry.mtimeMs === Math.trunc(file.mtimeMs)
          ) {
            return;
          }

          const remoteInfo = await store.getObjectInfo?.(remoteEntry.key);
          const remoteMtimeMs = resolveTargetMtimeMs({
            metadata: remoteInfo?.metadata,
            lastModified: remoteInfo?.lastModified ?? remoteEntry.lastModified
          });
          if (typeof remoteMtimeMs === "number" && remoteMtimeMs === Math.trunc(file.mtimeMs)) {
            return;
          }
          if (!remoteInfo && remoteEntry.lastModified && remoteEntry.lastModified.getTime() >= Math.trunc(file.mtimeMs)) {
            return;
          }
        }

        if (
          await putLocalFileObject({
            store,
            key: buildRemoteKey(remotePrefix, relativePath),
            filePath: file.absolutePath,
            mtimeMs: file.mtimeMs
          })
        ) {
          uploadedFileCount += 1;
        }
      });

      await runWithConcurrency([...snapshot.emptyDirectories], concurrency, async (relativePath) => {
        seenRemoteRelativePaths.add(relativePath);
        const remoteEntry = remoteByRelativePath.get(relativePath);
        if (remoteEntry?.key.endsWith("/")) {
          return;
        }
        await store.putObject(`${buildRemoteKey(remotePrefix, relativePath)}/`, Buffer.alloc(0));
        createdEmptyDirectoryCount += 1;
      });

      const keysToDelete: string[] = [];
      for (const [relativePath, remoteEntry] of remoteByRelativePath.entries()) {
        if (relativePath === "/") {
          continue;
        }
        if (!seenRemoteRelativePaths.has(relativePath)) {
          keysToDelete.push(remoteEntry.key);
        }
      }

      if (keysToDelete.length > 0) {
        await store.deleteObjects(keysToDelete);
      }

      await writeRemoteDirectorySyncManifest({
        store,
        remotePrefix,
        existingManifest: syncManifest,
        existingManifestDocument: resolvedManifestDocument,
        files: snapshotFiles,
        emptyDirectories: snapshot.emptyDirectories,
        storageMode: "objects"
      });
      return {
        localFingerprint,
        uploadedFileCount,
        deletedRemoteCount: keysToDelete.length,
        createdEmptyDirectoryCount
      };
    }
  });
  if (!bundleWriteHandledInPrimaryPath) {
    await maybeWriteObjectStorageBundle({
      store,
      remotePrefix,
      localDir,
      options,
      logger,
      skipWrite: !hasDirectorySyncMutations(result)
    });
  }
  await pruneEmptyDirectories(localDir);
  return result;
}
