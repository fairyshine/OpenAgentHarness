import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DirectoryObjectStore } from "../apps/server/src/object-storage.ts";
import {
  computeLocalDirectoryFingerprint,
  deleteRemotePrefixFromObjectStore,
  ObjectStorageMirrorController,
  syncLocalDirectoryToRemote,
  syncRemotePrefixToLocal,
  syncWorkspaceRootToObjectStore
} from "../apps/server/src/object-storage.ts";

class FakeDirectoryObjectStore implements DirectoryObjectStore {
  readonly bucket = "test-bucket";
  readonly objects = new Map<string, { body: Buffer; lastModified: Date; metadata?: Record<string, string> | undefined }>();
  listEntriesCalls = 0;
  getObjectCalls = 0;
  getObjectInfoCalls = 0;
  putObjectCalls = 0;

  async listEntries(prefix: string) {
    this.listEntriesCalls += 1;
    const normalizedPrefix = prefix ? `${prefix}/` : "";
    return [...this.objects.entries()]
      .filter(([key]) => (normalizedPrefix ? key.startsWith(normalizedPrefix) : true))
      .map(([key, value]) => ({
        key,
        size: value.body.length,
        lastModified: value.lastModified
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async getObject(key: string): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }> {
    this.getObjectCalls += 1;
    const entry = this.objects.get(key);
    if (!entry) {
      throw new Error(`Missing object ${key}`);
    }
    return {
      body: Buffer.from(entry.body),
      ...(entry.metadata ? { metadata: { ...entry.metadata } } : {})
    };
  }

  async getObjectInfo(
    key: string
  ): Promise<{ size?: number | undefined; lastModified?: Date | undefined; metadata?: Record<string, string> | undefined }> {
    this.getObjectInfoCalls += 1;
    const entry = this.objects.get(key);
    if (!entry) {
      throw new Error(`Missing object ${key}`);
    }
    return {
      size: entry.body.length,
      lastModified: entry.lastModified,
      ...(entry.metadata ? { metadata: { ...entry.metadata } } : {})
    };
  }

  async putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void> {
    this.putObjectCalls += 1;
    this.objects.set(key, {
      body: Buffer.from(body),
      lastModified: new Date(),
      ...(typeof options?.mtimeMs === "number" && options.mtimeMs > 0
        ? {
            metadata: {
              "oah-mtime-ms": String(Math.trunc(options.mtimeMs))
            }
          }
        : {})
    });
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
    }
  }

  async close(): Promise<void> {
    return undefined;
  }
}

const tempDirs: string[] = [];

async function importObjectStorageWithFsOverrides(overrides: Partial<typeof import("node:fs/promises")>) {
  vi.resetModules();
  vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "0");
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return { ...actual, ...overrides };
  });
  return import("../apps/server/src/object-storage.ts");
}

