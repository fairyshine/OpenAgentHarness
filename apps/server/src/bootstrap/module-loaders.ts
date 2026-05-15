import type { ServerConfig } from "@oah/config";

let configWorkspaceModulePromise: Promise<typeof import("@oah/config/workspace")> | undefined;
let configRuntimesModulePromise: Promise<typeof import("@oah/config/runtimes")> | undefined;
let configServerConfigModulePromise: Promise<{ loadServerConfig: (configPath: string) => Promise<ServerConfig> }> | undefined;
let workspaceDefinitionHelpersPromise: Promise<typeof import("./workspace-definition-helpers.js")> | undefined;
let configuredSandboxHostModulePromise: Promise<typeof import("./configured-sandbox-host.js")> | undefined;
let objectStorageModulePromise: Promise<typeof import("../object-storage.js")> | undefined;
let sandboxBackedWorkspaceInitializerModulePromise:
  | Promise<typeof import("./sandbox-backed-workspace-initializer.js")>
  | undefined;
let platformAgentsModulePromise: Promise<typeof import("../platform-agents.js")> | undefined;
let serviceRoutedPostgresModulePromise: Promise<typeof import("./service-routed-postgres.js")> | undefined;
let adminCapabilitiesModulePromise: Promise<typeof import("./admin-capabilities.js")> | undefined;
let sqliteStorageModulePromise: Promise<typeof import("@oah/storage-sqlite")> | undefined;
let redisStorageModulePromise: Promise<typeof import("@oah/storage-redis")> | undefined;
let controlPlaneRuntimeModulePromise: Promise<typeof import("./control-plane-runtime.js")> | undefined;
let workerRuntimeModulePromise: Promise<typeof import("./worker-runtime.js")> | undefined;
let storageAdminModulePromise: Promise<typeof import("../storage-admin.js")> | undefined;
let modelMetadataDiscoveryModulePromise: Promise<typeof import("./model-metadata-discovery.js")> | undefined;
let sandboxHostModulePromise: Promise<typeof import("./sandbox-host.js")> | undefined;
let workspaceMaterializationModulePromise: Promise<typeof import("./workspace-materialization.js")> | undefined;
let nativeBridgeModulePromise: Promise<typeof import("@oah/native-bridge")> | undefined;
let metadataRetentionModulePromise: Promise<typeof import("../metadata-retention.js")> | undefined;

export function loadConfigWorkspaceModule(): Promise<typeof import("@oah/config/workspace")> {
  configWorkspaceModulePromise ??= import("@oah/config");
  return configWorkspaceModulePromise;
}

export function loadConfigRuntimesModule(): Promise<typeof import("@oah/config/runtimes")> {
  configRuntimesModulePromise ??= import("@oah/config");
  return configRuntimesModulePromise;
}

export function loadConfigServerConfigModule(): Promise<{ loadServerConfig: (configPath: string) => Promise<ServerConfig> }> {
  configServerConfigModulePromise ??= import("@oah/config");
  return configServerConfigModulePromise;
}

export function loadWorkspaceDefinitionHelpersModule(): Promise<typeof import("./workspace-definition-helpers.js")> {
  workspaceDefinitionHelpersPromise ??= import("./workspace-definition-helpers.js");
  return workspaceDefinitionHelpersPromise;
}

export function loadConfiguredSandboxHostModule(): Promise<typeof import("./configured-sandbox-host.js")> {
  configuredSandboxHostModulePromise ??= import("./configured-sandbox-host.js");
  return configuredSandboxHostModulePromise;
}

export function loadObjectStorageModule(): Promise<typeof import("../object-storage.js")> {
  objectStorageModulePromise ??= import("../object-storage.js");
  return objectStorageModulePromise;
}

export function loadSandboxBackedWorkspaceInitializerModule(): Promise<
  typeof import("./sandbox-backed-workspace-initializer.js")
> {
  sandboxBackedWorkspaceInitializerModulePromise ??= import("./sandbox-backed-workspace-initializer.js");
  return sandboxBackedWorkspaceInitializerModulePromise;
}

export function loadPlatformAgentsModule(): Promise<typeof import("../platform-agents.js")> {
  platformAgentsModulePromise ??= import("../platform-agents.js");
  return platformAgentsModulePromise;
}

export function loadServiceRoutedPostgresModule(): Promise<typeof import("./service-routed-postgres.js")> {
  serviceRoutedPostgresModulePromise ??= import("./service-routed-postgres.js");
  return serviceRoutedPostgresModulePromise;
}

export function loadAdminCapabilitiesModule(): Promise<typeof import("./admin-capabilities.js")> {
  adminCapabilitiesModulePromise ??= import("./admin-capabilities.js");
  return adminCapabilitiesModulePromise;
}

export function loadStorageAdminModule(): Promise<typeof import("../storage-admin.js")> {
  storageAdminModulePromise ??= import("../storage-admin.js");
  return storageAdminModulePromise;
}

export function loadMetadataRetentionModule(): Promise<typeof import("../metadata-retention.js")> {
  metadataRetentionModulePromise ??= import("../metadata-retention.js");
  return metadataRetentionModulePromise;
}

export function loadSQLiteStorageModule(): Promise<typeof import("@oah/storage-sqlite")> {
  sqliteStorageModulePromise ??= import("@oah/storage-sqlite");
  return sqliteStorageModulePromise;
}

export function loadRedisStorageModule(): Promise<typeof import("@oah/storage-redis")> {
  redisStorageModulePromise ??= import("@oah/storage-redis");
  return redisStorageModulePromise;
}

export function loadControlPlaneRuntimeModule(): Promise<typeof import("./control-plane-runtime.js")> {
  controlPlaneRuntimeModulePromise ??= import("./control-plane-runtime.js");
  return controlPlaneRuntimeModulePromise;
}

export function loadWorkerRuntimeModule(): Promise<typeof import("./worker-runtime.js")> {
  workerRuntimeModulePromise ??= import("./worker-runtime.js");
  return workerRuntimeModulePromise;
}

export function loadModelMetadataDiscoveryModule(): Promise<typeof import("./model-metadata-discovery.js")> {
  modelMetadataDiscoveryModulePromise ??= import("./model-metadata-discovery.js");
  return modelMetadataDiscoveryModulePromise;
}

export function loadSandboxHostModule(): Promise<typeof import("./sandbox-host.js")> {
  sandboxHostModulePromise ??= import("./sandbox-host.js");
  return sandboxHostModulePromise;
}

export function loadWorkspaceMaterializationModule(): Promise<typeof import("./workspace-materialization.js")> {
  workspaceMaterializationModulePromise ??= import("./workspace-materialization.js");
  return workspaceMaterializationModulePromise;
}

export function loadNativeBridgeModule(): Promise<typeof import("@oah/native-bridge")> {
  nativeBridgeModulePromise ??= import("@oah/native-bridge");
  return nativeBridgeModulePromise;
}
