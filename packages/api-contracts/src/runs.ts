import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema, timestampSchema } from "./common.js";

export const runSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string().optional(),
  parentRunId: z.string().optional(),
  initiatorRef: z.string().optional(),
  triggerType: z.enum(["message", "manual_action", "api_action", "hook", "system"]),
  triggerRef: z.string().optional(),
  agentName: z.string().optional(),
  effectiveAgentName: z.string(),
  switchCount: z.number().int().min(0).optional(),
  status: z.enum(["queued", "running", "waiting_tool", "completed", "failed", "cancelled", "timed_out"]),
  cancelRequestedAt: timestampSchema.optional(),
  startedAt: timestampSchema.optional(),
  heartbeatAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  metadata: jsonObjectSchema.optional()
});

export const runPageSchema = z.object({
  items: z.array(runSchema),
  nextCursor: z.string().optional()
});

export const runStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().min(1),
  stepType: z.enum(["model_call", "tool_call", "agent_switch", "agent_delegate", "hook", "system"]),
  name: z.string().optional(),
  agentName: z.string().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional()
});

export const runStepPageSchema = z.object({
  items: z.array(runStepSchema),
  nextCursor: z.string().optional()
});

export const cancelRunAcceptedSchema = z.object({
  runId: z.string(),
  status: z.literal("cancellation_requested")
});

export const guideQueuedRunAcceptedSchema = z.object({
  runId: z.string(),
  status: z.literal("interrupt_requested")
});

export const requeueRunAcceptedSchema = z.object({
  runId: z.string(),
  status: z.literal("queued"),
  previousStatus: z.enum(["failed", "timed_out"]),
  source: z.literal("manual_requeue")
});

export const batchRequeueRunsRequestSchema = z.object({
  runIds: z.array(z.string().min(1)).min(1).max(200)
});

export const batchRequeueRunsItemSchema = z.union([
  z.object({
    runId: z.string(),
    status: z.literal("queued"),
    previousStatus: z.enum(["failed", "timed_out"]),
    source: z.literal("manual_requeue")
  }),
  z.object({
    runId: z.string(),
    status: z.literal("error"),
    errorCode: z.string(),
    errorMessage: z.string()
  })
]);

export const batchRequeueRunsResponseSchema = z.object({
  items: z.array(batchRequeueRunsItemSchema)
});

export const createActionRunRequestSchema = z.object({
  sessionId: z.string().optional(),
  agentName: z.string().optional(),
  input: jsonValueSchema.optional(),
  triggerSource: z.enum(["api", "user"]).optional()
});

export const actionRunAcceptedSchema = z.object({
  runId: z.string(),
  status: z.literal("queued"),
  actionName: z.string(),
  sessionId: z.string().optional()
});

export const runEventsQuerySchema = z.object({
  runId: z.string().optional(),
  cursor: z.string().optional()
});

export type Run = z.infer<typeof runSchema>;
export type RunPage = z.infer<typeof runPageSchema>;
export type RunStep = z.infer<typeof runStepSchema>;
export type RunStepPage = z.infer<typeof runStepPageSchema>;
export type CancelRunAccepted = z.infer<typeof cancelRunAcceptedSchema>;
export type GuideQueuedRunAccepted = z.infer<typeof guideQueuedRunAcceptedSchema>;
export type RequeueRunAccepted = z.infer<typeof requeueRunAcceptedSchema>;
export type BatchRequeueRunsRequest = z.infer<typeof batchRequeueRunsRequestSchema>;
export type BatchRequeueRunsResponse = z.infer<typeof batchRequeueRunsResponseSchema>;
export type CreateActionRunRequest = z.infer<typeof createActionRunRequestSchema>;
export type ActionRunAccepted = z.infer<typeof actionRunAcceptedSchema>;
export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>;
