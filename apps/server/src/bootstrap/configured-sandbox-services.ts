import type { PlatformModelRegistry, ServerConfig } from "@oah/config";
import type { EngineService, WorkspaceActivityTracker, WorkspaceInitializer, WorkspaceRecord } from "@oah/engine-core";

import { createLocalWorkspaceInitializer } from "./local-workspace-initializer.js";
import { objectStorageBacksManagedWorkspaces } from "./object-storage-policy.js";
import type { SandboxHost } from "./sandbox-host.js";
import type { SelfHostedSandboxInitializerOptions } from "./self-hosted-workspace-initializer.js";
import { trimToUndefined } from "./string-utils.js";
import type { PlatformAgentRegistry } from "./workspace-registry.js";
import { createWorkspaceDeletionHandler } from "./workspace-deletion-handler.js";
import { createWorkspaceLifecycle } from "./workspace-lifecycle-service.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";
import {
  isRemoteSandboxProviderConfig,
  isRemoteSandboxProviderKind,
  isSelfHostedSandboxProviderKind,
  resolveConfiguredSandboxProvider,
  shouldDeferEmbeddedSandboxMaterialization,
  shouldUseSandboxBackedWorkspaceInitializer,
  shouldUseSelfHostedWorkspaceDelegatingInitializer,
  shouldUseWorkspaceMaterialization
} from "../sandbox-capabilities.js";

type ConfigWorkspaceModule = typeof import("@oah/config/workspace");
type ConfigRuntimesModule = typeof import("@oah/config/runtimes");
type ObjectStorageModule = typeof import("../object-storage.js");
type SandboxBackedWorkspaceInitializerModule = typeof import("./sandbox-backed-workspace-initializer.js");

export type SandboxWorkspaceInitializerMode = "self_hosted_delegated" | "sandbox_backed" | "local";
export type SandboxMaterializationMode = "none" | "eager" | "lazy";

export interface SandboxBootstrapPlan {
  provider: "embedded" | "self_hosted" | "e2b";
  remoteSandboxProvider: boolean;
  selfHostedWorkerProcess: boolean;
  materializationMode: SandboxMaterializationMode;
  shouldUseWorkspaceMaterialization: boolean;
  canDeferEmbeddedSandboxMaterialization: boolean;
}

export interface SandboxWorkspaceServicePlan {
  useSelfHostedWorkspaceDelegatingInitializer: boolean;
  useSandboxBackedWorkspaceInitializer: boolean;
  initializerMode: SandboxWorkspaceInitializerMode;
  selfHostedSandboxOptions?: SelfHostedSandboxInitializerOptions | undefined;
}

export { isRemoteSandboxProviderConfig as isRemoteSandboxProvider, resolveConfiguredSandboxProvider };

export function resolveSandboxBootstrapPlan(input: {
  config: ServerConfig;
  processKind: "api" | "worker";
  startWorker: boolean;
  hasSandboxHostFactory: boolean;
}): SandboxBootstrapPlan {
  const provider = resolveConfiguredSandboxProvider(input.config);
  const remoteSandboxProvider = isRemoteSandboxProviderKind(provider);
  const selfHostedWorkerProcess = input.processKind === "worker" && isSelfHostedSandboxProviderKind(provider);
  const objectStorageConfigured = Boolean(input.config.object_storage);
  const canDeferEmbeddedSandboxMaterialization = shouldDeferEmbeddedSandboxMaterialization({
    remoteSandboxProvider,
    objectStorageConfigured,
    processKind: input.processKind,
    startWorker: input.startWorker,
    hasSandboxHostFactory: input.hasSandboxHostFactory
  });
  const useWorkspaceMaterialization = shouldUseWorkspaceMaterialization({
    objectStorageConfigured,
    remoteSandboxProvider,
    selfHostedWorkerProcess
  });

  return {
    provider,
    remoteSandboxProvider,
    selfHostedWorkerProcess,
    materializationMode: canDeferEmbeddedSandboxMaterialization
      ? "lazy"
      : useWorkspaceMaterialization
        ? "eager"
        : "none",
    shouldUseWorkspaceMaterialization: useWorkspaceMaterialization,
    canDeferEmbeddedSandboxMaterialization
  };
}

