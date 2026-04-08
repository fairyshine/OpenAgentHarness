import type { Run } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type { RunRepository, SessionEvent } from "../types.js";

export function canTransitionRunStatus(from: Run["status"], to: Run["status"]): boolean {
  if (from === to) {
    return true;
  }

  switch (from) {
    case "queued":
      return to === "running" || to === "cancelled" || to === "failed";
    case "running":
      return to === "waiting_tool" || to === "completed" || to === "failed" || to === "cancelled" || to === "timed_out";
    case "waiting_tool":
      return to === "running" || to === "completed" || to === "failed" || to === "cancelled" || to === "timed_out";
    default:
      return false;
  }
}

export interface RunStateServiceDependencies {
  runRepository: RunRepository;
  getRun: (runId: string) => Promise<Run>;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown>) => Promise<unknown>;
  nowIso: () => string;
}

export class RunStateService {
  readonly #runRepository: RunRepository;
  readonly #getRun: RunStateServiceDependencies["getRun"];
  readonly #appendEvent: RunStateServiceDependencies["appendEvent"];
  readonly #recordSystemStep: RunStateServiceDependencies["recordSystemStep"];
  readonly #nowIso: RunStateServiceDependencies["nowIso"];

  constructor(dependencies: RunStateServiceDependencies) {
    this.#runRepository = dependencies.runRepository;
    this.#getRun = dependencies.getRun;
    this.#appendEvent = dependencies.appendEvent;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#nowIso = dependencies.nowIso;
  }

  async markRunCancelled(sessionId: string, run: Run): Promise<void> {
    const cancelledRun =
      run.status === "cancelled"
        ? run
        : await this.setRunStatus(run, "cancelled", {
            endedAt: this.#nowIso(),
            cancelRequestedAt: run.cancelRequestedAt ?? this.#nowIso()
          });
    await this.#recordSystemStep(cancelledRun, "run.cancelled", {
      status: cancelledRun.status
    });

    await this.#appendEvent({
      sessionId,
      runId: cancelledRun.id,
      event: "run.cancelled",
      data: {
        runId: cancelledRun.id,
        sessionId,
        status: cancelledRun.status
      }
    });
  }

  async markRunTimedOut(run: Run, runTimeoutMs: number | undefined): Promise<Run> {
    if (run.status === "timed_out") {
      return run;
    }

    return this.setRunStatus(run, "timed_out", {
      endedAt: this.#nowIso(),
      errorCode: "run_timed_out",
      errorMessage:
        runTimeoutMs !== undefined
          ? `Run exceeded configured timeout of ${runTimeoutMs}ms.`
          : "Run exceeded the configured timeout."
    });
  }

  async setRunStatus(run: Run, nextStatus: Run["status"], patch: Partial<Run>): Promise<Run> {
    if (!canTransitionRunStatus(run.status, nextStatus)) {
      throw new AppError(409, "invalid_run_transition", `Cannot transition run from ${run.status} to ${nextStatus}.`);
    }

    return this.updateRun(run, {
      ...patch,
      status: nextStatus
    });
  }

  async setRunStatusIfPossible(runId: string, nextStatus: Run["status"]): Promise<void> {
    const run = await this.#getRun(runId);
    if (run.status === nextStatus || !canTransitionRunStatus(run.status, nextStatus)) {
      return;
    }

    await this.setRunStatus(run, nextStatus, {});
  }

  async refreshRunHeartbeat(runId: string): Promise<void> {
    const run = await this.#getRun(runId);
    if (run.status !== "running" && run.status !== "waiting_tool") {
      return;
    }

    await this.updateRun(run, {
      heartbeatAt: this.#nowIso()
    });
  }

  async updateRun(run: Run, patch: Partial<Run>): Promise<Run> {
    return this.#runRepository.update({
      ...run,
      ...patch
    });
  }
}
