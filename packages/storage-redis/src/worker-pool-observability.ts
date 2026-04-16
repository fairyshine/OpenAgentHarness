interface SessionRunQueuePressureLike {
  readySessionCount: number;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export type RedisRunWorkerPoolRebalanceReason =
  | "startup"
  | "steady"
  | "scale_up"
  | "scale_down"
  | "cooldown_hold"
  | "shutdown";

export interface RedisRunWorkerPoolDecisionLike {
  timestamp: string;
  reason: RedisRunWorkerPoolRebalanceReason;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity?: number | undefined;
  reservedWorkers?: number | undefined;
  availableIdleCapacity?: number | undefined;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget?: number | undefined;
  subagentReserveDeficit?: number | undefined;
  desiredWorkers: number;
  activeWorkers: number;
  busyWorkers?: number | undefined;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface RedisRunWorkerPoolSlotSnapshotLike {
  slotId: string;
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  currentSessionId?: string | undefined;
  currentRunId?: string | undefined;
  currentWorkspaceId?: string | undefined;
}

export interface RedisRunWorkerPoolSnapshotLike {
  running: boolean;
  processKind: "embedded" | "standalone";
  sessionSerialBoundary: "session";
  minWorkers: number;
  maxWorkers: number;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity: number;
  reservedWorkers?: number | undefined;
  availableIdleCapacity: number;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget: number;
  subagentReserveDeficit: number;
  desiredWorkers: number;
  slotCapacity: number;
  slots: RedisRunWorkerPoolSlotSnapshotLike[];
  activeWorkers: number;
  busySlots: number;
  idleSlots: number;
  busyWorkers: number;
  idleWorkers: number;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionsPerCapacityUnit: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
  lastRebalanceAt?: string | undefined;
  lastRebalanceReason?: RedisRunWorkerPoolRebalanceReason | undefined;
  scaleUpPressureStreak: number;
  scaleDownPressureStreak: number;
  scaleUpCooldownRemainingMs: number;
  scaleDownCooldownRemainingMs: number;
  recentDecisions: RedisRunWorkerPoolDecisionLike[];
}

export interface RedisRunWorkerPoolLoggedState {
  desiredWorkers: number;
  activeWorkers: number;
}

export function buildRedisRunWorkerPoolDecision(input: {
  timestamp: string;
  reason: RedisRunWorkerPoolRebalanceReason;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity?: number | undefined;
  reservedWorkers?: number | undefined;
  availableIdleCapacity?: number | undefined;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget?: number | undefined;
  subagentReserveDeficit?: number | undefined;
  desiredWorkers: number;
  activeWorkers: number;
  busyWorkers: number;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}): RedisRunWorkerPoolDecisionLike {
  return {
    timestamp: input.timestamp,
    reason: input.reason,
    suggestedWorkers: input.suggestedWorkers,
    ...(typeof input.globalSuggestedWorkers === "number" ? { globalSuggestedWorkers: input.globalSuggestedWorkers } : {}),
    ...(typeof input.reservedSubagentCapacity === "number" ? { reservedSubagentCapacity: input.reservedSubagentCapacity } : {}),
    ...(typeof input.reservedWorkers === "number" ? { reservedWorkers: input.reservedWorkers } : {}),
    ...(typeof input.availableIdleCapacity === "number" ? { availableIdleCapacity: input.availableIdleCapacity } : {}),
    ...(typeof input.readySessionsPerActiveWorker === "number"
      ? { readySessionsPerActiveWorker: input.readySessionsPerActiveWorker }
      : {}),
    ...(typeof input.subagentReserveTarget === "number" ? { subagentReserveTarget: input.subagentReserveTarget } : {}),
    ...(typeof input.subagentReserveDeficit === "number" ? { subagentReserveDeficit: input.subagentReserveDeficit } : {}),
    desiredWorkers: input.desiredWorkers,
    activeWorkers: input.activeWorkers,
    ...(input.busyWorkers > 0 ? { busyWorkers: input.busyWorkers } : {}),
    ...(typeof input.globalActiveWorkers === "number" ? { globalActiveWorkers: input.globalActiveWorkers } : {}),
    ...(typeof input.globalBusyWorkers === "number" ? { globalBusyWorkers: input.globalBusyWorkers } : {}),
    ...(typeof input.remoteActiveWorkers === "number" ? { remoteActiveWorkers: input.remoteActiveWorkers } : {}),
    ...(typeof input.remoteBusyWorkers === "number" ? { remoteBusyWorkers: input.remoteBusyWorkers } : {}),
    ...(typeof input.readySessionCount === "number" ? { readySessionCount: input.readySessionCount } : {}),
    ...(typeof input.readyQueueDepth === "number" ? { readyQueueDepth: input.readyQueueDepth } : {}),
    ...(typeof input.uniqueReadySessionCount === "number" ? { uniqueReadySessionCount: input.uniqueReadySessionCount } : {}),
    ...(typeof input.subagentReadySessionCount === "number" ? { subagentReadySessionCount: input.subagentReadySessionCount } : {}),
    ...(typeof input.subagentReadyQueueDepth === "number" ? { subagentReadyQueueDepth: input.subagentReadyQueueDepth } : {}),
    ...(typeof input.lockedReadySessionCount === "number" ? { lockedReadySessionCount: input.lockedReadySessionCount } : {}),
    ...(typeof input.staleReadySessionCount === "number" ? { staleReadySessionCount: input.staleReadySessionCount } : {}),
    ...(typeof input.oldestSchedulableReadyAgeMs === "number"
      ? { oldestSchedulableReadyAgeMs: input.oldestSchedulableReadyAgeMs }
      : {})
  };
}

export function appendRedisRunWorkerPoolDecision<T extends RedisRunWorkerPoolDecisionLike>(
  decisions: T[],
  nextDecision: T,
  maxEntries = 8
): T[] {
  const lastDecision = decisions.at(-1);
  if (lastDecision && areRedisRunWorkerPoolDecisionsEquivalent(lastDecision, nextDecision)) {
    return [...decisions];
  }

  const next = [...decisions, nextDecision];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

export function shouldLogRedisRunWorkerPoolRebalance(
  lastLoggedState: RedisRunWorkerPoolLoggedState | undefined,
  input: {
    desiredWorkers: number;
    activeWorkers: number;
    reason: RedisRunWorkerPoolRebalanceReason;
  }
): boolean {
  if (input.reason === "shutdown") {
    return true;
  }

  return !(
    lastLoggedState?.desiredWorkers === input.desiredWorkers &&
    lastLoggedState.activeWorkers === input.activeWorkers
  );
}

export function formatRedisRunWorkerPoolRebalanceLog(input: {
  reason: RedisRunWorkerPoolRebalanceReason;
  activeWorkers: number;
  desiredWorkers: number;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity: number;
  reservedWorkers?: number | undefined;
  availableIdleCapacity: number;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget: number;
  subagentReserveDeficit: number;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  busyWorkers: number;
  minWorkers: number;
  maxWorkers: number;
  scaleUpPressureStreak: number;
  scaleUpSampleSize: number;
  scaleDownPressureStreak: number;
  scaleDownSampleSize: number;
  schedulingPressure?: SessionRunQueuePressureLike | undefined;
}): string {
  return `Redis worker pool rebalance (${input.reason}): active=${input.activeWorkers}, desired=${input.desiredWorkers}, suggested=${input.suggestedWorkers}, globalSuggested=${
    optionalNumber(input.globalSuggestedWorkers)
  }, reservedSubagentCapacity=${input.reservedSubagentCapacity}, reservedWorkers=${optionalNumber(
    input.reservedWorkers
  )}, availableIdleCapacity=${input.availableIdleCapacity}, readyPerWorker=${optionalNumber(
    input.readySessionsPerActiveWorker
  )}, subagentReserveTarget=${input.subagentReserveTarget}, subagentReserveDeficit=${input.subagentReserveDeficit}, globalActive=${optionalNumber(
    input.globalActiveWorkers
  )}, globalBusy=${optionalNumber(input.globalBusyWorkers)}, remoteActive=${optionalNumber(
    input.remoteActiveWorkers
  )}, remoteBusy=${optionalNumber(input.remoteBusyWorkers)}, schedulableSessions=${optionalNumber(
    input.schedulingPressure?.readySessionCount
  )}, busyWorkers=${input.busyWorkers}, readyDepth=${optionalNumber(input.schedulingPressure?.readyQueueDepth)}, uniqueReady=${optionalNumber(
    input.schedulingPressure?.uniqueReadySessionCount
  )}, subagentSchedulable=${optionalNumber(input.schedulingPressure?.subagentReadySessionCount)}, subagentDepth=${optionalNumber(
    input.schedulingPressure?.subagentReadyQueueDepth
  )}, lockedReady=${optionalNumber(input.schedulingPressure?.lockedReadySessionCount)}, staleReady=${optionalNumber(
    input.schedulingPressure?.staleReadySessionCount
  )}, oldestReadyAgeMs=${optionalNumber(
    input.schedulingPressure?.oldestSchedulableReadyAgeMs
  )}, upStreak=${input.scaleUpPressureStreak}/${input.scaleUpSampleSize}, downStreak=${input.scaleDownPressureStreak}/${input.scaleDownSampleSize}, min=${
    input.minWorkers
  }, max=${input.maxWorkers}.`;
}

export function buildRedisRunWorkerPoolSnapshot(input: {
  running: boolean;
  processKind: "embedded" | "standalone";
  minWorkers: number;
  maxWorkers: number;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity: number;
  reservedWorkers?: number | undefined;
  availableIdleCapacity: number;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget: number;
  subagentReserveDeficit: number;
  desiredWorkers: number;
  slots: RedisRunWorkerPoolSlotSnapshotLike[];
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionsPerCapacityUnit: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
  lastRebalanceAt?: string | undefined;
  lastRebalanceReason?: RedisRunWorkerPoolRebalanceReason | undefined;
  scaleUpPressureStreak: number;
  scaleDownPressureStreak: number;
  scaleUpCooldownRemainingMs: number;
  scaleDownCooldownRemainingMs: number;
  recentDecisions: RedisRunWorkerPoolDecisionLike[];
}): RedisRunWorkerPoolSnapshotLike {
  const busySlots = input.slots.filter((slot) => slot.state === "busy").length;
  const idleSlots = input.slots.filter((slot) => slot.state === "idle").length;

  return {
    running: input.running,
    processKind: input.processKind,
    sessionSerialBoundary: "session",
    minWorkers: input.minWorkers,
    maxWorkers: input.maxWorkers,
    suggestedWorkers: input.suggestedWorkers,
    ...(typeof input.globalSuggestedWorkers === "number" ? { globalSuggestedWorkers: input.globalSuggestedWorkers } : {}),
    reservedSubagentCapacity: input.reservedSubagentCapacity,
    ...(typeof input.reservedWorkers === "number" ? { reservedWorkers: input.reservedWorkers } : {}),
    availableIdleCapacity: input.availableIdleCapacity,
    ...(typeof input.readySessionsPerActiveWorker === "number"
      ? { readySessionsPerActiveWorker: input.readySessionsPerActiveWorker }
      : {}),
    subagentReserveTarget: input.subagentReserveTarget,
    subagentReserveDeficit: input.subagentReserveDeficit,
    desiredWorkers: input.desiredWorkers,
    slotCapacity: input.slots.length,
    slots: input.slots,
    activeWorkers: input.slots.length,
    busySlots,
    idleSlots,
    busyWorkers: busySlots,
    idleWorkers: idleSlots,
    ...(typeof input.globalActiveWorkers === "number" ? { globalActiveWorkers: input.globalActiveWorkers } : {}),
    ...(typeof input.globalBusyWorkers === "number" ? { globalBusyWorkers: input.globalBusyWorkers } : {}),
    ...(typeof input.remoteActiveWorkers === "number" ? { remoteActiveWorkers: input.remoteActiveWorkers } : {}),
    ...(typeof input.remoteBusyWorkers === "number" ? { remoteBusyWorkers: input.remoteBusyWorkers } : {}),
    readySessionsPerCapacityUnit: input.readySessionsPerCapacityUnit,
    scaleIntervalMs: input.scaleIntervalMs,
    scaleUpCooldownMs: input.scaleUpCooldownMs,
    scaleDownCooldownMs: input.scaleDownCooldownMs,
    scaleUpSampleSize: input.scaleUpSampleSize,
    scaleDownSampleSize: input.scaleDownSampleSize,
    scaleUpBusyRatioThreshold: input.scaleUpBusyRatioThreshold,
    scaleUpMaxReadyAgeMs: input.scaleUpMaxReadyAgeMs,
    ...(typeof input.readySessionCount === "number" ? { readySessionCount: input.readySessionCount } : {}),
    ...(typeof input.readyQueueDepth === "number" ? { readyQueueDepth: input.readyQueueDepth } : {}),
    ...(typeof input.uniqueReadySessionCount === "number" ? { uniqueReadySessionCount: input.uniqueReadySessionCount } : {}),
    ...(typeof input.subagentReadySessionCount === "number" ? { subagentReadySessionCount: input.subagentReadySessionCount } : {}),
    ...(typeof input.subagentReadyQueueDepth === "number" ? { subagentReadyQueueDepth: input.subagentReadyQueueDepth } : {}),
    ...(typeof input.lockedReadySessionCount === "number" ? { lockedReadySessionCount: input.lockedReadySessionCount } : {}),
    ...(typeof input.staleReadySessionCount === "number" ? { staleReadySessionCount: input.staleReadySessionCount } : {}),
    ...(typeof input.oldestSchedulableReadyAgeMs === "number"
      ? { oldestSchedulableReadyAgeMs: input.oldestSchedulableReadyAgeMs }
      : {}),
    ...(input.lastRebalanceAt ? { lastRebalanceAt: input.lastRebalanceAt } : {}),
    ...(input.lastRebalanceReason ? { lastRebalanceReason: input.lastRebalanceReason } : {}),
    scaleUpPressureStreak: input.scaleUpPressureStreak,
    scaleDownPressureStreak: input.scaleDownPressureStreak,
    scaleUpCooldownRemainingMs: input.scaleUpCooldownRemainingMs,
    scaleDownCooldownRemainingMs: input.scaleDownCooldownRemainingMs,
    recentDecisions: [...input.recentDecisions]
  };
}

function areRedisRunWorkerPoolDecisionsEquivalent(
  left: RedisRunWorkerPoolDecisionLike,
  right: RedisRunWorkerPoolDecisionLike
): boolean {
  return (
    left.reason === right.reason &&
    left.suggestedWorkers === right.suggestedWorkers &&
    left.globalSuggestedWorkers === right.globalSuggestedWorkers &&
    left.reservedSubagentCapacity === right.reservedSubagentCapacity &&
    left.reservedWorkers === right.reservedWorkers &&
    left.availableIdleCapacity === right.availableIdleCapacity &&
    left.readySessionsPerActiveWorker === right.readySessionsPerActiveWorker &&
    left.subagentReserveTarget === right.subagentReserveTarget &&
    left.subagentReserveDeficit === right.subagentReserveDeficit &&
    left.desiredWorkers === right.desiredWorkers &&
    left.activeWorkers === right.activeWorkers &&
    left.readySessionCount === right.readySessionCount &&
    left.readyQueueDepth === right.readyQueueDepth &&
    left.uniqueReadySessionCount === right.uniqueReadySessionCount &&
    left.subagentReadySessionCount === right.subagentReadySessionCount &&
    left.subagentReadyQueueDepth === right.subagentReadyQueueDepth &&
    left.lockedReadySessionCount === right.lockedReadySessionCount &&
    left.staleReadySessionCount === right.staleReadySessionCount &&
    left.busyWorkers === right.busyWorkers &&
    left.globalActiveWorkers === right.globalActiveWorkers &&
    left.globalBusyWorkers === right.globalBusyWorkers &&
    left.remoteActiveWorkers === right.remoteActiveWorkers &&
    left.remoteBusyWorkers === right.remoteBusyWorkers &&
    left.oldestSchedulableReadyAgeMs === right.oldestSchedulableReadyAgeMs
  );
}

function optionalNumber(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "n/a";
}