export function resolveSandboxWorkspaceServicePlan(input: {
  config: ServerConfig;
  remoteSandboxProvider: boolean;
  sandboxHost?: SandboxHost | undefined;
  processKind: "api" | "worker";
  startWorker: boolean;
  workspacePlacementRegistry?: SelfHostedSandboxInitializerOptions["workspacePlacementRegistry"];
  workerRegistry?: SelfHostedSandboxInitializerOptions["workerRegistry"];
}): SandboxWorkspaceServicePlan {
  const selfHostedSandboxOptions =
    isSelfHostedSandboxProviderKind(input.sandboxHost?.providerKind) && trimToUndefined(input.config.sandbox?.self_hosted?.base_url)
      ? ({
          baseUrl: trimToUndefined(input.config.sandbox?.self_hosted?.base_url)!,
          headers: input.config.sandbox?.self_hosted?.headers,
          maxWorkspacesPerSandbox: input.config.sandbox?.fleet?.max_workspaces_per_sandbox,
          resourceCpuPressureThreshold: input.config.sandbox?.fleet?.resource_cpu_pressure_threshold,
          resourceMemoryPressureThreshold: input.config.sandbox?.fleet?.resource_memory_pressure_threshold,
          resourceDiskPressureThreshold: input.config.sandbox?.fleet?.resource_disk_pressure_threshold,
          ...(input.workspacePlacementRegistry ? { workspacePlacementRegistry: input.workspacePlacementRegistry } : {}),
          ...(input.workerRegistry ? { workerRegistry: input.workerRegistry } : {})
        } satisfies SelfHostedSandboxInitializerOptions)
      : undefined;
  const useSelfHostedWorkspaceDelegatingInitializer = shouldUseSelfHostedWorkspaceDelegatingInitializer({
    processKind: input.processKind,
    startWorker: input.startWorker,
    remoteSandboxProvider: input.remoteSandboxProvider,
    hasSelfHostedSandboxOptions: Boolean(selfHostedSandboxOptions)
  });
  const useSandboxBackedWorkspaceInitializer = shouldUseSandboxBackedWorkspaceInitializer({
    remoteSandboxProvider: input.remoteSandboxProvider,
    sandboxHostAvailable: Boolean(input.sandboxHost),
    useSelfHostedWorkspaceDelegatingInitializer,
    objectStorageBacksManagedWorkspaces: objectStorageBacksManagedWorkspaces(input.config)
  });

  return {
    useSelfHostedWorkspaceDelegatingInitializer,
    useSandboxBackedWorkspaceInitializer,
    initializerMode: useSelfHostedWorkspaceDelegatingInitializer
      ? "self_hosted_delegated"
      : useSandboxBackedWorkspaceInitializer
        ? "sandbox_backed"
        : "local",
    ...(selfHostedSandboxOptions ? { selfHostedSandboxOptions } : {})
  };
}

export async function createConfiguredWorkspaceInitializer(input: {
  plan: SandboxWorkspaceServicePlan;
  config: ServerConfig;
  toolDir: string;
  useRuntimeObjectStorageManagement: boolean;
  objectStorageModule: ObjectStorageModule | undefined;
  loadConfigWorkspaceModule: () => Promise<ConfigWorkspaceModule>;
  loadConfigRuntimesModule: () => Promise<ConfigRuntimesModule>;
  loadSandboxBackedWorkspaceInitializerModule: () => Promise<SandboxBackedWorkspaceInitializerModule>;
  discoverWorkspaceWithEnrichedModels(rootPath: string, kind: "project"): Promise<WorkspaceRecord>;
  getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord | undefined>;
  getPlatformAgents(): Promise<PlatformAgentRegistry>;
  platformModels: PlatformModelRegistry;
  sandboxHost?: SandboxHost | undefined;
}): Promise<WorkspaceInitializer> {
  if (input.plan.initializerMode === "self_hosted_delegated") {
    return (await input.loadSandboxBackedWorkspaceInitializerModule()).createSelfHostedWorkspaceDelegatingInitializer({
      selfHosted: input.plan.selfHostedSandboxOptions!,
      getWorkspaceRecord: input.getWorkspaceRecord
    });
  }

  if (input.plan.initializerMode === "sandbox_backed") {
    return (await input.loadSandboxBackedWorkspaceInitializerModule()).createSandboxBackedWorkspaceInitializer({
      runtimeDir: input.config.paths.runtime_dir,
      platformToolDir: input.config.paths.tool_dir,
      platformSkillDir: input.config.paths.skill_dir,
      toolDir: input.toolDir,
      platformModels: input.platformModels,
      platformAgents: await input.getPlatformAgents(),
      sandboxHost: input.sandboxHost!,
      ...(input.plan.selfHostedSandboxOptions ? { selfHosted: input.plan.selfHostedSandboxOptions } : {})
    });
  }

  return createLocalWorkspaceInitializer({
    config: input.config,
    toolDir: input.toolDir,
    useRuntimeObjectStorageManagement: input.useRuntimeObjectStorageManagement,
    objectStorageModule: input.objectStorageModule,
    loadConfigWorkspaceModule: input.loadConfigWorkspaceModule,
    loadConfigRuntimesModule: input.loadConfigRuntimesModule,
    discoverWorkspaceWithEnrichedModels: input.discoverWorkspaceWithEnrichedModels
  });
}

