import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DirectoryObjectStore } from "../apps/server/src/object-storage.ts";
import { ObjectStorageMirrorController, syncLocalDirectoryToRemote, syncRemotePrefixToLocal } from "../apps/server/src/object-storage.ts";

class FakeDirectoryObjectStore implements DirectoryObjectStore {
  readonly bucket = "test-bucket";
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();

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
      "workspace/demo/.openharness/settings.yaml",
      "workspace/demo/README.md",
      "workspace/demo/empty-dir/"
    ]);
    expect(store.objects.get("workspace/demo/README.md")?.body.toString("utf8")).toBe("# synced\n");
    expect(store.objects.get("workspace/demo/.openharness/settings.yaml")?.body.toString("utf8")).toBe(
      "default_agent: assistant\n"
    );
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
        blueprint_dir: "/tmp/blueprints",
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
        managed_paths: ["blueprint", "model"]
      },
      {
        workspace_dir: "/tmp/workspaces",
        blueprint_dir: "/tmp/blueprints",
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
      "workspace/ws_1/.openharness/settings.yaml",
      "workspace/ws_1/README.md"
    ]);
  });
});
