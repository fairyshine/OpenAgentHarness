import { readFile } from "node:fs/promises";

import { createObjectStorageSyncBudget } from "./object-storage-config.js";
import type { DirectoryObjectStore, ObjectStorageEntry } from "./object-storage-types.js";

export function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function collectObjectStorageEntries(
  store: DirectoryObjectStore,
  prefix: string
): Promise<ObjectStorageEntry[]> {
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

export async function deleteObjectStorageKeysInChunks(
  store: DirectoryObjectStore,
  keys: Iterable<string>
): Promise<number> {
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

export async function deleteRemoteEntriesMatching(input: {
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

export async function putLocalFileObject(input: {
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
