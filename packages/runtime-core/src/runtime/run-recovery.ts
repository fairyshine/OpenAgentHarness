import type { Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type { RequeueRunResult, RunQueue, RunRepository, SessionEvent, SessionRepository } from "../types.js";
import { nowIso } from "../utils.js";
import { isRecord, type AutomaticRecoveryStrategy, type RecoveryActor } from "./internal-helpers.js";

type RecoveryFailureReason =
  | "fail_closed"
  | "requeue_unavailable"
  | "session_missing"
  | "waiting_tool_manual_resume_required"
  | "max_attempts_exhausted"
  | "requeue_not_possible";

export interface RunRecoveryServiceDependencies {
  getRun: (runId: string) => Promise<Run>;
  getSession: (sessionId: string) => Promise<Session>;
  runRepository: RunRepository;
  runQueue?: RunQueue | undefined;
  updateRun: (run: Run, patch: Partial<Run>) => Promise<Run>;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown>) => Promise<RunStep>;
  enqueueRun: (sessionId: string, runId: string) => Promise<void>;
  runAbortControllers: Map<string, AbortController>;
  drainTimeoutRecoveredRuns: Set<string>;
  runHeartbeatIntervalMs: number;
  staleRunRecoveryStrategy: AutomaticRecoveryStrategy;
  staleRunRecoveryMaxAttempts: number;
}

export class RunRecoveryService {
  readonly #getRun: RunRecoveryServiceDependencies["getRun"];
  readonly #getSession: RunRecoveryServiceDependencies["getSession"];
  readonly #runRepository: RunRepository;
  readonly #runQueue: RunQueue | undefined;
  readonly #updateRun: RunRecoveryServiceDependencies["updateRun"];
  readonly #appendEvent: RunRecoveryServiceDependencies["appendEvent"];
  readonly #recordSystemStep: RunRecoveryServiceDependencies["recordSystemStep"];
  readonly #enqueueRun: RunRecoveryServiceDependencies["enqueueRun"];
  readonly #runAbortControllers: Map<string, AbortController>;
  readonly #drainTimeoutRecoveredRuns: Set<string>;
  readonly #runHeartbeatIntervalMs: number;
  readonly #staleRunRecoveryStrategy: AutomaticRecoveryStrategy;
  readonly #staleRunRecoveryMaxAttempts: number;

  constructor(dependencies: RunRecoveryServiceDependencies) {
    this.#getRun = dependencies.getRun;
    this.#getSession = dependencies.getSession;
    this.#runRepository = dependencies.runRepository;
    this.#runQueue = dependencies.runQueue;
    this.#updateRun = dependencies.updateRun;
    this.#appendEvent = dependencies.appendEvent;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#enqueueRun = dependencies.enqueueRun;
    this.#runAbortControllers = dependencies.runAbortControllers;
    this.#drainTimeoutRecoveredRuns = dependencies.drainTimeoutRecoveredRuns;
    this.#runHeartbeatIntervalMs = dependencies.runHeartbeatIntervalMs;
    this.#staleRunRecoveryStrategy = dependencies.staleRunRecoveryStrategy;
    this.#staleRunRecoveryMaxAttempts = dependencies.staleRunRecoveryMaxAttempts;
  }

