import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRecord,
  HookRunAuditRecord,
  Message,
  Run,
  RunStep,
  EngineMessage,
  Session,
  ToolCallAuditRecord,
  WorkspaceArchiveRecord,
  WorkspaceArchiveRepository
} from "@oah/engine-core";
import { nowIso } from "@oah/engine-core";

import {
  inspectNativeArchiveExportDirectory,
  isNativeArchiveExportEnabled,
  resolveDefaultNativeArchiveExportWorkerCount,
  shouldPreferNativeArchiveExportBundle,
  writeNativeArchiveBundle,
  writeNativeArchiveChecksum
} from "./native-archive-export.js";

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
  logger?: WorkspaceArchiveExporterLogger | undefined;
}

const archiveSchemaStatements = [
  `create table if not exists archive_manifest (
    archive_date text primary key,
    timezone text not null,
    exported_at text not null,
    archive_count integer not null
  )`,
  `create table if not exists archives (
    archive_id text primary key,
    workspace_id text not null,
    scope_type text not null,
    scope_id text not null,
    archive_date text not null,
    archived_at text not null,
    deleted_at text not null,
    timezone text not null,
    exported_at text,
    export_path text,
    workspace_name text not null,
    root_path text not null,
    workspace_snapshot text not null
  )`,
  `create table if not exists sessions (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    subject_ref text not null,
    model_ref text,
    agent_name text,
    active_agent_name text not null,
    title text,
    status text not null,
    last_run_at text,
    created_at text not null,
    updated_at text not null,
    payload text not null,
    primary key (archive_id, id)
  )`,
  `create table if not exists runs (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    session_id text,
    parent_run_id text,
    trigger_type text not null,
    trigger_ref text,
    agent_name text,
    effective_agent_name text not null,
    status text not null,
    created_at text not null,
    started_at text,
    heartbeat_at text,
    ended_at text,
    payload text not null,
    primary key (archive_id, id)
  )`,
  `create table if not exists messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )`,
  `create table if not exists runtime_messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    kind text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )`,
  `create table if not exists run_steps (
    archive_id text not null,
    id text not null,
    run_id text not null,
    seq integer not null,
    step_type text not null,
    name text,
    agent_name text,
    status text not null,
    started_at text,
    ended_at text,
    input text,
    output text,
    primary key (archive_id, id)
  )`,
  `create table if not exists tool_calls (
    archive_id text not null,
    id text not null,
    run_id text not null,
    step_id text,
    source_type text not null,
    tool_name text not null,
    status text not null,
    duration_ms integer,
    started_at text not null,
    ended_at text not null,
    request text,
    response text,
    primary key (archive_id, id)
  )`,
  `create table if not exists hook_runs (
    archive_id text not null,
    id text not null,
    run_id text not null,
    hook_name text not null,
    event_name text not null,
    status text not null,
    started_at text not null,
    ended_at text not null,
    capabilities text not null,
    patch text,
    error_message text,
    primary key (archive_id, id)
  )`,
  `create table if not exists artifacts (
    archive_id text not null,
    id text not null,
    run_id text not null,
    type text not null,
    path text,
    content_ref text,
    created_at text not null,
    metadata text,
    primary key (archive_id, id)
  )`
] as const;

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

function archiveExportDbPath(exportRoot: string, archiveDate: string): string {
  return path.join(exportRoot, `${archiveDate}.sqlite`);
}

function archiveChecksumPath(exportPath: string): string {
  return `${exportPath}.sha256`;
}

function isArchiveBundleName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite$/u.test(fileName);
}

