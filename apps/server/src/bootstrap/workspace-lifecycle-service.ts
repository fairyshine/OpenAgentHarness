import type { EngineService } from "@oah/engine-core";
import type { SandboxHost } from "./sandbox-host.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";
import type { BootstrappedRuntime } from "./bootstrap-runtime-types.js";

export function createWorkspaceLifecycle(input: {
  sandboxHost: SandboxHost | undefined;
  runtimeService: EngineService;
  workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
  touchWorkspaceActivity?: ((workspaceId: string) => Promise<void>) | undefined;
  clearWorkspaceCoordination(workspaceId: string): Promise<void>;
}): BootstrappedRuntime["workspaceLifecycle"] | undefined {
  if (!input.sandboxHost) {
    return undefined;
  }
  const sandboxHost = input.sandboxHost;

  return {
    async execute(operationInput) {
      if (operationInput.operation === "delete") {
        try {
          await input.runtimeService.deleteWorkspace(operationInput.workspaceId);
        } catch (error) {
          if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "workspace_not_found") {
            throw error;
          }
        }
        await input.clearWorkspaceCoordination(operationInput.workspaceId);
        return {
          workspaceId: operationInput.workspaceId,
          operation: operationInput.operation,
          status: "completed" as const
        };
      }

      if (operationInput.operation === "hydrate") {
        const workspace = await input.runtimeService.getWorkspaceRecord(operationInput.workspaceId);
        if (input.workspaceMaterializationManager) {
          const hydrated = await input.workspaceMaterializationManager.hydrateWorkspace(workspace);
          return {
            workspaceId: operationInput.workspaceId,
            operation: operationInput.operation,
            status: "completed" as const,
            hydrated
          };
        }

        const lease = await sandboxHost.workspaceFileAccessProvider.acquire({
          workspace,
          access: "read"
        });
        await lease.release();
        return {
          workspaceId: operationInput.workspaceId,
          operation: operationInput.operation,
          status: "completed" as const,
          hydrated: []
        };
      }

      if (operationInput.operation === "flush") {
        const flushed = (await input.workspaceMaterializationManager?.flushWorkspaceCopies(operationInput.workspaceId)) ?? [];
        return {
          workspaceId: operationInput.workspaceId,
          operation: operationInput.operation,
          status: "completed" as const,
          flushed
        };
      }

      if (operationInput.operation === "evict") {
        const result =
          (await input.workspaceMaterializationManager?.evictWorkspaceCopies(operationInput.workspaceId, {
            force: operationInput.force
          })) ?? {
            evicted: [],
            skipped: []
          };
        return {
          workspaceId: operationInput.workspaceId,
          operation: operationInput.operation,
          status: "completed" as const,
          evicted: result.evicted,
          skipped: result.skipped
        };
      }

      const repaired = (await input.workspaceMaterializationManager?.repairWorkspacePlacement(operationInput.workspaceId)) ?? [];
      if (repaired.length === 0) {
        await input.touchWorkspaceActivity?.(operationInput.workspaceId);
      }
      return {
        workspaceId: operationInput.workspaceId,
        operation: operationInput.operation,
        status: "completed" as const,
        repaired
      };
    }
  };
}
