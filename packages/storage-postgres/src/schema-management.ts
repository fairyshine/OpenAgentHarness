import { type Pool } from "pg";

import type { Message, RunStep } from "@oah/engine-core";
import { isMessageRole, normalizePersistedMessageRecord, normalizePersistedMessages, normalizePersistedRunStep } from "@oah/engine-core";
import { createMessage, isRecord } from "./row-mappers.js";

interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const schemaLockKey = 20_260_401;

const schemaStatements = [
  `create table if not exists workspaces (
    id text primary key,
    external_ref text,
    owner_id text,
    service_name text,
    name text not null,
    root_path text not null,
    execution_policy text not null,
    status text not null,
    kind text not null,
    read_only boolean not null,
    history_mirror_enabled boolean not null,
    default_agent text,
    project_agents_md text,
    settings jsonb not null,
    workspace_models jsonb not null,
    agents jsonb not null,
    actions jsonb not null,
    skills jsonb not null,
    mcp_servers jsonb not null,
    hooks jsonb not null,
    catalog jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `create index if not exists workspaces_root_path_idx on workspaces (root_path)`,
  `create index if not exists workspaces_external_ref_idx on workspaces (external_ref)`,
  `alter table workspaces add column if not exists external_ref text`,
  `alter table workspaces add column if not exists owner_id text`,
  `alter table workspaces add column if not exists service_name text`,
  `alter table workspaces add column if not exists name text`,
  `alter table workspaces add column if not exists root_path text`,
  `alter table workspaces add column if not exists execution_policy text`,
  `alter table workspaces add column if not exists status text`,
  `alter table workspaces add column if not exists kind text`,
  `alter table workspaces add column if not exists read_only boolean`,
  `alter table workspaces add column if not exists history_mirror_enabled boolean`,
  `alter table workspaces add column if not exists default_agent text`,
  `alter table workspaces add column if not exists project_agents_md text`,
  `alter table workspaces add column if not exists settings jsonb`,
  `alter table workspaces add column if not exists workspace_models jsonb`,
  `alter table workspaces add column if not exists agents jsonb`,
  `alter table workspaces add column if not exists actions jsonb`,
  `alter table workspaces add column if not exists skills jsonb`,
  `alter table workspaces add column if not exists mcp_servers jsonb`,
  `alter table workspaces add column if not exists hooks jsonb`,
  `alter table workspaces add column if not exists catalog jsonb`,
  `alter table workspaces add column if not exists created_at timestamptz`,
  `alter table workspaces add column if not exists updated_at timestamptz`,
  `do $$
   begin
     if exists (
       select 1
       from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'workspaces'
         and column_name = 'tool_servers'
     ) then
       update workspaces
       set mcp_servers = coalesce(mcp_servers, tool_servers)
       where mcp_servers is null;
     end if;
   end
   $$;`,
  `update workspaces set kind = 'project' where kind is null`,
  `update workspaces set read_only = false where read_only is null`,
  `update workspaces set history_mirror_enabled = true where history_mirror_enabled is null`,
  `update workspaces set settings = '{}'::jsonb where settings is null`,
  `update workspaces set workspace_models = '{}'::jsonb where workspace_models is null`,
  `update workspaces set agents = '{}'::jsonb where agents is null`,
  `update workspaces set actions = '{}'::jsonb where actions is null`,
  `update workspaces set skills = '{}'::jsonb where skills is null`,
  `update workspaces set mcp_servers = '{}'::jsonb where mcp_servers is null`,
  `update workspaces set hooks = '{}'::jsonb where hooks is null`,
  `update workspaces set catalog = '{}'::jsonb where catalog is null`,
  `update workspaces set created_at = now() where created_at is null`,
  `update workspaces set updated_at = coalesce(updated_at, created_at, now()) where updated_at is null`,
  `alter table workspaces alter column name set not null`,
  `alter table workspaces alter column root_path set not null`,
  `alter table workspaces alter column execution_policy set not null`,
  `alter table workspaces alter column status set not null`,
  `alter table workspaces alter column kind set not null`,
  `alter table workspaces alter column read_only set not null`,
  `alter table workspaces alter column history_mirror_enabled set not null`,
  `alter table workspaces alter column settings set not null`,
  `alter table workspaces alter column workspace_models set not null`,
  `alter table workspaces alter column agents set not null`,
  `alter table workspaces alter column actions set not null`,
  `alter table workspaces alter column skills set not null`,
  `alter table workspaces alter column mcp_servers set not null`,
  `alter table workspaces alter column hooks set not null`,
  `alter table workspaces alter column catalog set not null`,
  `alter table workspaces alter column created_at set not null`,
  `alter table workspaces alter column updated_at set not null`,
  `create table if not exists sessions (
    id text primary key,
    workspace_id text not null references workspaces(id) on delete cascade,
    parent_session_id text references sessions(id) on delete set null,
    subject_ref text not null,
    model_ref text,
    agent_name text,
    active_agent_name text not null,
    title text,
    status text not null,
    last_run_at timestamptz,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `alter table sessions add column if not exists parent_session_id text references sessions(id) on delete set null`,
  `alter table sessions add column if not exists model_ref text`,
  `create index if not exists sessions_workspace_created_idx on sessions (workspace_id, created_at desc)`,
  `create index if not exists sessions_parent_session_idx on sessions (parent_session_id)`,
  `create index if not exists sessions_subject_created_idx on sessions (subject_ref, created_at desc)`,
  `create table if not exists runs (
    id text primary key,
    workspace_id text not null references workspaces(id) on delete cascade,
    session_id text references sessions(id) on delete cascade,
    parent_run_id text,
    initiator_ref text,
    trigger_type text not null,
    trigger_ref text,
    agent_name text,
    effective_agent_name text not null,
    switch_count integer,
    status text not null,
    cancel_requested_at timestamptz,
    started_at timestamptz,
    heartbeat_at timestamptz,
    ended_at timestamptz,
    error_code text,
    error_message text,
    metadata jsonb,
    created_at timestamptz not null
  )`,
  `create index if not exists runs_session_created_idx on runs (session_id, created_at desc)`,
  `create index if not exists runs_workspace_created_idx on runs (workspace_id, created_at desc)`,
  `create table if not exists messages (
    id text primary key,
    session_id text not null references sessions(id) on delete cascade,
    run_id text references runs(id) on delete cascade,
    role text not null,
    content jsonb not null,
    metadata jsonb,
    created_at timestamptz not null
  )`,
  `alter table messages alter column content type jsonb using to_jsonb(content)`,
  `alter table messages drop column if exists tool_name`,
  `alter table messages drop column if exists tool_call_id`,
  `create index if not exists messages_session_created_idx on messages (session_id, created_at)`,
  `create index if not exists messages_run_created_idx on messages (run_id, created_at)`,
  `create table if not exists runtime_messages (
    id text primary key,
    session_id text not null references sessions(id) on delete cascade,
    run_id text references runs(id) on delete cascade,
    role text not null,
    kind text not null,
    content jsonb not null,
    metadata jsonb,
    created_at timestamptz not null
  )`,
  `create index if not exists runtime_messages_session_created_idx on runtime_messages (session_id, created_at, id)`,
  `create index if not exists runtime_messages_run_created_idx on runtime_messages (run_id, created_at, id)`,
  `create table if not exists session_pending_runs (
    run_id text primary key references runs(id) on delete cascade,
    session_id text not null references sessions(id) on delete cascade,
    position integer not null,
    created_at timestamptz not null
  )`,
  `create index if not exists session_pending_runs_session_position_idx on session_pending_runs (session_id, position asc, created_at asc, run_id asc)`,
  `create table if not exists run_steps (
    id text primary key,
    run_id text not null references runs(id) on delete cascade,
    seq integer not null,
    step_type text not null,
    name text,
    agent_name text,
    status text not null,
    input jsonb,
    output jsonb,
    started_at timestamptz,
    ended_at timestamptz
  )`,
  `create unique index if not exists run_steps_run_seq_idx on run_steps (run_id, seq)`,
  `create table if not exists tool_calls (
    id text primary key,
    run_id text not null references runs(id) on delete cascade,
    step_id text references run_steps(id) on delete set null,
    source_type text not null,
    tool_name text not null,
    request jsonb,
    response jsonb,
    status text not null,
    duration_ms integer,
    started_at timestamptz not null,
    ended_at timestamptz not null
  )`,
  `create index if not exists tool_calls_run_started_idx on tool_calls (run_id, started_at)`,
  `create index if not exists tool_calls_source_name_started_idx on tool_calls (source_type, tool_name, started_at desc)`,
  `create table if not exists hook_runs (
    id text primary key,
    run_id text not null references runs(id) on delete cascade,
    hook_name text not null,
    event_name text not null,
    capabilities jsonb not null,
    patch jsonb,
    status text not null,
    started_at timestamptz not null,
    ended_at timestamptz not null,
    error_message text
  )`,
  `create index if not exists hook_runs_run_started_idx on hook_runs (run_id, started_at)`,
  `create index if not exists hook_runs_hook_event_started_idx on hook_runs (hook_name, event_name, started_at desc)`,
  `create table if not exists artifacts (
    id text primary key,
    run_id text not null references runs(id) on delete cascade,
    type text not null,
    path text,
    content_ref text,
    metadata jsonb,
    created_at timestamptz not null
  )`,
  `create index if not exists artifacts_run_created_idx on artifacts (run_id, created_at desc)`,
  `create table if not exists history_events (
    id integer generated always as identity primary key,
    workspace_id text not null references workspaces(id) on delete cascade,
    entity_type text not null,
    entity_id text not null,
    op text not null,
    payload jsonb not null,
    occurred_at timestamptz not null
  )`,
  `create index if not exists history_events_workspace_id_idx on history_events (workspace_id, id)`,
  `create index if not exists history_events_workspace_occurred_idx on history_events (workspace_id, occurred_at desc)`,
  `do $$
  begin
    if to_regclass('public.archives') is null and to_regclass('public.workspace_archives') is not null then
      alter table workspace_archives rename to archives;
    end if;
  end
  $$`,
  `do $$
  begin
    if to_regclass('public.workspace_archives_workspace_id_idx') is not null and to_regclass('public.archives_workspace_id_idx') is null then
      alter index workspace_archives_workspace_id_idx rename to archives_workspace_id_idx;
    end if;
    if to_regclass('public.workspace_archives_archive_date_idx') is not null and to_regclass('public.archives_archive_date_idx') is null then
      alter index workspace_archives_archive_date_idx rename to archives_archive_date_idx;
    end if;
    if to_regclass('public.workspace_archives_exported_idx') is not null and to_regclass('public.archives_exported_idx') is null then
      alter index workspace_archives_exported_idx rename to archives_exported_idx;
    end if;
  end
  $$`,
  `create table if not exists archives (
    id text primary key,
    workspace_id text not null,
    scope_type text not null,
    scope_id text not null,
    archive_date text not null,
    archived_at timestamptz not null,
    deleted_at timestamptz not null,
    timezone text not null,
    exported_at timestamptz,
    export_path text,
    workspace jsonb not null,
    sessions jsonb not null,
    runs jsonb not null,
    messages jsonb not null,
    runtime_messages jsonb not null,
    run_steps jsonb not null,
    tool_calls jsonb not null,
    hook_runs jsonb not null,
    artifacts jsonb not null
  )`,
  `alter table archives add column if not exists scope_type text`,
  `alter table archives add column if not exists scope_id text`,
  `update archives set scope_type = 'workspace' where scope_type is null`,
  `update archives set scope_id = workspace_id where scope_id is null`,
  `alter table archives alter column scope_type set not null`,
  `alter table archives alter column scope_id set not null`,
  `create index if not exists archives_workspace_id_idx on archives (workspace_id, archived_at desc)`,
  `create index if not exists archives_scope_idx on archives (scope_type, scope_id, archived_at desc)`,
  `create index if not exists archives_archive_date_idx on archives (archive_date asc, archived_at asc)`,
  `create index if not exists archives_exported_idx on archives (exported_at asc nulls first, archive_date asc)`,
  `create table if not exists session_events (
    id text primary key,
    cursor integer not null,
    session_id text not null references sessions(id) on delete cascade,
    run_id text references runs(id) on delete cascade,
    event text not null,
    data jsonb not null,
    created_at timestamptz not null
  )`,
  `create unique index if not exists session_events_session_cursor_idx on session_events (session_id, cursor)`,
  `create index if not exists session_events_session_run_cursor_idx on session_events (session_id, run_id, cursor)`
];

async function normalizePostgresPersistedData(queryable: SqlQueryable): Promise<void> {
  const messageResult = await queryable.query(
    "select id, session_id, run_id, role, content, metadata, created_at from messages order by session_id asc, created_at asc, id asc"
  );
  const messagesBySession = new Map<string, Message[]>();

  for (const row of messageResult.rows) {
    if (typeof row.id !== "string" || typeof row.session_id !== "string" || typeof row.role !== "string" || typeof row.created_at !== "string") {
      continue;
    }

    const message = createMessage({
      id: row.id,
      sessionId: row.session_id,
      runId: typeof row.run_id === "string" ? row.run_id : undefined,
      role: row.role,
      content: row.content,
      metadata: row.metadata,
      createdAt: row.created_at
    });

    const existing = messagesBySession.get(message.sessionId);
    if (existing) {
      existing.push(message);
    } else {
      messagesBySession.set(message.sessionId, [message]);
    }
  }

  for (const [sessionId, messages] of messagesBySession.entries()) {
    const normalized = normalizePersistedMessages(messages);
    if (!normalized.changed) {
      continue;
    }

    await queryable.query("delete from messages where session_id = $1", [sessionId]);
    for (const message of normalized.messages) {
      await queryable.query(
        "insert into messages (id, session_id, run_id, role, content, metadata, created_at) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)",
        [
          message.id,
          message.sessionId,
          message.runId ?? null,
          message.role,
          message.content,
          message.metadata ?? null,
          message.createdAt
        ]
      );
    }
  }

  const runStepResult = await queryable.query(
    "select id, run_id, seq, step_type, name, agent_name, status, input, output, started_at, ended_at from run_steps"
  );
  for (const row of runStepResult.rows) {
    if (
      typeof row.id !== "string" ||
      typeof row.run_id !== "string" ||
      typeof row.seq !== "number" ||
      typeof row.step_type !== "string" ||
      typeof row.status !== "string"
    ) {
      continue;
    }

    const step: RunStep = {
      id: row.id,
      runId: row.run_id,
      seq: row.seq,
      stepType: row.step_type as RunStep["stepType"],
      status: row.status as RunStep["status"],
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(typeof row.agent_name === "string" ? { agentName: row.agent_name } : {}),
      ...(row.input !== undefined && row.input !== null ? { input: row.input } : {}),
      ...(row.output !== undefined && row.output !== null ? { output: row.output } : {}),
      ...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
      ...(typeof row.ended_at === "string" ? { endedAt: row.ended_at } : {})
    };

    const normalized = normalizePersistedRunStep(step);
    if (!normalized.changed) {
      continue;
    }

    await queryable.query("update run_steps set input = $2::jsonb, output = $3::jsonb where id = $1", [
      normalized.step.id,
      normalized.step.input ?? null,
      normalized.step.output ?? null
    ]);
  }

  const historyResult = await queryable.query("select id, entity_type, payload from history_events");
  for (const row of historyResult.rows) {
    if (typeof row.id !== "number" || typeof row.entity_type !== "string") {
      continue;
    }

    if (row.entity_type === "message" && isRecord(row.payload)) {
      const role = isMessageRole(row.payload.role) ? row.payload.role : "assistant";
      const normalized = normalizePersistedMessageRecord({
        id: String(row.payload.id ?? ""),
        sessionId: String(row.payload.sessionId ?? ""),
        runId: typeof row.payload.runId === "string" ? row.payload.runId : undefined,
        role,
        content: row.payload.content as Message["content"],
        ...(isRecord(row.payload.metadata) ? { metadata: row.payload.metadata } : {}),
        createdAt: String(row.payload.createdAt ?? "")
      } as Message);
      if (normalized.changed) {
        await queryable.query("update history_events set payload = $2::jsonb where id = $1", [row.id, normalized.message]);
      }
      continue;
    }

    if (row.entity_type === "run_step" && isRecord(row.payload)) {
      const normalized = normalizePersistedRunStep({
        id: String(row.payload.id ?? ""),
        runId: String(row.payload.runId ?? ""),
        seq: typeof row.payload.seq === "number" ? row.payload.seq : 0,
        stepType: row.payload.stepType as RunStep["stepType"],
        status: row.payload.status as RunStep["status"],
        ...(typeof row.payload.name === "string" ? { name: row.payload.name } : {}),
        ...(typeof row.payload.agentName === "string" ? { agentName: row.payload.agentName } : {}),
        ...(row.payload.input !== undefined ? { input: row.payload.input } : {}),
        ...(row.payload.output !== undefined ? { output: row.payload.output } : {}),
        ...(typeof row.payload.startedAt === "string" ? { startedAt: row.payload.startedAt } : {}),
        ...(typeof row.payload.endedAt === "string" ? { endedAt: row.payload.endedAt } : {})
      });
      if (normalized.changed) {
        await queryable.query("update history_events set payload = $2::jsonb where id = $1", [row.id, normalized.step]);
      }
    }
  }
}

export async function ensurePostgresSchema(pool: Pool): Promise<void> {
  if (typeof pool.connect === "function") {
    const client = await pool.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [schemaLockKey]);
      for (const statement of schemaStatements) {
        await client.query(statement);
      }
      await normalizePostgresPersistedData(client as SqlQueryable);
    } finally {
      try {
        await client.query("select pg_advisory_unlock($1)", [schemaLockKey]);
      } finally {
        client.release();
      }
    }

    return;
  }

  for (const statement of schemaStatements) {
    await pool.query(statement);
  }

  await normalizePostgresPersistedData(pool as SqlQueryable);
}
