import type {
  RedisRunWorkerPoolRebalanceReason,
  RedisWorkerRegistryEntry,
  RedisWorkspacePlacementEntry,
  WorkspacePlacementRegistry
} from "@oah/storage-redis-control";

import type { WorkerReplicaTargetResult } from "./scale-target.js";
import type { SandboxFleetConfig } from "./controller-config.js";

export interface StandaloneWorkerFleetSummary {
  activeReplicas: number;
  busyReplicas: number;
  activeSlots: number;
  busySlots: number;
  idleSlots: number;
  effectiveCapacityPerReplica: number;
  healthyWorkers: RedisWorkerRegistryEntry[];
}

export type ControllerRebalanceReason =
  | Exclude<RedisRunWorkerPoolRebalanceReason, "shutdown">
  | "scale_down_blocked"
  | "placement_attention";

export interface ControllerScaleDownBlocker {
  replicaId: string;
  workerIds: string[];
  ownerBaseUrl?: string | undefined;
  reason: "missing_owner_base_url" | "probe_failed" | "worker_draining" | "materialization_blocked";
  message: string;
  materializationBlockerCount?: number | undefined;
  materializationFailureCount?: number | undefined;
}

export interface ControllerScaleDownPlacementBlocker {
  reason: "missing_owner_worker" | "late_owner_worker";
  workspaceCount: number;
  workerCount: number;
  message: string;
}

export interface ControllerScaleDownGate {
  allowed: boolean;
  checkedReplicas: number;
  blockedReplicas: number;
  blockers: ControllerScaleDownBlocker[];
  placementBlockers?: ControllerScaleDownPlacementBlocker[] | undefined;
  evaluatedAt: string;
}

export interface ControllerWorkerHealth {
  draining: boolean;
  materializationBlockerCount: number;
  materializationFailureCount: number;
}

