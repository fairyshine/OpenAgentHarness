import type {
  ArtifactRecord,
  HookRunAuditRecord,
  HistoryEventRecord,
  Message,
  EngineMessage,
  Run,
  RunStep,
  Session,
  SessionEvent,
  ToolCallAuditRecord,
  WorkspaceArchiveRecord,
  WorkspaceRecord
} from "@oah/engine-core";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  externalRef: text("external_ref"),
  ownerId: text("owner_id"),
  serviceName: text("service_name"),
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

export const sessions = pgTable("sessions", {
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

export const runs = pgTable("runs", {
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

export const messages = pgTable("messages", {
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

export const engineMessages = pgTable("runtime_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  kind: text("kind").notNull(),
  content: jsonb("content").$type<EngineMessage["content"]>().notNull(),
  metadata: jsonb("metadata").$type<EngineMessage["metadata"]>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

export const runSteps = pgTable("run_steps", {
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

export const sessionEvents = pgTable("session_events", {
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

export const sessionPendingRuns = pgTable("session_pending_runs", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

export const toolCalls = pgTable("tool_calls", {
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

export const hookRuns = pgTable("hook_runs", {
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

export const artifacts = pgTable("artifacts", {
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

export const historyEvents = pgTable("history_events", {
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

export const archives = pgTable("archives", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  archiveDate: text("archive_date").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }).notNull(),
  timezone: text("timezone").notNull(),
  exportedAt: timestamp("exported_at", { withTimezone: true, mode: "string" }),
  exportPath: text("export_path"),
  workspace: jsonb("workspace").$type<WorkspaceArchiveRecord["workspace"]>().notNull(),
  sessions: jsonb("sessions").$type<WorkspaceArchiveRecord["sessions"]>().notNull(),
  runs: jsonb("runs").$type<WorkspaceArchiveRecord["runs"]>().notNull(),
  messages: jsonb("messages").$type<WorkspaceArchiveRecord["messages"]>().notNull(),
  engineMessages: jsonb("runtime_messages").$type<WorkspaceArchiveRecord["engineMessages"]>().notNull(),
  runSteps: jsonb("run_steps").$type<WorkspaceArchiveRecord["runSteps"]>().notNull(),
  toolCalls: jsonb("tool_calls").$type<WorkspaceArchiveRecord["toolCalls"]>().notNull(),
  hookRuns: jsonb("hook_runs").$type<WorkspaceArchiveRecord["hookRuns"]>().notNull(),
  artifacts: jsonb("artifacts").$type<WorkspaceArchiveRecord["artifacts"]>().notNull()
});

export const oahPostgresSchema = {
  workspaces,
  sessions,
  runs,
  messages,
  engineMessages,
  runSteps,
  sessionEvents,
  sessionPendingRuns,
  toolCalls,
  hookRuns,
  artifacts,
  historyEvents,
  archives
};

export type OahDatabase = NodePgDatabase<typeof oahPostgresSchema>;
export type OahTransaction = Parameters<Parameters<OahDatabase["transaction"]>[0]>[0];
export type OahExecutor = OahDatabase | OahTransaction;