function isArchiveChecksumName(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.sqlite\.sha256$/u.test(fileName);
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function applyArchiveSchema(db: DatabaseSync): void {
  for (const statement of archiveSchemaStatements) {
    db.exec(statement);
  }
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

interface ArchiveDirectoryInspection {
  unexpectedDirectories: string[];
  leftoverTempFiles: string[];
  unexpectedFiles: string[];
  missingChecksums: string[];
  orphanChecksums: string[];
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

async function inspectArchiveDirectoryWithFallback(exportRoot: string): Promise<ArchiveDirectoryInspection> {
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

async function writeArchiveChecksumWithFallback(exportPath: string, checksumPath: string): Promise<void> {
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

const ARCHIVE_EXPORT_STREAM_PAGE_SIZE = 4;

type ArchiveBundleProducer = (visitor: (archive: WorkspaceArchiveRecord) => Promise<void>) => Promise<string[]>;

interface ArchiveBundleWriteSummary {
  archiveIds: string[];
  archiveCount: number;
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

async function writeArchiveBundleWithFallback(input: {
  outputPath: string;
  archiveDate: string;
  exportPath: string;
  exportedAt: string;
  produceArchives: ArchiveBundleProducer;
  preferNative: boolean;
}): Promise<ArchiveBundleWriteSummary> {
  if (!input.preferNative || !isNativeArchiveExportEnabled()) {
    return writeArchiveBundleTypeScript(input);
  }

  try {
    const result = await writeNativeArchiveBundle({
      outputPath: input.outputPath,
      archiveDate: input.archiveDate,
      exportPath: input.exportPath,
      exportedAt: input.exportedAt,
      produceArchives: async (writer) => input.produceArchives((archive) => writer.writeArchive(archive))
    });
    return {
      archiveIds: result.archiveIds,
      archiveCount: result.archiveCount
    };
  } catch (error) {
    console.warn(
      `[oah-native] Falling back to TypeScript archive bundle write for ${input.archiveDate}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return writeArchiveBundleTypeScript(input);
  }
}

interface ArchiveInsertStatements {
  manifest: ReturnType<DatabaseSync["prepare"]>;
  archive: ReturnType<DatabaseSync["prepare"]>;
  session: ReturnType<DatabaseSync["prepare"]>;
  run: ReturnType<DatabaseSync["prepare"]>;
  message: ReturnType<DatabaseSync["prepare"]>;
  engineMessage: ReturnType<DatabaseSync["prepare"]>;
  runStep: ReturnType<DatabaseSync["prepare"]>;
  toolCall: ReturnType<DatabaseSync["prepare"]>;
  hookRun: ReturnType<DatabaseSync["prepare"]>;
  artifact: ReturnType<DatabaseSync["prepare"]>;
}

function createArchiveInsertStatements(db: DatabaseSync): ArchiveInsertStatements {
  return {
    manifest: db.prepare(
      `insert or replace into archive_manifest (archive_date, timezone, exported_at, archive_count)
       values (?, ?, ?, ?)`
    ),
    archive: db.prepare(
      `insert or replace into archives (
        archive_id, workspace_id, scope_type, scope_id, archive_date, archived_at, deleted_at, timezone, exported_at, export_path, workspace_name, root_path, workspace_snapshot
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    session: db.prepare(
      `insert or replace into sessions (
        archive_id, id, workspace_id, subject_ref, model_ref, agent_name, active_agent_name, title, status, last_run_at, created_at, updated_at, payload
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    run: db.prepare(
      `insert or replace into runs (
        archive_id, id, workspace_id, session_id, parent_run_id, trigger_type, trigger_ref, agent_name, effective_agent_name, status, created_at, started_at, heartbeat_at, ended_at, payload
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    message: db.prepare(
      `insert or replace into messages (
        archive_id, id, session_id, run_id, role, created_at, content, metadata
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    engineMessage: db.prepare(
      `insert or replace into runtime_messages (
        archive_id, id, session_id, run_id, role, kind, created_at, content, metadata
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    runStep: db.prepare(
      `insert or replace into run_steps (
        archive_id, id, run_id, seq, step_type, name, agent_name, status, started_at, ended_at, input, output
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    toolCall: db.prepare(
      `insert or replace into tool_calls (
        archive_id, id, run_id, step_id, source_type, tool_name, status, duration_ms, started_at, ended_at, request, response
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    hookRun: db.prepare(
      `insert or replace into hook_runs (
        archive_id, id, run_id, hook_name, event_name, status, started_at, ended_at, capabilities, patch, error_message
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    artifact: db.prepare(
      `insert or replace into artifacts (
        archive_id, id, run_id, type, path, content_ref, created_at, metadata
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
  };
}

function insertSessionRows(statement: ArchiveInsertStatements["session"], archiveId: string, sessions: Session[]): void {
  for (const session of sessions) {
    statement.run(
      archiveId,
      session.id,
      session.workspaceId,
      session.subjectRef,
      session.modelRef ?? null,
      session.agentName ?? null,
      session.activeAgentName,
      session.title ?? null,
      session.status,
      session.lastRunAt ?? null,
      session.createdAt,
      session.updatedAt,
      jsonText(session)
    );
  }
}

function insertRunRows(statement: ArchiveInsertStatements["run"], archiveId: string, runs: Run[]): void {
  for (const run of runs) {
    statement.run(
      archiveId,
      run.id,
      run.workspaceId,
      run.sessionId ?? null,
      run.parentRunId ?? null,
      run.triggerType,
      run.triggerRef ?? null,
      run.agentName ?? null,
      run.effectiveAgentName,
      run.status,
      run.createdAt,
      run.startedAt ?? null,
      run.heartbeatAt ?? null,
      run.endedAt ?? null,
      jsonText(run)
    );
  }
}

function insertMessageRows(statement: ArchiveInsertStatements["message"], archiveId: string, messages: Message[]): void {
  for (const message of messages) {
    statement.run(
      archiveId,
      message.id,
      message.sessionId,
      message.runId ?? null,
      message.role,
      message.createdAt,
      jsonText(message.content),
      message.metadata ? jsonText(message.metadata) : null
    );
  }
}

function insertEngineMessageRows(
  statement: ArchiveInsertStatements["engineMessage"],
  archiveId: string,
  engineMessages: EngineMessage[]
): void {
  for (const message of engineMessages) {
    statement.run(
      archiveId,
      message.id,
      message.sessionId,
      message.runId ?? null,
      message.role,
      message.kind,
      message.createdAt,
      jsonText(message.content),
      message.metadata ? jsonText(message.metadata) : null
    );
  }
}

function insertRunStepRows(statement: ArchiveInsertStatements["runStep"], archiveId: string, runSteps: RunStep[]): void {
  for (const step of runSteps) {
    statement.run(
      archiveId,
      step.id,
      step.runId,
      step.seq,
      step.stepType,
      step.name ?? null,
      step.agentName ?? null,
      step.status,
      step.startedAt ?? null,
      step.endedAt ?? null,
      step.input !== undefined ? jsonText(step.input) : null,
      step.output !== undefined ? jsonText(step.output) : null
    );
  }
}

function insertToolCallRows(
  statement: ArchiveInsertStatements["toolCall"],
  archiveId: string,
  toolCalls: ToolCallAuditRecord[]
): void {
  for (const toolCall of toolCalls) {
    statement.run(
      archiveId,
      toolCall.id,
      toolCall.runId,
      toolCall.stepId ?? null,
      toolCall.sourceType,
      toolCall.toolName,
      toolCall.status,
      toolCall.durationMs ?? null,
      toolCall.startedAt,
      toolCall.endedAt,
      toolCall.request ? jsonText(toolCall.request) : null,
      toolCall.response ? jsonText(toolCall.response) : null
    );
  }
}

function insertHookRunRows(
  statement: ArchiveInsertStatements["hookRun"],
  archiveId: string,
  hookRuns: HookRunAuditRecord[]
): void {
  for (const hookRun of hookRuns) {
    statement.run(
      archiveId,
      hookRun.id,
      hookRun.runId,
      hookRun.hookName,
      hookRun.eventName,
      hookRun.status,
      hookRun.startedAt,
      hookRun.endedAt,
      jsonText(hookRun.capabilities),
      hookRun.patch ? jsonText(hookRun.patch) : null,
      hookRun.errorMessage ?? null
    );
  }
}

function insertArtifactRows(
  statement: ArchiveInsertStatements["artifact"],
  archiveId: string,
  artifacts: ArtifactRecord[]
): void {
  for (const artifact of artifacts) {
    statement.run(
      archiveId,
      artifact.id,
      artifact.runId,
      artifact.type,
      artifact.path ?? null,
      artifact.contentRef ?? null,
      artifact.createdAt,
      artifact.metadata ? jsonText(artifact.metadata) : null
    );
  }
}

function insertArchiveManifestRow(
  statement: ArchiveInsertStatements["manifest"],
  archiveDate: string,
  timezone: string,
  exportedAt: string,
  archiveCount: number
): void {
  statement.run(archiveDate, timezone, exportedAt, archiveCount);
}

function insertArchiveRow(
  statements: ArchiveInsertStatements,
  exportPath: string,
  exportedAt: string,
  archive: WorkspaceArchiveRecord
): void {
  statements.archive.run(
    archive.id,
    archive.workspaceId,
    archive.scopeType,
    archive.scopeId,
    archive.archiveDate,
    archive.archivedAt,
    archive.deletedAt,
    archive.timezone,
    exportedAt,
    exportPath,
    archive.workspace.name,
    archive.workspace.rootPath,
    jsonText(archive.workspace)
  );

  insertSessionRows(statements.session, archive.id, archive.sessions);
  insertRunRows(statements.run, archive.id, archive.runs);
  insertMessageRows(statements.message, archive.id, archive.messages);
  insertEngineMessageRows(statements.engineMessage, archive.id, archive.engineMessages);
  insertRunStepRows(statements.runStep, archive.id, archive.runSteps);
  insertToolCallRows(statements.toolCall, archive.id, archive.toolCalls);
  insertHookRunRows(statements.hookRun, archive.id, archive.hookRuns);
  insertArtifactRows(statements.artifact, archive.id, archive.artifacts);
}

async function writeArchiveBundleTypeScript(input: {
  outputPath: string;
  archiveDate: string;
  exportPath: string;
  exportedAt: string;
  produceArchives: ArchiveBundleProducer;
}): Promise<ArchiveBundleWriteSummary> {
  const db = new DatabaseSync(input.outputPath);
  try {
    applyArchiveSchema(db);
    const statements = createArchiveInsertStatements(db);
    const archiveIds: string[] = [];
    let archiveCount = 0;
    let timezone = "UTC";

    db.exec("begin immediate");
    try {
      const producedArchiveIds = await input.produceArchives(async (archive) => {
        if (archiveCount === 0) {
          timezone = archive.timezone;
        }
        archiveCount += 1;
        insertArchiveRow(statements, input.exportPath, input.exportedAt, archive);
      });
      archiveIds.push(...producedArchiveIds);
      insertArchiveManifestRow(statements.manifest, input.archiveDate, timezone, input.exportedAt, archiveCount);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }

    return {
      archiveIds,
      archiveCount
    };
  } finally {
    db.close();
  }
}

export class WorkspaceArchiveExporter {
  readonly #repository: WorkspaceArchiveRepository;
  readonly #exportRoot: string;
  readonly #timeZone: string;
  readonly #pollIntervalMs: number;
  readonly #batchLimit: number;
  readonly #exportedRetentionDays: number;
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
