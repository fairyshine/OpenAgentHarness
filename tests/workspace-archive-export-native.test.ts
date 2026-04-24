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
  isNativeArchiveExportEnabled?: (() => boolean) | undefined;
  shouldPreferNativeArchiveExportBundle?: ((pendingArchiveDateCount: number) => boolean) | undefined;
  resolveDefaultNativeArchiveExportWorkerCount?: (() => number) | undefined;
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
    archives?: WorkspaceArchiveRecord[] | undefined;
    produceArchives?: ((writer: { writeArchive(archive: WorkspaceArchiveRecord): Promise<void> }) => Promise<string[]>) | undefined;
  }) => Promise<{
    ok: true;
    protocolVersion: number;
    outputPath: string;
    archiveDate: string;
    archiveCount: number;
    archiveIds?: string[] | undefined;
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
      isNativeArchiveExportEnabled: overrides.isNativeArchiveExportEnabled ?? (() => true),
      shouldPreferNativeArchiveExportBundle: overrides.shouldPreferNativeArchiveExportBundle ?? (() => true),
      resolveDefaultNativeArchiveExportWorkerCount: overrides.resolveDefaultNativeArchiveExportWorkerCount ?? (() => 1),
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
  vi.unstubAllEnvs();
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
      archives?: WorkspaceArchiveRecord[] | undefined;
      produceArchives?: ((writer: { writeArchive(archive: WorkspaceArchiveRecord): Promise<void> }) => Promise<string[]>) | undefined;
    }) => {
      const archives: WorkspaceArchiveRecord[] = [];
      const archiveIds =
        input.archives?.map((archive) => archive.id) ??
        (await input.produceArchives?.({
          async writeArchive(archive) {
            archives.push(archive);
          }
        })) ??
        [];
      await writeFile(input.outputPath, "native bundle", "utf8");
      return {
        ok: true as const,
        protocolVersion: 1,
        outputPath: input.outputPath,
        archiveDate: input.archiveDate,
        archiveCount: archives.length,
        archiveIds
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
    expect(bundleSpy).toHaveBeenCalledTimes(1);
    const bundleInput = bundleSpy.mock.calls[0]?.[0];
    expect(bundleInput).toMatchObject({
      outputPath: `${dbPath}.tmp`,
      archiveDate: "2026-04-08",
      exportPath: dbPath,
      exportedAt: expect.any(String)
    });
    expect(bundleInput?.archives).toBeUndefined();
    expect(typeof bundleInput?.produceArchives).toBe("function");
    expect(checksumSpy).toHaveBeenCalledWith({
      filePath: dbPath,
      outputPath: checksumPath
    });
    await expect(readFile(checksumPath, "utf8")).resolves.toBe("deadbeef  2026-04-08.sqlite\n");
  });

  it("keeps single-date auto exports on the TypeScript bundle path", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-native-auto-single-"));
    tempDirs.push(exportRoot);

    const archive = createArchiveRecord({
      messages: [
        {
          id: "msg_native_auto_single_1",
          sessionId: "ses_native_1",
          role: "assistant",
          content: "auto single date",
          createdAt: "2026-04-08T11:06:00.000Z"
        }
      ]
    });
    const bundleSpy = vi.fn();
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
    const { WorkspaceArchiveExporter } = await importExporterWithNativeMocks({
      isNativeArchiveExportEnabled: () => true,
      shouldPreferNativeArchiveExportBundle: () => false,
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
    expect(bundleSpy).not.toHaveBeenCalled();
    await expect(readFile(dbPath)).resolves.toBeInstanceOf(Buffer);
    expect(checksumSpy).toHaveBeenCalledWith({
      filePath: dbPath,
      outputPath: checksumPath
    });
  });

  it("uses native bundle writing for multi-date auto exports", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-native-auto-multi-"));
    tempDirs.push(exportRoot);

    const archiveA = createArchiveRecord({
      id: "warc_native_auto_1",
      archiveDate: "2026-04-08"
    });
    const archiveB = createArchiveRecord({
      id: "warc_native_auto_2",
      workspaceId: "ws_native_2",
      scopeId: "ws_native_2",
      archiveDate: "2026-04-07",
      workspace: {
        ...createArchiveRecord().workspace,
        id: "ws_native_2",
        name: "native-auto-2",
        rootPath: "/tmp/native-auto-2",
        catalog: {
          workspaceId: "ws_native_2",
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      }
    });
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
      archives?: WorkspaceArchiveRecord[] | undefined;
      produceArchives?: ((writer: { writeArchive(archive: WorkspaceArchiveRecord): Promise<void> }) => Promise<string[]>) | undefined;
    }) => {
      const archives: WorkspaceArchiveRecord[] = [];
      const archiveIds =
        input.archives?.map((archive) => archive.id) ??
        (await input.produceArchives?.({
          async writeArchive(archive) {
            archives.push(archive);
          }
        })) ??
        [];
      await writeFile(input.outputPath, `native bundle ${input.archiveDate}`, "utf8");
      return {
        ok: true as const,
        protocolVersion: 1,
        outputPath: input.outputPath,
        archiveDate: input.archiveDate,
        archiveCount: archives.length,
        archiveIds
      };
    });
    const { WorkspaceArchiveExporter } = await importExporterWithNativeMocks({
      isNativeArchiveExportEnabled: () => true,
      shouldPreferNativeArchiveExportBundle: (pendingArchiveDateCount) => pendingArchiveDateCount > 1,
      resolveDefaultNativeArchiveExportWorkerCount: () => 2,
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

    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return archiveA;
      },
      async archiveSessionTree() {
        return archiveB;
      },
      async listPendingArchiveDates() {
        return ["2026-04-08", "2026-04-07"];
      },
      async listByArchiveDate(archiveDate) {
        if (archiveDate === "2026-04-08") {
          return [archiveA];
        }
        if (archiveDate === "2026-04-07") {
          return [archiveB];
        }
        return [];
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

    expect(bundleSpy).toHaveBeenCalledTimes(2);
    expect(bundleSpy.mock.calls.map(([input]) => input.archiveDate).sort()).toEqual(["2026-04-07", "2026-04-08"]);
  });
});
