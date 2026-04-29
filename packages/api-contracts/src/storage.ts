import { z } from "zod";
import { jsonValueSchema, timestampSchema } from "./common.js";
import { workerHealthSchema, workerProcessKindSchema, workerStateSchema } from "./health.js";

export const storagePostgresTableNameSchema = z.enum([
  "workspaces",
  "sessions",
  "runs",
  "messages",
  "run_steps",
  "session_events",
  "tool_calls",
  "hook_runs",
  "artifacts",
  "history_events",
  "archives"
]);

export const storagePostgresTableSummarySchema = z.object({
  name: storagePostgresTableNameSchema,
  rowCount: z.number().int().min(0),
  orderBy: z.string(),
  description: z.string()
});

export const storageRedisKeySummarySchema = z.object({
  key: z.string(),
  type: z.string(),
  ttlMs: z.number().int().optional(),
  size: z.number().int().min(0).optional()
});

export const storageRedisQueueSummarySchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  length: z.number().int().min(0)
});

export const storageRedisLockSummarySchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  ttlMs: z.number().int().optional(),
  owner: z.string().optional()
});

export const storageOverviewSchema = z.object({
  postgres: z.object({
    configured: z.boolean(),
    available: z.boolean(),
    primaryStorage: z.boolean(),
    database: z.string().optional(),
    tables: z.array(storagePostgresTableSummarySchema),
    historyEvents: z
      .object({
        cleanupEnabled: z.boolean(),
        retentionDays: z.number().int().min(1),
        rowCount: z.number().int().min(0),
        oldestOccurredAt: z.string().optional(),
        newestOccurredAt: z.string().optional()
      })
      .optional(),
    archives: z
      .object({
        exportEnabled: z.boolean(),
        rowCount: z.number().int().min(0),
        pendingExports: z.number().int().min(0),
        exportedRows: z.number().int().min(0),
        exportRoot: z.string().optional(),
        bundleCount: z.number().int().min(0).optional(),
        checksumCount: z.number().int().min(0).optional(),
        totalBytes: z.number().int().min(0).optional(),
        latestArchiveDate: z.string().optional(),
        leftoverTempFiles: z.number().int().min(0).optional(),
        unexpectedFiles: z.number().int().min(0).optional(),
        unexpectedDirectories: z.number().int().min(0).optional(),
        missingChecksums: z.number().int().min(0).optional(),
        orphanChecksums: z.number().int().min(0).optional(),
        oldestPendingArchiveDate: z.string().optional(),
        newestExportedAt: z.string().optional()
      })
      .optional(),
    recovery: z
      .object({
        trackedRuns: z.number().int().min(0),
        quarantinedRuns: z.number().int().min(0),
        requeuedRuns: z.number().int().min(0),
        failedRecoveryRuns: z.number().int().min(0),
        workerRecoveryFailures: z.number().int().min(0),
        oldestQuarantinedAt: z.string().optional(),
        newestQuarantinedAt: z.string().optional(),
        newestRecoveredAt: z.string().optional(),
        topQuarantineReasons: z.array(
          z.object({
            reason: z.string(),
            count: z.number().int().min(0)
          })
        )
      })
      .optional()
  }),
  redis: z.object({
    configured: z.boolean(),
    available: z.boolean(),
    keyPrefix: z.string(),
    eventBusEnabled: z.boolean(),
    runQueueEnabled: z.boolean(),
    dbSize: z.number().int().min(0).optional(),
    readyQueue: z
      .object({
        key: z.string(),
        length: z.number().int().min(0)
      })
      .optional(),
    sessionQueuesTruncated: z.boolean().optional(),
    sessionLocksTruncated: z.boolean().optional(),
    eventBuffersTruncated: z.boolean().optional(),
    sessionQueues: z.array(storageRedisQueueSummarySchema),
    sessionLocks: z.array(storageRedisLockSummarySchema),
    eventBuffers: z.array(storageRedisQueueSummarySchema)
  })
});

export const storageOverviewQuerySchema = z.object({
  serviceName: z.string().optional()
});

export const storagePostgresTablePageSchema = z.object({
  table: storagePostgresTableNameSchema,
  rowCount: z.number().int().min(0),
  orderBy: z.string(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(200),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), jsonValueSchema)),
  appliedFilters: z
    .object({
      serviceName: z.string().optional(),
      q: z.string().optional(),
      workspaceId: z.string().optional(),
      sessionId: z.string().optional(),
      runId: z.string().optional(),
      status: z.string().optional(),
      errorCode: z.string().optional(),
      recoveryState: z.string().optional()
    })
    .optional(),
  nextOffset: z.number().int().min(0).optional()
});

export const storageRedisKeyPageSchema = z.object({
  pattern: z.string(),
  items: z.array(storageRedisKeySummarySchema),
  nextCursor: z.string().optional()
});

export const storageRedisKeyDetailSchema = z.object({
  key: z.string(),
  type: z.string(),
  ttlMs: z.number().int().optional(),
  size: z.number().int().min(0).optional(),
  value: jsonValueSchema.optional()
});

export const storageRedisDeleteKeyResponseSchema = z.object({
  key: z.string(),
  deleted: z.boolean()
});

export const storageRedisDeleteKeysRequestSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(200)
});

export const storageRedisDeleteKeysResponseSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      deleted: z.boolean()
    })
  )
});

export const storageRedisMaintenanceRequestSchema = z.object({
  key: z.string().min(1)
});

export const storageRedisMaintenanceResponseSchema = z.object({
  key: z.string(),
  changed: z.boolean()
});

