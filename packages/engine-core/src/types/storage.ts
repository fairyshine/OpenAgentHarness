import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import type { EngineMessage } from "../engine/engine-messages.js";
import type { SessionEvent, ToolCallSourceType } from "./engine.js";
import type { WorkspaceRecord } from "./workspace.js";

export interface ToolCallAuditRecord {
  id: string;
  runId: string;
  stepId?: string | undefined;
  sourceType: ToolCallSourceType;
  toolName: string;
  request?: Record<string, unknown> | undefined;
  response?: Record<string, unknown> | undefined;
  status: "completed" | "failed" | "cancelled";
  durationMs?: number | undefined;
  startedAt: string;
  endedAt: string;
}

export interface HookRunAuditRecord {
  id: string;
  runId: string;
  hookName: string;
  eventName: string;
  capabilities: string[];
  patch?: Record<string, unknown> | undefined;
  status: "completed" | "failed";
  startedAt: string;
  endedAt: string;
  errorMessage?: string | undefined;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  type: string;
  path?: string | undefined;
  contentRef?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface LocalAgentTaskStateRecord {
  type: "local_agent";
  agentId: string;
  prompt: string;
  agentType: string;
  model?: string | undefined;
  retrieved: boolean;
  lastReportedToolCount: number;
  lastReportedTokenCount: number;
  isBackgrounded: boolean;
  pendingMessages: string[];
  retain: boolean;
  diskLoaded: boolean;
  notified?: boolean | undefined;
  evictAfter?: number | undefined;
}

export interface AgentTaskRecord {
  taskId: string;
  workspaceId: string;
  parentSessionId: string;
  parentRunId: string;
  childSessionId: string;
  childRunId: string;
  toolUseId?: string | undefined;
  targetAgentName: string;
  parentAgentName: string;
  status: AgentTaskStatus;
  description?: string | undefined;
  handoffSummary?: string | undefined;
  outputRef: string;
  outputFile?: string | undefined;
  finalText?: string | undefined;
  errorMessage?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  taskState?: LocalAgentTaskStateRecord | undefined;
  notifiedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskNotificationRecord {
  id: string;
  workspaceId: string;
  parentSessionId: string;
  parentRunId: string;
  taskId: string;
  toolUseId?: string | undefined;
  childRunId: string;
  childSessionId: string;
  updateType: "completed" | "failed";
  content: string;
  metadata: Record<string, unknown>;
  status: "pending" | "consumed";
  createdAt: string;
  consumedAt?: string | undefined;
}

export type HistoryEventEntityType =
  | "session"
  | "message"
  | "run"
  | "run_step"
  | "tool_call"
  | "hook_run"
  | "artifact";

export type HistoryEventOperation = "upsert" | "delete" | "replace";

export interface HistoryEventRecord {
  id: number;
  workspaceId: string;
  entityType: HistoryEventEntityType;
  entityId: string;
  op: HistoryEventOperation;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface ToolCallAuditRepository {
  create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord>;
}

export interface HookRunAuditRepository {
  create(input: HookRunAuditRecord): Promise<HookRunAuditRecord>;
}

export interface ArtifactRepository {
  create(input: ArtifactRecord): Promise<ArtifactRecord>;
  listByRunId(runId: string): Promise<ArtifactRecord[]>;
}

export interface AgentTaskRepository {
  upsert(input: AgentTaskRecord): Promise<AgentTaskRecord>;
  getByTaskId(taskId: string): Promise<AgentTaskRecord | null>;
  update(input: {
    taskId: string;
    status: AgentTaskStatus;
    updatedAt: string;
    toolUseId?: string | undefined;
    outputRef?: string | undefined;
    outputFile?: string | undefined;
    finalText?: string | undefined;
    errorMessage?: string | undefined;
    usage?: Record<string, unknown> | undefined;
    taskState?: LocalAgentTaskStateRecord | undefined;
    notifiedAt?: string | undefined;
  }): Promise<AgentTaskRecord>;
}

export interface AgentTaskNotificationRepository {
  create(input: AgentTaskNotificationRecord): Promise<AgentTaskNotificationRecord>;
  listPendingBySessionId(parentSessionId: string): Promise<AgentTaskNotificationRecord[]>;
  markConsumed(input: { ids: string[]; consumedAt: string }): Promise<void>;
}

export interface HistoryEventRepository {
  append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord>;
  listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]>;
}

export interface WorkspaceArchiveRecord {
  id: string;
  workspaceId: string;
  scopeType: "workspace" | "session";
  scopeId: string;
  archiveDate: string;
  archivedAt: string;
  deletedAt: string;
  timezone: string;
  exportedAt?: string | undefined;
  exportPath?: string | undefined;
  payloadRef?: string | undefined;
  payloadFormat?: "json_v1" | undefined;
  payloadBytes?: number | undefined;
  workspace: WorkspaceRecord;
  sessions: Session[];
  runs: Run[];
  messages: Message[];
  engineMessages: EngineMessage[];
  runSteps: RunStep[];
  toolCalls: ToolCallAuditRecord[];
  hookRuns: HookRunAuditRecord[];
  artifacts: ArtifactRecord[];
}

export interface SessionPendingRunQueueEntry {
  sessionId: string;
  runId: string;
  position: number;
  createdAt: string;
}

export interface WorkspaceArchiveRepository {
  archiveWorkspace(input: {
    workspace: WorkspaceRecord;
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord>;
  archiveSessionTree(input: {
    workspace: WorkspaceRecord;
    rootSessionId: string;
    sessionIds: string[];
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord>;
  listPendingArchiveDates(beforeArchiveDate: string, limit: number): Promise<string[]>;
  listByArchiveDate(archiveDate: string): Promise<WorkspaceArchiveRecord[]>;
  forEachByArchiveDate?(
    archiveDate: string,
    visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void,
    options?: {
      pageSize?: number | undefined;
    }
  ): Promise<number>;
  markExported(ids: string[], input: { exportedAt: string; exportPath: string }): Promise<void>;
  pruneExportedBefore(beforeArchiveDate: string, limit: number): Promise<number>;
}

export interface RunQueue {
  enqueue(
    sessionId: string,
    runId: string,
    options?: {
      priority?: import("./service.js").RunQueuePriority | undefined;
      preferredWorkerId?: string | undefined;
    }
  ): Promise<void>;
}

export interface SessionPendingRunQueueRepository {
  enqueue(input: {
    sessionId: string;
    runId: string;
    createdAt: string;
  }): Promise<SessionPendingRunQueueEntry>;
  listBySessionId(sessionId: string): Promise<SessionPendingRunQueueEntry[]>;
  getByRunId(runId: string): Promise<SessionPendingRunQueueEntry | null>;
  promote(runId: string): Promise<void>;
  dequeueNext(sessionId: string): Promise<SessionPendingRunQueueEntry | null>;
  remove(runId: string): Promise<void>;
}

export interface WorkspaceRepository {
  create(input: WorkspaceRecord): Promise<WorkspaceRecord>;
  upsert(input: WorkspaceRecord): Promise<WorkspaceRecord>;
  getById(id: string): Promise<WorkspaceRecord | null>;
  list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]>;
  delete(id: string): Promise<void>;
}

export interface SessionRepository {
  create(input: Session): Promise<Session>;
  getById(id: string): Promise<Session | null>;
  update(input: Session): Promise<Session>;
  listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]>;
  listChildrenByParentSessionId(parentSessionId: string, pageSize: number, cursor?: string): Promise<Session[]>;
  delete(id: string): Promise<void>;
}

export interface MessageRepository {
  create(input: Message): Promise<Message>;
  getById(id: string): Promise<Message | null>;
  update(input: Message): Promise<Message>;
  listBySessionId(sessionId: string): Promise<Message[]>;
  listPageBySessionId(input: {
    sessionId: string;
    pageSize: number;
    cursor?: string | undefined;
    direction?: "forward" | "backward" | undefined;
  }): Promise<{
    items: Message[];
    hasMore: boolean;
  }>;
}

export interface EngineMessageRepository {
  replaceBySessionId(sessionId: string, messages: EngineMessage[]): Promise<void>;
  listBySessionId(sessionId: string): Promise<EngineMessage[]>;
}

export interface RunRepository {
  create(input: Run): Promise<Run>;
  getById(id: string): Promise<Run | null>;
  update(input: Run): Promise<Run>;
  hasActiveRunForSession(sessionId: string, excludedRunIds?: ReadonlySet<string>): Promise<boolean>;
  listBySessionId(sessionId: string): Promise<Run[]>;
  listPageBySessionId?(sessionId: string, pageSize: number, cursor?: string): Promise<Run[]>;
  listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]>;
}

export interface RunStepRepository {
  create(input: RunStep): Promise<RunStep>;
  update(input: RunStep): Promise<RunStep>;
  listByRunId(runId: string): Promise<RunStep[]>;
}

export interface SessionEventStore {
  append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent>;
  deleteById(eventId: string): Promise<void>;
  listSince(sessionId: string, cursor?: string, runId?: string, limit?: number): Promise<SessionEvent[]>;
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void;
}
