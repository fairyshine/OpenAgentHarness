import type { ServerConfig } from "@oah/config";
import {
  buildRedisWorkerAffinitySummary,
  calculateRedisWorkerPoolSuggestion,
  type RedisWorkspacePlacementEntry,
  type RedisRunWorkerPoolRebalanceReason,
  type RedisWorkerRegistryEntry,
  type SessionRunQueue,
  type SessionRunQueuePressure,
  type WorkerRegistry,
  type WorkspacePlacementRegistry
} from "@oah/storage-redis-control";

import type { WorkerReplicaTarget, WorkerReplicaTargetResult } from "./scale-target.js";

export interface StandaloneControllerConfig {
  minReplicas: number;
  maxReplicas: number;
  readySessionsPerCapacityUnit: number;
  reservedSubagentCapacity: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
}

export interface SandboxFleetConfig {
  providerKind: "embedded" | "self_hosted" | "e2b";
  managedByController: boolean;
  minCount: number;
  maxCount: number;
  maxWorkspacesPerSandbox: number;
  ownerlessPool: "shared" | "dedicated";
}

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

interface ControllerLoggedState {
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

interface ControllerWorkspacePlacementEntry extends RedisWorkspacePlacementEntry {
  preferredWorkerId?: string | undefined;
  preferredWorkerReason?: "controller_target" | undefined;
}

function placementOwnerAffinityId(placement: Pick<RedisWorkspacePlacementEntry, "ownerId">): string | undefined {
  const ownerId = placement.ownerId?.trim();
  return ownerId || undefined;
}

function readEnv(names: string | string[]): string | undefined {
  for (const name of Array.isArray(names) ? names : [names]) {
    const raw = process.env[name];
    if (raw && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return undefined;
}

function readPositiveIntEnv(names: string | string[], fallback: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(names: string | string[], fallback: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readRatioEnv(names: string | string[], fallback: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function readEnumEnv<TValue extends string>(
  names: string | string[],
  allowed: readonly TValue[],
  fallback: TValue
): TValue {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  return (allowed as readonly string[]).includes(raw) ? (raw as TValue) : fallback;
}

function appendDecision(decisions: ControllerDecision[], nextDecision: ControllerDecision, maxEntries = 8) {
  const lastDecision = decisions.at(-1);
  if (
    lastDecision &&
    lastDecision.reason === nextDecision.reason &&
    lastDecision.suggestedReplicas === nextDecision.suggestedReplicas &&
    lastDecision.desiredReplicas === nextDecision.desiredReplicas &&
    lastDecision.activeReplicas === nextDecision.activeReplicas &&
    lastDecision.activeSlots === nextDecision.activeSlots &&
    lastDecision.busySlots === nextDecision.busySlots &&
    lastDecision.scaleDownAllowed === nextDecision.scaleDownAllowed &&
    lastDecision.scaleDownBlockedReplicas === nextDecision.scaleDownBlockedReplicas &&
    lastDecision.readySessionCount === nextDecision.readySessionCount &&
    lastDecision.oldestSchedulableReadyAgeMs === nextDecision.oldestSchedulableReadyAgeMs
  ) {
    return [...decisions];
  }

  const next = [...decisions, nextDecision];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

function buildControllerLoggedState(input: {
  reason: ControllerRebalanceReason;
  desiredReplicas: number;
  suggestedReplicas: number;
  activeReplicas: number;
  activeSlots: number;
  busySlots: number;
  effectiveCapacityPerReplica: number;
  schedulingPressure?: SessionRunQueuePressure | undefined;
  scaleDownGate?: ControllerScaleDownGate | undefined;
  sandboxFleet: ControllerSandboxFleetSummary;
  placementSummary?: ControllerPlacementSummary | undefined;
  placementPolicy?: ControllerPlacementPolicySummary | undefined;
  placementRecommendations?: ControllerPlacementRecommendation[] | undefined;
  placementActionPlan?: ControllerPlacementActionPlan | undefined;
  placementExecution?: ControllerPlacementExecutionReport | undefined;
  scaleTarget?: WorkerReplicaTargetResult | undefined;
}): ControllerLoggedState {
  return {
    reason: input.reason,
    desiredReplicas: input.desiredReplicas,
    suggestedReplicas: input.suggestedReplicas,
    activeReplicas: input.activeReplicas,
    activeSlots: input.activeSlots,
    busySlots: input.busySlots,
    effectiveCapacityPerReplica: input.effectiveCapacityPerReplica,
    ...(typeof input.schedulingPressure?.readySessionCount === "number"
      ? { readySessionCount: input.schedulingPressure.readySessionCount }
      : {}),
    ...(input.scaleDownGate ? { scaleDownAllowed: input.scaleDownGate.allowed } : {}),
    scaleDownBlockedReplicas: input.scaleDownGate?.blockedReplicas ?? 0,
    sandboxProvider: input.sandboxFleet.providerKind,
    sandboxDesired: input.sandboxFleet.desiredSandboxes,
    sandboxLogical: input.sandboxFleet.logicalSandboxes,
    sandboxOwnerGroups: input.sandboxFleet.ownerGroups,
    placementMissingOwners: input.placementSummary?.ownedByMissingWorkers ?? 0,
    placementLateOwners: input.placementSummary?.ownedByLateWorkers ?? 0,
    placementOwnersSpanningWorkers: input.placementPolicy?.ownersSpanningWorkers ?? 0,
    placementSandboxesAboveWorkspaceCapacity: input.placementPolicy?.sandboxesAboveWorkspaceCapacity ?? 0,
    placementRecommendations: input.placementRecommendations?.length ?? 0,
    placementActionItems: input.placementActionPlan?.totalItems ?? 0,
    placementExecutionAttempted: input.placementExecution?.attempted ?? 0,
    placementExecutionApplied: input.placementExecution?.applied ?? 0,
    placementExecutionSkipped: input.placementExecution?.skipped ?? 0,
    placementExecutionFailed: input.placementExecution?.failed ?? 0,
    targetKind: input.scaleTarget?.kind ?? "none",
    targetOutcome: input.scaleTarget?.outcome ?? "n/a"
  };
}

function areControllerLoggedStatesEquivalent(left: ControllerLoggedState, right: ControllerLoggedState): boolean {
  return (
    left.reason === right.reason &&
    left.desiredReplicas === right.desiredReplicas &&
    left.suggestedReplicas === right.suggestedReplicas &&
    left.activeReplicas === right.activeReplicas &&
    left.activeSlots === right.activeSlots &&
    left.busySlots === right.busySlots &&
    left.effectiveCapacityPerReplica === right.effectiveCapacityPerReplica &&
    left.readySessionCount === right.readySessionCount &&
    left.scaleDownAllowed === right.scaleDownAllowed &&
    left.scaleDownBlockedReplicas === right.scaleDownBlockedReplicas &&
    left.sandboxProvider === right.sandboxProvider &&
    left.sandboxDesired === right.sandboxDesired &&
    left.sandboxLogical === right.sandboxLogical &&
    left.sandboxOwnerGroups === right.sandboxOwnerGroups &&
    left.placementMissingOwners === right.placementMissingOwners &&
    left.placementLateOwners === right.placementLateOwners &&
    left.placementOwnersSpanningWorkers === right.placementOwnersSpanningWorkers &&
    left.placementSandboxesAboveWorkspaceCapacity === right.placementSandboxesAboveWorkspaceCapacity &&
    left.placementRecommendations === right.placementRecommendations &&
    left.placementActionItems === right.placementActionItems &&
    left.placementExecutionAttempted === right.placementExecutionAttempted &&
    left.placementExecutionApplied === right.placementExecutionApplied &&
    left.placementExecutionSkipped === right.placementExecutionSkipped &&
    left.placementExecutionFailed === right.placementExecutionFailed &&
    left.targetKind === right.targetKind &&
    left.targetOutcome === right.targetOutcome
  );
}

function controllerRebalanceLogHeartbeatMs(reason: ControllerRebalanceReason, scaleIntervalMs: number): number {
  return Math.max(scaleIntervalMs, reason === "steady" ? 60_000 : 15_000);
}

function shouldLogControllerRebalance(
  lastLoggedState: ControllerLoggedState | undefined,
  lastLoggedAtMs: number | undefined,
  nextLoggedState: ControllerLoggedState,
  nowMs: number,
  scaleIntervalMs: number
): boolean {
  if (!lastLoggedState || typeof lastLoggedAtMs !== "number") {
    return true;
  }

  if (!areControllerLoggedStatesEquivalent(lastLoggedState, nextLoggedState)) {
    return true;
  }

  return nowMs - lastLoggedAtMs >= controllerRebalanceLogHeartbeatMs(nextLoggedState.reason, scaleIntervalMs);
}

function formatControllerRebalanceLog(input: ControllerLoggedState): string {
  return `[controller] rebalance=${input.reason} activeReplicas=${input.activeReplicas} desiredReplicas=${input.desiredReplicas} suggestedReplicas=${input.suggestedReplicas} activeSlots=${input.activeSlots} busySlots=${input.busySlots} effectiveCapacityPerReplica=${input.effectiveCapacityPerReplica} readySessions=${input.readySessionCount ?? "n/a"} scaleDownAllowed=${typeof input.scaleDownAllowed === "boolean" ? (input.scaleDownAllowed ? "yes" : "no") : "n/a"} scaleDownBlockedReplicas=${input.scaleDownBlockedReplicas} sandboxProvider=${input.sandboxProvider} sandboxDesired=${input.sandboxDesired} sandboxLogical=${input.sandboxLogical} sandboxOwnerGroups=${input.sandboxOwnerGroups} placementMissingOwners=${input.placementMissingOwners} placementLateOwners=${input.placementLateOwners} placementOwnersSpanningWorkers=${input.placementOwnersSpanningWorkers} placementSandboxesAboveWorkspaceCapacity=${input.placementSandboxesAboveWorkspaceCapacity} placementRecommendations=${input.placementRecommendations} placementActionItems=${input.placementActionItems} placementExecutionAttempted=${input.placementExecutionAttempted} placementExecutionApplied=${input.placementExecutionApplied} placementExecutionSkipped=${input.placementExecutionSkipped} placementExecutionFailed=${input.placementExecutionFailed} target=${input.targetKind} targetOutcome=${input.targetOutcome}`;
}

function cooldownRemainingMs(lastChangeAtMs: number | undefined, cooldownMs: number, nowMs: number): number {
  if (!lastChangeAtMs || cooldownMs <= 0) {
    return 0;
  }

  return Math.max(0, lastChangeAtMs + cooldownMs - nowMs);
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  return fallback;
}

export function resolveStandaloneControllerConfig(config: ServerConfig): StandaloneControllerConfig {
  const standalone = config.workers?.standalone;
  const controller = config.workers?.controller;
  const sandboxFleet = resolveSandboxFleetConfig(config);
  const defaultMinReplicas = standalone?.min_replicas ?? (sandboxFleet.managedByController ? sandboxFleet.minCount : 1);
  const minReplicas = readNonNegativeIntEnv("OAH_STANDALONE_WORKER_MIN_REPLICAS", defaultMinReplicas);
  const maxReplicas = Math.max(
    minReplicas,
    readPositiveIntEnv(
      "OAH_STANDALONE_WORKER_MAX_REPLICAS",
      standalone?.max_replicas ?? (sandboxFleet.managedByController ? Math.max(minReplicas, sandboxFleet.maxCount) : minReplicas)
    )
  );
  const latencyFirst = readBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false) || minReplicas === maxReplicas;

  return {
    minReplicas,
    maxReplicas,
    readySessionsPerCapacityUnit: readPositiveIntEnv(
      "OAH_STANDALONE_WORKER_READY_SESSIONS_PER_CAPACITY_UNIT",
      standalone?.ready_sessions_per_capacity_unit ?? 1
    ),
    reservedSubagentCapacity: readNonNegativeIntEnv(
      "OAH_STANDALONE_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT",
      standalone?.reserved_capacity_for_subagent ?? 1
    ),
    scaleIntervalMs: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_INTERVAL_MS",
      controller?.scale_interval_ms ?? (latencyFirst ? 1_000 : 5_000)
    ),
    scaleUpCooldownMs: readNonNegativeIntEnv(
      "OAH_CONTROLLER_SCALE_UP_COOLDOWN_MS",
      controller?.cooldown_ms ?? (latencyFirst ? 0 : 1_000)
    ),
    scaleDownCooldownMs: readNonNegativeIntEnv(
      "OAH_CONTROLLER_SCALE_DOWN_COOLDOWN_MS",
      controller?.cooldown_ms ?? (latencyFirst ? 0 : 15_000)
    ),
    scaleUpSampleSize: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_UP_SAMPLE_SIZE",
      controller?.scale_up_window ?? (latencyFirst ? 1 : 2)
    ),
    scaleDownSampleSize: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_DOWN_SAMPLE_SIZE",
      controller?.scale_down_window ?? (latencyFirst ? 1 : 3)
    ),
    scaleUpBusyRatioThreshold: readRatioEnv("OAH_CONTROLLER_SCALE_UP_BUSY_RATIO_THRESHOLD", controller?.scale_up_busy_ratio_threshold ?? 0.75),
    scaleUpMaxReadyAgeMs: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_UP_MAX_READY_AGE_MS",
      controller?.scale_up_max_ready_age_ms ?? (latencyFirst ? 500 : 2_000)
    )
  };
}

function resolveSandboxProviderKind(config: ServerConfig): SandboxFleetConfig["providerKind"] {
  const provider = config.sandbox?.provider ?? (config.sandbox?.self_hosted?.base_url?.trim() ? "self_hosted" : "embedded");
  return provider === "self_hosted" || provider === "e2b" ? provider : "embedded";
}

export function resolveSandboxFleetConfig(config: ServerConfig): SandboxFleetConfig {
  const providerKind = resolveSandboxProviderKind(config);
  const managedByController = providerKind !== "embedded";
  const configuredMinCount = config.sandbox?.fleet?.min_count;
  const configuredMaxCount = config.sandbox?.fleet?.max_count;
  const minCount = readNonNegativeIntEnv(
    "OAH_SANDBOX_FLEET_MIN_COUNT",
    configuredMinCount ?? (managedByController ? 1 : 0)
  );
  const defaultMaxCount = managedByController ? Math.max(minCount, 64) : Math.max(1, minCount);
  const maxCount = Math.max(
    minCount,
    readPositiveIntEnv("OAH_SANDBOX_FLEET_MAX_COUNT", configuredMaxCount ?? defaultMaxCount)
  );

  return {
    providerKind,
    managedByController,
    minCount,
    maxCount,
    maxWorkspacesPerSandbox: readPositiveIntEnv(
      "OAH_SANDBOX_FLEET_MAX_WORKSPACES_PER_SANDBOX",
      config.sandbox?.fleet?.max_workspaces_per_sandbox ?? 32
    ),
    ownerlessPool: readEnumEnv(
      "OAH_SANDBOX_FLEET_OWNERLESS_POOL",
      ["shared", "dedicated"],
      config.sandbox?.fleet?.ownerless_pool ?? "shared"
    )
  };
}

function effectiveCapacityPerReplica(fleet: Pick<StandaloneWorkerFleetSummary, "activeReplicas" | "activeSlots">): number {
  if (fleet.activeReplicas <= 0 || fleet.activeSlots <= 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(fleet.activeSlots / fleet.activeReplicas));
}

export function summarizeStandaloneWorkerFleet(activeWorkers: RedisWorkerRegistryEntry[]): StandaloneWorkerFleetSummary {
  const healthyStandaloneWorkers = activeWorkers.filter(
    (worker) => worker.processKind === "standalone" && worker.health === "healthy"
  );
  const replicaIds = new Set<string>();
  const busyReplicaIds = new Set<string>();

  for (const worker of healthyStandaloneWorkers) {
    const replicaId = worker.runtimeInstanceId ?? worker.workerId;
    replicaIds.add(replicaId);
    if (worker.state === "busy") {
      busyReplicaIds.add(replicaId);
    }
  }

  const activeSlots = healthyStandaloneWorkers.length;
  const busySlots = healthyStandaloneWorkers.filter((worker) => worker.state === "busy").length;

  return {
    activeReplicas: replicaIds.size,
    busyReplicas: busyReplicaIds.size,
    activeSlots,
    busySlots,
    idleSlots: Math.max(0, activeSlots - busySlots),
    effectiveCapacityPerReplica: effectiveCapacityPerReplica({
      activeReplicas: replicaIds.size,
      activeSlots
    }),
    healthyWorkers: healthyStandaloneWorkers
  };
}

function workerPlacementReference(worker: Pick<RedisWorkerRegistryEntry, "workerId" | "runtimeInstanceId">): string {
  return worker.runtimeInstanceId ?? worker.workerId;
}

export function calculateStandaloneWorkerReplicas(input: {
  config: StandaloneControllerConfig;
  activeWorkers: RedisWorkerRegistryEntry[];
  schedulingPressure?: SessionRunQueuePressure | undefined;
}): {
  fleet: StandaloneWorkerFleetSummary;
  suggestedWorkers: number;
  suggestedReplicas: number;
} {
  const fleet = summarizeStandaloneWorkerFleet(input.activeWorkers);
  const capacityPerReplica = fleet.effectiveCapacityPerReplica;
  const readySessionsPerCapacityUnit = Math.max(1, input.config.readySessionsPerCapacityUnit);
  const sizing = calculateRedisWorkerPoolSuggestion({
    minWorkers: input.config.minReplicas * capacityPerReplica,
    maxWorkers: input.config.maxReplicas * capacityPerReplica,
    readySessionsPerCapacityUnit,
    reservedSubagentCapacity: input.config.reservedSubagentCapacity,
    localActiveWorkers: fleet.activeSlots,
    localBusyWorkers: fleet.busySlots,
    scaleUpBusyRatioThreshold: input.config.scaleUpBusyRatioThreshold,
    scaleUpMaxReadyAgeMs: input.config.scaleUpMaxReadyAgeMs,
    schedulingPressure: input.schedulingPressure
  });
  const suggestedWorkers = sizing.localSuggestedWorkers;

  return {
    fleet,
    suggestedWorkers,
    suggestedReplicas: Math.max(
      input.config.minReplicas,
      Math.min(input.config.maxReplicas, Math.ceil(suggestedWorkers / capacityPerReplica))
    )
  };
}

export function summarizeWorkspacePlacements(
  placements: RedisWorkspacePlacementEntry[] | undefined,
  activeWorkers?: RedisWorkerRegistryEntry[] | undefined
): ControllerPlacementSummary | undefined {
  if (!placements || placements.length === 0) {
    return undefined;
  }

  const trackedPlacements = placements.filter((placement) => placement.state !== "evicted");
  const workerHealthById = new Map(activeWorkers?.map((worker) => [workerPlacementReference(worker), worker.health]) ?? []);
  const ownerWorkers = new Set<string>();
  const lateOwnerWorkers = new Set<string>();
  const missingOwnerWorkers = new Set<string>();
  let assignedOwners = 0;
  let active = 0;
  let idle = 0;
  let draining = 0;
  let evicted = 0;
  let unassigned = 0;
  let ownedWorkspaces = 0;
  let ownedByActiveWorkers = 0;
  let ownedByLateWorkers = 0;
  let ownedByMissingWorkers = 0;

  for (const placement of placements) {
    switch (placement.state) {
      case "active":
        active += 1;
        break;
      case "idle":
        idle += 1;
        break;
      case "draining":
        draining += 1;
        break;
      case "evicted":
        evicted += 1;
        break;
      default:
        unassigned += 1;
        break;
    }
  }

  for (const placement of trackedPlacements) {
    if (placementOwnerAffinityId(placement)) {
      assignedOwners += 1;
    }
    if (placement.ownerWorkerId) {
      ownedWorkspaces += 1;
      ownerWorkers.add(placement.ownerWorkerId);
      const health = workerHealthById.get(placement.ownerWorkerId);
      if (health === "healthy") {
        ownedByActiveWorkers += 1;
      } else if (health === "late") {
        ownedByLateWorkers += 1;
        lateOwnerWorkers.add(placement.ownerWorkerId);
      } else {
        ownedByMissingWorkers += 1;
        missingOwnerWorkers.add(placement.ownerWorkerId);
      }
    }
  }

  return {
    totalWorkspaces: trackedPlacements.length,
    assignedOwners,
    unassignedOwners: Math.max(0, trackedPlacements.length - assignedOwners),
    ownedWorkspaces,
    workersWithPlacements: ownerWorkers.size,
    ownedByActiveWorkers,
    ownedByLateWorkers,
    ownedByMissingWorkers,
    workersWithLatePlacements: lateOwnerWorkers.size,
    workersWithMissingPlacements: missingOwnerWorkers.size,
    active,
    idle,
    draining,
    evicted,
    unassigned
  };
}

export function summarizeSandboxFleet(input: {
  placements?: RedisWorkspacePlacementEntry[] | undefined;
  config: SandboxFleetConfig;
}): ControllerSandboxFleetSummary {
  const trackedPlacements = (input.placements ?? []).filter((placement) => placement.state !== "evicted");
  const ownerWorkspaceCounts = new Map<string, number>();
  let ownerlessWorkspaces = 0;

  for (const placement of trackedPlacements) {
    const ownerId = placementOwnerAffinityId(placement);
    if (ownerId) {
      ownerWorkspaceCounts.set(ownerId, (ownerWorkspaceCounts.get(ownerId) ?? 0) + 1);
    } else {
      ownerlessWorkspaces += 1;
    }
  }

  const ownerScopedWorkspaces = [...ownerWorkspaceCounts.values()].reduce((sum, count) => sum + count, 0);
  const ownerScopedSandboxes = [...ownerWorkspaceCounts.values()].reduce(
    (sum, count) => sum + Math.max(1, Math.ceil(count / input.config.maxWorkspacesPerSandbox)),
    0
  );
  const ownerlessSandboxes =
    ownerlessWorkspaces === 0
      ? 0
      : input.config.ownerlessPool === "dedicated"
        ? ownerlessWorkspaces
        : Math.ceil(ownerlessWorkspaces / input.config.maxWorkspacesPerSandbox);
  const logicalSandboxes = ownerScopedSandboxes + ownerlessSandboxes;
  const desiredSandboxes = input.config.managedByController
    ? Math.max(input.config.minCount, Math.min(input.config.maxCount, logicalSandboxes))
    : 0;

  return {
    providerKind: input.config.providerKind,
    managedByController: input.config.managedByController,
    minSandboxes: input.config.minCount,
    maxSandboxes: input.config.maxCount,
    maxWorkspacesPerSandbox: input.config.maxWorkspacesPerSandbox,
    ownerlessPool: input.config.ownerlessPool,
    trackedWorkspaces: trackedPlacements.length,
    ownerScopedWorkspaces,
    ownerlessWorkspaces,
    ownerGroups: ownerWorkspaceCounts.size,
    ownerScopedSandboxes,
    ownerlessSandboxes,
    sharedSandboxes: input.config.ownerlessPool === "shared" ? ownerlessSandboxes : 0,
    logicalSandboxes,
    desiredSandboxes,
    capped: input.config.managedByController && logicalSandboxes > input.config.maxCount
  };
}

export function summarizePlacementPolicy(input: {
  placements: RedisWorkspacePlacementEntry[] | undefined;
  activeWorkers: RedisWorkerRegistryEntry[];
  maxWorkspacesPerSandbox: number;
}): ControllerPlacementPolicySummary | undefined {
  const { placements, activeWorkers } = input;
  if (!placements || placements.length === 0) {
    return undefined;
  }

  const workerHealthById = new Map(activeWorkers.map((worker) => [workerPlacementReference(worker), worker.health]));
  const workerStateByIdByReference = new Map(activeWorkers.map((worker) => [workerPlacementReference(worker), worker.state]));
  const ownerAffinityWorkers = new Map<string, Set<string>>();
  const workerRefLoads = new Map<string, number>();
  let unassignedWorkspaces = 0;
  let missingOwnerWorkspaces = 0;
  let lateOwnerWorkspaces = 0;
  let drainingOwnerWorkspaces = 0;

  for (const placement of placements) {
    if (placement.state === "evicted") {
      continue;
    }

    if (placement.state === "unassigned" || !placement.ownerWorkerId) {
      unassignedWorkspaces += 1;
      continue;
    }

    const workerHealth = workerHealthById.get(placement.ownerWorkerId);
    if (!workerHealth) {
      missingOwnerWorkspaces += 1;
      continue;
    }
    if (workerHealth === "late") {
      lateOwnerWorkspaces += 1;
    }
    if (workerStateByIdByReference.get(placement.ownerWorkerId) === "stopping" || placement.state === "draining") {
      drainingOwnerWorkspaces += 1;
    }

    const ownerId = placementOwnerAffinityId(placement);
    if (ownerId) {
      const workers = ownerAffinityWorkers.get(ownerId) ?? new Set<string>();
      workers.add(placement.ownerWorkerId);
      ownerAffinityWorkers.set(ownerId, workers);
    }

    const refLoad =
      typeof placement.refCount === "number" ? Math.max(0, placement.refCount) : placement.state === "active" ? 1 : 0;
    workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + refLoad);
  }

  const ownerWorkerCounts = [...ownerAffinityWorkers.values()].map((workers) => workers.size);
  const maxWorkersPerOwner = ownerWorkerCounts.length > 0 ? Math.max(...ownerWorkerCounts) : 0;
  const ownersSpanningWorkers = ownerWorkerCounts.filter((count) => count > 1).length;
  const maxWorkspaceRefsPerSandbox = workerRefLoads.size > 0 ? Math.max(...workerRefLoads.values()) : 0;
  const workspaceCapacity = Math.max(1, input.maxWorkspacesPerSandbox);
  const sandboxesAboveWorkspaceCapacity = [...workerRefLoads.values()].filter((load) => load > workspaceCapacity).length;

  return {
    attentionRequired:
      unassignedWorkspaces > 0 ||
      missingOwnerWorkspaces > 0 ||
      lateOwnerWorkspaces > 0 ||
      drainingOwnerWorkspaces > 0 ||
      ownersSpanningWorkers > 0 ||
      sandboxesAboveWorkspaceCapacity > 0,
    unassignedWorkspaces,
    missingOwnerWorkspaces,
    lateOwnerWorkspaces,
    drainingOwnerWorkspaces,
    ownersSpanningWorkers,
    maxWorkersPerOwner,
    sandboxesAboveWorkspaceCapacity,
    maxWorkspaceRefsPerSandbox
  };
}

export function summarizePlacementRecommendations(input: {
  placementSummary?: ControllerPlacementSummary | undefined;
  placementPolicy?: ControllerPlacementPolicySummary | undefined;
  placements?: RedisWorkspacePlacementEntry[] | undefined;
  activeWorkers?: RedisWorkerRegistryEntry[] | undefined;
  maxWorkspacesPerSandbox?: number | undefined;
}): ControllerPlacementRecommendation[] | undefined {
  const placementSummary = input.placementSummary;
  const placementPolicy = input.placementPolicy;
  if (!placementSummary && !placementPolicy) {
    return undefined;
  }

  const placements = input.placements ?? [];
  const workerHealthById = new Map((input.activeWorkers ?? []).map((worker) => [workerPlacementReference(worker), worker.health]));
  const ownerAffinityWorkers = new Map<string, Set<string>>();
  const workerRefLoads = new Map<string, number>();
  const workspaceCapacity = Math.max(1, input.maxWorkspacesPerSandbox ?? 1);

  for (const placement of placements) {
    const ownerId = placementOwnerAffinityId(placement);
    if (ownerId && placement.ownerWorkerId && placement.state !== "evicted" && placement.state !== "unassigned") {
      const workers = ownerAffinityWorkers.get(ownerId) ?? new Set<string>();
      workers.add(placement.ownerWorkerId);
      ownerAffinityWorkers.set(ownerId, workers);
    }
    if (placement.ownerWorkerId && placement.state !== "evicted" && placement.state !== "unassigned") {
      const refLoad =
        typeof placement.refCount === "number" ? Math.max(0, placement.refCount) : placement.state === "active" ? 1 : 0;
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + refLoad);
    }
  }

