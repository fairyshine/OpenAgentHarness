import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRecord,
  EngineMessage,
  HookRunAuditRecord,
  Message,
  Run,
  RunStep,
  Session,
  ToolCallAuditRecord,
  WorkspaceArchiveRecord
} from "@oah/engine-core";

import { isNativeArchiveExportEnabled, writeNativeArchiveBundle } from "./native-archive-export.js";

export const ARCHIVE_EXPORT_STREAM_PAGE_SIZE = 4;

export type ArchiveBundleProducer = (visitor: (archive: WorkspaceArchiveRecord) => Promise<void>) => Promise<string[]>;

export interface ArchiveBundleWriteSummary {
  archiveIds: string[];
  archiveCount: number;
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

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function applyArchiveSchema(db: DatabaseSync): void {
  for (const statement of archiveSchemaStatements) {
    db.exec(statement);
  }
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

export async function writeArchiveBundleWithFallback(input: {
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
