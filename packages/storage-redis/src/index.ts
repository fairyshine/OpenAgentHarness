import { createClient, type RedisClientType } from "redis";

import {
  createId,
  type RunQueue,
  type SessionEvent,
  type SessionEventBus,
  type SessionEventStore,
  type SessionRunQueue,
  type SessionRunQueuePressure,
  type WorkerLeaseInput,
  type WorkerRegistry,
  type WorkerRegistryEntry,
  type WorkspaceLeaseEntry,
  type WorkspaceLeaseInput,
  type WorkspaceLeaseRegistry,
  type WorkspacePlacementEntry,
  type WorkspacePlacementInput,
  type WorkspacePlacementRegistry,
  type WorkspacePlacementState
} from "@oah/runtime-core";
import { calculateRedisWorkerPoolSuggestion, summarizeRedisWorkerLoad } from "./worker-pool-policy.js";
import { summarizeRedisRunWorkerPoolPressure } from "./worker-pool-pressure.js";
import {
  appendRedisRunWorkerPoolDecision,
  buildRedisRunWorkerPoolDecision,
  buildRedisRunWorkerPoolSnapshot,
  formatRedisRunWorkerPoolRebalanceLog,
  shouldLogRedisRunWorkerPoolRebalance
} from "./worker-pool-observability.js";

export {
  buildRedisWorkerAffinitySummary,
  type RedisWorkerAffinityActiveWorkerLike,
  type RedisWorkerAffinityCandidate,
  type RedisWorkerAffinityReason,
  type RedisWorkerAffinitySlotLike,
  type RedisWorkerAffinitySummary
} from "./worker-pool-affinity.js";
export {
  calculateRedisWorkerPoolSuggestion,
  summarizeRedisWorkerLoad,
  type RedisRunWorkerPoolSizingInput,
  type RedisRunWorkerPoolSizingResult,
  type RedisWorkerLoadSummary
} from "./worker-pool-policy.js";
export { summarizeRedisRunWorkerPoolPressure, type RedisRunWorkerPoolPressureSummary } from "./worker-pool-pressure.js";
export {
  appendRedisRunWorkerPoolDecision,
  buildRedisRunWorkerPoolDecision,
  buildRedisRunWorkerPoolSnapshot,
  formatRedisRunWorkerPoolRebalanceLog,
  shouldLogRedisRunWorkerPoolRebalance
} from "./worker-pool-observability.js";
export type {
  RedisRunWorkerPoolDecisionLike,
  RedisRunWorkerPoolLoggedState,
  RedisRunWorkerPoolRebalanceReason,
  RedisRunWorkerPoolSlotSnapshotLike,
  RedisRunWorkerPoolSnapshotLike
} from "./worker-pool-observability.js";

type RunQueuePriority = "normal" | "subagent";

export type {
  SessionEventBus,
  SessionRunQueue,
  SessionRunQueuePressure,
  WorkerLeaseInput,
  WorkerRegistry,
  WorkerRegistryEntry,
  WorkspaceLeaseEntry,
  WorkspaceLeaseInput,
  WorkspaceLeaseRegistry,
  WorkspacePlacementEntry,
  WorkspacePlacementInput,
  WorkspacePlacementRegistry,
  WorkspacePlacementState
} from "@oah/runtime-core";

// Back-compat aliases for external consumers that import Redis*-prefixed names.
export type RedisWorkerLeaseInput = WorkerLeaseInput;
export type RedisWorkerRegistryEntry = WorkerRegistryEntry;
export type RedisWorkspaceLeaseInput = WorkspaceLeaseInput;
export type RedisWorkspaceLeaseEntry = WorkspaceLeaseEntry;
export type RedisWorkspacePlacementState = WorkspacePlacementState;
export type RedisWorkspacePlacementInput = WorkspacePlacementInput;
export type RedisWorkspacePlacementEntry = WorkspacePlacementEntry;

export interface CreateRedisSessionEventBusOptions {
  url: string;
  keyPrefix?: string | undefined;
  eventBufferSize?: number | undefined;
  publisher?: RedisClientType | undefined;
  subscriber?: RedisClientType | undefined;
}

export interface CreateRedisSessionRunQueueOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
  blocking?: RedisClientType | undefined;
}

export interface CreateRedisWorkerRegistryOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
}

export interface CreateRedisWorkspaceLeaseRegistryOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
}

export interface CreateRedisWorkspacePlacementRegistryOptions {
  url: string;
  keyPrefix?: string | undefined;
  commands?: RedisClientType | undefined;
}