export function createSandboxWorkspaceActivityTracker(input: {
  workspaceMaterializationManager: WorkspaceMaterializationManager | undefined;
  canDeferEmbeddedSandboxMaterialization: boolean;
}): WorkspaceActivityTracker | undefined {
  if (!input.workspaceMaterializationManager && !input.canDeferEmbeddedSandboxMaterialization) {
    return undefined;
  }

  return {
    async touchWorkspace(workspaceId: string) {
      await input.workspaceMaterializationManager?.touchWorkspaceActivity(workspaceId);
    }
  };
}

export function createConfiguredWorkspaceDeletionHandler(input: {
  plan: SandboxWorkspaceServicePlan;
  config: ServerConfig;
  remoteSandboxProvider: boolean;
  sandboxHost: SandboxHost | undefined;
  workspaceMaterializationManager: WorkspaceMaterializationManager | undefined;
  objectStorageModule: ObjectStorageModule | undefined;
  objectStorageMirror: import("../object-storage.js").ObjectStorageMirrorController | undefined;
  sqliteShadowRoot: string;
  clearWorkspaceCoordination(workspaceId: string): Promise<void>;
  closeWorkspaceWatcher?: ((workspace: Pick<WorkspaceRecord, "rootPath">) => void) | undefined;
}) {
  return createWorkspaceDeletionHandler({
    config: input.config,
    remoteSandboxProvider: input.remoteSandboxProvider,
    sandboxHost: input.sandboxHost,
    useSelfHostedWorkspaceDelegatingInitializer: input.plan.useSelfHostedWorkspaceDelegatingInitializer,
    objectStorageModule: input.objectStorageModule,
    objectStorageMirror: input.objectStorageMirror,
    workspaceMaterializationManager: input.workspaceMaterializationManager,
    sqliteShadowRoot: input.sqliteShadowRoot,
    clearWorkspaceCoordination: input.clearWorkspaceCoordination,
    ...(input.closeWorkspaceWatcher ? { closeWorkspaceWatcher: input.closeWorkspaceWatcher } : {})
  });
}

export function createConfiguredWorkspaceLifecycle(input: {
  sandboxHost: SandboxHost | undefined;
  runtimeService: EngineService;
  workspaceMaterializationManager: WorkspaceMaterializationManager | undefined;
  touchWorkspaceActivity?: ((workspaceId: string) => Promise<void>) | undefined;
  clearWorkspaceCoordination(workspaceId: string): Promise<void>;
}) {
  return createWorkspaceLifecycle({
    sandboxHost: input.sandboxHost,
    runtimeService: input.runtimeService,
    workspaceMaterializationManager: input.workspaceMaterializationManager,
    touchWorkspaceActivity: input.touchWorkspaceActivity,
    clearWorkspaceCoordination: input.clearWorkspaceCoordination
  });
}

export function createSandboxHostMaintenance(input: {
  sandboxHost: SandboxHost | undefined;
  idleTtlMs: number;
  maintenanceIntervalMs: number;
}): { start(): NodeJS.Timeout | undefined } {
  if (!input.sandboxHost) {
    return {
      start: () => undefined
    };
  }

  const runSandboxHostMaintenance = () => {
    const idleBefore = new Date(Date.now() - input.idleTtlMs).toISOString();
    void input.sandboxHost!.maintain({ idleBefore }).catch((error: unknown) => {
      console.warn("Sandbox host maintenance failed.", error);
    });
  };

  return {
    start() {
      runSandboxHostMaintenance();
      const timer = setInterval(runSandboxHostMaintenance, input.maintenanceIntervalMs);
      timer.unref?.();
      return timer;
    }
  };
}
