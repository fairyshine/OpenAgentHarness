import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeRelativePath, shouldIgnoreRelativePath } from "./object-storage-manifest.js";
import type { DirectorySyncOptions, LocalDirectorySnapshot } from "./object-storage-types.js";

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function collectLocalDirectorySnapshot(rootDir: string, options?: DirectorySyncOptions): Promise<LocalDirectorySnapshot> {
  const files = new Map<string, { absolutePath: string; size: number; mtimeMs: number }>();
  const emptyDirectories = new Set<string>();
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });

  if (!rootExists?.isDirectory()) {
    return { files, emptyDirectories };
  }

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!entries) {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    let visibleChildren = 0;
    let suppressedChildren = false;

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
      if (shouldIgnoreRelativePath(relativePath)) {
        suppressedChildren = true;
        continue;
      }
      if (options?.excludeRelativePath?.(relativePath)) {
        suppressedChildren = true;
        continue;
      }

      visibleChildren += 1;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        const entryStat = await stat(absolutePath).catch((error) => {
          if (isNotFoundError(error)) {
            return null;
          }
          throw error;
        });
        if (!entryStat?.isFile()) {
          continue;
        }

        files.set(relativePath, {
          absolutePath,
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs
        });
      }
    }

    const relativeDirectory = normalizeRelativePath(path.relative(rootDir, directory));
    if (visibleChildren === 0 && relativeDirectory && !suppressedChildren) {
      emptyDirectories.add(relativeDirectory);
    }
  };

  await walk(rootDir);
  return { files, emptyDirectories };
}

export function createDirectoryFingerprint(snapshot: LocalDirectorySnapshot): string {
  const hash = createHash("sha1");
  for (const [relativePath, file] of [...snapshot.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`file:${relativePath}:${file.size}:${Math.trunc(file.mtimeMs)}\n`);
  }
  for (const relativePath of [...snapshot.emptyDirectories].sort((left, right) => left.localeCompare(right))) {
    hash.update(`dir:${relativePath}\n`);
  }
  return hash.digest("hex");
}

export function createDirectoryFingerprintFromEntries(input: {
  files: Array<{ relativePath: string; size: number; mtimeMs: number }>;
  emptyDirectories: Iterable<string>;
}): string {
  const hash = createHash("sha1");
  for (const file of [...input.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(`file:${file.relativePath}:${file.size}:${Math.trunc(file.mtimeMs)}\n`);
  }
  for (const relativePath of [...input.emptyDirectories].sort((left, right) => left.localeCompare(right))) {
    hash.update(`dir:${relativePath}\n`);
  }
  return hash.digest("hex");
}

export function resolveEmptyRemoteDirectories(input: {
  explicitDirectories: Iterable<string>;
  filePaths: Iterable<string>;
}): string[] {
  const explicitDirectories = [...input.explicitDirectories]
    .map((relativePath) => normalizeRelativePath(relativePath))
    .filter((relativePath) => relativePath.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const filePaths = [...input.filePaths]
    .map((relativePath) => normalizeRelativePath(relativePath))
    .filter((relativePath) => relativePath.length > 0);

  return explicitDirectories.filter((candidate) => {
    const childPrefix = `${candidate}/`;
    return (
      !filePaths.some((relativePath) => relativePath.startsWith(childPrefix)) &&
      !explicitDirectories.some((relativePath) => relativePath !== candidate && relativePath.startsWith(childPrefix))
    );
  });
}
