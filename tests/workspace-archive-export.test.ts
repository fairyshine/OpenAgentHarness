import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceArchiveRecord, WorkspaceArchiveRepository } from "@oah/engine-core";

import { WorkspaceArchiveExporter } from "../apps/server/src/workspace-archive-export.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true
      })
    )
  );
});

function createArchiveRecord(overrides: Partial<WorkspaceArchiveRecord> = {}): WorkspaceArchiveRecord {
  return {
    id: overrides.id ?? "warc_1",
    workspaceId: overrides.workspaceId ?? "ws_1",
    scopeType: overrides.scopeType ?? "workspace",
    scopeId: overrides.scopeId ?? "ws_1",
    archiveDate: overrides.archiveDate ?? "2026-04-08",
    archivedAt: overrides.archivedAt ?? "2026-04-08T12:00:00.000Z",
    deletedAt: overrides.deletedAt ?? "2026-04-08T12:00:00.000Z",
    timezone: overrides.timezone ?? "Asia/Shanghai",
    workspace: overrides.workspace ?? {
      id: "ws_1",
      name: "demo",
      rootPath: "/tmp/demo",
      executionPolicy: "local",
      status: "active",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      createdAt: "2026-04-08T11:00:00.000Z",
      updatedAt: "2026-04-08T12:00:00.000Z",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_1",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    },
    sessions: overrides.sessions ?? [
      {
        id: "ses_1",
        workspaceId: "ws_1",
        subjectRef: "dev:test",
        activeAgentName: "builder",
        status: "active",
        createdAt: "2026-04-08T11:00:00.000Z",
        updatedAt: "2026-04-08T12:00:00.000Z"
      }
    ],
    runs: overrides.runs ?? [
      {
        id: "run_1",
        workspaceId: "ws_1",
        sessionId: "ses_1",
        triggerType: "message",
        effectiveAgentName: "builder",
        status: "completed",
        createdAt: "2026-04-08T11:05:00.000Z"
      }
    ],
    messages: overrides.messages ?? [
      {
        id: "msg_1",
        sessionId: "ses_1",
        runId: "run_1",
        role: "assistant",
        content: "archived hello",
        createdAt: "2026-04-08T11:06:00.000Z"
      }
    ],
    engineMessages: overrides.engineMessages ?? [],
    runSteps: overrides.runSteps ?? [],
    toolCalls: overrides.toolCalls ?? [],
    hookRuns: overrides.hookRuns ?? [],
    artifacts: overrides.artifacts ?? []
  };
}

describe("workspace archive exporter", () => {
  it("exports pending pre-today archive buckets into a date-named sqlite database", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-export-"));
    tempDirs.push(exportRoot);

    const archive = createArchiveRecord();
    const calls: {
      pendingBefore?: string;
      marked?: { ids: string[]; exportPath: string };
      prunedBefore?: string;
      prunedLimit?: number;
    } = {};

    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return archive;
      },
      async archiveSessionTree() {
        return archive;
      },
      async listPendingArchiveDates(beforeArchiveDate) {
        calls.pendingBefore = beforeArchiveDate;
        return ["2026-04-08"];
      },
      async listByArchiveDate(archiveDate) {
        return archiveDate === "2026-04-08" ? [archive] : [];
      },
      async markExported(ids, input) {
        calls.marked = {
          ids,
          exportPath: input.exportPath
        };
      },
      async pruneExportedBefore(beforeArchiveDate, limit) {
        calls.prunedBefore = beforeArchiveDate;
        calls.prunedLimit = limit;
        return 0;
      }
    };

    const exporter = new WorkspaceArchiveExporter({
      repository,
      exportRoot,
      timeZone: "Asia/Shanghai",
      pollIntervalMs: 60_000
    });

    await exporter.exportPending();
    await exporter.close();

    const expectedToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
    expect(calls.pendingBefore).toBe(expectedToday);
    expect(calls.marked?.ids).toEqual(["warc_1"]);
    expect(calls.marked?.exportPath).toBe(path.join(exportRoot, "2026-04-08.sqlite"));
    expect(calls.prunedBefore).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000))
    );
    expect(calls.prunedLimit).toBe(32);

    const dbPath = path.join(exportRoot, "2026-04-08.sqlite");
    const checksumPath = `${dbPath}.sha256`;
    const db = new DatabaseSync(dbPath);
    const manifest = db
      .prepare("select archive_date as archiveDate, archive_count as archiveCount from archive_manifest where archive_date = ?")
      .get("2026-04-08") as { archiveDate: string; archiveCount: number } | undefined;
    const archivedWorkspace = db
      .prepare("select workspace_id as workspaceId, scope_type as scopeType, scope_id as scopeId from archives where archive_id = ?")
      .get("warc_1") as { workspaceId: string; scopeType: string; scopeId: string } | undefined;
    const archivedMessage = db
      .prepare("select role, content from messages where archive_id = ? and id = ?")
      .get("warc_1", "msg_1") as { role: string; content: string } | undefined;
    db.close();

    expect(manifest).toEqual({
      archiveDate: "2026-04-08",
      archiveCount: 1
    });
    expect(archivedWorkspace?.workspaceId).toBe("ws_1");
    expect(archivedWorkspace?.scopeType).toBe("workspace");
    expect(archivedWorkspace?.scopeId).toBe("ws_1");
    expect(archivedMessage?.role).toBe("assistant");
    expect(JSON.parse(archivedMessage?.content ?? "null")).toBe("archived hello");
    await expect(readFile(checksumPath, "utf8")).resolves.toMatch(
      /^[a-f0-9]{64}  2026-04-08\.sqlite\n$/u
    );
  });

  it("exports multiple archives for the same date into one sqlite bundle", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-export-multi-"));
    tempDirs.push(exportRoot);

    const archiveA = createArchiveRecord();
    const archiveB = createArchiveRecord({
      id: "warc_2",
      workspaceId: "ws_2",
      scopeId: "ses_2",
      scopeType: "session",
      workspace: {
        ...createArchiveRecord().workspace,
        id: "ws_2",
        name: "demo-2",
        rootPath: "/tmp/demo-2",
        catalog: {
          workspaceId: "ws_2",
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      },
      sessions: [
        {
          id: "ses_2",
          workspaceId: "ws_2",
          subjectRef: "dev:test:2",
          activeAgentName: "builder",
          status: "archived",
          createdAt: "2026-04-08T10:00:00.000Z",
          updatedAt: "2026-04-08T11:00:00.000Z"
        }
      ],
      runs: [],
      messages: [
        {
          id: "msg_2",
          sessionId: "ses_2",
          role: "user",
          content: "archived two",
          createdAt: "2026-04-08T10:05:00.000Z"
        }
      ]
    });
    const marked: Array<{ ids: string[]; exportPath: string }> = [];

    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return archiveA;
      },
      async archiveSessionTree() {
        return archiveB;
      },
      async listPendingArchiveDates() {
        return ["2026-04-08"];
      },
      async listByArchiveDate(archiveDate) {
        return archiveDate === "2026-04-08" ? [archiveA, archiveB] : [];
      },
      async markExported(ids, input) {
        marked.push({
          ids,
          exportPath: input.exportPath
        });
      },
      async pruneExportedBefore() {
        return 0;
      }
    };

    const exporter = new WorkspaceArchiveExporter({
      repository,
      exportRoot,
      timeZone: "Asia/Shanghai"
    });

    await exporter.exportPending();
    await exporter.close();

    expect(marked).toEqual([
      {
        ids: ["warc_1", "warc_2"],
        exportPath: path.join(exportRoot, "2026-04-08.sqlite")
      }
    ]);

    const db = new DatabaseSync(path.join(exportRoot, "2026-04-08.sqlite"));
    try {
      const manifest = db
        .prepare("select archive_count as archiveCount from archive_manifest where archive_date = ?")
        .get("2026-04-08") as { archiveCount: number } | undefined;
      const archiveCount = db.prepare("select count(*) as count from archives").get() as { count: number };
      const messageCount = db.prepare("select count(*) as count from messages").get() as { count: number };

      expect(manifest).toEqual({
        archiveCount: 2
      });
      expect(archiveCount.count).toBe(2);
      expect(messageCount.count).toBe(2);
    } finally {
      db.close();
    }
  });

  it("prefers repository per-archive iteration when available", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-export-stream-"));
    tempDirs.push(exportRoot);

    const archive = createArchiveRecord();
    let forEachCalls = 0;
    let listCalls = 0;

    const repository: WorkspaceArchiveRepository & {
      forEachByArchiveDate: (
        archiveDate: string,
        visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void,
        options?: { pageSize?: number | undefined }
      ) => Promise<number>;
    } = {
      async archiveWorkspace() {
        return archive;
      },
      async archiveSessionTree() {
        return archive;
      },
      async listPendingArchiveDates() {
        return ["2026-04-08"];
      },
      async listByArchiveDate() {
        listCalls += 1;
        throw new Error("listByArchiveDate should not be called when forEachByArchiveDate is available");
      },
      async forEachByArchiveDate(archiveDate, visitor) {
        forEachCalls += 1;
        if (archiveDate === "2026-04-08") {
          await visitor(archive);
          return 1;
        }
        return 0;
      },
      async markExported() {},
      async pruneExportedBefore() {
        return 0;
      }
    };

    const exporter = new WorkspaceArchiveExporter({
      repository,
      exportRoot
    });

    await exporter.exportPending();
    await exporter.close();

    expect(forEachCalls).toBe(1);
    expect(listCalls).toBe(0);

    const db = new DatabaseSync(path.join(exportRoot, "2026-04-08.sqlite"));
    try {
      const archiveCount = db.prepare("select count(*) as count from archives").get() as { count: number };
      expect(archiveCount.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("prunes exported archive metadata after the retention window", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-export-prune-"));
    tempDirs.push(exportRoot);

    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return createArchiveRecord();
      },
      async archiveSessionTree() {
        return createArchiveRecord();
      },
      async listPendingArchiveDates() {
        return [];
      },
      async listByArchiveDate() {
        return [];
      },
      async markExported() {},
      async pruneExportedBefore() {
        return 3;
      }
    };

    const logs: string[] = [];
    const exporter = new WorkspaceArchiveExporter({
      repository,
      exportRoot,
      timeZone: "Asia/Shanghai",
      batchLimit: 7,
      exportedRetentionDays: 14,
      logger: {
        info(message) {
          logs.push(message);
        }
      }
    });

    await exporter.exportPending();
    await exporter.close();

    expect(logs.some((message) => message.includes("Pruned 3 exported workspace archives older than"))).toBe(true);
  });

  it("warns about unexpected archive directory entries without deleting them", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-export-inspect-"));
    tempDirs.push(exportRoot);

    await Promise.all([
      mkdir(path.join(exportRoot, "manual"), { recursive: true }),
      writeFile(path.join(exportRoot, "2026-04-08.sqlite"), "bundle", "utf8"),
      writeFile(path.join(exportRoot, "2026-04-08.sqlite.tmp"), "temp", "utf8"),
      writeFile(path.join(exportRoot, "2026-04-09.sqlite.sha256"), "deadbeef", "utf8"),
      writeFile(path.join(exportRoot, "notes.txt"), "note", "utf8")
    ]);

    const warnings: string[] = [];
    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return createArchiveRecord();
      },
      async archiveSessionTree() {
        return createArchiveRecord();
      },
      async listPendingArchiveDates() {
        return [];
      },
      async listByArchiveDate() {
        return [];
      },
      async markExported() {},
      async pruneExportedBefore() {
        return 0;
      }
    };

    const exporter = new WorkspaceArchiveExporter({
      repository,
      exportRoot,
      logger: {
        warn(message) {
          warnings.push(message);
        }
      }
    });

    await exporter.exportPending();
    await exporter.exportPending();
    await exporter.close();

    expect(warnings).toHaveLength(5);
    expect(warnings.some((message) => message.includes("unexpected subdirectories"))).toBe(true);
    expect(warnings.some((message) => message.includes("leftover temporary files"))).toBe(true);
    expect(warnings.some((message) => message.includes("outside the YYYY-MM-DD.sqlite naming convention"))).toBe(true);
    expect(warnings.some((message) => message.includes("without checksum files"))).toBe(true);
    expect(warnings.some((message) => message.includes("without matching archive bundles"))).toBe(true);
    await expect(readFile(path.join(exportRoot, "2026-04-08.sqlite.tmp"), "utf8")).resolves.toBe("temp");
    await expect(readFile(path.join(exportRoot, "notes.txt"), "utf8")).resolves.toBe("note");
  });
});
