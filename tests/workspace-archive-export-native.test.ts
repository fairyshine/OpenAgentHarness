import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceArchiveRecord, WorkspaceArchiveRepository } from "@oah/engine-core";

const tempDirs: string[] = [];

function createArchiveRecord(overrides: Partial<WorkspaceArchiveRecord> = {}): WorkspaceArchiveRecord {
  return {
    id: overrides.id ?? "warc_native_1",
    workspaceId: overrides.workspaceId ?? "ws_native_1",
    scopeType: overrides.scopeType ?? "workspace",
    scopeId: overrides.scopeId ?? "ws_native_1",
    archiveDate: overrides.archiveDate ?? "2026-04-08",
    archivedAt: overrides.archivedAt ?? "2026-04-08T12:00:00.000Z",
    deletedAt: overrides.deletedAt ?? "2026-04-08T12:00:00.000Z",
    timezone: overrides.timezone ?? "Asia/Shanghai",
    workspace: overrides.workspace ?? {
      id: "ws_native_1",
      name: "native-demo",
      rootPath: "/tmp/native-demo",
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
        workspaceId: "ws_native_1",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    },
    sessions: overrides.sessions ?? [],
    runs: overrides.runs ?? [],
    messages: overrides.messages ?? [],
    engineMessages: overrides.engineMessages ?? [],
    runSteps: overrides.runSteps ?? [],
    toolCalls: overrides.toolCalls ?? [],
    hookRuns: overrides.hookRuns ?? [],
    artifacts: overrides.artifacts ?? []
  };
}

async function importExporterWithNativeMocks(overrides: {
  inspectNativeArchiveExportDirectory?: ((input: { exportRoot: string }) => Promise<{
    ok: true;
    protocolVersion: number;
    unexpectedDirectories: string[];
    leftoverTempFiles: string[];
    unexpectedFiles: string[];
    missingChecksums: string[];
    orphanChecksums: string[];
  }>) | undefined;
  writeNativeArchiveBundle?: ((input: {
    outputPath: string;
    archiveDate: string;
    exportPath: string;
    exportedAt: string;
    archives: WorkspaceArchiveRecord[];
  }) => Promise<{
    ok: true;
    protocolVersion: number;
    outputPath: string;
    archiveDate: string;
    archiveCount: number;
  }>) | undefined;
  writeNativeArchiveChecksum?: ((input: { filePath: string; outputPath?: string | undefined }) => Promise<{
    ok: true;
    protocolVersion: number;
    filePath: string;
    outputPath: string;
    checksum: string;
  }>) | undefined;
}) {
  vi.resetModules();
  vi.doMock("../apps/server/src/native-archive-export.ts", async () => {
    const actual =
      await vi.importActual<typeof import("../apps/server/src/native-archive-export.ts")>(
        "../apps/server/src/native-archive-export.ts"
      );
    return {
      ...actual,
      isNativeArchiveExportEnabled: () => true,
      ...(overrides.inspectNativeArchiveExportDirectory
        ? { inspectNativeArchiveExportDirectory: overrides.inspectNativeArchiveExportDirectory }
        : {}),
      ...(overrides.writeNativeArchiveBundle ? { writeNativeArchiveBundle: overrides.writeNativeArchiveBundle } : {}),
      ...(overrides.writeNativeArchiveChecksum ? { writeNativeArchiveChecksum: overrides.writeNativeArchiveChecksum } : {})
    };
  });
  return import("../apps/server/src/workspace-archive-export.ts");
}

afterEach(async () => {
  vi.doUnmock("../apps/server/src/native-archive-export.ts");
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace archive exporter native bridge", () => {
  it("uses native archive directory inspection when enabled", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-native-inspect-"));
    tempDirs.push(exportRoot);

    const inspectSpy = vi.fn(async () => ({
      ok: true as const,
      protocolVersion: 1,
      unexpectedDirectories: ["manual"],
      leftoverTempFiles: ["2026-04-08.sqlite.tmp"],
      unexpectedFiles: ["notes.txt"],
      missingChecksums: ["2026-04-08.sqlite"],
      orphanChecksums: ["2026-04-09.sqlite.sha256"]
    }));
    const { WorkspaceArchiveExporter } = await importExporterWithNativeMocks({
      inspectNativeArchiveExportDirectory: inspectSpy
    });

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
    await exporter.close();

    expect(inspectSpy).toHaveBeenCalledWith({ exportRoot });
    expect(warnings).toHaveLength(5);
    expect(warnings.some((message) => message.includes("unexpected subdirectories"))).toBe(true);
    expect(warnings.some((message) => message.includes("leftover temporary files"))).toBe(true);
  });

  it("uses native checksum writing when enabled", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-native-checksum-"));
    tempDirs.push(exportRoot);

    const checksumSpy = vi.fn(async (input: { filePath: string; outputPath?: string | undefined }) => {
      const outputPath = input.outputPath ?? `${input.filePath}.sha256`;
      await writeFile(outputPath, `deadbeef  ${path.basename(input.filePath)}\n`, "utf8");
      return {
        ok: true as const,
        protocolVersion: 1,
        filePath: input.filePath,
        outputPath,
        checksum: "deadbeef"
      };
    });
    const bundleSpy = vi.fn(async (input: {
      outputPath: string;
      archiveDate: string;
      exportPath: string;
      exportedAt: string;
      archives: WorkspaceArchiveRecord[];
    }) => {
      await writeFile(input.outputPath, "native bundle", "utf8");
      return {
        ok: true as const,
        protocolVersion: 1,
        outputPath: input.outputPath,
        archiveDate: input.archiveDate,
        archiveCount: input.archives.length
      };
    });
    const { WorkspaceArchiveExporter } = await importExporterWithNativeMocks({
      inspectNativeArchiveExportDirectory: vi.fn(async () => ({
        ok: true as const,
        protocolVersion: 1,
        unexpectedDirectories: [],
        leftoverTempFiles: [],
        unexpectedFiles: [],
        missingChecksums: [],
        orphanChecksums: []
      })),
      writeNativeArchiveBundle: bundleSpy,
      writeNativeArchiveChecksum: checksumSpy
    });

    const archive = createArchiveRecord({
      messages: [
        {
          id: "msg_native_1",
          sessionId: "ses_native_1",
          role: "assistant",
          content: "native checksum",
          createdAt: "2026-04-08T11:06:00.000Z"
        }
      ]
    });
    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return archive;
      },
      async archiveSessionTree() {
        return archive;
      },
      async listPendingArchiveDates() {
        return ["2026-04-08"];
      },
      async listByArchiveDate(archiveDate) {
        return archiveDate === "2026-04-08" ? [archive] : [];
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

    const dbPath = path.join(exportRoot, "2026-04-08.sqlite");
    const checksumPath = `${dbPath}.sha256`;
    expect(bundleSpy).toHaveBeenCalledWith({
      outputPath: `${dbPath}.tmp`,
      archiveDate: "2026-04-08",
      exportPath: dbPath,
      exportedAt: expect.any(String),
      archives: [archive]
    });
    expect(checksumSpy).toHaveBeenCalledWith({
      filePath: dbPath,
      outputPath: checksumPath
    });
    await expect(readFile(checksumPath, "utf8")).resolves.toBe("deadbeef  2026-04-08.sqlite\n");
  });
});
