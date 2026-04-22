import { z } from "zod";
import { pageQuerySchema, jsonObjectSchema, jsonValueSchema, timestampSchema } from "./common.js";

export const textMessagePartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  providerOptions: jsonObjectSchema.optional()
});

export const imageMessagePartSchema = z.object({
  type: z.literal("image"),
  image: z.string(),
  mediaType: z.string().optional(),
  providerOptions: jsonObjectSchema.optional()
});

export const fileMessagePartSchema = z.object({
  type: z.literal("file"),
  data: z.string(),
  filename: z.string().optional(),
  mediaType: z.string(),
  providerOptions: jsonObjectSchema.optional()
});

export const reasoningMessagePartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  providerOptions: jsonObjectSchema.optional()
});

export const toolCallMessagePartSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: jsonValueSchema,
  providerOptions: jsonObjectSchema.optional(),
  providerExecuted: z.boolean().optional()
});

export const toolResultOutputSchema = z.union([
  z.object({
    type: z.literal("text"),
    value: z.string(),
    providerOptions: jsonObjectSchema.optional()
  }),
  z.object({
    type: z.literal("json"),
    value: jsonValueSchema,
    providerOptions: jsonObjectSchema.optional()
  }),
  z.object({
    type: z.literal("execution-denied"),
    reason: z.string().optional(),
    providerOptions: jsonObjectSchema.optional()
  }),
  z.object({
    type: z.literal("error-text"),
    value: z.string(),
    providerOptions: jsonObjectSchema.optional()
  }),
  z.object({
    type: z.literal("error-json"),
    value: jsonValueSchema,
    providerOptions: jsonObjectSchema.optional()
  }),
  z.object({
    type: z.literal("content"),
    value: z.array(
      z.union([
        z.object({
          type: z.literal("text"),
          text: z.string(),
          providerOptions: jsonObjectSchema.optional()
        }),
        z.object({
          type: z.literal("file-data"),
          data: z.string(),
          mediaType: z.string(),
          filename: z.string().optional(),
          providerOptions: jsonObjectSchema.optional()
        }),
        z.object({
          type: z.literal("file-url"),
          url: z.string(),
          providerOptions: jsonObjectSchema.optional()
        }),
        z.object({
          type: z.literal("file-id"),
          fileId: z.union([z.string(), z.record(z.string(), z.string())]),
          providerOptions: jsonObjectSchema.optional()
        }),
        z.object({
          type: z.literal("image-data"),
          data: z.string(),
          mediaType: z.string(),
          providerOptions: jsonObjectSchema.optional()
        }),
        z.object({
          type: z.literal("image-url"),
          url: z.string(),
          providerOptions: jsonObjectSchema.optional()
        }),
        z.object({
          type: z.literal("image-file-id"),
          fileId: z.union([z.string(), z.record(z.string(), z.string())]),
          providerOptions: jsonObjectSchema.optional()
        }),
        z.object({
          type: z.literal("custom"),
          providerOptions: jsonObjectSchema.optional()
        })
      ])
    )
  })
]);

export const toolResultMessagePartSchema = z.object({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  output: toolResultOutputSchema,
  providerOptions: jsonObjectSchema.optional()
});

export const toolApprovalRequestMessagePartSchema = z.object({
  type: z.literal("tool-approval-request"),
  approvalId: z.string(),
  toolCallId: z.string()
});

export const toolApprovalResponseMessagePartSchema = z.object({
  type: z.literal("tool-approval-response"),
  approvalId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
  providerExecuted: z.boolean().optional()
});

export const messagePartSchema = z.union([
  textMessagePartSchema,
  imageMessagePartSchema,
  fileMessagePartSchema,
  reasoningMessagePartSchema,
  toolCallMessagePartSchema,
  toolResultMessagePartSchema,
  toolApprovalRequestMessagePartSchema,
  toolApprovalResponseMessagePartSchema
]);

export const systemMessageContentSchema = z.string();
export const userMessageContentSchema = z.union([
  z.string(),
  z.array(z.union([textMessagePartSchema, imageMessagePartSchema, fileMessagePartSchema]))
]);
export const assistantMessageContentSchema = z.union([
  z.string(),
  z.array(
    z.union([
      textMessagePartSchema,
      fileMessagePartSchema,
      reasoningMessagePartSchema,
      toolCallMessagePartSchema,
      toolResultMessagePartSchema,
      toolApprovalRequestMessagePartSchema
    ])
  )
]);
export const toolMessageContentSchema = z.array(z.union([toolResultMessagePartSchema, toolApprovalResponseMessagePartSchema]));
export const messageContentSchema = z.union([
  systemMessageContentSchema,
  userMessageContentSchema,
  assistantMessageContentSchema,
  toolMessageContentSchema
]);

export const systemChatMessageSchema = z.object({
  role: z.literal("system"),
  content: systemMessageContentSchema
});

export const userChatMessageSchema = z.object({
  role: z.literal("user"),
  content: userMessageContentSchema
});

export const assistantChatMessageSchema = z.object({
  role: z.literal("assistant"),
  content: assistantMessageContentSchema
});

export const toolChatMessageSchema = z.object({
  role: z.literal("tool"),
  content: toolMessageContentSchema
});

export const messageSchema = z.intersection(
  z.object({
    id: z.string(),
    sessionId: z.string(),
    runId: z.string().optional(),
    metadata: jsonObjectSchema.optional(),
    createdAt: timestampSchema
  }),
  z.union([systemChatMessageSchema, userChatMessageSchema, assistantChatMessageSchema, toolChatMessageSchema])
);

export const messagePageSchema = z.object({
  items: z.array(messageSchema),
  nextCursor: z.string().optional()
});

export const messageListQuerySchema = pageQuerySchema.extend({
  direction: z.enum(["forward", "backward"]).default("forward")
});

export const chatMessageSchema = z.union([
  systemChatMessageSchema,
  userChatMessageSchema,
  assistantChatMessageSchema,
  toolChatMessageSchema
]);

export const createMessageRequestSchema = z.object({
  content: z.string().min(1),
  metadata: jsonObjectSchema.optional(),
  runningRunBehavior: z.enum(["queue", "interrupt"]).optional()
});

export const messageAcceptedSchema = z.object({
  messageId: z.string(),
  runId: z.string(),
  status: z.literal("queued"),
  delivery: z.enum(["active_run", "session_queue"]).optional(),
  queuedPosition: z.number().int().min(1).optional(),
  createdAt: timestampSchema.optional()
});

export type Message = z.infer<typeof messageSchema>;
export type MessagePage = z.infer<typeof messagePageSchema>;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;
export type MessagePart = z.infer<typeof messagePartSchema>;
export type MessageContent = z.infer<typeof messageContentSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
export type MessageAccepted = z.infer<typeof messageAcceptedSchema>;
