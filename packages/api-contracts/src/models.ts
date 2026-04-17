import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./common.js";
import { chatMessageSchema } from "./messages.js";

export const modelProviderSchema = z.object({
  id: z.enum(["openai", "openai-compatible"]),
  packageName: z.string(),
  description: z.string(),
  requiresUrl: z.boolean(),
  useCases: z.array(z.string())
});

export const modelProviderListSchema = z.object({
  items: z.array(modelProviderSchema)
});

export const platformModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  modelName: z.string(),
  url: z.string().optional(),
  hasKey: z.boolean(),
  metadata: jsonObjectSchema.optional(),
  isDefault: z.boolean()
});

export const platformModelListSchema = z.object({
  items: z.array(platformModelSchema)
});

export const platformModelSnapshotSchema = z.object({
  revision: z.number().int().min(0),
  items: z.array(platformModelSchema)
});

export const distributedPlatformModelRefreshTargetSchema = z.object({
  workerId: z.string(),
  runtimeInstanceId: z.string().optional(),
  ownerBaseUrl: z.string(),
  status: z.enum(["refreshed", "failed"]),
  snapshot: platformModelSnapshotSchema.optional(),
  error: z.string().optional()
});

export const distributedPlatformModelRefreshResultSchema = z.object({
  snapshot: platformModelSnapshotSchema,
  summary: z.object({
    attempted: z.number().int().min(0),
    succeeded: z.number().int().min(0),
    failed: z.number().int().min(0)
  }),
  targets: z.array(distributedPlatformModelRefreshTargetSchema)
});

export const usageSchema = z.object({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  totalTokens: z.number().int().min(0).optional()
});

export const modelGenerateRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    prompt: z.string().optional(),
    messages: z.array(chatMessageSchema).optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    maxTokens: z.number().int().min(1).optional()
  })
  .superRefine((value, ctx) => {
    if (!value.prompt && !value.messages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either prompt or messages is required."
      });
    }
  });

export const modelStreamRequestSchema = modelGenerateRequestSchema;

export const modelGenerateResponseSchema = z.object({
  model: z.string(),
  text: z.string(),
  content: z.array(jsonValueSchema).optional(),
  reasoning: z.array(jsonValueSchema).optional(),
  finishReason: z.string().optional(),
  usage: usageSchema.optional()
});

export type PlatformModel = z.infer<typeof platformModelSchema>;
export type PlatformModelList = z.infer<typeof platformModelListSchema>;
export type PlatformModelSnapshot = z.infer<typeof platformModelSnapshotSchema>;
export type DistributedPlatformModelRefreshTarget = z.infer<typeof distributedPlatformModelRefreshTargetSchema>;
export type DistributedPlatformModelRefreshResult = z.infer<typeof distributedPlatformModelRefreshResultSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type ModelGenerateRequest = z.infer<typeof modelGenerateRequestSchema>;
export type ModelStreamRequest = z.infer<typeof modelStreamRequestSchema>;
export type ModelGenerateResponse = z.infer<typeof modelGenerateResponseSchema>;
