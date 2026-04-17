import { z } from "zod";
import { timestampSchema } from "./common.js";
import { sandboxTopologySchema } from "./sandboxes.js";

export const workerModeSchema = z.enum(["embedded", "external", "disabled"]);
export const workerProcessKindSchema = z.enum(["embedded", "standalone"]);
export const workerStateSchema = z.enum(["starting", "idle", "busy", "stopping"]);
export const workerHealthSchema = z.enum(["healthy", "late"]);
export const sessionSerialBoundarySchema = z.literal("session");

export const healthCheckStatusSchema = z.enum(["up", "down", "not_configured"]);
export const readinessStatusSchema = z.enum(["ready", "not_ready"]);
export const readinessReasonSchema = z.enum(["draining", "checks_down"]);
export const healthStatusSchema = z.enum(["ok", "degraded"]);
export const runtimeProcessSchema = z.object({
  mode: z.enum(["api_embedded_worker", "api_only", "standalone_worker"]),
  label: z.enum(["API + embedded worker", "API only", "standalone worker"]),
  execution: z.enum(["redis_queue", "local_inline", "none"])
});
export const healthStorageSchema = z.object({
  primary: z.enum(["postgres", "sqlite"]),
  events: z.enum(["redis", "memory"]),
  runQueue: z.enum(["redis", "in_process"])
});

export const workerLeaseSchema = z.object({
  workerId: z.string(),
  processKind: workerProcessKindSchema,
  state: workerStateSchema,
  lastSeenAt: timestampSchema,
  leaseTtlMs: z.number().int().min(0),
  expiresAt: timestampSchema,
  lastSeenAgeMs: z.number().int().min(0),
  health: workerHealthSchema,
  currentSessionId: z.string().optional(),
  currentRunId: z.string().optional(),
  currentWorkspaceId: z.string().optional()
});

export const workerSlotSchema = z.object({
  slotId: z.string(),
  workerId: z.string(),
  processKind: workerProcessKindSchema,
  state: workerStateSchema,
  currentSessionId: z.string().optional(),
  currentRunId: z.string().optional(),
  currentWorkspaceId: z.string().optional()
});

export const workerSummarySchema = z.object({
  active: z.number().int().min(0),
  healthy: z.number().int().min(0),
  late: z.number().int().min(0),
  busy: z.number().int().min(0),
  embedded: z.number().int().min(0),
  standalone: z.number().int().min(0)
});

export const workerPoolDecisionReasonSchema = z.enum([
  "startup",
  "steady",
  "scale_up",
  "scale_down",
  "cooldown_hold",
  "shutdown"
]);

export const workerPoolDecisionSchema = z.object({
  timestamp: timestampSchema,
  reason: workerPoolDecisionReasonSchema,
  suggestedWorkers: z.number().int().min(0),
  globalSuggestedWorkers: z.number().int().min(0).optional(),
  reservedSubagentCapacity: z.number().int().min(0).optional(),
  reservedWorkers: z.number().int().min(0).optional(),
  availableIdleCapacity: z.number().int().min(0).optional(),
  readySessionsPerActiveWorker: z.number().min(0).optional(),
  subagentReserveTarget: z.number().int().min(0).optional(),
  subagentReserveDeficit: z.number().int().min(0).optional(),
  desiredWorkers: z.number().int().min(0),
  activeWorkers: z.number().int().min(0),
  busyWorkers: z.number().int().min(0).optional(),
  globalActiveWorkers: z.number().int().min(0).optional(),
  globalBusyWorkers: z.number().int().min(0).optional(),
  remoteActiveWorkers: z.number().int().min(0).optional(),
  remoteBusyWorkers: z.number().int().min(0).optional(),
  readySessionCount: z.number().int().min(0).optional(),
  readyQueueDepth: z.number().int().min(0).optional(),
  uniqueReadySessionCount: z.number().int().min(0).optional(),
  subagentReadySessionCount: z.number().int().min(0).optional(),
  subagentReadyQueueDepth: z.number().int().min(0).optional(),
  lockedReadySessionCount: z.number().int().min(0).optional(),
  staleReadySessionCount: z.number().int().min(0).optional(),
  oldestSchedulableReadyAgeMs: z.number().int().min(0).optional()
});