export interface RedisRunWorkerLogger {
  info?(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface RedisRunWorkerOptions {
  queue: SessionRunQueue;
  runtimeService: {
    processQueuedRun(runId: string): Promise<void>;
    describeQueuedRun?(runId: string): Promise<{ workspaceId?: string | undefined } | undefined>;
    recoverStaleRuns?(options?: {
      staleBefore?: string | undefined;
      limit?: number | undefined;
    }): Promise<{ recoveredRunIds: string[]; requeuedRunIds?: string[] }>;
  };
  workerId?: string | undefined;
  runtimeInstanceId?: string | undefined;
  ownerBaseUrl?: string | undefined;
  processKind?: "embedded" | "standalone" | undefined;
  lockTtlMs?: number | undefined;
  pollTimeoutMs?: number | undefined;
  recoveryGraceMs?: number | undefined;
  registry?: WorkerRegistry | undefined;
  recoverOnStart?: boolean | undefined;
  logger?: RedisRunWorkerLogger | undefined;
  onStateChange?:
    | ((entry: {
        workerId: string;
        state: "starting" | "idle" | "busy" | "stopping";
        currentSessionId?: string | undefined;
        currentRunId?: string | undefined;
        currentWorkspaceId?: string | undefined;
      }) => void)
    | undefined;
}

export interface RedisRunWorkerPoolOptions extends Omit<RedisRunWorkerOptions, "workerId" | "queue"> {
  queue: SessionRunQueue;
  queueFactory?: (() => Promise<SessionRunQueue>) | undefined;
  minWorkers?: number | undefined;
  maxWorkers?: number | undefined;
  scaleIntervalMs?: number | undefined;
  readySessionsPerCapacityUnit?: number | undefined;
  reservedSubagentCapacity?: number | undefined;
  scaleUpCooldownMs?: number | undefined;
  scaleDownCooldownMs?: number | undefined;
  scaleUpSampleSize?: number | undefined;
  scaleDownSampleSize?: number | undefined;
  scaleUpBusyRatioThreshold?: number | undefined;
  scaleUpMaxReadyAgeMs?: number | undefined;
}

export interface RedisRunWorkerPoolDecision {
  timestamp: string;
  reason: "startup" | "steady" | "scale_up" | "scale_down" | "cooldown_hold" | "shutdown";
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity?: number | undefined;
  reservedWorkers?: number | undefined;
  availableIdleCapacity?: number | undefined;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget?: number | undefined;
  subagentReserveDeficit?: number | undefined;
  desiredWorkers: number;
  activeWorkers: number;
  busyWorkers?: number | undefined;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface RedisRunWorkerPoolSlotSnapshot {
  slotId: string;
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  currentSessionId?: string | undefined;
  currentRunId?: string | undefined;
  currentWorkspaceId?: string | undefined;
}

export interface RedisRunWorkerPoolSnapshot {
  running: boolean;
  processKind: "embedded" | "standalone";
  sessionSerialBoundary: "session";
  minWorkers: number;
  maxWorkers: number;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity: number;
  reservedWorkers?: number | undefined;
  availableIdleCapacity: number;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget: number;
  subagentReserveDeficit: number;
  desiredWorkers: number;
  slotCapacity: number;
  slots: RedisRunWorkerPoolSlotSnapshot[];
  activeWorkers: number;
  busySlots: number;
  idleSlots: number;
  busyWorkers: number;
  idleWorkers: number;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionsPerCapacityUnit: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
  lastRebalanceAt?: string | undefined;
  lastRebalanceReason?:
    | "startup"
    | "steady"
    | "scale_up"
    | "scale_down"
    | "cooldown_hold"
    | "shutdown"
    | undefined;
  scaleUpPressureStreak: number;
  scaleDownPressureStreak: number;
  scaleUpCooldownRemainingMs: number;
  scaleDownCooldownRemainingMs: number;
  recentDecisions: RedisRunWorkerPoolDecision[];
}

const compareAndDeleteScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const enqueueSessionRunScript = `
local queueLength = redis.call("rpush", KEYS[1], ARGV[1])
if ARGV[5] ~= "" then
  redis.call("set", KEYS[5], ARGV[5])
else
  redis.call("del", KEYS[5])
end
if queueLength == 1 then
  redis.call("set", KEYS[3], ARGV[3], "NX")
  redis.call("set", KEYS[4], ARGV[4])
  local alreadyReady = false
  local readyEntries = redis.call("lrange", KEYS[2], 0, -1)
  for _, readySessionId in ipairs(readyEntries) do
    if readySessionId == ARGV[2] then
      alreadyReady = true
      break
    end
  end
  if not alreadyReady then
    if ARGV[4] == "subagent" then
      redis.call("lpush", KEYS[2], ARGV[2])
    else
      redis.call("rpush", KEYS[2], ARGV[2])
    end
  end
end
return queueLength
`;

const claimCompatibleSessionScript = `
local workerId = ARGV[3]
local runtimeInstanceId = ARGV[4]
local readyEntries = redis.call("lrange", KEYS[1], 0, -1)

for _, sessionId in ipairs(readyEntries) do
  local preferredWorkerId = redis.call("get", ARGV[1] .. sessionId .. ARGV[2])
  if workerId == "" or preferredWorkerId == false or preferredWorkerId == "" or preferredWorkerId == workerId or (runtimeInstanceId ~= "" and preferredWorkerId == runtimeInstanceId) then
    redis.call("lrem", KEYS[1], 1, sessionId)
    return sessionId
  end
end

return false
`;

const DEFAULT_WORKER_LEASE_TTL_MS = 5_000;
const DEFAULT_WORKSPACE_LEASE_TTL_MS = 15_000;

function deriveRedisWorkerRegistryEntry(
  entry: RedisWorkerLeaseInput & {
    leaseTtlMs?: number | undefined;
    expiresAt?: string | undefined;
  },
  nowMs: number
): RedisWorkerRegistryEntry {
  const parsedLastSeenAtMs = Date.parse(entry.lastSeenAt);
  const lastSeenAtMs = Number.isFinite(parsedLastSeenAtMs) ? parsedLastSeenAtMs : 0;
  const leaseTtlMs =
    typeof entry.leaseTtlMs === "number" && Number.isFinite(entry.leaseTtlMs) && entry.leaseTtlMs > 0
      ? Math.floor(entry.leaseTtlMs)
      : DEFAULT_WORKER_LEASE_TTL_MS;
  const parsedExpiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  const expiresAtMs =
    Number.isFinite(parsedExpiresAtMs) && parsedExpiresAtMs >= lastSeenAtMs
      ? parsedExpiresAtMs
      : lastSeenAtMs + leaseTtlMs;
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

function calculateWorkerLeaseTtlMs(lockTtlMs: number, pollTimeoutMs: number): number {
  return Math.max(DEFAULT_WORKER_LEASE_TTL_MS, lockTtlMs * 2, pollTimeoutMs * 4);
}

function deriveRedisWorkspaceLeaseEntry(
  entry: RedisWorkspaceLeaseInput & {
    leaseTtlMs?: number | undefined;
    expiresAt?: string | undefined;
  },
  nowMs: number
): RedisWorkspaceLeaseEntry {
  const parsedLastSeenAtMs = Date.parse(entry.lastSeenAt);
  const lastSeenAtMs = Number.isFinite(parsedLastSeenAtMs) ? parsedLastSeenAtMs : 0;
  const leaseTtlMs =
    typeof entry.leaseTtlMs === "number" && Number.isFinite(entry.leaseTtlMs) && entry.leaseTtlMs > 0
      ? Math.floor(entry.leaseTtlMs)
      : DEFAULT_WORKSPACE_LEASE_TTL_MS;
  const parsedExpiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  const expiresAtMs =
    Number.isFinite(parsedExpiresAtMs) && parsedExpiresAtMs >= lastSeenAtMs
      ? parsedExpiresAtMs
      : lastSeenAtMs + leaseTtlMs;
  const lastSeenAgeMs = Math.max(0, nowMs - lastSeenAtMs);
  const lateThresholdMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));

  return {
    workspaceId: entry.workspaceId,
    version: entry.version,
    ownerWorkerId: entry.ownerWorkerId,
    ...(entry.ownerBaseUrl ? { ownerBaseUrl: entry.ownerBaseUrl } : {}),
    sourceKind: entry.sourceKind,
    localPath: entry.localPath,
    dirty: entry.dirty,
    refCount: entry.refCount,
    lastActivityAt: entry.lastActivityAt,
    lastSeenAt: new Date(lastSeenAtMs).toISOString(),
    leaseTtlMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    lastSeenAgeMs,
    health: expiresAtMs - nowMs <= lateThresholdMs ? "late" : "healthy",
    ...(entry.remotePrefix ? { remotePrefix: entry.remotePrefix } : {}),
    ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {})
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

  async heartbeat(entry: RedisWorkerLeaseInput, ttlMs: number): Promise<void> {
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

  async listActive(nowMs = Date.now()): Promise<RedisWorkerRegistryEntry[]> {
    const workerIds = await this.#commands.sMembers(this.#registrySetKey());
    if (workerIds.length === 0) {
      return [];
    }

    const records = await Promise.all(
      workerIds.map(async (workerId) => ({
        workerId,
        fields: await this.#commands.hGetAll(this.#workerKey(workerId))
      }))
    );

    const activeEntries: RedisWorkerRegistryEntry[] = [];
    const missingWorkerIds: string[] = [];

    for (const record of records) {
      if (Object.keys(record.fields).length === 0) {
        missingWorkerIds.push(record.workerId);
        continue;
      }

      const entry: RedisWorkerRegistryEntry = {
        ...deriveRedisWorkerRegistryEntry(
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
      };
      activeEntries.push(entry);
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

export class RedisWorkspaceLeaseRegistry implements WorkspaceLeaseRegistry {
  readonly #commands: RedisClientType;
  readonly #ownsCommands: boolean;
  readonly #keyPrefix: string;

  constructor(options: CreateRedisWorkspaceLeaseRegistryOptions) {
    this.#commands = options.commands ?? createClient({ url: options.url });
    this.#ownsCommands = !options.commands;
    this.#keyPrefix = options.keyPrefix ?? "oah";
  }

  async connect(): Promise<void> {
    if (!this.#commands.isOpen) {
      await this.#commands.connect();
    }
  }

  async heartbeat(entry: RedisWorkspaceLeaseInput, ttlMs: number): Promise<void> {
    const leaseTtlMs = Math.max(1_000, Math.floor(ttlMs));
    const lastSeenAtMs = Number.isFinite(Date.parse(entry.lastSeenAt)) ? Date.parse(entry.lastSeenAt) : 0;
    const expiresAt = new Date(lastSeenAtMs + leaseTtlMs).toISOString();
    const leaseId = this.#leaseId(entry.workspaceId, entry.version, entry.ownerWorkerId);
    const transaction = this.#commands
      .multi()
      .sAdd(this.#registrySetKey(), leaseId)
      .sAdd(this.#workspaceLeaseSetKey(entry.workspaceId), leaseId)
      .hSet(this.#leaseKey(leaseId), {
        workspaceId: entry.workspaceId,
        version: entry.version,
        ownerWorkerId: entry.ownerWorkerId,
        ...(entry.ownerBaseUrl ? { ownerBaseUrl: entry.ownerBaseUrl } : {}),
        sourceKind: entry.sourceKind,
        localPath: entry.localPath,
        dirty: entry.dirty ? "1" : "0",
        refCount: String(Math.max(0, Math.floor(entry.refCount))),
        lastActivityAt: entry.lastActivityAt,
        lastSeenAt: entry.lastSeenAt,
        leaseTtlMs: String(leaseTtlMs),
        expiresAt,
        ...(entry.remotePrefix ? { remotePrefix: entry.remotePrefix } : {}),
        ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {})
      });

    if (!entry.remotePrefix) {
      transaction.hDel(this.#leaseKey(leaseId), "remotePrefix");
    }
    if (!entry.ownerBaseUrl) {
      transaction.hDel(this.#leaseKey(leaseId), "ownerBaseUrl");
    }
    if (!entry.materializedAt) {
      transaction.hDel(this.#leaseKey(leaseId), "materializedAt");
    }

    await transaction.pExpire(this.#leaseKey(leaseId), leaseTtlMs).exec();
  }

  async remove(workspaceId: string, version: string, ownerWorkerId: string): Promise<void> {
    const leaseId = this.#leaseId(workspaceId, version, ownerWorkerId);
    await this.#commands
      .multi()
      .sRem(this.#registrySetKey(), leaseId)
      .sRem(this.#workspaceLeaseSetKey(workspaceId), leaseId)
      .del(this.#leaseKey(leaseId))
      .exec();
  }

  async listActive(nowMs = Date.now()): Promise<RedisWorkspaceLeaseEntry[]> {
    const leaseIds = await this.#commands.sMembers(this.#registrySetKey());
    if (leaseIds.length === 0) {
      return [];
    }

    const records = await Promise.all(
      leaseIds.map(async (leaseId) => ({
        leaseId,
        fields: await this.#commands.hGetAll(this.#leaseKey(leaseId))
      }))
    );

    const activeEntries: RedisWorkspaceLeaseEntry[] = [];
    const missingLeaseIds: string[] = [];
    const emptyWorkspaceSets = new Set<string>();

    for (const record of records) {
      if (Object.keys(record.fields).length === 0) {
        missingLeaseIds.push(record.leaseId);
        const workspaceId = this.#workspaceIdFromLeaseId(record.leaseId);
        if (workspaceId) {
          emptyWorkspaceSets.add(workspaceId);
        }
        continue;
      }

      activeEntries.push(
        deriveRedisWorkspaceLeaseEntry(
          {
            workspaceId: record.fields.workspaceId ?? this.#workspaceIdFromLeaseId(record.leaseId) ?? "unknown",
            version: record.fields.version ?? "live",
            ownerWorkerId: record.fields.ownerWorkerId ?? "unknown",
            ...(record.fields.ownerBaseUrl ? { ownerBaseUrl: record.fields.ownerBaseUrl } : {}),
            sourceKind: record.fields.sourceKind === "local_directory" ? "local_directory" : "object_store",
            localPath: record.fields.localPath ?? "",
            dirty: record.fields.dirty === "1",
            refCount: record.fields.refCount ? Number(record.fields.refCount) : 0,
            lastActivityAt: record.fields.lastActivityAt ?? new Date(0).toISOString(),
            lastSeenAt: record.fields.lastSeenAt ?? new Date(0).toISOString(),
            leaseTtlMs: record.fields.leaseTtlMs ? Number(record.fields.leaseTtlMs) : undefined,
            expiresAt: record.fields.expiresAt,
            ...(record.fields.remotePrefix ? { remotePrefix: record.fields.remotePrefix } : {}),
            ...(record.fields.materializedAt ? { materializedAt: record.fields.materializedAt } : {})
          },
          nowMs
        )
      );
    }

    if (missingLeaseIds.length > 0) {
      const cleanup = this.#commands.multi().sRem(this.#registrySetKey(), missingLeaseIds);
      for (const leaseId of missingLeaseIds) {
        const workspaceId = this.#workspaceIdFromLeaseId(leaseId);
        if (workspaceId) {
          cleanup.sRem(this.#workspaceLeaseSetKey(workspaceId), leaseId);
        }
      }
      await cleanup.exec();
    }

    for (const workspaceId of emptyWorkspaceSets) {
      const members = await this.#commands.sMembers(this.#workspaceLeaseSetKey(workspaceId));
      if (members.length === 0) {
        await this.#commands.del(this.#workspaceLeaseSetKey(workspaceId));
      }
    }

    return activeEntries.sort(
      (left, right) =>
        left.workspaceId.localeCompare(right.workspaceId) ||
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        left.ownerWorkerId.localeCompare(right.ownerWorkerId)
    );
  }

  async getByWorkspaceId(workspaceId: string, nowMs = Date.now()): Promise<RedisWorkspaceLeaseEntry | undefined> {
    const activeEntries = await this.listActive(nowMs);
    return activeEntries.find((entry) => entry.workspaceId === workspaceId);
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
    return `${this.#keyPrefix}:workspace-leases:registry`;
  }

  #workspaceLeaseSetKey(workspaceId: string): string {
    return `${this.#keyPrefix}:workspace-leases:workspace:${workspaceId}`;
  }

  #leaseKey(leaseId: string): string {
    return `${this.#keyPrefix}:workspace-lease:${leaseId}`;
  }

  #leaseId(workspaceId: string, version: string, ownerWorkerId: string): string {
    return `${workspaceId}:${version}:${ownerWorkerId}`;
  }

  #workspaceIdFromLeaseId(leaseId: string): string | undefined {
    return leaseId.split(":")[0];
  }
}

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

  async upsert(entry: RedisWorkspacePlacementInput): Promise<void> {
    const key = this.#placementKey(entry.workspaceId);
    const existing = await this.#commands.hGetAll(key);
    const next = {
      workspaceId: entry.workspaceId,
      version: entry.version?.trim() || existing.version || "live",
      ...(existing.userId ? { userId: existing.userId } : {}),
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
    } satisfies RedisWorkspacePlacementEntry;

    if (entry.userId?.trim()) {
      next.userId = entry.userId.trim();
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
      ...(next.userId ? { userId: next.userId } : {}),
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

    if (!next.userId) {
      transaction.hDel(key, "userId");
    }
    if (!next.ownerWorkerId) {
      transaction.hDel(key, "ownerWorkerId");
    }
    if (!next.ownerBaseUrl) {
      transaction.hDel(key, "ownerBaseUrl");
    }
    if (!next.preferredWorkerId) {
      transaction.hDel(key, "preferredWorkerId");
    }
    if (!next.preferredWorkerReason) {
      transaction.hDel(key, "preferredWorkerReason");
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

  async assignUser(
    workspaceId: string,
    userId: string,
    options?: { overwrite?: boolean | undefined; updatedAt?: string | undefined }
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedUserId = userId.trim();
    if (normalizedWorkspaceId.length === 0 || normalizedUserId.length === 0) {
      return;
    }

    const existing = await this.getByWorkspaceId(normalizedWorkspaceId);
    if (existing?.userId && !options?.overwrite) {
      return;
    }

    await this.upsert({
      workspaceId: normalizedWorkspaceId,
      userId: normalizedUserId,
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
      state?: RedisWorkspacePlacementState | undefined;
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
      ...(existing.userId ? { userId: existing.userId } : {}),
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

  async listAll(): Promise<RedisWorkspacePlacementEntry[]> {
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

    const items: RedisWorkspacePlacementEntry[] = [];
    const missingWorkspaceIds: string[] = [];

    for (const record of records) {
      if (Object.keys(record.fields).length === 0) {
        missingWorkspaceIds.push(record.workspaceId);
        continue;
      }

      items.push({
        workspaceId: record.fields.workspaceId ?? record.workspaceId,
        version: record.fields.version ?? "live",
        ...(record.fields.userId ? { userId: record.fields.userId } : {}),
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
          ? { sourceKind: record.fields.sourceKind }
          : {}),
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

  async getByWorkspaceId(workspaceId: string): Promise<RedisWorkspacePlacementEntry | undefined> {
    const fields = await this.#commands.hGetAll(this.#placementKey(workspaceId));
    if (Object.keys(fields).length === 0) {
      return undefined;
    }

    return {
      workspaceId: fields.workspaceId ?? workspaceId,
      version: fields.version ?? "live",
      ...(fields.userId ? { userId: fields.userId } : {}),
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
        ? { sourceKind: fields.sourceKind }
        : {}),
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
}

const compareAndExpireScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const requeuePendingSessionScript = `
if redis.call("llen", KEYS[1]) > 0 then
  local readyEntries = redis.call("lrange", KEYS[2], 0, -1)
  for _, readySessionId in ipairs(readyEntries) do
    if readySessionId == ARGV[1] then
      return 0
    end
  end
  redis.call("rpush", KEYS[2], ARGV[1])
  return 1
end
return 0
`;

const inspectSchedulingPressureScript = `
local readyEntries = redis.call("lrange", KEYS[1], 0, -1)
local readyQueueDepth = #readyEntries
local uniqueReady = 0
local schedulable = 0
local subagentReadyQueueDepth = 0
local subagentSchedulable = 0
local lockedReady = 0
local staleReady = 0
local oldestSchedulableReadyAgeMs = 0
local seen = {}

for _, sessionId in ipairs(readyEntries) do
  local readyPriorityKey = ARGV[1] .. sessionId .. ARGV[5]
  local isSubagent = redis.call("get", readyPriorityKey) == "subagent"
  if isSubagent then
    subagentReadyQueueDepth = subagentReadyQueueDepth + 1
  end

  if not seen[sessionId] then
    seen[sessionId] = true
    uniqueReady = uniqueReady + 1

    local sessionQueueKey = ARGV[1] .. sessionId .. ARGV[2]
    local pendingRunCount = redis.call("llen", sessionQueueKey)

    if pendingRunCount <= 0 then
      staleReady = staleReady + 1
    else
      local sessionLockKey = ARGV[1] .. sessionId .. ARGV[3]
      if redis.call("exists", sessionLockKey) == 1 then
        lockedReady = lockedReady + 1
      else
        schedulable = schedulable + 1
        if isSubagent then
          subagentSchedulable = subagentSchedulable + 1
        end
        local readyAtKey = ARGV[1] .. sessionId .. ARGV[4]
        local readyAtMs = tonumber(redis.call("get", readyAtKey))
        if readyAtMs ~= nil then
          local waitAgeMs = tonumber(ARGV[6]) - readyAtMs
          if waitAgeMs > oldestSchedulableReadyAgeMs then
            oldestSchedulableReadyAgeMs = waitAgeMs
          end
        end
      end
    end
  end
end

return { schedulable, readyQueueDepth, uniqueReady, subagentSchedulable, subagentReadyQueueDepth, lockedReady, staleReady, oldestSchedulableReadyAgeMs }
`;

const dequeueSessionRunScript = `
local runId = redis.call("lpop", KEYS[1])
if not runId then
  return false
end
if redis.call("llen", KEYS[1]) == 0 then
  redis.call("del", KEYS[2], KEYS[3], KEYS[4])
end
return runId
`;

export class RedisSessionEventBus implements SessionEventBus {
  readonly #publisher: RedisClientType;
  readonly #subscriber: RedisClientType;
  readonly #ownsPublisher: boolean;
  readonly #ownsSubscriber: boolean;
  readonly #keyPrefix: string;
  readonly #eventBufferSize: number;

  constructor(options: CreateRedisSessionEventBusOptions) {
    this.#publisher = options.publisher ?? createClient({ url: options.url });
    this.#subscriber = options.subscriber ?? this.#publisher.duplicate();
    this.#ownsPublisher = !options.publisher;
    this.#ownsSubscriber = !options.subscriber;
    this.#keyPrefix = options.keyPrefix ?? "oah";
    this.#eventBufferSize = Math.max(1, options.eventBufferSize ?? 200);
  }

  async connect(): Promise<void> {
    if (!this.#publisher.isOpen) {
      await this.#publisher.connect();
    }

    if (!this.#subscriber.isOpen) {
      await this.#subscriber.connect();
    }
  }

  async publish(event: SessionEvent): Promise<void> {
    const payload = JSON.stringify(event);
    const eventsKey = this.#eventsKey(event.sessionId);
    const channel = this.#channel(event.sessionId);

    await this.#publisher
      .multi()
      .rPush(eventsKey, payload)
      .lTrim(eventsKey, -this.#eventBufferSize, -1)
      .publish(channel, payload)
      .exec();
  }

  async subscribe(sessionId: string, listener: (event: SessionEvent) => void): Promise<() => Promise<void>> {
    const channel = this.#channel(sessionId);
    const handler = (message: string) => {
      listener(JSON.parse(message) as SessionEvent);
    };

    await this.#subscriber.subscribe(channel, handler);

    return async () => {
      if (this.#subscriber.isOpen) {
        await this.#subscriber.unsubscribe(channel, handler);
      }
    };
  }

  async close(): Promise<void> {
    if (this.#ownsSubscriber && this.#subscriber.isOpen) {
      await this.#subscriber.quit();
    }

    if (this.#ownsPublisher && this.#publisher.isOpen) {
      await this.#publisher.quit();
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.#publisher.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  #eventsKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:events`;
  }

  #channel(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:events:pubsub`;
  }
}

export class RedisSessionRunQueue implements SessionRunQueue {
  readonly #commands: RedisClientType;
  readonly #blocking: RedisClientType;
  readonly #ownsCommands: boolean;
  readonly #ownsBlocking: boolean;
  readonly #keyPrefix: string;

  constructor(options: CreateRedisSessionRunQueueOptions) {
    this.#commands = options.commands ?? createClient({ url: options.url });
    this.#blocking = options.blocking ?? this.#commands.duplicate();
    this.#ownsCommands = !options.commands;
    this.#ownsBlocking = !options.blocking;
    this.#keyPrefix = options.keyPrefix ?? "oah";
  }

  async connect(): Promise<void> {
    if (!this.#commands.isOpen) {
      await this.#commands.connect();
    }

    if (!this.#blocking.isOpen) {
      await this.#blocking.connect();
    }
  }

  async enqueue(
    sessionId: string,
    runId: string,
    options?: { priority?: RunQueuePriority | undefined; preferredWorkerId?: string | undefined }
  ): Promise<void> {
    const priority = options?.priority ?? "normal";
    const preferredWorkerId = options?.preferredWorkerId?.trim() ?? "";
    const queueLength = Number(
      await this.#commands.eval(enqueueSessionRunScript, {
        keys: [
          this.#sessionQueueKey(sessionId),
          this.#readyQueueKey(),
          this.#readyAtKey(sessionId),
          this.#readyPriorityKey(sessionId),
          this.#preferredWorkerKey(sessionId)
        ],
        arguments: [runId, sessionId, String(Date.now()), priority, preferredWorkerId]
      })
    );
    if (queueLength === 1) {
      return;
    }
  }

  async claimNextSession(
    timeoutMs = 1_000,
    options?: { workerId?: string | undefined; runtimeInstanceId?: string | undefined }
  ): Promise<string | undefined> {
    const workerId = options?.workerId?.trim() ?? "";
    const runtimeInstanceId = options?.runtimeInstanceId?.trim() ?? "";
    const deadline = Date.now() + Math.max(1, timeoutMs);

    while (Date.now() < deadline) {
      const claimed = await this.#commands.eval(claimCompatibleSessionScript, {
        keys: [this.#readyQueueKey()],
        arguments: [`${this.#keyPrefix}:session:`, ":preferred-worker", workerId, runtimeInstanceId]
      });
      if (typeof claimed === "string" && claimed.length > 0) {
        return claimed;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
    }

    return undefined;
  }

  async readyQueueLength(): Promise<number> {
    return this.#commands.lLen(this.#readyQueueKey());
  }

  async inspectReadyQueue(nowMs = Date.now()): Promise<{
    length: number;
    subagentLength: number;
    oldestReadyAgeMs: number;
    averageReadyAgeMs: number;
  }> {
    const sessionIds = await this.#commands.lRange(this.#readyQueueKey(), 0, -1);
    if (sessionIds.length === 0) {
      return {
        length: 0,
        subagentLength: 0,
        oldestReadyAgeMs: 0,
        averageReadyAgeMs: 0
      };
    }

    const [readySinceValues, readyPriorityValues] = await Promise.all([
      this.#commands.mGet(sessionIds.map((sessionId) => this.#readyAtKey(sessionId))),
      this.#commands.mGet(sessionIds.map((sessionId) => this.#readyPriorityKey(sessionId)))
    ]);
    const ages = readySinceValues
      .map((value) => {
        if (!value) {
          return undefined;
        }

        const readySinceMs = Number.parseInt(value, 10);
        return Number.isFinite(readySinceMs) ? Math.max(0, nowMs - readySinceMs) : undefined;
      })
      .filter((value): value is number => value !== undefined);

    if (ages.length === 0) {
      return {
        length: sessionIds.length,
        subagentLength: readyPriorityValues.filter((value) => value === "subagent").length,
        oldestReadyAgeMs: 0,
        averageReadyAgeMs: 0
      };
    }

    const totalAgeMs = ages.reduce((sum, ageMs) => sum + ageMs, 0);
    return {
      length: sessionIds.length,
      subagentLength: readyPriorityValues.filter((value) => value === "subagent").length,
      oldestReadyAgeMs: Math.max(...ages),
      averageReadyAgeMs: Math.round(totalAgeMs / ages.length)
    };
  }

  async tryAcquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.#commands.set(this.#lockKey(sessionId), token, {
      NX: true,
      PX: ttlMs
    });

    return result === "OK";
  }

  async renewSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.#commands.eval(compareAndExpireScript, {
      keys: [this.#lockKey(sessionId)],
      arguments: [token, String(ttlMs)]
    });

    return Number(result) === 1;
  }

  async releaseSessionLock(sessionId: string, token: string): Promise<boolean> {
    const result = await this.#commands.eval(compareAndDeleteScript, {
      keys: [this.#lockKey(sessionId)],
      arguments: [token]
    });

    return Number(result) === 1;
  }

  async dequeueRun(sessionId: string): Promise<string | undefined> {
    const runId = await this.#commands.eval(dequeueSessionRunScript, {
      keys: [
        this.#sessionQueueKey(sessionId),
        this.#readyAtKey(sessionId),
        this.#readyPriorityKey(sessionId),
        this.#preferredWorkerKey(sessionId)
      ]
    });

    return typeof runId === "string" ? runId : undefined;
  }

  async requeueSessionIfPending(sessionId: string): Promise<boolean> {
    const result = await this.#commands.eval(requeuePendingSessionScript, {
      keys: [this.#sessionQueueKey(sessionId), this.#readyQueueKey()],
      arguments: [sessionId]
    });

    return Number(result) === 1;
  }

  async getSchedulingPressure(): Promise<SessionRunQueuePressure> {
    const [
      readySessionCount,
      readyQueueDepth,
      uniqueReadySessionCount,
      subagentReadySessionCount,
      subagentReadyQueueDepth,
      lockedReadySessionCount,
      staleReadySessionCount,
      oldestSchedulableReadyAgeMs
    ] = (
      await this.#commands.eval(inspectSchedulingPressureScript, {
        keys: [this.#readyQueueKey()],
        arguments: [`${this.#keyPrefix}:session:`, ":queue", ":lock", ":ready_at", ":ready-priority", String(Date.now())]
      })
    ) as number[];

    return {
      readySessionCount: Number(readySessionCount),
      readyQueueDepth: Number(readyQueueDepth),
      uniqueReadySessionCount: Number(uniqueReadySessionCount),
      subagentReadySessionCount: Number(subagentReadySessionCount),
      subagentReadyQueueDepth: Number(subagentReadyQueueDepth),
      lockedReadySessionCount: Number(lockedReadySessionCount),
      staleReadySessionCount: Number(staleReadySessionCount),
      oldestSchedulableReadyAgeMs: Number(oldestSchedulableReadyAgeMs)
    };
  }

  async getReadySessionCount(): Promise<number> {
    return await this.#commands.lLen(this.#readyQueueKey());
  }

  async close(): Promise<void> {
    if (this.#ownsBlocking && this.#blocking.isOpen) {
      await this.#blocking.quit();
    }

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

  #readyQueueKey(): string {
    return `${this.#keyPrefix}:runs:ready`;
  }

  #sessionQueueKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:queue`;
  }

  #lockKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:lock`;
  }

  #readyPriorityKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:ready-priority`;
  }

  #readyAtKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:ready_at`;
  }

  #preferredWorkerKey(sessionId: string): string {
    return `${this.#keyPrefix}:session:${sessionId}:preferred-worker`;
  }
}

export class RedisRunWorker {
  readonly #queue: SessionRunQueue;
  readonly #runtimeService: RedisRunWorkerOptions["runtimeService"];
  readonly #workerId: string;
  readonly #runtimeInstanceId?: string | undefined;
  readonly #ownerBaseUrl?: string | undefined;
  readonly #processKind: "embedded" | "standalone";
  readonly #lockTtlMs: number;
  readonly #pollTimeoutMs: number;
  readonly #recoveryGraceMs: number;
  readonly #leaseTtlMs: number;
  readonly #registry?: WorkerRegistry | undefined;
  readonly #recoverOnStart: boolean;
  readonly #logger?: RedisRunWorkerLogger | undefined;
  readonly #onStateChange:
    | ((entry: {
        workerId: string;
        state: "starting" | "idle" | "busy" | "stopping";
        currentSessionId?: string | undefined;
        currentRunId?: string | undefined;
        currentWorkspaceId?: string | undefined;
      }) => void)
    | undefined;
  #loop: Promise<void> | undefined;
  #active = false;
  #state: "starting" | "idle" | "busy" | "stopping" = "starting";
  #currentSessionId: string | undefined;
  #currentRunId: string | undefined;
  #currentWorkspaceId: string | undefined;

  constructor(options: RedisRunWorkerOptions) {
    this.#queue = options.queue;
    this.#runtimeService = options.runtimeService;
    this.#workerId = options.workerId ?? createId("worker");
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#ownerBaseUrl = options.ownerBaseUrl;
    this.#processKind = options.processKind ?? "embedded";
    this.#lockTtlMs = Math.max(1_000, options.lockTtlMs ?? 30_000);
    this.#pollTimeoutMs = Math.max(250, options.pollTimeoutMs ?? 1_000);
    this.#recoveryGraceMs = Math.max(this.#lockTtlMs, options.recoveryGraceMs ?? this.#lockTtlMs * 2);
    this.#leaseTtlMs = calculateWorkerLeaseTtlMs(this.#lockTtlMs, this.#pollTimeoutMs);
    this.#registry = options.registry;
    this.#recoverOnStart = options.recoverOnStart ?? true;
    this.#logger = options.logger;
    this.#onStateChange = options.onStateChange;
  }

  start(): void {
    if (this.#loop) {
      return;
    }

    this.#active = true;
    this.#notifyStateChange();
    this.#loop = this.#runLoop();
  }

  async close(): Promise<void> {
    this.#active = false;
    this.#setState("stopping");
    await this.#publishLease();
    await this.#loop;
  }

  async #runLoop(): Promise<void> {
    await this.#publishLease();
    const leaseHeartbeat = setInterval(() => {
      void this.#publishLease();
    }, Math.max(1_000, Math.floor(this.#leaseTtlMs / 3)));
    leaseHeartbeat.unref?.();

    if (this.#recoverOnStart && this.#runtimeService.recoverStaleRuns) {
      try {
        await this.#runtimeService.recoverStaleRuns({
          staleBefore: new Date(Date.now() - this.#recoveryGraceMs).toISOString()
        });
      } catch (error) {
        this.#logger?.warn("Failed to recover stale runs during worker startup.", error);
      }
    }

    this.#setState("idle");
    await this.#publishLease();

    try {
      while (this.#active) {
        let sessionId: string | undefined;
        try {
          sessionId = await this.#queue.claimNextSession(this.#pollTimeoutMs, {
            workerId: this.#workerId,
            ...(this.#runtimeInstanceId ? { runtimeInstanceId: this.#runtimeInstanceId } : {})
          });
        } catch (error) {
          this.#logger?.warn("Failed to claim next Redis run queue item.", error);
          continue;
        }

        if (!sessionId) {
          continue;
        }

        const lockToken = `${this.#workerId}:${createId("lock")}`;
        let acquired = false;
        try {
          acquired = await this.#queue.tryAcquireSessionLock(sessionId, lockToken, this.#lockTtlMs);
        } catch (error) {
          this.#logger?.warn(`Failed to acquire Redis session lock for ${sessionId}.`, error);
          continue;
        }

        if (!acquired) {
          await this.#restoreClaimedSession(sessionId);
          continue;
        }

        this.#setState("busy", sessionId);
        await this.#publishLease();

        const heartbeat = setInterval(() => {
          void this.#queue.renewSessionLock(sessionId, lockToken, this.#lockTtlMs).then(
            (renewed) => {
              if (!renewed) {
                this.#logger?.warn(`Redis session lock renewal lost for ${sessionId}.`);
              }
            },
            (error) => {
              this.#logger?.warn(`Failed to renew Redis session lock for ${sessionId}.`, error);
            }
          );
        }, Math.max(1_000, Math.floor(this.#lockTtlMs / 3)));
        heartbeat.unref?.();

        try {
          while (this.#active) {
            const runId = await this.#queue.dequeueRun(sessionId);
            if (!runId) {
              break;
            }

            try {
              const queuedRun = this.#runtimeService.describeQueuedRun
                ? await this.#runtimeService.describeQueuedRun(runId)
                : undefined;
              this.#setState("busy", sessionId, runId, queuedRun?.workspaceId);
              await this.#publishLease();
              await this.#runtimeService.processQueuedRun(runId);
            } catch (error) {
              this.#logger?.error(`Failed to process queued run ${runId}.`, error);
            } finally {
              this.#setState("busy", sessionId);
              await this.#publishLease();
            }
          }
        } finally {
          clearInterval(heartbeat);
          this.#setState(this.#active ? "idle" : "stopping");
          await this.#publishLease();
          try {
            await this.#queue.releaseSessionLock(sessionId, lockToken);
          } catch (error) {
            this.#logger?.warn(`Failed to release Redis session lock for ${sessionId}.`, error);
          }
        }
      }
    } finally {
      clearInterval(leaseHeartbeat);
      await this.#registry?.remove(this.#workerId).catch((error) => {
        this.#logger?.warn(`Failed to remove worker lease for ${this.#workerId}.`, error);
      });
    }
  }

  async #publishLease(): Promise<void> {
    if (!this.#registry) {
      return;
    }

    try {
      await this.#registry.heartbeat(
        {
          workerId: this.#workerId,
          ...(this.#runtimeInstanceId ? { runtimeInstanceId: this.#runtimeInstanceId } : {}),
          ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
          processKind: this.#processKind,
          state: this.#state,
          lastSeenAt: new Date().toISOString(),
          ...(this.#currentSessionId ? { currentSessionId: this.#currentSessionId } : {}),
          ...(this.#currentRunId ? { currentRunId: this.#currentRunId } : {}),
          ...(this.#currentWorkspaceId ? { currentWorkspaceId: this.#currentWorkspaceId } : {})
        },
        this.#leaseTtlMs
      );
    } catch (error) {
      this.#logger?.warn(`Failed to publish worker lease for ${this.#workerId}.`, error);
    }
  }

  async #restoreClaimedSession(sessionId: string): Promise<void> {
    if (typeof this.#queue.requeueSessionIfPending !== "function") {
      return;
    }

    try {
      await this.#queue.requeueSessionIfPending(sessionId);
    } catch (error) {
      this.#logger?.warn(`Failed to restore claimed Redis session ${sessionId} back to the ready queue.`, error);
    }
  }

  #setState(
    nextState: "starting" | "idle" | "busy" | "stopping",
    currentSessionId?: string,
    currentRunId?: string,
    currentWorkspaceId?: string
  ): void {
    if (
      this.#state === nextState &&
      this.#currentSessionId === currentSessionId &&
      this.#currentRunId === currentRunId &&
      this.#currentWorkspaceId === currentWorkspaceId
    ) {
      return;
    }

    this.#state = nextState;
    this.#currentSessionId = currentSessionId;
    this.#currentRunId = currentRunId;
    this.#currentWorkspaceId = currentWorkspaceId;
    this.#notifyStateChange();
  }

  #notifyStateChange(): void {
    this.#onStateChange?.({
      workerId: this.#workerId,
      state: this.#state,
      ...(this.#currentSessionId ? { currentSessionId: this.#currentSessionId } : {}),
      ...(this.#currentRunId ? { currentRunId: this.#currentRunId } : {}),
      ...(this.#currentWorkspaceId ? { currentWorkspaceId: this.#currentWorkspaceId } : {})
    });
  }
}

export class RedisRunWorkerPool {
  readonly #queue: SessionRunQueue;
  readonly #queueFactory?: (() => Promise<SessionRunQueue>) | undefined;
  readonly #runtimeService: RedisRunWorkerOptions["runtimeService"];
  readonly #runtimeInstanceId?: string | undefined;
  readonly #ownerBaseUrl?: string | undefined;
  readonly #processKind: "embedded" | "standalone";
  readonly #lockTtlMs: number;
  readonly #pollTimeoutMs: number;
  readonly #recoveryGraceMs: number;
  readonly #registry?: WorkerRegistry | undefined;
  readonly #logger?: RedisRunWorkerLogger | undefined;
  readonly #minWorkers: number;
  readonly #maxWorkers: number;
  readonly #scaleIntervalMs: number;
  readonly #readySessionsPerCapacityUnit: number;
  readonly #reservedSubagentCapacity: number;
  readonly #scaleUpCooldownMs: number;
  readonly #scaleDownCooldownMs: number;
  readonly #scaleUpSampleSize: number;
  readonly #scaleDownSampleSize: number;
  readonly #scaleUpBusyRatioThreshold: number;
  readonly #scaleUpMaxReadyAgeMs: number;
  readonly #workers: Array<{
    workerId: string;
    worker: RedisRunWorker;
    queue: SessionRunQueue;
    ownsQueue: boolean;
  }> = [];
  readonly #workerSlots = new Map<string, RedisRunWorkerPoolSlotSnapshot>();
  #active = false;
  #scaleTimer: NodeJS.Timeout | undefined;
  #rebalancePromise: Promise<void> | undefined;
  #lastLoggedState:
    | {
        desiredWorkers: number;
        activeWorkers: number;
      }
    | undefined;
  #lastReadySessionCount: number | undefined;
  #lastReadyQueueDepth: number | undefined;
  #lastUniqueReadySessionCount: number | undefined;
  #lastSubagentReadySessionCount: number | undefined;
  #lastSubagentReadyQueueDepth: number | undefined;
  #lastLockedReadySessionCount: number | undefined;
  #lastStaleReadySessionCount: number | undefined;
  #lastOldestSchedulableReadyAgeMs: number | undefined;
  #lastReservedWorkers: number | undefined;
  #lastGlobalSuggestedWorkers: number | undefined;
  #lastGlobalActiveWorkers: number | undefined;
  #lastGlobalBusyWorkers: number | undefined;
  #lastRemoteActiveWorkers: number | undefined;
  #lastRemoteBusyWorkers: number | undefined;
  #lastRebalanceAtMs: number | undefined;
  #lastRebalanceReason: RedisRunWorkerPoolSnapshot["lastRebalanceReason"];
  #lastScaleUpAtMs: number | undefined;
  #lastScaleDownAtMs: number | undefined;
  #scaleUpPressureStreak = 0;
  #scaleDownPressureStreak = 0;
  #suggestedWorkers = 0;
  #desiredWorkers = 0;
  #recentDecisions: RedisRunWorkerPoolDecision[] = [];

  constructor(options: RedisRunWorkerPoolOptions) {
    this.#queue = options.queue;
    this.#queueFactory = options.queueFactory;
    this.#runtimeService = options.runtimeService;
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#ownerBaseUrl = options.ownerBaseUrl;
    this.#processKind = options.processKind ?? "embedded";
    this.#lockTtlMs = Math.max(1_000, options.lockTtlMs ?? 30_000);
    this.#pollTimeoutMs = Math.max(250, options.pollTimeoutMs ?? 1_000);
    this.#recoveryGraceMs = Math.max(this.#lockTtlMs, options.recoveryGraceMs ?? this.#lockTtlMs * 2);
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#minWorkers = Math.max(1, Math.floor(options.minWorkers ?? 1));
    this.#maxWorkers = Math.max(this.#minWorkers, Math.floor(options.maxWorkers ?? this.#minWorkers));
    this.#scaleIntervalMs = Math.max(1_000, Math.floor(options.scaleIntervalMs ?? 5_000));
    this.#readySessionsPerCapacityUnit = Math.max(1, Math.floor(options.readySessionsPerCapacityUnit ?? 1));
    this.#reservedSubagentCapacity = Math.max(0, Math.floor(options.reservedSubagentCapacity ?? 1));
    this.#scaleUpCooldownMs = Math.max(0, Math.floor(options.scaleUpCooldownMs ?? 1_000));
    this.#scaleDownCooldownMs = Math.max(0, Math.floor(options.scaleDownCooldownMs ?? 15_000));
    this.#scaleUpSampleSize = Math.max(1, Math.floor(options.scaleUpSampleSize ?? 2));
    this.#scaleDownSampleSize = Math.max(1, Math.floor(options.scaleDownSampleSize ?? 3));
    this.#scaleUpBusyRatioThreshold = Math.min(1, Math.max(0, options.scaleUpBusyRatioThreshold ?? 0.75));
    this.#scaleUpMaxReadyAgeMs = Math.max(0, Math.floor(options.scaleUpMaxReadyAgeMs ?? 2_000));
  }

  start(): void {
    if (this.#active) {
      return;
    }

    this.#active = true;
    void this.#scheduleRebalance("startup");
    this.#scaleTimer = setInterval(() => {
      void this.#scheduleRebalance("interval");
    }, this.#scaleIntervalMs);
    this.#scaleTimer.unref?.();
  }

  async close(): Promise<void> {
    this.#active = false;
    if (this.#scaleTimer) {
      clearInterval(this.#scaleTimer);
      this.#scaleTimer = undefined;
    }

    await this.#rebalancePromise;

    const workers = this.#workers.splice(0, this.#workers.length).reverse();
    await Promise.all(
      workers.map(async ({ worker, queue, ownsQueue }) => {
        await worker.close();
        if (ownsQueue) {
          await queue.close();
        }
      })
    );
    this.#workerSlots.clear();

    this.#desiredWorkers = 0;
    this.#lastRebalanceAtMs = Date.now();
    this.#lastRebalanceReason = "shutdown";
    this.#recordDecision("shutdown");
    this.#logRebalanceIfChanged(0, "shutdown");
  }

  snapshot(nowMs = Date.now()): RedisRunWorkerPoolSnapshot {
    const scaleDownCooldownReferenceMs = this.#lastCapacityChangeAtMs();
    const schedulingPressure = this.#lastSchedulingPressure();
    const busyWorkers = this.#busyWorkerCount();
    const pressureSummary = summarizeRedisRunWorkerPoolPressure({
      activeWorkers: this.#workers.length,
      busyWorkers,
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      schedulingPressure
    });
    return buildRedisRunWorkerPoolSnapshot({
      running: this.#active,
      processKind: this.#processKind,
      minWorkers: this.#minWorkers,
      maxWorkers: this.#maxWorkers,
      suggestedWorkers: this.#suggestedWorkers,
      ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      ...(typeof this.#lastReservedWorkers === "number" ? { reservedWorkers: this.#lastReservedWorkers } : {}),
      availableIdleCapacity: pressureSummary.availableIdleCapacity,
      ...(typeof pressureSummary.readySessionsPerActiveWorker === "number"
        ? { readySessionsPerActiveWorker: pressureSummary.readySessionsPerActiveWorker }
        : {}),
      subagentReserveTarget: pressureSummary.subagentReserveTarget,
      subagentReserveDeficit: pressureSummary.subagentReserveDeficit,
      desiredWorkers: this.#desiredWorkers,
      slots: this.#slotSnapshots(),
      ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
      ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
      ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
      ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
      readySessionsPerCapacityUnit: this.#readySessionsPerCapacityUnit,
      scaleIntervalMs: this.#scaleIntervalMs,
      scaleUpCooldownMs: this.#scaleUpCooldownMs,
      scaleDownCooldownMs: this.#scaleDownCooldownMs,
      scaleUpSampleSize: this.#scaleUpSampleSize,
      scaleDownSampleSize: this.#scaleDownSampleSize,
      scaleUpBusyRatioThreshold: this.#scaleUpBusyRatioThreshold,
      scaleUpMaxReadyAgeMs: this.#scaleUpMaxReadyAgeMs,
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : {}),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadySessionCount === "number"
        ? { subagentReadySessionCount: this.#lastSubagentReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadyQueueDepth === "number"
        ? { subagentReadyQueueDepth: this.#lastSubagentReadyQueueDepth }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {}),
      ...(this.#lastRebalanceAtMs ? { lastRebalanceAt: new Date(this.#lastRebalanceAtMs).toISOString() } : {}),
      ...(this.#lastRebalanceReason ? { lastRebalanceReason: this.#lastRebalanceReason } : {}),
      scaleUpPressureStreak: this.#scaleUpPressureStreak,
      scaleDownPressureStreak: this.#scaleDownPressureStreak,
      scaleUpCooldownRemainingMs: this.#cooldownRemainingMs(this.#lastScaleUpAtMs, this.#scaleUpCooldownMs, nowMs),
      scaleDownCooldownRemainingMs: this.#cooldownRemainingMs(scaleDownCooldownReferenceMs, this.#scaleDownCooldownMs, nowMs),
      recentDecisions: [...this.#recentDecisions]
    });
  }

  async #scheduleRebalance(reason: "startup" | "interval"): Promise<void> {
    if (this.#rebalancePromise) {
      return this.#rebalancePromise;
    }

    const task = this.#rebalance(reason).finally(() => {
      if (this.#rebalancePromise === task) {
        this.#rebalancePromise = undefined;
      }
    });
    this.#rebalancePromise = task;
    return task;
  }

  async #rebalance(reason: "startup" | "interval"): Promise<void> {
    const schedulingPressure = await this.#readSchedulingPressure();
    const readySessionCount = schedulingPressure?.readySessionCount;
    const globalWorkerLoad = await this.#readGlobalWorkerLoad();
    const currentWorkers = this.#workers.length;
    this.#lastReservedWorkers = undefined;
    const suggestedWorkers = this.#rawDesiredWorkerCount(schedulingPressure, globalWorkerLoad);
    this.#suggestedWorkers = suggestedWorkers;
    const desiredWorkers = this.#desiredWorkerCount(suggestedWorkers, currentWorkers, reason);
    this.#desiredWorkers = desiredWorkers;
    this.#lastReadySessionCount = readySessionCount;
    this.#lastReadyQueueDepth = schedulingPressure?.readyQueueDepth;
    this.#lastUniqueReadySessionCount = schedulingPressure?.uniqueReadySessionCount;
    this.#lastSubagentReadySessionCount = schedulingPressure?.subagentReadySessionCount;
    this.#lastSubagentReadyQueueDepth = schedulingPressure?.subagentReadyQueueDepth;
    this.#lastLockedReadySessionCount = schedulingPressure?.lockedReadySessionCount;
    this.#lastStaleReadySessionCount = schedulingPressure?.staleReadySessionCount;
    this.#lastOldestSchedulableReadyAgeMs = schedulingPressure?.oldestSchedulableReadyAgeMs;
    this.#lastGlobalSuggestedWorkers = globalWorkerLoad?.globalSuggestedWorkers;
    this.#lastGlobalActiveWorkers = globalWorkerLoad?.globalActiveWorkers;
    this.#lastGlobalBusyWorkers = globalWorkerLoad?.globalBusyWorkers;
    this.#lastRemoteActiveWorkers = globalWorkerLoad?.remoteActiveWorkers;
    this.#lastRemoteBusyWorkers = globalWorkerLoad?.remoteBusyWorkers;

    while (this.#active && this.#workers.length < desiredWorkers) {
      const queue = this.#queueFactory ? await this.#queueFactory() : this.#queue;
      const ownsQueue = Boolean(this.#queueFactory);
      const workerId = createId("worker");
      const worker = new RedisRunWorker({
        workerId,
        ...(this.#runtimeInstanceId ? { runtimeInstanceId: this.#runtimeInstanceId } : {}),
        ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
        queue,
        runtimeService: this.#runtimeService,
        processKind: this.#processKind,
        lockTtlMs: this.#lockTtlMs,
        pollTimeoutMs: this.#pollTimeoutMs,
        recoveryGraceMs: this.#recoveryGraceMs,
        registry: this.#registry,
        recoverOnStart: this.#workers.length === 0,
        logger: this.#logger,
        onStateChange: ({ workerId: stateWorkerId, state, currentSessionId, currentRunId, currentWorkspaceId }) => {
          this.#workerSlots.set(stateWorkerId, {
            slotId: stateWorkerId,
            workerId: stateWorkerId,
            processKind: this.#processKind,
            state,
            ...(currentSessionId ? { currentSessionId } : {}),
            ...(currentRunId ? { currentRunId } : {}),
            ...(currentWorkspaceId ? { currentWorkspaceId } : {})
          });
        }
      });
      this.#workers.push({
        workerId,
        worker,
        queue,
        ownsQueue
      });
      worker.start();
    }

    let scaledDown = false;
    while (this.#workers.length > desiredWorkers) {
      const removed = this.#workers.pop();
      if (!removed) {
        break;
      }

      await removed.worker.close();
      if (removed.ownsQueue) {
        await removed.queue.close();
      }
      this.#workerSlots.delete(removed.workerId);
      scaledDown = true;
    }

    const activeWorkers = this.#workers.length;
    const rebalanceReason =
      reason === "startup"
        ? "startup"
        : activeWorkers > currentWorkers
          ? "scale_up"
          : scaledDown
            ? "scale_down"
            : desiredWorkers !== suggestedWorkers
              ? "cooldown_hold"
              : "steady";
    const nowMs = Date.now();
    if (activeWorkers > currentWorkers) {
      this.#lastScaleUpAtMs = nowMs;
    }
    if (scaledDown) {
      this.#lastScaleDownAtMs = nowMs;
    }
    this.#lastRebalanceAtMs = nowMs;
    this.#lastRebalanceReason = rebalanceReason;
    if (globalWorkerLoad) {
      this.#lastGlobalActiveWorkers = globalWorkerLoad.remoteActiveWorkers + activeWorkers;
      this.#lastGlobalBusyWorkers = globalWorkerLoad.remoteBusyWorkers + this.#busyWorkerCount();
    }
    this.#recordDecision(rebalanceReason);
    this.#logRebalanceIfChanged(desiredWorkers, rebalanceReason, schedulingPressure);
  }

  async #readSchedulingPressure(): Promise<SessionRunQueuePressure | undefined> {
    if (typeof this.#queue.getSchedulingPressure === "function") {
      try {
        return await this.#queue.getSchedulingPressure();
      } catch (error) {
        this.#logger?.warn("Failed to read Redis scheduling pressure for worker pool rebalance.", error);
      }
    }

    if (typeof this.#queue.getReadySessionCount !== "function") {
      return undefined;
    }

    try {
      return {
        readySessionCount: await this.#queue.getReadySessionCount()
      };
    } catch (error) {
      this.#logger?.warn("Failed to read Redis ready-session depth for worker pool rebalance.", error);
      return undefined;
    }
  }

  async #readGlobalWorkerLoad():
    Promise<
      | {
          globalSuggestedWorkers: number;
          globalActiveWorkers: number;
          globalBusyWorkers: number;
          remoteActiveWorkers: number;
          remoteBusyWorkers: number;
        }
      | undefined
    > {
    if (typeof this.#registry?.listActive !== "function") {
      return undefined;
    }

    try {
      const activeWorkers = await this.#registry.listActive(Date.now());
      return summarizeRedisWorkerLoad({
        activeWorkers,
        localWorkerIds: this.#workers.map((entry) => entry.workerId),
        localActiveWorkers: this.#workers.length,
        localBusyWorkers: this.#busyWorkerCount()
      });
    } catch (error) {
      this.#logger?.warn("Failed to read global Redis worker load for worker pool rebalance.", error);
      return undefined;
    }
  }

  #desiredWorkerCount(suggestedWorkers: number, currentWorkers: number, reason: "startup" | "interval"): number {
    if (!this.#queueFactory) {
      return 1;
    }

    if (suggestedWorkers > currentWorkers) {
      this.#scaleUpPressureStreak += 1;
    } else {
      this.#scaleUpPressureStreak = 0;
    }
    if (suggestedWorkers < currentWorkers) {
      this.#scaleDownPressureStreak += 1;
    } else {
      this.#scaleDownPressureStreak = 0;
    }

    const targetWorkers =
      suggestedWorkers > currentWorkers
        ? this.#scaleUpPressureStreak >= this.#scaleUpSampleSize
          ? suggestedWorkers
          : currentWorkers
        : suggestedWorkers < currentWorkers
          ? this.#scaleDownPressureStreak >= this.#scaleDownSampleSize
            ? suggestedWorkers
            : currentWorkers
          : suggestedWorkers;
    if (reason === "startup") {
      return suggestedWorkers;
    }

    const nowMs = Date.now();
    if (targetWorkers > currentWorkers && this.#cooldownRemainingMs(this.#lastScaleUpAtMs, this.#scaleUpCooldownMs, nowMs) > 0) {
      return currentWorkers;
    }
    if (targetWorkers < currentWorkers && this.#cooldownRemainingMs(this.#lastCapacityChangeAtMs(), this.#scaleDownCooldownMs, nowMs) > 0) {
      return currentWorkers;
    }

    return targetWorkers;
  }

