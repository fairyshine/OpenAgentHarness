import { z } from "zod";
import { timestampSchema, workspaceMemoryOverrideSchema } from "./common.js";
import { messagePageSchema } from "./messages.js";
import { runPageSchema, runStepPageSchema } from "./runs.js";

export const sessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  parentSessionId: z.string().optional(),
  subjectRef: z.string(),
  modelRef: z.string().optional(),
  agentName: z.string().optional(),
  activeAgentName: z.string(),
  workspaceMemory: workspaceMemoryOverrideSchema.optional(),
  title: z.string().optional(),
  status: z.enum(["active", "archived", "closed"]),
  lastRunAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const sessionPageSchema = z.object({
  items: z.array(sessionSchema),
  nextCursor: z.string().optional()
});

export const sessionQueuedRunSchema = z.object({
  runId: z.string(),
  messageId: z.string(),
  content: z.string(),
  createdAt: timestampSchema,
  position: z.number().int().min(1)
});

export const sessionQueueSchema = z.object({
  items: z.array(sessionQueuedRunSchema)
});

export const sessionSnapshotSchema = z.object({
  session: sessionSchema,
  messages: messagePageSchema,
  runs: runPageSchema,
  selectedRunId: z.string().optional(),
  selectedRunSteps: runStepPageSchema.optional(),
  queue: sessionQueueSchema
});

export const sessionCompactResultSchema = z.object({
  runId: z.string(),
  status: z.literal("completed"),
  compacted: z.boolean(),
  reason: z.enum(["insufficient_history", "summary_empty"]).optional(),
  boundaryMessageId: z.string().optional(),
  summaryMessageId: z.string().optional(),
  summarizedMessageCount: z.number().int().min(0).optional(),
  createdAt: timestampSchema,
  completedAt: timestampSchema
});

export const compactSessionRequestSchema = z.object({
  instructions: z.string().trim().min(1).max(8_000).optional()
});

export const createSessionRequestSchema = z.object({
  title: z.string().optional(),
  agentName: z.string().optional(),
  modelRef: z.string().trim().min(1).optional(),
  workspaceMemory: workspaceMemoryOverrideSchema.optional()
});

export const updateSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    activeAgentName: z.string().trim().min(1).optional(),
    modelRef: z.string().trim().min(1).nullable().optional(),
    workspaceMemory: workspaceMemoryOverrideSchema.nullable().optional()
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.activeAgentName !== undefined ||
      value.modelRef !== undefined ||
      value.workspaceMemory !== undefined,
    {
      message: "At least one session field must be provided."
    }
  );

export type Session = z.infer<typeof sessionSchema>;
export type SessionPage = z.infer<typeof sessionPageSchema>;
export type SessionQueuedRun = z.infer<typeof sessionQueuedRunSchema>;
export type SessionQueue = z.infer<typeof sessionQueueSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionCompactResult = z.infer<typeof sessionCompactResultSchema>;
export type CompactSessionRequest = z.infer<typeof compactSessionRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;
