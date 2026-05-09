import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceArchiveRecord, WorkspaceArchiveRepository } from "@oah/engine-core";
import { nowIso } from "@oah/engine-core";

import {
  resolveDefaultNativeArchiveExportWorkerCount,
  shouldPreferNativeArchiveExportBundle
} from "./native-archive-export.js";
import {
  ARCHIVE_EXPORT_STREAM_PAGE_SIZE,
  writeArchiveBundleWithFallback
} from "./workspace-archive-export-bundle.js";
import {
  archiveChecksumPath,
  archiveExportDbPath,
  inspectArchiveDirectoryWithFallback,
  pruneArchiveExportBundles,
  writeArchiveChecksumWithFallback
} from "./workspace-archive-export-files.js";

export interface WorkspaceArchiveExporterLogger {
  info?(message: string): void;
  warn?(message: string, error?: unknown): void;
  error?(message: string, error?: unknown): void;
}

export interface WorkspaceArchiveExporterOptions {
  repository: WorkspaceArchiveRepository;
  exportRoot: string;
  timeZone?: string | undefined;
  pollIntervalMs?: number | undefined;
  batchLimit?: number | undefined;
  exportedRetentionDays?: number | undefined;
  exportedBundleRetentionDays?: number | undefined;
  logger?: WorkspaceArchiveExporterLogger | undefined;
}

function resolveArchiveTimeZone(input?: string | undefined): string {
  return (
    input?.trim() ||
    process.env.OAH_ARCHIVE_TIMEZONE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC"
  );
}

function formatArchiveDate(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function shiftArchiveDate(baseTimestamp: string, timeZone: string, deltaDays: number): string {
  return formatArchiveDate(
    new Date(new Date(baseTimestamp).getTime() + deltaDays * 24 * 60 * 60 * 1000).toISOString(),
    timeZone
  );
}

function resolvePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(
    Array.from({ length: normalizedConcurrency }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }

        await worker(items[index]!);
      }
    })
  );
}

