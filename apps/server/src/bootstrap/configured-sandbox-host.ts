import type { ServerConfig } from "@oah/config";
import type { WorkerRegistry, WorkspacePlacementRegistry } from "@oah/engine-core";

import type { SandboxHost } from "./sandbox-host.js";
import { trimToUndefined } from "./string-utils.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";
import {
  describeSandboxTopology,
  resolveConfiguredSandboxProvider
} from "../sandbox-capabilities.js";

let sandboxHostModulePromise: Promise<typeof import("./sandbox-host.js")> | undefined;
let e2bCompatibleSandboxHostModulePromise: Promise<typeof import("./e2b-compatible-sandbox-host.js")> | undefined;
let nativeE2BSandboxServiceModulePromise: Promise<typeof import("./native-e2b-sandbox-service.js")> | undefined;
let selfHostedSandboxRoutingModulePromise: Promise<typeof import("./self-hosted-sandbox-routing.js")> | undefined;

function loadSandboxHostModule(): Promise<typeof import("./sandbox-host.js")> {
  sandboxHostModulePromise ??= import("./sandbox-host.js");
  return sandboxHostModulePromise;
}

function loadE2BCompatibleSandboxHostModule(): Promise<typeof import("./e2b-compatible-sandbox-host.js")> {
  e2bCompatibleSandboxHostModulePromise ??= import("./e2b-compatible-sandbox-host.js");
  return e2bCompatibleSandboxHostModulePromise;
}

function loadNativeE2BSandboxServiceModule(): Promise<typeof import("./native-e2b-sandbox-service.js")> {
  nativeE2BSandboxServiceModulePromise ??= import("./native-e2b-sandbox-service.js");
  return nativeE2BSandboxServiceModulePromise;
}

function loadSelfHostedSandboxRoutingModule(): Promise<typeof import("./self-hosted-sandbox-routing.js")> {
  selfHostedSandboxRoutingModulePromise ??= import("./self-hosted-sandbox-routing.js");
  return selfHostedSandboxRoutingModulePromise;
}

export async function createConfiguredSandboxHost(options: {
  config: ServerConfig;
  workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
  createWorkspaceMaterializationManager?: (() => WorkspaceMaterializationManager) | undefined;
  selfHostedWorkerProcess?: boolean | undefined;
  workspacePlacementRegistry?: Pick<WorkspacePlacementRegistry, "listAll" | "assignOwnerAffinity"> | undefined;
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
}): Promise<SandboxHost | undefined> {
  const provider = resolveConfiguredSandboxProvider(options.config);

  if (provider === "embedded") {
    const topology = describeSandboxTopology("embedded");
    const materializationManager = options.workspaceMaterializationManager;
    if (!materializationManager && !options.createWorkspaceMaterializationManager) {
      return undefined;
    }

    const { createLazySandboxHost, createMaterializationSandboxHost } = await loadSandboxHostModule();
    if (!materializationManager && options.createWorkspaceMaterializationManager) {
      let lazyMaterializationManager: WorkspaceMaterializationManager | undefined;
      return createLazySandboxHost({
        providerKind: "embedded",
        createHost: () => {
          lazyMaterializationManager ??= options.createWorkspaceMaterializationManager!();
          return createMaterializationSandboxHost({
            materializationManager: lazyMaterializationManager
          });
        },
        diagnostics: () => ({
          provider: topology.provider,
          executionModel: topology.executionModel,
          workerPlacement: topology.workerPlacement,
          materialization: lazyMaterializationManager?.diagnostics()
        })
      });
    }

    return createMaterializationSandboxHost({
      materializationManager: materializationManager!
    });
  }

  if (provider === "self_hosted") {
    const topology = describeSandboxTopology("self_hosted");
    if (options.selfHostedWorkerProcess) {
      if (!options.workspaceMaterializationManager) {
        return undefined;
      }
      return (await loadSandboxHostModule()).createMaterializationSandboxHost({
        materializationManager: options.workspaceMaterializationManager,
        providerKind: "self_hosted",
        diagnostics: {
          provider: topology.provider,
          executionModel: topology.executionModel,
          workerPlacement: topology.workerPlacement
        }
      });
    }

    const baseUrl = trimToUndefined(options.config.sandbox?.self_hosted?.base_url);
    if (!baseUrl) {
      throw new Error("sandbox.self_hosted.base_url is required when sandbox.provider is self_hosted.");
    }

    const [{ createE2BCompatibleSandboxHost, createHttpE2BCompatibleSandboxService }, { resolveSelfHostedSandboxCreateBaseUrl }] =
      await Promise.all([loadE2BCompatibleSandboxHostModule(), loadSelfHostedSandboxRoutingModule()]);

    return createE2BCompatibleSandboxHost({
      providerKind: "self_hosted",
      diagnostics: {
        provider: topology.provider,
        transport: "http",
        executionModel: topology.executionModel,
        workerPlacement: topology.workerPlacement
      },
      service: createHttpE2BCompatibleSandboxService({
        baseUrl,
        ...(options.config.sandbox?.self_hosted?.headers ? { headers: options.config.sandbox.self_hosted.headers } : {}),
        ...(options.workspacePlacementRegistry
          ? {
              resolveCreateBaseUrl: (workspace) =>
                resolveSelfHostedSandboxCreateBaseUrl({
                  baseUrl,
                  workspace,
                  workspacePlacementRegistry: options.workspacePlacementRegistry,
                  maxWorkspacesPerSandbox: options.config.sandbox?.fleet?.max_workspaces_per_sandbox,
                  resourceCpuPressureThreshold: (
                    options.config.sandbox?.fleet as { resource_cpu_pressure_threshold?: number | undefined } | undefined
                  )?.resource_cpu_pressure_threshold,
                  resourceMemoryPressureThreshold: (
                    options.config.sandbox?.fleet as { resource_memory_pressure_threshold?: number | undefined } | undefined
                  )?.resource_memory_pressure_threshold,
                  resourceDiskPressureThreshold: (
                    options.config.sandbox?.fleet as { resource_disk_pressure_threshold?: number | undefined } | undefined
                  )?.resource_disk_pressure_threshold,
                  ...(options.workerRegistry ? { workerRegistry: options.workerRegistry } : {})
                })
            }
          : {})
      })
    });
  }

  const [{ createE2BCompatibleSandboxHost }, { createNativeE2BSandboxService, normalizeE2BApiUrl }] = await Promise.all([
    loadE2BCompatibleSandboxHostModule(),
    loadNativeE2BSandboxServiceModule()
  ]);

  return createE2BCompatibleSandboxHost({
    providerKind: "e2b",
    service: createNativeE2BSandboxService({
      apiKey: trimToUndefined(options.config.sandbox?.e2b?.api_key),
      apiUrl: normalizeE2BApiUrl(options.config.sandbox?.e2b?.base_url),
      domain: trimToUndefined(options.config.sandbox?.e2b?.domain),
      headers: options.config.sandbox?.e2b?.headers,
      template: trimToUndefined(options.config.sandbox?.e2b?.template),
      timeoutMs: options.config.sandbox?.e2b?.timeout_ms,
      requestTimeoutMs: options.config.sandbox?.e2b?.request_timeout_ms,
      maxWorkspacesPerSandbox: options.config.sandbox?.fleet?.max_workspaces_per_sandbox,
      ownerlessPool: options.config.sandbox?.fleet?.ownerless_pool,
      warmEmptyCount: options.config.sandbox?.fleet?.warm_empty_count
    })
  });
}