  const spanningOwners = new Set(
    [...ownerAffinityWorkers.entries()].filter(([, workers]) => workers.size > 1).map(([ownerId]) => ownerId)
  );
  const overloadedWorkers = new Set(
    [...workerRefLoads.entries()].filter(([, load]) => load > workspaceCapacity).map(([workerId]) => workerId)
  );
  const sampleWorkspaceIds = (filter: (placement: RedisWorkspacePlacementEntry) => boolean) =>
    placements
      .filter(filter)
      .map((placement) => placement.workspaceId)
      .filter((value, index, items) => items.indexOf(value) === index)
      .slice(0, 5);
  const sampleWorkerIds = (filter: (placement: RedisWorkspacePlacementEntry) => boolean) =>
    placements
      .filter(filter)
      .map((placement) => placement.ownerWorkerId)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .filter((value, index, items) => items.indexOf(value) === index)
      .slice(0, 5);
  const sampleOwnerIds = (filter: (placement: RedisWorkspacePlacementEntry) => boolean) =>
    placements
      .filter(filter)
      .map((placement) => placementOwnerAffinityId(placement))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .filter((value, index, items) => items.indexOf(value) === index)
      .slice(0, 5);
  const recommendations: ControllerPlacementRecommendation[] = [];
  if ((placementPolicy?.unassignedWorkspaces ?? 0) > 0) {
    recommendations.push({
      kind: "assign_unassigned",
      priority: "high",
      workspaceCount: placementPolicy?.unassignedWorkspaces ?? 0,
      sampleWorkspaceIds: sampleWorkspaceIds((placement) => placement.state === "unassigned" || !placement.ownerWorkerId),
      message: `assign ${placementPolicy?.unassignedWorkspaces ?? 0} unassigned workspace(s) to healthy workers before new locality assumptions form`
    });
  }
  if ((placementPolicy?.missingOwnerWorkspaces ?? 0) > 0) {
    recommendations.push({
      kind: "recover_missing_owner",
      priority: "high",
      workspaceCount: placementPolicy?.missingOwnerWorkspaces ?? 0,
      ...(typeof placementSummary?.workersWithMissingPlacements === "number"
        ? { workerCount: placementSummary.workersWithMissingPlacements }
        : {}),
      sampleWorkspaceIds: sampleWorkspaceIds(
        (placement) => placement.state !== "evicted" && Boolean(placement.ownerWorkerId) && !workerHealthById.has(placement.ownerWorkerId!)
      ),
      sampleWorkerIds: sampleWorkerIds(
        (placement) => placement.state !== "evicted" && Boolean(placement.ownerWorkerId) && !workerHealthById.has(placement.ownerWorkerId!)
      ),
      message: `recover or reassign ${placementPolicy?.missingOwnerWorkspaces ?? 0} workspace(s) still pointing at missing owners`
    });
  }
  if ((placementPolicy?.lateOwnerWorkspaces ?? 0) > 0) {
    recommendations.push({
      kind: "reassign_late_owner",
      priority: "high",
      workspaceCount: placementPolicy?.lateOwnerWorkspaces ?? 0,
      ...(typeof placementSummary?.workersWithLatePlacements === "number"
        ? { workerCount: placementSummary.workersWithLatePlacements }
        : {}),
      sampleWorkspaceIds: sampleWorkspaceIds(
        (placement) => placement.state !== "evicted" && workerHealthById.get(placement.ownerWorkerId ?? "") === "late"
      ),
      sampleWorkerIds: sampleWorkerIds(
        (placement) => placement.state !== "evicted" && workerHealthById.get(placement.ownerWorkerId ?? "") === "late"
      ),
      message: `stabilize or reassign ${placementPolicy?.lateOwnerWorkspaces ?? 0} workspace(s) currently attached to late owners`
    });
  }
  if ((placementPolicy?.drainingOwnerWorkspaces ?? 0) > 0) {
    recommendations.push({
      kind: "finish_draining_owner",
      priority: "medium",
      workspaceCount: placementPolicy?.drainingOwnerWorkspaces ?? 0,
      sampleWorkspaceIds: sampleWorkspaceIds((placement) => placement.state === "draining"),
      sampleWorkerIds: sampleWorkerIds((placement) => placement.state === "draining"),
      message: `finish draining or hand off ${placementPolicy?.drainingOwnerWorkspaces ?? 0} workspace(s) on workers that are stopping`
    });
  }
  if ((placementPolicy?.ownersSpanningWorkers ?? 0) > 0) {
    recommendations.push({
      kind: "consolidate_owner_affinity",
      priority: "medium",
      workspaceCount: 0,
      ownerCount: placementPolicy?.ownersSpanningWorkers ?? 0,
      sampleOwnerIds: sampleOwnerIds((placement) => {
        const ownerId = placementOwnerAffinityId(placement);
        return Boolean(ownerId) && spanningOwners.has(ownerId!);
      }),
      message: `consider consolidating ${placementPolicy?.ownersSpanningWorkers ?? 0} owner affinity group(s) that currently span multiple workers`
    });
  }
  if ((placementPolicy?.sandboxesAboveWorkspaceCapacity ?? 0) > 0) {
    recommendations.push({
      kind: "rebalance_workspace_capacity",
      priority: "medium",
      workspaceCount: 0,
      workerCount: placementPolicy?.sandboxesAboveWorkspaceCapacity ?? 0,
      sampleWorkerIds: sampleWorkerIds((placement) => overloadedWorkers.has(placement.ownerWorkerId ?? "")),
      message: `rebalance placements away from ${placementPolicy?.sandboxesAboveWorkspaceCapacity ?? 0} sandbox owner(s) above the workspace capacity limit`
    });
  }

