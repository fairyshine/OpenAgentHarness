import { z } from "zod";
import { timestampSchema } from "./common.js";

export const sessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  parentSessionId: z.string().optional(),
  subjectRef: z.string(),
  modelRef: z.string().optional(),
  agentName: z.string().optional(),
  activeAgentName: z.string(),
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

export const createSessionRequestSchema = z.object({
  title: z.string().optional(),
  agentName: z.string().optional(),
  modelRef: z.string().trim().min(1).optional()
});

export const updateSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    activeAgentName: z.string().trim().min(1).optional(),
    modelRef: z.string().trim().min(1).nullable().optional()
  })
  .refine((value) => value.title !== undefined || value.activeAgentName !== undefined || value.modelRef !== undefined, {
    message: "At least one session field must be provided."
  });

export type Session = z.infer<typeof sessionSchema>;
export type SessionPage = z.infer<typeof sessionPageSchema>;
export type SessionQueuedRun = z.infer<typeof sessionQueuedRunSchema>;
export type SessionQueue = z.infer<typeof sessionQueueSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;
