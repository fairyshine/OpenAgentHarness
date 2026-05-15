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
  entriesByPath?: Record<string, Array<{ name: string; kind: "file" | "directory"; updatedAt?: string; sizeBytes?: number }>>;
  entries?: Array<{ name: string; kind: "file" | "directory"; updatedAt?: string; sizeBytes?: number }>;
  stats: Record<string, WorkspaceFileStat>;
  files?: Record<string, Buffer>;
  onStat?: (targetPath: string) => void;
  onReadFile?: (targetPath: string) => void;
  onReadFileRange?: (targetPath: string, maxBytes: number) => void;
}): WorkspaceFileSystem {
  return {
    async realpath(targetPath) {
      return targetPath;
    },
    async stat(targetPath) {
      input.onStat?.(targetPath);
      const stat = input.stats[targetPath];
      if (!stat) {
        throw new Error(`Missing stat for ${targetPath}`);
      }

      return stat;
    },
    async readFile(targetPath) {
      input.onReadFile?.(targetPath);
      return input.files?.[targetPath] ?? Buffer.from("");
    },
    async readFileRange(targetPath, maxBytes) {
      input.onReadFileRange?.(targetPath, maxBytes);
      return (input.files?.[targetPath] ?? Buffer.from("")).subarray(0, maxBytes);
    },
    openReadStream() {
      return Readable.from([]);
    },
    async readdir(targetPath) {
      return input.entriesByPath?.[targetPath] ?? input.entries ?? [];
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

  it("uses the most recent descendant file timestamp for directories", async () => {
    const service = new WorkspaceFileService(
      createFileSystem({
        entriesByPath: {
          "/workspace": [
            {
              name: "src",
              kind: "directory"
            }
          ],
          "/workspace/src": [
            {
              name: "components",
              kind: "directory"
            }
          ],
          "/workspace/src/components": [
            {
              name: "button.tsx",
              kind: "file",
              sizeBytes: 42
            }
          ]
        },
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_000_000,
            birthtimeMs: 0
          },
          "/workspace/src": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_100_000,
            birthtimeMs: 0
          },
          "/workspace/src/components": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_200_000,
            birthtimeMs: 0
          },
          "/workspace/src/components/button.tsx": {
            kind: "file",
            size: 42,
            mtimeMs: 1_776_512_345_000,
            birthtimeMs: 0,
            ino: 4
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
      path: "src",
      type: "directory",
      updatedAt: "2026-04-18T11:39:05.000Z"
    });
  });

  it("can skip recursive directory timestamp discovery for lightweight listings", async () => {
    const statPaths: string[] = [];
    const service = new WorkspaceFileService(
      createFileSystem({
        entriesByPath: {
          "/workspace": [
            {
              name: "src",
              kind: "directory"
            }
          ],
          "/workspace/src": [
            {
              name: "components",
              kind: "directory"
            }
          ],
          "/workspace/src/components": [
            {
              name: "button.tsx",
              kind: "file",
              sizeBytes: 42
            }
          ]
        },
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_000_000,
            birthtimeMs: 0
          },
          "/workspace/src": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_100_000,
            birthtimeMs: 0
          },
          "/workspace/src/components": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_200_000,
            birthtimeMs: 0
          },
          "/workspace/src/components/button.tsx": {
            kind: "file",
            size: 42,
            mtimeMs: 1_776_512_345_000,
            birthtimeMs: 0,
            ino: 4
          }
        },
        onStat: (targetPath) => {
          statPaths.push(targetPath);
        }
      })
    );

    const page = await service.listEntries(createWorkspaceRecord(), {
      path: ".",
      pageSize: 50,
      sortBy: "name",
      sortOrder: "asc",
      includeDirectoryDescendantUpdatedAt: false
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      path: "src",
      type: "directory",
      updatedAt: "2023-11-14T22:15:00.000Z"
    });
    expect(statPaths).not.toContain("/workspace/src/components");
    expect(statPaths).not.toContain("/workspace/src/components/button.tsx");
  });

  it("reuses cached recursive directory timestamps across repeated listings", async () => {
    const statPaths: string[] = [];
    const service = new WorkspaceFileService(
      createFileSystem({
        entriesByPath: {
          "/workspace": [
            {
              name: "src",
              kind: "directory"
            }
          ],
          "/workspace/src": [
            {
              name: "components",
              kind: "directory"
            }
          ],
          "/workspace/src/components": [
            {
              name: "button.tsx",
              kind: "file",
              sizeBytes: 42
            }
          ]
        },
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_000_000,
            birthtimeMs: 0
          },
          "/workspace/src": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_100_000,
            birthtimeMs: 0
          },
          "/workspace/src/components": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_200_000,
            birthtimeMs: 0
          },
          "/workspace/src/components/button.tsx": {
            kind: "file",
            size: 42,
            mtimeMs: 1_776_512_345_000,
            birthtimeMs: 0,
            ino: 4
          }
        },
        onStat: (targetPath) => {
          statPaths.push(targetPath);
        }
      })
    );

    const input = {
      path: ".",
      pageSize: 50,
      sortBy: "name" as const,
      sortOrder: "asc" as const
    };
    await service.listEntries(createWorkspaceRecord(), input);
    await service.listEntries(createWorkspaceRecord(), input);

    expect(statPaths.filter((targetPath) => targetPath === "/workspace/src/components/button.tsx")).toHaveLength(1);
  });

  it("stats only the requested page when sorting lightweight directory entries", async () => {
    const statPaths: string[] = [];
    const entries = Array.from({ length: 10 }, (_, index) => ({
      name: `file-${String(index).padStart(2, "0")}.txt`,
      kind: "file" as const,
      sizeBytes: index
    }));
    const stats = Object.fromEntries(
      entries.map((entry, index) => [
        `/workspace/${entry.name}`,
        {
          kind: "file" as const,
          size: index,
          mtimeMs: 1_700_000_000_000 + index,
          birthtimeMs: 0,
          ino: index + 1
        }
      ])
    );
    const service = new WorkspaceFileService(
      createFileSystem({
        entries,
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_000_000,
            birthtimeMs: 0
          },
          ...stats
        },
        onStat: (targetPath) => {
          statPaths.push(targetPath);
        }
      })
    );

    const page = await service.listEntries(createWorkspaceRecord(), {
      path: ".",
      pageSize: 3,
      sortBy: "name",
      sortOrder: "asc"
    });

    expect(page.items.map((entry) => entry.name)).toEqual(["file-00.txt", "file-01.txt", "file-02.txt"]);
    expect(page.nextCursor).toBe("3");
    expect(statPaths.filter((targetPath) => targetPath.startsWith("/workspace/file-"))).toHaveLength(3);
  });

  it("can list names without stat metadata for fast directory previews", async () => {
    const statPaths: string[] = [];
    const service = new WorkspaceFileService(
      createFileSystem({
        entries: [
          {
            name: "src",
            kind: "directory"
          },
          {
            name: "README.md",
            kind: "file",
            sizeBytes: 12
          }
        ],
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_000_000,
            birthtimeMs: 0
          },
          "/workspace/src": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_700_000_100_000,
            birthtimeMs: 0
          },
          "/workspace/README.md": {
            kind: "file",
            size: 12,
            mtimeMs: 1_700_000_200_000,
            birthtimeMs: 0,
            ino: 1
          }
        },
        onStat: (targetPath) => {
          statPaths.push(targetPath);
        }
      })
    );

    const page = await service.listEntries(createWorkspaceRecord(), {
      path: ".",
      pageSize: 50,
      sortBy: "name",
      sortOrder: "asc",
      includeEntryMetadata: false
    });

    expect(page.items).toEqual([
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
    ]);
    expect(statPaths).toEqual(["/workspace"]);
  });

  it("falls back to the directory stat timestamp when a directory has no files", async () => {
    const service = new WorkspaceFileService(
      createFileSystem({
        entriesByPath: {
          "/workspace": [
            {
              name: "empty-dir",
              kind: "directory"
            }
          ],
          "/workspace/empty-dir": []
        },
        stats: {
          "/workspace": {
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0
          },
          "/workspace/empty-dir": {
            kind: "directory",
            size: 0,
            mtimeMs: 1_776_512_345_000,
            birthtimeMs: 0
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
      path: "empty-dir",
      type: "directory",
      updatedAt: "2026-04-18T11:39:05.000Z"
    });
  });

  it("uses range reads for truncated file previews", async () => {
    const readPaths: string[] = [];
    const rangeReads: Array<{ path: string; maxBytes: number }> = [];
    const service = new WorkspaceFileService(
      createFileSystem({
        files: {
          "/workspace/large.log": Buffer.from("abcdef")
        },
        entries: [],
        stats: {
          "/workspace/large.log": {
            kind: "file",
            size: 6,
            mtimeMs: 1_700_000_000_000,
            birthtimeMs: 0,
            ino: 1
          }
        },
        onReadFile: (targetPath) => {
          readPaths.push(targetPath);
        },
        onReadFileRange: (targetPath, maxBytes) => {
          rangeReads.push({ path: targetPath, maxBytes });
        }
      })
    );

    const content = await service.getFileContent(createWorkspaceRecord(), {
      path: "large.log",
      encoding: "utf8",
      maxBytes: 3
    });

    expect(content.content).toBe("abc");
    expect(content.truncated).toBe(true);
    expect(content.sizeBytes).toBe(6);
    expect(readPaths).toEqual([]);
    expect(rangeReads).toEqual([{ path: "/workspace/large.log", maxBytes: 3 }]);
  });
});
