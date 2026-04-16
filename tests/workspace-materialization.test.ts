import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DirectoryObjectStore } from "../apps/server/src/object-storage.ts";
import {
  WorkspaceMaterializationAggregateError,
  WorkspaceMaterializationDrainingError,
  WorkspaceMaterializationManager
} from "../apps/server/src/bootstrap/workspace-materialization.ts";

class FakeDirectoryObjectStore implements DirectoryObjectStore {
  readonly bucket = "test-bucket";
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();
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

  async getObject(key: string): Promise<Buffer> {
    this.getObjectCalls += 1;
    const entry = this.objects.get(key);
    if (!entry) {
      throw new Error(`Missing object ${key}`);
    }
    return Buffer.from(entry.body);
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    if (this.failPutObject) {
      throw new Error(`put failed for ${key}`);
    }
    this.objects.set(key, {
      body: Buffer.from(body),
      lastModified: new Date()
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
        externalRef: "s3://test-bucket/workspace/demo"
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

  it("publishes workspace ownership leases through the registry lifecycle", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-materialization-cache-"));
    tempDirs.push(cacheRoot);
    const store = new FakeDirectoryObjectStore();
    await store.putObject("workspace/demo/README.md", Buffer.from("# demo\n"));
    const heartbeats: Array<{ workspaceId: string; dirty: boolean; refCount: number; ownerBaseUrl?: string }> = [];
    const placements: Array<{ workspaceId: string; state: string; userId?: string; ownerWorkerId?: string }> = [];
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
            ...(entry.userId ? { userId: entry.userId } : {}),
            ...(entry.ownerWorkerId ? { ownerWorkerId: entry.ownerWorkerId } : {})
          });
        },
        async assignUser() {
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
        externalRef: "s3://test-bucket/workspace/demo"
      } as never
    });
    lease.markDirty();
    await lease.release({ dirty: true });
    await manager.refreshLeases();
    await manager.evictIdleCopies({ idleBefore: new Date(Date.now() + 1_000).toISOString() });

    expect(heartbeats.some((entry) => entry.workspaceId === "ws_1" && entry.refCount === 1)).toBe(true);
    expect(heartbeats.some((entry) => entry.workspaceId === "ws_1" && entry.dirty)).toBe(true);
    expect(heartbeats.some((entry) => entry.workspaceId === "ws_1" && entry.ownerBaseUrl === "http://worker-1.internal:8787")).toBe(true);
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
