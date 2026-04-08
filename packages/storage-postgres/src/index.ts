import { Pool, type PoolConfig } from "pg";

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

import type {
  ArtifactRecord,
  ArtifactRepository,
  HookRunAuditRecord,
  HookRunAuditRepository,
  HistoryEventEntityType,
  HistoryEventOperation,
  HistoryEventRecord,
  HistoryEventRepository,
  Message,
  Run,
  RunStep,
  Session,
  SessionEvent,
  SessionEventStore,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceRecord,
  WorkspaceRepository,
  SessionRepository,
  MessageRepository,
  RunRepository,
  RunStepRepository
} from "@oah/runtime-core";
import {
  AppError,
  createId,
  isMessageContentForRole,
  isMessageRole,
  normalizePersistedMessageRecord,
  normalizePersistedMessages,
  normalizePersistedRunStep,
  nowIso,
  parseCursor
} from "@oah/runtime-core";

interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createMessage(input: {
  id: string;
  sessionId: string;
  runId?: string | undefined;
  role: unknown;
  content: unknown;
  metadata?: unknown;
  createdAt: string;
}): Message {
  const role: Message["role"] = isMessageRole(input.role) ? input.role : "assistant";
  const base = {
    id: input.id,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    createdAt: input.createdAt
  };

  switch (role) {
    case "system":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : ""
      };
    case "user":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : ""
      };
    case "assistant":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : ""
      };
    case "tool":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : []
      };
  }
}

const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  externalRef: text("external_ref"),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  executionPolicy: text("execution_policy").notNull(),
  status: text("status").notNull(),
  kind: text("kind").notNull(),
  readOnly: boolean("read_only").notNull(),
  historyMirrorEnabled: boolean("history_mirror_enabled").notNull(),
  defaultAgent: text("default_agent"),
  projectAgentsMd: text("project_agents_md"),
  settings: jsonb("settings").$type<WorkspaceRecord["settings"]>().notNull(),
  workspaceModels: jsonb("workspace_models").$type<WorkspaceRecord["workspaceModels"]>().notNull(),
  agents: jsonb("agents").$type<WorkspaceRecord["agents"]>().notNull(),
  actions: jsonb("actions").$type<WorkspaceRecord["actions"]>().notNull(),
  skills: jsonb("skills").$type<WorkspaceRecord["skills"]>().notNull(),
  toolServers: jsonb("mcp_servers").$type<WorkspaceRecord["toolServers"]>().notNull(),
  hooks: jsonb("hooks").$type<WorkspaceRecord["hooks"]>().notNull(),
  catalog: jsonb("catalog").$type<WorkspaceRecord["catalog"]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
});

const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  parentSessionId: text("parent_session_id"),
  subjectRef: text("subject_ref").notNull(),
  modelRef: text("model_ref"),
  agentName: text("agent_name"),
  activeAgentName: text("active_agent_name").notNull(),
  title: text("title"),
  status: text("status").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
});

const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  parentRunId: text("parent_run_id"),
  initiatorRef: text("initiator_ref"),
  triggerType: text("trigger_type").notNull(),
  triggerRef: text("trigger_ref"),
  agentName: text("agent_name"),
  effectiveAgentName: text("effective_agent_name").notNull(),
  switchCount: integer("switch_count"),
  status: text("status").notNull(),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true, mode: "string" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "string" }),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata").$type<Run["metadata"]>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: jsonb("content").$type<Message["content"]>().notNull(),
  metadata: jsonb("metadata").$type<Message["metadata"]>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

const runSteps = pgTable("run_steps", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  stepType: text("step_type").notNull(),
  name: text("name"),
  agentName: text("agent_name"),
  status: text("status").notNull(),
  input: jsonb("input").$type<RunStep["input"]>(),
  output: jsonb("output").$type<RunStep["output"]>(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" })
});

