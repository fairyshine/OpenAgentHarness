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

        if (sqlText.includes(`count(*) filter (where coalesce(metadata->'recovery'->>'state', '') <> '')`)) {
          return {
            rows: [
              {
                trackedRuns: "4",
                quarantinedRuns: "2",
                requeuedRuns: "1",
                failedRecoveryRuns: "1",
                workerRecoveryFailures: "2",
                oldestQuarantinedAt: "2026-04-08T01:00:00.000Z",
                newestQuarantinedAt: "2026-04-09T02:00:00.000Z",
                newestRecoveredAt: "2026-04-10T03:00:00.000Z"
              }
            ],
            fields: []
          };
        }

        if (sqlText.includes("where coalesce(metadata->'recovery'->>'state', '') = 'quarantined'")) {
          return {
            rows: [
              { reason: "max_attempts_exhausted", count: "2" },
              { reason: "missing_session", count: "1" }
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
    expect(overview.postgres.recovery).toEqual({
      trackedRuns: 4,
      quarantinedRuns: 2,
      requeuedRuns: 1,
      failedRecoveryRuns: 1,
      workerRecoveryFailures: 2,
      oldestQuarantinedAt: "2026-04-08T01:00:00.000Z",
      newestQuarantinedAt: "2026-04-09T02:00:00.000Z",
      newestRecoveredAt: "2026-04-10T03:00:00.000Z",
      topQuarantineReasons: [
        { reason: "max_attempts_exhausted", count: 2 },
        { reason: "missing_session", count: 1 }
      ]
    });

    await storageAdmin.close();
  });

  it("filters runs by status, error code and recovery state", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      async query<T extends Record<string, unknown>>(sqlText: string, values?: unknown[]) {
        queries.push({ sql: sqlText, values });

        if (sqlText.startsWith("select count(*)::text as count from runs")) {
          return {
            rows: [{ count: "1" }],
            fields: []
          };
        }

        if (sqlText.startsWith("select * from runs")) {
          return {
            rows: [
              {
                id: "run_1",
                status: "failed",
                error_code: "worker_recovery_failed",
                metadata: {
                  recovery: {
                    state: "quarantined"
                  }
                }
              }
            ],
            fields: [{ name: "id" }, { name: "status" }, { name: "error_code" }, { name: "metadata" }]
          };
        }

        throw new Error(`Unexpected query: ${sqlText}`);
      }
    } as unknown as Pool;

    const storageAdmin = createStorageAdmin({
      postgresPool: pool,
      redisAvailable: false,
      redisEventBusEnabled: false,
      redisRunQueueEnabled: false
    });

    const page = await storageAdmin.postgresTable("runs", {
      limit: 25,
      status: "failed",
      errorCode: "worker_recovery_failed",
      recoveryState: "quarantined"
    });

    expect(page.appliedFilters).toEqual({
      status: "failed",
      errorCode: "worker_recovery_failed",
      recoveryState: "quarantined"
    });
    expect(page.rows).toHaveLength(1);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain("status = $1");
    expect(queries[0]?.sql).toContain("error_code = $2");
    expect(queries[0]?.sql).toContain("coalesce(metadata->'recovery'->>'state', '') = $3");
    expect(queries[0]?.values).toEqual(["failed", "worker_recovery_failed", "quarantined"]);
    expect(queries[1]?.values).toEqual(["failed", "worker_recovery_failed", "quarantined"]);

    await storageAdmin.close();
  });

  it("uses bounded SCAN for redis overview key summaries", async () => {
    const previousLimit = process.env.OAH_STORAGE_ADMIN_REDIS_OVERVIEW_KEY_LIMIT;
    process.env.OAH_STORAGE_ADMIN_REDIS_OVERVIEW_KEY_LIMIT = "2";
    const commands: string[][] = [];

    const redisClient = {
      isOpen: true,
      async dbSize() {
        return 5;
      },
      async lLen(key: string) {
        if (key === "oah:runs:ready") {
          return 3;
        }
        if (key.endsWith(":queue")) {
          return 7;
        }
        if (key.endsWith(":events")) {
          return 9;
        }
        return 0;
      },
      async sendCommand(command: string[]) {
        commands.push(command);
        const pattern = command[3];
        if (pattern === "oah:session:*:queue") {
          return [
            "1",
            [
              "oah:session:ses_1:queue",
              "oah:session:ses_2:queue",
              "oah:session:ses_3:queue"
            ]
          ];
        }
        if (pattern === "oah:session:*:lock") {
          return ["0", ["oah:session:ses_4:lock"]];
        }
        if (pattern === "oah:session:*:events") {
          return ["0", ["oah:session:ses_5:events"]];
        }
        throw new Error(`Unexpected SCAN pattern: ${String(pattern)}`);
      },
      async pTTL() {
        return 1234;
      },
      async get() {
        return "worker_1";
      },
      async keys() {
        throw new Error("KEYS must not be used by redis overview.");
      },
      async quit() {
        throw new Error("Injected redis clients must not be closed by storage admin.");
      }
    };

    try {
      const storageAdmin = createStorageAdmin({
        redisClient: redisClient as Parameters<typeof createStorageAdmin>[0]["redisClient"],
        redisAvailable: true,
        redisEventBusEnabled: true,
        redisRunQueueEnabled: true
      });

      const overview = await storageAdmin.overview();

      expect(commands.map((command) => command[0])).toEqual(["SCAN", "SCAN", "SCAN"]);
      expect(overview.redis.readyQueue).toEqual({
        key: "oah:runs:ready",
        length: 3
      });
      expect(overview.redis.sessionQueues).toEqual([
        { key: "oah:session:ses_1:queue", sessionId: "ses_1", length: 7 },
        { key: "oah:session:ses_2:queue", sessionId: "ses_2", length: 7 }
      ]);
      expect(overview.redis.sessionQueuesTruncated).toBe(true);
      expect(overview.redis.sessionLocksTruncated).toBeUndefined();
      expect(overview.redis.eventBuffersTruncated).toBeUndefined();

      await storageAdmin.close();
    } finally {
      if (previousLimit === undefined) {
        delete process.env.OAH_STORAGE_ADMIN_REDIS_OVERVIEW_KEY_LIMIT;
      } else {
        process.env.OAH_STORAGE_ADMIN_REDIS_OVERVIEW_KEY_LIMIT = previousLimit;
      }
    }
  });

  it("routes postgres inspection to the matching service database", async () => {
    const defaultQueries: string[] = [];
    const serviceQueries: string[] = [];
    const createdConnectionStrings: string[] = [];
    let servicePoolClosed = false;
    const defaultPool = {
      async query<T extends Record<string, unknown>>(sqlText: string) {
        defaultQueries.push(sqlText);
        if (sqlText.startsWith("select count(*)::text as count from runs")) {
          return {
            rows: [{ count: "0" }],
            fields: []
          };
        }

        if (sqlText.startsWith("select * from runs")) {
          return {
            rows: [],
            fields: []
          };
        }

        throw new Error(`Unexpected default query: ${sqlText}`);
      }
    } as unknown as Pool;
    const servicePool = {
      async query<T extends Record<string, unknown>>(sqlText: string) {
        serviceQueries.push(sqlText);
        if (sqlText.startsWith("select count(*)::text as count from runs")) {
          return {
            rows: [{ count: "1" }],
            fields: []
          };
        }

        if (sqlText.startsWith("select * from runs")) {
          return {
            rows: [{ id: "run_service_1", status: "completed" }],
            fields: [{ name: "id" }, { name: "status" }]
          };
        }

        throw new Error(`Unexpected service query: ${sqlText}`);
      },
      async end() {
        servicePoolClosed = true;
      }
    } as unknown as Pool;

    const storageAdmin = createStorageAdmin({
      postgresPool: defaultPool,
      postgresConnectionString: "postgres://user:pass@127.0.0.1:5432/OAH",
      postgresPoolFactory: ({ connectionString }) => {
        createdConnectionStrings.push(connectionString);
        return servicePool;
      },
      redisAvailable: false,
      redisEventBusEnabled: false,
      redisRunQueueEnabled: false
    });

    const page = await storageAdmin.postgresTable("runs", {
      limit: 10,
      serviceName: "Acme"
    });

    expect(page.rows).toEqual([{ id: "run_service_1", status: "completed" }]);
    expect(createdConnectionStrings).toEqual(["postgres://user:pass@127.0.0.1:5432/OAH-acme"]);
    expect(defaultQueries).toEqual([]);
    expect(serviceQueries).toHaveLength(2);

    await storageAdmin.close();
    expect(servicePoolClosed).toBe(true);
  });

  it("builds worker affinity summaries from the worker registry", async () => {
    const storageAdmin = createStorageAdmin({
      redisAvailable: true,
      redisEventBusEnabled: true,
      redisRunQueueEnabled: true,
      workerRegistry: {
        async listActive() {
          return [
            {
              workerId: "worker_1",
              processKind: "standalone",
              state: "idle",
              health: "healthy",
              lastSeenAt: "2026-04-15T00:00:00.000Z",
              leaseTtlMs: 15_000,
              expiresAt: "2026-04-15T00:00:15.000Z",
              lastSeenAgeMs: 250,
              currentWorkspaceId: "ws_1"
            },
            {
              workerId: "worker_2",
              processKind: "embedded",
              state: "busy",
              health: "healthy",
              lastSeenAt: "2026-04-15T00:00:01.000Z",
              leaseTtlMs: 15_000,
              expiresAt: "2026-04-15T00:00:16.000Z",
              lastSeenAgeMs: 150,
              currentSessionId: "ses_1",
              currentWorkspaceId: "ws_2"
            }
          ];
        },
        async close() {}
      }
    });

    const affinity = await storageAdmin.redisWorkerAffinity({
      workspaceId: "ws_1",
      ownerWorkerId: "worker_1"
    });

    expect(affinity.preferredWorkerId).toBe("worker_1");
    expect(affinity.workspaceAffinityWorkerId).toBe("worker_1");
    expect(affinity.ownerWorkerId).toBe("worker_1");
    expect(affinity.candidates[0]).toMatchObject({
      workerId: "worker_1",
      matchingWorkspaceSlots: 1
    });
    expect(affinity.candidates[0]?.reasons).toContain("owner_worker");
    expect(affinity.candidates[0]?.reasons).toContain("same_workspace");

    await storageAdmin.close();
  });

  it("derives same-owner worker affinity from workspace placement state", async () => {
    const storageAdmin = createStorageAdmin({
      redisAvailable: true,
      redisEventBusEnabled: true,
      redisRunQueueEnabled: true,
      workerRegistry: {
        async listActive() {
          return [
            {
              workerId: "worker_1",
              processKind: "standalone",
              state: "busy",
              health: "healthy",
              lastSeenAt: "2026-04-15T00:00:00.000Z",
              leaseTtlMs: 15_000,
              expiresAt: "2026-04-15T00:00:15.000Z",
              lastSeenAgeMs: 250
            },
            {
              workerId: "worker_2",
              processKind: "standalone",
              state: "idle",
              health: "healthy",
              lastSeenAt: "2026-04-15T00:00:01.000Z",
              leaseTtlMs: 15_000,
              expiresAt: "2026-04-15T00:00:16.000Z",
              lastSeenAgeMs: 150
            }
          ];
        },
        async close() {}
      },
      workspacePlacementRegistry: {
        async upsert() {
          return undefined;
        },
        async assignOwnerAffinity() {
          return undefined;
        },
        async setPreferredWorker() {
          return undefined;
        },
        async releaseOwnership() {
          return undefined;
        },
        async listAll() {
          return [
            {
              workspaceId: "ws_1",
              version: "live",
              ownerId: "user_1",
              ownerWorkerId: "worker_1",
              state: "idle" as const,
              updatedAt: "2026-04-15T00:00:00.000Z"
            },
            {
              workspaceId: "ws_2",
              version: "live",
              ownerId: "user_1",
              ownerWorkerId: "worker_1",
              state: "active" as const,
              updatedAt: "2026-04-15T00:00:01.000Z"
            },
            {
              workspaceId: "ws_3",
              version: "live",
              ownerId: "user_1",
              state: "unassigned" as const,
              updatedAt: "2026-04-15T00:00:02.000Z"
            }
          ];
        },
        async getByWorkspaceId(workspaceId) {
          return workspaceId === "ws_3"
            ? {
                workspaceId,
                version: "live",
                ownerId: "user_1",
                state: "unassigned" as const,
                updatedAt: "2026-04-15T00:00:02.000Z"
              }
            : undefined;
        }
      }
    });

    const affinity = await storageAdmin.redisWorkerAffinity({
      workspaceId: "ws_3"
    });

    expect(affinity.ownerAffinityWorkerId).toBe("worker_1");
    expect(affinity.preferredWorkerId).toBe("worker_1");
    expect(affinity.candidates[0]).toMatchObject({
      workerId: "worker_1",
      matchingOwnerWorkspaces: 2
    });
    expect(affinity.candidates[0]?.reasons).toContain("same_owner");

    await storageAdmin.close();
  });

  it("surfaces controller-target worker hints in worker affinity summaries", async () => {
    const storageAdmin = createStorageAdmin({
      redisAvailable: true,
      redisEventBusEnabled: true,
      redisRunQueueEnabled: true,
      workerRegistry: {
        async listActive() {
          return [
            {
              workerId: "worker_1",
              processKind: "standalone",
              state: "idle",
              health: "healthy",
              lastSeenAt: "2026-04-15T00:00:00.000Z",
              leaseTtlMs: 15_000,
              expiresAt: "2026-04-15T00:00:15.000Z",
              lastSeenAgeMs: 250
            },
            {
              workerId: "worker_2",
              processKind: "standalone",
              state: "idle",
              health: "healthy",
              lastSeenAt: "2026-04-15T00:00:01.000Z",
              leaseTtlMs: 15_000,
              expiresAt: "2026-04-15T00:00:16.000Z",
              lastSeenAgeMs: 150
            }
          ];
        },
        async close() {}
      },
      workspacePlacementRegistry: {
        async upsert() {
          return undefined;
        },
        async assignOwnerAffinity() {
          return undefined;
        },
        async setPreferredWorker() {
          return undefined;
        },
        async releaseOwnership() {
          return undefined;
        },
        async listAll() {
          return [
            {
              workspaceId: "ws_targeted",
              version: "live",
              preferredWorkerId: "worker_2",
              preferredWorkerReason: "controller_target" as const,
              state: "unassigned" as const,
              updatedAt: "2026-04-15T00:00:02.000Z"
            }
          ];
        },
        async getByWorkspaceId(workspaceId) {
          return workspaceId === "ws_targeted"
            ? {
                workspaceId,
                version: "live",
                preferredWorkerId: "worker_2",
                preferredWorkerReason: "controller_target" as const,
                state: "unassigned" as const,
                updatedAt: "2026-04-15T00:00:02.000Z"
              }
            : undefined;
        }
      }
    });

    const affinity = await storageAdmin.redisWorkerAffinity({
      workspaceId: "ws_targeted"
    });

    expect(affinity.controllerTargetWorkerId).toBe("worker_2");
    expect(affinity.preferredWorkerId).toBe("worker_2");
    expect(affinity.candidates[0]?.reasons).toContain("controller_target");

    await storageAdmin.close();
  });

  it("lists workspace placement state from the placement registry", async () => {
    const storageAdmin = createStorageAdmin({
      redisAvailable: true,
      redisEventBusEnabled: true,
      redisRunQueueEnabled: true,
      workspacePlacementRegistry: {
        async upsert() {
          return undefined;
        },
        async assignOwnerAffinity() {
          return undefined;
        },
        async setPreferredWorker() {
          return undefined;
        },
        async releaseOwnership() {
          return undefined;
        },
        async listAll() {
          return [
            {
              workspaceId: "ws_1",
              version: "live",
              ownerId: "user_1",
              ownerWorkerId: "worker_1",
              state: "idle" as const,
              updatedAt: "2026-04-15T00:00:00.000Z"
            },
            {
              workspaceId: "ws_2",
              version: "live",
              ownerId: "user_2",
              ownerWorkerId: "worker_2",
              state: "active" as const,
              updatedAt: "2026-04-15T00:00:01.000Z"
            }
          ];
        },
        async getByWorkspaceId(workspaceId) {
          return workspaceId === "ws_1"
            ? {
                workspaceId,
                version: "live",
                ownerId: "user_1",
                ownerWorkerId: "worker_1",
                state: "idle" as const,
                updatedAt: "2026-04-15T00:00:00.000Z"
              }
            : undefined;
        }
      }
    });

    await expect(storageAdmin.redisWorkspacePlacements()).resolves.toEqual({
      items: [
        {
          workspaceId: "ws_1",
          version: "live",
          ownerId: "user_1",
          ownerWorkerId: "worker_1",
          state: "idle",
          updatedAt: "2026-04-15T00:00:00.000Z"
        },
        {
          workspaceId: "ws_2",
          version: "live",
          ownerId: "user_2",
          ownerWorkerId: "worker_2",
          state: "active",
          updatedAt: "2026-04-15T00:00:01.000Z"
        }
      ]
    });
    await expect(
      storageAdmin.redisWorkspacePlacements({
        workspaceId: "ws_1"
      })
    ).resolves.toEqual({
      items: [
        {
          workspaceId: "ws_1",
          version: "live",
          ownerId: "user_1",
          ownerWorkerId: "worker_1",
          state: "idle",
          updatedAt: "2026-04-15T00:00:00.000Z"
        }
      ]
    });
    await expect(
      storageAdmin.redisWorkspacePlacements({
        ownerId: "user_2"
      })
    ).resolves.toEqual({
      items: [
        {
          workspaceId: "ws_2",
          version: "live",
          ownerId: "user_2",
          ownerWorkerId: "worker_2",
          state: "active",
          updatedAt: "2026-04-15T00:00:01.000Z"
        }
      ]
    });
    await expect(
      storageAdmin.redisWorkspacePlacements({
        ownerWorkerId: "worker_1",
        state: "idle"
      })
    ).resolves.toEqual({
      items: [
        {
          workspaceId: "ws_1",
          version: "live",
          ownerId: "user_1",
          ownerWorkerId: "worker_1",
          state: "idle",
          updatedAt: "2026-04-15T00:00:00.000Z"
        }
      ]
    });

    await storageAdmin.close();
  });
});