  #rawDesiredWorkerCount(
    schedulingPressure: SessionRunQueuePressure | undefined,
    globalWorkerLoad?:
      | {
          globalSuggestedWorkers: number;
          globalActiveWorkers: number;
          globalBusyWorkers: number;
          remoteActiveWorkers: number;
          remoteBusyWorkers: number;
        }
      | undefined
  ): number {
    const sizing = calculateRedisWorkerPoolSuggestion({
      minWorkers: this.#minWorkers,
      maxWorkers: this.#maxWorkers,
      readySessionsPerCapacityUnit: this.#readySessionsPerCapacityUnit,
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      localActiveWorkers: this.#workers.length,
      localBusyWorkers: this.#busyWorkerCount(),
      scaleUpBusyRatioThreshold: this.#scaleUpBusyRatioThreshold,
      scaleUpMaxReadyAgeMs: this.#scaleUpMaxReadyAgeMs,
      schedulingPressure,
      globalWorkerLoad
    });
    if (globalWorkerLoad) {
      globalWorkerLoad.globalSuggestedWorkers = sizing.globalSuggestedWorkers;
    }
    this.#lastReservedWorkers = sizing.reservedWorkers;

    return sizing.localSuggestedWorkers;
  }

  #cooldownRemainingMs(lastChangeAtMs: number | undefined, cooldownMs: number, nowMs: number): number {
    if (!lastChangeAtMs || cooldownMs <= 0) {
      return 0;
    }

    return Math.max(0, lastChangeAtMs + cooldownMs - nowMs);
  }

  #lastCapacityChangeAtMs(): number | undefined {
    const lastScaleUpAtMs = this.#lastScaleUpAtMs ?? 0;
    const lastScaleDownAtMs = this.#lastScaleDownAtMs ?? 0;
    const latest = Math.max(lastScaleUpAtMs, lastScaleDownAtMs);
    return latest > 0 ? latest : undefined;
  }

  #recordDecision(reason: NonNullable<RedisRunWorkerPoolSnapshot["lastRebalanceReason"]>): void {
    const pressureSummary = summarizeRedisRunWorkerPoolPressure({
      activeWorkers: this.#workers.length,
      busyWorkers: this.#busyWorkerCount(),
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      schedulingPressure: this.#lastSchedulingPressure()
    });
    const decision = buildRedisRunWorkerPoolDecision({
      timestamp: new Date(this.#lastRebalanceAtMs ?? Date.now()).toISOString(),
      reason,
      suggestedWorkers: this.#suggestedWorkers,
      ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      ...(typeof this.#lastReservedWorkers === "number" ? { reservedWorkers: this.#lastReservedWorkers } : {}),
      availableIdleCapacity: pressureSummary.availableIdleCapacity,
      ...(typeof pressureSummary.readySessionsPerActiveWorker === "number"
        ? { readySessionsPerActiveWorker: pressureSummary.readySessionsPerActiveWorker }
        : {}),
      subagentReserveTarget: pressureSummary.subagentReserveTarget,
      subagentReserveDeficit: pressureSummary.subagentReserveDeficit,
      desiredWorkers: this.#desiredWorkers,
      activeWorkers: this.#workers.length,
      busyWorkers: this.#busyWorkerCount(),
      ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
      ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
      ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
      ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : {}),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadySessionCount === "number"
        ? { subagentReadySessionCount: this.#lastSubagentReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadyQueueDepth === "number"
        ? { subagentReadyQueueDepth: this.#lastSubagentReadyQueueDepth }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {})
    });
    this.#recentDecisions = appendRedisRunWorkerPoolDecision(this.#recentDecisions, decision);
  }

  #logRebalanceIfChanged(
    desiredWorkers: number,
    reason: NonNullable<RedisRunWorkerPoolSnapshot["lastRebalanceReason"]>,
    schedulingPressure?: SessionRunQueuePressure
  ): void {
    const activeWorkers = this.#workers.length;
    const busyWorkers = this.#busyWorkerCount();
    const pressureSummary = summarizeRedisRunWorkerPoolPressure({
      activeWorkers,
      busyWorkers,
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      schedulingPressure
    });
    if (
      !shouldLogRedisRunWorkerPoolRebalance(this.#lastLoggedState, {
        desiredWorkers,
        activeWorkers,
        reason
      })
    ) {
      return;
    }

    this.#lastLoggedState = {
      desiredWorkers,
      activeWorkers
    };
    this.#logger?.info?.(
      formatRedisRunWorkerPoolRebalanceLog({
        reason,
        activeWorkers,
        desiredWorkers,
        suggestedWorkers: this.#suggestedWorkers,
        ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
        reservedSubagentCapacity: this.#reservedSubagentCapacity,
        ...(typeof this.#lastReservedWorkers === "number" ? { reservedWorkers: this.#lastReservedWorkers } : {}),
        availableIdleCapacity: pressureSummary.availableIdleCapacity,
        ...(typeof pressureSummary.readySessionsPerActiveWorker === "number"
          ? { readySessionsPerActiveWorker: pressureSummary.readySessionsPerActiveWorker }
          : {}),
        subagentReserveTarget: pressureSummary.subagentReserveTarget,
        subagentReserveDeficit: pressureSummary.subagentReserveDeficit,
        ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
        ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
        ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
        ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
        busyWorkers,
        minWorkers: this.#minWorkers,
        maxWorkers: this.#maxWorkers,
        scaleUpPressureStreak: this.#scaleUpPressureStreak,
        scaleUpSampleSize: this.#scaleUpSampleSize,
        scaleDownPressureStreak: this.#scaleDownPressureStreak,
        scaleDownSampleSize: this.#scaleDownSampleSize,
        schedulingPressure
      })
    );
  }

  #busyWorkerCount(): number {
    return this.#slotSnapshots().filter((slot) => slot.state === "busy").length;
  }

  #slotSnapshots(): RedisRunWorkerPoolSlotSnapshot[] {
    return [...this.#workerSlots.values()].sort((left, right) => left.slotId.localeCompare(right.slotId));
  }

  #lastSchedulingPressure(): SessionRunQueuePressure | undefined {
    const hasAnySignal = [
      this.#lastReadySessionCount,
      this.#lastReadyQueueDepth,
      this.#lastUniqueReadySessionCount,
      this.#lastSubagentReadySessionCount,
      this.#lastSubagentReadyQueueDepth,
      this.#lastLockedReadySessionCount,
      this.#lastStaleReadySessionCount,
      this.#lastOldestSchedulableReadyAgeMs
    ].some((value) => typeof value === "number");

    if (!hasAnySignal) {
      return undefined;
    }

    return {
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : { readySessionCount: 0 }),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadySessionCount === "number"
        ? { subagentReadySessionCount: this.#lastSubagentReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadyQueueDepth === "number"
        ? { subagentReadyQueueDepth: this.#lastSubagentReadyQueueDepth }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {})
    };
  }

}

