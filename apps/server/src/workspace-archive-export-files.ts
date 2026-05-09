import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  inspectNativeArchiveExportDirectory,
  isNativeArchiveExportEnabled,
  writeNativeArchiveChecksum
} from "./native-archive-export.js";

export interface ArchiveBundlePruneSummary {
  bundles: number;
  checksums: number;
  bytes: number;
}

export interface ArchiveDirectoryInspection {
  unexpectedDirectories: string[];
  leftoverTempFiles: string[];
  unexpectedFiles: string[];
  missingChecksums: string[];
  orphanChecksums: string[];
}

export function archiveExportDbPath(exportRoot: string, archiveDate: string): string {
  return path.join(exportRoot, `${archiveDate}.sqlite`);
}

export function archiveChecksumPath(exportPath: string): string {
  return `${exportPath}.sha256`;
}

function isArchiveBundleName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite$/u.test(fileName);
}

function isArchiveChecksumName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite\.sha256$/u.test(fileName);
}

function archiveDateFromExportFileName(fileName: string): string | undefined {
  if (isArchiveBundleName(fileName)) {
    return fileName.slice(0, "YYYY-MM-DD".length);
  }

  if (isArchiveChecksumName(fileName)) {
    return fileName.slice(0, "YYYY-MM-DD".length);
  }

  return undefined;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve();
    });
    stream.on("error", (error) => {
      reject(error);
    });
  });

  return hash.digest("hex");
}

async function removeArchiveExportFile(filePath: string): Promise<number | undefined> {
  try {
    const fileStat = await stat(filePath);
    await rm(filePath, { force: true });
    return fileStat.size;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function pruneArchiveExportBundles(
  exportRoot: string,
  beforeArchiveDate: string,
  limit: number
): Promise<ArchiveBundlePruneSummary> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = (await readdir(exportRoot, { withFileTypes: true })).map((entry) => ({
      name: String(entry.name),
      isFile: () => entry.isFile()
    }));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        bundles: 0,
        checksums: 0,
        bytes: 0
      };
    }

    throw error;
  }

  const removableBundles = entries
    .filter((entry) => entry.isFile() && isArchiveBundleName(entry.name))
    .map((entry) => ({
      fileName: entry.name,
      archiveDate: archiveDateFromExportFileName(entry.name)!
    }))
    .filter((entry) => entry.archiveDate < beforeArchiveDate)
    .sort((left, right) => left.archiveDate.localeCompare(right.archiveDate) || left.fileName.localeCompare(right.fileName))
    .slice(0, Math.max(0, limit));

  const removableBundleNames = new Set(removableBundles.map((entry) => entry.fileName));
  let bundles = 0;
  let checksums = 0;
  let bytes = 0;

  for (const entry of removableBundles) {
    const removedBytes = await removeArchiveExportFile(path.join(exportRoot, entry.fileName));
    if (removedBytes !== undefined) {
      bundles += 1;
      bytes += removedBytes;
    }

    const checksumName = `${entry.fileName}.sha256`;
    const checksumBytes = await removeArchiveExportFile(path.join(exportRoot, checksumName));
    if (checksumBytes !== undefined) {
      checksums += 1;
      bytes += checksumBytes;
    }
  }

  const remainingChecksumSlots = Math.max(0, limit - bundles);
  if (remainingChecksumSlots > 0) {
    const removableOrphanChecksums = entries
      .filter((entry) => entry.isFile() && isArchiveChecksumName(entry.name))
      .filter((entry) => {
        const archiveDate = archiveDateFromExportFileName(entry.name);
        const bundleName = entry.name.replace(/\.sha256$/u, "");
        return archiveDate !== undefined && archiveDate < beforeArchiveDate && !removableBundleNames.has(bundleName);
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, remainingChecksumSlots);

    for (const entry of removableOrphanChecksums) {
      const removedBytes = await removeArchiveExportFile(path.join(exportRoot, entry.name));
      if (removedBytes !== undefined) {
        checksums += 1;
        bytes += removedBytes;
      }
    }
  }

  return {
    bundles,
    checksums,
    bytes
  };
}

async function inspectArchiveDirectory(exportRoot: string): Promise<ArchiveDirectoryInspection> {
  const entries = await readdir(exportRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  const unexpectedDirectories: string[] = [];
  const leftoverTempFiles: string[] = [];
  const unexpectedFiles: string[] = [];
  const missingChecksums: string[] = [];
  const orphanChecksums: string[] = [];
  const bundleNames = new Set<string>();
  const checksumNames = new Set<string>();

  for (const entry of entries) {
    if (entry.isDirectory()) {
      unexpectedDirectories.push(entry.name);
      continue;
    }

    if (entry.name.endsWith(".tmp")) {
      leftoverTempFiles.push(entry.name);
      continue;
    }

    if (isArchiveBundleName(entry.name)) {
      bundleNames.add(entry.name);
      continue;
    }

    if (isArchiveChecksumName(entry.name)) {
      checksumNames.add(entry.name);
      continue;
    }

    unexpectedFiles.push(entry.name);
  }

  for (const bundleName of bundleNames) {
    const checksumName = `${bundleName}.sha256`;
    if (!checksumNames.has(checksumName)) {
      missingChecksums.push(bundleName);
    }
  }

  for (const checksumName of checksumNames) {
    const bundleName = checksumName.replace(/\.sha256$/u, "");
    if (!bundleNames.has(bundleName)) {
      orphanChecksums.push(checksumName);
    }
  }

  return {
    unexpectedDirectories,
    leftoverTempFiles,
    unexpectedFiles,
    missingChecksums,
    orphanChecksums
  };
}

export async function inspectArchiveDirectoryWithFallback(exportRoot: string): Promise<ArchiveDirectoryInspection> {
  if (!isNativeArchiveExportEnabled()) {
    return inspectArchiveDirectory(exportRoot);
  }

  try {
    const result = await inspectNativeArchiveExportDirectory({ exportRoot });
    return {
      unexpectedDirectories: result.unexpectedDirectories,
      leftoverTempFiles: result.leftoverTempFiles,
      unexpectedFiles: result.unexpectedFiles,
      missingChecksums: result.missingChecksums,
      orphanChecksums: result.orphanChecksums
    };
  } catch (error) {
    console.warn(
      `[oah-native] Falling back to TypeScript archive directory inspection for ${exportRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return inspectArchiveDirectory(exportRoot);
  }
}

export async function writeArchiveChecksumWithFallback(exportPath: string, checksumPath: string): Promise<void> {
  if (!isNativeArchiveExportEnabled()) {
    const checksum = await sha256File(exportPath);
    await writeFile(checksumPath, `${checksum}  ${path.basename(exportPath)}\n`, "utf8");
    return;
  }

  try {
    await writeNativeArchiveChecksum({
      filePath: exportPath,
      outputPath: checksumPath
    });
  } catch (error) {
    console.warn(
      `[oah-native] Falling back to TypeScript archive checksum write for ${exportPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    const checksum = await sha256File(exportPath);
    await writeFile(checksumPath, `${checksum}  ${path.basename(exportPath)}\n`, "utf8");
  }
}
