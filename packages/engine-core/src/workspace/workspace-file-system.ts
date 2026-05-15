import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";

import type { WorkspaceFileStat, WorkspaceFileSystem, WorkspaceFileSystemEntry } from "../types.js";

function toWorkspaceFileStat(entry: Awaited<ReturnType<typeof stat>>): WorkspaceFileStat {
  return {
    kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    size: Number(entry.size),
    mtimeMs: Number(entry.mtimeMs),
    birthtimeMs: Number(entry.birthtimeMs),
    ino: entry.ino
  };
}

export function createLocalWorkspaceFileSystem(): WorkspaceFileSystem {
  return {
    async realpath(targetPath) {
      return realpath(targetPath);
    },
    async stat(targetPath) {
      return toWorkspaceFileStat(await stat(targetPath));
    },
    async readFile(targetPath) {
      return readFile(targetPath);
    },
    async readFileRange(targetPath, maxBytes) {
      const file = await open(targetPath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const result = await file.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, result.bytesRead);
      } finally {
        await file.close();
      }
    },
    openReadStream(targetPath) {
      return createReadStream(targetPath);
    },
    async readdir(targetPath) {
      const entries = await readdir(targetPath, { withFileTypes: true });
      return entries.map<WorkspaceFileSystemEntry>((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
      }));
    },
    async mkdir(targetPath, options) {
      await mkdir(targetPath, options);
    },
    async writeFile(targetPath, data, options) {
      await writeFile(targetPath, data);
      if (typeof options?.mtimeMs === "number" && Number.isFinite(options.mtimeMs) && options.mtimeMs > 0) {
        const modifiedAt = new Date(options.mtimeMs);
        await utimes(targetPath, modifiedAt, modifiedAt);
      }
    },
    async rm(targetPath, options) {
      await rm(targetPath, options);
    },
    async rename(sourcePath, targetPath) {
      await rename(sourcePath, targetPath);
    }
  };
}
