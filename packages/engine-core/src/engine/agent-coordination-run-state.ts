import type { Run } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type { AgentCoordinationLifecycle } from "./agent-coordination-types.js";

const terminalStatePollIntervalMs = 20;

export function isRunTerminal(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
}

export async function waitForRunTerminalState(
  lifecycle: Pick<AgentCoordinationLifecycle, "getRun">,
  runId: string
): Promise<Run> {
  while (true) {
    const run = await lifecycle.getRun(runId);
    if (isRunTerminal(run.status)) {
      return run;
    }

    await sleep(terminalStatePollIntervalMs);
  }
}

export async function waitForAnyRunTerminalState(
  lifecycle: Pick<AgentCoordinationLifecycle, "getRun">,
  runIds: string[]
): Promise<Run> {
  while (true) {
    const runs = await Promise.all(runIds.map(async (runId) => lifecycle.getRun(runId)));
    const completedRun = runs.find((run) => isRunTerminal(run.status));
    if (completedRun) {
      return completedRun;
    }

    await sleep(terminalStatePollIntervalMs);
  }
}

export async function waitForRunTerminalStateUntil(
  lifecycle: Pick<AgentCoordinationLifecycle, "getRun">,
  runId: string,
  timeoutMs: number,
  abortSignal?: AbortSignal | undefined
): Promise<Run | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (abortSignal?.aborted) {
      throw new AppError(499, "run_cancelled", "Task output wait was cancelled.");
    }

    const run = await lifecycle.getRun(runId);
    if (isRunTerminal(run.status)) {
      return run;
    }

    await sleep(terminalStatePollIntervalMs);
  }

  return lifecycle.getRun(runId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
