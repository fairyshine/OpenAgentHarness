import type { SessionRunQueuePressure } from "../../../../packages/engine-core/src/coordination.js";

export function selectPlacementPreferredWorkerId(placement: {
  state?: "unassigned" | "active" | "idle" | "draining" | "evicted" | undefined;
  ownerId?: string | undefined;
  ownerWorkerId?: string | undefined;
  preferredWorkerId?: string | undefined;
} | null | undefined): string | undefined {
  if (placement?.state === "evicted" || placement?.state === "unassigned") {
    return undefined;
  }

  const preferredWorkerId = placement?.preferredWorkerId?.trim();
  if (preferredWorkerId) {
    return preferredWorkerId;
  }

  const ownerWorkerId = placement?.ownerWorkerId?.trim();
  if (ownerWorkerId) {
    return ownerWorkerId;
  }

  return undefined;
}

interface PlacementAwareSessionRunQueueLike {
  enqueue(
    sessionId: string,
    runId: string,
    input?: { priority?: "normal" | "subagent" | undefined; preferredWorkerId?: string | undefined }
  ): Promise<void>;
  claimNextSession(
    timeoutMs?: number | undefined,
    input?: { workerId?: string | undefined; runtimeInstanceId?: string | undefined }
  ): Promise<string | undefined>;
  readyQueueLength(): Promise<number>;
  inspectReadyQueue(nowMs?: number | undefined): Promise<{
    length: number;
    subagentLength: number;
    oldestReadyAgeMs: number;
    averageReadyAgeMs: number;
  }>;
  tryAcquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  renewSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, token: string): Promise<boolean>;
  peekRun(sessionId: string): Promise<string | undefined>;
  dequeueRun(sessionId: string): Promise<string | undefined>;
  requeueSessionIfPending?(sessionId: string, input?: { preferredWorkerId?: string | undefined }): Promise<boolean>;
  getSchedulingPressure?(): Promise<SessionRunQueuePressure>;
  getReadySessionCount?(): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createPlacementAwareSessionRunQueue<TQueue extends PlacementAwareSessionRunQueueLike>(options: {
  queue: TQueue;
  runRepository: {
    getById(runId: string): Promise<{ workspaceId: string } | null>;
  };
  workspacePlacementRegistry?: {
    getByWorkspaceId?(workspaceId: string): Promise<{
      state?: "unassigned" | "active" | "idle" | "draining" | "evicted" | undefined;
      ownerId?: string | undefined;
      ownerWorkerId?: string | undefined;
      preferredWorkerId?: string | undefined;
    } | undefined>;
  } | undefined;
}): TQueue {
  const queue = options.queue;
  const wrappedQueue: PlacementAwareSessionRunQueueLike = {
    async enqueue(
      sessionId: string,
      runId: string,
      input?: { priority?: "normal" | "subagent" | undefined; preferredWorkerId?: string | undefined }
    ) {
      let preferredWorkerId = input?.preferredWorkerId?.trim();

      if (!preferredWorkerId && options.workspacePlacementRegistry?.getByWorkspaceId) {
        const run = await options.runRepository.getById(runId);
        if (run?.workspaceId) {
          const placement = await options.workspacePlacementRegistry.getByWorkspaceId(run.workspaceId);
          preferredWorkerId = selectPlacementPreferredWorkerId(placement);
        }
      }

      await queue.enqueue(sessionId, runId, {
        ...input,
        ...(preferredWorkerId ? { preferredWorkerId } : {})
      });
    },
    claimNextSession(timeoutMs, input) {
      return queue.claimNextSession(timeoutMs, input);
    },
    readyQueueLength() {
      return queue.readyQueueLength();
    },
    inspectReadyQueue(nowMs) {
      return queue.inspectReadyQueue(nowMs);
    },
    tryAcquireSessionLock(sessionId, token, ttlMs) {
      return queue.tryAcquireSessionLock(sessionId, token, ttlMs);
    },
    renewSessionLock(sessionId, token, ttlMs) {
      return queue.renewSessionLock(sessionId, token, ttlMs);
    },
    releaseSessionLock(sessionId, token) {
      return queue.releaseSessionLock(sessionId, token);
    },
    peekRun(sessionId) {
      return queue.peekRun(sessionId);
    },
    dequeueRun(sessionId) {
      return queue.dequeueRun(sessionId);
    },
    ...(queue.requeueSessionIfPending
      ? {
          requeueSessionIfPending(sessionId: string, input?: { preferredWorkerId?: string | undefined }) {
            return queue.requeueSessionIfPending!(sessionId, input);
          }
        }
      : {}),
    ...(queue.getSchedulingPressure
      ? {
          getSchedulingPressure() {
            return queue.getSchedulingPressure!();
          }
        }
      : {}),
    ...(queue.getReadySessionCount
      ? {
          getReadySessionCount() {
            return queue.getReadySessionCount!();
          }
        }
      : {}),
    ping() {
      return queue.ping();
    },
    close() {
      return queue.close();
    }
  };

  return wrappedQueue as TQueue;
}
