import { z } from "zod";

export const workspaceRuntimeSchema = z.object({
  name: z.string()
});

export const platformAssetKindSchema = z.enum(["runtime", "model", "tool", "skill"]);

export const platformModelAssetSchema = z.object({
  id: z.string(),
  provider: z.string().optional(),
  modelName: z.string().optional(),
  url: z.string().optional()
});

export const platformToolAssetSchema = z.object({
  name: z.string(),
  transportType: z.enum(["stdio", "http"]).optional(),
  enabled: z.boolean().optional(),
  toolPrefix: z.string().optional()
});

export const platformSkillAssetSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposeToLlm: z.boolean().optional()
});

export const platformAssetListSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("runtime"),
    items: z.array(workspaceRuntimeSchema)
  }),
  z.object({
    kind: z.literal("model"),
    items: z.array(platformModelAssetSchema)
  }),
  z.object({
    kind: z.literal("tool"),
    items: z.array(platformToolAssetSchema)
  }),
  z.object({
    kind: z.literal("skill"),
    items: z.array(platformSkillAssetSchema)
  })
]);

export const platformAssetMutationResponseSchema = z.object({
  kind: platformAssetKindSchema,
  name: z.string()
});

export const platformAssetDetailSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model"),
    name: z.string(),
    yaml: z.string()
  }),
  z.object({
    kind: z.literal("tool"),
    name: z.string(),
    definition: z.record(z.string(), z.unknown()),
    serverFiles: z.record(z.string(), z.string()).optional()
  }),
  z.object({
    kind: z.literal("skill"),
    name: z.string(),
    skillMarkdown: z.string(),
    files: z.record(z.string(), z.string()).optional()
  })
]);

export const workspaceRuntimeListSchema = z.object({
  items: z.array(workspaceRuntimeSchema)
});

const booleanQuerySchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return value;
}, z.boolean());

export const uploadWorkspaceRuntimeRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/, "Runtime name must contain only alphanumeric characters, hyphens, and underscores"),
  overwrite: booleanQuerySchema.default(false)
});

export const uploadWorkspaceRuntimeResponseSchema = z.object({
  name: z.string()
});

export const updateWorkspaceRuntimeResponseSchema = z.object({
  name: z.string()
});

export const uploadPlatformAssetRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/, "Asset name must contain only alphanumeric characters, dots, hyphens, and underscores"),
  overwrite: booleanQuerySchema.default(false)
});

export type WorkspaceRuntime = z.infer<typeof workspaceRuntimeSchema>;
export type WorkspaceRuntimeList = z.infer<typeof workspaceRuntimeListSchema>;
export type PlatformAssetKind = z.infer<typeof platformAssetKindSchema>;
export type PlatformModelAsset = z.infer<typeof platformModelAssetSchema>;
export type PlatformToolAsset = z.infer<typeof platformToolAssetSchema>;
export type PlatformSkillAsset = z.infer<typeof platformSkillAssetSchema>;
export type PlatformAssetList = z.infer<typeof platformAssetListSchema>;
export type PlatformAssetDetail = z.infer<typeof platformAssetDetailSchema>;
export type PlatformAssetMutationResponse = z.infer<typeof platformAssetMutationResponseSchema>;
export type UploadWorkspaceRuntimeRequest = z.infer<typeof uploadWorkspaceRuntimeRequestSchema>;
export type UploadWorkspaceRuntimeResponse = z.infer<typeof uploadWorkspaceRuntimeResponseSchema>;
export type UpdateWorkspaceRuntimeResponse = z.infer<typeof updateWorkspaceRuntimeResponseSchema>;
export type UploadPlatformAssetRequest = z.infer<typeof uploadPlatformAssetRequestSchema>;

export type PlatformAssetRecord = WorkspaceRuntime | PlatformModelAsset | PlatformToolAsset | PlatformSkillAsset;
