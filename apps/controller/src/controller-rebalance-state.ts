import type { SessionRunQueuePressure } from "@oah/storage-redis-control";

import type { WorkerReplicaTargetResult } from "./scale-target.js";
import type {
  ControllerDecision,
  ControllerLoggedState,
  ControllerPlacementActionPlan,
  ControllerPlacementExecutionReport,
  ControllerPlacementPolicySummary,
  ControllerPlacementRecommendation,
  ControllerPlacementSummary,
  ControllerRebalanceReason,
  ControllerSandboxFleetSummary,
  ControllerScaleDownGate
} from "./controller-types.js";

export function appendDecision(decisions: ControllerDecision[], nextDecision: ControllerDecision, maxEntries = 8) {
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

export function buildControllerLoggedState(input: {
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

export function shouldLogControllerRebalance(
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

export function formatControllerRebalanceLog(input: ControllerLoggedState): string {
  return `[controller] rebalance=${input.reason} activeReplicas=${input.activeReplicas} desiredReplicas=${input.desiredReplicas} suggestedReplicas=${input.suggestedReplicas} activeSlots=${input.activeSlots} busySlots=${input.busySlots} effectiveCapacityPerReplica=${input.effectiveCapacityPerReplica} readySessions=${input.readySessionCount ?? "n/a"} scaleDownAllowed=${typeof input.scaleDownAllowed === "boolean" ? (input.scaleDownAllowed ? "yes" : "no") : "n/a"} scaleDownBlockedReplicas=${input.scaleDownBlockedReplicas} sandboxProvider=${input.sandboxProvider} sandboxDesired=${input.sandboxDesired} sandboxLogical=${input.sandboxLogical} sandboxOwnerGroups=${input.sandboxOwnerGroups} placementMissingOwners=${input.placementMissingOwners} placementLateOwners=${input.placementLateOwners} placementOwnersSpanningWorkers=${input.placementOwnersSpanningWorkers} placementSandboxesAboveWorkspaceCapacity=${input.placementSandboxesAboveWorkspaceCapacity} placementRecommendations=${input.placementRecommendations} placementActionItems=${input.placementActionItems} placementExecutionAttempted=${input.placementExecutionAttempted} placementExecutionApplied=${input.placementExecutionApplied} placementExecutionSkipped=${input.placementExecutionSkipped} placementExecutionFailed=${input.placementExecutionFailed} target=${input.targetKind} targetOutcome=${input.targetOutcome}`;
}

export function cooldownRemainingMs(lastChangeAtMs: number | undefined, cooldownMs: number, nowMs: number): number {
  if (!lastChangeAtMs || cooldownMs <= 0) {
    return 0;
  }

  return Math.max(0, lastChangeAtMs + cooldownMs - nowMs);
}