const sessionEvents = pgTable("session_events", {
  id: text("id").primaryKey(),
  cursor: integer("cursor").notNull(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  data: jsonb("data").$type<SessionEvent["data"]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

const toolCalls = pgTable("tool_calls", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  stepId: text("step_id").references(() => runSteps.id, { onDelete: "set null" }),
  sourceType: text("source_type").notNull(),
  toolName: text("tool_name").notNull(),
  request: jsonb("request").$type<ToolCallAuditRecord["request"]>(),
  response: jsonb("response").$type<ToolCallAuditRecord["response"]>(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }).notNull()
});

const hookRuns = pgTable("hook_runs", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  hookName: text("hook_name").notNull(),
  eventName: text("event_name").notNull(),
  capabilities: jsonb("capabilities").$type<HookRunAuditRecord["capabilities"]>().notNull(),
  patch: jsonb("patch").$type<HookRunAuditRecord["patch"]>(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }).notNull(),
  errorMessage: text("error_message")
});

const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  path: text("path"),
  contentRef: text("content_ref"),
  metadata: jsonb("metadata").$type<ArtifactRecord["metadata"]>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

const historyEvents = pgTable("history_events", {
  id: serial("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  op: text("op").notNull(),
  payload: jsonb("payload").$type<HistoryEventRecord["payload"]>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull()
});

type OahDatabase = NodePgDatabase<{
  workspaces: typeof workspaces;
  sessions: typeof sessions;
  runs: typeof runs;
  messages: typeof messages;
  runSteps: typeof runSteps;
  sessionEvents: typeof sessionEvents;
  toolCalls: typeof toolCalls;
  hookRuns: typeof hookRuns;
  artifacts: typeof artifacts;
  historyEvents: typeof historyEvents;
}>;

type OahTransaction = Parameters<Parameters<OahDatabase["transaction"]>[0]>[0];
type OahExecutor = OahDatabase | OahTransaction;

function nonNull<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function expectRow<T>(value: T | undefined, label: string): T {
  if (!value) {
    throw new Error(`Expected row for ${label}.`);
  }

  return value;
}

function normalizeTimestamp(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

function buildWorkspaceRow(input: WorkspaceRecord) {
  return {
    id: input.id,
    externalRef: input.externalRef ?? null,
    name: input.name,
    rootPath: input.rootPath,
    executionPolicy: input.executionPolicy,
    status: input.status,
    kind: input.kind,
    readOnly: input.readOnly,
    historyMirrorEnabled: input.historyMirrorEnabled,
    defaultAgent: input.defaultAgent ?? null,
    projectAgentsMd: input.projectAgentsMd ?? null,
    settings: input.settings,
    workspaceModels: input.workspaceModels,
    agents: input.agents,
    actions: input.actions,
    skills: input.skills,
    toolServers: input.toolServers,
    hooks: input.hooks,
    catalog: input.catalog,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

function toWorkspaceRecord(row: typeof workspaces.$inferSelect): WorkspaceRecord {
  const toolServers = row.toolServers ?? {};

  return {
    id: row.id,
    ...(row.externalRef ? { externalRef: row.externalRef } : {}),
    name: row.name,
    rootPath: row.rootPath,
    executionPolicy: row.executionPolicy as WorkspaceRecord["executionPolicy"],
    status: row.status as WorkspaceRecord["status"],
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    updatedAt: normalizeTimestamp(row.updatedAt) ?? row.updatedAt,
    kind: row.kind as WorkspaceRecord["kind"],
    readOnly: row.readOnly,
    historyMirrorEnabled: row.historyMirrorEnabled,
    ...(row.defaultAgent ? { defaultAgent: row.defaultAgent } : {}),
    ...(row.projectAgentsMd ? { projectAgentsMd: row.projectAgentsMd } : {}),
    settings: row.settings,
    workspaceModels: row.workspaceModels,
    agents: row.agents,
    actions: row.actions,
    skills: row.skills,
    toolServers,
    hooks: row.hooks,
    catalog: row.catalog
  };
}

function buildSessionRow(input: Session) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    parentSessionId: input.parentSessionId ?? null,
    subjectRef: input.subjectRef,
    modelRef: input.modelRef ?? null,
    agentName: input.agentName ?? null,
    activeAgentName: input.activeAgentName,
    title: input.title ?? null,
    status: input.status,
    lastRunAt: input.lastRunAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

function toSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
    subjectRef: row.subjectRef,
    ...(row.modelRef ? { modelRef: row.modelRef } : {}),
    ...(row.agentName ? { agentName: row.agentName } : {}),
    activeAgentName: row.activeAgentName,
    ...(row.title ? { title: row.title } : {}),
    status: row.status as Session["status"],
    ...(row.lastRunAt ? { lastRunAt: normalizeTimestamp(row.lastRunAt) ?? row.lastRunAt } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    updatedAt: normalizeTimestamp(row.updatedAt) ?? row.updatedAt
  };
}

function buildMessageRow(input: Message) {
  return {
    id: input.id,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    role: input.role,
    content: input.content,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt
  };
}

function toMessage(row: typeof messages.$inferSelect): Message {
  return createMessage({
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId ?? undefined,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? undefined,
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  });
}

function buildRunRow(input: Run) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId ?? null,
    parentRunId: input.parentRunId ?? null,
    initiatorRef: input.initiatorRef ?? null,
    triggerType: input.triggerType,
    triggerRef: input.triggerRef ?? null,
    agentName: input.agentName ?? null,
    effectiveAgentName: input.effectiveAgentName,
    switchCount: input.switchCount ?? null,
    status: input.status,
    cancelRequestedAt: input.cancelRequestedAt ?? null,
    startedAt: input.startedAt ?? null,
    heartbeatAt: input.heartbeatAt ?? null,
    endedAt: input.endedAt ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt
  };
}

function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
    ...(row.initiatorRef ? { initiatorRef: row.initiatorRef } : {}),
    triggerType: row.triggerType as Run["triggerType"],
    ...(row.triggerRef ? { triggerRef: row.triggerRef } : {}),
    ...(row.agentName ? { agentName: row.agentName } : {}),
    effectiveAgentName: row.effectiveAgentName,
    ...(row.switchCount !== null ? { switchCount: row.switchCount } : {}),
    status: row.status as Run["status"],
    ...(row.cancelRequestedAt ? { cancelRequestedAt: normalizeTimestamp(row.cancelRequestedAt) ?? row.cancelRequestedAt } : {}),
    ...(row.startedAt ? { startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt } : {}),
    ...(row.heartbeatAt ? { heartbeatAt: normalizeTimestamp(row.heartbeatAt) ?? row.heartbeatAt } : {}),
    ...(row.endedAt ? { endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {})
  };
}

