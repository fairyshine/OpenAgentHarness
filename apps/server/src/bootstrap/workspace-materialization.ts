import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceRecord } from "@oah/engine-core";
import type { WorkspaceLeaseRegistry, WorkspacePlacementRegistry } from "@oah/storage-redis";

import {
  computeLocalDirectoryFingerprint,
  shouldExcludeWorkspaceBackingStoreRelativePath,
  syncWorkspaceRootToObjectStore,
  syncRemotePrefixToLocal,
  type DirectoryObjectStore,
  type ObjectStoreRequestCounts,
  type RemoteToLocalDirectorySyncPhaseTimings
} from "../object-storage.js";

type WorkspaceMaterializationSource =
  | {
      kind: "object_store";
      bucket?: string | undefined;
      remotePrefix: string;
    }
  | {
      kind: "local_directory";
      rootPath: string;
    };

interface WorkspaceMaterializationEntry {
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

interface WorkspaceMaterializeResult {
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

function nowIso(): string {
  return new Date().toISOString();
}

const BACKGROUND_STATE_DIRECTORY_CANDIDATES = [
  [".openharness", "state", "background-tasks"],
  [".openharness", "state", "background"]
];
const MATERIALIZATION_SYNC_METADATA_DIRECTORY = ".sync-metadata";

interface MaterializationSyncMetadata {
  localFingerprint: string;
  syncedAt: string;
}

function normalizeRemotePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "workspace";
}

function buildCacheSuffix(input: { workspaceId: string; version: string; source: WorkspaceMaterializationSource }): string {
  const sourceKey = input.source.kind === "object_store" ? `${input.source.bucket ?? ""}:${input.source.remotePrefix}` : input.source.rootPath;
  return createHash("sha1").update(`${input.workspaceId}:${input.version}:${sourceKey}`).digest("hex").slice(0, 12);
}

function inferWorkspaceRootFromCacheRoot(cacheRoot: string): string {
  const normalizedCacheRoot = path.resolve(cacheRoot);
  const cacheParent = path.dirname(normalizedCacheRoot);
  if (path.basename(normalizedCacheRoot) === "__materialized__" && path.basename(cacheParent) === ".openharness") {
    return path.dirname(cacheParent);
  }

  return normalizedCacheRoot;
}

function parseExternalWorkspaceRef(externalRef: string): { bucket?: string | undefined; remotePrefix: string } {
  const parsed = new URL(externalRef);
  if (parsed.protocol !== "s3:") {
    throw new Error(`Unsupported workspace externalRef protocol: ${parsed.protocol}`);
  }

  return {
    bucket: parsed.hostname || undefined,
    remotePrefix: normalizeRemotePrefix(parsed.pathname)
  };
}

function resolveWorkspaceMaterializationSource(
  workspace: Pick<WorkspaceRecord, "rootPath" | "externalRef">
): WorkspaceMaterializationSource {
  if (!workspace.externalRef) {
    return {
      kind: "local_directory",
      rootPath: workspace.rootPath
    };
  }

  const parsed = parseExternalWorkspaceRef(workspace.externalRef);
  return {
    kind: "object_store",
    bucket: parsed.bucket,
    remotePrefix: parsed.remotePrefix
  };
}

export class WorkspaceMaterializationManager {
  readonly #cacheRoot: string;
  readonly #workspaceRoot: string;
  readonly #workerId: string;
  readonly #ownerBaseUrl?: string | undefined;
  readonly #store: DirectoryObjectStore;
  readonly #leaseRegistry?: WorkspaceLeaseRegistry | undefined;
  readonly #placementRegistry?: WorkspacePlacementRegistry | undefined;
  readonly #leaseTtlMs: number;
  readonly #logger: (message: string) => void;
  readonly #entries = new Map<string, WorkspaceMaterializationEntry>();
  readonly #failures = new Map<string, WorkspaceMaterializationFailureDiagnostic>();
  #draining = false;
  #drainStartedAt: string | undefined;

