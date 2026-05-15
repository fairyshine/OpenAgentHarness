import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeObjectStorageConfig, type ServerConfig } from "@oah/config";

import { observeNativeWorkspaceSyncOperation } from "./observability/native-workspace-sync.js";
import {
  enforceLocalDirectorySyncBudget,
  resolveDirectorySyncConcurrency,
  resolveObjectStorageBundleConfig,
  shouldAssumeEmptyTrustedManagedObjectStoragePrefix,
  shouldTrustManagedObjectStoragePrefixes
} from "./object-storage-config.js";
import { shouldAttemptObjectStorageBundle } from "./object-storage-bundle.js";
import {
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
import { collectLocalDirectorySnapshot, createDirectoryFingerprint } from "./object-storage-local-snapshot.js";
import {
  captureManagedPathFingerprints,
  collectNativeLocalToRemotePlanIfAvailable,
  collectNativeSnapshotIfAvailable,
  computeLocalDirectoryFingerprint,
  resolveMirrorFingerprintOptions,
  syncNativeLocalDirectoryToRemoteIfAvailable
} from "./object-storage-native-sync.js";
import {
  shouldExcludeWorkspaceBackingStoreRelativePath,
  shouldExcludeWorkspaceMirrorRelativePath
} from "./object-storage-path-filters.js";
import { S3DirectoryStore } from "./object-storage-s3.js";
import { maybeWriteObjectStorageBundle } from "./object-storage-sync-bundles.js";
import { syncRemotePrefixToLocal } from "./object-storage-remote-to-local.js";
import { hasDirectorySyncMutations, runWithConcurrency } from "./object-storage-sync-utils.js";
import {
  type DirectoryObjectStore,
  type DirectorySyncOptions,
  type ManagedPathKey,
  type ObjectStorageDirectoryEntry,
  type ObjectStorageConfig,
  type ObjectStorageEntry
} from "./object-storage-types.js";
import type {
  DirectorySyncResult,
  RemoteToLocalDirectorySyncResult
} from "./object-storage-sync-types.js";
import {
  collectObjectStorageEntries,
  deleteObjectStorageKeysInChunks,
  deleteRemoteEntriesMatching,
  isNotFoundError,
  putLocalFileObject
} from "./object-storage-remote-ops.js";

export { normalizeAwsS3Module } from "./object-storage-s3.js";
export { computeLocalDirectoryFingerprint } from "./object-storage-native-sync.js";
export { syncRemotePrefixToLocal } from "./object-storage-remote-to-local.js";
export { shouldExcludeWorkspaceBackingStoreRelativePath } from "./object-storage-path-filters.js";
export type {
  DirectoryObjectStore,
  ManagedPathKey,
  ObjectStorageConfig,
  ObjectStorageDirectoryEntry,
  ObjectStorageEntry
} from "./object-storage-types.js";
export type * from "./object-storage-sync-types.js";

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

function resolveManagedPathMapping(
  mappings: readonly ManagedPathMapping[],
  key: ManagedPathKey
): ManagedPathMapping | undefined {
  return mappings.find((candidate) => candidate.key === key);
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

function resolveTargetMtimeMs(input: {
  metadata?: Record<string, string> | undefined;
  lastModified?: Date | undefined;
}): number | undefined {
  return parseObjectMtimeMs(input.metadata) ?? (input.lastModified ? Math.trunc(input.lastModified.getTime()) : undefined);
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

    const nativeFingerprints = await captureManagedPathFingerprints(mappings);
    if (nativeFingerprints) {
      return nativeFingerprints;
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