export class FanoutSessionEventStore implements SessionEventStore {
  readonly #primary: SessionEventStore;
  readonly #bus: SessionEventBus;

  constructor(primary: SessionEventStore, bus: SessionEventBus) {
    this.#primary = primary;
    this.#bus = bus;
  }

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.#primary.append(input);
    await this.#bus.publish(event);
    return event;
  }

  async deleteById(eventId: string): Promise<void> {
    await this.#primary.deleteById(eventId);
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    return this.#primary.listSince(sessionId, cursor, runId);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const seen = new Set<string>();
    const order: string[] = [];
    let active = true;
    let unsubscribeSecondary: (() => Promise<void> | void) | undefined;

    const forward = (event: SessionEvent) => {
      if (!active || event.sessionId !== sessionId || seen.has(event.id)) {
        return;
      }

      seen.add(event.id);
      order.push(event.id);
      if (order.length > 1024) {
        const oldest = order.shift();
        if (oldest) {
          seen.delete(oldest);
        }
      }

      listener(event);
    };

    const unsubscribePrimary = this.#primary.subscribe(sessionId, forward);

    void this.#bus.subscribe(sessionId, forward).then(
      (unsubscribe) => {
        if (!active) {
          void unsubscribe();
          return;
        }

        unsubscribeSecondary = unsubscribe;
      },
      () => undefined
    );

    return () => {
      active = false;
      unsubscribePrimary();
      void unsubscribeSecondary?.();
    };
  }
}