  constructor(options: WorkspaceMaterializationManagerOptions) {
    this.#cacheRoot = options.cacheRoot;
    this.#workspaceRoot = path.resolve(options.workspaceRoot ?? inferWorkspaceRootFromCacheRoot(options.cacheRoot));
    this.#workerId = options.workerId;
    this.#ownerBaseUrl = options.ownerBaseUrl;
    this.#store = options.store;
    this.#leaseRegistry = options.leaseRegistry;
    this.#placementRegistry = options.placementRegistry;
    this.#leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? 15_000);
    this.#logger = options.logger ?? (() => undefined);
  }

  async acquireWorkspace(input: {
    workspace: Pick<WorkspaceRecord, "id" | "rootPath" | "externalRef" | "ownerId">;
    version?: string | undefined;
  }): Promise<WorkspaceMaterializationLease> {
    const version = input.version?.trim() || "live";
    const source = resolveWorkspaceMaterializationSource(input.workspace);
    if (source.kind === "object_store" && version !== "live") {
      throw new WorkspaceMaterializationUnsupportedVersionError(version);
    }
    if (source.kind === "object_store" && source.bucket && this.#store.bucket && source.bucket !== this.#store.bucket) {
      throw new Error(
        `Workspace ${input.workspace.id} points to bucket ${source.bucket}, but the configured object store is ${this.#store.bucket}.`
      );
    }

    const cacheKey = this.#cacheKey(input.workspace.id, version, source);
    let entry = this.#entries.get(cacheKey);
    if (this.#draining && !entry && source.kind === "object_store") {
      throw new WorkspaceMaterializationDrainingError();
    }
    if (!entry) {
      entry = {
        cacheKey,
        workspaceId: input.workspace.id,
        version,
        ...(input.workspace.ownerId?.trim() ? { ownerId: input.workspace.ownerId.trim() } : {}),
        ownerWorkerId: this.#workerId,
        source,
        localPath: this.#localPathForEntry(input.workspace.id, version, source, input.workspace.rootPath),
        dirty: false,
        refCount: 0,
        lastActivityAt: nowIso()
      };
      this.#entries.set(cacheKey, entry);
    }

    const materializeResult = await this.#ensureMaterialized(entry);
    const baselineFingerprint =
      entry.source.kind === "object_store"
        ? (entry.lastSyncedLocalFingerprint ?? (await this.#readSyncMetadata(entry))?.localFingerprint) ??
          (await computeLocalDirectoryFingerprint(entry.localPath, {
            excludeRelativePath: shouldExcludeWorkspaceBackingStoreRelativePath
          }))
        : undefined;
    if (baselineFingerprint !== undefined) {
      entry.lastSyncedLocalFingerprint = baselineFingerprint;
    }
    entry.refCount += 1;
    this.#touchEntry(entry);
    await this.#publishEntry(entry);

    let released = false;
    return {
      workspaceId: entry.workspaceId,
      version: entry.version,
      ownerWorkerId: entry.ownerWorkerId,
      localPath: entry.localPath,
      sourceKind: entry.source.kind,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      ...(materializeResult?.requestCounts ? { materializeRequestCounts: materializeResult.requestCounts } : {}),
      ...(materializeResult?.phaseTimings ? { materializePhaseTimings: materializeResult.phaseTimings } : {}),
      markDirty: () => {
        entry!.dirty = true;
        this.#touchEntry(entry!);
      },
      touch: () => {
        this.#touchEntry(entry!);
      },
      release: async (options?: { dirty?: boolean | undefined }) => {
        if (released) {
          return;
        }

        released = true;
        if (options?.dirty) {
          if (baselineFingerprint !== undefined) {
            entry!.dirty ||=
              (await computeLocalDirectoryFingerprint(entry!.localPath, {
                excludeRelativePath: shouldExcludeWorkspaceBackingStoreRelativePath
              })) !== baselineFingerprint;
          } else {
            entry!.dirty = true;
          }
        }
        entry!.refCount = Math.max(0, entry!.refCount - 1);
        this.#touchEntry(entry!);
        await this.#publishEntry(entry!);
        if (this.#draining && entry!.refCount === 0) {
          await this.#flushAndEvictEntry(entry!, "drain_release");
        }
      }
    };
  }

  isDraining(): boolean {
    return this.#draining;
  }

  drainStartedAt(): string | undefined {
    return this.#drainStartedAt;
  }

  snapshot(): WorkspaceMaterializationSnapshot[] {
    return [...this.#entries.values()]
      .map((entry) => ({
        cacheKey: entry.cacheKey,
        workspaceId: entry.workspaceId,
        version: entry.version,
        ownerWorkerId: entry.ownerWorkerId,
        ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
        sourceKind: entry.source.kind,
        localPath: entry.localPath,
        ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
        dirty: entry.dirty,
        refCount: entry.refCount,
        ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
        lastActivityAt: entry.lastActivityAt
      }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId) || left.version.localeCompare(right.version));
  }

  diagnostics(): WorkspaceMaterializationDiagnostics {
    const snapshots = this.snapshot();
    const failures = [...this.#failures.values()].sort((left, right) => left.at.localeCompare(right.at));
    return {
      draining: this.#draining,
      ...(this.#drainStartedAt ? { drainStartedAt: this.#drainStartedAt } : {}),
      cachedCopies: snapshots.length,
      objectStoreCopies: snapshots.filter((entry) => entry.sourceKind === "object_store").length,
      dirtyCopies: snapshots.filter((entry) => entry.dirty).length,
      busyCopies: snapshots.filter((entry) => entry.refCount > 0).length,
      idleCopies: snapshots.filter((entry) => entry.refCount === 0).length,
      failureCount: failures.length,
      blockerCount: failures.filter((failure) => failure.dirty || failure.refCount > 0 || failure.stage.startsWith("drain")).length,
      failures
    };
  }

  async beginDrain(): Promise<{
    drainStartedAt: string;
    flushed: WorkspaceMaterializationSnapshot[];
    evicted: WorkspaceMaterializationSnapshot[];
  }> {
    if (!this.#draining) {
      this.#draining = true;
      this.#drainStartedAt = nowIso();
      this.#logger("[workspace-materialization] drain started; blocking new object-store materializations");
      await Promise.all([...this.#entries.values()].map((entry) => this.#publishEntry(entry)));
    }

    const drained = await this.#flushAndEvictIdleEntries(Date.now(), "drain_evict");
    const drainStartedAt = this.#drainStartedAt ?? nowIso();
    this.#drainStartedAt = drainStartedAt;
    return {
      drainStartedAt,
      flushed: drained.flushed,
      evicted: drained.evicted
    };
  }

  async flushIdleCopies(options?: { idleBefore?: string | undefined }): Promise<WorkspaceMaterializationSnapshot[]> {
    const thresholdMs = options?.idleBefore ? Date.parse(options.idleBefore) : Date.now();
    const flushed: WorkspaceMaterializationSnapshot[] = [];
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];

    for (const entry of this.#entries.values()) {
      if (!this.#isIdle(entry, thresholdMs) || !entry.dirty) {
        continue;
      }
      try {
        await this.#flushEntry(entry, "idle_flush");
        await this.#publishEntry(entry);
        flushed.push(this.#toSnapshot(entry));
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, "idle_flush", "flush"));
      }
    }

    this.#throwIfFailures(failures);
    return flushed;
  }

  async evictIdleCopies(options?: { idleBefore?: string | undefined }): Promise<WorkspaceMaterializationSnapshot[]> {
    const thresholdMs = options?.idleBefore ? Date.parse(options.idleBefore) : Date.now();
    const evicted: WorkspaceMaterializationSnapshot[] = [];
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];

    for (const entry of [...this.#entries.values()]) {
      if (!this.#isIdle(entry, thresholdMs)) {
        continue;
      }

      try {
        await this.#flushAndEvictEntry(entry, "idle_evict");
        evicted.push(this.#toSnapshot(entry));
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, "idle_evict", entry.dirty ? "flush" : "evict"));
      }
    }

    this.#throwIfFailures(failures);
    return evicted;
  }

  async close(): Promise<void> {
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];
    for (const entry of [...this.#entries.values()]) {
      try {
        await this.#flushAndEvictEntry(entry, "close");
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, "close", entry.dirty ? "flush" : "evict"));
      }
    }
    this.#throwIfFailures(failures);
  }

  async deleteWorkspaceCopies(workspaceId: string): Promise<WorkspaceMaterializationSnapshot[]> {
    const deleted: WorkspaceMaterializationSnapshot[] = [];
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];

    for (const entry of [...this.#entries.values()].filter((candidate) => candidate.workspaceId === workspaceId)) {
      try {
        await this.#removeEntryLease(entry);
        if (entry.source.kind === "object_store") {
          await rm(entry.localPath, { recursive: true, force: true });
        }
        this.#entries.delete(entry.cacheKey);
        this.#failures.delete(entry.cacheKey);
        deleted.push(this.#toSnapshot(entry));
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, "delete", "evict"));
      }
    }

    this.#throwIfFailures(failures);
    return deleted;
  }

  async refreshLeases(): Promise<void> {
    for (const entry of this.#entries.values()) {
      await this.#refreshBackgroundActivity(entry);
      await this.#publishEntry(entry);
    }
  }

  async touchWorkspaceActivity(
    workspaceId: string,
    options?: {
      version?: string | undefined;
    }
  ): Promise<boolean> {
    const version = options?.version?.trim();
    const matchingEntries = [...this.#entries.values()].filter(
      (entry) => entry.workspaceId === workspaceId && (version === undefined || entry.version === version)
    );

    if (matchingEntries.length === 0) {
      return false;
    }

    for (const entry of matchingEntries) {
      this.#touchEntry(entry);
      await this.#publishEntry(entry);
    }

    return true;
  }

  async #ensureMaterialized(entry: WorkspaceMaterializationEntry): Promise<WorkspaceMaterializeResult | undefined> {
    if (entry.source.kind !== "object_store") {
      entry.materializedAt ??= nowIso();
      this.#failures.delete(entry.cacheKey);
      return undefined;
    }

    if (entry.materializedAt) {
      return undefined;
    }

    const source = entry.source;
    if (!entry.inFlight) {
      entry.inFlight = (async () => {
        try {
          await mkdir(path.dirname(entry.localPath), { recursive: true });
          const adoptedLegacyCopy = await this.#adoptLegacyMaterializedCopy(entry);
          if (adoptedLegacyCopy) {
            this.#logger(
              `[workspace-materialization] adopted legacy materialized workspace ${entry.workspaceId} (${entry.version}) from ${adoptedLegacyCopy} into ${entry.localPath}`
            );
            entry.materializedAt = nowIso();
            this.#failures.delete(entry.cacheKey);
            return undefined;
          }
          this.#logger(
            `[workspace-materialization] materializing workspace ${entry.workspaceId} (${entry.version}) from ${source.remotePrefix} into ${entry.localPath}`
          );
          const syncResult = await syncRemotePrefixToLocal(
            this.#store,
            source.remotePrefix,
            entry.localPath,
            this.#logger,
            entry.workspaceId
          );
          entry.lastSyncedLocalFingerprint =
            syncResult.localFingerprint ??
            (await computeLocalDirectoryFingerprint(entry.localPath, {
              excludeRelativePath: shouldExcludeWorkspaceBackingStoreRelativePath
            }));
          await this.#writeSyncMetadata(entry);
          entry.materializedAt = nowIso();
          this.#failures.delete(entry.cacheKey);
          return {
            ...(syncResult.requestCounts ? { requestCounts: syncResult.requestCounts } : {}),
            ...(syncResult.phaseTimings ? { phaseTimings: syncResult.phaseTimings } : {})
          };
        } catch (error) {
          throw this.#recordOperationFailure(entry, "materialize", "materialize", error);
        }
      })().finally(() => {
        entry.inFlight = undefined;
      });
    }

