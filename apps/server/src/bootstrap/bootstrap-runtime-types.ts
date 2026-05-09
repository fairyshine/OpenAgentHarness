import type {
  DistributedPlatformModelRefreshResult,
  HealthReport,
  ReadinessReport
} from "@oah/api-contracts";
import type { ServerConfig } from "@oah/config";
import type {
  ModelGateway,
  SandboxHostProviderKind
} from "../../../../packages/engine-core/src/types.js";
import type { ExecutionRuntimeOperations } from "../../../../packages/engine-core/src/execution-engine-service.js";
import type { EngineService } from "../../../../packages/engine-core/src/engine-service.js";
import type { ControlPlaneRuntimeOperations } from "../../../../packages/engine-core/src/control-plane-engine-service.js";
import type { EngineAdminCapabilities } from "./admin-capabilities.js";
import type { EngineProcessDescriptor } from "./engine-process.js";
import type { PlatformModelSnapshot } from "./platform-model-service.js";
import type { SandboxHost } from "./sandbox-host.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";
import type { PlatformAgentRegistry } from "./workspace-registry.js";

export interface BootstrapOptions {
  argv?: string[] | undefined;
  startWorker?: boolean | undefined;
  processKind?: "api" | "worker" | undefined;
  platformAgents?: PlatformAgentRegistry | undefined;
  sandboxHostFactory?:
    | ((input: {
        config: ServerConfig;
        processKind: "api" | "worker";
        workerId: string;
        ownerBaseUrl?: string | undefined;
        workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
      }) => Promise<SandboxHost | undefined> | SandboxHost | undefined)
    | undefined;
}

export interface BootstrappedRuntime {
  config: ServerConfig;
  controlPlaneEngineService: ControlPlaneRuntimeOperations;
  executionEngineService: ExecutionRuntimeOperations;
  runtimeService: EngineService;
  modelGateway: ModelGateway;
  process: EngineProcessDescriptor;
  workspaceMode:
    | {
        kind: "multi";
      }
    | {
        kind: "single";
        workspaceId: string;
        workspaceKind: "project";
        rootPath: string;
      };
  listWorkspaceRuntimes?: () => Promise<Array<{ name: string }>>;
  uploadWorkspaceRuntime?: (input: {
    runtimeName: string;
    zipBuffer: Buffer;
    overwrite?: boolean | undefined;
    requireExisting?: boolean | undefined;
  }) => Promise<{ name: string }>;
  deleteWorkspaceRuntime?: (input: { runtimeName: string }) => Promise<void>;
  listPlatformModels?: () => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
      metadata?: Record<string, unknown>;
      isDefault: boolean;
    }>
  >;
  getPlatformModelSnapshot?: () => Promise<PlatformModelSnapshot>;
  refreshPlatformModels?: () => Promise<PlatformModelSnapshot>;
  refreshDistributedPlatformModels?: () => Promise<DistributedPlatformModelRefreshResult>;
  subscribePlatformModelSnapshot?: (
    listener: (snapshot: PlatformModelSnapshot) => void
  ) => (() => void);
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
  clearWorkspaceCoordination?: (workspaceId: string) => Promise<void>;
  adminCapabilities?: EngineAdminCapabilities | undefined;
  sandboxHostProviderKind?: SandboxHostProviderKind | undefined;
  localOwnerBaseUrl?: string | undefined;
  touchWorkspaceActivity?: (workspaceId: string) => Promise<void>;
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
  };
  appendEngineLog(input: {
    sessionId: string;
    runId?: string | undefined;
    level: "debug" | "info" | "warn" | "error";
    category: "run" | "model" | "tool" | "hook" | "agent" | "http" | "system";
    message: string;
    details?: unknown;
    context?: import("@oah/api-contracts").EngineLogEventContext | undefined;
  }): Promise<void>;
  healthReport(): Promise<HealthReport>;
  readinessReport(): Promise<ReadinessReport>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}
