import { readdir, stat } from "node:fs/promises";
import path from "node:path";

function isArchiveBundleName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite$/u.test(fileName);
}

function isArchiveChecksumName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite\.sha256$/u.test(fileName);
}

export async function summarizeArchiveExportDirectory(exportRoot: string): Promise<{
  exportRoot: string;
  bundleCount: number;
  checksumCount: number;
  totalBytes: number;
  latestArchiveDate?: string | undefined;
  leftoverTempFiles: number;
  unexpectedFiles: number;
  unexpectedDirectories: number;
  missingChecksums: number;
  orphanChecksums: number;
}> {
  const entries = await readdir(exportRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  const bundleNames = new Set<string>();
  const checksumNames = new Set<string>();
  let totalBytes = 0;
  let leftoverTempFiles = 0;
  let unexpectedFiles = 0;
  let unexpectedDirectories = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      unexpectedDirectories += 1;
      continue;
    }

    if (entry.name.endsWith(".tmp")) {
      leftoverTempFiles += 1;
      continue;
    }

    if (isArchiveBundleName(entry.name)) {
      bundleNames.add(entry.name);
      const fileStat = await stat(path.join(exportRoot, entry.name));
      totalBytes += fileStat.size;
      continue;
    }

    if (isArchiveChecksumName(entry.name)) {
      checksumNames.add(entry.name);
      continue;
    }

    unexpectedFiles += 1;
  }

  let missingChecksums = 0;
  for (const bundleName of bundleNames) {
    if (!checksumNames.has(`${bundleName}.sha256`)) {
      missingChecksums += 1;
    }
  }

  let orphanChecksums = 0;
  for (const checksumName of checksumNames) {
    if (!bundleNames.has(checksumName.replace(/\.sha256$/u, ""))) {
      orphanChecksums += 1;
    }
  }

  return {
    exportRoot,
    bundleCount: bundleNames.size,
    checksumCount: checksumNames.size,
    totalBytes,
    ...(bundleNames.size > 0
      ? {
          latestArchiveDate: Array.from(bundleNames)
            .map((name) => name.replace(/\.sqlite$/u, ""))
            .sort()
            .at(-1)
        }
      : {}),
    leftoverTempFiles,
    unexpectedFiles,
    unexpectedDirectories,
    missingChecksums,
    orphanChecksums
  };
}
