import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DirectoryObjectStore } from "../apps/server/src/object-storage.ts";
import { WorkspaceMaterializationManager } from "../apps/server/src/bootstrap/workspace-materialization.ts";

class FakeDirectoryObjectStore implements DirectoryObjectStore {
  readonly bucket = "test-bucket";
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();
  getObjectCalls = 0;

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
});
