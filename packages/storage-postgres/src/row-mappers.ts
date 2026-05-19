import { readFileSync } from "node:fs";

import type {
  ArtifactRecord,
  AgentTaskNotificationRecord,
  AgentTaskRecord,
  HistoryEventEntityType,
  HistoryEventOperation,
  HistoryEventRecord,
  HookRunAuditRecord,
  Message,
  EngineMessage,
  Run,
  RunStep,
  Session,
  SessionCurrentStateRecord,
  SessionEvent,
  ToolCallAuditRecord,
  WorkspaceArchiveRecord,
  WorkspaceRecord
} from "@oah/engine-core";
import { isMessageContentForRole, isMessageMode, isMessageOrigin, isMessageRole, isEngineMessageKind } from "@oah/engine-core";
import { eq } from "drizzle-orm";
import type { OahExecutor } from "./schema.js";
import {
  archives,
  agentTaskNotifications,
  artifacts,
  agentTasks,
  historyEvents,
  hookRuns,
  messages,
  runSteps,
  runs,
  engineMessages,
  sessionEvents,
  sessionCurrentState,
  sessions,
  toolCalls,
  workspaces
} from "./schema.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMessage(input: {
  id: string;
  sessionId: string;
  runId?: string | undefined;
  origin?: unknown;
  mode?: unknown;
  role: unknown;
  content: unknown;
  metadata?: unknown;
  createdAt: string;
}): Message {
  const role: Message["role"] = isMessageRole(input.role) ? input.role : "assistant";
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const origin = isMessageOrigin(input.origin)
    ? input.origin
    : isMessageOrigin(metadata?.origin)
      ? metadata.origin
      : metadata?.taskNotification === true
        ? "engine"
        : undefined;
  const mode = isMessageMode(input.mode)
    ? input.mode
    : isMessageMode(metadata?.mode)
      ? metadata.mode
      : metadata?.taskNotification === true
        ? "task-notification"
        : undefined;
  const base = {
    id: input.id,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(origin ? { origin } : {}),
    ...(mode ? { mode } : {}),
    ...(metadata ? { metadata } : {}),
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

export function nonNull<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

export function expectRow<T>(value: T | undefined, label: string): T {
  if (!value) {
    throw new Error(`Expected row for ${label}.`);
  }

  return value;
}

export function normalizeTimestamp(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

export function buildWorkspaceRow(input: WorkspaceRecord) {
  return {
    id: input.id,
    externalRef: input.externalRef ?? null,
    ownerId: input.ownerId ?? null,
    serviceName: input.serviceName ?? null,
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

export function toWorkspaceRecord(row: typeof workspaces.$inferSelect): WorkspaceRecord {
  const toolServers = row.toolServers ?? {};
  const runtime = typeof row.settings?.runtime === "string" && row.settings.runtime.trim() ? row.settings.runtime : undefined;

  return {
    id: row.id,
    ...(row.externalRef ? { externalRef: row.externalRef } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    ...(row.serviceName ? { serviceName: row.serviceName } : {}),
    name: row.name,
    ...(runtime ? { runtime } : {}),
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

export function buildSessionRow(input: Session) {
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

export function toSession(row: typeof sessions.$inferSelect): Session {
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

export function buildMessageRow(input: Message) {
  const metadata =
    input.metadata || input.origin || input.mode
      ? {
          ...(input.metadata ?? {}),
          ...(input.origin ? { origin: input.origin } : {}),
          ...(input.mode ? { mode: input.mode } : {})
        }
      : null;

  return {
    id: input.id,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    role: input.role,
    content: input.content,
    metadata,
    createdAt: input.createdAt
  };
}

export function toMessage(row: typeof messages.$inferSelect): Message {
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

export function buildEngineMessageRow(input: EngineMessage) {
  const metadata =
    input.metadata || input.origin || input.mode
      ? {
          ...(input.metadata ?? {}),
          ...(input.origin ? { origin: input.origin } : {}),
          ...(input.mode ? { mode: input.mode } : {})
        }
      : null;

  return {
    id: input.id,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    role: input.role,
    kind: input.kind,
    content: input.content,
    metadata,
    createdAt: input.createdAt
  };
}

export function toEngineMessageRecord(row: typeof engineMessages.$inferSelect): EngineMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.runId ? { runId: row.runId } : {}),
    role: isMessageRole(row.role) ? row.role : "assistant",
    ...(isRecord(row.metadata) && isMessageOrigin(row.metadata.origin) ? { origin: row.metadata.origin } : {}),
    ...(isRecord(row.metadata) && isMessageMode(row.metadata.mode) ? { mode: row.metadata.mode } : {}),
    kind: isEngineMessageKind(row.kind) ? row.kind : "assistant_text",
    content: row.content,
    ...(isRecord(row.metadata) ? { metadata: row.metadata } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  };
}

export function buildRunRow(input: Run) {
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

export function toRun(row: typeof runs.$inferSelect): Run {
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

export function buildRunStepRow(input: RunStep) {
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

export function toRunStep(row: typeof runSteps.$inferSelect): RunStep {
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

export function toSessionEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
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

export function toSessionCurrentStateRecord(row: typeof sessionCurrentState.$inferSelect): SessionCurrentStateRecord {
  return {
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    activeAgentName: row.activeAgentName,
    ...(row.modelRef ? { modelRef: row.modelRef } : {}),
    ...(row.latestRunId ? { latestRunId: row.latestRunId } : {}),
    ...(row.latestRunStatus ? { latestRunStatus: row.latestRunStatus } : {}),
    ...(row.latestRunStartedAt ? { latestRunStartedAt: normalizeTimestamp(row.latestRunStartedAt) ?? row.latestRunStartedAt } : {}),
    ...(row.latestRunEndedAt ? { latestRunEndedAt: normalizeTimestamp(row.latestRunEndedAt) ?? row.latestRunEndedAt } : {}),
    ...(row.latestRunCreatedAt ? { latestRunCreatedAt: normalizeTimestamp(row.latestRunCreatedAt) ?? row.latestRunCreatedAt } : {}),
    ...(row.latestMessageId ? { latestMessageId: row.latestMessageId } : {}),
    ...(row.latestMessageCreatedAt
      ? { latestMessageCreatedAt: normalizeTimestamp(row.latestMessageCreatedAt) ?? row.latestMessageCreatedAt }
      : {}),
    messageTotalCount: row.messageTotalCount,
    queueCount: row.queueCount,
    ...(row.eventCursor !== null ? { eventCursor: String(row.eventCursor) } : {}),
    updatedAt: normalizeTimestamp(row.updatedAt) ?? row.updatedAt
  };
}

export function buildToolCallRow(input: ToolCallAuditRecord) {
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

export function buildHookRunRow(input: HookRunAuditRecord) {
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

export function toToolCallAuditRecord(row: typeof toolCalls.$inferSelect): ToolCallAuditRecord {
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

export function toHookRunAuditRecord(row: typeof hookRuns.$inferSelect): HookRunAuditRecord {
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

export function buildArtifactRow(input: ArtifactRecord) {
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

export function toArtifactRecord(row: typeof artifacts.$inferSelect): ArtifactRecord {
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

export function buildAgentTaskRow(input: AgentTaskRecord) {
  return {
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    parentSessionId: input.parentSessionId,
    parentRunId: input.parentRunId,
    childSessionId: input.childSessionId,
    childRunId: input.childRunId,
    toolUseId: input.toolUseId ?? null,
    targetAgentName: input.targetAgentName,
    parentAgentName: input.parentAgentName,
    status: input.status,
    description: input.description ?? null,
    handoffSummary: input.handoffSummary ?? null,
    outputRef: input.outputRef,
    outputFile: input.outputFile ?? null,
    finalText: input.finalText ?? null,
    errorMessage: input.errorMessage ?? null,
    usage: input.usage ?? null,
    taskState: input.taskState ?? null,
    notifiedAt: input.notifiedAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

export function toAgentTaskRecord(row: typeof agentTasks.$inferSelect): AgentTaskRecord {
  return {
    taskId: row.taskId,
    workspaceId: row.workspaceId,
    parentSessionId: row.parentSessionId,
    parentRunId: row.parentRunId,
    childSessionId: row.childSessionId,
    childRunId: row.childRunId,
    ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
    targetAgentName: row.targetAgentName,
    parentAgentName: row.parentAgentName,
    status: row.status as AgentTaskRecord["status"],
    ...(row.description ? { description: row.description } : {}),
    ...(row.handoffSummary ? { handoffSummary: row.handoffSummary } : {}),
    outputRef: row.outputRef,
    ...(row.outputFile ? { outputFile: row.outputFile } : {}),
    ...(row.finalText !== null ? { finalText: row.finalText } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    ...(row.usage ? { usage: row.usage } : {}),
    ...(row.taskState ? { taskState: row.taskState } : {}),
    ...(row.notifiedAt ? { notifiedAt: normalizeTimestamp(row.notifiedAt) ?? row.notifiedAt } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    updatedAt: normalizeTimestamp(row.updatedAt) ?? row.updatedAt
  };
}

export function buildAgentTaskNotificationRow(input: AgentTaskNotificationRecord) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    parentSessionId: input.parentSessionId,
    parentRunId: input.parentRunId,
    taskId: input.taskId,
    toolUseId: input.toolUseId ?? null,
    childRunId: input.childRunId,
    childSessionId: input.childSessionId,
    updateType: input.updateType,
    content: input.content,
    metadata: input.metadata,
    status: input.status,
    createdAt: input.createdAt,
    consumedAt: input.consumedAt ?? null
  };
}

export function toAgentTaskNotificationRecord(
  row: typeof agentTaskNotifications.$inferSelect
): AgentTaskNotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentSessionId: row.parentSessionId,
    parentRunId: row.parentRunId,
    taskId: row.taskId,
    ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
    childRunId: row.childRunId,
    childSessionId: row.childSessionId,
    updateType: row.updateType as AgentTaskNotificationRecord["updateType"],
    content: row.content,
    metadata: row.metadata,
    status: row.status as AgentTaskNotificationRecord["status"],
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    ...(row.consumedAt ? { consumedAt: normalizeTimestamp(row.consumedAt) ?? row.consumedAt } : {})
  };
}

export function toHistoryEventRecord(row: typeof historyEvents.$inferSelect): HistoryEventRecord {
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

export function buildWorkspaceArchiveRow(input: WorkspaceArchiveRecord) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    archiveDate: input.archiveDate,
    archivedAt: input.archivedAt,
    deletedAt: input.deletedAt,
    timezone: input.timezone,
    exportedAt: input.exportedAt ?? null,
    exportPath: input.exportPath ?? null,
    payloadRef: input.payloadRef ?? null,
    payloadFormat: input.payloadFormat ?? null,
    payloadBytes: input.payloadBytes ?? null,
    workspace: input.workspace,
    sessions: input.sessions,
    runs: input.runs,
    messages: input.messages,
    engineMessages: input.engineMessages,
    runSteps: input.runSteps,
    toolCalls: input.toolCalls,
    hookRuns: input.hookRuns,
    artifacts: input.artifacts
  };
}

function readArchivePayload(row: typeof archives.$inferSelect): Partial<WorkspaceArchiveRecord> {
  if (!row.payloadRef || row.payloadFormat !== "json_v1") {
    return {};
  }

  const payload = JSON.parse(readFileSync(row.payloadRef, "utf8")) as Partial<WorkspaceArchiveRecord>;
  const result: Partial<WorkspaceArchiveRecord> = {};
  if (payload.workspace) {
    result.workspace = payload.workspace;
  }
  if (payload.sessions) {
    result.sessions = payload.sessions;
  }
  if (payload.runs) {
    result.runs = payload.runs;
  }
  if (payload.messages) {
    result.messages = payload.messages;
  }
  if (payload.engineMessages) {
    result.engineMessages = payload.engineMessages;
  }
  if (payload.runSteps) {
    result.runSteps = payload.runSteps;
  }
  if (payload.toolCalls) {
    result.toolCalls = payload.toolCalls;
  }
  if (payload.hookRuns) {
    result.hookRuns = payload.hookRuns;
  }
  if (payload.artifacts) {
    result.artifacts = payload.artifacts;
  }
  return result;
}

export function toWorkspaceArchiveRecord(row: typeof archives.$inferSelect): WorkspaceArchiveRecord {
  const payload = readArchivePayload(row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scopeType: row.scopeType as WorkspaceArchiveRecord["scopeType"],
    scopeId: row.scopeId,
    archiveDate: row.archiveDate,
    archivedAt: normalizeTimestamp(row.archivedAt) ?? row.archivedAt,
    deletedAt: normalizeTimestamp(row.deletedAt) ?? row.deletedAt,
    timezone: row.timezone,
    ...(row.exportedAt ? { exportedAt: normalizeTimestamp(row.exportedAt) ?? row.exportedAt } : {}),
    ...(row.exportPath ? { exportPath: row.exportPath } : {}),
    ...(row.payloadRef ? { payloadRef: row.payloadRef } : {}),
    ...(row.payloadFormat === "json_v1" ? { payloadFormat: "json_v1" as const } : {}),
    ...(row.payloadBytes !== null ? { payloadBytes: row.payloadBytes } : {}),
    workspace: payload.workspace ?? row.workspace,
    sessions: payload.sessions ?? row.sessions,
    runs: payload.runs ?? row.runs,
    messages: payload.messages ?? row.messages,
    engineMessages: payload.engineMessages ?? row.engineMessages,
    runSteps: payload.runSteps ?? row.runSteps,
    toolCalls: payload.toolCalls ?? row.toolCalls,
    hookRuns: payload.hookRuns ?? row.hookRuns,
    artifacts: payload.artifacts ?? row.artifacts
  };
}

export async function resolveWorkspaceIdForSession(db: OahExecutor, sessionId: string): Promise<string> {
  const [row] = await db.select({ workspaceId: sessions.workspaceId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return expectRow(row, `workspace for session ${sessionId}`).workspaceId;
}

export async function resolveWorkspaceIdForRun(db: OahExecutor, runId: string): Promise<string> {
  const [row] = await db.select({ workspaceId: runs.workspaceId }).from(runs).where(eq(runs.id, runId)).limit(1);
  return expectRow(row, `workspace for run ${runId}`).workspaceId;
}

export async function appendHistoryEventRecord(
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

export async function appendHistoryDeleteEvents(
  db: OahExecutor,
  workspaceId: string,
  entities: Array<{ entityType: HistoryEventEntityType; entityId: string }>,
  occurredAt: string
): Promise<void> {
  for (const entity of entities) {
    await appendHistoryEventRecord(db, {
      workspaceId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      op: "delete",
      payload: {},
      occurredAt
    });
  }
}
