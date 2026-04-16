import type {
  SandboxExecutionModel,
  SandboxProviderKind,
  SandboxTopology,
  SandboxWorkerPlacement
} from "@oah/api-contracts";

function executionModelForProvider(provider: SandboxProviderKind): SandboxExecutionModel {
  return provider === "embedded" ? "local_embedded" : "sandbox_hosted";
}

function workerPlacementForProvider(provider: SandboxProviderKind): SandboxWorkerPlacement {
  return provider === "embedded" ? "api_process" : "inside_sandbox";
}

export function describeSandboxTopology(provider: SandboxProviderKind | undefined): SandboxTopology {
  const resolvedProvider = provider ?? "embedded";
  return {
    provider: resolvedProvider,
    executionModel: executionModelForProvider(resolvedProvider),
    workerPlacement: workerPlacementForProvider(resolvedProvider)
  };
}
