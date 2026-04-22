import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema, timestampSchema } from "./common.js";

export const engineLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const engineLogCategorySchema = z.enum(["run", "model", "tool", "hook", "agent", "http", "system"]);
export const engineLogEventContextSchema = z.object({
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  stepId: z.string().optional(),
  toolCallId: z.string().optional(),
  agentName: z.string().optional()
});
export const engineLogEventDataSchema = z.object({
  level: engineLogLevelSchema,
  category: engineLogCategorySchema,
  message: z.string(),
  details: z.union([jsonValueSchema, z.string()]).optional(),
  context: engineLogEventContextSchema.optional(),
  source: z.enum(["server", "web"]),
  timestamp: timestampSchema
});

export const sessionEventSchema = z.object({
  id: z.string(),
  cursor: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  event: z.enum([
    "run.queued",
    "queue.updated",
    "run.started",
    "message.delta",
    "message.completed",
    "agent.switch.requested",
    "agent.switched",
    "agent.delegate.started",
    "agent.delegate.completed",
    "agent.delegate.failed",
    "hook.notice",
    "tool.started",
    "tool.completed",
    "tool.failed",
    "engine.log",
    "run.completed",
    "run.failed",
    "run.cancelled"
  ]),
  data: jsonObjectSchema,
  createdAt: timestampSchema
});

export type EngineLogLevel = z.infer<typeof engineLogLevelSchema>;
export type EngineLogCategory = z.infer<typeof engineLogCategorySchema>;
export type EngineLogEventContext = z.infer<typeof engineLogEventContextSchema>;
export type EngineLogEventData = z.infer<typeof engineLogEventDataSchema>;
export type SessionEventContract = z.infer<typeof sessionEventSchema>;
