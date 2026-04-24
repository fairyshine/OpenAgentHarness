export type RunQueuePriority = "normal" | "subagent";

export interface SessionRunQueuePressure {
  readySessionCount: number;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface SessionRunQueue {
  enqueue(
    sessionId: string,
    runId: string,
    options?: {
      priority?: RunQueuePriority | undefined;
      preferredWorkerId?: string | undefined;
    }
  ): Promise<void>;
  claimNextSession(
    timeoutMs?: number,
    options?: { workerId?: string | undefined; runtimeInstanceId?: string | undefined }
  ): Promise<string | undefined>;
  readyQueueLength(): Promise<number>;
  inspectReadyQueue(nowMs?: number): Promise<{
    length: number;
    subagentLength: number;
    oldestReadyAgeMs: number;
    averageReadyAgeMs: number;
  }>;
  tryAcquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  renewSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, token: string): Promise<boolean>;
  dequeueRun(sessionId: string): Promise<string | undefined>;
  requeueSessionIfPending?(sessionId: string): Promise<boolean>;
  getSchedulingPressure?(): Promise<SessionRunQueuePressure>;
  getReadySessionCount?(): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface WorkerLeaseInput {
  workerId: string;
  runtimeInstanceId?: string | undefined;
  ownerBaseUrl?: string | undefined;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  lastSeenAt: string;
  currentSessionId?: string | undefined;
  currentRunId?: string | undefined;
  currentWorkspaceId?: string | undefined;
}

export interface WorkerRegistryEntry extends WorkerLeaseInput {
  leaseTtlMs: number;
  expiresAt: string;
  lastSeenAgeMs: number;
  health: "healthy" | "late";
}

export interface WorkerRegistry {
  heartbeat(entry: WorkerLeaseInput, ttlMs: number): Promise<void>;
  remove(workerId: string): Promise<void>;
  listActive?(nowMs?: number): Promise<WorkerRegistryEntry[]>;
}

export type WorkspacePlacementState = "unassigned" | "active" | "idle" | "draining" | "evicted";

export interface WorkspacePlacementInput {
  workspaceId: string;
  version?: string | undefined;
  ownerId?: string | undefined;
  ownerWorkerId?: string | undefined;
  ownerBaseUrl?: string | undefined;
  preferredWorkerId?: string | undefined;
  preferredWorkerReason?: "controller_target" | undefined;
  state: WorkspacePlacementState;
  sourceKind?: "object_store" | "local_directory" | undefined;
  localPath?: string | undefined;
  remotePrefix?: string | undefined;
  dirty?: boolean | undefined;
  refCount?: number | undefined;
  lastActivityAt?: string | undefined;
  materializedAt?: string | undefined;
  updatedAt: string;
}

export interface WorkspacePlacementEntry {
  workspaceId: string;
  version: string;
  ownerId?: string | undefined;
  ownerWorkerId?: string | undefined;
  ownerBaseUrl?: string | undefined;
  preferredWorkerId?: string | undefined;
  preferredWorkerReason?: "controller_target" | undefined;
  state: WorkspacePlacementState;
  sourceKind?: "object_store" | "local_directory" | undefined;
  localPath?: string | undefined;
  remotePrefix?: string | undefined;
  dirty?: boolean | undefined;
  refCount?: number | undefined;
  lastActivityAt?: string | undefined;
  materializedAt?: string | undefined;
  updatedAt: string;
}

export interface WorkspacePlacementRegistry {
  upsert(entry: WorkspacePlacementInput): Promise<void>;
  assignOwnerAffinity(
    workspaceId: string,
    ownerId: string,
    options?: { overwrite?: boolean | undefined; updatedAt?: string | undefined }
  ): Promise<void>;
  setPreferredWorker(
    workspaceId: string,
    preferredWorkerId: string,
    options?: {
      reason?: "controller_target" | undefined;
      overwrite?: boolean | undefined;
      updatedAt?: string | undefined;
    }
  ): Promise<void>;
  releaseOwnership(
    workspaceId: string,
    options?: {
      state?: WorkspacePlacementState | undefined;
      preferredWorkerId?: string | undefined;
      preferredWorkerReason?: "controller_target" | undefined;
      updatedAt?: string | undefined;
    }
  ): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<void>;
  listAll(): Promise<WorkspacePlacementEntry[]>;
  getByWorkspaceId(workspaceId: string): Promise<WorkspacePlacementEntry | undefined>;
}
