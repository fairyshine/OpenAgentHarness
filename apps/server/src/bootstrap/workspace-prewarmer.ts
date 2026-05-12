import type { WorkspacePrewarmer, WorkspaceRecord } from "@oah/engine-core";

import type { SandboxHost } from "./sandbox-host.js";

export function createWorkspacePrewarmer(options: {
  sandboxHost: SandboxHost;
  getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord>;
  delayMs?: number | undefined;
  coalesceWindowMs?: number | undefined;
}): WorkspacePrewarmer {
  const inFlightByWorkspaceId = new Map<string, Promise<void>>();
  const lastCompletedAtByWorkspaceId = new Map<string, number>();

  return {
    async prewarmWorkspace(workspaceId: string): Promise<void> {
      const normalizedWorkspaceId = workspaceId.trim();
      if (normalizedWorkspaceId.length === 0) {
        return;
      }

      const coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? 0);
      const lastCompletedAt = lastCompletedAtByWorkspaceId.get(normalizedWorkspaceId);
      if (
        coalesceWindowMs > 0 &&
        typeof lastCompletedAt === "number" &&
        Date.now() - lastCompletedAt < coalesceWindowMs
      ) {
        return;
      }

      const existingTask = inFlightByWorkspaceId.get(normalizedWorkspaceId);
      if (existingTask) {
        await existingTask;
        return;
      }

      let task: Promise<void>;
      task = (async () => {
        if ((options.delayMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        const workspace = await options.getWorkspaceRecord(normalizedWorkspaceId);
        const lease = await options.sandboxHost.workspaceFileAccessProvider.acquire({
          workspace,
          access: "read"
        });
        await lease.release();
        lastCompletedAtByWorkspaceId.set(normalizedWorkspaceId, Date.now());
      })().finally(() => {
        if (inFlightByWorkspaceId.get(normalizedWorkspaceId) === task) {
          inFlightByWorkspaceId.delete(normalizedWorkspaceId);
        }
      });

      inFlightByWorkspaceId.set(normalizedWorkspaceId, task);
      await task;
    }
  };
}
