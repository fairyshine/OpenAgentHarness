import { describe, expect, it } from "vitest";

import {
  isRemoteSandboxProviderConfig,
  isRemoteSandboxProviderKind,
  normalizeOwnerProxyBaseUrl,
  normalizeSandboxOwnerInternalBaseUrl,
  projectWorkspaceRootPathForPublicApi,
  resolveConfiguredSandboxProvider,
  resolveSandboxOwnerFallbackBaseUrl,
  shouldDeferEmbeddedSandboxMaterialization,
  shouldDelegateWorkspaceOperationToFallbackWorker,
  shouldCleanupWorkspaceThroughSandboxHost,
  shouldExposeLocalWorkspaceManagement,
  shouldProjectWorkspaceRootPath,
  shouldRefreshWorkspaceDefinitionsFromLiveRoots,
  shouldSnapshotWorkspaceDefinitionBeforeDiscovery,
  shouldReserveOwnerScopedPlacement,
  shouldUseSandboxBackedWorkspaceInitializer,
  shouldUseSelfHostedWorkspaceDelegatingInitializer,
  shouldUseWorkspaceMaterialization
} from "../apps/server/src/sandbox-capabilities.ts";

describe("sandbox capabilities", () => {
  it("derives the configured provider from explicit and legacy self-hosted config", () => {
    expect(resolveConfiguredSandboxProvider({})).toBe("embedded");
    expect(
      resolveConfiguredSandboxProvider({
        sandbox: {
          self_hosted: {
            base_url: " http://127.0.0.1:8788/internal/v1 "
          }
        }
      })
    ).toBe("self_hosted");
    expect(
      resolveConfiguredSandboxProvider({
        sandbox: {
          provider: "e2b",
          self_hosted: {
            base_url: "http://127.0.0.1:8788/internal/v1"
          }
        }
      })
    ).toBe("e2b");
    expect(resolveConfiguredSandboxProvider({ sandbox: { provider: "e2b-aliyun" } })).toBe("e2b-aliyun");
    expect(isRemoteSandboxProviderConfig({})).toBe(false);
    expect(isRemoteSandboxProviderConfig({ sandbox: { provider: "self_hosted" } })).toBe(true);
  });

  it("identifies remote sandbox providers and public root path projection", () => {
    expect(isRemoteSandboxProviderKind(undefined)).toBe(false);
    expect(isRemoteSandboxProviderKind("embedded")).toBe(false);
    expect(isRemoteSandboxProviderKind("self_hosted")).toBe(true);
    expect(isRemoteSandboxProviderKind("e2b")).toBe(true);
    expect(isRemoteSandboxProviderKind("e2b-aliyun")).toBe(true);

    expect(shouldProjectWorkspaceRootPath("embedded")).toBe(false);
    expect(shouldProjectWorkspaceRootPath("self_hosted")).toBe(true);
    expect(projectWorkspaceRootPathForPublicApi("embedded", "/data/workspaces/ws_1")).toBe("/data/workspaces/ws_1");
    expect(projectWorkspaceRootPathForPublicApi("e2b", "/data/workspaces/ws_1")).toBe("/workspace");
    expect(projectWorkspaceRootPathForPublicApi("e2b-aliyun", "/data/workspaces/ws_1")).toBe("/workspace");
  });

  it("limits owner-scoped placement reservations to self-hosted sandbox workspaces", () => {
    expect(
      shouldReserveOwnerScopedPlacement({
        provider: "self_hosted",
        ownerId: "owner_1",
        workspaceId: "ws_1"
      })
    ).toBe(true);
    expect(
      shouldReserveOwnerScopedPlacement({
        provider: "e2b",
        ownerId: "owner_1",
        workspaceId: "ws_1"
      })
    ).toBe(false);
    expect(
      shouldReserveOwnerScopedPlacement({
        provider: "self_hosted",
        ownerId: undefined,
        workspaceId: "ws_1"
      })
    ).toBe(false);
  });

  it("delegates unresolved operations only for API-only self-hosted control planes with a fallback worker", () => {
    expect(
      shouldDelegateWorkspaceOperationToFallbackWorker({
        provider: "self_hosted",
        fallbackBaseUrl: "http://127.0.0.1:8788/internal/v1",
        localOwnerBaseUrl: undefined
      })
    ).toBe(true);
    expect(
      shouldDelegateWorkspaceOperationToFallbackWorker({
        provider: "self_hosted",
        fallbackBaseUrl: "http://127.0.0.1:8788/internal/v1",
        localOwnerBaseUrl: "http://127.0.0.1:8787/internal/v1"
      })
    ).toBe(false);
    expect(
      shouldDelegateWorkspaceOperationToFallbackWorker({
        provider: "e2b",
        fallbackBaseUrl: "http://127.0.0.1:8788/internal/v1",
        localOwnerBaseUrl: undefined
      })
    ).toBe(false);
  });

  it("normalizes self-hosted owner fallback URLs only for self-hosted providers", () => {
    expect(normalizeOwnerProxyBaseUrl(" http://127.0.0.1:8788/internal/v1/ ")).toBe("http://127.0.0.1:8788");
    expect(normalizeOwnerProxyBaseUrl("http://worker.internal/api/v1")).toBe("http://worker.internal");
    expect(normalizeOwnerProxyBaseUrl("worker.internal/internal/v1")).toBe("worker.internal");
    expect(normalizeSandboxOwnerInternalBaseUrl("http://worker.internal/api/v1")).toBe(
      "http://worker.internal/internal/v1"
    );
    expect(normalizeSandboxOwnerInternalBaseUrl("worker.internal/internal/v1")).toBe("worker.internal/internal/v1");
    expect(resolveSandboxOwnerFallbackBaseUrl({ provider: "self_hosted", configuredBaseUrl: "http://worker/api/v1" })).toBe(
      "http://worker"
    );
    expect(resolveSandboxOwnerFallbackBaseUrl({ provider: "e2b", configuredBaseUrl: "http://worker/api/v1" })).toBeUndefined();
  });

  it("keeps workspace definition refresh policy tied to sandbox topology", () => {
    expect(
      shouldRefreshWorkspaceDefinitionsFromLiveRoots({
        remoteSandboxProvider: false,
        controlPlaneFacadeEnabled: true
      })
    ).toBe(true);
    expect(
      shouldRefreshWorkspaceDefinitionsFromLiveRoots({
        remoteSandboxProvider: true,
        controlPlaneFacadeEnabled: true
      })
    ).toBe(false);
    expect(
      shouldRefreshWorkspaceDefinitionsFromLiveRoots({
        remoteSandboxProvider: false,
        controlPlaneFacadeEnabled: false
      })
    ).toBe(false);
    expect(shouldSnapshotWorkspaceDefinitionBeforeDiscovery({ remoteSandboxProvider: false })).toBe(false);
    expect(shouldSnapshotWorkspaceDefinitionBeforeDiscovery({ remoteSandboxProvider: true })).toBe(true);
  });

  it("centralizes workspace service routing policy", () => {
    expect(
      shouldUseSelfHostedWorkspaceDelegatingInitializer({
        processKind: "api",
        startWorker: false,
        remoteSandboxProvider: true,
        hasSelfHostedSandboxOptions: true
      })
    ).toBe(true);
    expect(
      shouldUseSelfHostedWorkspaceDelegatingInitializer({
        processKind: "worker",
        startWorker: false,
        remoteSandboxProvider: true,
        hasSelfHostedSandboxOptions: true
      })
    ).toBe(false);
    expect(
      shouldUseSandboxBackedWorkspaceInitializer({
        remoteSandboxProvider: true,
        sandboxHostAvailable: true,
        useSelfHostedWorkspaceDelegatingInitializer: false,
        objectStorageBacksManagedWorkspaces: false
      })
    ).toBe(true);
    expect(
      shouldUseSandboxBackedWorkspaceInitializer({
        remoteSandboxProvider: true,
        sandboxHostAvailable: true,
        useSelfHostedWorkspaceDelegatingInitializer: true,
        objectStorageBacksManagedWorkspaces: false
      })
    ).toBe(false);
    expect(shouldCleanupWorkspaceThroughSandboxHost({ remoteSandboxProvider: true, sandboxHostAvailable: true })).toBe(true);
    expect(shouldCleanupWorkspaceThroughSandboxHost({ remoteSandboxProvider: false, sandboxHostAvailable: true })).toBe(false);
    expect(shouldExposeLocalWorkspaceManagement({ remoteSandboxProvider: false })).toBe(true);
    expect(shouldExposeLocalWorkspaceManagement({ remoteSandboxProvider: true })).toBe(false);
  });

  it("centralizes sandbox materialization policy", () => {
    expect(
      shouldDeferEmbeddedSandboxMaterialization({
        remoteSandboxProvider: false,
        objectStorageConfigured: true,
        processKind: "api",
        startWorker: false,
        hasSandboxHostFactory: false
      })
    ).toBe(true);
    expect(
      shouldDeferEmbeddedSandboxMaterialization({
        remoteSandboxProvider: true,
        objectStorageConfigured: true,
        processKind: "api",
        startWorker: false,
        hasSandboxHostFactory: false
      })
    ).toBe(false);
    expect(
      shouldUseWorkspaceMaterialization({
        objectStorageConfigured: true,
        remoteSandboxProvider: false,
        selfHostedWorkerProcess: false
      })
    ).toBe(true);
    expect(
      shouldUseWorkspaceMaterialization({
        objectStorageConfigured: true,
        remoteSandboxProvider: true,
        selfHostedWorkerProcess: true
      })
    ).toBe(true);
    expect(
      shouldUseWorkspaceMaterialization({
        objectStorageConfigured: true,
        remoteSandboxProvider: true,
        selfHostedWorkerProcess: false
      })
    ).toBe(false);
    expect(
      shouldUseWorkspaceMaterialization({
        provider: "e2b",
        objectStorageConfigured: true,
        remoteSandboxProvider: true,
        selfHostedWorkerProcess: false
      })
    ).toBe(true);
    expect(
      shouldUseWorkspaceMaterialization({
        provider: "e2b-aliyun",
        objectStorageConfigured: true,
        remoteSandboxProvider: true,
        selfHostedWorkerProcess: false
      })
    ).toBe(true);
  });
});
