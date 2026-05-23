import type { FastifyRequest } from "fastify";

import type {
  CallerContext,
  ControlPlaneRuntimeOperations,
  ModelGateway,
  SandboxHostProviderKind,
  WorkspaceEntryPage,
  WorkspaceEntrySortBy,
  SortOrder
} from "@oah/engine-core";
import type {
  DistributedPlatformModelRefreshResult,
  HealthReport,
  PlatformAssetKind,
  PlatformAssetList,
  PlatformAssetMutationResponse,
  PlatformModelSnapshot,
  ReadinessReport,
  SystemProfile,
  EngineLogEventContext
} from "@oah/api-contracts";
import type { StorageAdmin } from "../storage-admin.js";

declare module "fastify" {
  interface FastifyRequest {
    callerContext?: CallerContext;
  }
}

export interface AppDependencies {
  runtimeService: ControlPlaneRuntimeOperations;
  modelGateway?: ModelGateway;
  defaultModel: string;
  systemProfile?: SystemProfile | undefined;
  localApiAuthToken?: string | undefined;
  logger?: boolean;
  workspaceMode?: "multi" | "single";
  resolveWorkspaceOwnership?: ((workspaceId: string) => Promise<{
    workspaceId: string;
    version: string;
    ownerWorkerId: string;
    ownerBaseUrl?: string | undefined;
    health: "healthy" | "late";
    lastActivityAt: string;
    localPath?: string | undefined;
    remotePrefix?: string | undefined;
    isLocalOwner: boolean;
  } | undefined>) | undefined;
  resolveCallerContext?: ((request: FastifyRequest) => Promise<CallerContext | undefined> | CallerContext | undefined) | undefined;
  listWorkspaceRuntimes?: (() => Promise<import("@oah/config").WorkspaceRuntimeDescriptor[]>) | undefined;
  uploadWorkspaceRuntime?: ((input: {
    runtimeName: string;
    zipBuffer: Buffer;
    overwrite: boolean;
    requireExisting?: boolean | undefined;
  }) => Promise<import("@oah/config").WorkspaceRuntimeDescriptor>) | undefined;
  deleteWorkspaceRuntime?: ((input: {
    runtimeName: string;
  }) => Promise<void>) | undefined;
  listPlatformAssets?: ((kind: PlatformAssetKind) => Promise<PlatformAssetList>) | undefined;
  uploadPlatformModelAsset?: ((input: {
    name: string;
    yamlBuffer: Buffer;
    overwrite?: boolean | undefined;
    requireExisting?: boolean | undefined;
  }) => Promise<PlatformAssetMutationResponse>) | undefined;
  deletePlatformModelAsset?: ((input: { name: string }) => Promise<void>) | undefined;
  uploadPlatformToolAsset?: ((input: {
    name: string;
    definition: Record<string, unknown>;
    serverFiles?: Record<string, string> | undefined;
    overwrite?: boolean | undefined;
    requireExisting?: boolean | undefined;
  }) => Promise<PlatformAssetMutationResponse>) | undefined;
  deletePlatformToolAsset?: ((input: { name: string }) => Promise<void>) | undefined;
  uploadPlatformSkillAsset?: ((input: {
    name: string;
    skillMarkdown: string;
    files?: Record<string, string> | undefined;
    overwrite?: boolean | undefined;
    requireExisting?: boolean | undefined;
  }) => Promise<PlatformAssetMutationResponse>) | undefined;
  deletePlatformSkillAsset?: ((input: { name: string }) => Promise<void>) | undefined;
  listPlatformModels?: (() => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
      contextWindowTokens?: number;
      metadata?: Record<string, unknown>;
      isDefault: boolean;
    }>
  >) | undefined;
  getPlatformModelSnapshot?: (() => Promise<PlatformModelSnapshot>) | undefined;
  refreshPlatformModels?: (() => Promise<PlatformModelSnapshot>) | undefined;
  refreshDistributedPlatformModels?: (() => Promise<DistributedPlatformModelRefreshResult>) | undefined;
  subscribePlatformModelSnapshot?: ((listener: (snapshot: PlatformModelSnapshot) => void) => (() => void)) | undefined;
  importWorkspace?: (input: {
    rootPath: string;
    kind?: "project";
    name?: string;
    externalRef?: string;
    ownerId?: string;
    serviceName?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  registerLocalWorkspace?: (input: {
    rootPath: string;
    name?: string;
    runtime?: string;
    ownerId?: string;
    serviceName?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  repairLocalWorkspace?: (input: {
    workspaceId: string;
    rootPath: string;
    name?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  assignWorkspacePlacementOwnerAffinity?: ((input: {
    workspaceId: string;
    ownerId: string;
    overwrite?: boolean | undefined;
  }) => Promise<void>) | undefined;
  releaseWorkspacePlacement?: ((input: {
    workspaceId: string;
    state?: "unassigned" | "draining" | "evicted" | undefined;
  }) => Promise<void>) | undefined;
  clearWorkspaceCoordination?: ((workspaceId: string) => Promise<void>) | undefined;
  workspaceLifecycle?: {
    execute(input: {
      workspaceId: string;
      operation: "hydrate" | "flush" | "evict" | "delete" | "repair_placement";
      force?: boolean | undefined;
    }): Promise<{
      workspaceId: string;
      operation: "hydrate" | "flush" | "evict" | "delete" | "repair_placement";
      status: "completed" | "not_available";
      hydrated?: unknown[] | undefined;
      flushed?: unknown[] | undefined;
      evicted?: unknown[] | undefined;
      skipped?: unknown[] | undefined;
      repaired?: unknown[] | undefined;
    }>;
  } | undefined;
  healthCheck?: () => Promise<HealthReport> | HealthReport;
  readinessCheck?: () => Promise<ReadinessReport> | ReadinessReport;
  beginDrain?: (() => Promise<void> | void) | undefined;
  storageAdmin?: StorageAdmin;
  appendEngineLog?: (input: {
    sessionId: string;
    runId?: string | undefined;
    level: "debug" | "info" | "warn" | "error";
    category: "run" | "model" | "tool" | "hook" | "agent" | "http" | "system";
    message: string;
    details?: unknown;
    context?: EngineLogEventContext | undefined;
  }) => Promise<void>;
  sandboxHostProviderKind?: SandboxHostProviderKind | undefined;
  sandboxOwnerFallbackBaseUrl?: string | undefined;
  localOwnerBaseUrl?: string | undefined;
  touchWorkspaceActivity?: ((workspaceId: string) => Promise<void>) | undefined;
  listWorkspaceEntriesFast?: ((input: {
    workspaceId: string;
    path?: string | undefined;
    pageSize: number;
    cursor?: string | undefined;
    sortBy: WorkspaceEntrySortBy;
    sortOrder: SortOrder;
    includeDirectoryDescendantUpdatedAt?: boolean | undefined;
    includeEntryMetadata?: boolean | undefined;
  }) => Promise<WorkspaceEntryPage | undefined>) | undefined;
}

export interface AppRouteOptions {
  workspaceMode: "multi" | "single";
}
