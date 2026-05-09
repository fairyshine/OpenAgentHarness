import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { recordObjectStorageOperation } from "./observability/object-storage.js";
import {
  enforceLocalDirectorySyncBudget,
  resolveObjectStorageBundleTimeoutMs
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
  buildRemoteKey,
  INTERNAL_SYNC_BUNDLE_RELATIVE_PATH,
  isDirectorySyncManifestFileEntry,
  normalizeRelativePath,
  relativePathFromRemoteKey,
  shouldIgnoreRelativePath,
  type DirectorySyncManifestDocument
} from "./object-storage-manifest.js";
import { collectLocalDirectorySnapshot } from "./object-storage-local-snapshot.js";
import { collectNativeSnapshotIfAvailable } from "./object-storage-native-sync.js";
import type {
  DirectoryObjectStore,
  DirectorySyncOptions,
  ObjectStorageEntry
} from "./object-storage-types.js";

export async function maybeWriteObjectStorageBundle(input: {
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

export async function maybeHydrateFromObjectStorageBundle(input: {
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

export function countRemoteMaterializedFiles(
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
