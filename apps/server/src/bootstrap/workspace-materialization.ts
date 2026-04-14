import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceRecord } from "@oah/runtime-core";

import { syncLocalDirectoryToRemote, syncRemotePrefixToLocal, type DirectoryObjectStore } from "../object-storage.js";

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
  ownerWorkerId: string;
  source: WorkspaceMaterializationSource;
  localPath: string;
  dirty: boolean;
  refCount: number;
  materializedAt?: string | undefined;
  lastActivityAt: string;
  inFlight?: Promise<void> | undefined;
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

export interface WorkspaceMaterializationLease {
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  localPath: string;
  sourceKind: "object_store" | "local_directory";
  remotePrefix?: string | undefined;
  markDirty(): void;
  touch(): void;
  release(options?: { dirty?: boolean | undefined }): Promise<void>;
}

export interface WorkspaceMaterializationManagerOptions {
  cacheRoot: string;
  workerId: string;
  store: DirectoryObjectStore;
  logger?: ((message: string) => void) | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
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
  readonly #workerId: string;
  readonly #store: DirectoryObjectStore;
  readonly #logger: (message: string) => void;
  readonly #entries = new Map<string, WorkspaceMaterializationEntry>();

  constructor(options: WorkspaceMaterializationManagerOptions) {
    this.#cacheRoot = options.cacheRoot;
    this.#workerId = options.workerId;
    this.#store = options.store;
    this.#logger = options.logger ?? (() => undefined);
  }

  async acquireWorkspace(input: {
    workspace: Pick<WorkspaceRecord, "id" | "rootPath" | "externalRef">;
    version?: string | undefined;
  }): Promise<WorkspaceMaterializationLease> {
    const version = input.version?.trim() || "live";
    const source = resolveWorkspaceMaterializationSource(input.workspace);
    if (source.kind === "object_store" && source.bucket && this.#store.bucket && source.bucket !== this.#store.bucket) {
      throw new Error(
        `Workspace ${input.workspace.id} points to bucket ${source.bucket}, but the configured object store is ${this.#store.bucket}.`
      );
    }

    const cacheKey = this.#cacheKey(input.workspace.id, version, source);
    let entry = this.#entries.get(cacheKey);
    if (!entry) {
      entry = {
        cacheKey,
        workspaceId: input.workspace.id,
        version,
        ownerWorkerId: this.#workerId,
        source,
        localPath: this.#localPathForEntry(input.workspace.id, version, source),
        dirty: false,
        refCount: 0,
        lastActivityAt: nowIso()
      };
      this.#entries.set(cacheKey, entry);
    }

    await this.#ensureMaterialized(entry);
    entry.refCount += 1;
    this.#touchEntry(entry);

    let released = false;
    return {
      workspaceId: entry.workspaceId,
      version: entry.version,
      ownerWorkerId: entry.ownerWorkerId,
      localPath: entry.localPath,
      sourceKind: entry.source.kind,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
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
          entry!.dirty = true;
        }
        entry!.refCount = Math.max(0, entry!.refCount - 1);
        this.#touchEntry(entry!);
      }
    };
  }

  snapshot(): WorkspaceMaterializationSnapshot[] {
    return [...this.#entries.values()]
      .map((entry) => ({
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
      }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId) || left.version.localeCompare(right.version));
  }

  async flushIdleCopies(options?: { idleBefore?: string | undefined }): Promise<WorkspaceMaterializationSnapshot[]> {
    const thresholdMs = options?.idleBefore ? Date.parse(options.idleBefore) : Date.now();
    const flushed: WorkspaceMaterializationSnapshot[] = [];

    for (const entry of this.#entries.values()) {
      if (!this.#isIdle(entry, thresholdMs) || !entry.dirty) {
        continue;
      }
      await this.#flushEntry(entry);
      flushed.push(this.#toSnapshot(entry));
    }

    return flushed;
  }

  async evictIdleCopies(options?: { idleBefore?: string | undefined }): Promise<WorkspaceMaterializationSnapshot[]> {
    const thresholdMs = options?.idleBefore ? Date.parse(options.idleBefore) : Date.now();
    const evicted: WorkspaceMaterializationSnapshot[] = [];

    for (const entry of [...this.#entries.values()]) {
      if (!this.#isIdle(entry, thresholdMs)) {
        continue;
      }

      if (entry.dirty) {
        await this.#flushEntry(entry);
      }

      if (entry.source.kind === "object_store") {
        await rm(entry.localPath, { recursive: true, force: true });
      }

      this.#entries.delete(entry.cacheKey);
      evicted.push(this.#toSnapshot(entry));
    }

    return evicted;
  }

  async close(): Promise<void> {
    for (const entry of [...this.#entries.values()]) {
      if (entry.dirty) {
        await this.#flushEntry(entry);
      }
      if (entry.source.kind === "object_store") {
        await rm(entry.localPath, { recursive: true, force: true });
      }
    }
    this.#entries.clear();
  }

  async #ensureMaterialized(entry: WorkspaceMaterializationEntry): Promise<void> {
    if (entry.source.kind !== "object_store") {
      entry.materializedAt ??= nowIso();
      return;
    }

    if (entry.materializedAt) {
      return;
    }

    const source = entry.source;
    if (!entry.inFlight) {
      entry.inFlight = (async () => {
        await mkdir(path.dirname(entry.localPath), { recursive: true });
        this.#logger(
          `[workspace-materialization] materializing workspace ${entry.workspaceId} (${entry.version}) from ${source.remotePrefix} into ${entry.localPath}`
        );
        await syncRemotePrefixToLocal(this.#store, source.remotePrefix, entry.localPath, this.#logger, entry.workspaceId);
        entry.materializedAt = nowIso();
      })().finally(() => {
        entry.inFlight = undefined;
      });
    }

    await entry.inFlight;
  }

  async #flushEntry(entry: WorkspaceMaterializationEntry): Promise<void> {
    if (entry.source.kind !== "object_store" || !entry.dirty) {
      return;
    }

    this.#logger(
      `[workspace-materialization] flushing workspace ${entry.workspaceId} (${entry.version}) from ${entry.localPath} back to ${entry.source.remotePrefix}`
    );
    await syncLocalDirectoryToRemote(this.#store, entry.source.remotePrefix, entry.localPath, this.#logger, entry.workspaceId);
    entry.dirty = false;
    this.#touchEntry(entry);
  }

  #touchEntry(entry: WorkspaceMaterializationEntry): void {
    entry.lastActivityAt = nowIso();
  }

  #cacheKey(workspaceId: string, version: string, source: WorkspaceMaterializationSource): string {
    return `${workspaceId}:${version}:${buildCacheSuffix({ workspaceId, version, source })}`;
  }

  #localPathForEntry(workspaceId: string, version: string, source: WorkspaceMaterializationSource): string {
    if (source.kind === "local_directory") {
      return source.rootPath;
    }

    const workspaceSegment = safeSegment(workspaceId);
    const versionSegment = safeSegment(version);
    const suffix = buildCacheSuffix({ workspaceId, version, source });
    return path.join(this.#cacheRoot, workspaceSegment, `${versionSegment}-${suffix}`);
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
}
