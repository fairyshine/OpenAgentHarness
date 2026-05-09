import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

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
  type NativeSyncBundleConfig
} from "@oah/native-bridge";

import {
  observeNativeWorkspaceSyncOperation,
  recordNativeWorkspaceSyncFallback
} from "./observability/native-workspace-sync.js";
import { recordObjectStorageOperation } from "./observability/object-storage.js";
import {
  createObjectStorageSyncBudget,
  enforceLocalDirectorySyncBudget,
  hasObjectStorageSyncBudgetPolicy,
  resolveDirectorySyncConcurrency,
  resolveNativeInlineUploadThresholdBytes,
  resolveObjectStorageBundleConfig,
  resolveObjectStorageBundleTimeoutMs,
  shouldAssumeEmptyTrustedManagedObjectStoragePrefix,
  shouldTrustManagedObjectStoragePrefixes
} from "./object-storage-config.js";
import {
  extractTarStreamToDirectory,
  isDirectoryEmpty,
  runLocalProcess,
  shouldAttemptObjectStorageBundle,
  withObjectStorageBundleExtractRoot,
  withObjectStorageBundleFile,
  withObjectStorageBundleStream
} from "./object-storage-bundle.js";
import {
  INTERNAL_SYNC_BUNDLE_RELATIVE_PATH,
  INTERNAL_SYNC_MANIFEST_RELATIVE_PATH,
  buildDirectorySyncManifestFromFiles,
  buildManagedRemoteKeysFromManifestDocument,
  buildRemoteKey,
  buildSyntheticRemoteEntriesFromManifestDocument,
  countManifestCreatedEmptyDirectories,
  countManifestDeletedFiles,
  countManifestFileMutations,
  isDirectorySyncManifestFileEntry,
  isEquivalentDirectorySyncManifestDocument,
  loadRemoteDirectorySyncManifest,
  loadRemoteDirectorySyncManifestDocument,
  normalizePrefix,
  normalizeRelativePath,
  parseObjectMtimeMs,
  relativePathFromRemoteKey,
  shouldIgnoreRelativePath,
  writeRemoteDirectorySyncManifest,
  type DirectorySyncManifestDocument,
  type DirectorySyncManifestFileEntry
} from "./object-storage-manifest.js";
import {
  collectLocalDirectorySnapshot,
  createDirectoryFingerprint,
  createDirectoryFingerprintFromEntries,
  resolveEmptyRemoteDirectories
} from "./object-storage-local-snapshot.js";
import { S3DirectoryStore } from "./object-storage-s3.js";
import {
  type DirectoryObjectStore,
  type DirectorySyncOptions,
  type LocalDirectorySnapshot,
  type ManagedPathKey,
  type ObjectStorageConfig,
  type ObjectStorageEntry
} from "./object-storage-types.js";

export { normalizeAwsS3Module } from "./object-storage-s3.js";
export type { DirectoryObjectStore, ManagedPathKey, ObjectStorageConfig, ObjectStorageEntry } from "./object-storage-types.js";

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
const DEFAULT_MANAGED_PATHS = Object.keys(DEFAULT_KEY_PREFIXES) as ManagedPathKey[];

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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

  const timeoutMs = resolveObjectStorageBundleTimeoutMs();
  const startedAt = performance.now();
  return withObjectStorageBundleExtractRoot(async ({ bundlePath }) => {
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
    }
  });
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