export class WorkspaceArchiveExporter {
  readonly #repository: WorkspaceArchiveRepository;
  readonly #exportRoot: string;
  readonly #timeZone: string;
  readonly #pollIntervalMs: number;
  readonly #batchLimit: number;
  readonly #exportedRetentionDays: number;
  readonly #exportedBundleRetentionDays: number | undefined;
  readonly #logger: WorkspaceArchiveExporterLogger;
  #activeExport: Promise<void> | undefined;
  #hasInspectedExportRoot = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: WorkspaceArchiveExporterOptions) {
    this.#repository = options.repository;
    this.#exportRoot = options.exportRoot;
    this.#timeZone = resolveArchiveTimeZone(options.timeZone);
    this.#pollIntervalMs = Math.max(60_000, options.pollIntervalMs ?? 15 * 60_000);
    this.#batchLimit = Math.max(1, options.batchLimit ?? 32);
    this.#exportedRetentionDays = Math.max(1, options.exportedRetentionDays ?? 30);
    const exportedBundleRetentionDays =
      options.exportedBundleRetentionDays ?? resolvePositiveIntEnv("OAH_ARCHIVE_EXPORT_BUNDLE_RETENTION_DAYS");
    this.#exportedBundleRetentionDays =
      exportedBundleRetentionDays !== undefined && exportedBundleRetentionDays > 0
        ? Math.max(1, Math.floor(exportedBundleRetentionDays))
        : undefined;
    this.#logger = options.logger ?? {};
  }

  start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.exportPending();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
    void this.exportPending();
  }

  async close(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    if (this.#activeExport) {
      try {
        await this.#activeExport;
      } catch {
        // Ignore background export failures during shutdown.
      }
    }
  }

  async exportPending(): Promise<void> {
    if (this.#activeExport) {
      return this.#activeExport;
    }

    const task = (async () => {
      await this.#inspectExportRootIfNeeded();

      const now = nowIso();
      const today = formatArchiveDate(now, this.#timeZone);
      const pendingArchiveDates = await this.#repository.listPendingArchiveDates(today, this.#batchLimit);
      const preferNativeBundle = shouldPreferNativeArchiveExportBundle(pendingArchiveDates.length);
      const archiveExportConcurrency = preferNativeBundle
        ? Math.max(1, Math.min(resolveDefaultNativeArchiveExportWorkerCount(), pendingArchiveDates.length || 1))
        : 1;
      if (archiveExportConcurrency > 1 && pendingArchiveDates.length > 1) {
        await runWithConcurrencyLimit(pendingArchiveDates, archiveExportConcurrency, async (archiveDate) => {
          await this.#exportArchiveDate(archiveDate, preferNativeBundle);
        });
      } else {
        for (const archiveDate of pendingArchiveDates) {
          await this.#exportArchiveDate(archiveDate, preferNativeBundle);
        }
      }

      const exportedPruneBefore = shiftArchiveDate(now, this.#timeZone, -(this.#exportedRetentionDays - 1));
      const pruned = await this.#repository.pruneExportedBefore(exportedPruneBefore, this.#batchLimit);
      if (pruned > 0) {
        this.#logger.info?.(
          `Pruned ${pruned} exported workspace archives older than ${exportedPruneBefore} from primary storage.`
        );
      }

      if (this.#exportedBundleRetentionDays !== undefined) {
        const bundlePruneBefore = shiftArchiveDate(now, this.#timeZone, -(this.#exportedBundleRetentionDays - 1));
        const bundlePrune = await pruneArchiveExportBundles(this.#exportRoot, bundlePruneBefore, this.#batchLimit);
        if (bundlePrune.bundles > 0 || bundlePrune.checksums > 0) {
          this.#logger.info?.(
            `Pruned ${bundlePrune.bundles} archive export bundles and ${bundlePrune.checksums} checksums older than ${bundlePruneBefore} (${bundlePrune.bytes} bytes).`
          );
        }
      }
    })();

    this.#activeExport = task;
    try {
      await task;
    } finally {
      if (this.#activeExport === task) {
        this.#activeExport = undefined;
      }
    }
  }

  async #inspectExportRootIfNeeded(): Promise<void> {
    if (this.#hasInspectedExportRoot) {
      return;
    }

    this.#hasInspectedExportRoot = true;

    try {
      const inspection = await inspectArchiveDirectoryWithFallback(this.#exportRoot);

      if (inspection.unexpectedDirectories.length > 0) {
        this.#logger.warn?.(
          `Archive export directory ${this.#exportRoot} contains unexpected subdirectories: ${inspection.unexpectedDirectories.join(", ")}.`
        );
      }
      if (inspection.leftoverTempFiles.length > 0) {
        this.#logger.warn?.(
          `Archive export directory ${this.#exportRoot} contains leftover temporary files: ${inspection.leftoverTempFiles.join(", ")}.`
        );
      }
      if (inspection.unexpectedFiles.length > 0) {
        this.#logger.warn?.(
          `Archive export directory ${this.#exportRoot} contains files outside the YYYY-MM-DD.sqlite naming convention: ${inspection.unexpectedFiles.join(", ")}.`
        );
      }
      if (inspection.missingChecksums.length > 0) {
        this.#logger.warn?.(
          `Archive export directory ${this.#exportRoot} contains archive bundles without checksum files: ${inspection.missingChecksums.join(", ")}.`
        );
      }
      if (inspection.orphanChecksums.length > 0) {
        this.#logger.warn?.(
          `Archive export directory ${this.#exportRoot} contains checksum files without matching archive bundles: ${inspection.orphanChecksums.join(", ")}.`
        );
      }
    } catch (error) {
      this.#logger.warn?.(`Failed to inspect archive export directory ${this.#exportRoot}.`, error);
    }
  }

  async #produceArchiveDate(archiveDate: string, visitor: (archive: WorkspaceArchiveRecord) => Promise<void>): Promise<string[]> {
    const archiveIds: string[] = [];
    const repository = this.#repository as WorkspaceArchiveRepository & {
      forEachByArchiveDate?: (
        archiveDate: string,
        visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void,
        options?: { pageSize?: number | undefined }
      ) => Promise<number>;
    };

    const handleArchive = async (archive: WorkspaceArchiveRecord) => {
      archiveIds.push(archive.id);
      await visitor(archive);
    };

    if (repository.forEachByArchiveDate) {
      await repository.forEachByArchiveDate(archiveDate, handleArchive, {
        pageSize: ARCHIVE_EXPORT_STREAM_PAGE_SIZE
      });
      return archiveIds;
    }

    const archives = await this.#repository.listByArchiveDate(archiveDate);
    for (const archive of archives) {
      await handleArchive(archive);
    }

    return archiveIds;
  }

  async #exportArchiveDate(archiveDate: string, preferNativeBundle: boolean): Promise<void> {
    const exportPath = archiveExportDbPath(this.#exportRoot, archiveDate);
    const tempPath = `${exportPath}.tmp`;
    const checksumPath = archiveChecksumPath(exportPath);
    const exportedAt = nowIso();

    await mkdir(path.dirname(exportPath), { recursive: true });
    await rm(tempPath, { force: true });

    const bundle = await writeArchiveBundleWithFallback({
      outputPath: tempPath,
      archiveDate,
      exportPath,
      exportedAt,
      produceArchives: async (visitor) => this.#produceArchiveDate(archiveDate, visitor),
      preferNative: preferNativeBundle
    });
    if (bundle.archiveCount === 0) {
      await rm(tempPath, { force: true });
      return;
    }

    await rm(exportPath, { force: true });
    await rename(tempPath, exportPath);
    await writeArchiveChecksumWithFallback(exportPath, checksumPath);
    await this.#repository.markExported(
      bundle.archiveIds,
      {
        exportedAt,
        exportPath
      }
    );
    this.#logger.info?.(
      `Exported ${bundle.archiveCount} workspace archives for ${archiveDate} to ${exportPath} with checksum ${path.basename(checksumPath)}.`
    );
  }
}
