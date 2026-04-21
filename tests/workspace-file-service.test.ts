import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { WorkspaceFileStat, WorkspaceFileSystem, WorkspaceRecord } from "../packages/engine-core/src/types/workspace.ts";
import { WorkspaceFileService } from "../packages/engine-core/src/workspace/workspace-files.ts";

function createWorkspaceRecord(): WorkspaceRecord {
  const now = "2026-04-20T00:00:00.000Z";
  return {
    id: "ws_test",
    name: "Test Workspace",
    rootPath: "/workspace",
    executionPolicy: "local",
    status: "active",
    kind: "project",
    readOnly: false,
    historyMirrorEnabled: true,
    settings: {},
    workspaceModels: {},
    agents: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    catalog: {
      workspaceId: "ws_test",
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: [],
      engineTools: []
    },
    createdAt: now,
    updatedAt: now
  };
}

function createFileSystem(input: {
  entries: Array<{ name: string; kind: "file" | "directory"; updatedAt?: string; sizeBytes?: number }>;
  stats: Record<string, WorkspaceFileStat>;
}): WorkspaceFileSystem {
  return {
    async realpath(targetPath) {
      return targetPath;
    },
    async stat(targetPath) {
      const stat = input.stats[targetPath];
      if (!stat) {
        throw new Error(`Missing stat for ${targetPath}`);
      }

      return stat;
    },
    async readFile() {
      return Buffer.from("");
    },
    openReadStream() {
      return Readable.from([]);
    },
    async readdir() {
      return input.entries;
    },
    async mkdir() {
      return undefined;
    },
    async writeFile(targetPath, data, options) {
      const existing = input.stats[targetPath];
      input.stats[targetPath] = {
        kind: "file",
        size: data.length,
        mtimeMs: typeof options?.mtimeMs === "number" ? options.mtimeMs : existing?.mtimeMs ?? 0,
        birthtimeMs: existing?.birthtimeMs ?? 0,
        ...(existing?.ino !== undefined ? { ino: existing.ino } : {})
      };
      return undefined;
    },
    async rm() {
      return undefined;
    },
    async rename() {
      return undefined;
    }
  };
}

describe("workspace file service", () => {
  it("prefers directory-list updatedAt metadata over zero stat timestamps", async () => {
    const service = new WorkspaceFileService(
      createFileSystem({
        entries: [
          {
            name: "hello.txt",
            kind: "file",
            updatedAt: "2026-04-19T12:34:56.000Z",
            sizeBytes: 12
          }
        ],
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0
          },
          "/workspace/hello.txt": {
            kind: "file",
            size: 12,
            mtimeMs: 0,
            birthtimeMs: 0,
            ino: 1
          }
        }
      })
    );

    const page = await service.listEntries(createWorkspaceRecord(), {
      path: ".",
      pageSize: 50,
      sortBy: "name",
      sortOrder: "asc"
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      path: "hello.txt",
      updatedAt: "2026-04-19T12:34:56.000Z",
      sizeBytes: 12
    });
    expect(page.items[0]?.createdAt).toBeUndefined();
  });

  it("omits invalid epoch-zero timestamps instead of returning 1970 dates", async () => {
    const service = new WorkspaceFileService(
      createFileSystem({
        entries: [
          {
            name: "empty.txt",
            kind: "file",
            sizeBytes: 0
          }
        ],
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0
          },
          "/workspace/empty.txt": {
            kind: "file",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0,
            ino: 2
          }
        }
      })
    );

    const page = await service.listEntries(createWorkspaceRecord(), {
      path: ".",
      pageSize: 50,
      sortBy: "name",
      sortOrder: "asc"
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.updatedAt).toBeUndefined();
    expect(page.items[0]?.createdAt).toBeUndefined();
  });

  it("omits invalid timestamps from downloads instead of returning 1970 dates", async () => {
    const service = new WorkspaceFileService(
      createFileSystem({
        entries: [],
        stats: {
          "/workspace/empty.txt": {
            kind: "file",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0,
            ino: 3
          }
        }
      })
    );

    const download = await service.getFileDownload(createWorkspaceRecord(), "empty.txt");

    expect(download.updatedAt).toBeUndefined();
  });

  it("preserves provided mtimeMs when uploading files", async () => {
    const service = new WorkspaceFileService(
      createFileSystem({
        entries: [],
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0
          }
        }
      })
    );

    const entry = await service.uploadFile(createWorkspaceRecord(), {
      path: "uploaded.txt",
      data: Buffer.from("hello"),
      mtimeMs: 1_776_512_345_000
    });

    expect(entry.updatedAt).toBe("2026-04-18T11:39:05.000Z");
  });
});