export async function createRedisSessionEventBus(
  options: CreateRedisSessionEventBusOptions
): Promise<RedisSessionEventBus> {
  const bus = new RedisSessionEventBus(options);
  await bus.connect();
  return bus;
}

export async function createRedisSessionRunQueue(
  options: CreateRedisSessionRunQueueOptions
): Promise<RedisSessionRunQueue> {
  const queue = new RedisSessionRunQueue(options);
  await queue.connect();
  return queue;
}

export async function createRedisWorkerRegistry(
  options: CreateRedisWorkerRegistryOptions
): Promise<RedisWorkerRegistry> {
  const registry = new RedisWorkerRegistry(options);
  await registry.connect();
  return registry;
}

export async function createRedisWorkspaceLeaseRegistry(
  options: CreateRedisWorkspaceLeaseRegistryOptions
): Promise<RedisWorkspaceLeaseRegistry> {
  const registry = new RedisWorkspaceLeaseRegistry(options);
  await registry.connect();
  return registry;
}

export async function createRedisWorkspacePlacementRegistry(
  options: CreateRedisWorkspacePlacementRegistryOptions
): Promise<RedisWorkspacePlacementRegistry> {
  const registry = new RedisWorkspacePlacementRegistry(options);
  await registry.connect();
  return registry;
}