function buildRunStepRow(input: RunStep) {
  return {
    id: input.id,
    runId: input.runId,
    seq: input.seq,
    stepType: input.stepType,
    name: input.name ?? null,
    agentName: input.agentName ?? null,
    status: input.status,
    input: input.input ?? null,
    output: input.output ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null
  };
}

function toRunStep(row: typeof runSteps.$inferSelect): RunStep {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    stepType: row.stepType as RunStep["stepType"],
    ...(row.name ? { name: row.name } : {}),
    ...(row.agentName ? { agentName: row.agentName } : {}),
    status: row.status as RunStep["status"],
    ...(row.input ? { input: row.input } : {}),
    ...(row.output ? { output: row.output } : {}),
    ...(row.startedAt ? { startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt } : {}),
    ...(row.endedAt ? { endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt } : {})
  };
}

function toSessionEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    cursor: String(row.cursor),
    sessionId: row.sessionId,
    ...(row.runId ? { runId: row.runId } : {}),
    event: row.event as SessionEvent["event"],
    data: row.data,
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  };
}

function buildToolCallRow(input: ToolCallAuditRecord) {
  return {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId ?? null,
    sourceType: input.sourceType,
    toolName: input.toolName,
    request: input.request ?? null,
    response: input.response ?? null,
    status: input.status,
    durationMs: input.durationMs ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt
  };
}

function buildHookRunRow(input: HookRunAuditRecord) {
  return {
    id: input.id,
    runId: input.runId,
    hookName: input.hookName,
    eventName: input.eventName,
    capabilities: input.capabilities,
    patch: input.patch ?? null,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    errorMessage: input.errorMessage ?? null
  };
}

