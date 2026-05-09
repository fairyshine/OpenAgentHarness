import type { CreateWorkspaceRequest } from "@oah/api-contracts";
import type { ServerConfig } from "@oah/config";

import type { WorkspaceRecord } from "../../../../packages/engine-core/src/types.js";
import { createId } from "../../../../packages/engine-core/src/utils.js";

import { resolveManagedWorkspaceExternalRef } from "./object-storage-policy.js";
import { resolveRuntimeSourceDirForBootstrap } from "./runtime-upload-cache.js";

type ConfigWorkspaceModule = typeof import("@oah/config/workspace");
type ConfigRuntimesModule = typeof import("@oah/config/runtimes");
type ObjectStorageModule = typeof import("../object-storage.js");

export function createLocalWorkspaceInitializer(input: {
  config: ServerConfig;
  toolDir: string;
  useRuntimeObjectStorageManagement: boolean;
  objectStorageModule: ObjectStorageModule | undefined;
  loadConfigWorkspaceModule: () => Promise<ConfigWorkspaceModule>;
  loadConfigRuntimesModule: () => Promise<ConfigRuntimesModule>;
  discoverWorkspaceWithEnrichedModels(rootPath: string, kind: "project"): Promise<WorkspaceRecord>;
}) {
  return {
    async initialize(request: CreateWorkspaceRequest): Promise<WorkspaceRecord> {
      const { resolveWorkspaceCreationRoot } = await input.loadConfigWorkspaceModule();
      const { initializeWorkspaceFromRuntime } = await input.loadConfigRuntimesModule();
      const workspaceId = (
        request as typeof request & {
          workspaceId?: string | undefined;
        }
      ).workspaceId?.trim() || createId("ws");
      const workspaceRoot = resolveWorkspaceCreationRoot({
        workspaceDir: input.config.paths.workspace_dir,
        name: request.name,
        workspaceId,
        rootPath: request.rootPath
      });

      const runtimeDir = await resolveRuntimeSourceDirForBootstrap(
        request.runtime,
        input.config.paths,
        input.useRuntimeObjectStorageManagement,
        input.config.object_storage,
        input.objectStorageModule
      );

      await initializeWorkspaceFromRuntime(
        {
          runtimeDir,
          runtimeName: request.runtime,
          rootPath: workspaceRoot,
          platformToolDir: input.config.paths.tool_dir,
          platformSkillDir: input.config.paths.skill_dir,
          agentsMd: request.agentsMd,
          toolServers: (request as typeof request & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
          skills: request.skills
        } as Parameters<typeof initializeWorkspaceFromRuntime>[0]
      );

      const inferredExternalRef = resolveManagedWorkspaceExternalRef(workspaceRoot, "project", input.config);
      const targetExternalRef = request.externalRef ?? inferredExternalRef;
      if (input.config.object_storage && targetExternalRef) {
        await input.objectStorageModule!.seedWorkspaceRootToExternalRef(
          input.config.object_storage,
          targetExternalRef,
          workspaceRoot,
          (message) => {
            console.info(`[oah-object-storage] ${message}`);
          }
        );
      }

      const discovered = await input.discoverWorkspaceWithEnrichedModels(workspaceRoot, "project");

      return {
        ...discovered,
        id: workspaceId,
        ...(targetExternalRef ? { externalRef: targetExternalRef } : {})
      };
    }
  };
}
