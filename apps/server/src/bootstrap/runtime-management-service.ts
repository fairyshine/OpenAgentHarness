import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ServerConfig } from "@oah/config";
import { AppError } from "../../../../packages/engine-core/src/errors.js";
import {
  prepareRuntimeUploadCacheDir,
  removeRuntimeFromUploadCaches,
  resolveRuntimeUploadCacheDirs,
  runtimeExistsInUploadCache
} from "./runtime-upload-cache.js";
import type { BootstrappedRuntime } from "./bootstrap-runtime-types.js";

type ObjectStorageModule = NonNullable<Awaited<ReturnType<typeof import("./module-loaders.js").loadObjectStorageModule>>>;
type ConfigRuntimesModule = Awaited<ReturnType<typeof import("./module-loaders.js").loadConfigRuntimesModule>>;

export function createRuntimeManagement(input: {
  config: ServerConfig;
  useRuntimeObjectStorageManagement: boolean;
  objectStorageModule: ObjectStorageModule | undefined;
  loadConfigRuntimesModule: () => Promise<ConfigRuntimesModule>;
}): Pick<BootstrappedRuntime, "listWorkspaceRuntimes" | "uploadWorkspaceRuntime" | "deleteWorkspaceRuntime"> {
  return {
    listWorkspaceRuntimes: async () => {
      const { listWorkspaceRuntimes } = await input.loadConfigRuntimesModule();
      const runtimesByName = new Map<string, { name: string }>();

      if (input.useRuntimeObjectStorageManagement) {
        for (const runtimeName of await input.objectStorageModule!.listRuntimeNamesFromObjectStore(input.config.object_storage!)) {
          runtimesByName.set(runtimeName, { name: runtimeName });
        }

        for (const runtimeCacheDir of resolveRuntimeUploadCacheDirs(input.config.paths)) {
          for (const runtime of await listWorkspaceRuntimes(runtimeCacheDir)) {
            runtimesByName.set(runtime.name, runtime);
          }
        }
      } else {
        for (const runtime of await listWorkspaceRuntimes(input.config.paths.runtime_dir)) {
          runtimesByName.set(runtime.name, runtime);
        }
      }

      return [...runtimesByName.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    uploadWorkspaceRuntime: async (uploadInput) => {
      const { uploadWorkspaceRuntime } = await input.loadConfigRuntimesModule();
      if (input.useRuntimeObjectStorageManagement) {
        const runtimeCacheDir = await prepareRuntimeUploadCacheDir(input.config.paths);
        const runtimeCacheTarget = path.join(runtimeCacheDir, uploadInput.runtimeName);
        const objectStorageRuntimeExists = (
          await input.objectStorageModule!.listRuntimeNamesFromObjectStore(input.config.object_storage!)
        ).includes(uploadInput.runtimeName);
        const cachedRuntimeExists = await runtimeExistsInUploadCache(input.config.paths, uploadInput.runtimeName);
        const runtimeExists = objectStorageRuntimeExists || cachedRuntimeExists;

        if (!runtimeExists && uploadInput.requireExisting) {
          throw new AppError(404, "runtime_not_found", `Runtime "${uploadInput.runtimeName}" does not exist`);
        }

        if (runtimeExists && !uploadInput.overwrite) {
          throw new AppError(409, "runtime_already_exists", `Runtime "${uploadInput.runtimeName}" already exists`);
        }

        await mkdir(runtimeCacheDir, { recursive: true });
        const runtime = await uploadWorkspaceRuntime({
          runtimeDir: runtimeCacheDir,
          runtimeName: uploadInput.runtimeName,
          zipBuffer: uploadInput.zipBuffer,
          overwrite: true
        });
        await input.objectStorageModule!.syncRuntimeDirectoryToObjectStore(
          input.config.object_storage!,
          uploadInput.runtimeName,
          runtimeCacheTarget,
          (message) => {
            console.info(`[oah-object-storage] ${message}`);
          }
        );
        return runtime;
      }

      return uploadWorkspaceRuntime({
        runtimeDir: input.config.paths.runtime_dir,
        runtimeName: uploadInput.runtimeName,
        zipBuffer: uploadInput.zipBuffer,
        ...(uploadInput.overwrite !== undefined ? { overwrite: uploadInput.overwrite } : {}),
        ...(uploadInput.requireExisting !== undefined ? { requireExisting: uploadInput.requireExisting } : {})
      });
    },

    deleteWorkspaceRuntime: async (deleteInput) => {
      const { deleteWorkspaceRuntime } = await input.loadConfigRuntimesModule();
      if (input.useRuntimeObjectStorageManagement) {
        const objectStorageRuntimeExists = (
          await input.objectStorageModule!.listRuntimeNamesFromObjectStore(input.config.object_storage!)
        ).includes(deleteInput.runtimeName);
        const cachedRuntimeExists = await runtimeExistsInUploadCache(input.config.paths, deleteInput.runtimeName);

        if (!objectStorageRuntimeExists && !cachedRuntimeExists) {
          throw new AppError(404, "runtime_not_found", `Runtime "${deleteInput.runtimeName}" does not exist`);
        }

        await removeRuntimeFromUploadCaches(input.config.paths, deleteInput.runtimeName);
        await input.objectStorageModule!.deleteRuntimeFromObjectStore(input.config.object_storage!, deleteInput.runtimeName, (message) => {
          console.info(`[oah-object-storage] ${message}`);
        });
        return;
      }

      return deleteWorkspaceRuntime({
        runtimeDir: input.config.paths.runtime_dir,
        runtimeName: deleteInput.runtimeName
      });
    }
  };
}