function toToolCallAuditRecord(row: typeof toolCalls.$inferSelect): ToolCallAuditRecord {
  return {
    id: row.id,
    runId: row.runId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    sourceType: row.sourceType as ToolCallAuditRecord["sourceType"],
    toolName: row.toolName,
    ...(row.request ? { request: row.request } : {}),
    ...(row.response ? { response: row.response } : {}),
    status: row.status as ToolCallAuditRecord["status"],
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt,
    endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt
  };
}

function toHookRunAuditRecord(row: typeof hookRuns.$inferSelect): HookRunAuditRecord {
  return {
    id: row.id,
    runId: row.runId,
    hookName: row.hookName,
    eventName: row.eventName,
    capabilities: row.capabilities,
    ...(row.patch ? { patch: row.patch } : {}),
    status: row.status as HookRunAuditRecord["status"],
    startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt,
    endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt,
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {})
  };
}

function buildArtifactRow(input: ArtifactRecord) {
  return {
    id: input.id,
    runId: input.runId,
    type: input.type,
    path: input.path ?? null,
    contentRef: input.contentRef ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt
  };
}

function toArtifactRecord(row: typeof artifacts.$inferSelect): ArtifactRecord {
  return {
    id: row.id,
    runId: row.runId,
    type: row.type,
    ...(row.path ? { path: row.path } : {}),
    ...(row.contentRef ? { contentRef: row.contentRef } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  };
}

function toHistoryEventRecord(row: typeof historyEvents.$inferSelect): HistoryEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityType: row.entityType as HistoryEventEntityType,
    entityId: row.entityId,
    op: row.op as HistoryEventOperation,
    payload: row.payload,
    occurredAt: normalizeTimestamp(row.occurredAt) ?? row.occurredAt
  };
}

async function resolveWorkspaceIdForSession(db: OahExecutor, sessionId: string): Promise<string> {
  const [row] = await db.select({ workspaceId: sessions.workspaceId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return expectRow(row, `workspace for session ${sessionId}`).workspaceId;
}

async function resolveWorkspaceIdForRun(db: OahExecutor, runId: string): Promise<string> {
  const [row] = await db.select({ workspaceId: runs.workspaceId }).from(runs).where(eq(runs.id, runId)).limit(1);
  return expectRow(row, `workspace for run ${runId}`).workspaceId;
}

async function appendHistoryEventRecord(
  db: OahExecutor,
  input: Omit<HistoryEventRecord, "id">
): Promise<HistoryEventRecord> {
  const [row] = await db
    .insert(historyEvents)
    .values({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      payload: input.payload,
      occurredAt: input.occurredAt
    })
    .returning();

  return toHistoryEventRecord(expectRow(row, `history event ${input.entityType}:${input.entityId}`));
}

class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const [row] = await this.db.insert(workspaces).values(buildWorkspaceRow(input)).returning();
    return toWorkspaceRecord(expectRow(row, `workspace ${input.id}`));
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const values = buildWorkspaceRow(input);
    const [row] = await this.db
      .insert(workspaces)
      .values(values)
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          externalRef: values.externalRef,
          name: values.name,
          rootPath: values.rootPath,
          executionPolicy: values.executionPolicy,
          status: values.status,
          kind: values.kind,
          readOnly: values.readOnly,
          historyMirrorEnabled: values.historyMirrorEnabled,
          defaultAgent: values.defaultAgent,
          projectAgentsMd: values.projectAgentsMd,
          settings: values.settings,
          workspaceModels: values.workspaceModels,
          agents: values.agents,
          actions: values.actions,
          skills: values.skills,
          toolServers: values.toolServers,
          hooks: values.hooks,
          catalog: values.catalog,
          updatedAt: values.updatedAt
        }
      })
      .returning();

    return toWorkspaceRecord(expectRow(row, `workspace ${input.id}`));
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return row ? toWorkspaceRecord(row) : null;
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(workspaces)
      .orderBy(sql`${workspaces.updatedAt} desc`, sql`${workspaces.createdAt} desc`, sql`${workspaces.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toWorkspaceRecord);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
  }
}

class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: Session): Promise<Session> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(sessions).values(buildSessionRow(input)).returning();
      const created = toSession(expectRow(row, `session ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: created.workspaceId,
        entityType: "session",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Session | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ? toSession(row) : null;
  }

  async update(input: Session): Promise<Session> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(sessions).set(buildSessionRow(input)).where(eq(sessions.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "session_not_found", `Session ${input.id} was not found.`);
      }

      const updated = toSession(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: updated.workspaceId,
        entityType: "session",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId))
      .orderBy(sql`${sessions.updatedAt} desc`, sql`${sessions.createdAt} desc`, sql`${sessions.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toSession);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(messages).where(eq(messages.sessionId, id));
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }
}

class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: Message): Promise<Message> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(messages).values(buildMessageRow(input)).returning();
      const created = toMessage(expectRow(row, `message ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForSession(tx, created.sessionId),
        entityType: "message",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Message | null> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return row ? toMessage(row) : null;
  }

  async update(input: Message): Promise<Message> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(messages).set(buildMessageRow(input)).where(eq(messages.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "message_not_found", `Message ${input.id} was not found.`);
      }

      const updated = toMessage(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForSession(tx, updated.sessionId),
        entityType: "message",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    return rows.map(toMessage);
  }
}

