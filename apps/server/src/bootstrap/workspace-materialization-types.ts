import type { WorkspaceRecord } from "@oah/engine-core";
import type { WorkspaceLeaseRegistry, WorkspacePlacementRegistry } from "@oah/storage-redis";

import type {
  DirectoryObjectStore,
  ObjectStoreRequestCounts,
  RemoteToLocalDirectorySyncPhaseTimings
} from "../object-storage.js";

export type WorkspaceMaterializationSource =
  | {
      kind: "object_store";
      bucket?: string | undefined;
      remotePrefix: string;
    }
  | {
      kind: "local_directory";
      rootPath: string;
    };

export interface WorkspaceMaterializationEntry {
  cacheKey: string;
  workspaceId: string;
  version: string;
  ownerId?: string | undefined;
  ownerWorkerId: string;
  source: WorkspaceMaterializationSource;
  localPath: string;
  dirty: boolean;
  refCount: number;
  materializedAt?: string | undefined;
  lastSyncedLocalFingerprint?: string | undefined;
  lastActivityAt: string;
  inFlight?: Promise<WorkspaceMaterializeResult | undefined> | undefined;
}

export class WorkspaceMaterializationDrainingError extends Error {
  constructor(message = "Workspace materialization is draining and cannot start a new object-store materialization.") {
    super(message);
    this.name = "WorkspaceMaterializationDrainingError";
  }
}

export class WorkspaceMaterializationUnsupportedVersionError extends Error {
  constructor(version: string) {
    super(
      `Workspace materialization only supports the live version locally. Received "${version}". ` +
        "Restore the desired object-store state into the live workspace before using it."
    );
    this.name = "WorkspaceMaterializationUnsupportedVersionError";
  }
}

export type WorkspaceMaterializationFailureStage =
  | "materialize"
  | "idle_flush"
  | "idle_evict"
  | "drain_evict"
  | "drain_release"
  | "delete"
  | "close";

export interface WorkspaceMaterializationFailureDiagnostic {
  cacheKey: string;
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  sourceKind: "object_store" | "local_directory";
  localPath: string;
  remotePrefix?: string | undefined;
  stage: WorkspaceMaterializationFailureStage;
  operation: "materialize" | "flush" | "evict";
  at: string;
  errorMessage: string;
  dirty: boolean;
  refCount: number;
  draining: boolean;
}

export class WorkspaceMaterializationOperationError extends Error {
  readonly diagnostic: WorkspaceMaterializationFailureDiagnostic;
  readonly cause: unknown;

  constructor(diagnostic: WorkspaceMaterializationFailureDiagnostic, cause: unknown) {
    super(
      `Workspace materialization ${diagnostic.operation} failed during ${diagnostic.stage} for ${diagnostic.workspaceId}@${diagnostic.version}: ${diagnostic.errorMessage}`
    );
    this.name = "WorkspaceMaterializationOperationError";
    this.diagnostic = diagnostic;
    this.cause = cause;
  }
}

export class WorkspaceMaterializationAggregateError extends Error {
  readonly failures: WorkspaceMaterializationFailureDiagnostic[];

  constructor(failures: WorkspaceMaterializationFailureDiagnostic[]) {
    super(
      `Workspace materialization encountered ${failures.length} failure(s): ${failures
        .map((failure) => `${failure.workspaceId}@${failure.version}:${failure.stage}`)
        .join(", ")}`
    );
    this.name = "WorkspaceMaterializationAggregateError";
    this.failures = failures;
  }
}

export interface WorkspaceMaterializationSnapshot {
  cacheKey: string;
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  sourceKind: "object_store" | "local_directory";
  localPath: string;
  remotePrefix?: string | undefined;
  dirty: boolean;
  refCount: number;
  materializedAt?: string | undefined;
  lastActivityAt: string;
}

export interface WorkspaceMaterializationDiagnostics {
  draining: boolean;
  drainStartedAt?: string | undefined;
  cachedCopies: number;
  objectStoreCopies: number;
  dirtyCopies: number;
  busyCopies: number;
  idleCopies: number;
  failureCount: number;
  blockerCount: number;
  failures: WorkspaceMaterializationFailureDiagnostic[];
}

export interface WorkspaceMaterializationLease {
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  localPath: string;
  sourceKind: "object_store" | "local_directory";
  remotePrefix?: string | undefined;
  materializeRequestCounts?: ObjectStoreRequestCounts | undefined;
  materializePhaseTimings?: RemoteToLocalDirectorySyncPhaseTimings | undefined;
  markDirty(): void;
  touch(): void;
  release(options?: { dirty?: boolean | undefined }): Promise<void>;
}

export interface WorkspaceMaterializeResult {
  requestCounts?: ObjectStoreRequestCounts | undefined;
  phaseTimings?: RemoteToLocalDirectorySyncPhaseTimings | undefined;
}

export interface WorkspaceMaterializationManagerOptions {
  cacheRoot: string;
  workspaceRoot?: string | undefined;
  workerId: string;
  ownerBaseUrl?: string | undefined;
  store: DirectoryObjectStore;
  leaseRegistry?: WorkspaceLeaseRegistry | undefined;
  placementRegistry?: WorkspacePlacementRegistry | undefined;
  leaseTtlMs?: number | undefined;
  logger?: ((message: string) => void) | undefined;
}

export type WorkspaceMaterializationWorkspace = Pick<WorkspaceRecord, "id" | "rootPath" | "externalRef" | "ownerId">;
