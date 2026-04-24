export type RedisWorkerAffinityReason =
  | "controller_target"
  | "owner_worker"
  | "same_session"
  | "same_workspace"
  | "same_owner"
  | "healthy"
  | "late"
  | "idle_worker"
  | "busy_worker"
  | "starting_worker"
  | "stopping_worker"
  | "idle_slot_capacity"
  | "slot_saturated";

export interface RedisWorkerAffinityActiveWorkerLike {
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  health: "healthy" | "late";
  currentSessionId?: string | undefined;
  currentWorkspaceId?: string | undefined;
}

export interface RedisWorkerAffinitySlotLike {
  workerId: string;
  state: "starting" | "idle" | "busy" | "stopping";
  currentSessionId?: string | undefined;
  currentWorkspaceId?: string | undefined;
}

export interface RedisWorkerAffinityCandidate {
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  health: "healthy" | "late";
  score: number;
  slotCapacity?: number | undefined;
  idleSlots?: number | undefined;
  busySlots?: number | undefined;
  matchingSessionSlots: number;
  matchingWorkspaceSlots: number;
  matchingOwnerWorkspaces: number;
  reasons: RedisWorkerAffinityReason[];
}

export interface RedisWorkerAffinitySummary {
  preferredWorkerId?: string | undefined;
  controllerTargetWorkerId?: string | undefined;
  sessionAffinityWorkerId?: string | undefined;
  workspaceAffinityWorkerId?: string | undefined;
  ownerAffinityWorkerId?: string | undefined;
  ownerWorkerId?: string | undefined;
  candidates: RedisWorkerAffinityCandidate[];
}

interface RedisWorkerAffinitySlotSummary {
  slotCapacity: number;
  idleSlots: number;
  busySlots: number;
  matchingSessionSlots: number;
  matchingWorkspaceSlots: number;
}

export function buildRedisWorkerAffinitySummary(input: {
  activeWorkers: RedisWorkerAffinityActiveWorkerLike[];
  slots?: RedisWorkerAffinitySlotLike[] | undefined;
  sessionId?: string | undefined;
  workspaceId?: string | undefined;
  ownerId?: string | undefined;
  workerOwnerAffinities?:
    | Array<{
        workerId: string;
        workspaceCount: number;
      }>
    | undefined;
  ownerWorkerId?: string | undefined;
  preferredWorkerId?: string | undefined;
}): RedisWorkerAffinitySummary {
  const workerOwnerAffinityCounts = new Map<string, number>(
    (input.workerOwnerAffinities ?? []).map((entry) => [entry.workerId, entry.workspaceCount])
  );
  const slotSummaries = summarizeSlotsByWorker(input.slots, input.sessionId, input.workspaceId);
  const candidates = input.activeWorkers
    .map((worker) =>
      buildRedisWorkerAffinityCandidate(worker, slotSummaries.get(worker.workerId), workerOwnerAffinityCounts, input)
    )
    .sort(compareRedisWorkerAffinityCandidates);

  const sessionAffinityWorkerId = candidates.find((candidate) => candidate.matchingSessionSlots > 0)?.workerId;
  const workspaceAffinityWorkerId = candidates.find((candidate) => candidate.matchingWorkspaceSlots > 0)?.workerId;
  const ownerAffinityWorkerId = candidates.find((candidate) => candidate.matchingOwnerWorkspaces > 0)?.workerId;
  const controllerTargetWorkerId = candidates.find((candidate) => candidate.reasons.includes("controller_target"))?.workerId;
  const preferredWorkerId =
    candidates.find((candidate) => candidate.health === "healthy" && candidate.state !== "stopping")?.workerId ??
    candidates[0]?.workerId;

  return {
    ...(preferredWorkerId ? { preferredWorkerId } : {}),
    ...(controllerTargetWorkerId ? { controllerTargetWorkerId } : {}),
    ...(sessionAffinityWorkerId ? { sessionAffinityWorkerId } : {}),
    ...(workspaceAffinityWorkerId ? { workspaceAffinityWorkerId } : {}),
    ...(ownerAffinityWorkerId ? { ownerAffinityWorkerId } : {}),
    ...(input.ownerWorkerId ? { ownerWorkerId: input.ownerWorkerId } : {}),
    candidates
  };
}

