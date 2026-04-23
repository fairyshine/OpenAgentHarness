import type {
  CompactSessionRequest,
  CreateMessageRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  Message,
  Run,
  RunStep,
  Session,
  Workspace
} from "@oah/api-contracts";

import type {
  CallerContext,
  ModelDefinition,
  ModelGateway,
  EngineLogger,
  WorkspaceActivityTracker
} from "./engine.js";
import type {
  ArtifactRepository,
  HistoryEventRepository,
  HookRunAuditRepository,
  MessageRepository,
  RunQueue,
  RunRepository,
  RunStepRepository,
  SessionPendingRunQueueRepository,
  EngineMessageRepository,
  SessionEventStore,
  SessionRepository,
  ToolCallAuditRepository,
  WorkspaceArchiveRepository,
  WorkspaceRepository
} from "./storage.js";
import type {
  WorkspaceCommandExecutor,
  WorkspaceDeletionHandler,
  WorkspaceExecutionProvider,
  WorkspaceFileAccessProvider,
  WorkspaceFileSystem,
  WorkspaceInitializer
} from "./workspace.js";
import type { EngineMessage } from "../engine/engine-messages.js";

export interface EngineServiceOptions {
  defaultModel: string;
  modelGateway: ModelGateway;
  logger?: EngineLogger | undefined;
  workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
  executionServicesMode?: "eager" | "lazy" | undefined;
  runHeartbeatIntervalMs?: number | undefined;
  staleRunRecovery?:
    | {
        strategy?: "fail" | "requeue_running" | "requeue_all" | undefined;
        maxAttempts?: number | undefined;
      }
    | undefined;
  platformModels?: Record<string, ModelDefinition> | undefined;
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  engineMessageRepository?: EngineMessageRepository | undefined;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  sessionPendingRunQueueRepository: SessionPendingRunQueueRepository;
  runQueue?: RunQueue | undefined;
  toolCallAuditRepository?: ToolCallAuditRepository | undefined;
  hookRunAuditRepository?: HookRunAuditRepository | undefined;
  artifactRepository?: ArtifactRepository | undefined;
  historyEventRepository?: HistoryEventRepository | undefined;
  workspaceArchiveRepository?: WorkspaceArchiveRepository | undefined;
  workspaceDeletionHandler?: WorkspaceDeletionHandler | undefined;
  workspaceInitializer?: WorkspaceInitializer | undefined;
  workspaceExecutionProvider?: WorkspaceExecutionProvider | undefined;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  workspaceFileSystem?: WorkspaceFileSystem | undefined;
  workspaceCommandExecutor?: WorkspaceCommandExecutor | undefined;
}

export type RunQueuePriority = "normal" | "subagent";

export interface CreateWorkspaceParams {
  input: CreateWorkspaceRequest;
}

export interface CreateSessionParams {
  workspaceId: string;
  caller: CallerContext;
  input: CreateSessionRequest;
}

export interface UpdateSessionParams {
  sessionId: string;
  input: import("@oah/api-contracts").UpdateSessionRequest;
}

export interface CreateSessionMessageParams {
  sessionId: string;
  caller: CallerContext;
  input: CreateMessageRequest;
}

export interface CompactSessionParams {
  sessionId: string;
  caller: CallerContext;
  input?: CompactSessionRequest | undefined;
}

export interface TriggerActionRunParams {
  workspaceId: string;
  caller: CallerContext;
  actionName: string;
  sessionId?: string | undefined;
  agentName?: string | undefined;
  input?: unknown;
  triggerSource?: "api" | "user" | undefined;
}

export interface CancelRunResult {
  runId: string;
  status: "cancellation_requested";
}

export interface RequeueRunResult {
  runId: string;
  status: "queued";
  previousStatus: "failed" | "timed_out";
  source: "manual_requeue";
}

export interface ActionRunAcceptedResult {
  runId: string;
  status: "queued";
  actionName: string;
  sessionId?: string | undefined;
}

export interface MessageAcceptedResult {
  messageId: string;
  runId: string;
  status: "queued";
  delivery?: "active_run" | "session_queue" | undefined;
  queuedPosition?: number | undefined;
  createdAt?: string | undefined;
}

export interface SessionQueuedRunListItem {
  runId: string;
  messageId: string;
  content: string;
  createdAt: string;
  position: number;
}

export interface SessionQueuedRunListResult {
  items: SessionQueuedRunListItem[];
}

export interface SessionCompactResult {
  runId: string;
  status: "completed";
  compacted: boolean;
  reason?: "insufficient_history" | "summary_empty" | undefined;
  boundaryMessageId?: string | undefined;
  summaryMessageId?: string | undefined;
  summarizedMessageCount?: number | undefined;
  createdAt: string;
  completedAt: string;
}

export interface GuideQueuedRunResult {
  runId: string;
  status: "interrupt_requested";
}

export interface EngineMessageListResult {
  items: EngineMessage[];
  nextCursor?: string | undefined;
}

export type MessagePageDirection = "forward" | "backward";

export interface MessageListResult {
  items: Message[];
  nextCursor?: string | undefined;
}

export interface WorkspaceListResult {
  items: Workspace[];
  nextCursor?: string | undefined;
}

export interface SessionListResult {
  items: Session[];
  nextCursor?: string | undefined;
}

export interface RunListResult {
  items: Run[];
  nextCursor?: string | undefined;
}

export interface RunStepListResult {
  items: RunStep[];
  nextCursor?: string | undefined;
}
