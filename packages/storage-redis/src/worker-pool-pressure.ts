interface SessionRunQueuePressureLike {
  readySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
}

export interface RedisRunWorkerPoolPressureSummary {
  availableIdleCapacity: number;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget: number;
  subagentReserveDeficit: number;
}

export function summarizeRedisRunWorkerPoolPressure(input: {
  activeWorkers: number;
  busyWorkers: number;
  reservedSubagentCapacity: number;
  schedulingPressure?: SessionRunQueuePressureLike | undefined;
}): RedisRunWorkerPoolPressureSummary {
  const availableIdleCapacity = Math.max(0, input.activeWorkers - input.busyWorkers);
  const subagentBacklogPresent =
    (input.schedulingPressure?.subagentReadySessionCount ?? 0) > 0 ||
    (input.schedulingPressure?.subagentReadyQueueDepth ?? 0) > 0;
  const subagentReserveTarget = subagentBacklogPresent ? input.reservedSubagentCapacity : 0;

  return {
    availableIdleCapacity,
    ...(input.activeWorkers > 0 && typeof input.schedulingPressure?.readySessionCount === "number"
      ? {
          readySessionsPerActiveWorker: Number(
            (input.schedulingPressure.readySessionCount / input.activeWorkers).toFixed(2)
          )
        }
      : {}),
    subagentReserveTarget,
    subagentReserveDeficit: Math.max(0, subagentReserveTarget - availableIdleCapacity)
  };
}