    return await entry.inFlight;
  }

  async #flushEntry(entry: WorkspaceMaterializationEntry, stage: WorkspaceMaterializationFailureStage): Promise<void> {
    if (entry.source.kind !== "object_store" || !entry.dirty) {
      return;
    }

    try {
      this.#logger(
        `[workspace-materialization] flushing workspace ${entry.workspaceId} (${entry.version}) from ${entry.localPath} back to ${entry.source.remotePrefix}`
      );
      const syncResult = await syncWorkspaceRootToObjectStore(
        this.#store,
        entry.source.remotePrefix,
        entry.localPath,
        this.#logger,
        entry.workspaceId
      );
      entry.lastSyncedLocalFingerprint =
        syncResult.localFingerprint ??
        (await computeLocalDirectoryFingerprint(entry.localPath, {
          excludeRelativePath: shouldExcludeWorkspaceBackingStoreRelativePath
        }));
      await this.#writeSyncMetadata(entry);
      entry.dirty = false;
      this.#touchEntry(entry);
      this.#failures.delete(entry.cacheKey);
    } catch (error) {
      throw this.#recordOperationFailure(entry, stage, "flush", error);
    }
  }

  async #flushAndEvictIdleEntries(thresholdMs: number, stage: Extract<WorkspaceMaterializationFailureStage, "idle_evict" | "drain_evict">): Promise<{
    flushed: WorkspaceMaterializationSnapshot[];
    evicted: WorkspaceMaterializationSnapshot[];
  }> {
    const flushed: WorkspaceMaterializationSnapshot[] = [];
    const evicted: WorkspaceMaterializationSnapshot[] = [];
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];

    for (const entry of [...this.#entries.values()]) {
      if (!this.#isIdle(entry, thresholdMs)) {
        continue;
      }

      const wasDirty = entry.dirty;
      try {
        await this.#flushAndEvictEntry(entry, stage);
        const snapshot = this.#toSnapshot(entry);
        if (wasDirty) {
          flushed.push(snapshot);
        }
        evicted.push(snapshot);
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, stage, wasDirty ? "flush" : "evict"));
      }
    }

    this.#throwIfFailures(failures);
    return {
      flushed,
      evicted
    };
  }

  async #flushAndEvictEntry(entry: WorkspaceMaterializationEntry, stage: Exclude<WorkspaceMaterializationFailureStage, "materialize" | "idle_flush">): Promise<void> {
    if (entry.dirty) {
      await this.#flushEntry(entry, stage);
    }
    try {
      await this.#removeEntryLease(entry);
      if (entry.source.kind === "object_store") {
        await rm(entry.localPath, { recursive: true, force: true });
      }
      this.#entries.delete(entry.cacheKey);
      this.#failures.delete(entry.cacheKey);
    } catch (error) {
      throw this.#recordOperationFailure(entry, stage, "evict", error);
    }
  }

  #touchEntry(entry: WorkspaceMaterializationEntry): void {
    entry.lastActivityAt = nowIso();
  }

  async #refreshBackgroundActivity(entry: WorkspaceMaterializationEntry): Promise<void> {
    if (entry.refCount > 0) {
      return;
    }

    if (!(await this.#hasActiveBackgroundTask(entry.localPath))) {
      return;
    }

    this.#touchEntry(entry);
  }

  async #hasActiveBackgroundTask(workspaceRoot: string): Promise<boolean> {
    for (const directorySegments of BACKGROUND_STATE_DIRECTORY_CANDIDATES) {
      const backgroundRoot = path.join(workspaceRoot, ...directorySegments);
      const sessionEntries = await readdir(backgroundRoot, { withFileTypes: true }).catch(() => []);
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory()) {
          continue;
        }

        const sessionRoot = path.join(backgroundRoot, sessionEntry.name);
        const taskEntries = await readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
        for (const taskEntry of taskEntries) {
          if (!taskEntry.isFile() || !taskEntry.name.endsWith(".json")) {
            continue;
          }

          const metadata = await readFile(path.join(sessionRoot, taskEntry.name), "utf8").catch(() => undefined);
          if (!metadata) {
            continue;
          }

          try {
            const parsed = JSON.parse(metadata) as { pid?: unknown };
            if (this.#isActiveBackgroundPid(parsed.pid)) {
              return true;
            }
          } catch {
            continue;
          }
        }
      }
    }

    return false;
  }

  #isActiveBackgroundPid(value: unknown): boolean {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return false;
    }

    try {
      process.kill(value, 0);
      return true;
    } catch {
      return false;
    }
  }

  async #publishEntry(entry: WorkspaceMaterializationEntry): Promise<void> {
    if (this.#leaseRegistry) {
      await this.#leaseRegistry.heartbeat(
        {
          workspaceId: entry.workspaceId,
          version: entry.version,
          ownerWorkerId: entry.ownerWorkerId,
          ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
          sourceKind: entry.source.kind,
          localPath: entry.localPath,
          dirty: entry.dirty,
          refCount: entry.refCount,
          lastActivityAt: entry.lastActivityAt,
          lastSeenAt: nowIso(),
          ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
          ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {})
        },
        this.#leaseTtlMs
      );
    }

    if (this.#placementRegistry) {
      await this.#placementRegistry.upsert({
        workspaceId: entry.workspaceId,
        version: entry.version,
        ...(entry.ownerId ? { ownerId: entry.ownerId } : {}),
        state: this.#draining ? "draining" : entry.refCount > 0 ? "active" : "idle",
        ownerWorkerId: entry.ownerWorkerId,
        ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
        sourceKind: entry.source.kind,
        localPath: entry.localPath,
        ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
        dirty: entry.dirty,
        refCount: entry.refCount,
        lastActivityAt: entry.lastActivityAt,
        ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
        updatedAt: nowIso()
      });
    }
  }

  async #removeEntryLease(entry: WorkspaceMaterializationEntry): Promise<void> {
    await this.#leaseRegistry?.remove(entry.workspaceId, entry.version, entry.ownerWorkerId);
    await this.#placementRegistry?.upsert({
      workspaceId: entry.workspaceId,
      version: entry.version,
      ...(entry.ownerId ? { ownerId: entry.ownerId } : {}),
      state: "evicted",
      ownerWorkerId: entry.ownerWorkerId,
      ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
      sourceKind: entry.source.kind,
      localPath: entry.localPath,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      dirty: false,
      refCount: 0,
      lastActivityAt: entry.lastActivityAt,
      ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
      updatedAt: nowIso()
    });
  }

  #cacheKey(workspaceId: string, version: string, source: WorkspaceMaterializationSource): string {
    return `${workspaceId}:${version}:${buildCacheSuffix({ workspaceId, version, source })}`;
  }

  #localPathForEntry(
    workspaceId: string,
    version: string,
    source: WorkspaceMaterializationSource,
    preferredRootPath: string
  ): string {
    if (source.kind === "local_directory") {
      return source.rootPath;
    }

    return this.#stableLiveWorkspaceRoot(workspaceId, preferredRootPath, version);
  }

  #stableLiveWorkspaceRoot(workspaceId: string, preferredRootPath: string, version: string): string {
    const normalizedPreferredRoot = path.resolve(preferredRootPath);
    const normalizedWorkspaceRoot = path.resolve(this.#workspaceRoot);
    const canonicalWorkspaceRoot = path.join(normalizedWorkspaceRoot, safeSegment(workspaceId));

    if (version !== "live") {
      return canonicalWorkspaceRoot;
    }

    const relativeToWorkspaceRoot = path.relative(normalizedWorkspaceRoot, normalizedPreferredRoot);
    if (
      relativeToWorkspaceRoot.startsWith("..") ||
      path.isAbsolute(relativeToWorkspaceRoot) ||
      relativeToWorkspaceRoot === "" ||
      relativeToWorkspaceRoot === "." ||
      relativeToWorkspaceRoot === ".openharness" ||
      relativeToWorkspaceRoot.startsWith(`.openharness${path.sep}`)
    ) {
      return canonicalWorkspaceRoot;
    }

    if (normalizedPreferredRoot !== canonicalWorkspaceRoot) {
      return canonicalWorkspaceRoot;
    }

    return normalizedPreferredRoot;
  }

  async #adoptLegacyMaterializedCopy(entry: WorkspaceMaterializationEntry): Promise<string | undefined> {
    if (entry.source.kind !== "object_store" || !this.#isStableWorkspaceRoot(entry.localPath)) {
      return undefined;
    }

    const existingEntries = await readdir(entry.localPath).catch(() => []);
    if (existingEntries.length > 0) {
      return undefined;
    }

    for (const legacyPath of this.#legacyMaterializedPaths(entry)) {
      if (legacyPath === entry.localPath) {
        continue;
      }

      const legacyEntries = await readdir(legacyPath).catch(() => []);
      if (legacyEntries.length === 0) {
        continue;
      }

      await rm(entry.localPath, { recursive: true, force: true });
      await rename(legacyPath, entry.localPath);
      await this.#pruneEmptyParents(path.dirname(legacyPath), this.#cacheRoot);
      entry.lastSyncedLocalFingerprint ??= (await this.#readSyncMetadata(entry))?.localFingerprint;
      return legacyPath;
    }

    return undefined;
  }

  #legacyMaterializedPaths(entry: WorkspaceMaterializationEntry): string[] {
    const workspaceSegment = safeSegment(entry.workspaceId);
    const versionSegment = safeSegment(entry.version);
    const suffix = buildCacheSuffix({
      workspaceId: entry.workspaceId,
      version: entry.version,
      source: entry.source
    });
    return [
      path.join(this.#cacheRoot, workspaceSegment),
      path.join(this.#cacheRoot, workspaceSegment, `${versionSegment}-${suffix}`)
    ];
  }

  #isStableWorkspaceRoot(localPath: string): boolean {
    const normalizedLocalPath = path.resolve(localPath);
    const normalizedWorkspaceRoot = path.resolve(this.#workspaceRoot);
    const relativeToWorkspaceRoot = path.relative(normalizedWorkspaceRoot, normalizedLocalPath);
    return !(
      relativeToWorkspaceRoot.startsWith("..") ||
      path.isAbsolute(relativeToWorkspaceRoot) ||
      relativeToWorkspaceRoot === "" ||
      relativeToWorkspaceRoot === "." ||
      relativeToWorkspaceRoot === ".openharness" ||
      relativeToWorkspaceRoot.startsWith(`.openharness${path.sep}`)
    );
  }

  async #pruneEmptyParents(startPath: string, stopPath: string): Promise<void> {
    const normalizedStopPath = path.resolve(stopPath);
    let currentPath = path.resolve(startPath);
    while (currentPath.startsWith(`${normalizedStopPath}${path.sep}`) || currentPath === normalizedStopPath) {
      const entries = await readdir(currentPath).catch(() => []);
      if (entries.length > 0) {
        return;
      }

      await rm(currentPath, { recursive: false, force: true }).catch(() => undefined);
      if (currentPath === normalizedStopPath) {
        return;
      }
      currentPath = path.dirname(currentPath);
    }
  }

  #syncMetadataPath(entry: WorkspaceMaterializationEntry): string {
    return path.join(this.#cacheRoot, MATERIALIZATION_SYNC_METADATA_DIRECTORY, `${safeSegment(entry.cacheKey)}.json`);
  }

  async #readSyncMetadata(entry: WorkspaceMaterializationEntry): Promise<MaterializationSyncMetadata | undefined> {
    const metadataPath = this.#syncMetadataPath(entry);
    const content = await readFile(metadataPath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!content) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(content) as Partial<MaterializationSyncMetadata>;
      if (typeof parsed.localFingerprint !== "string" || parsed.localFingerprint.length === 0) {
        return undefined;
      }

      return {
        localFingerprint: parsed.localFingerprint,
        syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : nowIso()
      };
    } catch {
      return undefined;
    }
  }

  async #writeSyncMetadata(entry: WorkspaceMaterializationEntry): Promise<void> {
    if (entry.source.kind !== "object_store" || !entry.lastSyncedLocalFingerprint) {
      return;
    }

    const metadataPath = this.#syncMetadataPath(entry);
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          localFingerprint: entry.lastSyncedLocalFingerprint,
          syncedAt: nowIso()
        } satisfies MaterializationSyncMetadata,
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  #isIdle(entry: WorkspaceMaterializationEntry, thresholdMs: number): boolean {
    return entry.refCount === 0 && Date.parse(entry.lastActivityAt) <= thresholdMs;
  }

  #toSnapshot(entry: WorkspaceMaterializationEntry): WorkspaceMaterializationSnapshot {
    return {
      cacheKey: entry.cacheKey,
      workspaceId: entry.workspaceId,
      version: entry.version,
      ownerWorkerId: entry.ownerWorkerId,
      sourceKind: entry.source.kind,
      localPath: entry.localPath,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      dirty: entry.dirty,
      refCount: entry.refCount,
      ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
      lastActivityAt: entry.lastActivityAt
    };
  }

  #recordOperationFailure(
    entry: WorkspaceMaterializationEntry,
    stage: WorkspaceMaterializationFailureStage,
    operation: WorkspaceMaterializationFailureDiagnostic["operation"],
    error: unknown
  ): WorkspaceMaterializationOperationError {
    const diagnostic: WorkspaceMaterializationFailureDiagnostic = {
      cacheKey: entry.cacheKey,
      workspaceId: entry.workspaceId,
      version: entry.version,
      ownerWorkerId: entry.ownerWorkerId,
      sourceKind: entry.source.kind,
      localPath: entry.localPath,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      stage,
      operation,
      at: nowIso(),
      errorMessage: error instanceof Error ? error.message : String(error),
      dirty: entry.dirty,
      refCount: entry.refCount,
      draining: this.#draining
    };
    this.#failures.set(entry.cacheKey, diagnostic);
    this.#logger(
      `[workspace-materialization] ${operation} failed during ${stage} for workspace ${entry.workspaceId} (${entry.version}): ${diagnostic.errorMessage}`
    );
    return new WorkspaceMaterializationOperationError(diagnostic, error);
  }

  #toFailureDiagnostic(
    error: unknown,
    entry: WorkspaceMaterializationEntry,
    stage: WorkspaceMaterializationFailureStage,
    operation: WorkspaceMaterializationFailureDiagnostic["operation"]
  ): WorkspaceMaterializationFailureDiagnostic {
    if (error instanceof WorkspaceMaterializationOperationError) {
      return error.diagnostic;
    }

    return this.#recordOperationFailure(entry, stage, operation, error).diagnostic;
  }

  #throwIfFailures(failures: WorkspaceMaterializationFailureDiagnostic[]): void {
    if (failures.length > 0) {
      throw new WorkspaceMaterializationAggregateError(failures);
    }
  }
}
