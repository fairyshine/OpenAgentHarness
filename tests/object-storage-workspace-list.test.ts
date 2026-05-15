import { describe, expect, it, vi } from "vitest";

import type {
  DirectoryObjectStore,
  ObjectStorageDirectoryEntry,
  ObjectStorageEntry
} from "../apps/server/src/object-storage.ts";
import { createObjectStorageWorkspaceEntryLister } from "../apps/server/src/object-storage-workspace-list.ts";

class FakeDirectoryObjectStore implements DirectoryObjectStore {
  readonly bucket = "test-bucket";
  readonly entries: ObjectStorageEntry[];
  listCalls = 0;
  directoryListCalls: Array<{ prefix: string; directory: string }> = [];
  directoryEntries?: ObjectStorageDirectoryEntry[] | undefined;

  constructor(entries: ObjectStorageEntry[], directoryEntries?: ObjectStorageDirectoryEntry[] | undefined) {
    this.entries = entries;
    this.directoryEntries = directoryEntries;
  }

  async listEntries(prefix: string): Promise<ObjectStorageEntry[]> {
    this.listCalls += 1;
    const normalizedPrefix = prefix ? `${prefix}/` : "";
    return this.entries.filter((entry) => entry.key.startsWith(normalizedPrefix));
  }

  async listDirectoryEntries(prefix: string, directory: string): Promise<ObjectStorageDirectoryEntry[]> {
    if (!this.directoryEntries) {
      return this.listEntries(prefix).then((entries) =>
        entries
          .map((entry) => ({
            name: entry.key.split("/").at(-1) ?? entry.key,
            kind: "file" as const,
            size: entry.size,
            lastModified: entry.lastModified
          }))
      );
    }
    this.directoryListCalls.push({ prefix, directory });
    return this.directoryEntries;
  }

  async getObject(): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }> {
    throw new Error("getObject should not be called for directory listing");
  }

  async putObject(): Promise<void> {
    throw new Error("putObject should not be called for directory listing");
  }

  async deleteObjects(): Promise<void> {
    throw new Error("deleteObjects should not be called for directory listing");
  }
}

class PrefixOnlyDirectoryObjectStore extends FakeDirectoryObjectStore {
  listDirectoryEntries = undefined;
}

function entry(key: string, size: number, date: string): ObjectStorageEntry {
  return {
    key,
    size,
    lastModified: new Date(date)
  };
}

describe("object storage workspace entry lister", () => {
  it("lists a cold object-store workspace directory without materializing file bodies", async () => {
    const store = new FakeDirectoryObjectStore([], [
      { name: "README.md", kind: "file", size: 12, lastModified: new Date("2026-05-01T00:00:00.000Z") },
      { name: "src", kind: "directory" },
      { name: ".oah-sync-manifest.json", kind: "file", size: 100, lastModified: new Date("2026-05-04T00:00:00.000Z") }
    ]);
    const prewarmWorkspace = vi.fn();
    const lister = createObjectStorageWorkspaceEntryLister({
      store,
      async getWorkspaceRecord() {
        return {
          id: "ws_1",
          rootPath: "/workspace/ws_1",
          externalRef: "s3://test-bucket/workspace/ws_1",
          readOnly: false
        };
      },
      prewarmWorkspace
    });

    const page = await lister({
      workspaceId: "ws_1",
      path: ".",
      pageSize: 10,
      sortBy: "name",
      sortOrder: "asc",
      includeEntryMetadata: false,
      includeDirectoryDescendantUpdatedAt: false
    });

    expect(page).toEqual({
      workspaceId: "ws_1",
      path: ".",
      items: [
        {
          path: "README.md",
          name: "README.md",
          type: "file",
          readOnly: false
        },
        {
          path: "src",
          name: "src",
          type: "directory",
          readOnly: false
        }
      ]
    });
    expect(store.listCalls).toBe(0);
    expect(store.directoryListCalls).toEqual([
      {
        prefix: "workspace/ws_1",
        directory: ""
      }
    ]);
    expect(prewarmWorkspace).toHaveBeenCalledWith("ws_1");
  });

  it("uses descendant file times for directory updatedAt when requested", async () => {
    const store = new PrefixOnlyDirectoryObjectStore([
      entry("workspace/ws_1/src/a.ts", 10, "2026-05-01T00:00:00.000Z"),
      entry("workspace/ws_1/src/nested/b.ts", 10, "2026-05-03T00:00:00.000Z")
    ]);
    const lister = createObjectStorageWorkspaceEntryLister({
      store,
      async getWorkspaceRecord() {
        return {
          id: "ws_1",
          rootPath: "/workspace/ws_1",
          externalRef: "s3://test-bucket/workspace/ws_1",
          readOnly: true
        };
      }
    });

    const page = await lister({
      workspaceId: "ws_1",
      path: ".",
      pageSize: 10,
      sortBy: "name",
      sortOrder: "asc",
      includeEntryMetadata: true,
      includeDirectoryDescendantUpdatedAt: true
    });

    expect(page?.items).toEqual([
      {
        path: "src",
        name: "src",
        type: "directory",
        updatedAt: "2026-05-03T00:00:00.000Z",
        readOnly: true
      }
    ]);
  });

  it("returns undefined when the workspace should use its materialized local copy", async () => {
    const store = new FakeDirectoryObjectStore([
      entry("workspace/ws_1/README.md", 12, "2026-05-01T00:00:00.000Z")
    ]);
    const lister = createObjectStorageWorkspaceEntryLister({
      store,
      shouldUseObjectStoreList: () => false,
      async getWorkspaceRecord() {
        return {
          id: "ws_1",
          rootPath: "/workspace/ws_1",
          externalRef: "s3://test-bucket/workspace/ws_1",
          readOnly: false
        };
      }
    });

    await expect(
      lister({
        workspaceId: "ws_1",
        path: ".",
        pageSize: 10,
        sortBy: "name",
        sortOrder: "asc"
      })
    ).resolves.toBeUndefined();
    expect(store.listCalls).toBe(0);
  });
});
