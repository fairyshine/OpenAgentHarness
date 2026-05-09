import type { Pool } from "pg";

function resolveServiceRoutingRegistryBackfillMode(): "auto" | "full" | "missing" | "none" {
  const raw = process.env.OAH_SERVICE_ROUTING_REGISTRY_BACKFILL?.trim().toLowerCase();
  if (raw === "full" || raw === "missing" || raw === "none" || raw === "auto") {
    return raw;
  }

  return "auto";
}

export async function ensureServiceRoutingRegistrySchema(pool: Pool): Promise<void> {
  const statements = [
    `create table if not exists workspace_registry (
      workspace_id text primary key,
      service_name text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )`,
    `create index if not exists workspace_registry_service_name_idx on workspace_registry (service_name)`,
    `create index if not exists workspace_registry_updated_idx on workspace_registry (updated_at desc, created_at desc, workspace_id asc)`,
    `create table if not exists session_registry (
      id text primary key,
      workspace_id text not null,
      parent_session_id text,
      service_name text,
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
    `alter table session_registry add column if not exists parent_session_id text`,
    `create index if not exists session_registry_workspace_idx on session_registry (workspace_id, updated_at desc, created_at desc, id asc)`,
    `create index if not exists session_registry_parent_session_idx on session_registry (parent_session_id, updated_at desc, created_at desc, id asc)`,
    `create index if not exists session_registry_service_name_idx on session_registry (service_name)`,
    `create table if not exists run_registry (
      id text primary key,
      workspace_id text not null,
      session_id text,
      service_name text,
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
    `create index if not exists run_registry_session_idx on run_registry (session_id, created_at desc, id desc)`,
    `create index if not exists run_registry_workspace_idx on run_registry (workspace_id, created_at desc, id desc)`,
    `create index if not exists run_registry_recoverable_idx on run_registry (status, heartbeat_at, started_at, created_at)`
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }
}

export async function migrateServiceRoutingRegistry(pool: Pool): Promise<void> {
  const backfillMode = resolveServiceRoutingRegistryBackfillMode();
  const upsertExistingRows = backfillMode === "full";
  const insertMissingRowsOnly = !upsertExistingRows;
  await pool.query(
    `insert into workspace_registry (workspace_id, service_name, created_at, updated_at)
     select
       w.id,
       nullif(lower(btrim(w.service_name)), ''),
       w.created_at,
       w.updated_at
     from workspaces w
     on conflict (workspace_id) do update set
       service_name = excluded.service_name,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`
  );

  if (backfillMode === "none") {
    await pool.query(`delete from workspaces where nullif(lower(btrim(service_name)), '') is not null`);
    return;
  }

  const shouldBackfillSessions =
    backfillMode === "full" ||
    backfillMode === "missing" ||
    !(await pool.query(`select exists(select 1 from session_registry limit 1) as exists`)).rows[0]?.exists;
  const shouldBackfillRuns =
    backfillMode === "full" ||
    backfillMode === "missing" ||
    !(await pool.query(`select exists(select 1 from run_registry limit 1) as exists`)).rows[0]?.exists;

  const sessionConflictClause = upsertExistingRows
    ? `do update set
       workspace_id = excluded.workspace_id,
       parent_session_id = excluded.parent_session_id,
       service_name = excluded.service_name,
       subject_ref = excluded.subject_ref,
       model_ref = excluded.model_ref,
       agent_name = excluded.agent_name,
       active_agent_name = excluded.active_agent_name,
       title = excluded.title,
       status = excluded.status,
       last_run_at = excluded.last_run_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`
    : "do nothing";
  const runConflictClause = upsertExistingRows
    ? `do update set
       workspace_id = excluded.workspace_id,
       session_id = excluded.session_id,
       service_name = excluded.service_name,
       parent_run_id = excluded.parent_run_id,
       initiator_ref = excluded.initiator_ref,
       trigger_type = excluded.trigger_type,
       trigger_ref = excluded.trigger_ref,
       agent_name = excluded.agent_name,
       effective_agent_name = excluded.effective_agent_name,
       switch_count = excluded.switch_count,
       status = excluded.status,
       cancel_requested_at = excluded.cancel_requested_at,
       started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at,
       ended_at = excluded.ended_at,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       metadata = excluded.metadata,
       created_at = excluded.created_at`
    : "do nothing";

  if (shouldBackfillSessions) {
    await pool.query(
      `insert into session_registry (
       id,
       workspace_id,
       parent_session_id,
       service_name,
       subject_ref,
       model_ref,
       agent_name,
       active_agent_name,
       title,
       status,
       last_run_at,
       created_at,
       updated_at
     )
     select
       s.id,
       s.workspace_id,
       s.parent_session_id,
       nullif(lower(btrim(w.service_name)), ''),
       s.subject_ref,
       s.model_ref,
       s.agent_name,
       s.active_agent_name,
       s.title,
       s.status,
       s.last_run_at,
       s.created_at,
       s.updated_at
     from sessions s
     join workspaces w on w.id = s.workspace_id
     ${insertMissingRowsOnly ? "where not exists (select 1 from session_registry sr where sr.id = s.id)" : ""}
     on conflict (id) ${sessionConflictClause}`
    );
  }

  await pool.query(
    `update session_registry sr
     set parent_session_id = s.parent_session_id
     from sessions s
     where sr.id = s.id
       and sr.parent_session_id is distinct from s.parent_session_id`
  );

  if (shouldBackfillRuns) {
    await pool.query(
      `insert into run_registry (
       id,
       workspace_id,
       session_id,
       service_name,
       parent_run_id,
       initiator_ref,
       trigger_type,
       trigger_ref,
       agent_name,
       effective_agent_name,
       switch_count,
       status,
       cancel_requested_at,
       started_at,
       heartbeat_at,
       ended_at,
       error_code,
       error_message,
       metadata,
       created_at
     )
     select
       r.id,
       r.workspace_id,
       r.session_id,
       nullif(lower(btrim(w.service_name)), ''),
       r.parent_run_id,
       r.initiator_ref,
       r.trigger_type,
       r.trigger_ref,
       r.agent_name,
       r.effective_agent_name,
       r.switch_count,
       r.status,
       r.cancel_requested_at,
       r.started_at,
       r.heartbeat_at,
       r.ended_at,
       r.error_code,
       r.error_message,
       r.metadata,
       r.created_at
     from runs r
     join workspaces w on w.id = r.workspace_id
     ${insertMissingRowsOnly ? "where not exists (select 1 from run_registry rr where rr.id = r.id)" : ""}
     on conflict (id) ${runConflictClause}`
    );
  }

  await pool.query(`delete from workspaces where nullif(lower(btrim(service_name)), '') is not null`);
}