  return recommendations.length > 0 ? recommendations : undefined;
}

function placementActionPhase(kind: ControllerPlacementRecommendation["kind"]): ControllerPlacementActionItem["phase"] {
  switch (kind) {
    case "assign_unassigned":
    case "recover_missing_owner":
    case "reassign_late_owner":
      return "stabilize";
    case "finish_draining_owner":
      return "handoff";
    default:
      return "optimize";
  }
}

function placementActionBlockers(recommendation: ControllerPlacementRecommendation): string[] {
  switch (recommendation.kind) {
    case "assign_unassigned":
      return ["owner_unassigned"];
    case "recover_missing_owner":
      return ["owner_missing"];
    case "reassign_late_owner":
      return ["owner_late"];
    case "finish_draining_owner":
      return ["worker_draining"];
    case "consolidate_owner_affinity":
      return ["owner_affinity_split"];
    case "rebalance_workspace_capacity":
      return ["workspace_capacity_exceeded"];
  }
}

export function summarizePlacementActionPlan(
  recommendations: ControllerPlacementRecommendation[] | undefined
): ControllerPlacementActionPlan | undefined {
  if (!recommendations || recommendations.length === 0) {
    return undefined;
  }

  const items = recommendations.map<ControllerPlacementActionItem>((recommendation, index) => ({
    id: `${recommendation.kind}:${index + 1}`,
    phase: placementActionPhase(recommendation.kind),
    kind: recommendation.kind,
    priority: recommendation.priority,
    blockers: placementActionBlockers(recommendation),
    ...(recommendation.sampleWorkspaceIds ? { workspaceIds: recommendation.sampleWorkspaceIds } : {}),
    ...(recommendation.sampleWorkerIds ? { workerIds: recommendation.sampleWorkerIds } : {}),
    ...(recommendation.sampleOwnerIds ? { ownerIds: recommendation.sampleOwnerIds } : {}),
    summary: recommendation.message
  }));

  return {
    totalItems: items.length,
    highPriorityItems: items.filter((item) => item.priority === "high").length,
    nextItem: items[0],
    items
  };
}

