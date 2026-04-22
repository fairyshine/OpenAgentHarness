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
  delete(id: string): Promise<void>;
}

export interface MessageRepository {
  create(input: Message): Promise<Message>;
  getById(id: string): Promise<Message | null>;
  update(input: Message): Promise<Message>;
  listBySessionId(sessionId: string): Promise<Message[]>;
}

export interface EngineMessageRepository {
  replaceBySessionId(sessionId: string, messages: EngineMessage[]): Promise<void>;
  listBySessionId(sessionId: string): Promise<EngineMessage[]>;
}

export interface RunRepository {
  create(input: Run): Promise<Run>;
  getById(id: string): Promise<Run | null>;
  update(input: Run): Promise<Run>;
  listBySessionId(sessionId: string): Promise<Run[]>;
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
  listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]>;
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void;
}
