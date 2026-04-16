import type {
  WorkspaceExecutionLease,
  WorkspaceFileAccessLease,
  WorkspaceRecord
} from "@oah/runtime-core";
import { AppError, createLocalWorkspaceCommandExecutor, createLocalWorkspaceFileSystem } from "@oah/runtime-core";

import type {
  WorkspaceMaterializationDiagnostics,
  WorkspaceMaterializationLease,
  WorkspaceMaterializationManager
} from "./workspace-materialization.js";
import { WorkspaceMaterializationDrainingError } from "./workspace-materialization.js";

export interface SandboxHostDiagnostics {
  materialization?: WorkspaceMaterializationDiagnostics | undefined;
}

/**
 * Local mirror of the runtime-core SandboxHost contract.
 *
 * This keeps the server package on a stable type-check path while the broader
 * workspace incrementally adopts the shared contract surface.
 */
export interface SandboxHost {
  providerKind: "self_hosted" | "e2b";
  workspaceCommandExecutor: ReturnType<typeof createLocalWorkspaceCommandExecutor>;
  workspaceFileSystem: ReturnType<typeof createLocalWorkspaceFileSystem>;
  workspaceExecutionProvider: {
    acquire(input: { workspace: WorkspaceRecord }): Promise<WorkspaceExecutionLease>;
  };
  workspaceFileAccessProvider: {
    acquire(input: { workspace: WorkspaceRecord }): Promise<WorkspaceFileAccessLease>;
  };
  diagnostics(): SandboxHostDiagnostics;
  maintain(options: { idleBefore: string }): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

function leaseToExecutionWorkspace(workspace: WorkspaceRecord, lease: WorkspaceMaterializationLease): WorkspaceRecord {
  return {
    ...workspace,
    rootPath: lease.localPath
  };
}

async function acquireMaterializedLease(
  manager: WorkspaceMaterializationManager,
  workspace: WorkspaceRecord
): Promise<WorkspaceMaterializationLease> {
  try {
    return await manager.acquireWorkspace({
      workspace
    });
  } catch (error) {
    if (error instanceof WorkspaceMaterializationDrainingError) {
      throw new AppError(503, "workspace_materialization_draining", error.message);
    }

    throw error;
  }
}

async function materializedExecutionLease(
  manager: WorkspaceMaterializationManager,
  workspace: WorkspaceRecord
): Promise<WorkspaceExecutionLease> {
  const lease = await acquireMaterializedLease(manager, workspace);
  return {
    workspace: leaseToExecutionWorkspace(workspace, lease),
    async release(options?: { dirty?: boolean | undefined }) {
      await lease.release(options);
    }
  };
}

async function materializedFileAccessLease(
  manager: WorkspaceMaterializationManager,
  workspace: WorkspaceRecord
): Promise<WorkspaceFileAccessLease> {
  const lease = await acquireMaterializedLease(manager, workspace);
  return {
    workspace: leaseToExecutionWorkspace(workspace, lease),
    async release(options?: { dirty?: boolean | undefined }) {
      await lease.release(options);
    }
  };
}

export function createMaterializationSandboxHost(options: {
  materializationManager: WorkspaceMaterializationManager;
}): SandboxHost {
  const manager = options.materializationManager;
  return {
    providerKind: "self_hosted",
    workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
    workspaceFileSystem: createLocalWorkspaceFileSystem(),
    workspaceExecutionProvider: {
      async acquire({ workspace }: { workspace: WorkspaceRecord }) {
        return materializedExecutionLease(manager, workspace);
      }
    },
    workspaceFileAccessProvider: {
      async acquire({ workspace }: { workspace: WorkspaceRecord }) {
        return materializedFileAccessLease(manager, workspace);
      }
    },
    diagnostics() {
      return {
        materialization: manager.diagnostics()
      } satisfies SandboxHostDiagnostics;
    },
    async maintain({ idleBefore }: { idleBefore: string }) {
      await manager.refreshLeases();
      await manager.flushIdleCopies({ idleBefore });
      await manager.evictIdleCopies({ idleBefore });
    },
    async beginDrain() {
      await manager.beginDrain();
    },
    async close() {
      await manager.close();
    }
  };
}
