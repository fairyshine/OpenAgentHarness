import {
  buildRedisWorkerAffinitySummary,
  calculateRedisWorkerPoolSuggestion,
  type RedisWorkspacePlacementEntry,
  type RedisWorkerRegistryEntry,
  type SessionRunQueuePressure
} from "@oah/storage-redis-control";

import type { SandboxFleetConfig, StandaloneControllerConfig } from "./controller-config.js";
import type {
  ControllerPlacementActionItem,
  ControllerPlacementActionPlan,
  ControllerPlacementExecutionOperation,
  ControllerPlacementPolicySummary,
  ControllerPlacementRecommendation,
  ControllerPlacementSummary,
  ControllerSandboxFleetSummary,
  ControllerWorkspacePlacementEntry,
  StandaloneWorkerFleetSummary
} from "./controller-types.js";

function placementOwnerAffinityId(placement: Pick<RedisWorkspacePlacementEntry, "ownerId">): string | undefined {
  const ownerId = placement.ownerId?.trim();
  return ownerId || undefined;
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

function workspacePlacementLoad(placement: Pick<RedisWorkspacePlacementEntry, "refCount" | "state">): number {
  if (placement.state === "evicted" || placement.state === "unassigned") {
    return 0;
  }

  if (typeof placement.refCount === "number") {
    return Math.max(0, placement.refCount);
  }

  return 1;
}

function workerResourcePressure(
  worker: Pick<RedisWorkerRegistryEntry, "resourceCpuLoadRatio" | "resourceMemoryUsedRatio" | "resourceDiskUsedRatio">,
  config: Pick<
    SandboxFleetConfig,
    "resourceCpuPressureThreshold" | "resourceMemoryPressureThreshold" | "resourceDiskPressureThreshold"
  >
): { pressure: number; pressureExceeded: boolean; hasMetrics: boolean } {
  const cpuThreshold = Math.max(0.01, config.resourceCpuPressureThreshold);
  const memoryThreshold = Math.max(0.01, config.resourceMemoryPressureThreshold);
  const diskThreshold = Math.max(0.01, config.resourceDiskPressureThreshold);
  const cpuPressure =
    typeof worker.resourceCpuLoadRatio === "number" && Number.isFinite(worker.resourceCpuLoadRatio)
      ? worker.resourceCpuLoadRatio / cpuThreshold
      : undefined;
  const memoryPressure =
    typeof worker.resourceMemoryUsedRatio === "number" && Number.isFinite(worker.resourceMemoryUsedRatio)
      ? worker.resourceMemoryUsedRatio / memoryThreshold
      : undefined;
  const diskPressure =
    typeof worker.resourceDiskUsedRatio === "number" && Number.isFinite(worker.resourceDiskUsedRatio)
      ? worker.resourceDiskUsedRatio / diskThreshold
      : undefined;
  const pressures = [cpuPressure, memoryPressure, diskPressure].filter((value): value is number => typeof value === "number");
  const pressure = pressures.length > 0 ? Math.max(...pressures) : 0;

  return {
    pressure,
    pressureExceeded: pressure > 1,
    hasMetrics: pressures.length > 0
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
  activeWorkers?: RedisWorkerRegistryEntry[] | undefined;
  config: SandboxFleetConfig;
}): ControllerSandboxFleetSummary {
  const trackedPlacements = (input.placements ?? []).filter((placement) => placement.state !== "evicted");
  const ownerWorkspaceCounts = new Map<string, number>();
  const workerRefLoads = new Map<string, number>();
  let ownerlessWorkspaces = 0;

  for (const placement of trackedPlacements) {
    const ownerId = placementOwnerAffinityId(placement);
    if (ownerId) {
      ownerWorkspaceCounts.set(ownerId, (ownerWorkspaceCounts.get(ownerId) ?? 0) + 1);
    } else {
      ownerlessWorkspaces += 1;
    }
    if (placement.ownerWorkerId && placement.state !== "unassigned") {
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + workspacePlacementLoad(placement));
    }
  }

  const observedSandboxRefs = new Set<string>();
  const healthySandboxRefs = new Set<string>();
  const pressuredSandboxRefs = new Set<string>();
  const healthySandboxWorkers: Array<{ workerId: string; placementReference: string }> = [];
  for (const worker of input.activeWorkers ?? []) {
    if (worker.processKind !== "standalone") {
      continue;
    }

    const ref = workerPlacementReference(worker);
    observedSandboxRefs.add(ref);
    if (worker.health === "healthy") {
      healthySandboxRefs.add(ref);
      healthySandboxWorkers.push({
        workerId: worker.workerId,
        placementReference: ref
      });
      if (workerResourcePressure(worker, input.config).pressureExceeded) {
        pressuredSandboxRefs.add(ref);
      }
    }
  }
  const emptySandboxRefs = new Set(
    healthySandboxWorkers
      .filter((worker) => (workerRefLoads.get(worker.placementReference) ?? workerRefLoads.get(worker.workerId) ?? 0) === 0)
      .map((worker) => worker.placementReference)
  );
  const emptySandboxes = emptySandboxRefs.size;
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
  const warmEmptySandboxes = input.config.managedByController ? Math.max(0, input.config.warmEmptyCount ?? 0) : 0;
  const loadedPressuredSandboxRefs = [...pressuredSandboxRefs].filter(
    (ref) => (workerRefLoads.get(ref) ?? 0) > 0
  );
  const pressureReserveSandboxes = input.config.managedByController ? loadedPressuredSandboxRefs.length : 0;
  const targetSandboxes = logicalSandboxes + warmEmptySandboxes + pressureReserveSandboxes;
  const desiredSandboxes = input.config.managedByController
    ? Math.max(input.config.minCount, Math.min(input.config.maxCount, targetSandboxes))
    : 0;

  return {
    providerKind: input.config.providerKind,
    managedByController: input.config.managedByController,
    minSandboxes: input.config.minCount,
    maxSandboxes: input.config.maxCount,
    maxWorkspacesPerSandbox: input.config.maxWorkspacesPerSandbox,
    ownerlessPool: input.config.ownerlessPool,
    warmEmptySandboxes,
    resourceCpuPressureThreshold: input.config.resourceCpuPressureThreshold,
    resourceMemoryPressureThreshold: input.config.resourceMemoryPressureThreshold,
    resourceDiskPressureThreshold: input.config.resourceDiskPressureThreshold,
    observedSandboxes: observedSandboxRefs.size,
    healthySandboxes: healthySandboxRefs.size,
    pressuredSandboxes: pressuredSandboxRefs.size,
    emptySandboxes,
    pressureReserveSandboxes,
    trackedWorkspaces: trackedPlacements.length,
    ownerScopedWorkspaces,
    ownerlessWorkspaces,
    ownerGroups: ownerWorkspaceCounts.size,
    ownerScopedSandboxes,
    ownerlessSandboxes,
    sharedSandboxes: input.config.ownerlessPool === "shared" ? ownerlessSandboxes : 0,
    logicalSandboxes,
    desiredSandboxes,
    capped: input.config.managedByController && targetSandboxes > input.config.maxCount
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

    workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + workspacePlacementLoad(placement));
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
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + workspacePlacementLoad(placement));
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
  resourceCpuPressureThreshold?: number | undefined;
  resourceMemoryPressureThreshold?: number | undefined;
  resourceDiskPressureThreshold?: number | undefined;
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
  const resourceThresholds = {
    resourceCpuPressureThreshold: Math.max(0.01, input.resourceCpuPressureThreshold ?? 0.8),
    resourceMemoryPressureThreshold: Math.max(0.01, input.resourceMemoryPressureThreshold ?? 0.8),
    resourceDiskPressureThreshold: Math.max(0.01, input.resourceDiskPressureThreshold ?? 0.85)
  };
  const workerRefLoads = new Map<string, number>();
  const scheduledWorkerLoads = new Map<string, number>();
  const ownerAffinityWorkers = new Map<string, Set<string>>();

  for (const placement of nonEvictedPlacements) {
    const ownerId = placementOwnerAffinityId(placement);
    if (ownerId && placement.ownerWorkerId && placement.state !== "unassigned") {
      const workers = ownerAffinityWorkers.get(ownerId) ?? new Set<string>();
      workers.add(placement.ownerWorkerId);
      ownerAffinityWorkers.set(ownerId, workers);
    }
    if (placement.ownerWorkerId && placement.state !== "unassigned") {
      workerRefLoads.set(placement.ownerWorkerId, (workerRefLoads.get(placement.ownerWorkerId) ?? 0) + workspacePlacementLoad(placement));
    }
  }

  const overloadedWorkers = new Set(
    [...workerRefLoads.entries()].filter(([, load]) => load > workspaceCapacity).map(([workerId]) => workerId)
  );

  const selectTargetWorker = (
    placement: RedisWorkspacePlacementEntry,
    excludeWorkerIds?: Iterable<string>,
    options?: { loadAware?: boolean | undefined }
  ) => {
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
    const loadAware = options?.loadAware ?? !ownerId;
    const reserveEmptyForOwnerless = loadAware && !ownerId;
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
    const preferredCandidate = affinity.candidates
      .filter((candidate) => candidate.health === "healthy" && candidate.state !== "stopping")
      .map((candidate) => {
        const worker = candidateWorkers.find((item) => item.workerId === candidate.workerId);
        const placementReference = worker ? workerPlacementReference(worker) : candidate.workerId;
        const placementLoad = (workerRefLoads.get(placementReference) ?? 0) + (scheduledWorkerLoads.get(placementReference) ?? 0);
        const projectedLoad = placementLoad + 1;
        const capacityPressure = Math.max(0, projectedLoad - workspaceCapacity);
        const resource = worker ? workerResourcePressure(worker, resourceThresholds) : { pressure: 0, pressureExceeded: false, hasMetrics: false };
        const loadAdjustedScore = loadAware ? candidate.score - placementLoad * 35 - capacityPressure * 160 : candidate.score;
        const warmReserveRank = !reserveEmptyForOwnerless
          ? 0
          : placementLoad > 0 && capacityPressure === 0 && !resource.pressureExceeded
            ? 2
            : placementLoad === 0
              ? 1
              : 0;
        return {
          ...candidate,
          placementReference,
          placementLoad,
          projectedLoad,
          capacityPressure,
          resourcePressure: resource.pressure,
          resourcePressureExceeded: resource.pressureExceeded,
          hasResourceMetrics: resource.hasMetrics,
          warmReserveRank,
          loadAdjustedScore
        };
      })
      .sort(
        (left, right) =>
          right.warmReserveRank - left.warmReserveRank ||
          (loadAware ? left.resourcePressure - right.resourcePressure : 0) ||
          right.loadAdjustedScore - left.loadAdjustedScore ||
          (loadAware ? left.capacityPressure - right.capacityPressure : 0) ||
          (loadAware ? left.projectedLoad - right.projectedLoad : 0) ||
          right.matchingOwnerWorkspaces - left.matchingOwnerWorkspaces ||
          (right.idleSlots ?? 0) - (left.idleSlots ?? 0) ||
          left.workerId.localeCompare(right.workerId)
      )[0];
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
      reasons: [
        ...preferredCandidate.reasons,
        preferredCandidate.hasResourceMetrics
          ? preferredCandidate.resourcePressureExceeded
            ? "resource_pressure"
            : "resource_available"
          : "resource_unknown",
        preferredCandidate.capacityPressure > 0 ? "workspace_capacity_pressure" : "workspace_capacity_available",
        preferredCandidate.placementLoad === 0 ? "empty_sandbox" : "lower_workspace_load"
      ]
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
        scheduledWorkerLoads.set(target.placementReference, (scheduledWorkerLoads.get(target.placementReference) ?? 0) + 1);
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
    if (target) {
      scheduledWorkerLoads.set(target.placementReference, (scheduledWorkerLoads.get(target.placementReference) ?? 0) + 1);
    }
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
    scheduledWorkerLoads.set(target.placementReference, (scheduledWorkerLoads.get(target.placementReference) ?? 0) + 1);
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

    const target = selectTargetWorker(placement, new Set([...overloadedWorkers, placement.ownerWorkerId]), {
      loadAware: true
    });
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
    scheduledWorkerLoads.set(target.placementReference, (scheduledWorkerLoads.get(target.placementReference) ?? 0) + 1);
  }

  return operations.sort((left, right) => left.id.localeCompare(right.id));
}