export const storageRedisWorkspacePlacementStateSchema = z.enum([
  "unassigned",
  "active",
  "idle",
  "draining",
  "evicted"
]);

export const storageRedisWorkspacePlacementQuerySchema = z.object({
  workspaceId: z.string().optional(),
  ownerId: z.string().optional(),
  ownerWorkerId: z.string().optional(),
  state: storageRedisWorkspacePlacementStateSchema.optional()
});

export const storageRedisWorkspacePlacementSchema = z.object({
  workspaceId: z.string(),
  version: z.string(),
  ownerId: z.string().optional(),
  ownerWorkerId: z.string().optional(),
  ownerBaseUrl: z.string().optional(),
  preferredWorkerId: z.string().optional(),
  preferredWorkerReason: z.enum(["controller_target"]).optional(),
  state: storageRedisWorkspacePlacementStateSchema,
  sourceKind: z.enum(["object_store", "local_directory"]).optional(),
  localPath: z.string().optional(),
  remotePrefix: z.string().optional(),
  dirty: z.boolean().optional(),
  refCount: z.number().int().min(0).optional(),
  lastActivityAt: timestampSchema.optional(),
  materializedAt: timestampSchema.optional(),
  updatedAt: timestampSchema
});

export const storageRedisWorkspacePlacementPageSchema = z.object({
  items: z.array(storageRedisWorkspacePlacementSchema)
});

export const storageTableQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  serviceName: z.string().optional(),
  q: z.string().optional(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
  errorCode: z.string().optional(),
  recoveryState: z.string().optional()
});

export const storageRedisKeysQuerySchema = z.object({
  pattern: z.string().optional().default("oah:*"),
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(100)
});

export const storageRedisKeyQuerySchema = z.object({
  key: z.string().min(1)
});

export const storageRedisWorkerAffinityQuerySchema = z.object({
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  ownerId: z.string().optional(),
  ownerWorkerId: z.string().optional()
});

export const storageRedisWorkerAffinityReasonSchema = z.enum([
  "controller_target",
  "owner_worker",
  "same_session",
  "same_workspace",
  "same_owner",
  "healthy",
  "late",
  "idle_worker",
  "busy_worker",
  "starting_worker",
  "stopping_worker",
  "idle_slot_capacity",
  "slot_saturated"
]);

export const storageRedisWorkerAffinityCandidateSchema = z.object({
  workerId: z.string(),
  processKind: workerProcessKindSchema,
  state: workerStateSchema,
  health: workerHealthSchema,
  score: z.number(),
  slotCapacity: z.number().int().min(0).optional(),
  idleSlots: z.number().int().min(0).optional(),
  busySlots: z.number().int().min(0).optional(),
  matchingSessionSlots: z.number().int().min(0),
  matchingWorkspaceSlots: z.number().int().min(0),
  matchingOwnerWorkspaces: z.number().int().min(0),
  reasons: z.array(storageRedisWorkerAffinityReasonSchema)
});

export const storageRedisWorkerAffinitySchema = z.object({
  preferredWorkerId: z.string().optional(),
  controllerTargetWorkerId: z.string().optional(),
  sessionAffinityWorkerId: z.string().optional(),
  workspaceAffinityWorkerId: z.string().optional(),
  ownerAffinityWorkerId: z.string().optional(),
  ownerWorkerId: z.string().optional(),
  candidates: z.array(storageRedisWorkerAffinityCandidateSchema)
});

export type StorageRedisWorkerAffinity = z.infer<typeof storageRedisWorkerAffinitySchema>;

export type StoragePostgresTableName = z.infer<typeof storagePostgresTableNameSchema>;
export type StoragePostgresTableSummary = z.infer<typeof storagePostgresTableSummarySchema>;
export type StorageRedisKeySummary = z.infer<typeof storageRedisKeySummarySchema>;
export type StorageRedisQueueSummary = z.infer<typeof storageRedisQueueSummarySchema>;
export type StorageRedisLockSummary = z.infer<typeof storageRedisLockSummarySchema>;
export type StorageOverview = z.infer<typeof storageOverviewSchema>;
export type StorageOverviewQuery = z.infer<typeof storageOverviewQuerySchema>;
export type StoragePostgresTablePage = z.infer<typeof storagePostgresTablePageSchema>;
export type StorageRedisKeyPage = z.infer<typeof storageRedisKeyPageSchema>;
export type StorageRedisKeyDetail = z.infer<typeof storageRedisKeyDetailSchema>;
export type StorageRedisWorkspacePlacement = z.infer<typeof storageRedisWorkspacePlacementSchema>;
export type StorageRedisWorkspacePlacementPage = z.infer<typeof storageRedisWorkspacePlacementPageSchema>;
export type StorageRedisDeleteKeyResponse = z.infer<typeof storageRedisDeleteKeyResponseSchema>;
export type StorageRedisDeleteKeysRequest = z.infer<typeof storageRedisDeleteKeysRequestSchema>;
export type StorageRedisDeleteKeysResponse = z.infer<typeof storageRedisDeleteKeysResponseSchema>;
export type StorageRedisMaintenanceRequest = z.infer<typeof storageRedisMaintenanceRequestSchema>;
export type StorageRedisMaintenanceResponse = z.infer<typeof storageRedisMaintenanceResponseSchema>;
export type StorageTableQuery = z.infer<typeof storageTableQuerySchema>;
export type StorageRedisKeysQuery = z.infer<typeof storageRedisKeysQuerySchema>;
export type StorageRedisKeyQuery = z.infer<typeof storageRedisKeyQuerySchema>;
