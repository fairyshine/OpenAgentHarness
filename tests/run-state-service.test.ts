import { describe, expect, it, vi } from "vitest";

import type { Run } from "@oah/api-contracts";
import { AppError } from "@oah/engine-core";

import { RunStateService } from "../packages/engine-core/src/engine/run-state.ts";

function buildRun(overrides?: Partial<Run>): Run {
  return {
    id: "run_test",
    workspaceId: "ws_test",
    sessionId: "ses_test",
    triggerType: "message",
    agentName: "assistant",
    effectiveAgentName: "assistant",
    status: "running",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    ...overrides
  };
}

function createRunStateService(overrides?: {
  getRun?: (runId: string) => Promise<Run>;
  update?: (run: Run) => Promise<Run>;
}) {
  const update = vi.fn(async (run: Run) => run);
  const getRun = vi.fn(async () => buildRun());
  return {
    service: new RunStateService({
      runRepository: {
        update: overrides?.update ?? update
      } as never,
      getRun: overrides?.getRun ?? getRun,
      appendEvent: vi.fn(async () => ({}) as never),
      recordSystemStep: vi.fn(async () => undefined),
      nowIso: () => "2026-04-16T00:01:00.000Z"
    }),
    getRun,
    update
  };
}

describe("RunStateService", () => {
  it("ignores heartbeat refreshes for runs that were already removed", async () => {
    const update = vi.fn(async (run: Run) => run);
    const { service } = createRunStateService({
      getRun: async () => {
        throw new AppError(404, "run_not_found", "Run was not found.");
      },
      update
    });

    await expect(service.refreshRunHeartbeat("run_missing")).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("ignores heartbeat update races when the run disappears after being read", async () => {
    const { service } = createRunStateService({
      update: async () => {
        throw new AppError(404, "run_not_found", "Run was not found.");
      }
    });

    await expect(service.refreshRunHeartbeat("run_test")).resolves.toBeUndefined();
  });

  it("ignores packaged run-not-found heartbeat errors that do not share the local AppError prototype", async () => {
    const update = vi.fn(async (run: Run) => run);
    const { service } = createRunStateService({
      getRun: async () => {
        throw {
          name: "AppError",
          statusCode: 404,
          code: "run_not_found",
          message: "Run run_missing was not found."
        };
      },
      update
    });

    await expect(service.refreshRunHeartbeat("run_missing")).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("ignores packaged run-not-found heartbeat update races that do not share the local AppError prototype", async () => {
    const { service } = createRunStateService({
      update: async () => {
        throw {
          name: "AppError",
          statusCode: 404,
          code: "run_not_found",
          message: "Run run_test was not found."
        };
      }
    });

    await expect(service.refreshRunHeartbeat("run_test")).resolves.toBeUndefined();
  });

  it("ignores best-effort status updates for missing runs", async () => {
    const update = vi.fn(async (run: Run) => run);
    const { service } = createRunStateService({
      getRun: async () => {
        throw new AppError(404, "run_not_found", "Run was not found.");
      },
      update
    });

    await expect(service.setRunStatusIfPossible("run_missing", "failed")).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });
});
