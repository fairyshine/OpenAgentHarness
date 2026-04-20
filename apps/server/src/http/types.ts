import type { FastifyRequest } from "fastify";

import type {
  CallerContext,
  ControlPlaneRuntimeOperations,
  ModelGateway,
  SandboxHostProviderKind
} from "@oah/engine-core";
import type {
  DistributedPlatformModelRefreshResult,
  HealthReport,
  PlatformModelSnapshot,
  ReadinessReport,
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
  modelGateway: ModelGateway;
  defaultModel: string;
  logger?: boolean;
  workspaceMode?: "multi" | "single";
  resolveWorkspaceOwnership?: ((workspaceId: string) => Promise<{
    workspaceId: string;
    version: string;
    ownerWorkerId: string;
    ownerBaseUrl?: string | undefined;
    health: "healthy" | "late";
    lastActivityAt: string;
    localPath: string;
    remotePrefix?: string | undefined;
    isLocalOwner: boolean;
  } | undefined>) | undefined;
  resolveCallerContext?: ((request: FastifyRequest) => Promise<CallerContext | undefined> | CallerContext | undefined) | undefined;
  listWorkspaceRuntimes?: (() => Promise<import("@oah/config").WorkspaceRuntimeDescriptor[]>) | undefined;
  uploadWorkspaceRuntime?: ((input: {
    runtimeName: string;
    zipBuffer: Buffer;
    overwrite: boolean;
  }) => Promise<import("@oah/config").WorkspaceRuntimeDescriptor>) | undefined;
  deleteWorkspaceRuntime?: ((input: {
    runtimeName: string;
  }) => Promise<void>) | undefined;
  listPlatformModels?: (() => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
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
  healthCheck?: () => Promise<HealthReport> | HealthReport;
  readinessCheck?: () => Promise<ReadinessReport> | ReadinessReport;
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
}

export interface AppRouteOptions {
  workspaceMode: "multi" | "single";
}