function buildRedisWorkerAffinityCandidate(
  worker: RedisWorkerAffinityActiveWorkerLike,
  slotSummary: RedisWorkerAffinitySlotSummary | undefined,
  workerOwnerAffinityCounts: Map<string, number>,
  input: {
    sessionId?: string | undefined;
    workspaceId?: string | undefined;
    ownerId?: string | undefined;
    ownerWorkerId?: string | undefined;
    preferredWorkerId?: string | undefined;
  }
): RedisWorkerAffinityCandidate {
  const reasons: RedisWorkerAffinityReason[] = [];
  let score = 0;

  if (input.preferredWorkerId && worker.workerId === input.preferredWorkerId) {
    reasons.push("controller_target");
    score += 320;
  }

  if (input.ownerWorkerId && worker.workerId === input.ownerWorkerId) {
    reasons.push("owner_worker");
    score += 700;
  }

  const matchingSessionSlots =
    slotSummary?.matchingSessionSlots ??
    (input.sessionId && worker.currentSessionId === input.sessionId ? 1 : 0);
  if (matchingSessionSlots > 0) {
    reasons.push("same_session");
    score += 500 + matchingSessionSlots * 25;
  }

  const matchingWorkspaceSlots =
    slotSummary?.matchingWorkspaceSlots ??
    (input.workspaceId && worker.currentWorkspaceId === input.workspaceId ? 1 : 0);
  if (matchingWorkspaceSlots > 0) {
    reasons.push("same_workspace");
    score += 250 + matchingWorkspaceSlots * 10;
  }

  const matchingOwnerWorkspaces = input.ownerId ? (workerOwnerAffinityCounts.get(worker.workerId) ?? 0) : 0;
  if (matchingOwnerWorkspaces > 0) {
    reasons.push("same_owner");
    score += 140 + matchingOwnerWorkspaces * 15;
  }

  if (worker.health === "healthy") {
    reasons.push("healthy");
    score += 100;
  } else {
    reasons.push("late");
    score -= 200;
  }

  if ((slotSummary?.idleSlots ?? 0) > 0) {
    reasons.push("idle_slot_capacity");
    score += 80 + (slotSummary?.idleSlots ?? 0) * 5;
  } else if ((slotSummary?.busySlots ?? 0) > 0) {
    reasons.push("slot_saturated");
    score -= 40 + (slotSummary?.busySlots ?? 0) * 5;
  } else if (worker.state === "idle") {
    reasons.push("idle_worker");
    score += 70;
  } else if (worker.state === "busy") {
    reasons.push("busy_worker");
    score -= 20;
  } else if (worker.state === "starting") {
    reasons.push("starting_worker");
    score += 10;
  } else {
    reasons.push("stopping_worker");
    score -= 250;
  }

  return {
    workerId: worker.workerId,
    processKind: worker.processKind,
    state: worker.state,
    health: worker.health,
    score,
    ...(slotSummary ? { slotCapacity: slotSummary.slotCapacity } : {}),
    ...(slotSummary ? { idleSlots: slotSummary.idleSlots } : {}),
    ...(slotSummary ? { busySlots: slotSummary.busySlots } : {}),
    matchingSessionSlots,
    matchingWorkspaceSlots,
    matchingOwnerWorkspaces,
    reasons
  };
}

function summarizeSlotsByWorker(
  slots: RedisWorkerAffinitySlotLike[] | undefined,
  sessionId: string | undefined,
  workspaceId: string | undefined
): Map<string, RedisWorkerAffinitySlotSummary> {
  const summaries = new Map<string, RedisWorkerAffinitySlotSummary>();
  for (const slot of slots ?? []) {
    const current = summaries.get(slot.workerId) ?? {
      slotCapacity: 0,
      idleSlots: 0,
      busySlots: 0,
      matchingSessionSlots: 0,
      matchingWorkspaceSlots: 0
    };
    current.slotCapacity += 1;
    if (slot.state === "idle") {
      current.idleSlots += 1;
    }
    if (slot.state === "busy") {
      current.busySlots += 1;
    }
    if (sessionId && slot.currentSessionId === sessionId) {
      current.matchingSessionSlots += 1;
    }
    if (workspaceId && slot.currentWorkspaceId === workspaceId) {
      current.matchingWorkspaceSlots += 1;
    }
    summaries.set(slot.workerId, current);
  }

  return summaries;
}

function compareRedisWorkerAffinityCandidates(
  left: RedisWorkerAffinityCandidate,
  right: RedisWorkerAffinityCandidate
): number {
  return (
    right.score - left.score ||
    right.matchingSessionSlots - left.matchingSessionSlots ||
    right.matchingWorkspaceSlots - left.matchingWorkspaceSlots ||
    (right.idleSlots ?? 0) - (left.idleSlots ?? 0) ||
    left.workerId.localeCompare(right.workerId)
  );
}