export const workerPoolSchema = z.object({
  running: z.boolean(),
  processKind: workerProcessKindSchema,
  sessionSerialBoundary: sessionSerialBoundarySchema,
  minWorkers: z.number().int().min(0),
  maxWorkers: z.number().int().min(0),
  suggestedWorkers: z.number().int().min(0),
  globalSuggestedWorkers: z.number().int().min(0).optional(),
  reservedSubagentCapacity: z.number().int().min(0),
  reservedWorkers: z.number().int().min(0).optional(),
  availableIdleCapacity: z.number().int().min(0),
  readySessionsPerActiveWorker: z.number().min(0).optional(),
  subagentReserveTarget: z.number().int().min(0),
  subagentReserveDeficit: z.number().int().min(0),
  desiredWorkers: z.number().int().min(0),
  slotCapacity: z.number().int().min(0),
  slots: z.array(workerSlotSchema),
  activeWorkers: z.number().int().min(0),
  busySlots: z.number().int().min(0),
  idleSlots: z.number().int().min(0),
  busyWorkers: z.number().int().min(0),
  idleWorkers: z.number().int().min(0),
  globalActiveWorkers: z.number().int().min(0).optional(),
  globalBusyWorkers: z.number().int().min(0).optional(),
  remoteActiveWorkers: z.number().int().min(0).optional(),
  remoteBusyWorkers: z.number().int().min(0).optional(),
  readySessionsPerCapacityUnit: z.number().int().min(1).describe("Primary queue-density target per observed capacity unit."),
  scaleIntervalMs: z.number().int().min(0),
  scaleUpCooldownMs: z.number().int().min(0),
  scaleDownCooldownMs: z.number().int().min(0),
  scaleUpSampleSize: z.number().int().min(1),
  scaleDownSampleSize: z.number().int().min(1),
  scaleUpBusyRatioThreshold: z.number().min(0).max(1),
  scaleUpMaxReadyAgeMs: z.number().int().min(0),
  readySessionCount: z.number().int().min(0).optional(),
  readyQueueDepth: z.number().int().min(0).optional(),
  uniqueReadySessionCount: z.number().int().min(0).optional(),
  subagentReadySessionCount: z.number().int().min(0).optional(),
  subagentReadyQueueDepth: z.number().int().min(0).optional(),
  lockedReadySessionCount: z.number().int().min(0).optional(),
  staleReadySessionCount: z.number().int().min(0).optional(),
  oldestSchedulableReadyAgeMs: z.number().int().min(0).optional(),
  lastRebalanceAt: timestampSchema.optional(),
  lastRebalanceReason: workerPoolDecisionReasonSchema.optional(),
  scaleUpPressureStreak: z.number().int().min(0),
  scaleDownPressureStreak: z.number().int().min(0),
  scaleUpCooldownRemainingMs: z.number().int().min(0),
  scaleDownCooldownRemainingMs: z.number().int().min(0),
  recentDecisions: z.array(workerPoolDecisionSchema)
});

export const healthChecksSchema = z.object({
  postgres: healthCheckStatusSchema,
  redisEvents: healthCheckStatusSchema,
  redisRunQueue: healthCheckStatusSchema
});

export const healthWorkerSchema = z.object({
  mode: workerModeSchema,
  draining: z.boolean(),
  acceptsNewRuns: z.boolean(),
  drainStartedAt: timestampSchema.optional(),
  sessionSerialBoundary: sessionSerialBoundarySchema,
  localSlots: z.array(workerSlotSchema),
  activeWorkers: z.array(workerLeaseSchema),
  summary: workerSummarySchema,
  pool: workerPoolSchema.nullable(),
  materialization: z
    .object({
      draining: z.boolean(),
      drainStartedAt: timestampSchema.optional(),
      cachedCopies: z.number().int().min(0),
      objectStoreCopies: z.number().int().min(0),
      dirtyCopies: z.number().int().min(0),
      busyCopies: z.number().int().min(0),
      idleCopies: z.number().int().min(0),
      failureCount: z.number().int().min(0),
      blockerCount: z.number().int().min(0),
      failures: z.array(
        z.object({
          cacheKey: z.string(),
          workspaceId: z.string(),
          version: z.string(),
          ownerWorkerId: z.string(),
          sourceKind: z.enum(["object_store", "local_directory"]),
          localPath: z.string(),
          remotePrefix: z.string().optional(),
          stage: z.enum(["materialize", "idle_flush", "idle_evict", "drain_evict", "drain_release", "delete", "close"]),
          operation: z.enum(["materialize", "flush", "evict"]),
          at: timestampSchema,
          errorMessage: z.string(),
          dirty: z.boolean(),
          refCount: z.number().int().min(0),
          draining: z.boolean()
        })
      )
    })
    .optional()
});

export const healthReportSchema = z.object({
  status: healthStatusSchema,
  storage: healthStorageSchema,
  process: runtimeProcessSchema,
  sandbox: sandboxTopologySchema,
  checks: healthChecksSchema,
  worker: healthWorkerSchema
});

export const readinessReportSchema = z.object({
  status: readinessStatusSchema,
  reason: readinessReasonSchema.optional(),
  draining: z.boolean().optional(),
  checks: healthChecksSchema
});

export type WorkerMode = z.infer<typeof workerModeSchema>;
export type WorkerProcessKind = z.infer<typeof workerProcessKindSchema>;
export type WorkerState = z.infer<typeof workerStateSchema>;
export type WorkerHealth = z.infer<typeof workerHealthSchema>;
export type SessionSerialBoundary = z.infer<typeof sessionSerialBoundarySchema>;
export type HealthCheckStatus = z.infer<typeof healthCheckStatusSchema>;
export type ReadinessReason = z.infer<typeof readinessReasonSchema>;
export type RuntimeProcess = z.infer<typeof runtimeProcessSchema>;
export type HealthStorage = z.infer<typeof healthStorageSchema>;
export type WorkerLease = z.infer<typeof workerLeaseSchema>;
export type WorkerSlot = z.infer<typeof workerSlotSchema>;
export type WorkerSummary = z.infer<typeof workerSummarySchema>;
export type WorkerPoolDecisionReason = z.infer<typeof workerPoolDecisionReasonSchema>;
export type WorkerPoolDecision = z.infer<typeof workerPoolDecisionSchema>;
export type WorkerPool = z.infer<typeof workerPoolSchema>;
export type HealthChecks = z.infer<typeof healthChecksSchema>;
export type HealthWorker = z.infer<typeof healthWorkerSchema>;
export type HealthReport = z.infer<typeof healthReportSchema>;
export type ReadinessReport = z.infer<typeof readinessReportSchema>;
