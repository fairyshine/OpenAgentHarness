import type { ServerConfig } from "@oah/config";
import { AppError } from "@oah/engine-core";
import type { WorkspaceRecord } from "@oah/engine-core";
import {
  cleanupWorkspaceLocalArtifacts,
  type WorkspaceLocalArtifactCleanupStatus
} from "./engine-state-paths.js";
import { resolveManagedWorkspaceExternalRef } from "./object-storage-policy.js";
import type { SandboxHost } from "./sandbox-host.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";
import { clearWorkspaceRootContents } from "./bootstrap-runtime-helpers.js";
import { shouldCleanupWorkspaceThroughSandboxHost } from "../sandbox-capabilities.js";

type ObjectStorageModule = NonNullable<Awaited<ReturnType<typeof import("./module-loaders.js").loadObjectStorageModule>>>;

export function createWorkspaceDeletionHandler(input: {
  config: ServerConfig;
  remoteSandboxProvider: boolean;
  sandboxHost: SandboxHost | undefined;
  useSelfHostedWorkspaceDelegatingInitializer: boolean;
  objectStorageModule: ObjectStorageModule | undefined;
  objectStorageMirror: import("../object-storage.js").ObjectStorageMirrorController | undefined;
  workspaceMaterializationManager: WorkspaceMaterializationManager | undefined;
  sqliteShadowRoot: string;
  clearWorkspaceCoordination(workspaceId: string): Promise<void>;
  closeWorkspaceWatcher?: ((workspace: Pick<WorkspaceRecord, "rootPath">) => void) | undefined;
}): { deleteWorkspace(workspace: WorkspaceRecord): Promise<void> } {
  return {
    async deleteWorkspace(workspace) {
      console.info(
        `[oah-bootstrap] Deleting workspace ${workspace.id} (rootPath=${workspace.rootPath}, externalRef=${workspace.externalRef ?? "none"})`
      );

      if (input.useSelfHostedWorkspaceDelegatingInitializer) {
        throw new AppError(
          409,
          "workspace_delete_requires_worker",
          `Workspace ${workspace.id} must be deleted by a self-hosted worker in API-only mode.`
        );
      }

      if (
        shouldCleanupWorkspaceThroughSandboxHost({
          remoteSandboxProvider: input.remoteSandboxProvider,
          sandboxHostAvailable: Boolean(input.sandboxHost)
        })
      ) {
        await clearWorkspaceRootContents({
          sandboxHost: input.sandboxHost!,
          workspace
        });
        await input.sandboxHost!.deleteWorkspace?.(workspace);
      } else {
        console.info(`[oah-bootstrap] No remote sandbox cleanup needed for workspace ${workspace.id}`);
      }

      const workspaceExternalRef =
        workspace.externalRef ??
        resolveManagedWorkspaceExternalRef(workspace.rootPath, workspace.kind, input.config) ??
        input.objectStorageMirror?.managedWorkspaceExternalRef(workspace.rootPath, workspace.kind, input.config.paths);
      if (input.config.object_storage && workspaceExternalRef) {
        console.info(
          `[oah-object-storage] Deleting workspace backing store for ${workspace.id} using ${workspaceExternalRef}`
        );
        await input.objectStorageModule!.deleteWorkspaceExternalRefFromObjectStore(
          input.config.object_storage,
          workspaceExternalRef,
          (message) => {
            console.info(`[oah-object-storage] ${message}`);
          }
        );
        console.info(`[oah-object-storage] Deleted workspace backing store for ${workspace.id}`);
      } else if (input.config.object_storage) {
        console.warn(
          `[oah-object-storage] Skipping backing-store deletion for workspace ${workspace.id}; no externalRef could be resolved`
        );
      } else {
        console.info(`[oah-object-storage] No object storage configured; skipping backing-store deletion for ${workspace.id}`);
      }

      input.closeWorkspaceWatcher?.(workspace);
      const deletedCopies = await input.workspaceMaterializationManager?.deleteWorkspaceCopies(workspace.id);
      const cleanup: WorkspaceLocalArtifactCleanupStatus = await cleanupWorkspaceLocalArtifacts({
        workspace,
        paths: input.config.paths,
        sqliteShadowRoot: input.sqliteShadowRoot
      });
      await input.clearWorkspaceCoordination(workspace.id);
      console.info(
        `[oah-bootstrap] Cleaned local artifacts for deleted workspace ${workspace.id} (${cleanup.mode}): ${cleanup.removedPaths.join(", ")}${
          deletedCopies && deletedCopies.length > 0 ? `; evicted copies: ${deletedCopies.map((copy) => copy.localPath).join(", ")}` : ""
        }`
      );
    }
  };
}
