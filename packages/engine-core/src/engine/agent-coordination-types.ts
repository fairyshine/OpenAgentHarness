import type { Message, Run, RunStep } from "@oah/api-contracts";

import type {
  AgentTaskNotificationRecord,
  AgentTaskNotificationRepository,
  AgentTaskRecord,
  AgentTaskRepository,
  MessageRepository,
  RunQueuePriority,
  RunRepository,
  RunStepRepository,
  SessionEvent,
  SessionPendingRunQueueRepository,
  SessionRepository,
  WorkspaceRecord
} from "../types.js";

export interface DelegatedRunRecord {
  childRunId: string;
  childSessionId: string;
  targetAgentName: string;
  parentAgentName: string;
  notifyParentOnCompletion?: boolean | undefined;
  toolUseId?: string | undefined;
}

export interface AwaitedRunSummary {
  run: Run;
  outputContent?: string | undefined;
}

export interface AgentTaskOutputView {
  taskId: string;
  taskType: "local_agent";
  childSessionId: string;
  childRunId: string;
  status: "pending" | "running" | "completed" | "failed" | "killed";
  description: string;
  output: string;
  prompt?: string | undefined;
  result?: string | undefined;
  error?: string | undefined;
  outputRef: string;
  outputFile?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  taskState?: AgentTaskRecord["taskState"] | undefined;
}

export interface AgentTaskOutputReadResult {
  retrievalStatus: "success" | "timeout" | "not_ready";
  task: AgentTaskOutputView | null;
}

export interface DelegatedRunMonitorState {
  notifyParentOnCompletion: boolean;
  promise?: Promise<void> | undefined;
}

export interface DelegatedNotificationBatchState {
  parentRun: Run;
  records: DelegatedRunRecord[];
  ready: boolean;
  pendingNotifications: AgentTaskNotificationRecord[];
}

export interface AgentCoordinationPersistence {
  sessions: Pick<SessionRepository, "getById" | "create" | "update">;
  messages: Pick<MessageRepository, "create" | "getById" | "update" | "listBySessionId">;
  runs: Pick<RunRepository, "create" | "getById" | "listBySessionId">;
  runSteps?: Pick<RunStepRepository, "listByRunId"> | undefined;
  agentTasks?: AgentTaskRepository | undefined;
  agentTaskNotifications?: AgentTaskNotificationRepository | undefined;
  sessionPendingRuns?: SessionPendingRunQueueRepository | undefined;
}

export interface AgentCoordinationLifecycle {
  getRun: (runId: string) => Promise<Run>;
  startRunStep: (input: {
    runId: string;
    stepType: "agent_switch" | "agent_delegate";
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }) => Promise<RunStep>;
  completeRunStep: (
    step: RunStep,
    status: "completed" | "failed" | "cancelled",
    output?: Record<string, unknown> | undefined
  ) => Promise<RunStep>;
  updateRun: (run: Run, patch: Partial<Run>) => Promise<Run>;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  enqueueRun: (sessionId: string, runId: string, options?: { priority?: RunQueuePriority | undefined }) => Promise<void>;
}

export interface AgentCoordinationHelpers {
  resolveModelForRun: (
    workspace: WorkspaceRecord,
    modelRef?: string | undefined
  ) => { canonicalModelRef: string };
  extractMessageDisplayText: (message: Message) => string;
  hasMeaningfulText: (value: string | undefined) => value is string;
  createId: (prefix: string) => string;
  nowIso: () => string;
}

export interface AgentCoordinationServiceDependencies {
  persistence: AgentCoordinationPersistence;
  lifecycle: AgentCoordinationLifecycle;
  helpers: AgentCoordinationHelpers;
}
