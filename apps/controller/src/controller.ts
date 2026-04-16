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
} from "@oah/storage-redis";

import type { WorkerReplicaTarget, WorkerReplicaTargetResult } from "./scale-target.js";

export interface StandaloneControllerConfig {
  minReplicas: number;
  maxReplicas: number;
  slotsPerPod: number;
  readySessionsPerWorker: number;
  reservedSubagentCapacity: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
}

export interface StandaloneWorkerFleetSummary {
  activeReplicas: number;
  busyReplicas: number;
  activeSlots: number;
  busySlots: number;
  idleSlots: number;
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
  slotsPerPod: number;
  suggestedReplicas: number;
  desiredReplicas: number;
  suggestedWorkers: number;
  activeReplicas: number;
  busyReplicas: number;
  activeSlots: number;
  busySlots: number;
  idleSlots: number;
  readySessionsPerWorker: number;
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
  assignedUsers: number;
  unassignedUsers: number;
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

export interface ControllerPlacementPolicySummary {
  attentionRequired: boolean;
  unassignedWorkspaces: number;
  missingOwnerWorkspaces: number;
  lateOwnerWorkspaces: number;
  drainingOwnerWorkspaces: number;
  usersSpanningWorkers: number;
  maxWorkersPerUser: number;
  workersAboveSoftCapacity: number;
  maxRefCountPerWorker: number;
}

export interface ControllerPlacementRecommendation {
  kind:
    | "assign_unassigned"
    | "recover_missing_owner"
    | "reassign_late_owner"
    | "finish_draining_owner"
    | "consolidate_user_affinity"
    | "rebalance_soft_capacity";
  priority: "high" | "medium";
  workspaceCount: number;
  workerCount?: number | undefined;
  userCount?: number | undefined;
  sampleWorkspaceIds?: string[] | undefined;
  sampleWorkerIds?: string[] | undefined;
  sampleUserIds?: string[] | undefined;
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
  userIds?: string[] | undefined;
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
    | "user_affinity_split"
    | "soft_capacity_exceeded";
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

function cooldownRemainingMs(lastChangeAtMs: number | undefined, cooldownMs: number, nowMs: number): number {
  if (!lastChangeAtMs || cooldownMs <= 0) {
    return 0;
  }

  return Math.max(0, lastChangeAtMs + cooldownMs - nowMs);
}

export function resolveStandaloneControllerConfig(config: ServerConfig): StandaloneControllerConfig {
  const standalone = config.workers?.standalone;
  const controller = config.workers?.controller;
  const minReplicas = readPositiveIntEnv("OAH_STANDALONE_WORKER_MIN_REPLICAS", standalone?.min_replicas ?? 1);
  const maxReplicas = Math.max(
    minReplicas,
    readPositiveIntEnv("OAH_STANDALONE_WORKER_MAX_REPLICAS", standalone?.max_replicas ?? minReplicas)
  );

  return {
    minReplicas,
    maxReplicas,
    slotsPerPod: readPositiveIntEnv("OAH_STANDALONE_WORKER_SLOTS_PER_POD", standalone?.slots_per_pod ?? 1),
    readySessionsPerWorker: readPositiveIntEnv(
      "OAH_STANDALONE_WORKER_READY_SESSIONS_PER_WORKER",
      standalone?.ready_sessions_per_worker ?? 1
    ),
    reservedSubagentCapacity: readNonNegativeIntEnv(
      "OAH_STANDALONE_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT",
      standalone?.reserved_capacity_for_subagent ?? 1
    ),
    scaleIntervalMs: readPositiveIntEnv("OAH_CONTROLLER_SCALE_INTERVAL_MS", controller?.scale_interval_ms ?? 5_000),
    scaleUpCooldownMs: readPositiveIntEnv("OAH_CONTROLLER_SCALE_UP_COOLDOWN_MS", controller?.cooldown_ms ?? 1_000),
    scaleDownCooldownMs: readPositiveIntEnv("OAH_CONTROLLER_SCALE_DOWN_COOLDOWN_MS", controller?.cooldown_ms ?? 15_000),
    scaleUpSampleSize: readPositiveIntEnv("OAH_CONTROLLER_SCALE_UP_SAMPLE_SIZE", controller?.scale_up_window ?? 2),
    scaleDownSampleSize: readPositiveIntEnv("OAH_CONTROLLER_SCALE_DOWN_SAMPLE_SIZE", controller?.scale_down_window ?? 3),
    scaleUpBusyRatioThreshold: readRatioEnv("OAH_CONTROLLER_SCALE_UP_BUSY_RATIO_THRESHOLD", controller?.scale_up_busy_ratio_threshold ?? 0.75),
    scaleUpMaxReadyAgeMs: readPositiveIntEnv("OAH_CONTROLLER_SCALE_UP_MAX_READY_AGE_MS", controller?.scale_up_max_ready_age_ms ?? 2_000)
  };
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
    healthyWorkers: healthyStandaloneWorkers
  };
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
  const sizing = calculateRedisWorkerPoolSuggestion({
    minWorkers: input.config.minReplicas * input.config.slotsPerPod,
    maxWorkers: input.config.maxReplicas * input.config.slotsPerPod,
    readySessionsPerWorker: input.config.readySessionsPerWorker,
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
      Math.min(input.config.maxReplicas, Math.ceil(suggestedWorkers / input.config.slotsPerPod))
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

  const workerHealthById = new Map(activeWorkers?.map((worker) => [worker.workerId, worker.health]) ?? []);
  const ownerWorkers = new Set<string>();
  const lateOwnerWorkers = new Set<string>();
  const missingOwnerWorkers = new Set<string>();
  let assignedUsers = 0;
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
    if (placement.userId) {
      assignedUsers += 1;
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

  return {
    totalWorkspaces: placements.length,
    assignedUsers,
    unassignedUsers: Math.max(0, placements.length - assignedUsers),
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

export function summarizePlacementPolicy(input: {
  placements: RedisWorkspacePlacementEntry[] | undefined;
  activeWorkers: RedisWorkerRegistryEntry[];
  slotsPerPod: number;
}): ControllerPlacementPolicySummary | undefined {
  const { placements, activeWorkers } = input;
  if (!placements || placements.length === 0) {
    return undefined;
  }

  const workerStateById = new Map(activeWorkers.map((worker) => [worker.workerId, worker.state]));
  const workerHealthById = new Map(activeWorkers.map((worker) => [worker.workerId, worker.health]));
  const userWorkers = new Map<string, Set<string>>();
  const workerRefLoads = new Map<string, number>();
  let unassignedWorkspaces = 0;
  let missingOwnerWorkspaces = 0;
  let lateOwnerWorkspaces = 0;
  let drainingOwnerWorkspaces = 0;

  for (const placement of placements) {
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
    if (workerStateById.get(placement.ownerWorkerId) === "stopping" || placement.state === "draining") {
      drainingOwnerWorkspaces += 1;
    }

    if (placement.userId && placement.state !== "evicted") {
      const workers = userWorkers.get(placement.userId) ?? new Set<string>();
      workers.add(placement.ownerWorkerId);
      userWorkers.set(placement.userId, workers);
    }

    if (placement.state !== "evicted") {
      const refLoad =
        typeof placement.refCount === "number" ? Math.max(0, placement.refCount) : placement.state === "active" ? 1 : 0;
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + refLoad);
    }
  }

  const userWorkerCounts = [...userWorkers.values()].map((workers) => workers.size);
  const maxWorkersPerUser = userWorkerCounts.length > 0 ? Math.max(...userWorkerCounts) : 0;
  const usersSpanningWorkers = userWorkerCounts.filter((count) => count > 1).length;
  const maxRefCountPerWorker = workerRefLoads.size > 0 ? Math.max(...workerRefLoads.values()) : 0;
  const softCapacity = Math.max(1, input.slotsPerPod);
  const workersAboveSoftCapacity = [...workerRefLoads.values()].filter((load) => load > softCapacity).length;

  return {
    attentionRequired:
      unassignedWorkspaces > 0 ||
      missingOwnerWorkspaces > 0 ||
      lateOwnerWorkspaces > 0 ||
      drainingOwnerWorkspaces > 0 ||
      usersSpanningWorkers > 0 ||
      workersAboveSoftCapacity > 0,
    unassignedWorkspaces,
    missingOwnerWorkspaces,
    lateOwnerWorkspaces,
    drainingOwnerWorkspaces,
    usersSpanningWorkers,
    maxWorkersPerUser,
    workersAboveSoftCapacity,
    maxRefCountPerWorker
  };
}

export function summarizePlacementRecommendations(input: {
  placementSummary?: ControllerPlacementSummary | undefined;
  placementPolicy?: ControllerPlacementPolicySummary | undefined;
  placements?: RedisWorkspacePlacementEntry[] | undefined;
  activeWorkers?: RedisWorkerRegistryEntry[] | undefined;
  slotsPerPod?: number | undefined;
}): ControllerPlacementRecommendation[] | undefined {
  const placementSummary = input.placementSummary;
  const placementPolicy = input.placementPolicy;
  if (!placementSummary && !placementPolicy) {
    return undefined;
  }

  const placements = input.placements ?? [];
  const workerHealthById = new Map((input.activeWorkers ?? []).map((worker) => [worker.workerId, worker.health]));
  const userWorkers = new Map<string, Set<string>>();
  const workerRefLoads = new Map<string, number>();
  const softCapacity = Math.max(1, input.slotsPerPod ?? 1);

  for (const placement of placements) {
    if (placement.userId && placement.ownerWorkerId && placement.state !== "evicted" && placement.state !== "unassigned") {
      const workers = userWorkers.get(placement.userId) ?? new Set<string>();
      workers.add(placement.ownerWorkerId);
      userWorkers.set(placement.userId, workers);
    }
    if (placement.ownerWorkerId && placement.state !== "evicted" && placement.state !== "unassigned") {
      const refLoad =
        typeof placement.refCount === "number" ? Math.max(0, placement.refCount) : placement.state === "active" ? 1 : 0;
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + refLoad);
    }
  }

  const spanningUsers = new Set(
    [...userWorkers.entries()].filter(([, workers]) => workers.size > 1).map(([userId]) => userId)
  );
  const overloadedWorkers = new Set(
    [...workerRefLoads.entries()].filter(([, load]) => load > softCapacity).map(([workerId]) => workerId)
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
  const sampleUserIds = (filter: (placement: RedisWorkspacePlacementEntry) => boolean) =>
    placements
      .filter(filter)
      .map((placement) => placement.userId)
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
        (placement) => Boolean(placement.ownerWorkerId) && !workerHealthById.has(placement.ownerWorkerId!)
      ),
      sampleWorkerIds: sampleWorkerIds(
        (placement) => Boolean(placement.ownerWorkerId) && !workerHealthById.has(placement.ownerWorkerId!)
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
      sampleWorkspaceIds: sampleWorkspaceIds((placement) => workerHealthById.get(placement.ownerWorkerId ?? "") === "late"),
      sampleWorkerIds: sampleWorkerIds((placement) => workerHealthById.get(placement.ownerWorkerId ?? "") === "late"),
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
  if ((placementPolicy?.usersSpanningWorkers ?? 0) > 0) {
    recommendations.push({
      kind: "consolidate_user_affinity",
      priority: "medium",
      workspaceCount: 0,
      userCount: placementPolicy?.usersSpanningWorkers ?? 0,
      sampleUserIds: sampleUserIds((placement) => Boolean(placement.userId) && spanningUsers.has(placement.userId!)),
      message: `consider consolidating ${placementPolicy?.usersSpanningWorkers ?? 0} user affinity group(s) that currently span multiple workers`
    });
  }
  if ((placementPolicy?.workersAboveSoftCapacity ?? 0) > 0) {
    recommendations.push({
      kind: "rebalance_soft_capacity",
      priority: "medium",
      workspaceCount: 0,
      workerCount: placementPolicy?.workersAboveSoftCapacity ?? 0,
      sampleWorkerIds: sampleWorkerIds((placement) => overloadedWorkers.has(placement.ownerWorkerId ?? "")),
      message: `rebalance placements away from ${placementPolicy?.workersAboveSoftCapacity ?? 0} worker(s) above the soft slots-per-pod capacity`
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
    case "consolidate_user_affinity":
      return ["user_affinity_split"];
    case "rebalance_soft_capacity":
      return ["soft_capacity_exceeded"];
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
    ...(recommendation.sampleUserIds ? { userIds: recommendation.sampleUserIds } : {}),
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
  slotsPerPod?: number | undefined;
}): ControllerPlacementExecutionOperation[] {
  const placements = (input.placements ?? []) as ControllerWorkspacePlacementEntry[];
  if (placements.length === 0) {
    return [];
  }

  const workerHealthById = new Map((input.activeWorkers ?? []).map((worker) => [worker.workerId, worker.health]));
  const workerStateById = new Map((input.activeWorkers ?? []).map((worker) => [worker.workerId, worker.state]));
  const nonEvictedPlacements = placements.filter((placement) => placement.state !== "evicted");
  const scheduledWorkspaceIds = new Set<string>();
  const operations: ControllerPlacementExecutionOperation[] = [];
  const softCapacity = Math.max(1, input.slotsPerPod ?? 1);
  const workerRefLoads = new Map<string, number>();
  const userWorkers = new Map<string, Set<string>>();

  for (const placement of nonEvictedPlacements) {
    if (placement.userId && placement.ownerWorkerId && placement.state !== "unassigned") {
      const workers = userWorkers.get(placement.userId) ?? new Set<string>();
      workers.add(placement.ownerWorkerId);
      userWorkers.set(placement.userId, workers);
    }
    if (placement.ownerWorkerId && placement.state !== "unassigned") {
      const refLoad =
        typeof placement.refCount === "number" ? Math.max(0, placement.refCount) : placement.state === "active" ? 1 : 0;
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + refLoad);
    }
  }

  const overloadedWorkers = new Set(
    [...workerRefLoads.entries()].filter(([, load]) => load > softCapacity).map(([workerId]) => workerId)
  );

  const selectTargetWorker = (placement: RedisWorkspacePlacementEntry, excludeWorkerIds?: Iterable<string>) => {
    const excluded = new Set(excludeWorkerIds ?? []);
    const candidateWorkers = (input.activeWorkers ?? []).filter(
      (worker) => worker.health === "healthy" && worker.state !== "stopping" && !excluded.has(worker.workerId)
    );
    if (candidateWorkers.length === 0) {
      return undefined;
    }

    const workerUserAffinities = placement.userId
      ? candidateWorkers
          .map((worker) => ({
            workerId: worker.workerId,
            workspaceCount: nonEvictedPlacements.filter(
              (item) =>
                item.userId === placement.userId &&
                item.workspaceId !== placement.workspaceId &&
                item.ownerWorkerId === worker.workerId &&
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
      ...(placement.userId ? { userId: placement.userId } : {}),
      ...(workerUserAffinities && workerUserAffinities.length > 0 ? { workerUserAffinities } : {})
    });
    const preferredCandidate = affinity.candidates.find(
      (candidate) => candidate.health === "healthy" && candidate.state !== "stopping"
    );
    return preferredCandidate
      ? {
          workerId: preferredCandidate.workerId,
          reasons: preferredCandidate.reasons
        }
      : undefined;
  };

  for (const placement of placements) {
    if (placement.state === "evicted") {
      continue;
    }

    if (!placement.ownerWorkerId || placement.state === "unassigned") {
      const target = selectTargetWorker(placement);
      if (target && target.workerId !== placement.preferredWorkerId) {
        operations.push({
          id: `assign_unassigned:${placement.workspaceId}`,
          kind: "assign_unassigned",
          workspaceId: placement.workspaceId,
          state: placement.state,
          action: "set_preferred_worker",
          reason: "unassigned_workspace",
          targetWorkerId: target.workerId,
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
          ? target && target.workerId !== placement.preferredWorkerId
            ? {
                id: `reassign_late_owner:${placement.workspaceId}`,
                kind: "reassign_late_owner",
                workspaceId: placement.workspaceId,
                ownerWorkerId: placement.ownerWorkerId,
                state: placement.state,
                action: "set_preferred_worker",
                reason: "owner_late",
                targetWorkerId: target.workerId,
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
      !placement.userId ||
      (userWorkers.get(placement.userId)?.size ?? 0) <= 1 ||
      (placement.state !== "idle" && placement.state !== "unassigned")
    ) {
      continue;
    }

    const target = selectTargetWorker(placement);
    if (!target || target.workerId === placement.ownerWorkerId || target.workerId === placement.preferredWorkerId) {
      continue;
    }

    operations.push({
      id: `consolidate_user_affinity:${placement.workspaceId}`,
      kind: "consolidate_user_affinity",
      workspaceId: placement.workspaceId,
      ...(placement.ownerWorkerId ? { ownerWorkerId: placement.ownerWorkerId } : {}),
      state: placement.state,
      action: "set_preferred_worker",
      reason: "user_affinity_split",
      targetWorkerId: target.workerId,
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
    if (!target || target.workerId === placement.preferredWorkerId) {
      continue;
    }

    operations.push({
      id: `rebalance_soft_capacity:${placement.workspaceId}`,
      kind: "rebalance_soft_capacity",
      workspaceId: placement.workspaceId,
      ownerWorkerId: placement.ownerWorkerId,
      state: placement.state,
      action: "set_preferred_worker",
      reason: "soft_capacity_exceeded",
      targetWorkerId: target.workerId,
      targetWorkerReasons: target.reasons
    });
  }

  return operations.sort((left, right) => left.id.localeCompare(right.id));
}

export function createPlacementRegistryActionExecutor(options: {
  placementRegistry: ControllerPlacementOwnershipRegistry;
  slotsPerPod?: number | undefined;
  logger?: ControllerLogger | undefined;
}): ControllerPlacementExecutor {
  return {
    async execute(input) {
      const operations = buildPlacementExecutionOperations({
        placements: input.placements,
        activeWorkers: input.activeWorkers,
        slotsPerPod: options.slotsPerPod
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
  readonly #scaleTarget?: WorkerReplicaTarget | undefined;
  readonly #logger?: ControllerLogger | undefined;
  readonly #healthProbe: ControllerHealthProbe;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #lastScaleUpAtMs: number | undefined;
  #lastScaleDownAtMs: number | undefined;
  #scaleUpPressureStreak = 0;
  #scaleDownPressureStreak = 0;
  #snapshot: ControllerSnapshot;

  constructor(options: {
    queue: SessionRunQueue;
    registry: WorkerRegistry;
    placementRegistry?: WorkspacePlacementRegistry | undefined;
    placementExecutor?: ControllerPlacementExecutor | undefined;
    config: StandaloneControllerConfig;
    scaleTarget?: WorkerReplicaTarget | undefined;
    logger?: ControllerLogger | undefined;
    healthProbe?: ControllerHealthProbe | undefined;
  }) {
    this.#queue = options.queue;
    this.#registry = options.registry;
    this.#placementRegistry = options.placementRegistry;
    this.#placementExecutor = options.placementExecutor;
    this.#config = options.config;
    this.#scaleTarget = options.scaleTarget;
    this.#logger = options.logger;
    this.#healthProbe = options.healthProbe ?? defaultControllerHealthProbe;
    this.#snapshot = {
      running: false,
      minReplicas: options.config.minReplicas,
      maxReplicas: options.config.maxReplicas,
      slotsPerPod: options.config.slotsPerPod,
      suggestedReplicas: options.config.minReplicas,
      desiredReplicas: options.config.minReplicas,
      suggestedWorkers: options.config.minReplicas * options.config.slotsPerPod,
      activeReplicas: 0,
      busyReplicas: 0,
      activeSlots: 0,
      busySlots: 0,
      idleSlots: 0,
      readySessionsPerWorker: options.config.readySessionsPerWorker,
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
    const { fleet, suggestedWorkers, suggestedReplicas } = calculateStandaloneWorkerReplicas({
      config: this.#config,
      activeWorkers,
      schedulingPressure
    });
    let placementSummary = summarizeWorkspacePlacements(workspacePlacements, activeWorkers);
    let placementPolicy = summarizePlacementPolicy({
      placements: workspacePlacements,
      activeWorkers,
      slotsPerPod: this.#config.slotsPerPod
    });
    let placementRecommendations = summarizePlacementRecommendations({
      placementSummary,
      placementPolicy,
      placements: workspacePlacements,
      activeWorkers,
      slotsPerPod: this.#config.slotsPerPod
    });
    let placementActionPlan = summarizePlacementActionPlan(placementRecommendations);
    const timestamp = new Date().toISOString();
    const placementExecution =
      this.#placementExecutor && workspacePlacements
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
        slotsPerPod: this.#config.slotsPerPod
      });
      placementRecommendations = summarizePlacementRecommendations({
        placementSummary,
        placementPolicy,
        placements: workspacePlacements,
        activeWorkers,
        slotsPerPod: this.#config.slotsPerPod
      });
      placementActionPlan = summarizePlacementActionPlan(placementRecommendations);
    }
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
      slotsPerPod: this.#config.slotsPerPod,
      suggestedReplicas,
      desiredReplicas,
      suggestedWorkers,
      activeReplicas: fleet.activeReplicas,
      busyReplicas: fleet.busyReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      idleSlots: fleet.idleSlots,
      readySessionsPerWorker: this.#config.readySessionsPerWorker,
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

    this.#logger?.info?.(
      `[controller] rebalance=${rebalanceReason} activeReplicas=${fleet.activeReplicas} desiredReplicas=${desiredReplicas} suggestedReplicas=${suggestedReplicas} activeSlots=${fleet.activeSlots} busySlots=${fleet.busySlots} readySessions=${schedulingPressure?.readySessionCount ?? "n/a"} scaleDownAllowed=${scaleDownGate ? (scaleDownGate.allowed ? "yes" : "no") : "n/a"} scaleDownBlockedReplicas=${scaleDownGate?.blockedReplicas ?? 0} placementMissingOwners=${placementSummary?.ownedByMissingWorkers ?? 0} placementLateOwners=${placementSummary?.ownedByLateWorkers ?? 0} placementUsersSpanningWorkers=${placementPolicy?.usersSpanningWorkers ?? 0} placementWorkersAboveSoftCapacity=${placementPolicy?.workersAboveSoftCapacity ?? 0} placementRecommendations=${placementRecommendations?.length ?? 0} placementActionItems=${placementActionPlan?.totalItems ?? 0} target=${scaleTarget?.kind ?? "none"} targetOutcome=${scaleTarget?.outcome ?? "n/a"}`
    );

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
