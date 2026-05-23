import type { AppDependencies } from "./http/types.js";
import type { BootstrappedRuntime } from "./bootstrap.js";
import { resolveSandboxOwnerFallbackBaseUrl } from "./sandbox-capabilities.js";
import { buildSystemProfile } from "./system-profile.js";

function resolveLocalApiAuthToken(): string | undefined {
  const token = process.env.OAH_LOCAL_API_TOKEN?.trim();
  return token || undefined;
}

function buildSharedAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  const sandboxOwnerFallbackBaseUrl = resolveSandboxOwnerFallbackBaseUrl({
    provider: runtime.sandboxHostProviderKind,
    configuredBaseUrl: runtime.config.sandbox?.self_hosted?.base_url
  });
  const systemProfile = buildSystemProfile({
    config: runtime.config,
    process: runtime.process,
    workspaceMode: runtime.workspaceMode.kind,
    storageInspection: Boolean(runtime.adminCapabilities?.storageAdmin),
    assetManagement: Boolean(runtime.listPlatformAssets)
  });

  return {
    runtimeService: runtime.controlPlaneEngineService,
    defaultModel: runtime.config.llm.default_model,
    systemProfile,
    workspaceMode: runtime.workspaceMode.kind,
    healthCheck: () => runtime.healthReport(),
    readinessCheck: () => runtime.readinessReport(),
    beginDrain: () => runtime.beginDrain(),
    appendEngineLog: runtime.appendEngineLog,
    ...(runtime.sandboxHostProviderKind ? { sandboxHostProviderKind: runtime.sandboxHostProviderKind } : {}),
    ...(sandboxOwnerFallbackBaseUrl ? { sandboxOwnerFallbackBaseUrl } : {}),
    ...(runtime.resolveWorkspaceOwnership
      ? { resolveWorkspaceOwnership: runtime.resolveWorkspaceOwnership }
      : {}),
    ...(runtime.clearWorkspaceCoordination
      ? { clearWorkspaceCoordination: runtime.clearWorkspaceCoordination }
      : {}),
    ...(runtime.touchWorkspaceActivity
      ? { touchWorkspaceActivity: runtime.touchWorkspaceActivity }
      : {}),
    ...(runtime.listWorkspaceEntriesFast
      ? { listWorkspaceEntriesFast: runtime.listWorkspaceEntriesFast }
      : {}),
    ...(runtime.workspaceLifecycle
      ? { workspaceLifecycle: runtime.workspaceLifecycle }
      : {})
  };
}

export function buildApiAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  const localApiAuthToken = resolveLocalApiAuthToken();

  return {
    ...buildSharedAppDependencies(runtime),
    ...(localApiAuthToken ? { localApiAuthToken } : {}),
    modelGateway: runtime.modelGateway,
    ...(runtime.adminCapabilities?.storageAdmin ? { storageAdmin: runtime.adminCapabilities.storageAdmin } : {}),
    ...(runtime.listPlatformModels ? { listPlatformModels: runtime.listPlatformModels } : {}),
    ...(runtime.getPlatformModelSnapshot ? { getPlatformModelSnapshot: runtime.getPlatformModelSnapshot } : {}),
    ...(runtime.refreshPlatformModels ? { refreshPlatformModels: runtime.refreshPlatformModels } : {}),
    ...(runtime.refreshDistributedPlatformModels
      ? { refreshDistributedPlatformModels: runtime.refreshDistributedPlatformModels }
      : {}),
    ...(runtime.subscribePlatformModelSnapshot
      ? { subscribePlatformModelSnapshot: runtime.subscribePlatformModelSnapshot }
      : {}),
    ...(runtime.listWorkspaceRuntimes ? { listWorkspaceRuntimes: runtime.listWorkspaceRuntimes } : {}),
    ...(runtime.uploadWorkspaceRuntime ? { uploadWorkspaceRuntime: runtime.uploadWorkspaceRuntime } : {}),
    ...(runtime.deleteWorkspaceRuntime ? { deleteWorkspaceRuntime: runtime.deleteWorkspaceRuntime } : {}),
    ...(runtime.listPlatformAssets ? { listPlatformAssets: runtime.listPlatformAssets } : {}),
    ...(runtime.uploadPlatformModelAsset ? { uploadPlatformModelAsset: runtime.uploadPlatformModelAsset } : {}),
    ...(runtime.deletePlatformModelAsset ? { deletePlatformModelAsset: runtime.deletePlatformModelAsset } : {}),
    ...(runtime.uploadPlatformToolAsset ? { uploadPlatformToolAsset: runtime.uploadPlatformToolAsset } : {}),
    ...(runtime.deletePlatformToolAsset ? { deletePlatformToolAsset: runtime.deletePlatformToolAsset } : {}),
    ...(runtime.uploadPlatformSkillAsset ? { uploadPlatformSkillAsset: runtime.uploadPlatformSkillAsset } : {}),
    ...(runtime.deletePlatformSkillAsset ? { deletePlatformSkillAsset: runtime.deletePlatformSkillAsset } : {}),
    ...(runtime.importWorkspace ? { importWorkspace: runtime.importWorkspace } : {}),
    ...(runtime.registerLocalWorkspace ? { registerLocalWorkspace: runtime.registerLocalWorkspace } : {})
  };
}

export function buildWorkerAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  return {
    ...buildSharedAppDependencies(runtime),
    ...(runtime.refreshPlatformModels ? { refreshPlatformModels: runtime.refreshPlatformModels } : {}),
    ...(runtime.localOwnerBaseUrl ? { localOwnerBaseUrl: runtime.localOwnerBaseUrl } : {})
  };
}
