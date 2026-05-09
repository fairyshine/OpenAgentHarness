export interface RuntimeAssemblyProfile {
  id: "api_control_plane" | "api_embedded_runtime" | "worker_executor";
  executionServicesMode: "eager" | "lazy";
  enablePlatformModelLiveReload: boolean;
  enableWorkerRuntime: boolean;
  enableAdminCapabilities: boolean;
  enableControlPlaneFacade: boolean;
}

export type WorkspaceModelMetadataDiscoveryMode = "eager" | "background" | "manual";

export function resolveRuntimeAssemblyProfile(options: {
  processKind: "api" | "worker";
  startWorker: boolean;
  remoteSandboxProvider: boolean;
}): RuntimeAssemblyProfile {
  void options.remoteSandboxProvider;

  if (options.processKind === "worker") {
    return {
      id: "worker_executor",
      executionServicesMode: "lazy",
      enablePlatformModelLiveReload: false,
      enableWorkerRuntime: true,
      enableAdminCapabilities: false,
      enableControlPlaneFacade: false
    };
  }

  if (!options.startWorker) {
    return {
      id: "api_control_plane",
      executionServicesMode: "lazy",
      enablePlatformModelLiveReload: false,
      enableWorkerRuntime: false,
      enableAdminCapabilities: true,
      enableControlPlaneFacade: true
    };
  }

  return {
    id: "api_embedded_runtime",
    executionServicesMode: "eager",
    enablePlatformModelLiveReload: false,
    enableWorkerRuntime: true,
    enableAdminCapabilities: true,
    enableControlPlaneFacade: true
  };
}

export function shouldManageWorkspaceRegistry(options: {
  processKind: "api" | "worker";
  hasSingleWorkspace: boolean;
  remoteSandboxProvider: boolean;
}): boolean {
  return options.processKind !== "worker" && !options.hasSingleWorkspace && !options.remoteSandboxProvider;
}

export function resolveWorkspaceModelMetadataDiscoveryMode(options: {
  processKind: "api" | "worker";
  hasSingleWorkspace: boolean;
  managesWorkspaceRegistry: boolean;
}): WorkspaceModelMetadataDiscoveryMode {
  if (options.processKind !== "api") {
    return "eager";
  }

  if (options.hasSingleWorkspace || !options.managesWorkspaceRegistry) {
    return "eager";
  }

  return "manual";
}
