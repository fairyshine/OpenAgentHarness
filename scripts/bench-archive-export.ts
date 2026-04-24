import { performance } from "node:perf_hooks";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { WorkspaceArchiveRecord, WorkspaceArchiveRepository } from "@oah/engine-core";

import { WorkspaceArchiveExporter } from "../apps/server/src/workspace-archive-export.ts";

interface BenchmarkOptions {
  archives: number;
  archiveDateBuckets: number;
  sessionsPerArchive: number;
  messagesPerSession: number;
  runsPerSession: number;
  stepsPerRun: number;
  engineMessagesPerSession: number;
  artifactsPerRun: number;
  toolCallsPerRun: number;
  hookRunsPerRun: number;
  messageSizeBytes: number;
  memoryPollIntervalMs: number;
  nativeMode: "force" | "auto";
}

interface MemorySample {
  rssBeforeMiB: number;
  rssAfterMiB: number;
  rssPeakDeltaMiB: number;
  heapBeforeMiB: number;
  heapAfterMiB: number;
  heapPeakDeltaMiB: number;
}

interface TimedMeasurement<T> {
  durationMs: number;
  memory: MemorySample;
  result: T;
}

interface BenchmarkRunResult {
  durationMs: number;
  memory: MemorySample;
  archiveCount: number;
  exportedDbSizeMiB: number;
  manifestArchiveCount: number;
  messageRowCount: number;
  runRowCount: number;
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    archives: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_COUNT || "8", 10) || 8,
    archiveDateBuckets: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_DATE_BUCKETS || "1", 10) || 1,
    sessionsPerArchive: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_SESSIONS || "8", 10) || 8,
    messagesPerSession: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_MESSAGES || "40", 10) || 40,
    runsPerSession: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_RUNS || "6", 10) || 6,
    stepsPerRun: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_STEPS || "8", 10) || 8,
    engineMessagesPerSession: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_ENGINE_MESSAGES || "24", 10) || 24,
    artifactsPerRun: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_ARTIFACTS || "2", 10) || 2,
    toolCallsPerRun: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_TOOL_CALLS || "3", 10) || 3,
    hookRunsPerRun: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_HOOK_RUNS || "1", 10) || 1,
    messageSizeBytes: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_MESSAGE_SIZE_BYTES || "1024", 10) || 1024,
    memoryPollIntervalMs: Number.parseInt(process.env.OAH_BENCH_ARCHIVE_MEMORY_POLL_MS || "10", 10) || 10,
    nativeMode: process.env.OAH_BENCH_ARCHIVE_NATIVE_MODE === "auto" ? "auto" : "force"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg?.startsWith("--") || value === undefined) {
      continue;
    }

    switch (arg) {
      case "--archives":
        options.archives = Math.max(1, Number.parseInt(value, 10) || options.archives);
        index += 1;
        break;
      case "--archive-date-buckets":
        options.archiveDateBuckets = Math.max(1, Number.parseInt(value, 10) || options.archiveDateBuckets);
        index += 1;
        break;
      case "--sessions-per-archive":
        options.sessionsPerArchive = Math.max(1, Number.parseInt(value, 10) || options.sessionsPerArchive);
        index += 1;
        break;
      case "--messages-per-session":
        options.messagesPerSession = Math.max(1, Number.parseInt(value, 10) || options.messagesPerSession);
        index += 1;
        break;
      case "--runs-per-session":
        options.runsPerSession = Math.max(1, Number.parseInt(value, 10) || options.runsPerSession);
        index += 1;
        break;
      case "--steps-per-run":
        options.stepsPerRun = Math.max(1, Number.parseInt(value, 10) || options.stepsPerRun);
        index += 1;
        break;
      case "--engine-messages-per-session":
        options.engineMessagesPerSession = Math.max(0, Number.parseInt(value, 10) || options.engineMessagesPerSession);
        index += 1;
        break;
      case "--artifacts-per-run":
        options.artifactsPerRun = Math.max(0, Number.parseInt(value, 10) || options.artifactsPerRun);
        index += 1;
        break;
      case "--tool-calls-per-run":
        options.toolCallsPerRun = Math.max(0, Number.parseInt(value, 10) || options.toolCallsPerRun);
        index += 1;
        break;
      case "--hook-runs-per-run":
        options.hookRunsPerRun = Math.max(0, Number.parseInt(value, 10) || options.hookRunsPerRun);
        index += 1;
        break;
      case "--message-size-bytes":
        options.messageSizeBytes = Math.max(1, Number.parseInt(value, 10) || options.messageSizeBytes);
        index += 1;
        break;
      case "--memory-poll-ms":
        options.memoryPollIntervalMs = Math.max(1, Number.parseInt(value, 10) || options.memoryPollIntervalMs);
        index += 1;
        break;
      case "--native-mode":
        options.nativeMode = value === "auto" ? "auto" : "force";
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function bytesToMiB(value: number): number {
  return round(value / (1024 * 1024));
}

function createPayload(prefix: string, sizeBytes: number): string {
  if (prefix.length >= sizeBytes) {
    return prefix.slice(0, sizeBytes);
  }

  return `${prefix}${"x".repeat(sizeBytes - prefix.length)}`;
}

function formatArchiveDateOffset(offsetDays: number): string {
  const date = new Date(Date.UTC(2026, 3, 8 - offsetDays, 0, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

async function measureOperation<T>(pollIntervalMs: number, action: () => Promise<T>): Promise<TimedMeasurement<T>> {
  const before = process.memoryUsage();
  let peakRss = before.rss;
  let peakHeap = before.heapUsed;
  const sampler = setInterval(() => {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    peakHeap = Math.max(peakHeap, current.heapUsed);
  }, pollIntervalMs);

  const start = performance.now();
  try {
    const result = await action();
    const after = process.memoryUsage();
    return {
      durationMs: performance.now() - start,
      memory: {
        rssBeforeMiB: bytesToMiB(before.rss),
        rssAfterMiB: bytesToMiB(after.rss),
        rssPeakDeltaMiB: bytesToMiB(Math.max(0, peakRss - before.rss)),
        heapBeforeMiB: bytesToMiB(before.heapUsed),
        heapAfterMiB: bytesToMiB(after.heapUsed),
        heapPeakDeltaMiB: bytesToMiB(Math.max(0, peakHeap - before.heapUsed))
      },
      result
    };
  } finally {
    clearInterval(sampler);
  }
}

function buildArchiveDataset(options: BenchmarkOptions): WorkspaceArchiveRecord[] {
  const archives: WorkspaceArchiveRecord[] = [];
  const messagePayload = createPayload("archive-message:", options.messageSizeBytes);
  const engineMessagePayload = createPayload("engine-message:", Math.max(256, Math.floor(options.messageSizeBytes / 2)));

  for (let archiveIndex = 0; archiveIndex < options.archives; archiveIndex += 1) {
    const workspaceId = `ws_${String(archiveIndex + 1).padStart(4, "0")}`;
    const archiveId = `warc_${String(archiveIndex + 1).padStart(4, "0")}`;
    const archiveDate = formatArchiveDateOffset(archiveIndex % options.archiveDateBuckets);
    const sessions: WorkspaceArchiveRecord["sessions"] = [];
    const runs: WorkspaceArchiveRecord["runs"] = [];
    const messages: WorkspaceArchiveRecord["messages"] = [];
    const engineMessages: WorkspaceArchiveRecord["engineMessages"] = [];
    const runSteps: WorkspaceArchiveRecord["runSteps"] = [];
    const toolCalls: WorkspaceArchiveRecord["toolCalls"] = [];
    const hookRuns: WorkspaceArchiveRecord["hookRuns"] = [];
    const artifacts: WorkspaceArchiveRecord["artifacts"] = [];

    for (let sessionIndex = 0; sessionIndex < options.sessionsPerArchive; sessionIndex += 1) {
      const sessionId = `${workspaceId}_ses_${String(sessionIndex + 1).padStart(3, "0")}`;
      sessions.push({
        id: sessionId,
        workspaceId,
        subjectRef: `bench:archive:${workspaceId}:${sessionIndex}`,
        activeAgentName: "builder",
        status: "archived",
        createdAt: "2026-04-08T11:00:00.000Z",
        updatedAt: "2026-04-08T12:00:00.000Z",
        title: `Archive session ${sessionIndex + 1}`
      });

      for (let runIndex = 0; runIndex < options.runsPerSession; runIndex += 1) {
        const runId = `${sessionId}_run_${String(runIndex + 1).padStart(3, "0")}`;
        runs.push({
          id: runId,
          workspaceId,
          sessionId,
          triggerType: "message",
          effectiveAgentName: "builder",
          status: "completed",
          createdAt: "2026-04-08T11:05:00.000Z",
          startedAt: "2026-04-08T11:05:01.000Z",
          endedAt: "2026-04-08T11:05:30.000Z"
        });

        for (let stepIndex = 0; stepIndex < options.stepsPerRun; stepIndex += 1) {
          const stepId = `${runId}_step_${String(stepIndex + 1).padStart(3, "0")}`;
          runSteps.push({
            id: stepId,
            runId,
            seq: stepIndex + 1,
            stepType: stepIndex % 2 === 0 ? "model" : "tool",
            name: `step-${stepIndex + 1}`,
            agentName: "builder",
            status: "completed",
            startedAt: "2026-04-08T11:05:02.000Z",
            endedAt: "2026-04-08T11:05:03.000Z",
            input: { prompt: `prompt-${stepIndex + 1}` },
            output: { text: `output-${stepIndex + 1}` }
          });
        }

        for (let toolCallIndex = 0; toolCallIndex < options.toolCallsPerRun; toolCallIndex += 1) {
          toolCalls.push({
            id: `${runId}_tool_${String(toolCallIndex + 1).padStart(3, "0")}`,
            runId,
            sourceType: "engine",
            toolName: "read_file",
            status: "completed",
            durationMs: 12 + toolCallIndex,
            startedAt: "2026-04-08T11:05:04.000Z",
            endedAt: "2026-04-08T11:05:05.000Z",
            request: { path: `src/file-${toolCallIndex + 1}.ts` },
            response: { bytes: 1234 + toolCallIndex }
          });
        }

        for (let hookRunIndex = 0; hookRunIndex < options.hookRunsPerRun; hookRunIndex += 1) {
          hookRuns.push({
            id: `${runId}_hook_${String(hookRunIndex + 1).padStart(3, "0")}`,
            runId,
            hookName: "post-run",
            eventName: "run.completed",
            capabilities: ["patch"],
            status: "completed",
            startedAt: "2026-04-08T11:05:06.000Z",
            endedAt: "2026-04-08T11:05:07.000Z"
          });
        }

        for (let artifactIndex = 0; artifactIndex < options.artifactsPerRun; artifactIndex += 1) {
          artifacts.push({
            id: `${runId}_artifact_${String(artifactIndex + 1).padStart(3, "0")}`,
            runId,
            type: "file",
            path: `.openharness/artifacts/${artifactIndex + 1}.txt`,
            contentRef: `artifact://${runId}/${artifactIndex + 1}`,
            createdAt: "2026-04-08T11:05:08.000Z",
            metadata: { bytes: 2048 + artifactIndex }
          });
        }
      }

      for (let messageIndex = 0; messageIndex < options.messagesPerSession; messageIndex += 1) {
        const runId = `${sessionId}_run_${String((messageIndex % options.runsPerSession) + 1).padStart(3, "0")}`;
        messages.push({
          id: `${sessionId}_msg_${String(messageIndex + 1).padStart(4, "0")}`,
          sessionId,
          runId,
          role: messageIndex % 2 === 0 ? "assistant" : "user",
          content: `${messagePayload}:${archiveIndex}:${sessionIndex}:${messageIndex}`,
          createdAt: "2026-04-08T11:06:00.000Z",
          metadata: messageIndex % 3 === 0 ? { tags: ["archive-bench"] } : undefined
        });
      }

      for (let engineMessageIndex = 0; engineMessageIndex < options.engineMessagesPerSession; engineMessageIndex += 1) {
        const runId = `${sessionId}_run_${String((engineMessageIndex % options.runsPerSession) + 1).padStart(3, "0")}`;
        engineMessages.push({
          id: `${sessionId}_emsg_${String(engineMessageIndex + 1).padStart(4, "0")}`,
          sessionId,
          runId,
          role: "assistant",
          kind: engineMessageIndex % 2 === 0 ? "assistant_text" : "tool_result",
          content: `${engineMessagePayload}:${archiveIndex}:${sessionIndex}:${engineMessageIndex}`,
          createdAt: "2026-04-08T11:06:01.000Z",
          metadata: { source: "engine" }
        });
      }
    }

    archives.push({
      id: archiveId,
      workspaceId,
      scopeType: archiveIndex % 2 === 0 ? "workspace" : "session",
      scopeId: archiveIndex % 2 === 0 ? workspaceId : `${workspaceId}_ses_001`,
      archiveDate,
      archivedAt: `${archiveDate}T12:00:00.000Z`,
      deletedAt: `${archiveDate}T12:00:00.000Z`,
      timezone: "Asia/Shanghai",
      workspace: {
        id: workspaceId,
        name: `archive-workspace-${archiveIndex + 1}`,
        rootPath: `/tmp/archive/${workspaceId}`,
        executionPolicy: "local",
        status: "archived",
        kind: "project",
        readOnly: false,
        historyMirrorEnabled: true,
        createdAt: "2026-04-08T10:00:00.000Z",
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
          workspaceId,
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      },
      sessions,
      runs,
      messages,
      engineMessages,
      runSteps,
      toolCalls,
      hookRuns,
      artifacts
    });
  }

  return archives;
}

async function runCase(options: {
  label: string;
  nativeMode: "off" | "force" | "auto";
  benchmark: BenchmarkOptions;
  archives: WorkspaceArchiveRecord[];
}): Promise<BenchmarkRunResult> {
  const exportRoot = await mkdtemp(path.join(os.tmpdir(), `oah-archive-bench-${options.label}-`));
  process.env.OAH_NATIVE_ARCHIVE_EXPORT =
    options.nativeMode === "off" ? "0" : options.nativeMode === "auto" ? "auto" : "1";

  try {
    const archiveDates = [...new Set(options.archives.map((archive) => archive.archiveDate))].sort();
    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return options.archives[0]!;
      },
      async archiveSessionTree() {
        return options.archives[0]!;
      },
      async listPendingArchiveDates() {
        return archiveDates;
      },
      async listByArchiveDate(archiveDate) {
        return options.archives.filter((archive) => archive.archiveDate === archiveDate);
      },
      async forEachByArchiveDate(archiveDate, visitor) {
        const items = options.archives.filter((archive) => archive.archiveDate === archiveDate);
        for (const archive of items) {
          await visitor(archive);
        }
        return items.length;
      },
      async markExported() {},
      async pruneExportedBefore() {
        return 0;
      }
    };

    const exporter = new WorkspaceArchiveExporter({
      repository,
      exportRoot,
      pollIntervalMs: 60_000
    });

    const measurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () => {
      await exporter.exportPending();
      await exporter.close();
      return undefined;
    });
    let exportedDbSizeBytes = 0;
    let manifestArchiveCount = 0;
    let messageRowCount = 0;
    let runRowCount = 0;

    for (const archiveDate of archiveDates) {
      const dbPath = path.join(exportRoot, `${archiveDate}.sqlite`);
      const checksumPath = `${dbPath}.sha256`;
      const dbStats = await stat(dbPath);
      exportedDbSizeBytes += dbStats.size;
      await readFile(checksumPath, "utf8");
      const db = new DatabaseSync(dbPath);
      try {
        manifestArchiveCount +=
          (
            db
              .prepare("select archive_count as archiveCount from archive_manifest where archive_date = ?")
              .get(archiveDate) as { archiveCount: number } | undefined
          )?.archiveCount ?? 0;
        messageRowCount += (db.prepare("select count(*) as count from messages").get() as { count: number }).count;
        runRowCount += (db.prepare("select count(*) as count from runs").get() as { count: number }).count;
      } finally {
        db.close();
      }
    }

    return {
      durationMs: measurement.durationMs,
      memory: measurement.memory,
      archiveCount: options.archives.length,
      exportedDbSizeMiB: bytesToMiB(exportedDbSizeBytes),
      manifestArchiveCount,
      messageRowCount,
      runRowCount
    };
  } finally {
    await rm(exportRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const archives = buildArchiveDataset(options);

  const totals = archives.reduce(
    (result, archive) => {
      result.sessions += archive.sessions.length;
      result.messages += archive.messages.length;
      result.runs += archive.runs.length;
      result.engineMessages += archive.engineMessages.length;
      result.runSteps += archive.runSteps.length;
      result.toolCalls += archive.toolCalls.length;
      result.hookRuns += archive.hookRuns.length;
      result.artifacts += archive.artifacts.length;
      return result;
    },
    {
      sessions: 0,
      messages: 0,
      runs: 0,
      engineMessages: 0,
      runSteps: 0,
      toolCalls: 0,
      hookRuns: 0,
      artifacts: 0
    }
  );

  console.log(
    `Benchmarking archive export with archives=${options.archives} archiveDates=${options.archiveDateBuckets} sessions=${totals.sessions} runs=${totals.runs} messages=${totals.messages} engineMessages=${totals.engineMessages} runSteps=${totals.runSteps}`
  );

  const tsCase = await runCase({
    label: "typescript",
    nativeMode: "off",
    benchmark: options,
    archives
  });
  const nativeCase = await runCase({
    label: `native-${options.nativeMode}`,
    nativeMode: options.nativeMode,
    benchmark: options,
    archives
  });

  console.table([
    {
      mode: "typescript",
      exportMs: Math.round(tsCase.durationMs),
      archiveCount: tsCase.archiveCount,
      dbSizeMiB: tsCase.exportedDbSizeMiB,
      manifestArchiveCount: tsCase.manifestArchiveCount,
      messageRows: tsCase.messageRowCount,
      runRows: tsCase.runRowCount
    },
      {
        mode: options.nativeMode === "auto" ? "native(auto)" : "native(force)",
        exportMs: Math.round(nativeCase.durationMs),
        archiveCount: nativeCase.archiveCount,
        dbSizeMiB: nativeCase.exportedDbSizeMiB,
      manifestArchiveCount: nativeCase.manifestArchiveCount,
      messageRows: nativeCase.messageRowCount,
      runRows: nativeCase.runRowCount
    }
  ]);

  console.table([
    {
      mode: "typescript",
      rssPeakMiB: tsCase.memory.rssPeakDeltaMiB,
      heapPeakMiB: tsCase.memory.heapPeakDeltaMiB
    },
      {
        mode: options.nativeMode === "auto" ? "native(auto)" : "native(force)",
        rssPeakMiB: nativeCase.memory.rssPeakDeltaMiB,
        heapPeakMiB: nativeCase.memory.heapPeakDeltaMiB
      }
  ]);

  console.log(
    `Native delta: export ${Math.round(tsCase.durationMs - nativeCase.durationMs)}ms, rssPeak ${round(
      tsCase.memory.rssPeakDeltaMiB - nativeCase.memory.rssPeakDeltaMiB
    )} MiB, heapPeak ${round(tsCase.memory.heapPeakDeltaMiB - nativeCase.memory.heapPeakDeltaMiB)} MiB`
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
