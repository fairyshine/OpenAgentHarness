import { z } from "zod";

export const timestampSchema = z.string().datetime({ offset: true });
export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);
export const workspaceMemoryWritePolicySchema = z.enum(["explicit-only", "confirm-suggested", "auto-extract"]);
export const workspaceMemoryOverrideSchema = z.object({
  writePolicy: workspaceMemoryWritePolicySchema.optional()
});

export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: jsonObjectSchema.optional()
});

export const errorResponseSchema = z.object({
  error: errorSchema
});

export const pageQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional()
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;
