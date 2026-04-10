import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createStorageAdmin } from "../apps/server/src/storage-admin.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("storage admin", () => {
  it("includes archive export directory metrics in the overview", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-storage-admin-"));
    tempDirs.push(tempDir);

    const archiveDir = path.join(tempDir, "archives");
    await mkdir(archiveDir, { recursive: true });
    await Promise.all([
      mkdir(path.join(archiveDir, "manual"), { recursive: true }),
      writeFile(path.join(archiveDir, "2026-04-08.sqlite"), "bundle-a", "utf8"),
      writeFile(path.join(archiveDir, "2026-04-08.sqlite.sha256"), "checksum-a", "utf8"),
      writeFile(path.join(archiveDir, "2026-04-09.sqlite"), "bundle-bb", "utf8"),
      writeFile(path.join(archiveDir, "2026-04-09.sqlite.tmp"), "temp", "utf8"),
      writeFile(path.join(archiveDir, "2026-04-10.sqlite.sha256"), "orphan", "utf8"),
      writeFile(path.join(archiveDir, "README.txt"), "note", "utf8")
    ]);

    const pool = {
      async query<T extends Record<string, unknown>>(sqlText: string) {
        if (sqlText.includes("current_database()")) {
          return {
            rows: [{ database: "oah_test" }],
            fields: []
          };
        }

        const countTableMatch = sqlText.match(/select count\(\*\)::text as count from ([a-z_]+)/u);
        if (countTableMatch) {
          return {
            rows: [{ count: countTableMatch[1] === "archives" ? "5" : "1" }],
            fields: []
          };
        }

        if (sqlText.includes("from history_events")) {
          return {
            rows: [
              {
                count: "7",
                oldestOccurredAt: "2026-04-01T00:00:00.000Z",
                newestOccurredAt: "2026-04-10T00:00:00.000Z"
              }
            ],
            fields: []
          };
        }

        if (sqlText.includes("from archives")) {
          return {
            rows: [
              {
                rowCount: "5",
                pendingExports: "2",
                exportedRows: "3",
                oldestPendingArchiveDate: "2026-04-08",
                newestExportedAt: "2026-04-10T01:02:03.000Z"
              }
            ],
            fields: []
          };
        }

        throw new Error(`Unexpected query: ${sqlText}`);
      }
    } as unknown as Pool;

    const storageAdmin = createStorageAdmin({
      postgresPool: pool,
      redisAvailable: false,
      redisEventBusEnabled: false,
      redisRunQueueEnabled: false,
      archiveExportEnabled: true,
      archiveExportRoot: archiveDir
    });

    const overview = await storageAdmin.overview();

    expect(overview.postgres.archives).toMatchObject({
      exportEnabled: true,
      rowCount: 5,
      pendingExports: 2,
      exportedRows: 3,
      exportRoot: archiveDir,
      bundleCount: 2,
      checksumCount: 2,
      totalBytes: 17,
      latestArchiveDate: "2026-04-09",
      leftoverTempFiles: 1,
      unexpectedFiles: 1,
      unexpectedDirectories: 1,
      missingChecksums: 1,
      orphanChecksums: 1,
      oldestPendingArchiveDate: "2026-04-08",
      newestExportedAt: "2026-04-10T01:02:03.000Z"
    });

    await storageAdmin.close();
  });
});
