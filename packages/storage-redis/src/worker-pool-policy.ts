export interface RedisWorkerLoadSummary {
  globalSuggestedWorkers: number;
  globalActiveWorkers: number;
  globalBusyWorkers: number;
  remoteActiveWorkers: number;
  remoteBusyWorkers: number;
}

export interface RedisRunWorkerPoolSizingInput {
  minWorkers: number;
  maxWorkers: number;
  readySessionsPerCapacityUnit: number;
  reservedSubagentCapacity: number;
  localActiveWorkers: number;
  localBusyWorkers: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
  schedulingPressure?:
    | {
        readySessionCount?: number | undefined;
        subagentReadySessionCount?: number | undefined;
        oldestSchedulableReadyAgeMs?: number | undefined;
      }
    | undefined;
  globalWorkerLoad?: RedisWorkerLoadSummary | undefined;
}

export interface RedisRunWorkerPoolSizingResult {
  pressureWorkers: number;
  saturatedWorkers: number;
  reservedWorkers: number;
  ageBoostWorkers: number;
  globalSuggestedWorkers: number;
  localSuggestedWorkers: number;
}

export function summarizeRedisWorkerLoad(input: {
  activeWorkers: Array<{
    workerId: string;
    state: "starting" | "idle" | "busy" | "stopping";
    health: "healthy" | "late";
  }>;
  localWorkerIds?: Iterable<string> | undefined;
  localActiveWorkers: number;
  localBusyWorkers: number;
}): RedisWorkerLoadSummary {
  const localWorkerIds = new Set(input.localWorkerIds ?? []);
  const remoteHealthyWorkers = input.activeWorkers.filter(
    (entry) => !localWorkerIds.has(entry.workerId) && entry.health === "healthy"
  );
  const remoteActiveWorkers = remoteHealthyWorkers.length;
  const remoteBusyWorkers = remoteHealthyWorkers.filter((entry) => entry.state === "busy").length;
  const globalActiveWorkers = remoteActiveWorkers + input.localActiveWorkers;
  const globalBusyWorkers = remoteBusyWorkers + input.localBusyWorkers;

  return {
    globalSuggestedWorkers: 0,
    globalActiveWorkers,
    globalBusyWorkers,
    remoteActiveWorkers,
    remoteBusyWorkers
  };
}

export function calculateRedisWorkerPoolSuggestion(
  input: RedisRunWorkerPoolSizingInput
): RedisRunWorkerPoolSizingResult {
  const readySessionCount = input.schedulingPressure?.readySessionCount;
  const subagentReadySessionCount = input.schedulingPressure?.subagentReadySessionCount;
  const busyWorkers = input.globalWorkerLoad?.globalBusyWorkers ?? input.localBusyWorkers;
  const activeWorkers = input.globalWorkerLoad?.globalActiveWorkers ?? input.localActiveWorkers;
  const readySessionsPerCapacityUnit = Math.max(1, input.readySessionsPerCapacityUnit);
  const pressureWorkers =
    typeof readySessionCount === "number" ? Math.ceil(readySessionCount / readySessionsPerCapacityUnit) : input.minWorkers;
  const saturatedWorkers =
    typeof readySessionCount === "number"
      ? Math.ceil((readySessionCount + busyWorkers) / readySessionsPerCapacityUnit)
      : busyWorkers;
  const reservedWorkers =
    typeof subagentReadySessionCount === "number" && subagentReadySessionCount > 0
      ? busyWorkers + input.reservedSubagentCapacity
      : 0;
  const ageBoostWorkers =
    typeof readySessionCount === "number" &&
    readySessionCount > 0 &&
    busyRatio(activeWorkers, busyWorkers) >= input.scaleUpBusyRatioThreshold &&
    (input.schedulingPressure?.oldestSchedulableReadyAgeMs ?? 0) >= input.scaleUpMaxReadyAgeMs
      ? activeWorkers + 1
      : 0;
  const globalSuggestedWorkers = Math.max(pressureWorkers, saturatedWorkers, reservedWorkers, ageBoostWorkers);
  const localSuggestedWorkers = input.globalWorkerLoad
    ? Math.max(input.minWorkers, globalSuggestedWorkers - input.globalWorkerLoad.remoteActiveWorkers)
    : globalSuggestedWorkers;

  return {
    pressureWorkers,
    saturatedWorkers,
    reservedWorkers,
    ageBoostWorkers,
    globalSuggestedWorkers,
    localSuggestedWorkers: Math.max(input.minWorkers, Math.min(input.maxWorkers, localSuggestedWorkers))
  };
}

function busyRatio(activeWorkers: number, busyWorkers: number): number {
  if (activeWorkers <= 0) {
    return 0;
  }

  return busyWorkers / activeWorkers;
}
