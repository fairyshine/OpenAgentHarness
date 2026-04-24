import type { AppDependencies } from "./http/types.js";
import type { BootstrappedRuntime } from "./bootstrap.js";

function normalizeOwnerProxyBaseUrl(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname.replace(/\/(?:api|internal)\/v1\/?$/u, "").replace(/\/+$/u, "");
    return `${url.origin}${normalizedPath}`;
  } catch {
    return trimmed.replace(/\/(?:api|internal)\/v1\/?$/u, "").replace(/\/+$/u, "");
  }
}

function buildSharedAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  const sandboxOwnerFallbackBaseUrl =
    runtime.sandboxHostProviderKind === "self_hosted"
      ? normalizeOwnerProxyBaseUrl(runtime.config.sandbox?.self_hosted?.base_url)
      : undefined;

  return {
    runtimeService: runtime.controlPlaneEngineService,
    modelGateway: runtime.modelGateway,
    defaultModel: runtime.config.llm.default_model,
    workspaceMode: runtime.workspaceMode.kind,
    healthCheck: () => runtime.healthReport(),
    readinessCheck: () => runtime.readinessReport(),
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
      : {})
  };
}

export function buildApiAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  return {
    ...buildSharedAppDependencies(runtime),
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
    ...(runtime.importWorkspace ? { importWorkspace: runtime.importWorkspace } : {})
  };
}

export function buildWorkerAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  return {
    ...buildSharedAppDependencies(runtime),
    ...(runtime.refreshPlatformModels ? { refreshPlatformModels: runtime.refreshPlatformModels } : {}),
    ...(runtime.localOwnerBaseUrl ? { localOwnerBaseUrl: runtime.localOwnerBaseUrl } : {})
  };
}
