import { createClient, type RedisClientType } from "redis";

import type { WorkerLeaseInput, WorkerRegistry, WorkerRegistryEntry } from "./contracts.js";
import type { CreateRedisWorkerRegistryOptions } from "./registry-types.js";

const DEFAULT_WORKER_LEASE_TTL_MS = 5_000;

function deriveRedisWorkerRegistryEntry(
  entry: WorkerLeaseInput & {
    leaseTtlMs?: number | undefined;
    expiresAt?: string | undefined;
  },
  nowMs: number
): WorkerRegistryEntry {
  const parsedLastSeenAtMs = Date.parse(entry.lastSeenAt);
  const lastSeenAtMs = Number.isFinite(parsedLastSeenAtMs) ? parsedLastSeenAtMs : 0;
  const leaseTtlMs =
    typeof entry.leaseTtlMs === "number" && Number.isFinite(entry.leaseTtlMs) && entry.leaseTtlMs > 0
      ? Math.floor(entry.leaseTtlMs)
      : DEFAULT_WORKER_LEASE_TTL_MS;
  const parsedExpiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  const expiresAtMs =
    Number.isFinite(parsedExpiresAtMs) && parsedExpiresAtMs >= lastSeenAtMs ? parsedExpiresAtMs : lastSeenAtMs + leaseTtlMs;
  const lastSeenAgeMs = Math.max(0, nowMs - lastSeenAtMs);
  const lateThresholdMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));

  return {
    workerId: entry.workerId,
    ...(entry.runtimeInstanceId ? { runtimeInstanceId: entry.runtimeInstanceId } : {}),
    ...(entry.ownerBaseUrl ? { ownerBaseUrl: entry.ownerBaseUrl } : {}),
    processKind: entry.processKind,
    state: entry.state,
    lastSeenAt: new Date(lastSeenAtMs).toISOString(),
    leaseTtlMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    lastSeenAgeMs,
    health: expiresAtMs - nowMs <= lateThresholdMs ? "late" : "healthy",
    ...(entry.currentSessionId ? { currentSessionId: entry.currentSessionId } : {}),
    ...(entry.currentRunId ? { currentRunId: entry.currentRunId } : {}),
    ...(entry.currentWorkspaceId ? { currentWorkspaceId: entry.currentWorkspaceId } : {})
  };
}

export class RedisWorkerRegistry implements WorkerRegistry {
  readonly #commands: RedisClientType;
  readonly #ownsCommands: boolean;
  readonly #keyPrefix: string;

  constructor(options: CreateRedisWorkerRegistryOptions) {
    this.#commands = options.commands ?? createClient({ url: options.url });
    this.#ownsCommands = !options.commands;
    this.#keyPrefix = options.keyPrefix ?? "oah";
  }

  async connect(): Promise<void> {
    if (!this.#commands.isOpen) {
      await this.#commands.connect();
    }
  }