export function buildPlacementExecutionOperations(input: {
  placements?: RedisWorkspacePlacementEntry[] | undefined;
  activeWorkers?: RedisWorkerRegistryEntry[] | undefined;
  maxWorkspacesPerSandbox?: number | undefined;
}): ControllerPlacementExecutionOperation[] {
  const placements = (input.placements ?? []) as ControllerWorkspacePlacementEntry[];
  if (placements.length === 0) {
    return [];
  }

  const workerHealthById = new Map((input.activeWorkers ?? []).map((worker) => [workerPlacementReference(worker), worker.health]));
  const workerStateById = new Map((input.activeWorkers ?? []).map((worker) => [workerPlacementReference(worker), worker.state]));
  const nonEvictedPlacements = placements.filter((placement) => placement.state !== "evicted");
  const scheduledWorkspaceIds = new Set<string>();
  const operations: ControllerPlacementExecutionOperation[] = [];
  const workspaceCapacity = Math.max(1, input.maxWorkspacesPerSandbox ?? 1);
  const workerRefLoads = new Map<string, number>();
  const ownerAffinityWorkers = new Map<string, Set<string>>();

  for (const placement of nonEvictedPlacements) {
    const ownerId = placementOwnerAffinityId(placement);
    if (ownerId && placement.ownerWorkerId && placement.state !== "unassigned") {
      const workers = ownerAffinityWorkers.get(ownerId) ?? new Set<string>();
      workers.add(placement.ownerWorkerId);
      ownerAffinityWorkers.set(ownerId, workers);
    }
    if (placement.ownerWorkerId && placement.state !== "unassigned") {
      const refLoad =
        typeof placement.refCount === "number" ? Math.max(0, placement.refCount) : placement.state === "active" ? 1 : 0;
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + refLoad);
    }
  }

  const overloadedWorkers = new Set(
    [...workerRefLoads.entries()].filter(([, load]) => load > workspaceCapacity).map(([workerId]) => workerId)
  );

  const selectTargetWorker = (placement: RedisWorkspacePlacementEntry, excludeWorkerIds?: Iterable<string>) => {
    const excluded = new Set(excludeWorkerIds ?? []);
    const candidateWorkers = (input.activeWorkers ?? []).filter(
      (worker) =>
        worker.health === "healthy" &&
        worker.state !== "stopping" &&
        !excluded.has(worker.workerId) &&
        !excluded.has(workerPlacementReference(worker))
    );
    if (candidateWorkers.length === 0) {
      return undefined;
    }

    const ownerId = placementOwnerAffinityId(placement);
    const workerOwnerAffinities = ownerId
      ? candidateWorkers
          .map((worker) => ({
            workerId: worker.workerId,
            placementReference: workerPlacementReference(worker),
            workspaceCount: nonEvictedPlacements.filter(
              (item) =>
                placementOwnerAffinityId(item) === ownerId &&
                item.workspaceId !== placement.workspaceId &&
                item.ownerWorkerId === workerPlacementReference(worker) &&
                item.state !== "unassigned"
            ).length
          }))
          .filter((entry) => entry.workspaceCount > 0)
      : undefined;
    const affinity = buildRedisWorkerAffinitySummary({
      activeWorkers: candidateWorkers.map((worker) => ({
        workerId: worker.workerId,
        processKind: worker.processKind,
        state: worker.state,
        health: worker.health,
        ...(worker.currentSessionId ? { currentSessionId: worker.currentSessionId } : {}),
        ...(worker.currentWorkspaceId ? { currentWorkspaceId: worker.currentWorkspaceId } : {})
      })),
      slots: candidateWorkers.map((worker) => ({
        workerId: worker.workerId,
        state: worker.state,
        ...(worker.currentSessionId ? { currentSessionId: worker.currentSessionId } : {}),
        ...(worker.currentWorkspaceId ? { currentWorkspaceId: worker.currentWorkspaceId } : {})
      })),
      workspaceId: placement.workspaceId,
      ...(ownerId ? { ownerId } : {}),
      ...(workerOwnerAffinities && workerOwnerAffinities.length > 0 ? { workerOwnerAffinities } : {})
    });
    const preferredCandidate = affinity.candidates.find(
      (candidate) => candidate.health === "healthy" && candidate.state !== "stopping"
    );
    if (!preferredCandidate) {
      return undefined;
    }

    const selectedWorker = candidateWorkers.find((worker) => worker.workerId === preferredCandidate.workerId);
    if (!selectedWorker) {
      return undefined;
    }

    return {
      workerId: preferredCandidate.workerId,
      placementReference: workerPlacementReference(selectedWorker),
      reasons: preferredCandidate.reasons
    };
  };

  for (const placement of placements) {
    if (placement.state === "evicted") {
      continue;
    }

    if (!placement.ownerWorkerId || placement.state === "unassigned") {
      const target = selectTargetWorker(placement);
      if (target && target.placementReference !== placement.preferredWorkerId && target.workerId !== placement.preferredWorkerId) {
        operations.push({
          id: `assign_unassigned:${placement.workspaceId}`,
          kind: "assign_unassigned",
          workspaceId: placement.workspaceId,
          state: placement.state,
          action: "set_preferred_worker",
          reason: "unassigned_workspace",
          targetWorkerId: target.placementReference,
          targetWorkerReasons: target.reasons
        });
        scheduledWorkspaceIds.add(placement.workspaceId);
      }
      continue;
    }

    const workerHealth = workerHealthById.get(placement.ownerWorkerId);
    const workerState = workerStateById.get(placement.ownerWorkerId);
    const target = selectTargetWorker(placement, [placement.ownerWorkerId]);
    let operation: ControllerPlacementExecutionOperation | undefined;

    if (!workerHealth) {
      operation = {
        id: `recover_missing_owner:${placement.workspaceId}`,
        kind: "recover_missing_owner",
        workspaceId: placement.workspaceId,
        ownerWorkerId: placement.ownerWorkerId,
        state: placement.state,
        action: "release_ownership",
        reason: "owner_missing",
        ...(target ? { targetWorkerId: target.workerId, targetWorkerReasons: target.reasons } : {})
      };
    } else if (placement.state === "draining" || workerState === "stopping") {
      operation = {
        id: `finish_draining_owner:${placement.workspaceId}`,
        kind: "finish_draining_owner",
        workspaceId: placement.workspaceId,
        ownerWorkerId: placement.ownerWorkerId,
        state: placement.state,
        action: "release_ownership",
        reason: "worker_draining",
        ...(target ? { targetWorkerId: target.workerId, targetWorkerReasons: target.reasons } : {})
      };
    } else if (workerHealth === "late") {
      operation =
        placement.state === "active"
          ? target &&
            target.placementReference !== placement.preferredWorkerId &&
            target.workerId !== placement.preferredWorkerId
            ? {
                id: `reassign_late_owner:${placement.workspaceId}`,
                kind: "reassign_late_owner",
                workspaceId: placement.workspaceId,
                ownerWorkerId: placement.ownerWorkerId,
                state: placement.state,
                action: "set_preferred_worker",
                reason: "owner_late",
                targetWorkerId: target.placementReference,
                targetWorkerReasons: target.reasons
              }
            : undefined
          : {
              id: `reassign_late_owner:${placement.workspaceId}`,
              kind: "reassign_late_owner",
              workspaceId: placement.workspaceId,
              ownerWorkerId: placement.ownerWorkerId,
              state: placement.state,
              action: "release_ownership",
              reason: "owner_late",
              ...(target ? { targetWorkerId: target.workerId, targetWorkerReasons: target.reasons } : {})
            };
    }

    if (!operation) {
      continue;
    }

    operations.push(operation);
    scheduledWorkspaceIds.add(placement.workspaceId);
  }

  for (const placement of nonEvictedPlacements) {
    if (
      scheduledWorkspaceIds.has(placement.workspaceId) ||
      !placementOwnerAffinityId(placement) ||
      (ownerAffinityWorkers.get(placementOwnerAffinityId(placement)!)?.size ?? 0) <= 1 ||
      (placement.state !== "idle" && placement.state !== "unassigned")
    ) {
      continue;
    }

    const target = selectTargetWorker(placement);
    if (
      !target ||
      target.placementReference === placement.ownerWorkerId ||
      target.placementReference === placement.preferredWorkerId ||
      target.workerId === placement.preferredWorkerId
    ) {
      continue;
    }

    operations.push({
      id: `consolidate_owner_affinity:${placement.workspaceId}`,
      kind: "consolidate_owner_affinity",
      workspaceId: placement.workspaceId,
      ...(placement.ownerWorkerId ? { ownerWorkerId: placement.ownerWorkerId } : {}),
      state: placement.state,
      action: "set_preferred_worker",
      reason: "owner_affinity_split",
      targetWorkerId: target.placementReference,
      targetWorkerReasons: target.reasons
    });
    scheduledWorkspaceIds.add(placement.workspaceId);
  }

  for (const placement of nonEvictedPlacements) {
    if (
      scheduledWorkspaceIds.has(placement.workspaceId) ||
      !placement.ownerWorkerId ||
      !overloadedWorkers.has(placement.ownerWorkerId) ||
      placement.state !== "idle"
    ) {
      continue;
    }

    const target = selectTargetWorker(placement, new Set([...overloadedWorkers, placement.ownerWorkerId]));
    if (!target || target.placementReference === placement.preferredWorkerId || target.workerId === placement.preferredWorkerId) {
      continue;
    }

    operations.push({
      id: `rebalance_workspace_capacity:${placement.workspaceId}`,
      kind: "rebalance_workspace_capacity",
      workspaceId: placement.workspaceId,
      ownerWorkerId: placement.ownerWorkerId,
      state: placement.state,
      action: "set_preferred_worker",
      reason: "workspace_capacity_exceeded",
      targetWorkerId: target.placementReference,
      targetWorkerReasons: target.reasons
    });
  }

  return operations.sort((left, right) => left.id.localeCompare(right.id));
}

