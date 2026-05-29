import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ValidateFunction } from "ajv";

import { createAjv, expandEnv, validationMessage } from "@oah/schema-tools";

import type { ServerConfig } from "./types.js";

export { expandEnv, validationMessage };

const schemaCache = new Map<string, Promise<unknown>>();
const schemaValidatorCache = new Map<string, Promise<ValidateFunction<unknown>>>();

function resolveRuntimeAssetFileUrl(relativePath: string): URL {
  const normalizedRelativePath = path.posix.normalize(relativePath.replaceAll("\\", "/")).replace(/^(\.\.\/)+/u, "");
  const configuredRoot = process.env.OAH_DOCS_ROOT?.trim();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    configuredRoot,
    process.cwd(),
    path.resolve(moduleDir, "../../..")
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const root of candidateRoots) {
    const candidatePath = path.join(root, normalizedRelativePath);
    if (existsSync(candidatePath)) {
      return pathToFileURL(candidatePath);
    }
  }

  return new URL(relativePath, import.meta.url);
}

export async function loadSchema<T>(relativePath: string): Promise<T> {
  const fileUrl = resolveRuntimeAssetFileUrl(relativePath);
  const cacheKey = fileUrl.toString();
  let cached = schemaCache.get(cacheKey);
  if (!cached) {
    cached = readFile(fileUrl, "utf8").then((fileContent) => JSON.parse(fileContent));
    schemaCache.set(cacheKey, cached);
  }

  return cached as Promise<T>;
}

export async function loadSchemaValidator<T>(relativePath: string): Promise<ValidateFunction<T>> {
  const fileUrl = resolveRuntimeAssetFileUrl(relativePath);
  const cacheKey = fileUrl.toString();
  let cached = schemaValidatorCache.get(cacheKey);
  if (!cached) {
    cached = loadSchema<object>(relativePath).then((schema) => createAjv().compile<T>(schema));
    schemaValidatorCache.set(cacheKey, cached);
  }

  return cached as Promise<ValidateFunction<T>>;
}

export function resolveConfigPaths(config: ServerConfig, configPath: string): ServerConfig {
  const configDir = path.dirname(configPath);
  const workspaceDir = path.resolve(configDir, config.paths.workspace_dir);
  const runtimeStateDir = path.resolve(
    configDir,
    config.paths.runtime_state_dir ?? path.join(path.dirname(workspaceDir), ".openharness")
  );
  return {
    ...config,
    storage: {
      ...(config.storage ?? {})
    },
    paths: {
      workspace_dir: workspaceDir,
      runtime_state_dir: runtimeStateDir,
      runtime_dir: path.resolve(configDir, config.paths.runtime_dir),
      model_dir: path.resolve(configDir, config.paths.model_dir),
      tool_dir: path.resolve(configDir, config.paths.tool_dir),
      skill_dir: path.resolve(configDir, config.paths.skill_dir)
    }
  };
}

export function emitConfigDeprecationWarnings(
  config: ServerConfig,
  configPath: string,
  usesLegacyCompatibilityFields: (config: NonNullable<ServerConfig["object_storage"]>) => boolean
) {
  if (typeof config.workers?.standalone?.slots_per_pod === "number") {
    process.emitWarning(
      `workers.standalone.slots_per_pod is deprecated in ${configPath} and ignored by controller sizing; ` +
        "sandbox replica decisions now use observed worker-reported capacity.",
      {
        type: "DeprecationWarning",
        code: "OAH_CONFIG_DEPRECATED_SLOTS_PER_POD"
      }
    );
  }

  if (config.object_storage && usesLegacyCompatibilityFields(config.object_storage)) {
    process.emitWarning(
      `object_storage legacy fields are deprecated in ${configPath}; ` +
        "migrate managed_paths/key_prefixes/sync_on_* to workspace_backing_store and mirrors.",
      {
        type: "DeprecationWarning",
        code: "OAH_CONFIG_DEPRECATED_OBJECT_STORAGE_LEGACY_FIELDS"
      }
    );
  }
}
