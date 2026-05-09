import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { observeNativeWorkspaceSyncOperation } from "./observability/native-workspace-sync.js";
import { resolveDirectorySyncConcurrency, resolveObjectStorageBundleConfig } from "./object-storage-config.js";
import {
  buildSyntheticRemoteEntriesFromManifestDocument,
  isDirectorySyncManifestFileEntry,
  loadRemoteDirectorySyncManifest,
  loadRemoteDirectorySyncManifestDocument,
  normalizeRelativePath,
  parseObjectMtimeMs,
  relativePathFromRemoteKey,
  shouldIgnoreRelativePath,
  type DirectorySyncManifestFileEntry
} from "./object-storage-manifest.js";
import {
  createDirectoryFingerprintFromEntries,
  resolveEmptyRemoteDirectories
} from "./object-storage-local-snapshot.js";
import {
  collectNativeRemoteToLocalPlanIfAvailable,
  computeLocalDirectoryFingerprint,
  syncNativeRemotePrefixToLocalIfAvailable
} from "./object-storage-native-sync.js";
import {
  countRemoteMaterializedFiles,
  maybeHydrateFromObjectStorageBundle
} from "./object-storage-sync-bundles.js";
import { runWithConcurrency } from "./object-storage-sync-utils.js";
import type {
  DirectoryObjectStore,
  DirectorySyncOptions,
  ObjectStorageEntry
} from "./object-storage-types.js";
import type { RemoteToLocalDirectorySyncResult } from "./object-storage-sync-types.js";
import { collectObjectStorageEntries, isNotFoundError } from "./object-storage-remote-ops.js";

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
  let syncManifestDocument: Awaited<ReturnType<typeof loadRemoteDirectorySyncManifestDocument>> | undefined;

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
