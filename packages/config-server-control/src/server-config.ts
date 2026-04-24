import { readFile } from "node:fs/promises";

import YAML from "yaml";

import { normalizeObjectStorageConfig, usesLegacyObjectStorageCompatibilityFields } from "./object-storage.js";
import type { ObjectStorageConfig } from "./object-storage.js";
import {
  emitConfigDeprecationWarnings,
  expandEnv,
  loadSchemaValidator,
  resolveConfigPaths,
  validationMessage
} from "./shared.js";
import type { ServerConfig } from "./types.js";

export async function loadServerConfig(configPath: string): Promise<ServerConfig> {
  const [validate, fileContent] = await Promise.all([
    loadSchemaValidator<ServerConfig>("../../../docs/schemas/server-config.schema.json"),
    readFile(configPath, "utf8")
  ]);

  const parsed = YAML.parse(fileContent) ?? {};
  const expandedRaw = expandEnv(parsed);
  const expandedRecord =
    expandedRaw && typeof expandedRaw === "object" && !Array.isArray(expandedRaw)
      ? (expandedRaw as Record<string, unknown>)
      : null;
  const expanded = expandedRecord
    ? ({
        ...expandedRecord,
        storage:
          expandedRecord.storage &&
          typeof expandedRecord.storage === "object" &&
          !Array.isArray(expandedRecord.storage)
            ? expandedRecord.storage
            : {}
      } as Record<string, unknown>)
    : expandedRaw;
  if (!validate(expanded)) {
    throw new Error(`Invalid server config: ${validationMessage(validate.errors)}`);
  }

  const resolvedConfig = resolveConfigPaths(
    {
      ...expanded,
      server: expanded.server as ServerConfig["server"],
      storage:
        expanded.storage && typeof expanded.storage === "object" && !Array.isArray(expanded.storage)
          ? (expanded.storage as ServerConfig["storage"])
          : {},
      object_storage:
        expanded.object_storage && typeof expanded.object_storage === "object" && !Array.isArray(expanded.object_storage)
          ? normalizeObjectStorageConfig(expanded.object_storage as ObjectStorageConfig)
          : undefined,
      sandbox:
        expanded.sandbox && typeof expanded.sandbox === "object" && !Array.isArray(expanded.sandbox)
          ? (expanded.sandbox as ServerConfig["sandbox"])
          : undefined
    } as ServerConfig,
    configPath
  );

  emitConfigDeprecationWarnings(resolvedConfig, configPath, usesLegacyObjectStorageCompatibilityFields);
  return resolvedConfig;
}