class PostgresRunRepository implements RunRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: Run): Promise<Run> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(runs).values(buildRunRow(input)).returning();
      const created = toRun(expectRow(row, `run ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: created.workspaceId,
        entityType: "run",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Run | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async update(input: Run): Promise<Run> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(runs).set(buildRunRow(input)).where(eq(runs.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "run_not_found", `Run ${input.id} was not found.`);
      }

      const updated = toRun(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: updated.workspaceId,
        entityType: "run",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listBySessionId(sessionId: string): Promise<Run[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(desc(runs.createdAt), desc(runs.id));

    return rows.map(toRun);
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["running", "waiting_tool"]),
          sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt}) <= ${staleBefore}`
        )
      )
      .orderBy(asc(sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt})`), asc(runs.id))
      .limit(Math.max(1, limit));

    return rows.map(toRun);
  }
}

class PostgresRunStepRepository implements RunStepRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: RunStep): Promise<RunStep> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(runSteps).values(buildRunStepRow(input)).returning();
      const created = toRunStep(expectRow(row, `run step ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "run_step",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async update(input: RunStep): Promise<RunStep> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(runSteps).set(buildRunStepRow(input)).where(eq(runSteps.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "run_step_not_found", `Run step ${input.id} was not found.`);
      }

      const updated = toRunStep(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, updated.runId),
        entityType: "run_step",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    const rows = await this.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
    return rows.map(toRunStep);
  }
}

class PostgresSessionEventStore implements SessionEventStore {
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();

  constructor(private readonly db: OahDatabase) {}

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.db.transaction(async (tx) => {
      const current = await tx
        .select({
          maxCursor: sql<number>`coalesce(max(${sessionEvents.cursor}), -1)`
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, input.sessionId));
      const nextCursor = nonNull(current[0]?.maxCursor, -1) + 1;
      const [row] = await tx
        .insert(sessionEvents)
        .values({
          id: createId("evt"),
          cursor: nextCursor,
          sessionId: input.sessionId,
          runId: input.runId ?? null,
          event: input.event,
          data: input.data,
          createdAt: nowIso()
        })
        .returning();

      return toSessionEvent(expectRow(row, `session event ${nextCursor}`));
    });

    for (const listener of this.#listeners.get(input.sessionId) ?? []) {
      listener(event);
    }

    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : -1;
    const normalizedCursor = Number.isFinite(parsedCursor) && parsedCursor >= -1 ? parsedCursor : -1;
    const filters = [eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.cursor, normalizedCursor)];
    if (runId) {
      filters.push(eq(sessionEvents.runId, runId));
    }

    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(...filters))
      .orderBy(asc(sessionEvents.cursor));

    return rows.map(toSessionEvent);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);

    return () => {
      const current = this.#listeners.get(sessionId);
      if (!current) {
        return;
      }

      current.delete(listener);
      if (current.size === 0) {
        this.#listeners.delete(sessionId);
      }
    };
  }
}

