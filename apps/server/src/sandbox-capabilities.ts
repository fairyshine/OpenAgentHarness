import {
  SANDBOX_ROOT_PATH,
  type SandboxExecutionModel,
  type SandboxProviderKind,
  type SandboxTopology,
  type SandboxWorkerPlacement
} from "@oah/api-contracts";
import type { SandboxHostProviderKind } from "@oah/engine-core";

export function resolveConfiguredSandboxProvider(config: {
  sandbox?:
    | {
        provider?: SandboxProviderKind | undefined;
        self_hosted?: { base_url?: string | undefined } | undefined;
      }
    | undefined;
}): SandboxProviderKind {
  const configuredProvider = config.sandbox?.provider;
  if (configuredProvider) {
    return configuredProvider;
  }

  return config.sandbox?.self_hosted?.base_url?.trim() ? "self_hosted" : "embedded";
}

export function isRemoteSandboxProviderConfig(config: Parameters<typeof resolveConfiguredSandboxProvider>[0]): boolean {
  return isRemoteSandboxProviderKind(resolveConfiguredSandboxProvider(config));
}

export function sandboxExecutionModelForProvider(provider: SandboxProviderKind): SandboxExecutionModel {
  return provider === "embedded" ? "local_embedded" : "sandbox_hosted";
}

export function sandboxWorkerPlacementForProvider(provider: SandboxProviderKind): SandboxWorkerPlacement {
  return provider === "embedded" ? "api_process" : "inside_sandbox";
}

export function describeSandboxTopology(provider: SandboxProviderKind | undefined): SandboxTopology {
  const resolvedProvider = provider ?? "embedded";
  return {
    provider: resolvedProvider,
    executionModel: sandboxExecutionModelForProvider(resolvedProvider),
    workerPlacement: sandboxWorkerPlacementForProvider(resolvedProvider)
  };
}

export function isRemoteSandboxProviderKind(provider: SandboxHostProviderKind | undefined): boolean {
  return provider === "self_hosted" || provider === "e2b";
}

export function isSelfHostedSandboxProviderKind(provider: SandboxHostProviderKind | undefined): boolean {
  return provider === "self_hosted";
}

export function shouldProjectWorkspaceRootPath(provider: SandboxHostProviderKind | undefined): boolean {
  return isRemoteSandboxProviderKind(provider);
}

export function projectWorkspaceRootPathForPublicApi(
  provider: SandboxHostProviderKind | undefined,
  rootPath: string
): string {
  return shouldProjectWorkspaceRootPath(provider) ? SANDBOX_ROOT_PATH : rootPath;
}

export function shouldReserveOwnerScopedPlacement(input: {
  provider: SandboxHostProviderKind | undefined;
  ownerId: string | undefined;
  workspaceId: string | undefined;
}): boolean {
  return isSelfHostedSandboxProviderKind(input.provider) && Boolean(input.ownerId) && Boolean(input.workspaceId);
}

export function shouldDelegateWorkspaceOperationToFallbackWorker(input: {
  provider: SandboxHostProviderKind | undefined;
  fallbackBaseUrl: string | undefined;
  localOwnerBaseUrl: string | undefined;
}): boolean {
  return isSelfHostedSandboxProviderKind(input.provider) && Boolean(input.fallbackBaseUrl) && !input.localOwnerBaseUrl;
}

export function normalizeOwnerProxyBaseUrl(input: string | undefined): string | undefined {
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

export function resolveSandboxOwnerFallbackBaseUrl(input: {
  provider: SandboxHostProviderKind | undefined;
  configuredBaseUrl: string | undefined;
}): string | undefined {
  return isSelfHostedSandboxProviderKind(input.provider) ? normalizeOwnerProxyBaseUrl(input.configuredBaseUrl) : undefined;
}

export function normalizeSandboxOwnerInternalBaseUrl(input: string | undefined): string | undefined {
  const rootBaseUrl = normalizeOwnerProxyBaseUrl(input);
  return rootBaseUrl ? `${rootBaseUrl}/internal/v1` : undefined;
}

export function shouldRefreshWorkspaceDefinitionsFromLiveRoots(input: {
  remoteSandboxProvider: boolean;
  controlPlaneFacadeEnabled: boolean;
}): boolean {
  return !input.remoteSandboxProvider && input.controlPlaneFacadeEnabled;
}

export function shouldSnapshotWorkspaceDefinitionBeforeDiscovery(input: { remoteSandboxProvider: boolean }): boolean {
  return input.remoteSandboxProvider;
}

export function shouldDeferEmbeddedSandboxMaterialization(input: {
  remoteSandboxProvider: boolean;
  objectStorageConfigured: boolean;
  processKind: "api" | "worker";
  startWorker: boolean;
  hasSandboxHostFactory: boolean;
}): boolean {
  return (
    !input.remoteSandboxProvider &&
    input.objectStorageConfigured &&
    input.processKind === "api" &&
    !input.startWorker &&
    !input.hasSandboxHostFactory
  );
}

export function shouldUseWorkspaceMaterialization(input: {
  objectStorageConfigured: boolean;
  remoteSandboxProvider: boolean;
  selfHostedWorkerProcess: boolean;
}): boolean {
  return input.objectStorageConfigured && (!input.remoteSandboxProvider || input.selfHostedWorkerProcess);
}

export function shouldUseSelfHostedSeedTransfer(provider: SandboxHostProviderKind | undefined): boolean {
  return isSelfHostedSandboxProviderKind(provider);
}

export function shouldUseSelfHostedWorkspaceDelegatingInitializer(input: {
  processKind: "api" | "worker";
  startWorker: boolean;
  remoteSandboxProvider: boolean;
  hasSelfHostedSandboxOptions: boolean;
}): boolean {
  return input.processKind === "api" && !input.startWorker && input.remoteSandboxProvider && input.hasSelfHostedSandboxOptions;
}

export function shouldUseSandboxBackedWorkspaceInitializer(input: {
  remoteSandboxProvider: boolean;
  sandboxHostAvailable: boolean;
  useSelfHostedWorkspaceDelegatingInitializer: boolean;
  objectStorageBacksManagedWorkspaces: boolean;
}): boolean {
  return (
    input.remoteSandboxProvider &&
    input.sandboxHostAvailable &&
    !input.useSelfHostedWorkspaceDelegatingInitializer &&
    !input.objectStorageBacksManagedWorkspaces
  );
}

export function shouldCleanupWorkspaceThroughSandboxHost(input: {
  remoteSandboxProvider: boolean;
  sandboxHostAvailable: boolean;
}): boolean {
  return input.remoteSandboxProvider && input.sandboxHostAvailable;
}

export function shouldExposeLocalWorkspaceManagement(input: { remoteSandboxProvider: boolean }): boolean {
  return !input.remoteSandboxProvider;
}
