import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DirectoryObjectStore } from "../apps/server/src/object-storage.ts";
import {
  WorkspaceMaterializationAggregateError,
  WorkspaceMaterializationDrainingError,
  WorkspaceMaterializationManager,
  WorkspaceMaterializationUnsupportedVersionError
} from "../apps/server/src/bootstrap/workspace-materialization.ts";

class FakeDirectoryObjectStore implements DirectoryObjectStore {
  readonly bucket = "test-bucket";
  readonly objects = new Map<string, { body: Buffer; lastModified: Date; metadata?: Record<string, string> | undefined }>();
  getObjectCalls = 0;
  failPutObject = false;

  async listEntries(prefix: string) {
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

  async putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void> {
    if (this.failPutObject) {
      throw new Error(`put failed for ${key}`);
    }
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
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
  vi.doUnmock("../apps/server/src/object-storage.ts");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("workspace materialization", () => {
  it("reuses the same object-store workspace copy across concurrent leases", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    await store.putObject("workspace/demo/src/index.ts", Buffer.from("export {};\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const [leaseA, leaseB] = await Promise.all([
      manager.acquireWorkspace({
        workspace: {
          id: "ws_1",
          rootPath: "/unused",
          externalRef: "s3://test-bucket/workspace/demo"
        } as never
      }),
      manager.acquireWorkspace({
        workspace: {
          id: "ws_1",
          rootPath: "/unused",
          externalRef: "s3://test-bucket/workspace/demo"
        } as never
      })
    ]);

    expect(leaseA.localPath).toBe(leaseB.localPath);
    await expect(readFile(path.join(leaseA.localPath, "README.md"), "utf8")).resolves.toBe("# demo\n");
    await expect(readFile(path.join(leaseA.localPath, "src", "index.ts"), "utf8")).resolves.toBe("export {};\n");
    expect(store.getObjectCalls).toBe(2);
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({
        workspaceId: "ws_1",
        sourceKind: "object_store",
        remotePrefix: "workspace/demo",
        refCount: 2,
        dirty: false
      })
    ]);

    await leaseA.release();
    await leaseB.release();
    await manager.close();
  });

  it("keeps default object-store workspace copies under a standalone cache root", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    expect(lease.localPath).toBe(path.join(cacheRoot, "ws_1"));
    await expect(readFile(path.join(lease.localPath, "README.md"), "utf8")).resolves.toBe("# demo\n");

    await lease.release();
    await manager.close();
  });

  it("flushes dirty idle copies back to object storage before eviction", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# old\n"));
    await store.putObject("workspace/demo/obsolete.txt", Buffer.from("remove me\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo",
        ownerId: "user_1"
      } as never
    });

    await writeFile(path.join(lease.localPath, "README.md"), "# fresh\n", "utf8");
    await rm(path.join(lease.localPath, "obsolete.txt"), { force: true });
    await mkdir(path.join(lease.localPath, "docs"), { recursive: true });
    await writeFile(path.join(lease.localPath, "docs", "guide.md"), "hello\n", "utf8");
    lease.markDirty();
    await lease.release();

    const flushed = await manager.flushIdleCopies({ idleBefore: new Date(Date.now() + 1_000).toISOString() });
    expect(flushed).toHaveLength(1);
    expect(store.objects.get("workspace/demo/README.md")?.body.toString("utf8")).toBe("# fresh\n");
    expect(store.objects.has("workspace/demo/obsolete.txt")).toBe(false);
    expect(store.objects.get("workspace/demo/docs/guide.md")?.body.toString("utf8")).toBe("hello\n");

