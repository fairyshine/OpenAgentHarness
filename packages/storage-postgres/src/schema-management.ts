import { type Pool } from "pg";

import type { Message, RunStep } from "@oah/engine-core";
import { isMessageRole, normalizePersistedMessageRecord, normalizePersistedMessages, normalizePersistedRunStep } from "@oah/engine-core";
import { createMessage, isRecord } from "./row-mappers.js";

interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const schemaLockKey = 20_260_401;
const persistedDataNormalizationMigrationId = "2026-05-06_normalize_persisted_message_payloads";
const DEFAULT_POSTGRES_NORMALIZATION_PAGE_SIZE = 500;
const MAX_POSTGRES_NORMALIZATION_PAGE_SIZE = 5_000;

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
  `create table if not exists agent_tasks (
    task_id text primary key,
    workspace_id text not null references workspaces(id) on delete cascade,
    parent_session_id text not null,
    parent_run_id text not null,
    child_session_id text not null,
    child_run_id text not null,
    tool_use_id text,
    target_agent_name text not null,
    parent_agent_name text not null,
    status text not null,
    description text,
    handoff_summary text,
    output_ref text not null,
    output_file text,
    final_text text,
    error_message text,
    usage jsonb,
    task_state jsonb,
    notified_at timestamptz,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `alter table agent_tasks add column if not exists tool_use_id text`,
  `alter table agent_tasks add column if not exists output_ref text`,
  `alter table agent_tasks add column if not exists output_file text`,
  `alter table agent_tasks add column if not exists final_text text`,
  `alter table agent_tasks add column if not exists error_message text`,
  `alter table agent_tasks add column if not exists usage jsonb`,
  `alter table agent_tasks add column if not exists task_state jsonb`,
  `alter table agent_tasks add column if not exists notified_at timestamptz`,
  `update agent_tasks set output_ref = 'agent-task://' || task_id || '/output' where output_ref is null`,
  `alter table agent_tasks alter column output_ref set not null`,
  `create index if not exists agent_tasks_parent_session_idx on agent_tasks (parent_session_id, created_at desc)`,
  `create index if not exists agent_tasks_child_run_idx on agent_tasks (child_run_id)`,
  `create table if not exists agent_task_notifications (
    id text primary key,
    workspace_id text not null references workspaces(id) on delete cascade,
    parent_session_id text not null,
    parent_run_id text not null,
    task_id text not null,
    tool_use_id text,
    child_run_id text not null,
    child_session_id text not null,
    update_type text not null,
    content text not null,
    metadata jsonb not null,
    status text not null,
    created_at timestamptz not null,
    consumed_at timestamptz
  )`,
  `alter table agent_task_notifications add column if not exists tool_use_id text`,
  `create index if not exists agent_task_notifications_pending_session_idx on agent_task_notifications (parent_session_id, status, created_at asc, id asc)`,
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
    payload_ref text,
    payload_format text,
    payload_bytes integer,
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
  `alter table archives add column if not exists payload_ref text`,
  `alter table archives add column if not exists payload_format text`,
  `alter table archives add column if not exists payload_bytes integer`,
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
  `create index if not exists session_events_session_run_cursor_idx on session_events (session_id, run_id, cursor)`,
  `create table if not exists session_current_state (
    session_id text primary key references sessions(id) on delete cascade,
    workspace_id text not null references workspaces(id) on delete cascade,
    active_agent_name text not null,
    model_ref text,
    latest_run_id text references runs(id) on delete set null,
    latest_run_status text,
    latest_run_started_at timestamptz,
    latest_run_ended_at timestamptz,
    latest_run_created_at timestamptz,
    latest_message_id text references messages(id) on delete set null,
    latest_message_created_at timestamptz,
    message_total_count integer not null default 0,
    queue_count integer not null default 0,
    event_cursor integer,
    updated_at timestamptz not null
  )`,
  `create index if not exists session_current_state_workspace_idx on session_current_state (workspace_id, updated_at desc)`,
  `create or replace function oah_refresh_session_current_state(target_session_id text)
  returns void
  language plpgsql
  as $$
  begin
    insert into session_current_state (
      session_id,
      workspace_id,
      active_agent_name,
      model_ref,
      latest_run_id,
      latest_run_status,
      latest_run_started_at,
      latest_run_ended_at,
      latest_run_created_at,
      latest_message_id,
      latest_message_created_at,
      message_total_count,
      queue_count,
      event_cursor,
      updated_at
    )
    select
      s.id,
      s.workspace_id,
      s.active_agent_name,
      s.model_ref,
      latest_run.id,
      latest_run.status,
      latest_run.started_at,
      latest_run.ended_at,
      latest_run.created_at,
      latest_message.id,
      latest_message.created_at,
      coalesce(message_counts.total_count, 0)::integer,
      coalesce(queue_counts.total_count, 0)::integer,
      latest_event.cursor,
      now()
    from sessions s
    left join lateral (
      select id, status, started_at, ended_at, created_at
      from runs
      where session_id = s.id
      order by created_at desc, id desc
      limit 1
    ) latest_run on true
    left join lateral (
      select id, created_at
      from messages
      where session_id = s.id
      order by created_at desc, id desc
      limit 1
    ) latest_message on true
    left join lateral (
      select count(*) as total_count
      from messages
      where session_id = s.id
    ) message_counts on true
    left join lateral (
      select count(*) as total_count
      from session_pending_runs
      where session_id = s.id
    ) queue_counts on true
    left join lateral (
      select max(cursor) as cursor
      from session_events
      where session_id = s.id
    ) latest_event on true
    where s.id = target_session_id
    on conflict (session_id) do update set
      workspace_id = excluded.workspace_id,
      active_agent_name = excluded.active_agent_name,
      model_ref = excluded.model_ref,
      latest_run_id = excluded.latest_run_id,
      latest_run_status = excluded.latest_run_status,
      latest_run_started_at = excluded.latest_run_started_at,
      latest_run_ended_at = excluded.latest_run_ended_at,
      latest_run_created_at = excluded.latest_run_created_at,
      latest_message_id = excluded.latest_message_id,
      latest_message_created_at = excluded.latest_message_created_at,
      message_total_count = excluded.message_total_count,
      queue_count = excluded.queue_count,
      event_cursor = excluded.event_cursor,
      updated_at = excluded.updated_at;
  end
  $$`,
  `create or replace function oah_refresh_session_current_state_from_session()
  returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'DELETE' then
      return old;
    end if;
    perform oah_refresh_session_current_state(new.id);
    return new;
  end
  $$`,
  `create or replace function oah_refresh_session_current_state_from_child_row()
  returns trigger
  language plpgsql
  as $$
  declare
    target_session_id text;
  begin
    if tg_op = 'DELETE' then
      target_session_id := old.session_id;
      if target_session_id is not null then
        perform oah_refresh_session_current_state(target_session_id);
      end if;
      return old;
    end if;
    target_session_id := new.session_id;
    if target_session_id is not null then
      perform oah_refresh_session_current_state(target_session_id);
    end if;
    return new;
  end
  $$`,
  `create or replace function oah_touch_session_current_state_event_cursor()
  returns trigger
  language plpgsql
  as $$
  begin
    update session_current_state
    set event_cursor = greatest(coalesce(event_cursor, -1), new.cursor),
        updated_at = now()
    where session_id = new.session_id;
    if not found then
      perform oah_refresh_session_current_state(new.session_id);
    end if;
    return new;
  end
  $$`,
  `do $$
  begin
    if not exists (select 1 from pg_trigger where tgname = 'session_current_state_sessions_refresh') then
      create trigger session_current_state_sessions_refresh
      after insert or update on sessions
      for each row execute function oah_refresh_session_current_state_from_session();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'session_current_state_messages_refresh') then
      create trigger session_current_state_messages_refresh
      after insert or update or delete on messages
      for each row execute function oah_refresh_session_current_state_from_child_row();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'session_current_state_runs_refresh') then
      create trigger session_current_state_runs_refresh
      after insert or update or delete on runs
      for each row execute function oah_refresh_session_current_state_from_child_row();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'session_current_state_queue_refresh') then
      create trigger session_current_state_queue_refresh
      after insert or update or delete on session_pending_runs
      for each row execute function oah_refresh_session_current_state_from_child_row();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'session_current_state_events_cursor') then
      create trigger session_current_state_events_cursor
      after insert on session_events
      for each row execute function oah_touch_session_current_state_event_cursor();
    end if;
  end
  $$`,
  `select oah_refresh_session_current_state(s.id)
   from sessions s
   left join session_current_state sc on sc.session_id = s.id
   where sc.session_id is null`,
  `create table if not exists oah_schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  )`
];

function resolvePostgresNormalizationPageSize(): number {
  const raw = process.env.OAH_POSTGRES_SCHEMA_NORMALIZATION_PAGE_SIZE?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POSTGRES_NORMALIZATION_PAGE_SIZE;
  }

  return Math.min(Math.floor(parsed), MAX_POSTGRES_NORMALIZATION_PAGE_SIZE);
}

async function isSchemaMigrationApplied(queryable: SqlQueryable, id: string): Promise<boolean> {
  const result = await queryable.query("select id from oah_schema_migrations where id = $1 limit 1", [id]);
  return result.rows.length > 0;
}

async function recordSchemaMigration(queryable: SqlQueryable, id: string): Promise<void> {
  await queryable.query("insert into oah_schema_migrations (id) values ($1) on conflict (id) do nothing", [id]);
}

function messageFromRow(row: Record<string, unknown>): Message | undefined {
  if (typeof row.id !== "string" || typeof row.session_id !== "string" || typeof row.role !== "string" || typeof row.created_at !== "string") {
    return undefined;
  }

  return createMessage({
    id: row.id,
    sessionId: row.session_id,
    runId: typeof row.run_id === "string" ? row.run_id : undefined,
    role: row.role,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at
  });
}

async function normalizeMessageSession(queryable: SqlQueryable, sessionId: string, messages: Message[]): Promise<void> {
  const normalized = normalizePersistedMessages(messages);
  if (!normalized.changed) {
    return;
  }

  await queryable.query("delete from messages where session_id = $1", [sessionId]);
  for (const message of normalized.messages) {
    await queryable.query(
      "insert into messages (id, session_id, run_id, role, content, metadata, created_at) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)",
      [message.id, message.sessionId, message.runId ?? null, message.role, message.content, message.metadata ?? null, message.createdAt]
    );
  }
}

async function normalizePostgresMessages(queryable: SqlQueryable, pageSize: number): Promise<void> {
  let lastSessionId: string | undefined;
  let lastCreatedAt: string | undefined;
  let lastId: string | undefined;
  let currentSessionId: string | undefined;
  let currentSessionMessages: Message[] = [];

  for (;;) {
    const result =
      lastSessionId && lastCreatedAt && lastId
        ? await queryable.query(
            `select id, session_id, run_id, role, content, metadata, created_at
             from messages
             where (session_id, created_at, id) > ($1, $2, $3)
             order by session_id asc, created_at asc, id asc
             limit $4`,
            [lastSessionId, lastCreatedAt, lastId, pageSize]
          )
        : await queryable.query(
            `select id, session_id, run_id, role, content, metadata, created_at
             from messages
             order by session_id asc, created_at asc, id asc
             limit $1`,
            [pageSize]
          );

    if (result.rows.length === 0) {
      break;
    }

    for (const row of result.rows) {
      const message = messageFromRow(row);
      if (!message) {
        continue;
      }

      if (currentSessionId && message.sessionId !== currentSessionId) {
        await normalizeMessageSession(queryable, currentSessionId, currentSessionMessages);
        currentSessionMessages = [];
      }

      currentSessionId = message.sessionId;
      currentSessionMessages.push(message);
    }

    const lastRow = result.rows.at(-1);
    if (
      typeof lastRow?.session_id !== "string" ||
      typeof lastRow.created_at !== "string" ||
      typeof lastRow.id !== "string" ||
      result.rows.length < pageSize
    ) {
      break;
    }
    lastSessionId = lastRow.session_id;
    lastCreatedAt = lastRow.created_at;
    lastId = lastRow.id;
  }

  if (currentSessionId && currentSessionMessages.length > 0) {
    await normalizeMessageSession(queryable, currentSessionId, currentSessionMessages);
  }
}

function legacyRunStepFromRow(row: Record<string, unknown>): RunStep | undefined {
  if (
    typeof row.id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.seq !== "number" ||
    typeof row.step_type !== "string" ||
    typeof row.status !== "string"
  ) {
    return undefined;
  }

  return {
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
}

async function normalizePostgresRunSteps(queryable: SqlQueryable, pageSize: number): Promise<void> {
  let lastId: string | undefined;

  for (;;) {
    const result = await queryable.query(
      lastId
        ? `select id, run_id, seq, step_type, name, agent_name, status, input, output, started_at, ended_at
           from run_steps
           where id > $1
           order by id asc
           limit $2`
        : `select id, run_id, seq, step_type, name, agent_name, status, input, output, started_at, ended_at
           from run_steps
           order by id asc
           limit $1`,
      lastId ? [lastId, pageSize] : [pageSize]
    );

    if (result.rows.length === 0) {
      break;
    }

    for (const row of result.rows) {
      const step = legacyRunStepFromRow(row);
      if (!step) {
        continue;
      }

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

    const lastRow = result.rows.at(-1);
    if (typeof lastRow?.id !== "string" || result.rows.length < pageSize) {
      break;
    }
    lastId = lastRow.id;
  }
}

async function normalizePostgresHistoryEvents(queryable: SqlQueryable, pageSize: number): Promise<void> {
  let lastId: number | undefined;

  for (;;) {
    const result = await queryable.query(
      lastId
        ? `select id, entity_type, payload
           from history_events
           where id > $1 and entity_type in ('message', 'run_step')
           order by id asc
           limit $2`
        : `select id, entity_type, payload
           from history_events
           where entity_type in ('message', 'run_step')
           order by id asc
           limit $1`,
      lastId === undefined ? [pageSize] : [lastId, pageSize]
    );

    if (result.rows.length === 0) {
      break;
    }

    for (const row of result.rows) {
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

    const lastRow = result.rows.at(-1);
    if (typeof lastRow?.id !== "number" || result.rows.length < pageSize) {
      break;
    }
    lastId = lastRow.id;
  }
}

async function normalizePostgresPersistedData(queryable: SqlQueryable): Promise<void> {
  if (await isSchemaMigrationApplied(queryable, persistedDataNormalizationMigrationId)) {
    return;
  }

  const pageSize = resolvePostgresNormalizationPageSize();
  await normalizePostgresMessages(queryable, pageSize);
  await normalizePostgresRunSteps(queryable, pageSize);
  await normalizePostgresHistoryEvents(queryable, pageSize);
  await recordSchemaMigration(queryable, persistedDataNormalizationMigrationId);
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