  async heartbeat(entry: WorkerLeaseInput, ttlMs: number): Promise<void> {
    const leaseTtlMs = Math.max(1_000, Math.floor(ttlMs));
    const lastSeenAtMs = Number.isFinite(Date.parse(entry.lastSeenAt)) ? Date.parse(entry.lastSeenAt) : 0;
    const expiresAt = new Date(lastSeenAtMs + leaseTtlMs).toISOString();
    const transaction = this.#commands
      .multi()
      .sAdd(this.#registrySetKey(), entry.workerId)
      .hSet(this.#workerKey(entry.workerId), {
        workerId: entry.workerId,
        ...(entry.runtimeInstanceId ? { runtimeInstanceId: entry.runtimeInstanceId } : {}),
        ...(entry.ownerBaseUrl ? { ownerBaseUrl: entry.ownerBaseUrl } : {}),
        processKind: entry.processKind,
        state: entry.state,
        lastSeenAt: entry.lastSeenAt,
        leaseTtlMs: String(leaseTtlMs),
        expiresAt,
        ...(entry.currentSessionId ? { currentSessionId: entry.currentSessionId } : {}),
        ...(entry.currentRunId ? { currentRunId: entry.currentRunId } : {}),
        ...(entry.currentWorkspaceId ? { currentWorkspaceId: entry.currentWorkspaceId } : {})
      });
    if (!entry.currentSessionId) {
      transaction.hDel(this.#workerKey(entry.workerId), "currentSessionId");
    }
    if (!entry.currentRunId) {
      transaction.hDel(this.#workerKey(entry.workerId), "currentRunId");
    }
    if (!entry.currentWorkspaceId) {
      transaction.hDel(this.#workerKey(entry.workerId), "currentWorkspaceId");
    }
    if (!entry.runtimeInstanceId) {
      transaction.hDel(this.#workerKey(entry.workerId), "runtimeInstanceId");
    }
    if (!entry.ownerBaseUrl) {
      transaction.hDel(this.#workerKey(entry.workerId), "ownerBaseUrl");
    }
    await transaction.pExpire(this.#workerKey(entry.workerId), leaseTtlMs).exec();
  }

  async remove(workerId: string): Promise<void> {
    await this.#commands.multi().sRem(this.#registrySetKey(), workerId).del(this.#workerKey(workerId)).exec();
  }

  async listActive(nowMs = Date.now()): Promise<WorkerRegistryEntry[]> {
    const workerIds = await this.#commands.sMembers(this.#registrySetKey());
    if (workerIds.length === 0) {
      return [];
    }

    const records = await Promise.all(
      workerIds.map(async (workerId: string) => ({
        workerId,
        fields: await this.#commands.hGetAll(this.#workerKey(workerId))
      }))
    );

    const activeEntries: WorkerRegistryEntry[] = [];
    const missingWorkerIds: string[] = [];

    for (const record of records) {
      if (Object.keys(record.fields).length === 0) {
        missingWorkerIds.push(record.workerId);
        continue;
      }

      activeEntries.push(
        deriveRedisWorkerRegistryEntry(
          {
            workerId: record.fields.workerId ?? record.workerId,
            ...(record.fields.runtimeInstanceId ? { runtimeInstanceId: record.fields.runtimeInstanceId } : {}),
            ...(record.fields.ownerBaseUrl ? { ownerBaseUrl: record.fields.ownerBaseUrl } : {}),
            processKind: record.fields.processKind === "standalone" ? "standalone" : "embedded",
            state:
              record.fields.state === "starting" ||
              record.fields.state === "busy" ||
              record.fields.state === "stopping"
                ? record.fields.state
                : "idle",
            lastSeenAt: record.fields.lastSeenAt ?? new Date(0).toISOString(),
            leaseTtlMs: record.fields.leaseTtlMs ? Number(record.fields.leaseTtlMs) : undefined,
            expiresAt: record.fields.expiresAt,
            ...(record.fields.currentSessionId ? { currentSessionId: record.fields.currentSessionId } : {}),
            ...(record.fields.currentRunId ? { currentRunId: record.fields.currentRunId } : {}),
            ...(record.fields.currentWorkspaceId ? { currentWorkspaceId: record.fields.currentWorkspaceId } : {})
          },
          nowMs
        )
      );
    }

    if (missingWorkerIds.length > 0) {
      await this.#commands.sRem(this.#registrySetKey(), missingWorkerIds);
    }

    return activeEntries.sort((left, right) => left.workerId.localeCompare(right.workerId));
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
    return `${this.#keyPrefix}:workers:registry`;
  }

  #workerKey(workerId: string): string {
    return `${this.#keyPrefix}:worker:${workerId}`;
  }
}

export async function createRedisWorkerRegistry(
  options: CreateRedisWorkerRegistryOptions
): Promise<RedisWorkerRegistry> {
  const registry = new RedisWorkerRegistry(options);
  await registry.connect();
  return registry;
}