  async requeueRun(runId: string, requestedBy?: string): Promise<RequeueRunResult> {
    const run = await this.#getRun(runId);
    if (run.status !== "failed" && run.status !== "timed_out") {
      throw new AppError(409, "run_requeue_invalid_status", `Run ${runId} is not in a terminal recovery state.`);
    }

    if (!this.#isRecoveryManagedRun(run)) {
      throw new AppError(409, "run_requeue_not_supported", `Run ${runId} is not eligible for manual requeue.`);
    }

    if (!this.#runQueue || !run.sessionId) {
      throw new AppError(409, "run_requeue_unavailable", `Run ${runId} cannot be requeued on this deployment.`);
    }

    await this.#getSession(run.sessionId);
    const previousStatus = run.status;
    const recoveredAt = nowIso();
    const queuedRun = await this.#updateRun(run, {
      status: "queued",
      startedAt: undefined,
      heartbeatAt: undefined,
      endedAt: undefined,
      cancelRequestedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      metadata: this.#buildRecoveryMetadata(run, {
        attempts: this.#readRecoveryAttempts(run.metadata),
        outcome: "requeued",
        recoveredBy: "manual_operator_requeue",
        recoveredAt,
        reason: "manual_operator_requeue",
        quarantined: false,
        strategy: "manual",
        requestedBy
      })
    });

    await this.#appendEvent({
      sessionId: run.sessionId,
      runId: queuedRun.id,
      event: "run.queued",
      data: {
        runId: queuedRun.id,
        sessionId: run.sessionId,
        status: queuedRun.status,
        recoveredBy: "manual_operator_requeue",
        recoveryAttempt: this.#readRecoveryAttempts(queuedRun.metadata),
        recoveryState: "requeued",
        recoveryReason: "manual_operator_requeue",
        recoveryStrategy: "manual",
        previousStatus,
        ...(requestedBy ? { requestedBy } : {})
      }
    });
    await this.#recordSystemStep(queuedRun, "run.requeued", {
      status: queuedRun.status,
      recoveredBy: "manual_operator_requeue",
      recoveryAttempt: this.#readRecoveryAttempts(queuedRun.metadata),
      recoveryState: "requeued",
      recoveryReason: "manual_operator_requeue",
      recoveryStrategy: "manual",
      previousStatus,
      ...(requestedBy ? { requestedBy } : {})
    });
    await this.#enqueueRun(run.sessionId, queuedRun.id);

    return {
      runId: queuedRun.id,
      status: "queued",
      previousStatus,
      source: "manual_requeue"
    };
  }

  async recoverRunAfterDrainTimeout(
    runId: string,
    strategy: AutomaticRecoveryStrategy
  ): Promise<"failed" | "requeued" | "ignored"> {
    const run = await this.#runRepository.getById(runId);
    if (!run || (run.status !== "running" && run.status !== "waiting_tool")) {
      return "ignored";
    }

    const abortController = this.#runAbortControllers.get(run.id);
    if (abortController) {
      this.#drainTimeoutRecoveredRuns.add(run.id);
      abortController.abort();
    }

    if (strategy !== "fail") {
      if (
        await this.#tryRequeueRecoveredRun(run, {
          strategy,
          recoveredBy: "worker_drain_timeout_requeue"
        })
      ) {
        return "requeued";
      }
    }

    const endedAt = nowIso();
    const failureContext = this.#resolveRecoveryFailureContext(run, strategy);
    const failedRun = await this.#updateRun(run, {
      status: "failed",
      endedAt,
      errorCode: "worker_recovery_failed",
      errorMessage: "Run was recovered as failed after worker drain timed out.",
      metadata: this.#buildRecoveryMetadata(run, {
        attempts: failureContext.recoveryAttempts,
        outcome: "failed",
        recoveredBy: "worker_drain_timeout",
        recoveredAt: endedAt,
        reason: failureContext.reason,
        quarantined: failureContext.quarantined,
        strategy
      })
    });

    if (failedRun.sessionId) {
      await this.#appendEvent({
        sessionId: failedRun.sessionId,
        runId: failedRun.id,
        event: "run.failed",
        data: {
          runId: failedRun.id,
          sessionId: failedRun.sessionId,
          status: failedRun.status,
          errorCode: failedRun.errorCode,
          errorMessage: failedRun.errorMessage,
          recoveredBy: "worker_drain_timeout",
          recoveryAttempt: failureContext.recoveryAttempts,
          recoveryState: failureContext.quarantined ? "quarantined" : "failed",
          recoveryReason: failureContext.reason,
          recoveryStrategy: strategy
        }
      });
    }

    await this.#recordSystemStep(failedRun, "run.failed", {
      status: failedRun.status,
      errorCode: failedRun.errorCode,
      errorMessage: failedRun.errorMessage,
      recoveredBy: "worker_drain_timeout",
      recoveryAttempt: failureContext.recoveryAttempts,
      recoveryState: failureContext.quarantined ? "quarantined" : "failed",
      recoveryReason: failureContext.reason,
      recoveryStrategy: strategy
    });

    return "failed";
  }

  async recoverStaleRuns(options?: {
    staleBefore?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ recoveredRunIds: string[]; requeuedRunIds: string[] }> {
    const staleBefore = options?.staleBefore ?? new Date(Date.now() - this.#runHeartbeatIntervalMs * 3).toISOString();
    const recoverableRuns = await this.#runRepository.listRecoverableActiveRuns(staleBefore, options?.limit ?? 100);
    const recoveredRunIds: string[] = [];
    const requeuedRunIds: string[] = [];

    for (const run of recoverableRuns) {
      const currentRun = await this.#runRepository.getById(run.id);
      if (!currentRun || (currentRun.status !== "running" && currentRun.status !== "waiting_tool")) {
        continue;
      }

      if (this.#staleRunRecoveryStrategy !== "fail") {
        if (
          await this.#tryRequeueRecoveredRun(currentRun, {
            strategy: this.#staleRunRecoveryStrategy,
            recoveredBy: "worker_startup_requeue"
          })
        ) {
          requeuedRunIds.push(currentRun.id);
          continue;
        }
      }

      const endedAt = nowIso();
      const failureContext = this.#resolveRecoveryFailureContext(currentRun, this.#staleRunRecoveryStrategy);
      const failedRun = await this.#updateRun(currentRun, {
        status: "failed",
        endedAt,
        errorCode: "worker_recovery_failed",
        errorMessage: "Run was recovered as failed after worker heartbeat expired.",
        metadata: this.#buildRecoveryMetadata(currentRun, {
          attempts: failureContext.recoveryAttempts,
          outcome: "failed",
          recoveredBy: "worker_startup",
          recoveredAt: endedAt,
          reason: failureContext.reason,
          quarantined: failureContext.quarantined,
          strategy: this.#staleRunRecoveryStrategy
        })
      });

      if (failedRun.sessionId) {
        await this.#appendEvent({
          sessionId: failedRun.sessionId,
          runId: failedRun.id,
          event: "run.failed",
          data: {
            runId: failedRun.id,
            sessionId: failedRun.sessionId,
            status: failedRun.status,
            errorCode: failedRun.errorCode,
            errorMessage: failedRun.errorMessage,
            recoveredBy: "worker_startup",
            recoveryAttempt: failureContext.recoveryAttempts,
            recoveryState: failureContext.quarantined ? "quarantined" : "failed",
            recoveryReason: failureContext.reason
          }
        });
      }

      await this.#recordSystemStep(failedRun, "run.failed", {
        status: failedRun.status,
        errorCode: failedRun.errorCode,
        errorMessage: failedRun.errorMessage,
        recoveredBy: "worker_startup",
        recoveryAttempt: failureContext.recoveryAttempts,
        recoveryState: failureContext.quarantined ? "quarantined" : "failed",
        recoveryReason: failureContext.reason
      });
      recoveredRunIds.push(failedRun.id);
    }

    return { recoveredRunIds, requeuedRunIds };
  }

  async #tryRequeueRecoveredRun(
    run: Run,
    input: {
      strategy: Exclude<AutomaticRecoveryStrategy, "fail">;
      recoveredBy: Extract<RecoveryActor, "worker_startup_requeue" | "worker_drain_timeout_requeue">;
    }
  ): Promise<boolean> {
    if (!this.#runQueue || !run.sessionId) {
      return false;
    }

    if (input.strategy === "requeue_running" && run.status !== "running") {
      return false;
    }

    const recoveryAttempts = this.#readRecoveryAttempts(run.metadata);
    if (recoveryAttempts >= this.#staleRunRecoveryMaxAttempts) {
      return false;
    }

    const nextRecoveryAttempt = recoveryAttempts + 1;
    const recoveredAt = nowIso();
    const queuedRun = await this.#updateRun(run, {
      status: "queued",
      startedAt: undefined,
      heartbeatAt: undefined,
      endedAt: undefined,
      cancelRequestedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      metadata: this.#buildRecoveryMetadata(run, {
        attempts: nextRecoveryAttempt,
        outcome: "requeued",
        recoveredBy: input.recoveredBy,
        recoveredAt,
        reason: "automatic_requeue",
        quarantined: false,
        strategy: input.strategy
      })
    });

    await this.#appendEvent({
      sessionId: run.sessionId,
      runId: queuedRun.id,
      event: "run.queued",
      data: {
        runId: queuedRun.id,
        sessionId: run.sessionId,
        status: queuedRun.status,
        recoveredBy: input.recoveredBy,
        recoveryAttempt: nextRecoveryAttempt,
        recoveryState: "requeued",
        recoveryReason: "automatic_requeue",
        recoveryStrategy: input.strategy
      }
    });
    await this.#recordSystemStep(queuedRun, "run.requeued", {
      status: queuedRun.status,
      recoveredBy: input.recoveredBy,
      recoveryAttempt: nextRecoveryAttempt,
      recoveryState: "requeued",
      recoveryReason: "automatic_requeue",
      recoveryStrategy: input.strategy
    });
    await this.#enqueueRun(run.sessionId, queuedRun.id);
    return true;
  }

  #readRecoveryAttempts(metadata: Run["metadata"]): number {
    const rootMetadata = isRecord(metadata) ? metadata : {};
    const recoveryMetadata = isRecord(rootMetadata.recovery) ? rootMetadata.recovery : {};
    const attemptsValue = rootMetadata.recoveryAttempts ?? recoveryMetadata.attempts;

    return typeof attemptsValue === "number" && Number.isFinite(attemptsValue) && attemptsValue >= 0
      ? Math.floor(attemptsValue)
      : 0;
  }

  #resolveRecoveryFailureContext(run: Run, strategy: AutomaticRecoveryStrategy): {
    recoveryAttempts: number;
    reason: RecoveryFailureReason;
    quarantined: boolean;
  } {
    const recoveryAttempts = this.#readRecoveryAttempts(run.metadata);
    if (strategy === "fail") {
      return {
        recoveryAttempts,
        reason: "fail_closed",
        quarantined: false
      };
    }

    if (!this.#runQueue) {
      return {
        recoveryAttempts,
        reason: "requeue_unavailable",
        quarantined: true
      };
    }

    if (!run.sessionId) {
      return {
        recoveryAttempts,
        reason: "session_missing",
        quarantined: true
      };
    }

    if (strategy === "requeue_running" && run.status === "waiting_tool") {
      return {
        recoveryAttempts,
        reason: "waiting_tool_manual_resume_required",
        quarantined: true
      };
    }

    if (recoveryAttempts >= this.#staleRunRecoveryMaxAttempts) {
      return {
        recoveryAttempts,
        reason: "max_attempts_exhausted",
        quarantined: true
      };
    }

    return {
      recoveryAttempts,
      reason: "requeue_not_possible",
      quarantined: true
    };
  }

  #buildRecoveryMetadata(
    run: Run,
    input: {
      attempts: number;
      outcome: "failed" | "requeued";
      recoveredBy: RecoveryActor;
      recoveredAt: string;
      reason: string;
      quarantined: boolean;
      strategy: AutomaticRecoveryStrategy | "manual";
      requestedBy?: string | undefined;
    }
  ): Record<string, unknown> {
    const rootMetadata = isRecord(run.metadata) ? run.metadata : {};
    const previousRecovery = isRecord(rootMetadata.recovery) ? rootMetadata.recovery : {};
    const { deadLetter: _previousDeadLetter, ...previousRecoveryWithoutDeadLetter } = previousRecovery;
    const manualRequeueCount =
      input.recoveredBy === "manual_operator_requeue"
        ? typeof previousRecovery.manualRequeueCount === "number" && Number.isFinite(previousRecovery.manualRequeueCount)
          ? Math.max(0, Math.floor(previousRecovery.manualRequeueCount)) + 1
          : 1
        : typeof previousRecovery.manualRequeueCount === "number" && Number.isFinite(previousRecovery.manualRequeueCount)
          ? Math.max(0, Math.floor(previousRecovery.manualRequeueCount))
          : undefined;
    const recoveryMetadata: Record<string, unknown> = {
      ...previousRecoveryWithoutDeadLetter,
      state: input.quarantined ? "quarantined" : input.outcome,
      strategy: input.strategy,
      attempts: input.attempts,
      maxAttempts: this.#staleRunRecoveryMaxAttempts,
      lastOutcome: input.outcome,
      lastRecoveredBy: input.recoveredBy,
      lastRecoveredAt: input.recoveredAt,
      reason: input.reason,
      ...(typeof manualRequeueCount === "number" ? { manualRequeueCount } : {}),
      ...(input.recoveredBy === "manual_operator_requeue"
        ? {
            lastManualRequeueAt: input.recoveredAt,
            ...(input.requestedBy ? { lastManualRequeueBy: input.requestedBy } : {})
          }
        : {}),
      ...(input.quarantined
        ? {
            deadLetter: {
              status: "quarantined",
              reason: input.reason,
              at: input.recoveredAt
            }
          }
        : {})
    };

    return {
      ...rootMetadata,
      recoveryAttempts: input.attempts,
      recoveredBy: input.recoveredBy,
      recoveredAt: input.recoveredAt,
      recovery: recoveryMetadata,
      ...(input.requestedBy ? { recoveryRequestedBy: input.requestedBy } : {})
    };
  }

  #isRecoveryManagedRun(run: Run): boolean {
    if (run.errorCode === "worker_recovery_failed") {
      return true;
    }

    const rootMetadata = isRecord(run.metadata) ? run.metadata : {};
    const recoveryMetadata = isRecord(rootMetadata.recovery) ? rootMetadata.recovery : undefined;
    const recoveryState = typeof recoveryMetadata?.state === "string" ? recoveryMetadata.state : undefined;

    return (
      recoveryState === "quarantined" ||
      recoveryState === "failed" ||
      recoveryState === "requeued" ||
      typeof rootMetadata.recoveryAttempts === "number"
    );
  }
}