export interface ControllerDecision {
  timestamp: string;
  reason: ControllerRebalanceReason;
  suggestedReplicas: number;
  desiredReplicas: number;
  suggestedWorkers: number;
  activeReplicas: number;
  activeSlots: number;
  busySlots: number;
  scaleDownAllowed?: boolean | undefined;
  scaleDownBlockedReplicas?: number | undefined;
  readySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface ControllerSnapshot {
  running: boolean;
  minReplicas: number;
  maxReplicas: number;
  suggestedReplicas: number;
  desiredReplicas: number;
  suggestedWorkers: number;
  activeReplicas: number;
  busyReplicas: number;
  activeSlots: number;
  busySlots: number;
  idleSlots: number;
  effectiveCapacityPerReplica: number;
  readySessionsPerCapacityUnit: number;
  reservedSubagentCapacity: number;
  readySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
  lastRebalanceAt?: string | undefined;
  lastRebalanceReason?: ControllerRebalanceReason | undefined;
  scaleUpPressureStreak: number;
  scaleDownPressureStreak: number;
  scaleUpCooldownRemainingMs: number;
  scaleDownCooldownRemainingMs: number;
  sandboxFleet?: ControllerSandboxFleetSummary | undefined;
  placement?: ControllerPlacementSummary | undefined;
  placementPolicy?: ControllerPlacementPolicySummary | undefined;
  placementRecommendations?: ControllerPlacementRecommendation[] | undefined;
  placementActionPlan?: ControllerPlacementActionPlan | undefined;
  placementExecution?: ControllerPlacementExecutionReport | undefined;
  scaleDownGate?: ControllerScaleDownGate | undefined;
  scaleTarget?: WorkerReplicaTargetResult | undefined;
  recentDecisions: ControllerDecision[];
}

export interface ControllerPlacementSummary {
  totalWorkspaces: number;
  assignedOwners: number;
  unassignedOwners: number;
  ownedWorkspaces: number;
  workersWithPlacements: number;
  ownedByActiveWorkers: number;
  ownedByLateWorkers: number;
  ownedByMissingWorkers: number;
  workersWithLatePlacements: number;
  workersWithMissingPlacements: number;
  active: number;
  idle: number;
  draining: number;
  evicted: number;
  unassigned: number;
}

export interface ControllerSandboxFleetSummary {
  providerKind: SandboxFleetConfig["providerKind"];
  managedByController: boolean;
  minSandboxes: number;
  maxSandboxes: number;
  maxWorkspacesPerSandbox: number;
  ownerlessPool: SandboxFleetConfig["ownerlessPool"];
  warmEmptySandboxes: number;
  resourceCpuPressureThreshold: number;
  resourceMemoryPressureThreshold: number;
  resourceDiskPressureThreshold: number;
  observedSandboxes: number;
  healthySandboxes: number;
  pressuredSandboxes: number;
  emptySandboxes: number;
  pressureReserveSandboxes: number;
  trackedWorkspaces: number;
  ownerScopedWorkspaces: number;
  ownerlessWorkspaces: number;
  ownerGroups: number;
  ownerScopedSandboxes: number;
  ownerlessSandboxes: number;
  sharedSandboxes: number;
  logicalSandboxes: number;
  desiredSandboxes: number;
  capped: boolean;
}

export interface ControllerPlacementPolicySummary {
  attentionRequired: boolean;
  unassignedWorkspaces: number;
  missingOwnerWorkspaces: number;
  lateOwnerWorkspaces: number;
  drainingOwnerWorkspaces: number;
  ownersSpanningWorkers: number;
  maxWorkersPerOwner: number;
  sandboxesAboveWorkspaceCapacity: number;
  maxWorkspaceRefsPerSandbox: number;
}

export interface ControllerPlacementRecommendation {
  kind:
    | "assign_unassigned"
    | "recover_missing_owner"
    | "reassign_late_owner"
    | "finish_draining_owner"
    | "consolidate_owner_affinity"
    | "rebalance_workspace_capacity";
  priority: "high" | "medium";
  workspaceCount: number;
  workerCount?: number | undefined;
  ownerCount?: number | undefined;
  sampleWorkspaceIds?: string[] | undefined;
  sampleWorkerIds?: string[] | undefined;
  sampleOwnerIds?: string[] | undefined;
  message: string;
}

export interface ControllerPlacementActionItem {
  id: string;
  phase: "stabilize" | "handoff" | "optimize";
  kind: ControllerPlacementRecommendation["kind"];
  priority: ControllerPlacementRecommendation["priority"];
  blockers: string[];
  workspaceIds?: string[] | undefined;
  workerIds?: string[] | undefined;
  ownerIds?: string[] | undefined;
  summary: string;
}

export interface ControllerPlacementActionPlan {
  totalItems: number;
  highPriorityItems: number;
  nextItem?: ControllerPlacementActionItem | undefined;
  items: ControllerPlacementActionItem[];
}

export interface ControllerPlacementExecutionOperation {
  id: string;
  kind: ControllerPlacementRecommendation["kind"];
  workspaceId: string;
  ownerWorkerId?: string | undefined;
  state: RedisWorkspacePlacementEntry["state"];
  action: "release_ownership" | "set_preferred_worker";
  reason:
    | "owner_missing"
    | "owner_late"
    | "worker_draining"
    | "unassigned_workspace"
    | "owner_affinity_split"
    | "workspace_capacity_exceeded";
  targetWorkerId?: string | undefined;
  targetWorkerReasons?: string[] | undefined;
}

export interface ControllerPlacementExecutionResult extends ControllerPlacementExecutionOperation {
  status: "applied" | "skipped" | "failed";
  message: string;
}

export interface ControllerPlacementExecutionReport {
  attempted: number;
  applied: number;
  skipped: number;
  failed: number;
  operations: ControllerPlacementExecutionResult[];
}

export interface ControllerLoggedState {
  reason: ControllerRebalanceReason;
  desiredReplicas: number;
  suggestedReplicas: number;
  activeReplicas: number;
  activeSlots: number;
  busySlots: number;
  effectiveCapacityPerReplica: number;
  readySessionCount?: number | undefined;
  scaleDownAllowed?: boolean | undefined;
  scaleDownBlockedReplicas: number;
  sandboxProvider: SandboxFleetConfig["providerKind"];
  sandboxDesired: number;
  sandboxLogical: number;
  sandboxOwnerGroups: number;
  placementMissingOwners: number;
  placementLateOwners: number;
  placementOwnersSpanningWorkers: number;
  placementSandboxesAboveWorkspaceCapacity: number;
  placementRecommendations: number;
  placementActionItems: number;
  placementExecutionAttempted: number;
  placementExecutionApplied: number;
  placementExecutionSkipped: number;
  placementExecutionFailed: number;
  targetKind: string;
  targetOutcome: string;
}

export interface ControllerLogger {
  info?(message: string): void;
  warn(message: string, error?: unknown): void;
}

export type ControllerHealthProbe = (input: {
  replicaId: string;
  ownerBaseUrl: string;
  workers: RedisWorkerRegistryEntry[];
}) => Promise<ControllerWorkerHealth>;

export interface ControllerPlacementExecutor {
  execute(input: {
    timestamp: string;
    placements: RedisWorkspacePlacementEntry[];
    activeWorkers: RedisWorkerRegistryEntry[];
  }): Promise<ControllerPlacementExecutionReport | undefined>;
  close?(): Promise<void>;
}

export interface ControllerPlacementOwnershipRegistry extends WorkspacePlacementRegistry {
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
      state?: RedisWorkspacePlacementEntry["state"] | undefined;
      preferredWorkerId?: string | undefined;
      preferredWorkerReason?: "controller_target" | undefined;
      updatedAt?: string | undefined;
    }
  ): Promise<void>;
}

export interface ControllerWorkspacePlacementEntry extends RedisWorkspacePlacementEntry {
  preferredWorkerId?: string | undefined;
  preferredWorkerReason?: "controller_target" | undefined;
}
