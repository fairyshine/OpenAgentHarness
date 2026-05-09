import { performance } from "node:perf_hooks";

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
import {
  enforceLocalDirectorySyncBudget,
  hasObjectStorageSyncBudgetPolicy,
  resolveDirectorySyncConcurrency,
  resolveNativeInlineUploadThresholdBytes,
  resolveObjectStorageBundleConfig,
  shouldTrustManagedObjectStoragePrefixes
} from "./object-storage-config.js";
import {
  buildRemoteKey,
  INTERNAL_SYNC_BUNDLE_RELATIVE_PATH,
  INTERNAL_SYNC_MANIFEST_RELATIVE_PATH,
  relativePathFromRemoteKey,
  shouldIgnoreRelativePath
} from "./object-storage-manifest.js";
import {
  collectLocalDirectorySnapshot,
  createDirectoryFingerprint
} from "./object-storage-local-snapshot.js";
import {
  shouldExcludeWorkspaceBackingStoreRelativePath,
  shouldExcludeWorkspaceMirrorRelativePath
} from "./object-storage-path-filters.js";
import type {
  DirectoryObjectStore,
  DirectorySyncOptions,
  LocalDirectorySnapshot,
  ManagedPathKey,
  ObjectStorageEntry
} from "./object-storage-types.js";
import type {
  DirectorySyncResult,
  RemoteToLocalDirectorySyncPhaseTimings,
  RemoteToLocalDirectorySyncResult
} from "./object-storage-sync-types.js";

export interface ManagedPathFingerprintInput {
  key: ManagedPathKey;
  localDir: string;
}

export function resolveNativeFingerprintExcludes(options?: DirectorySyncOptions): string[] | undefined {
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

export function resolveMirrorFingerprintOptions(mapping?: { key: ManagedPathKey } | undefined): DirectorySyncOptions | undefined {
  return mapping?.key === "workspace"
    ? {
        excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath
      }
    : undefined;
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

export async function computeLocalDirectoryFingerprint(
  rootDir: string,
  options?: DirectorySyncOptions
): Promise<string> {
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

export async function collectNativeSnapshotIfAvailable(
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

export async function captureManagedPathFingerprints(
  mappings: readonly ManagedPathFingerprintInput[]
): Promise<Map<ManagedPathKey, string> | undefined> {
  const fingerprints = new Map<ManagedPathKey, string>();
  if (mappings.length === 0) {
    return fingerprints;
  }

  const nativeInputs = mappings.map((mapping) => {
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

  if (!isNativeWorkspaceSyncEnabled() || !nativeInputs.every((entry) => entry !== undefined)) {
    return undefined;
  }

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

    return fingerprints.size === mappings.length ? fingerprints : undefined;
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "fingerprint_batch",
      target: "object-storage-mirror",
      error,
      metadata: {
        directoryCount: mappings.length
      }
    });
    return undefined;
  }
}

function nativeRemoteEntriesFromObjectEntries(
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[] | undefined,
  options?: DirectorySyncOptions
):
  | Array<{
      relativePath: string;
      key: string;
      size: number;
      lastModifiedMs?: number | undefined;
      isDirectory: boolean;
    }>
  | undefined {
  return remoteEntries
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
}

export async function collectNativeLocalToRemotePlanIfAvailable(
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
          remoteEntries: nativeRemoteEntriesFromObjectEntries(remotePrefix, remoteEntries, options) ?? []
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

export async function syncNativeLocalDirectoryToRemoteIfAvailable(
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

export async function collectNativeRemoteToLocalPlanIfAvailable(
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
          remoteEntries: nativeRemoteEntriesFromObjectEntries(remotePrefix, remoteEntries, options) ?? []
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

export async function syncNativeRemotePrefixToLocalIfAvailable(
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
    const nativeRemoteEntries = nativeRemoteEntriesFromObjectEntries(remotePrefix, prefetchedEntries, options);
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