class PostgresToolCallAuditRepository implements ToolCallAuditRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(toolCalls).values(buildToolCallRow(input)).returning();
      const created = toToolCallAuditRecord(expectRow(row, `tool call ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "tool_call",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }
}

class PostgresHookRunAuditRepository implements HookRunAuditRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(hookRuns).values(buildHookRunRow(input)).returning();
      const created = toHookRunAuditRecord(expectRow(row, `hook run ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "hook_run",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }
}

class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(artifacts).values(buildArtifactRow(input)).returning();
      const created = toArtifactRecord(expectRow(row, `artifact ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "artifact",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async listByRunId(runId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db.select().from(artifacts).where(eq(artifacts.runId, runId)).orderBy(asc(artifacts.createdAt));
    return rows.map(toArtifactRecord);
  }
}

class PostgresHistoryEventRepository implements HistoryEventRepository {
  constructor(private readonly db: OahDatabase) {}

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    return appendHistoryEventRecord(this.db, input);
  }

  async listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const filters = [eq(historyEvents.workspaceId, workspaceId)];
    if (afterId !== undefined) {
      filters.push(gt(historyEvents.id, afterId));
    }

    const rows = await this.db
      .select()
      .from(historyEvents)
      .where(and(...filters))
      .orderBy(asc(historyEvents.id))
      .limit(limit);

    return rows.map(toHistoryEventRecord);
  }
}

export interface PostgresRuntimePersistence {
  pool: Pool;
  db: OahDatabase;
  workspaceRepository: PostgresWorkspaceRepository;
  sessionRepository: PostgresSessionRepository;
  messageRepository: PostgresMessageRepository;
  runRepository: PostgresRunRepository;
  runStepRepository: PostgresRunStepRepository;
  sessionEventStore: PostgresSessionEventStore;
  toolCallAuditRepository: PostgresToolCallAuditRepository;
  hookRunAuditRepository: PostgresHookRunAuditRepository;
  artifactRepository: PostgresArtifactRepository;
  historyEventRepository: PostgresHistoryEventRepository;
  close(): Promise<void>;
}

export interface CreatePostgresRuntimePersistenceOptions {
  connectionString?: string | undefined;
  pool?: Pool | undefined;
  poolConfig?: PoolConfig | undefined;
  ensureSchema?: boolean | undefined;
}

const schemaLockKey = 20_260_401;

const schemaStatements = [
  `create table if not exists workspaces (
    id text primary key,
    external_ref text,
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

export async function createPostgresRuntimePersistence(
  options: CreatePostgresRuntimePersistenceOptions
): Promise<PostgresRuntimePersistence> {
  const ownPool = !options.pool;
  const pool =
    options.pool ??
    new Pool({
      ...(options.connectionString ? { connectionString: options.connectionString } : {}),
      ...(options.poolConfig ?? {})
    });

  if (options.ensureSchema !== false) {
    await ensurePostgresSchema(pool);
  }

  const db = drizzle(pool, {
    schema: {
      workspaces,
      sessions,
      runs,
      messages,
      runSteps,
      sessionEvents,
      toolCalls,
      hookRuns,
      artifacts,
      historyEvents
    }
  });

  return {
    pool,
    db,
    workspaceRepository: new PostgresWorkspaceRepository(db),
    sessionRepository: new PostgresSessionRepository(db),
    messageRepository: new PostgresMessageRepository(db),
    runRepository: new PostgresRunRepository(db),
    runStepRepository: new PostgresRunStepRepository(db),
    sessionEventStore: new PostgresSessionEventStore(db),
    toolCallAuditRepository: new PostgresToolCallAuditRepository(db),
    hookRunAuditRepository: new PostgresHookRunAuditRepository(db),
    artifactRepository: new PostgresArtifactRepository(db),
    historyEventRepository: new PostgresHistoryEventRepository(db),
    async close() {
      if (ownPool) {
        await pool.end();
      }
    }
  };
}

export type {
  PostgresWorkspaceRepository,
  PostgresSessionRepository,
  PostgresMessageRepository,
  PostgresRunRepository,
  PostgresRunStepRepository,
  PostgresSessionEventStore,
  PostgresToolCallAuditRepository,
  PostgresHookRunAuditRepository,
  PostgresArtifactRepository,
  PostgresHistoryEventRepository
};