async function importObjectStorageWithNativeBridgeOverrides(overrides: Partial<typeof import("@oah/native-bridge")>) {
  vi.resetModules();
  vi.doMock("@oah/native-bridge", async () => {
    const actual = await vi.importActual<typeof import("@oah/native-bridge")>("@oah/native-bridge");
    return { ...actual, ...overrides };
  });
  return import("../apps/server/src/object-storage.ts");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
  vi.unstubAllEnvs();
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("@oah/native-bridge");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("object storage sync", () => {
  it("materializes remote objects into a local directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-pull-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/.openharness/settings.yaml", Buffer.from("default_agent: builder\n"));
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    await store.putObject("workspace/demo/empty-dir/", Buffer.alloc(0));

    await syncRemotePrefixToLocal(store, "workspace/demo", directory);

    await expect(readFile(path.join(directory, ".openharness", "settings.yaml"), "utf8")).resolves.toBe(
      "default_agent: builder\n"
    );
    await expect(readFile(path.join(directory, "README.md"), "utf8")).resolves.toBe("# demo\n");
    expect((await stat(path.join(directory, "empty-dir"))).isDirectory()).toBe(true);
  });

  it("returns the local fingerprint computed during remote-to-local sync", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-pull-fingerprint-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const preservedMtime = new Date("2026-04-18T08:09:10.000Z");

    await store.putObject("workspace/demo/.openharness/settings.yaml", Buffer.from("default_agent: builder\n"));
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"), { mtimeMs: preservedMtime.getTime() });
    await store.putObject("workspace/demo/empty-dir/", Buffer.alloc(0));

    const result = await syncRemotePrefixToLocal(store, "workspace/demo", directory);

    expect(result.localFingerprint).toBe(
      await computeLocalDirectoryFingerprint(directory, {
        excludeRelativePath: undefined
      })
    );
  });

  it("preserves remote lastModified timestamps when materializing locally", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-pull-mtime-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const lastModified = new Date("2026-04-18T08:09:10.000Z");
    store.objects.set("workspace/demo/README.md", {
      body: Buffer.from("# demo\n"),
      lastModified
    });

    await syncRemotePrefixToLocal(store, "workspace/demo", directory);

    const materializedStat = await stat(path.join(directory, "README.md"));
    expect(Math.trunc(materializedStat.mtimeMs)).toBe(lastModified.getTime());
  });

  it("pushes local changes back into remote storage and deletes removed objects", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-push-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/obsolete.txt", Buffer.from("old"));
    await mkdir(path.join(directory, ".openharness"), { recursive: true });
    await mkdir(path.join(directory, "empty-dir"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(directory, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(path.join(directory, ".DS_Store"), "ignore", "utf8");

    await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    const keys = [...store.objects.keys()].sort();
    expect(keys).toEqual([
      "workspace/demo/.oah-sync-manifest.json",
      "workspace/demo/.openharness/settings.yaml",
      "workspace/demo/README.md",
      "workspace/demo/empty-dir/"
    ]);
    expect(store.objects.get("workspace/demo/README.md")?.body.toString("utf8")).toBe("# synced\n");
    expect(store.objects.get("workspace/demo/.openharness/settings.yaml")?.body.toString("utf8")).toBe(
      "default_agent: assistant\n"
    );
  });

  it("skips re-uploading unchanged local files when remote metadata already matches", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-push-skip-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const expectedMtime = new Date("2026-04-18T08:09:10.000Z");

    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await utimes(path.join(directory, "README.md"), expectedMtime, expectedMtime);
    await store.putObject("workspace/demo/README.md", Buffer.from("# synced\n"), { mtimeMs: expectedMtime.getTime() });
    store.putObjectCalls = 0;

    const result = await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(result.uploadedFileCount).toBe(0);
    expect(store.getObjectInfoCalls).toBe(1);
    expect(store.putObjectCalls).toBe(1);
  });

  it("reuses the remote sync manifest to skip unchanged uploads without head requests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-push-manifest-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const expectedMtime = new Date("2026-04-18T08:09:10.000Z");

    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await utimes(path.join(directory, "README.md"), expectedMtime, expectedMtime);

    await syncLocalDirectoryToRemote(store, "workspace/demo", directory);
    store.getObjectCalls = 0;
    store.getObjectInfoCalls = 0;
    store.putObjectCalls = 0;

    const result = await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(result.uploadedFileCount).toBe(0);
    expect(store.getObjectCalls).toBe(1);
    expect(store.getObjectInfoCalls).toBe(0);
    expect(store.putObjectCalls).toBe(0);
  });

  it("writes an object-storage sync bundle sidecar when forced", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");

    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-push-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(directory, "docs", "guide.md"), "hello\n", "utf8");

    await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(store.objects.has("workspace/demo/.oah-sync-bundle.tar")).toBe(true);
  });

  it("skips rewriting the object-storage sync bundle on no-op push", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");

    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-noop-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(directory, "docs", "guide.md"), "hello\n", "utf8");

    await syncLocalDirectoryToRemote(store, "workspace/demo", directory);
    store.getObjectCalls = 0;
    store.getObjectInfoCalls = 0;
    store.putObjectCalls = 0;

    const result = await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(result.uploadedFileCount).toBe(0);
    expect(result.deletedRemoteCount).toBe(0);
    expect(result.createdEmptyDirectoryCount).toBe(0);
    expect(store.getObjectCalls).toBe(1);
    expect(store.getObjectInfoCalls).toBe(0);
    expect(store.putObjectCalls).toBe(0);
  });

  it("stores bundle-primary prefixes as manifest plus bundle in the TS fallback push path", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT", "primary");

    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-push-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(directory, "docs", "guide.md"), "hello\n", "utf8");
    await store.putObject("workspace/demo/old.txt", Buffer.from("stale\n"));
    store.putObjectCalls = 0;

    const result = await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(result.uploadedFileCount).toBe(2);
    expect(store.listEntriesCalls).toBe(1);
    expect(store.putObjectCalls).toBe(2);
    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/demo/.oah-sync-bundle.tar",
      "workspace/demo/.oah-sync-manifest.json"
    ]);
  });

  it("skips remote listing on trusted bundle-primary cold pushes", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT", "primary");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES", "1");

    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-trusted-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(directory, "docs", "guide.md"), "hello\n", "utf8");

    const result = await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(result.uploadedFileCount).toBe(2);
    expect(store.listEntriesCalls).toBe(0);
    expect(store.getObjectCalls).toBe(0);
    expect(store.putObjectCalls).toBe(2);
    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/demo/.oah-sync-bundle.tar",
      "workspace/demo/.oah-sync-manifest.json"
    ]);
  });

  it("skips rewriting bundle-primary prefixes on no-op TS fallback pushes", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT", "primary");

    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-noop-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(directory, "docs", "guide.md"), "hello\n", "utf8");

    await syncLocalDirectoryToRemote(store, "workspace/demo", directory);
    store.listEntriesCalls = 0;
    store.getObjectCalls = 0;
    store.getObjectInfoCalls = 0;
    store.putObjectCalls = 0;

    const result = await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(result.uploadedFileCount).toBe(0);
    expect(result.deletedRemoteCount).toBe(0);
    expect(result.createdEmptyDirectoryCount).toBe(0);
    expect(store.listEntriesCalls).toBe(0);
    expect(store.getObjectCalls).toBe(1);
    expect(store.getObjectInfoCalls).toBe(0);
    expect(store.putObjectCalls).toBe(0);
    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/demo/.oah-sync-bundle.tar",
      "workspace/demo/.oah-sync-manifest.json"
    ]);
  });

  it("migrates manifest-managed object prefixes to bundle-primary without listing remote entries", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT", "primary");

    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-migrate-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(directory, "docs", "guide.md"), "hello\n", "utf8");

    await store.putObject("workspace/demo/README.md", Buffer.from("stale\n"));
    await store.putObject(
      "workspace/demo/.oah-sync-manifest.json",
      Buffer.from(
        `${JSON.stringify({
          version: 1,
          storageMode: "objects",
          files: {
            "README.md": {
              size: 6,
              mtimeMs: 1
            }
          }
        })}\n`,
        "utf8"
      )
    );

    store.listEntriesCalls = 0;
    store.getObjectCalls = 0;

    const result = await syncLocalDirectoryToRemote(store, "workspace/demo", directory);

    expect(result.uploadedFileCount).toBe(2);
    expect(result.deletedRemoteCount).toBe(1);
    expect(store.listEntriesCalls).toBe(0);
    expect(store.getObjectCalls).toBe(1);
    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/demo/.oah-sync-bundle.tar",
      "workspace/demo/.oah-sync-manifest.json"
    ]);
  });

  it("passes configured sync concurrency into native object-storage sync execution", async () => {
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_CONCURRENCY", "3");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT", "primary");
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC_INLINE_UPLOAD_THRESHOLD_BYTES", "262144");

    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-native-push-"));
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-native-pull-"));
    tempDirs.push(sourceDirectory, targetDirectory);

    await writeFile(path.join(sourceDirectory, "README.md"), "# native push\n", "utf8");

    let pushedConcurrency: number | undefined;
    let pulledConcurrency: number | undefined;
    let pushedInlineThreshold: number | undefined;
    let pushedSyncBundle:
      | {
          mode?: string | undefined;
          minFileCount?: number | undefined;
          minTotalBytes?: number | undefined;
        }
      | undefined;
    const objectStorage = await importObjectStorageWithNativeBridgeOverrides({
      isNativeWorkspaceSyncEnabled: () => true,
      syncNativeLocalToRemote: vi.fn(async (input) => {
        pushedConcurrency = input.maxConcurrency;
        pushedInlineThreshold = input.inlineUploadThresholdBytes;
        pushedSyncBundle = input.syncBundle;
        return {
          ok: true as const,
          protocolVersion: 1,
          localFingerprint: "native",
          uploadedFileCount: 1,
          deletedRemoteCount: 0,
          createdEmptyDirectoryCount: 0
        };
      }),
      syncNativeRemoteToLocal: vi.fn(async (input) => {
        pulledConcurrency = input.maxConcurrency;
        return {
          ok: true as const,
          protocolVersion: 1,
          removedPathCount: 0,
          createdDirectoryCount: 0,
          downloadedFileCount: 0
        };
      })
    });

    const store = new FakeDirectoryObjectStore();
    store.getNativeWorkspaceSyncConfig = () => ({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      accessKey: "test",
      secretKey: "test"
    });

    await objectStorage.syncLocalDirectoryToRemote(store, "workspace/demo", sourceDirectory);
    await objectStorage.syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory);

    expect(pushedConcurrency).toBe(3);
    expect(pulledConcurrency).toBe(3);
    expect(pushedInlineThreshold).toBe(262144);
    expect(pushedSyncBundle).toMatchObject({
      mode: "force",
      minFileCount: 16,
      minTotalBytes: 128 * 1024,
      layout: "primary"
    });
    expect(store.putObjectCalls).toBe(0);
  });

  it("skips JS remote prefetch when native remote-to-local sync succeeds", async () => {
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");

    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-native-prefetch-"));
    tempDirs.push(targetDirectory);

    let remoteEntries:
      | Array<{
          relativePath: string;
          key: string;
          size: number;
          lastModifiedMs?: number | undefined;
          isDirectory: boolean;
        }>
      | undefined;
    let hasSyncManifest: boolean | undefined;
    const objectStorage = await importObjectStorageWithNativeBridgeOverrides({
      isNativeWorkspaceSyncEnabled: () => true,
      syncNativeRemoteToLocal: vi.fn(async (input) => {
        remoteEntries = input.remoteEntries;
        hasSyncManifest = input.hasSyncManifest;
        return {
          ok: true as const,
          protocolVersion: 1,
          localFingerprint: "native-materialized-fingerprint",
          removedPathCount: 0,
          createdDirectoryCount: 0,
          downloadedFileCount: 1
        };
      })
    });

    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    await store.putObject("workspace/demo/.oah-sync-manifest.json", Buffer.from("{\"version\":1,\"files\":{}}"));
    store.getNativeWorkspaceSyncConfig = () => ({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      accessKey: "test",
      secretKey: "test"
    });

    await objectStorage.syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory);

    expect(store.listEntriesCalls).toBe(0);
    expect(hasSyncManifest).toBeUndefined();
    expect(remoteEntries).toBeUndefined();
  });

  it("falls back to JS remote prefetch when native remote-to-local sync is unavailable", async () => {
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");

    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-native-prefetch-fallback-"));
    tempDirs.push(targetDirectory);

    const objectStorage = await importObjectStorageWithNativeBridgeOverrides({
      isNativeWorkspaceSyncEnabled: () => true,
      syncNativeRemoteToLocal: vi.fn(async () => {
        throw new Error("native unavailable");
      })
    });

    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    store.getNativeWorkspaceSyncConfig = () => ({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      accessKey: "test",
      secretKey: "test"
    });

    await objectStorage.syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory);

    expect(store.listEntriesCalls).toBe(1);
    await expect(readFile(path.join(targetDirectory, "README.md"), "utf8")).resolves.toBe("# demo\n");
  });

  it("hydrates bundle-primary prefixes during JS fallback cold pulls", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT", "primary");
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");

    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-source-"));
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-target-"));
    tempDirs.push(sourceDirectory, targetDirectory);

    await mkdir(path.join(sourceDirectory, "docs"), { recursive: true });
    await writeFile(path.join(sourceDirectory, "README.md"), "# bundled\n", "utf8");
    await writeFile(path.join(sourceDirectory, "docs", "guide.md"), "hello\n", "utf8");

    const store = new FakeDirectoryObjectStore();
    await syncLocalDirectoryToRemote(store, "workspace/demo", sourceDirectory);
    store.objects.delete("workspace/demo/README.md");
    store.objects.delete("workspace/demo/docs/guide.md");
    store.objects.set("workspace/demo/.oah-sync-manifest.json", {
      body: Buffer.from(
        JSON.stringify({
          version: 1,
          storageMode: "bundle",
          files: {
            "README.md": { size: "# bundled\n".length, mtimeMs: 1_712_000_000_000 },
            "docs/guide.md": { size: "hello\n".length, mtimeMs: 1_712_000_000_001 }
          }
        }),
        "utf8"
      ),
      lastModified: new Date()
    });

    const objectStorage = await importObjectStorageWithNativeBridgeOverrides({
      isNativeWorkspaceSyncEnabled: () => true,
      syncNativeRemoteToLocal: vi.fn(async () => {
        throw new Error("native unavailable");
      })
    });

    store.listEntriesCalls = 0;
    store.getObjectCalls = 0;
    await expect(objectStorage.syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory)).resolves.toMatchObject({
      downloadedFileCount: 2
    });
    await expect(readFile(path.join(targetDirectory, "README.md"), "utf8")).resolves.toBe("# bundled\n");
    await expect(readFile(path.join(targetDirectory, "docs", "guide.md"), "utf8")).resolves.toBe("hello\n");
    expect(store.listEntriesCalls).toBe(0);
    expect(store.getObjectCalls).toBe(2);
  });

  it("hydrates bundle-primary prefixes during JS fallback incremental pulls", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT", "primary");
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");

    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-incremental-source-"));
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-primary-incremental-target-"));
    tempDirs.push(sourceDirectory, targetDirectory);

    await mkdir(path.join(sourceDirectory, "docs"), { recursive: true });
    await writeFile(path.join(sourceDirectory, "README.md"), "# bundled\n", "utf8");
    await writeFile(path.join(sourceDirectory, "docs", "guide.md"), "hello\n", "utf8");

    const store = new FakeDirectoryObjectStore();
    await syncLocalDirectoryToRemote(store, "workspace/demo", sourceDirectory);
    store.objects.delete("workspace/demo/README.md");
    store.objects.delete("workspace/demo/docs/guide.md");
    store.objects.set("workspace/demo/.oah-sync-manifest.json", {
      body: Buffer.from(
        JSON.stringify({
          version: 1,
          storageMode: "bundle",
          files: {
            "README.md": { size: "# bundled\n".length, mtimeMs: 1_712_000_000_000 },
            "docs/guide.md": { size: "hello\n".length, mtimeMs: 1_712_000_000_001 }
          }
        }),
        "utf8"
      ),
      lastModified: new Date()
    });

    await writeFile(path.join(targetDirectory, "README.md"), "# stale\n", "utf8");
    await writeFile(path.join(targetDirectory, "stale.txt"), "remove me\n", "utf8");

    const objectStorage = await importObjectStorageWithNativeBridgeOverrides({
      isNativeWorkspaceSyncEnabled: () => true,
      syncNativeRemoteToLocal: vi.fn(async () => {
        throw new Error("native unavailable");
      })
    });

    store.listEntriesCalls = 0;
    store.getObjectCalls = 0;
    await expect(objectStorage.syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory)).resolves.toMatchObject({
      downloadedFileCount: 2
    });
    await expect(readFile(path.join(targetDirectory, "README.md"), "utf8")).resolves.toBe("# bundled\n");
    await expect(readFile(path.join(targetDirectory, "docs", "guide.md"), "utf8")).resolves.toBe("hello\n");
    await expect(stat(path.join(targetDirectory, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.listEntriesCalls).toBe(0);
    expect(store.getObjectCalls).toBe(2);
  });

  it("returns the native local fingerprint during remote-to-local sync", async () => {
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");

    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-native-fingerprint-"));
    tempDirs.push(targetDirectory);

    const objectStorage = await importObjectStorageWithNativeBridgeOverrides({
      isNativeWorkspaceSyncEnabled: () => true,
      syncNativeRemoteToLocal: vi.fn(async () => ({
        ok: true as const,
        protocolVersion: 1,
        localFingerprint: "native-materialized-fingerprint",
        removedPathCount: 0,
        createdDirectoryCount: 0,
        downloadedFileCount: 0
      }))
    });

    const store = new FakeDirectoryObjectStore();
    store.getNativeWorkspaceSyncConfig = () => ({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      accessKey: "test",
      secretKey: "test"
    });

    await expect(objectStorage.syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory)).resolves.toMatchObject({
      localFingerprint: "native-materialized-fingerprint"
    });
  });

  it("preserves native request counts in sync results", async () => {
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");

    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-native-request-push-"));
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-native-request-pull-"));
    tempDirs.push(sourceDirectory, targetDirectory);

    await writeFile(path.join(sourceDirectory, "README.md"), "# native push\n", "utf8");

    const objectStorage = await importObjectStorageWithNativeBridgeOverrides({
      isNativeWorkspaceSyncEnabled: () => true,
      syncNativeLocalToRemote: vi.fn(async () => ({
        ok: true as const,
        protocolVersion: 1,
        localFingerprint: "native-push",
        uploadedFileCount: 1,
        deletedRemoteCount: 0,
        createdEmptyDirectoryCount: 0,
        requestCounts: {
          listRequests: 1,
          getRequests: 0,
          headRequests: 0,
          putRequests: 2,
          deleteRequests: 0
        },
        phaseTimings: {
          scanMs: 3,
          fingerprintMs: 1,
          clientCreateMs: 6,
          manifestReadMs: 4,
          bundleBuildMs: 18,
          bundleBodyPrepareMs: 2,
          bundleUploadMs: 11,
          bundleTransport: "memory",
          bundleBytes: 4096,
          manifestWriteMs: 2,
          deleteMs: 0,
          totalPrimaryPathMs: 35,
          totalCommandMs: 52
        }
      })),
      syncNativeRemoteToLocal: vi.fn(async () => ({
        ok: true as const,
        protocolVersion: 1,
        localFingerprint: "native-pull",
        removedPathCount: 0,
        createdDirectoryCount: 0,
        downloadedFileCount: 1,
        requestCounts: {
          listRequests: 0,
          getRequests: 1,
          headRequests: 0,
          putRequests: 0,
          deleteRequests: 0
        }
      }))
    });

    const store = new FakeDirectoryObjectStore();
    store.getNativeWorkspaceSyncConfig = () => ({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      accessKey: "test",
      secretKey: "test"
    });

    await expect(objectStorage.syncLocalDirectoryToRemote(store, "workspace/demo", sourceDirectory)).resolves.toMatchObject({
      phaseTimings: {
        scanMs: 3,
        fingerprintMs: 1,
        clientCreateMs: 6,
        manifestReadMs: 4,
        bundleBuildMs: 18,
        bundleBodyPrepareMs: 2,
        bundleUploadMs: 11,
        bundleTransport: "memory",
        bundleBytes: 4096,
        manifestWriteMs: 2,
        deleteMs: 0,
        totalPrimaryPathMs: 35,
        totalCommandMs: 52
      },
      requestCounts: {
        listRequests: 1,
        getRequests: 0,
        headRequests: 0,
        putRequests: 2,
        deleteRequests: 0
      }
    });

    await expect(objectStorage.syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory)).resolves.toMatchObject({
      requestCounts: {
        listRequests: 0,
        getRequests: 1,
        headRequests: 0,
        putRequests: 0,
        deleteRequests: 0
      }
    });
  });

  it("ignores files that disappear while collecting a local snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-snapshot-race-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const disappearingFile = path.join(directory, ".openharness", "agents", "compact-e2e.md");

    await mkdir(path.dirname(disappearingFile), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(disappearingFile, "agent prompt\n", "utf8");

    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const objectStorage = await importObjectStorageWithFsOverrides({
      stat: async (target, options) => {
        if (String(target) === disappearingFile) {
          const error = new Error(`ENOENT: no such file or directory, stat '${disappearingFile}'`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return actualFs.stat(target, options as never);
      }
    });

    await expect(objectStorage.syncLocalDirectoryToRemote(store, "workspace/demo", directory)).resolves.toMatchObject({
      uploadedFileCount: 1
    });
    vi.doUnmock("node:fs/promises");
    vi.resetModules();

    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/demo/.oah-sync-manifest.json",
      "workspace/demo/README.md"
    ]);
  });

  it("ignores files that disappear after snapshot collection but before upload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-upload-race-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const disappearingFile = path.join(directory, ".openharness", "agents", "compact-e2e.md");

    await mkdir(path.dirname(disappearingFile), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# synced\n", "utf8");
    await writeFile(disappearingFile, "agent prompt\n", "utf8");

    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const objectStorage = await importObjectStorageWithFsOverrides({
      readFile: async (target, options) => {
        if (String(target) === disappearingFile) {
          const error = new Error(`ENOENT: no such file or directory, open '${disappearingFile}'`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return actualFs.readFile(target, options as never);
      }
    });

    await expect(objectStorage.syncLocalDirectoryToRemote(store, "workspace/demo", directory)).resolves.toMatchObject({
      uploadedFileCount: 1
    });
    vi.doUnmock("node:fs/promises");
    vi.resetModules();

    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/demo/.oah-sync-manifest.json",
      "workspace/demo/README.md"
    ]);
  });

  it("preserves original file mtime across local-to-remote and remote-to-local sync", async () => {
    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-roundtrip-source-"));
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-roundtrip-target-"));
    tempDirs.push(sourceDirectory, targetDirectory);
    const store = new FakeDirectoryObjectStore();
    const expectedMtime = new Date("2026-04-18T08:09:10.000Z");

    await writeFile(path.join(sourceDirectory, "README.md"), "# synced\n", "utf8");
    await utimes(path.join(sourceDirectory, "README.md"), expectedMtime, expectedMtime);

    await syncLocalDirectoryToRemote(store, "workspace/demo", sourceDirectory);
    await syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory);

    const materializedStat = await stat(path.join(targetDirectory, "README.md"));
    expect(Math.trunc(materializedStat.mtimeMs)).toBe(expectedMtime.getTime());
    expect(store.objects.get("workspace/demo/README.md")?.metadata?.["oah-mtime-ms"]).toBe(String(expectedMtime.getTime()));
  });

  it("incrementally refreshes only changed remote files and removes stale local entries", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-incremental-pull-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const preservedMtime = new Date("2026-04-18T08:09:10.000Z");
    const changedMtime = new Date("2026-04-19T09:10:11.000Z");

    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "README.md"), "# demo\n", "utf8");
    await utimes(path.join(directory, "README.md"), preservedMtime, preservedMtime);
    await writeFile(path.join(directory, "stale.txt"), "remove me\n", "utf8");

    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"), { mtimeMs: preservedMtime.getTime() });
    await store.putObject("workspace/demo/docs/guide.md", Buffer.from("fresh\n"), { mtimeMs: changedMtime.getTime() });

    await syncRemotePrefixToLocal(store, "workspace/demo", directory);

    await expect(readFile(path.join(directory, "README.md"), "utf8")).resolves.toBe("# demo\n");
    await expect(readFile(path.join(directory, "docs", "guide.md"), "utf8")).resolves.toBe("fresh\n");
    await expect(stat(path.join(directory, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.getObjectCalls).toBe(1);
    expect(store.getObjectInfoCalls).toBe(1);
    expect(Math.trunc((await stat(path.join(directory, "README.md"))).mtimeMs)).toBe(preservedMtime.getTime());
  });

  it("reuses the remote sync manifest to skip unchanged downloads without head requests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-pull-manifest-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    const preservedMtime = new Date("2026-04-18T08:09:10.000Z");

    await writeFile(path.join(directory, "README.md"), "# demo\n", "utf8");
    await utimes(path.join(directory, "README.md"), preservedMtime, preservedMtime);
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"), { mtimeMs: preservedMtime.getTime() });

    await syncLocalDirectoryToRemote(store, "workspace/demo", directory);
    store.getObjectCalls = 0;
    store.getObjectInfoCalls = 0;

    await syncRemotePrefixToLocal(store, "workspace/demo", directory);

    expect(store.getObjectCalls).toBe(1);
    expect(store.getObjectInfoCalls).toBe(0);
    expect(Math.trunc((await stat(path.join(directory, "README.md"))).mtimeMs)).toBe(preservedMtime.getTime());
  });

  it("hydrates from the object-storage sync bundle on cold pull when forced", async () => {
    vi.stubEnv("OAH_OBJECT_STORAGE_SYNC_BUNDLE", "1");

    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-source-"));
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bundle-target-"));
    tempDirs.push(sourceDirectory, targetDirectory);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(sourceDirectory, "docs"), { recursive: true });
    await writeFile(path.join(sourceDirectory, "README.md"), "# synced\n", "utf8");
    await writeFile(path.join(sourceDirectory, "docs", "guide.md"), "hello\n", "utf8");

    await syncLocalDirectoryToRemote(store, "workspace/demo", sourceDirectory);
    store.getObjectCalls = 0;
    store.getObjectInfoCalls = 0;

    await syncRemotePrefixToLocal(store, "workspace/demo", targetDirectory);

    await expect(readFile(path.join(targetDirectory, "README.md"), "utf8")).resolves.toBe("# synced\n");
    await expect(readFile(path.join(targetDirectory, "docs", "guide.md"), "utf8")).resolves.toBe("hello\n");
    expect(store.getObjectCalls).toBe(1);
    expect(store.getObjectInfoCalls).toBe(0);
  });

  it("pushes workspace roots to object storage while excluding runtime-only state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-workspace-root-"));
    tempDirs.push(directory);
    const store = new FakeDirectoryObjectStore();
    await mkdir(path.join(directory, ".openharness", "state", "todos"), { recursive: true });
    await mkdir(path.join(directory, ".openharness", "__materialized__", "ws_1"), { recursive: true });
    await writeFile(path.join(directory, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(path.join(directory, ".openharness", "state", "todos", "session.json"), "{}", "utf8");
    await writeFile(path.join(directory, ".openharness", "__materialized__", "ws_1", "ghost.txt"), "ghost\n", "utf8");
    await writeFile(path.join(directory, "README.md"), "# workspace\n", "utf8");

    await syncWorkspaceRootToObjectStore(store, "workspace/demo", directory);

    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/demo/.oah-sync-manifest.json",
      "workspace/demo/.openharness/settings.yaml",
      "workspace/demo/README.md"
    ]);
  });

  it("deletes an object storage workspace prefix recursively", async () => {
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    await store.putObject("workspace/demo/src/index.ts", Buffer.from("export {};\n"));
    await store.putObject("workspace/demo/empty-dir/", Buffer.alloc(0));
    await store.putObject("workspace/other/README.md", Buffer.from("# other\n"));

    await deleteRemotePrefixFromObjectStore(store, "workspace/demo");

    expect([...store.objects.keys()].sort()).toEqual(["workspace/other/README.md"]);
  });

  it("only computes managed workspace external refs for configured managed paths", () => {
    const controller = new ObjectStorageMirrorController(
      {
        provider: "s3",
        bucket: "test-bucket",
        region: "us-east-1",
        endpoint: "http://127.0.0.1:9000",
        force_path_style: true,
        managed_paths: ["workspace"]
      },
      {
        workspace_dir: "/tmp/workspaces",
        runtime_dir: "/tmp/runtimes",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills"
      }
    );

    expect(
      controller.managedWorkspaceExternalRef("/tmp/workspaces/demo", "project", {
        workspace_dir: "/tmp/workspaces"
      })
    ).toBe("s3://test-bucket/workspace/demo");

    const unmanagedController = new ObjectStorageMirrorController(
      {
        provider: "s3",
        bucket: "test-bucket",
        region: "us-east-1",
        endpoint: "http://127.0.0.1:9000",
        force_path_style: true,
        managed_paths: ["runtime", "model"]
      },
      {
        workspace_dir: "/tmp/workspaces",
        runtime_dir: "/tmp/runtimes",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills"
      }
    );

    expect(
      unmanagedController.managedWorkspaceExternalRef("/tmp/workspaces/demo", "project", {
        workspace_dir: "/tmp/workspaces"
      })
    ).toBeUndefined();
  });

  it("can continue mirror initialization in the background after local paths are prepared", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bg-init-workspaces-"));
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bg-init-runtimes-"));
    const modelDir = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bg-init-models-"));
    const toolDir = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bg-init-tools-"));
    const skillDir = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-bg-init-skills-"));
    tempDirs.push(workspaceDir, runtimeDir, modelDir, toolDir, skillDir);

    let releaseRemoteScan!: () => void;
    const remoteScanGate = new Promise<void>((resolve) => {
      releaseRemoteScan = resolve;
    });

    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/ws_1/README.md", Buffer.from("# demo\n"));
    const originalListEntries = store.listEntries.bind(store);
    store.listEntries = async (prefix: string) => {
      await remoteScanGate;
      return originalListEntries(prefix);
    };

    const controller = new ObjectStorageMirrorController(
      {
        provider: "s3",
        bucket: "test-bucket",
        region: "us-east-1",
        endpoint: "http://127.0.0.1:9000",
        force_path_style: true,
        managed_paths: ["workspace"],
        sync_on_boot: true,
        sync_on_change: false
      },
      {
        workspace_dir: workspaceDir,
        runtime_dir: runtimeDir,
        model_dir: modelDir,
        tool_dir: toolDir,
        skill_dir: skillDir
      },
      undefined,
      {
        store
      }
    );

    await controller.initialize({ awaitInitialSync: false });

    await expect(stat(workspaceDir)).resolves.toBeTruthy();
    await expect(readFile(path.join(workspaceDir, "ws_1", "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    releaseRemoteScan();
    await controller.syncChangedMappings();

    await expect(readFile(path.join(workspaceDir, "ws_1", "README.md"), "utf8")).resolves.toBe("# demo\n");
    await controller.close();
  });

  it("ignores workspace_dir top-level runtime internals while still syncing real workspace contents", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-workspaces-"));
    tempDirs.push(workspaceDir);
    const store = new FakeDirectoryObjectStore();

    await mkdir(path.join(workspaceDir, ".openharness", "__materialized__", "ws_1"), { recursive: true });
    await writeFile(path.join(workspaceDir, ".openharness", "__materialized__", "ws_1", "ghost.txt"), "ghost\n", "utf8");
    await syncLocalDirectoryToRemote(store, "workspace", workspaceDir, undefined, undefined, {
      excludeRelativePath: (relativePath) => relativePath === ".openharness" || relativePath.startsWith(".openharness/")
    });
    expect([...store.objects.keys()]).toEqual([]);

    await mkdir(path.join(workspaceDir, "ws_1", ".openharness"), { recursive: true });
    await writeFile(path.join(workspaceDir, "ws_1", "README.md"), "# demo\n", "utf8");
    await writeFile(path.join(workspaceDir, "ws_1", ".openharness", "settings.yaml"), "default_agent: builder\n", "utf8");

    await syncLocalDirectoryToRemote(store, "workspace", workspaceDir, undefined, undefined, {
      excludeRelativePath: (relativePath) => relativePath === ".openharness" || relativePath.startsWith(".openharness/")
    });

    expect([...store.objects.keys()].sort()).toEqual([
      "workspace/.oah-sync-manifest.json",
      "workspace/ws_1/.openharness/settings.yaml",
      "workspace/ws_1/README.md"
    ]);
  });
});
