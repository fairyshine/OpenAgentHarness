import type {
  SandboxHost as EngineSandboxHost,
  SandboxHostDiagnostics as EngineSandboxHostDiagnostics,
  WorkspaceExecutionLease,
  WorkspaceFileAccessLease,
  WorkspaceRecord,
} from "@oah/engine-core";
import { AppError, createLocalWorkspaceCommandExecutor, createLocalWorkspaceFileSystem } from "@oah/engine-core";

import type {
  WorkspaceMaterializationDiagnostics,
  WorkspaceMaterializationLease,
  WorkspaceMaterializationManager
} from "./workspace-materialization.js";
import { WorkspaceMaterializationDrainingError } from "./workspace-materialization.js";

export interface SandboxHostDiagnostics {
  provider?: "embedded" | "self_hosted" | "e2b" | undefined;
  executionModel?: "local_embedded" | "sandbox_hosted" | undefined;
  workerPlacement?: "api_process" | "inside_sandbox" | undefined;
  materialization?: WorkspaceMaterializationDiagnostics | undefined;
}

export interface SandboxHost extends Omit<EngineSandboxHost, "diagnostics"> {
  diagnostics(): SandboxHostDiagnostics;
  deleteWorkspace?(workspace: WorkspaceRecord): Promise<void> | void;
}

const _diagnosticsContractCheck: EngineSandboxHostDiagnostics = {} satisfies SandboxHostDiagnostics;
void _diagnosticsContractCheck;

export function createLazySandboxHost(options: {
  providerKind: SandboxHost["providerKind"];
  createHost: () => SandboxHost;
  diagnostics?: SandboxHostDiagnostics | (() => SandboxHostDiagnostics);
}): SandboxHost {
  let host: SandboxHost | undefined;

  const getHost = (): SandboxHost => {
    host ??= options.createHost();
    return host;
  };

  const resolveDiagnostics = (): SandboxHostDiagnostics | undefined =>
    typeof options.diagnostics === "function" ? options.diagnostics() : options.diagnostics;

  return {
    providerKind: options.providerKind,
    workspaceCommandExecutor: {
      runForeground(input) {
        return getHost().workspaceCommandExecutor.runForeground(input);
      },
      runProcess(input) {
        return getHost().workspaceCommandExecutor.runProcess(input);
      },
      runBackground(input) {
        return getHost().workspaceCommandExecutor.runBackground(input);
      },
      getBackgroundTask(input) {
        return getHost().workspaceCommandExecutor.getBackgroundTask?.(input) ?? Promise.resolve(null);
      },
      stopBackgroundTask(input) {
        return getHost().workspaceCommandExecutor.stopBackgroundTask?.(input) ?? Promise.resolve(null);
      },
      writeBackgroundTaskInput(input) {
        return getHost().workspaceCommandExecutor.writeBackgroundTaskInput?.(input) ?? Promise.resolve(null);
      },
      runPersistentTerminal(input) {
        return getHost().workspaceCommandExecutor.runPersistentTerminal?.(input) ?? Promise.reject(new AppError(501, "persistent_terminal_unsupported", "Persistent terminals are not supported by this sandbox host."));
      },
      stopPersistentTerminal(input) {
        return getHost().workspaceCommandExecutor.stopPersistentTerminal?.(input) ?? Promise.resolve(null);
      }
    },
    workspaceFileSystem: {
      realpath(targetPath) {
        return getHost().workspaceFileSystem.realpath(targetPath);
      },
      stat(targetPath) {
        return getHost().workspaceFileSystem.stat(targetPath);
      },
      readFile(targetPath) {
        return getHost().workspaceFileSystem.readFile(targetPath);
      },
      openReadStream(targetPath) {
        return getHost().workspaceFileSystem.openReadStream(targetPath);
      },
      readdir(targetPath) {
        return getHost().workspaceFileSystem.readdir(targetPath);
      },
      mkdir(targetPath, options) {
        return getHost().workspaceFileSystem.mkdir(targetPath, options);
      },
      writeFile(targetPath, data, options) {
        return getHost().workspaceFileSystem.writeFile(targetPath, data, options);
      },
      rm(targetPath, options) {
        return getHost().workspaceFileSystem.rm(targetPath, options);
      },
      rename(sourcePath, targetPath) {
        return getHost().workspaceFileSystem.rename(sourcePath, targetPath);
      }
    },
    workspaceExecutionProvider: {
      acquire(input) {
        return getHost().workspaceExecutionProvider.acquire(input);
      }
    },
    workspaceFileAccessProvider: {
      acquire(input) {
        return getHost().workspaceFileAccessProvider.acquire(input);
      }
    },
    diagnostics() {
      return host?.diagnostics() ?? resolveDiagnostics() ?? { provider: options.providerKind };
    },
    async maintain(options) {
      if (!host) {
        return;
      }
      await host.maintain(options);
    },
    async beginDrain() {
      if (!host) {
        return;
      }
      await host.beginDrain();
    },
    async deleteWorkspace(workspace) {
      if (!host) {
        return;
      }
      await host.deleteWorkspace?.(workspace);
    },
    async close() {
      if (!host) {
        return;
      }
      await host.close();
    }
  };
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
  providerKind?: SandboxHost["providerKind"] | undefined;
  diagnostics?: Partial<SandboxHostDiagnostics> | undefined;
}): SandboxHost {
  const manager = options.materializationManager;
  const providerKind = options.providerKind ?? "embedded";
  return {
    providerKind,
    workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
    workspaceFileSystem: createLocalWorkspaceFileSystem(),
    workspaceExecutionProvider: {
      async acquire({ workspace }) {
        return materializedExecutionLease(manager, workspace);
      }
    },
    workspaceFileAccessProvider: {
      async acquire({ workspace }) {
        return materializedFileAccessLease(manager, workspace);
      }
    },
    diagnostics() {
      return {
        provider: providerKind,
        executionModel: "local_embedded",
        workerPlacement: "api_process",
        materialization: manager.diagnostics(),
        ...(options.diagnostics ?? {})
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