    const localPath = lease.localPath;
    const evicted = await manager.evictIdleCopies({ idleBefore: new Date(Date.now() + 1_000).toISOString() });
    expect(evicted).toHaveLength(1);
    await expect(stat(localPath)).rejects.toThrow();
    expect(manager.snapshot()).toEqual([]);
  });

  it("flushes workspace configs without persisting runtime-only state", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/.openharness/settings.yaml", Buffer.from("default_agent: builder\n"));
    await store.putObject("workspace/demo/README.md", Buffer.from("# old\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo",
        ownerId: "user_1"
      } as never
    });

    await mkdir(path.join(lease.localPath, ".openharness", "state", "background-tasks", "ses_1"), { recursive: true });
    await writeFile(path.join(lease.localPath, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(path.join(lease.localPath, ".openharness", "state", "background-tasks", "ses_1", "stdout.log"), "hi\n", "utf8");
    lease.markDirty();
    await lease.release();

    await manager.flushIdleCopies({ idleBefore: new Date(Date.now() + 1_000).toISOString() });

    expect(store.objects.get("workspace/demo/.openharness/settings.yaml")?.body.toString("utf8")).toBe(
      "default_agent: assistant\n"
    );
    expect(
      [...store.objects.keys()].some((key) => key.startsWith("workspace/demo/.openharness/state/"))
    ).toBe(false);
  });

  it("falls back to a passthrough local directory for workspaces without object storage refs", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    const localWorkspace = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-local-"));
    tempDirs.push(cacheRoot, localWorkspace);
    await writeFile(path.join(localWorkspace, "README.md"), "# local\n", "utf8");
    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store: new FakeDirectoryObjectStore()
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_local",
        rootPath: localWorkspace
      } as never
    });

    expect(lease.localPath).toBe(localWorkspace);
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({
        workspaceId: "ws_local",
        sourceKind: "local_directory",
        localPath: localWorkspace,
        refCount: 1
      })
    ]);

    lease.markDirty();
    await lease.release();
    await manager.flushIdleCopies({ idleBefore: new Date(Date.now() + 1_000).toISOString() });
    await expect(readFile(path.join(localWorkspace, "README.md"), "utf8")).resolves.toBe("# local\n");
    await manager.close();
    await expect(readFile(path.join(localWorkspace, "README.md"), "utf8")).resolves.toBe("# local\n");
  });

  it("materializes live object-store workspaces into their stable workspace root when available", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-stable-root-"));
    const workspaceDir = path.join(tempRoot, "workspaces");
    const cacheRoot = path.join(workspaceDir, ".openharness", "__materialized__");
    const stableWorkspaceRoot = path.join(workspaceDir, "ws_1");
    tempDirs.push(tempRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    await store.putObject("workspace/demo/docs/guide.md", Buffer.from("hello\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: stableWorkspaceRoot,
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    expect(lease.localPath).toBe(stableWorkspaceRoot);
    await expect(readFile(path.join(stableWorkspaceRoot, "README.md"), "utf8")).resolves.toBe("# demo\n");
    await expect(readFile(path.join(stableWorkspaceRoot, "docs", "guide.md"), "utf8")).resolves.toBe("hello\n");

    await writeFile(path.join(stableWorkspaceRoot, "notes.md"), "stable root\n", "utf8");
    lease.markDirty();
    await lease.release();

    const evicted = await manager.evictIdleCopies({
      idleBefore: new Date(Date.now() + 1_000).toISOString()
    });
    expect(evicted).toHaveLength(1);
    expect(store.objects.get("workspace/demo/notes.md")?.body.toString("utf8")).toBe("stable root\n");
    await expect(stat(stableWorkspaceRoot)).rejects.toThrow();
  });

  it("normalizes live object-store workspaces to the canonical workspace-id directory", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-canonical-root-"));
    const workspaceDir = path.join(tempRoot, "workspaces");
    const cacheRoot = path.join(workspaceDir, ".openharness", "__materialized__");
    const nonCanonicalRoot = path.join(workspaceDir, "custom-name");
    const canonicalWorkspaceRoot = path.join(workspaceDir, "ws_1");
    tempDirs.push(tempRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: nonCanonicalRoot,
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    expect(lease.localPath).toBe(canonicalWorkspaceRoot);
    await expect(readFile(path.join(canonicalWorkspaceRoot, "README.md"), "utf8")).resolves.toBe("# demo\n");
    await expect(stat(nonCanonicalRoot)).rejects.toThrow();
  });

  it("rejects non-live object-store workspace materialization", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    await expect(
      manager.acquireWorkspace({
        workspace: {
          id: "ws_1",
          rootPath: "/unused",
          externalRef: "s3://test-bucket/workspace/demo"
        } as never,
        version: "snapshot-2026-04-17"
      })
    ).rejects.toBeInstanceOf(WorkspaceMaterializationUnsupportedVersionError);
  });

  it("forgets materialized workspace copies during workspace deletion", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-delete-root-"));
    const workspaceDir = path.join(tempRoot, "workspaces");
    const cacheRoot = path.join(workspaceDir, ".openharness", "__materialized__");
    const stableWorkspaceRoot = path.join(workspaceDir, "ws_1");
    tempDirs.push(tempRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: stableWorkspaceRoot,
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });
    await writeFile(path.join(stableWorkspaceRoot, "dirty.txt"), "dirty\n", "utf8");
    lease.markDirty();
    await lease.release();

    const deletedCopies = await manager.deleteWorkspaceCopies("ws_1");

    expect(deletedCopies).toHaveLength(1);
    expect(deletedCopies[0]?.localPath).toBe(stableWorkspaceRoot);
    await expect(stat(stableWorkspaceRoot)).rejects.toThrow();
    expect(manager.snapshot()).toEqual([]);
    expect(store.objects.has("workspace/demo/dirty.txt")).toBe(false);
  });

  it("repairs legacy hidden materialized roots back into the stable workspace directory", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-repair-root-"));
    const workspaceDir = path.join(tempRoot, "workspaces");
    const cacheRoot = path.join(workspaceDir, ".openharness", "__materialized__");
    const stableWorkspaceRoot = path.join(workspaceDir, "ws_1");
    const legacyHiddenRoot = path.join(cacheRoot, "ws_1");
    tempDirs.push(tempRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# remote\n"));
    await mkdir(legacyHiddenRoot, { recursive: true });
    await writeFile(path.join(legacyHiddenRoot, "README.md"), "# adopted\n", "utf8");
    await writeFile(path.join(legacyHiddenRoot, "note.txt"), "legacy copy\n", "utf8");

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: legacyHiddenRoot,
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    expect(lease.localPath).toBe(stableWorkspaceRoot);
    await expect(readFile(path.join(stableWorkspaceRoot, "README.md"), "utf8")).resolves.toBe("# adopted\n");
    await expect(readFile(path.join(stableWorkspaceRoot, "note.txt"), "utf8")).resolves.toBe("legacy copy\n");
    await expect(stat(legacyHiddenRoot)).rejects.toThrow();
  });

  it("keeps an idle materialized workspace alive when control-plane activity refreshes it", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo",
        ownerId: "user_1"
      } as never
    });
    await lease.release();

    const staleCutoff = new Date(Date.now() + 5).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await manager.touchWorkspaceActivity("ws_1");

    const firstEvictionAttempt = await manager.evictIdleCopies({ idleBefore: staleCutoff });
    expect(firstEvictionAttempt).toEqual([]);
    expect(manager.snapshot()).toHaveLength(1);

    const secondEvictionAttempt = await manager.evictIdleCopies({
      idleBefore: new Date(Date.now() + 1_000).toISOString()
    });
    expect(secondEvictionAttempt).toHaveLength(1);
    expect(manager.snapshot()).toEqual([]);
  });

  it("keeps a workspace alive while a background task recorded in state metadata is still running", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo",
        ownerId: "user_1"
      } as never
    });

    const backgroundStateRoot = path.join(lease.localPath, ".openharness", "state", "background-tasks", "ses_1");
    await mkdir(backgroundStateRoot, { recursive: true });
    await writeFile(
      path.join(backgroundStateRoot, "task_1.json"),
      JSON.stringify({
        taskId: "task_1",
        pid: process.pid,
        createdAt: new Date().toISOString()
      }),
      "utf8"
    );
    await lease.release();

    const staleCutoff = new Date(Date.now() + 5).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await manager.refreshLeases();

    const firstEvictionAttempt = await manager.evictIdleCopies({ idleBefore: staleCutoff });
    expect(firstEvictionAttempt).toEqual([]);
    expect(manager.snapshot()).toHaveLength(1);

    await writeFile(
      path.join(backgroundStateRoot, "task_1.json"),
      JSON.stringify({
        taskId: "task_1",
        pid: 999_999_999,
        createdAt: new Date().toISOString()
      }),
      "utf8"
    );

    const secondEvictionAttempt = await manager.evictIdleCopies({
      idleBefore: new Date(Date.now() + 1_000).toISOString()
    });
    expect(secondEvictionAttempt).toHaveLength(1);
    expect(manager.snapshot()).toEqual([]);
  });

  it("publishes workspace ownership leases through the registry lifecycle", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    const heartbeats: Array<{ workspaceId: string; dirty: boolean; refCount: number; ownerBaseUrl?: string }> = [];
    const placements: Array<{ workspaceId: string; state: string; ownerId?: string; ownerWorkerId?: string }> = [];
    const removals: Array<{ workspaceId: string; version: string; ownerWorkerId: string }> = [];

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      ownerBaseUrl: "http://worker-1.internal:8787",
      store,
      leaseRegistry: {
        async heartbeat(entry) {
          heartbeats.push({
            workspaceId: entry.workspaceId,
            dirty: entry.dirty,
            refCount: entry.refCount,
            ownerBaseUrl: entry.ownerBaseUrl
          });
        },
        async remove(workspaceId, version, ownerWorkerId) {
          removals.push({ workspaceId, version, ownerWorkerId });
        }
      },
      placementRegistry: {
        async upsert(entry) {
          placements.push({
            workspaceId: entry.workspaceId,
            state: entry.state,
            ...(entry.ownerId ? { ownerId: entry.ownerId } : {}),
            ...(entry.ownerWorkerId ? { ownerWorkerId: entry.ownerWorkerId } : {})
          });
        },
        async assignOwnerAffinity() {
          return undefined;
        },
        async assignOwnerAffinity() {
          return undefined;
        },
        async setPreferredWorker() {
          return undefined;
        },
        async releaseOwnership() {
          return undefined;
        },
        async listAll() {
          return [];
        },
        async getByWorkspaceId() {
          return undefined;
        }
      }
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo",
        ownerId: "user_1"
      } as never
    });
    lease.markDirty();
    await lease.release({ dirty: true });
    await manager.refreshLeases();
    await manager.evictIdleCopies({ idleBefore: new Date(Date.now() + 1_000).toISOString() });

    expect(heartbeats.some((entry) => entry.workspaceId === "ws_1" && entry.refCount === 1)).toBe(true);
    expect(heartbeats.some((entry) => entry.workspaceId === "ws_1" && entry.dirty)).toBe(true);
    expect(heartbeats.some((entry) => entry.workspaceId === "ws_1" && entry.ownerBaseUrl === "http://worker-1.internal:8787")).toBe(true);
    expect(placements.some((entry) => entry.workspaceId === "ws_1" && entry.ownerId === "user_1" && entry.state === "active")).toBe(true);
    expect(placements.some((entry) => entry.workspaceId === "ws_1" && entry.state === "active")).toBe(true);
    expect(placements.some((entry) => entry.workspaceId === "ws_1" && entry.state === "idle")).toBe(true);
    expect(placements.some((entry) => entry.workspaceId === "ws_1" && entry.state === "evicted")).toBe(true);
    expect(removals).toEqual([{ workspaceId: "ws_1", version: "live", ownerWorkerId: "worker_1" }]);
  });

  it("does not mark a workspace dirty when a write-capable lease releases without file changes", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    await lease.release({ dirty: true });

    expect(manager.snapshot()).toEqual([
      expect.objectContaining({
        workspaceId: "ws_1",
        dirty: false,
        refCount: 0
      })
    ]);

    await manager.close();
  });

  it("reuses the sync fingerprint returned during materialization instead of rescanning the local workspace", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);

    const syncRemotePrefixToLocal = vi.fn(async (_store: DirectoryObjectStore, _remotePrefix: string, localDir: string) => {
      await mkdir(localDir, { recursive: true });
      await writeFile(path.join(localDir, "README.md"), "# demo\n", "utf8");
      return {
        localFingerprint: "materialized-sync-fingerprint",
        removedPathCount: 0,
        createdDirectoryCount: 0,
        downloadedFileCount: 1
      };
    });
    const computeLocalDirectoryFingerprint = vi.fn(async () => {
      throw new Error("expected materialization to reuse the sync fingerprint");
    });

    vi.resetModules();
    vi.doMock("../apps/server/src/object-storage.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/server/src/object-storage.ts")>(
        "../apps/server/src/object-storage.ts"
      );
      return {
        ...actual,
        syncRemotePrefixToLocal,
        computeLocalDirectoryFingerprint
      };
    });

    const { WorkspaceMaterializationManager: TestWorkspaceMaterializationManager } = await import(
      "../apps/server/src/bootstrap/workspace-materialization.ts"
    );

    const manager = new TestWorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store: new FakeDirectoryObjectStore()
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    expect(syncRemotePrefixToLocal).toHaveBeenCalledTimes(1);
    expect(computeLocalDirectoryFingerprint).not.toHaveBeenCalled();
    await expect(readFile(path.join(lease.localPath, "README.md"), "utf8")).resolves.toBe("# demo\n");

    await lease.release();
    await manager.close();
  });

  it("surfaces materialization request counts on the first lease that performs the sync", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);

    const syncRemotePrefixToLocal = vi.fn(async (_store: DirectoryObjectStore, _remotePrefix: string, localDir: string) => {
      await mkdir(localDir, { recursive: true });
      await writeFile(path.join(localDir, "README.md"), "# demo\n", "utf8");
      return {
        localFingerprint: "materialized-sync-fingerprint",
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
      };
    });

    vi.resetModules();
    vi.doMock("../apps/server/src/object-storage.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/server/src/object-storage.ts")>(
        "../apps/server/src/object-storage.ts"
      );
      return {
        ...actual,
        syncRemotePrefixToLocal
      };
    });

    const { WorkspaceMaterializationManager: TestWorkspaceMaterializationManager } = await import(
      "../apps/server/src/bootstrap/workspace-materialization.ts"
    );

    const manager = new TestWorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store: new FakeDirectoryObjectStore()
    });

    const firstLease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    expect(firstLease.materializeRequestCounts).toEqual({
      listRequests: 0,
      getRequests: 1,
      headRequests: 0,
      putRequests: 0,
      deleteRequests: 0
    });
    await firstLease.release();

    const secondLease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    expect(secondLease.materializeRequestCounts).toBeUndefined();
    expect(syncRemotePrefixToLocal).toHaveBeenCalledTimes(1);
    await secondLease.release();
    await manager.close();
  });

  it("reuses the sync fingerprint returned during flush instead of rescanning the local workspace", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);

    const syncRemotePrefixToLocal = vi.fn(async (_store: DirectoryObjectStore, _remotePrefix: string, localDir: string) => {
      await mkdir(localDir, { recursive: true });
      await writeFile(path.join(localDir, "README.md"), "# demo\n", "utf8");
      return {
        localFingerprint: "materialized-sync-fingerprint",
        removedPathCount: 0,
        createdDirectoryCount: 0,
        downloadedFileCount: 1
      };
    });
    const syncWorkspaceRootToObjectStore = vi.fn(async () => ({
      localFingerprint: "flushed-sync-fingerprint",
      uploadedFileCount: 1,
      deletedRemoteCount: 0,
      createdEmptyDirectoryCount: 0
    }));
    const computeLocalDirectoryFingerprint = vi.fn(async () => {
      throw new Error("expected flush to reuse the sync fingerprint");
    });

    vi.resetModules();
    vi.doMock("../apps/server/src/object-storage.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/server/src/object-storage.ts")>(
        "../apps/server/src/object-storage.ts"
      );
      return {
        ...actual,
        syncRemotePrefixToLocal,
        syncWorkspaceRootToObjectStore,
        computeLocalDirectoryFingerprint
      };
    });

    const { WorkspaceMaterializationManager: TestWorkspaceMaterializationManager } = await import(
      "../apps/server/src/bootstrap/workspace-materialization.ts"
    );

    const manager = new TestWorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store: new FakeDirectoryObjectStore()
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    await writeFile(path.join(lease.localPath, "README.md"), "# changed\n", "utf8");
    lease.markDirty();
    await lease.release();

    const flushed = await manager.flushIdleCopies({ idleBefore: new Date(Date.now() + 1_000).toISOString() });
    expect(flushed).toHaveLength(1);
    expect(syncRemotePrefixToLocal).toHaveBeenCalledTimes(1);
    expect(syncWorkspaceRootToObjectStore).toHaveBeenCalledTimes(1);
    expect(computeLocalDirectoryFingerprint).not.toHaveBeenCalled();

    await manager.close();
  });

  it("ignores runtime-only state changes for dirty detection when releasing a write lease", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });

    await mkdir(path.join(lease.localPath, ".openharness", "state", "background-tasks", "ses_1"), { recursive: true });
    await writeFile(
      path.join(lease.localPath, ".openharness", "state", "background-tasks", "ses_1", "stdout.log"),
      "runtime only\n",
      "utf8"
    );

    await lease.release({ dirty: true });

    expect(manager.snapshot()).toEqual([
      expect.objectContaining({
        workspaceId: "ws_1",
        dirty: false,
        refCount: 0
      })
    ]);

    await manager.close();
  });

  it("flushes and evicts idle object-store copies when drain begins", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# old\n"));

    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });
    const localPath = lease.localPath;
    await writeFile(path.join(localPath, "README.md"), "# drained\n", "utf8");
    lease.markDirty();
    await lease.release();

    const drained = await manager.beginDrain();

    expect(manager.isDraining()).toBe(true);
    expect(drained.flushed).toHaveLength(1);
    expect(drained.evicted).toHaveLength(1);
    expect(store.objects.get("workspace/demo/README.md")?.body.toString("utf8")).toBe("# drained\n");
    await expect(stat(localPath)).rejects.toThrow();
    expect(manager.snapshot()).toEqual([]);
  });

  it("blocks new object-store materializations during drain", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    await manager.beginDrain();

    await expect(
      manager.acquireWorkspace({
        workspace: {
          id: "ws_1",
          rootPath: "/unused",
          externalRef: "s3://test-bucket/workspace/demo"
        } as never
      })
    ).rejects.toBeInstanceOf(WorkspaceMaterializationDrainingError);
  });

  it("allows existing leases to flush and evict themselves when released during drain", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# old\n"));
    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_1",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });
    const localPath = lease.localPath;
    await writeFile(path.join(localPath, "README.md"), "# in-flight\n", "utf8");
    lease.markDirty();

    await manager.beginDrain();
    await lease.release();

    expect(store.objects.get("workspace/demo/README.md")?.body.toString("utf8")).toBe("# in-flight\n");
    await expect(stat(localPath)).rejects.toThrow();
    expect(manager.snapshot()).toEqual([]);
  });

  it("records drain blockers when flush and eviction fail during drain", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# old\n"));
    const manager = new WorkspaceMaterializationManager({
      cacheRoot,
      workerId: "worker_1",
      store
    });

    const lease = await manager.acquireWorkspace({
      workspace: {
        id: "ws_fail",
        rootPath: "/unused",
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });
    await writeFile(path.join(lease.localPath, "README.md"), "# dirty\n", "utf8");
    await lease.release({ dirty: true });
    store.failPutObject = true;

    await expect(manager.beginDrain()).rejects.toBeInstanceOf(WorkspaceMaterializationAggregateError);

    expect(manager.snapshot()).toEqual([
      expect.objectContaining({
        workspaceId: "ws_fail",
        dirty: true,
        refCount: 0
      })
    ]);
    expect(manager.diagnostics()).toMatchObject({
      draining: true,
      cachedCopies: 1,
      dirtyCopies: 1,
      failureCount: 1,
      blockerCount: 1,
      failures: [
        expect.objectContaining({
          workspaceId: "ws_fail",
          stage: "drain_evict",
          operation: "flush",
          dirty: true,
          refCount: 0
        })
      ]
    });
  });
});
