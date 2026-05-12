import path from "node:path";

import type { ServerConfig } from "@oah/config";
import type { WorkspaceRepository } from "@oah/engine-core";
import { AppError } from "@oah/engine-core";
import type { WorkspaceRecord } from "@oah/engine-core";
import { nowIso } from "@oah/engine-core";
import type { EngineService } from "@oah/engine-core";
import type { BootstrappedRuntime } from "./bootstrap-runtime-types.js";
import {
  localWorkspaceExternalRef,
  resolveLocalWorkspaceRoot
} from "./bootstrap-runtime-helpers.js";
import { resolveManagedWorkspaceExternalRef } from "./object-storage-policy.js";
import { resolveRuntimeSourceDirForBootstrap } from "./runtime-upload-cache.js";

type ObjectStorageModule = NonNullable<Awaited<ReturnType<typeof import("./module-loaders.js").loadObjectStorageModule>>>;
type ConfigRuntimesModule = Awaited<ReturnType<typeof import("./module-loaders.js").loadConfigRuntimesModule>>;

export function createLocalWorkspaceManagement(input: {
  config: ServerConfig;
  workspaceRepository: WorkspaceRepository;
  runtimeService: EngineService;
  objectStorageModule: ObjectStorageModule | undefined;
  objectStorageMirror: import("../object-storage.js").ObjectStorageMirrorController | undefined;
  useRuntimeObjectStorageManagement: boolean;
  discoverWorkspaceWithEnrichedModels(rootPath: string, kind: "project"): Promise<WorkspaceRecord>;
  loadConfigRuntimesModule: () => Promise<ConfigRuntimesModule>;
}): Pick<BootstrappedRuntime, "importWorkspace" | "registerLocalWorkspace" | "repairLocalWorkspace"> {
  return {
    async importWorkspace(importInput) {
      const resolvedRoot = path.resolve(importInput.rootPath);
      const relativeToAllowed = path.relative(input.config.paths.workspace_dir, resolvedRoot);
      if (relativeToAllowed.startsWith("..") || path.isAbsolute(relativeToAllowed)) {
        throw new AppError(
          403,
          "workspace_path_not_allowed",
          `rootPath "${importInput.rootPath}" resolves outside the allowed directory. ` +
            "Workspace imports must target paths within the configured workspace_dir."
        );
      }

      const discovered = await input.discoverWorkspaceWithEnrichedModels(importInput.rootPath, "project");
      const existing = await input.workspaceRepository.getById(discovered.id);
      const inferredExternalRef =
        resolveManagedWorkspaceExternalRef(importInput.rootPath, "project", input.config) ??
        input.objectStorageMirror?.managedWorkspaceExternalRef(importInput.rootPath, "project", input.config.paths);
      const persisted = await input.workspaceRepository.upsert({
        ...discovered,
        name: importInput.name ?? existing?.name ?? discovered.name,
        createdAt: existing?.createdAt ?? discovered.createdAt,
        externalRef: importInput.externalRef ?? existing?.externalRef ?? inferredExternalRef,
        ...(importInput.ownerId
          ? { ownerId: importInput.ownerId }
          : existing?.ownerId
            ? { ownerId: existing.ownerId }
            : {}),
        ...(importInput.serviceName
          ? { serviceName: importInput.serviceName }
          : existing?.serviceName
            ? { serviceName: existing.serviceName }
            : {})
      });
      return input.runtimeService.getWorkspace(persisted.id);
    },

    async registerLocalWorkspace(registerInput) {
      const rootPath = await resolveLocalWorkspaceRoot(registerInput.rootPath);
      if (registerInput.runtime) {
        const { applyWorkspaceRuntimeToExistingRoot } = await input.loadConfigRuntimesModule();
        const runtimeDir = await resolveRuntimeSourceDirForBootstrap(
          registerInput.runtime,
          input.config.paths,
          input.useRuntimeObjectStorageManagement,
          input.config.object_storage,
          input.objectStorageModule
        );
        await applyWorkspaceRuntimeToExistingRoot({
          runtimeDir,
          runtimeName: registerInput.runtime,
          rootPath,
          platformToolDir: input.config.paths.tool_dir,
          platformSkillDir: input.config.paths.skill_dir
        });
      }
      const discovered = await input.discoverWorkspaceWithEnrichedModels(rootPath, "project");
      const existing = await input.workspaceRepository.getById(discovered.id);
      const persisted = await input.workspaceRepository.upsert({
        ...discovered,
        rootPath,
        name: registerInput.name ?? existing?.name ?? discovered.name,
        createdAt: existing?.createdAt ?? discovered.createdAt,
        externalRef: existing?.externalRef ?? localWorkspaceExternalRef(rootPath),
        ...(registerInput.ownerId
          ? { ownerId: registerInput.ownerId }
          : existing?.ownerId
            ? { ownerId: existing.ownerId }
            : {}),
        ...(registerInput.serviceName
          ? { serviceName: registerInput.serviceName }
          : existing?.serviceName
            ? { serviceName: existing.serviceName }
            : {})
      });
      return input.runtimeService.getWorkspace(persisted.id);
    },

    async repairLocalWorkspace(repairInput) {
      const rootPath = await resolveLocalWorkspaceRoot(repairInput.rootPath);
      const existing = await input.workspaceRepository.getById(repairInput.workspaceId);
      if (!existing) {
        throw new AppError(404, "workspace_not_found", `Workspace ${repairInput.workspaceId} was not found.`);
      }

      const discovered = await input.discoverWorkspaceWithEnrichedModels(rootPath, "project");
      const conflicting = await input.workspaceRepository.getById(discovered.id);
      if (conflicting && conflicting.id !== existing.id) {
        throw new AppError(
          409,
          "workspace_repair_target_conflict",
          `Target path is already registered as workspace ${conflicting.id}. Delete that workspace before repairing ${existing.id}.`
        );
      }

      const persisted = await input.workspaceRepository.upsert({
        ...discovered,
        id: existing.id,
        rootPath,
        name: repairInput.name ?? existing.name ?? discovered.name,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
        externalRef: localWorkspaceExternalRef(rootPath),
        catalog: {
          ...discovered.catalog,
          workspaceId: existing.id
        },
        ...(existing.ownerId ? { ownerId: existing.ownerId } : {}),
        ...(existing.serviceName ? { serviceName: existing.serviceName } : {})
      });
      return input.runtimeService.getWorkspace(persisted.id);
    }
  };
}
