import { createClient, type RedisClientType } from "redis";

import type {
  WorkspacePlacementEntry,
  WorkspacePlacementInput,
  WorkspacePlacementRegistry,
  WorkspacePlacementState
} from "@oah/engine-core";
import type { CreateRedisWorkspacePlacementRegistryOptions } from "./registry-types.js";

export class RedisWorkspacePlacementRegistry implements WorkspacePlacementRegistry {
  readonly #commands: RedisClientType;
  readonly #ownsCommands: boolean;
  readonly #keyPrefix: string;

  constructor(options: CreateRedisWorkspacePlacementRegistryOptions) {
    this.#commands = options.commands ?? createClient({ url: options.url });
    this.#ownsCommands = !options.commands;
    this.#keyPrefix = options.keyPrefix ?? "oah";
  }

  async connect(): Promise<void> {
    if (!this.#commands.isOpen) {
      await this.#commands.connect();
    }
  }

  async upsert(entry: WorkspacePlacementInput): Promise<void> {
    const key = this.#placementKey(entry.workspaceId);
    const existing = await this.#commands.hGetAll(key);
    const existingOwnerId = this.#readStoredOwnerId(existing);
    const next = {
      workspaceId: entry.workspaceId,
      version: entry.version?.trim() || existing.version || "live",
      ...(existingOwnerId ? { ownerId: existingOwnerId } : {}),
      ...(existing.ownerWorkerId ? { ownerWorkerId: existing.ownerWorkerId } : {}),
      ...(existing.ownerBaseUrl ? { ownerBaseUrl: existing.ownerBaseUrl } : {}),
      ...(existing.preferredWorkerId ? { preferredWorkerId: existing.preferredWorkerId } : {}),
      ...(existing.preferredWorkerReason === "controller_target"
        ? { preferredWorkerReason: existing.preferredWorkerReason }
        : {}),
      state: entry.state,
      ...(existing.sourceKind === "object_store" || existing.sourceKind === "local_directory"
        ? { sourceKind: existing.sourceKind }
        : {}),
      ...(existing.localPath ? { localPath: existing.localPath } : {}),
      ...(existing.remotePrefix ? { remotePrefix: existing.remotePrefix } : {}),
      ...(existing.dirty ? { dirty: existing.dirty === "1" } : {}),
      ...(existing.refCount ? { refCount: Number(existing.refCount) } : {}),
      ...(existing.lastActivityAt ? { lastActivityAt: existing.lastActivityAt } : {}),
      ...(existing.materializedAt ? { materializedAt: existing.materializedAt } : {}),
      updatedAt: entry.updatedAt
    } satisfies WorkspacePlacementEntry;

    const inputOwnerId = entry.ownerId?.trim();
    if (inputOwnerId) {
      next.ownerId = inputOwnerId;
    }
    if (entry.ownerWorkerId?.trim()) {
      next.ownerWorkerId = entry.ownerWorkerId.trim();
    }
    if (entry.ownerBaseUrl?.trim()) {
      next.ownerBaseUrl = entry.ownerBaseUrl.trim();
    }
    if (entry.preferredWorkerId?.trim()) {
      next.preferredWorkerId = entry.preferredWorkerId.trim();
    }
    if (entry.preferredWorkerReason === "controller_target") {
      next.preferredWorkerReason = entry.preferredWorkerReason;
    }
    if (entry.sourceKind) {
      next.sourceKind = entry.sourceKind;
    }
    if (entry.localPath?.trim()) {
      next.localPath = entry.localPath;
    }
    if (entry.remotePrefix?.trim()) {
      next.remotePrefix = entry.remotePrefix;
    }
    if (typeof entry.dirty === "boolean") {
      next.dirty = entry.dirty;
    }
    if (typeof entry.refCount === "number") {
      next.refCount = Math.max(0, Math.floor(entry.refCount));
    }
    if (entry.lastActivityAt?.trim()) {
      next.lastActivityAt = entry.lastActivityAt;
    }
    if (entry.materializedAt?.trim()) {
      next.materializedAt = entry.materializedAt;
    }
    if (entry.ownerWorkerId?.trim() && !entry.preferredWorkerId?.trim()) {
      delete next.preferredWorkerId;
      delete next.preferredWorkerReason;
    }

    const transaction = this.#commands.multi().sAdd(this.#registrySetKey(), entry.workspaceId).hSet(key, {
      workspaceId: next.workspaceId,
      version: next.version,
      ...(next.ownerId ? { ownerId: next.ownerId } : {}),
      ...(next.ownerWorkerId ? { ownerWorkerId: next.ownerWorkerId } : {}),
      ...(next.ownerBaseUrl ? { ownerBaseUrl: next.ownerBaseUrl } : {}),
      ...(next.preferredWorkerId ? { preferredWorkerId: next.preferredWorkerId } : {}),
      ...(next.preferredWorkerReason ? { preferredWorkerReason: next.preferredWorkerReason } : {}),
      state: next.state,
      ...(next.sourceKind ? { sourceKind: next.sourceKind } : {}),
      ...(next.localPath ? { localPath: next.localPath } : {}),
      ...(next.remotePrefix ? { remotePrefix: next.remotePrefix } : {}),
      ...(typeof next.dirty === "boolean" ? { dirty: next.dirty ? "1" : "0" } : {}),
      ...(typeof next.refCount === "number" ? { refCount: String(next.refCount) } : {}),
      ...(next.lastActivityAt ? { lastActivityAt: next.lastActivityAt } : {}),
      ...(next.materializedAt ? { materializedAt: next.materializedAt } : {}),
      updatedAt: next.updatedAt
    });

    if (!next.ownerWorkerId) {
      transaction.hDel(key, "ownerWorkerId");
    }
    if (!next.ownerBaseUrl) {
      transaction.hDel(key, "ownerBaseUrl");
    }
    if (!next.sourceKind) {
      transaction.hDel(key, "sourceKind");
    }
    if (!next.localPath) {
      transaction.hDel(key, "localPath");
    }
    if (!next.remotePrefix) {
      transaction.hDel(key, "remotePrefix");
    }
    if (typeof next.dirty !== "boolean") {
      transaction.hDel(key, "dirty");
    }
    if (typeof next.refCount !== "number") {
      transaction.hDel(key, "refCount");
    }
    if (!next.lastActivityAt) {
      transaction.hDel(key, "lastActivityAt");
    }
    if (!next.materializedAt) {
      transaction.hDel(key, "materializedAt");
    }

    await transaction.exec();
  }

  async assignOwnerAffinity(
    workspaceId: string,
    ownerId: string,
    options?: { overwrite?: boolean | undefined; updatedAt?: string | undefined }
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedOwnerId = ownerId.trim();
    if (normalizedWorkspaceId.length === 0 || normalizedOwnerId.length === 0) {
      return;
    }

    const existing = await this.getByWorkspaceId(normalizedWorkspaceId);
    if (this.#readEntryOwnerId(existing) && !options?.overwrite) {
      return;
    }

    await this.upsert({
      workspaceId: normalizedWorkspaceId,
      ownerId: normalizedOwnerId,
      state: existing?.state ?? "unassigned",
      updatedAt: options?.updatedAt ?? new Date().toISOString()
    });
  }

  async setPreferredWorker(
    workspaceId: string,
    preferredWorkerId: string,
    options?: {
      reason?: "controller_target" | undefined;
      overwrite?: boolean | undefined;
      updatedAt?: string | undefined;
    }
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedPreferredWorkerId = preferredWorkerId.trim();
    if (normalizedWorkspaceId.length === 0 || normalizedPreferredWorkerId.length === 0) {
      return;
    }

    const existing = await this.getByWorkspaceId(normalizedWorkspaceId);
    if (!existing) {
      return;
    }
    if (existing.preferredWorkerId && !options?.overwrite) {
      return;
    }

    await this.upsert({
      workspaceId: normalizedWorkspaceId,
      state: existing.state,
      preferredWorkerId: normalizedPreferredWorkerId,
      preferredWorkerReason: options?.reason ?? "controller_target",
      updatedAt: options?.updatedAt ?? new Date().toISOString()
    });
  }

  async releaseOwnership(
    workspaceId: string,
    options?: {
      state?: WorkspacePlacementState | undefined;
      preferredWorkerId?: string | undefined;
      preferredWorkerReason?: "controller_target" | undefined;
      updatedAt?: string | undefined;
    }
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (normalizedWorkspaceId.length === 0) {
      return;
    }

    const existing = await this.getByWorkspaceId(normalizedWorkspaceId);
    if (!existing) {
      return;
    }

    const key = this.#placementKey(normalizedWorkspaceId);
    const nextState = options?.state ?? "unassigned";
    const updatedAt = options?.updatedAt ?? new Date().toISOString();
    const transaction = this.#commands.multi().sAdd(this.#registrySetKey(), normalizedWorkspaceId).hSet(key, {
      workspaceId: existing.workspaceId,
      version: existing.version,
      ...(this.#readEntryOwnerId(existing) ? { ownerId: this.#readEntryOwnerId(existing)! } : {}),
      ...(options?.preferredWorkerId?.trim()
        ? { preferredWorkerId: options.preferredWorkerId.trim() }
        : existing.preferredWorkerId
          ? { preferredWorkerId: existing.preferredWorkerId }
          : {}),
      ...((options?.preferredWorkerId?.trim() || existing.preferredWorkerId) &&
      (options?.preferredWorkerReason === "controller_target" || existing.preferredWorkerReason === "controller_target")
        ? { preferredWorkerReason: options?.preferredWorkerReason ?? existing.preferredWorkerReason ?? "controller_target" }
        : {}),
      state: nextState,
      ...(existing.sourceKind ? { sourceKind: existing.sourceKind } : {}),
      ...(existing.remotePrefix ? { remotePrefix: existing.remotePrefix } : {}),
      dirty: "0",
      refCount: "0",
      ...(existing.lastActivityAt ? { lastActivityAt: existing.lastActivityAt } : {}),
      updatedAt
    });

    transaction.hDel(key, "ownerWorkerId");
    transaction.hDel(key, "ownerBaseUrl");
    transaction.hDel(key, "localPath");
    transaction.hDel(key, "materializedAt");

    await transaction.exec();
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (normalizedWorkspaceId.length === 0) {
      return;
    }

    await this.#commands
      .multi()
      .sRem(this.#registrySetKey(), normalizedWorkspaceId)
      .del(this.#placementKey(normalizedWorkspaceId))
      .exec();
  }

  async listAll(): Promise<WorkspacePlacementEntry[]> {
    const workspaceIds = await this.#commands.sMembers(this.#registrySetKey());
    if (workspaceIds.length === 0) {
      return [];
    }

    const records = await Promise.all(
      workspaceIds.map(async (workspaceId) => ({
        workspaceId,
        fields: await this.#commands.hGetAll(this.#placementKey(workspaceId))
      }))
    );

    const items: WorkspacePlacementEntry[] = [];
    const missingWorkspaceIds: string[] = [];

    for (const record of records) {
      if (Object.keys(record.fields).length === 0) {
        missingWorkspaceIds.push(record.workspaceId);
        continue;
      }

      const ownerId = this.#readStoredOwnerId(record.fields);

      items.push({
        workspaceId: record.fields.workspaceId ?? record.workspaceId,
        version: record.fields.version ?? "live",
        ...(ownerId ? { ownerId } : {}),
        ...(record.fields.ownerWorkerId ? { ownerWorkerId: record.fields.ownerWorkerId } : {}),
        ...(record.fields.ownerBaseUrl ? { ownerBaseUrl: record.fields.ownerBaseUrl } : {}),
        ...(record.fields.preferredWorkerId ? { preferredWorkerId: record.fields.preferredWorkerId } : {}),
        ...(record.fields.preferredWorkerReason === "controller_target"
          ? { preferredWorkerReason: record.fields.preferredWorkerReason }
          : {}),
        state:
          record.fields.state === "active" ||
          record.fields.state === "idle" ||
          record.fields.state === "draining" ||
          record.fields.state === "evicted"
            ? record.fields.state
            : "unassigned",
        ...(record.fields.sourceKind === "object_store" || record.fields.sourceKind === "local_directory"
          ? { sourceKind: record.fields.sourceKind } : {}),
        ...(record.fields.localPath ? { localPath: record.fields.localPath } : {}),
        ...(record.fields.remotePrefix ? { remotePrefix: record.fields.remotePrefix } : {}),
        ...(record.fields.dirty ? { dirty: record.fields.dirty === "1" } : {}),
        ...(record.fields.refCount ? { refCount: Number(record.fields.refCount) } : {}),
        ...(record.fields.lastActivityAt ? { lastActivityAt: record.fields.lastActivityAt } : {}),
        ...(record.fields.materializedAt ? { materializedAt: record.fields.materializedAt } : {}),
        updatedAt: record.fields.updatedAt ?? new Date(0).toISOString()
      });
    }

    if (missingWorkspaceIds.length > 0) {
      await this.#commands.sRem(this.#registrySetKey(), missingWorkspaceIds);
    }

    return items.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  }

  async getByWorkspaceId(workspaceId: string): Promise<WorkspacePlacementEntry | undefined> {
    const fields = await this.#commands.hGetAll(this.#placementKey(workspaceId));
    if (Object.keys(fields).length === 0) {
      return undefined;
    }

    const ownerId = this.#readStoredOwnerId(fields);

    return {
      workspaceId: fields.workspaceId ?? workspaceId,
      version: fields.version ?? "live",
      ...(ownerId ? { ownerId } : {}),
      ...(fields.ownerWorkerId ? { ownerWorkerId: fields.ownerWorkerId } : {}),
      ...(fields.ownerBaseUrl ? { ownerBaseUrl: fields.ownerBaseUrl } : {}),
      ...(fields.preferredWorkerId ? { preferredWorkerId: fields.preferredWorkerId } : {}),
      ...(fields.preferredWorkerReason === "controller_target"
        ? { preferredWorkerReason: fields.preferredWorkerReason }
        : {}),
      state:
        fields.state === "active" ||
        fields.state === "idle" ||
        fields.state === "draining" ||
        fields.state === "evicted"
          ? fields.state
          : "unassigned",
      ...(fields.sourceKind === "object_store" || fields.sourceKind === "local_directory"
        ? { sourceKind: fields.sourceKind } : {}),
      ...(fields.localPath ? { localPath: fields.localPath } : {}),
      ...(fields.remotePrefix ? { remotePrefix: fields.remotePrefix } : {}),
      ...(fields.dirty ? { dirty: fields.dirty === "1" } : {}),
      ...(fields.refCount ? { refCount: Number(fields.refCount) } : {}),
      ...(fields.lastActivityAt ? { lastActivityAt: fields.lastActivityAt } : {}),
      ...(fields.materializedAt ? { materializedAt: fields.materializedAt } : {}),
      updatedAt: fields.updatedAt ?? new Date(0).toISOString()
    };
  }

  async close(): Promise<void> {
    if (this.#ownsCommands && this.#commands.isOpen) {
      await this.#commands.quit();
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.#commands.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  #registrySetKey(): string {
    return `${this.#keyPrefix}:workspace-placements:registry`;
  }

  #placementKey(workspaceId: string): string {
    return `${this.#keyPrefix}:workspace-placement:${workspaceId}`;
  }

  #readStoredOwnerId(fields: Record<string, string>): string | undefined {
    const ownerId = fields.ownerId?.trim();
    return ownerId || undefined;
  }

  #readEntryOwnerId(entry: WorkspacePlacementEntry | undefined): string | undefined {
    const ownerId = entry?.ownerId?.trim();
    return ownerId || undefined;
  }
}

export async function createRedisWorkspacePlacementRegistry(
  options: CreateRedisWorkspacePlacementRegistryOptions
): Promise<RedisWorkspacePlacementRegistry> {
  const registry = new RedisWorkspacePlacementRegistry(options);
  await registry.connect();
  return registry;
}