export function createPlacementRegistryActionExecutor(options: {
  placementRegistry: ControllerPlacementOwnershipRegistry;
  maxWorkspacesPerSandbox?: number | undefined;
  logger?: ControllerLogger | undefined;
}): ControllerPlacementExecutor {
  return {
    async execute(input) {
      const operations = buildPlacementExecutionOperations({
        placements: input.placements,
        activeWorkers: input.activeWorkers,
        maxWorkspacesPerSandbox: options.maxWorkspacesPerSandbox
      });
      if (operations.length === 0) {
        return undefined;
      }

      const results: ControllerPlacementExecutionResult[] = [];
      for (const operation of operations) {
        try {
          if (operation.action === "set_preferred_worker" && !operation.targetWorkerId) {
            results.push({
              ...operation,
              status: "skipped",
              message: "no healthy target worker was available for the requested placement hint update"
            });
            continue;
          }

          if (operation.action === "set_preferred_worker" && operation.targetWorkerId) {
            await options.placementRegistry.setPreferredWorker(operation.workspaceId, operation.targetWorkerId, {
              reason: "controller_target",
              overwrite: true,
              updatedAt: input.timestamp
            });
            results.push({
              ...operation,
              status: "applied",
              message: `controller preferred worker hint was updated to ${operation.targetWorkerId}`
            });
          } else {
            await options.placementRegistry.releaseOwnership(operation.workspaceId, {
              state: "unassigned",
              ...(operation.targetWorkerId
                ? {
                    preferredWorkerId: operation.targetWorkerId,
                    preferredWorkerReason: "controller_target" as const
                  }
                : {}),
              updatedAt: input.timestamp
            });
            results.push({
              ...operation,
              status: "applied",
              message: operation.targetWorkerId
                ? `workspace ownership was released for controller-driven reassignment toward ${operation.targetWorkerId}`
                : "workspace ownership was released for controller-driven reassignment"
            });
          }
        } catch (error) {
          options.logger?.warn?.(
            `[controller] failed to execute placement action ${operation.kind} for workspace ${operation.workspaceId}`,
            error
          );
          results.push({
            ...operation,
            status: "failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        attempted: results.length,
        applied: results.filter((result) => result.status === "applied").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        failed: results.filter((result) => result.status === "failed").length,
        operations: results
      };
    }
  };
}

export class RedisController {
  readonly #queue: SessionRunQueue;
  readonly #registry: WorkerRegistry;
  readonly #placementRegistry?: WorkspacePlacementRegistry | undefined;
  readonly #placementExecutor?: ControllerPlacementExecutor | undefined;
  readonly #config: StandaloneControllerConfig;
  readonly #sandboxConfig: SandboxFleetConfig;
  readonly #scaleTarget?: WorkerReplicaTarget | undefined;
  readonly #logger?: ControllerLogger | undefined;
  readonly #healthProbe: ControllerHealthProbe;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #lastScaleUpAtMs: number | undefined;
  #lastScaleDownAtMs: number | undefined;
  #lastLoggedAtMs: number | undefined;
  #lastLoggedState: ControllerLoggedState | undefined;
  #scaleUpPressureStreak = 0;
  #scaleDownPressureStreak = 0;
  #snapshot: ControllerSnapshot;

  constructor(options: {
    queue: SessionRunQueue;
    registry: WorkerRegistry;
    placementRegistry?: WorkspacePlacementRegistry | undefined;
    placementExecutor?: ControllerPlacementExecutor | undefined;
    config: StandaloneControllerConfig;
    sandboxConfig?: SandboxFleetConfig | undefined;
    scaleTarget?: WorkerReplicaTarget | undefined;
    logger?: ControllerLogger | undefined;
    healthProbe?: ControllerHealthProbe | undefined;
  }) {
    this.#queue = options.queue;
    this.#registry = options.registry;
    this.#placementRegistry = options.placementRegistry;
    this.#placementExecutor = options.placementExecutor;
    this.#config = options.config;
    this.#sandboxConfig = options.sandboxConfig ?? {
      providerKind: "embedded",
      managedByController: false,
      minCount: 0,
      maxCount: 1,
      maxWorkspacesPerSandbox: 32,
      ownerlessPool: "shared"
    };
    this.#scaleTarget = options.scaleTarget;
    this.#logger = options.logger;
    this.#healthProbe = options.healthProbe ?? defaultControllerHealthProbe;
    this.#snapshot = {
      running: false,
      minReplicas: options.config.minReplicas,
      maxReplicas: options.config.maxReplicas,
      suggestedReplicas: options.config.minReplicas,
      desiredReplicas: options.config.minReplicas,
      suggestedWorkers: options.config.minReplicas,
      activeReplicas: 0,
      busyReplicas: 0,
      activeSlots: 0,
      busySlots: 0,
      idleSlots: 0,
      effectiveCapacityPerReplica: 1,
      readySessionsPerCapacityUnit: options.config.readySessionsPerCapacityUnit,
      reservedSubagentCapacity: options.config.reservedSubagentCapacity,
      scaleUpPressureStreak: 0,
      scaleDownPressureStreak: 0,
      scaleUpCooldownRemainingMs: 0,
      scaleDownCooldownRemainingMs: 0,
      recentDecisions: []
    };
  }

  start(options?: { skipInitialEvaluation?: boolean | undefined }): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    if (!options?.skipInitialEvaluation) {
      void this.evaluateNow("startup");
    }
    this.#timer = setInterval(() => {
      void this.evaluateNow("interval");
    }, this.#config.scaleIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async close(): Promise<void> {
    this.stop();
    await this.#placementExecutor?.close?.();
    await this.#scaleTarget?.close?.();
  }

  snapshot(): ControllerSnapshot {
    return {
      ...this.#snapshot,
      recentDecisions: [...this.#snapshot.recentDecisions]
    };
  }

  async evaluateNow(reason: "startup" | "interval" = "interval"): Promise<ControllerSnapshot> {
    const [activeWorkers, schedulingPressure, listedWorkspacePlacements] = await Promise.all([
      this.#registry.listActive ? this.#registry.listActive(Date.now()) : Promise.resolve([]),
      this.#readSchedulingPressure(),
      this.#placementRegistry?.listAll() ?? Promise.resolve(undefined)
    ]);
    let workspacePlacements = listedWorkspacePlacements;
    const { fleet, suggestedWorkers, suggestedReplicas: workloadSuggestedReplicas } = calculateStandaloneWorkerReplicas({
      config: this.#config,
      activeWorkers,
      schedulingPressure
    });
    let placementSummary = summarizeWorkspacePlacements(workspacePlacements, activeWorkers);
    let placementPolicy = summarizePlacementPolicy({
      placements: workspacePlacements,
      activeWorkers,
      maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
    });
    let placementRecommendations = placementPolicy?.attentionRequired
      ? summarizePlacementRecommendations({
          placementSummary,
          placementPolicy,
          placements: workspacePlacements,
          activeWorkers,
          maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
        })
      : undefined;
    let placementActionPlan = placementRecommendations ? summarizePlacementActionPlan(placementRecommendations) : undefined;
    const timestamp = new Date().toISOString();
    const placementExecution =
      this.#placementExecutor && workspacePlacements && placementPolicy?.attentionRequired
        ? await this.#placementExecutor.execute({
            timestamp,
            placements: workspacePlacements,
            activeWorkers
          })
        : undefined;
    if ((placementExecution?.applied ?? 0) > 0 && this.#placementRegistry) {
      workspacePlacements = await this.#placementRegistry.listAll();
      placementSummary = summarizeWorkspacePlacements(workspacePlacements, activeWorkers);
      placementPolicy = summarizePlacementPolicy({
        placements: workspacePlacements,
        activeWorkers,
        maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
      });
      placementRecommendations = placementPolicy?.attentionRequired
        ? summarizePlacementRecommendations({
            placementSummary,
            placementPolicy,
            placements: workspacePlacements,
            activeWorkers,
            maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
          })
        : undefined;
      placementActionPlan = placementRecommendations ? summarizePlacementActionPlan(placementRecommendations) : undefined;
    }
    const sandboxFleet = summarizeSandboxFleet({
      placements: workspacePlacements,
      config: this.#sandboxConfig
    });
    const placementSuggestedReplicas = sandboxFleet.managedByController
      ? Math.max(
          this.#config.minReplicas,
          Math.min(this.#config.maxReplicas, Math.max(0, sandboxFleet.desiredSandboxes))
        )
      : this.#config.minReplicas;
    const suggestedReplicas = Math.max(workloadSuggestedReplicas, placementSuggestedReplicas);
    const scaleDownTargetReplicas = this.#scaleDownTargetReplicas(suggestedReplicas, fleet.activeReplicas);
    const scaleDownGate =
      scaleDownTargetReplicas < fleet.activeReplicas
        ? await this.#evaluateScaleDownGate(activeWorkers, placementSummary)
        : undefined;
    const desiredReplicas = this.#desiredReplicas({
      suggestedReplicas,
      currentReplicas: fleet.activeReplicas,
      reason,
      scaleDownTargetReplicas,
      allowScaleDown: scaleDownGate?.allowed ?? true
    });
    const rebalanceReason = this.#rebalanceReason({
      reason,
      desiredReplicas,
      suggestedReplicas,
      activeReplicas: fleet.activeReplicas,
      scaleDownGate,
      placementPolicy
    });
    const nowMs = Date.now();
    const scaleTarget = await this.#reconcileScaleTarget({
      timestamp,
      reason: rebalanceReason,
      desiredReplicas,
      suggestedReplicas,
      activeReplicas: fleet.activeReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      ...(typeof schedulingPressure?.readySessionCount === "number" ? { readySessionCount: schedulingPressure.readySessionCount } : {}),
      ...(typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: schedulingPressure.oldestSchedulableReadyAgeMs }
        : {})
    });

    this.#snapshot = {
      running: this.#running,
      minReplicas: this.#config.minReplicas,
      maxReplicas: this.#config.maxReplicas,
      suggestedReplicas,
      desiredReplicas,
      suggestedWorkers,
      activeReplicas: fleet.activeReplicas,
      busyReplicas: fleet.busyReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      idleSlots: fleet.idleSlots,
      effectiveCapacityPerReplica: fleet.effectiveCapacityPerReplica,
      readySessionsPerCapacityUnit: this.#config.readySessionsPerCapacityUnit,
      reservedSubagentCapacity: this.#config.reservedSubagentCapacity,
      ...(typeof schedulingPressure?.readySessionCount === "number" ? { readySessionCount: schedulingPressure.readySessionCount } : {}),
      ...(typeof schedulingPressure?.subagentReadySessionCount === "number"
        ? { subagentReadySessionCount: schedulingPressure.subagentReadySessionCount }
        : {}),
      ...(typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: schedulingPressure.oldestSchedulableReadyAgeMs }
        : {}),
      lastRebalanceAt: timestamp,
      lastRebalanceReason: rebalanceReason,
      scaleUpPressureStreak: this.#scaleUpPressureStreak,
      scaleDownPressureStreak: this.#scaleDownPressureStreak,
      scaleUpCooldownRemainingMs: cooldownRemainingMs(this.#lastScaleUpAtMs, this.#config.scaleUpCooldownMs, nowMs),
      scaleDownCooldownRemainingMs: cooldownRemainingMs(
        this.#lastCapacityChangeAtMs(),
        this.#config.scaleDownCooldownMs,
        nowMs
      ),
      sandboxFleet,
      ...(placementSummary ? { placement: placementSummary } : {}),
      ...(placementPolicy ? { placementPolicy } : {}),
      ...(placementRecommendations ? { placementRecommendations } : {}),
      ...(placementActionPlan ? { placementActionPlan } : {}),
      ...(placementExecution ? { placementExecution } : {}),
      ...(scaleDownGate ? { scaleDownGate } : {}),
      ...(scaleTarget ? { scaleTarget } : {}),
      recentDecisions: appendDecision(this.#snapshot.recentDecisions, {
        timestamp,
        reason: rebalanceReason,
        suggestedReplicas,
        desiredReplicas,
        suggestedWorkers,
        activeReplicas: fleet.activeReplicas,
        activeSlots: fleet.activeSlots,
        busySlots: fleet.busySlots,
        ...(scaleDownGate ? { scaleDownAllowed: scaleDownGate.allowed, scaleDownBlockedReplicas: scaleDownGate.blockedReplicas } : {}),
        ...(typeof schedulingPressure?.readySessionCount === "number" ? { readySessionCount: schedulingPressure.readySessionCount } : {}),
        ...(typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number"
          ? { oldestSchedulableReadyAgeMs: schedulingPressure.oldestSchedulableReadyAgeMs }
          : {})
      })
    };

    const loggedState = buildControllerLoggedState({
      reason: rebalanceReason,
      desiredReplicas,
      suggestedReplicas,
      activeReplicas: fleet.activeReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      effectiveCapacityPerReplica: fleet.effectiveCapacityPerReplica,
      schedulingPressure,
      scaleDownGate,
      sandboxFleet,
      placementSummary,
      placementPolicy,
      placementRecommendations,
      placementActionPlan,
      placementExecution,
      scaleTarget
    });
    if (shouldLogControllerRebalance(this.#lastLoggedState, this.#lastLoggedAtMs, loggedState, nowMs, this.#config.scaleIntervalMs)) {
      this.#logger?.info?.(formatControllerRebalanceLog(loggedState));
      this.#lastLoggedState = loggedState;
      this.#lastLoggedAtMs = nowMs;
    }

    return this.snapshot();
  }

  async #readSchedulingPressure(): Promise<SessionRunQueuePressure | undefined> {
    if (typeof this.#queue.getSchedulingPressure === "function") {
      return this.#queue.getSchedulingPressure();
    }

    if (typeof this.#queue.getReadySessionCount === "function") {
      return {
        readySessionCount: await this.#queue.getReadySessionCount()
      };
    }

    return undefined;
  }

  #scaleDownTargetReplicas(suggestedReplicas: number, currentReplicas: number): number {
    if (suggestedReplicas > currentReplicas) {
      this.#scaleUpPressureStreak += 1;
    } else {
      this.#scaleUpPressureStreak = 0;
    }

    if (suggestedReplicas < currentReplicas) {
      this.#scaleDownPressureStreak += 1;
    } else {
      this.#scaleDownPressureStreak = 0;
    }

    return suggestedReplicas < currentReplicas && this.#scaleDownPressureStreak >= this.#config.scaleDownSampleSize
      ? suggestedReplicas
      : currentReplicas;
  }

  #desiredReplicas(input: {
    suggestedReplicas: number;
    currentReplicas: number;
    reason: "startup" | "interval";
    scaleDownTargetReplicas: number;
    allowScaleDown: boolean;
  }): number {
    const { suggestedReplicas, currentReplicas, reason, scaleDownTargetReplicas, allowScaleDown } = input;

    if (reason === "startup") {
      if (suggestedReplicas < currentReplicas && !allowScaleDown) {
        return currentReplicas;
      }
      return suggestedReplicas;
    }

    const nowMs = Date.now();
    if (suggestedReplicas > currentReplicas) {
      const targetReplicas =
        this.#scaleUpPressureStreak >= this.#config.scaleUpSampleSize ? suggestedReplicas : currentReplicas;
      if (targetReplicas <= currentReplicas) {
        return currentReplicas;
      }
      if (cooldownRemainingMs(this.#lastScaleUpAtMs, this.#config.scaleUpCooldownMs, nowMs) > 0) {
        return currentReplicas;
      }
      this.#lastScaleUpAtMs = nowMs;
      return targetReplicas;
    }

    if (scaleDownTargetReplicas < currentReplicas) {
      if (!allowScaleDown) {
        return currentReplicas;
      }
      if (cooldownRemainingMs(this.#lastCapacityChangeAtMs(), this.#config.scaleDownCooldownMs, nowMs) > 0) {
        return currentReplicas;
      }
      this.#lastScaleDownAtMs = nowMs;
      return scaleDownTargetReplicas;
    }

    return suggestedReplicas > currentReplicas ? currentReplicas : suggestedReplicas;
  }

  #lastCapacityChangeAtMs(): number | undefined {
    const lastScaleUpAtMs = this.#lastScaleUpAtMs ?? 0;
    const lastScaleDownAtMs = this.#lastScaleDownAtMs ?? 0;
    const latest = Math.max(lastScaleUpAtMs, lastScaleDownAtMs);
    return latest > 0 ? latest : undefined;
  }

  #rebalanceReason(input: {
    reason: "startup" | "interval";
    desiredReplicas: number;
    suggestedReplicas: number;
    activeReplicas: number;
    scaleDownGate?: ControllerScaleDownGate | undefined;
    placementPolicy?: ControllerPlacementPolicySummary | undefined;
  }): ControllerRebalanceReason {
    if (input.reason === "startup") {
      if (input.suggestedReplicas < input.activeReplicas && input.scaleDownGate && !input.scaleDownGate.allowed) {
        return "scale_down_blocked";
      }
      return "startup";
    }

    if (input.desiredReplicas > input.activeReplicas) {
      return "scale_up";
    }

    if (input.desiredReplicas < input.activeReplicas) {
      return "scale_down";
    }

    if (input.suggestedReplicas < input.activeReplicas && input.scaleDownGate && !input.scaleDownGate.allowed) {
      return "scale_down_blocked";
    }

    if (input.desiredReplicas !== input.suggestedReplicas) {
      return "cooldown_hold";
    }

    if (input.placementPolicy?.attentionRequired) {
      return "placement_attention";
    }

    return "steady";
  }

  async #evaluateScaleDownGate(
    activeWorkers: RedisWorkerRegistryEntry[],
    placementSummary?: ControllerPlacementSummary | undefined
  ): Promise<ControllerScaleDownGate> {
    const replicaWorkers = new Map<string, RedisWorkerRegistryEntry[]>();

    for (const worker of activeWorkers) {
      if (worker.processKind !== "standalone" || worker.health !== "healthy") {
        continue;
      }

      const replicaId = worker.runtimeInstanceId ?? worker.workerId;
      const existing = replicaWorkers.get(replicaId);
      if (existing) {
        existing.push(worker);
      } else {
        replicaWorkers.set(replicaId, [worker]);
      }
    }

    const blockerResults: Array<ControllerScaleDownBlocker | undefined> = await Promise.all(
      [...replicaWorkers.entries()].map(async ([replicaId, workers]) => {
        const ownerBaseUrl = workers.find((worker) => worker.ownerBaseUrl)?.ownerBaseUrl;
        if (!ownerBaseUrl) {
          return {
            replicaId,
            workerIds: workers.map((worker) => worker.workerId).sort(),
            reason: "missing_owner_base_url" as const,
            message: "worker registry entry is missing ownerBaseUrl for scale-down health probing"
          };
        }

        try {
          const health = await this.#healthProbe({
            replicaId,
            ownerBaseUrl,
            workers
          });
          if (health.draining) {
            return {
              replicaId,
              workerIds: workers.map((worker) => worker.workerId).sort(),
              ownerBaseUrl,
              reason: "worker_draining" as const,
              message: "worker is currently draining and should not be selected for scale-down"
            };
          }
          if (health.materializationBlockerCount > 0 || health.materializationFailureCount > 0) {
            return {
              replicaId,
              workerIds: workers.map((worker) => worker.workerId).sort(),
              ownerBaseUrl,
              reason: "materialization_blocked" as const,
              message: `worker reported ${health.materializationBlockerCount} materialization blocker(s) and ${health.materializationFailureCount} failure(s)`,
              materializationBlockerCount: health.materializationBlockerCount,
              materializationFailureCount: health.materializationFailureCount
            };
          }
          return undefined;
        } catch (error) {
          return {
            replicaId,
            workerIds: workers.map((worker) => worker.workerId).sort(),
            ownerBaseUrl,
            reason: "probe_failed" as const,
            message: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    const blockers = blockerResults
      .reduce<ControllerScaleDownBlocker[]>((accumulator, blocker) => {
        if (blocker) {
          accumulator.push(blocker);
        }
        return accumulator;
      }, [])
      .sort((left, right) => left.replicaId.localeCompare(right.replicaId));
    const placementBlockers: ControllerScaleDownPlacementBlocker[] = [];
    if ((placementSummary?.ownedByMissingWorkers ?? 0) > 0) {
      placementBlockers.push({
        reason: "missing_owner_worker",
        workspaceCount: placementSummary?.ownedByMissingWorkers ?? 0,
        workerCount: placementSummary?.workersWithMissingPlacements ?? 0,
        message: `workspace placement still references ${placementSummary?.workersWithMissingPlacements ?? 0} missing worker(s) across ${placementSummary?.ownedByMissingWorkers ?? 0} workspace(s)`
      });
    }
    if ((placementSummary?.ownedByLateWorkers ?? 0) > 0) {
      placementBlockers.push({
        reason: "late_owner_worker",
        workspaceCount: placementSummary?.ownedByLateWorkers ?? 0,
        workerCount: placementSummary?.workersWithLatePlacements ?? 0,
        message: `workspace placement still references ${placementSummary?.workersWithLatePlacements ?? 0} late worker(s) across ${placementSummary?.ownedByLateWorkers ?? 0} workspace(s)`
      });
    }

    return {
      allowed: blockers.length === 0 && placementBlockers.length === 0,
      checkedReplicas: replicaWorkers.size,
      blockedReplicas: blockers.length,
      blockers,
      ...(placementBlockers.length > 0 ? { placementBlockers } : {}),
      evaluatedAt: new Date().toISOString()
    };
  }

  async #reconcileScaleTarget(
    input: Parameters<Exclude<WorkerReplicaTarget, undefined>["reconcile"]>[0]
  ): Promise<WorkerReplicaTargetResult | undefined> {
    if (!this.#scaleTarget) {
      return undefined;
    }

    try {
      return await this.#scaleTarget.reconcile(input);
    } catch (error) {
      this.#logger?.warn("[controller] failed to reconcile scale target", error);
      return {
        kind: this.#scaleTarget.kind,
        attempted: true,
        applied: false,
        desiredReplicas: input.desiredReplicas,
        outcome: "error",
        at: input.timestamp,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

async function defaultControllerHealthProbe(input: {
  replicaId: string;
  ownerBaseUrl: string;
}): Promise<ControllerWorkerHealth> {
  const timeoutMs = readPositiveIntEnv("OAH_CONTROLLER_HEALTH_TIMEOUT_MS", 1_500);
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${input.ownerBaseUrl.replace(/\/+$/u, "")}/healthz`, {
      signal: abortController.signal
    });
    if (!response.ok) {
      throw new Error(`healthz probe failed for ${input.replicaId} with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      worker?: {
        draining?: unknown;
        materialization?: {
          blockerCount?: unknown;
          failureCount?: unknown;
        } | undefined;
      } | null;
    };
    const materialization = payload?.worker?.materialization;

    return {
      draining: payload?.worker?.draining === true,
      materializationBlockerCount:
        typeof materialization?.blockerCount === "number" && Number.isFinite(materialization.blockerCount)
          ? Math.max(0, Math.floor(materialization.blockerCount))
          : 0,
      materializationFailureCount:
        typeof materialization?.failureCount === "number" && Number.isFinite(materialization.failureCount)
          ? Math.max(0, Math.floor(materialization.failureCount))
          : 0
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`healthz probe timed out for ${input.replicaId} after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
