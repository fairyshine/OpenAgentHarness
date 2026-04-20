import { z } from "zod";
import { jsonObjectSchema, timestampSchema } from "./common.js";

export const workspaceSchema = z.object({
  id: z.string(),
  externalRef: z.string().optional(),
  ownerId: z.string().optional(),
  name: z.string(),
  runtime: z.string().min(1).optional(),
  serviceName: z.string().optional(),
  rootPath: z.string(),
  executionPolicy: z.enum(["local", "container", "remote_runner"]),
  status: z.enum(["active", "archived", "disabled"]),
  kind: z.literal("project"),
  readOnly: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const workspacePageSchema = z.object({
  items: z.array(workspaceSchema),
  nextCursor: z.string().optional()
});

export const workspaceEntryTypeSchema = z.enum(["file", "directory"]);
export const workspaceFileEncodingSchema = z.enum(["utf8", "base64"]);
export const workspaceEntrySortBySchema = z.enum(["name", "updatedAt", "sizeBytes", "type"]);
export const sortOrderSchema = z.enum(["asc", "desc"]);

export const workspaceEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  type: workspaceEntryTypeSchema,
  sizeBytes: z.number().int().min(0).optional(),
  mimeType: z.string().optional(),
  etag: z.string().optional(),
  updatedAt: timestampSchema.optional(),
  createdAt: timestampSchema.optional(),
  readOnly: z.boolean()
});

export const workspaceEntryPageSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  items: z.array(workspaceEntrySchema),
  nextCursor: z.string().optional()
});

export const workspaceFileContentSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  encoding: workspaceFileEncodingSchema,
  content: z.string(),
  truncated: z.boolean(),
  sizeBytes: z.number().int().min(0).optional(),
  mimeType: z.string().optional(),
  etag: z.string().optional(),
  updatedAt: timestampSchema.optional(),
  readOnly: z.boolean()
});

export const workspaceDeleteResultSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  type: workspaceEntryTypeSchema,
  deleted: z.boolean()
});

export const workspaceSkillInputSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1)
});

export const createWorkspaceRequestSchema = z
  .object({
    externalRef: z.string().optional(),
    name: z.string().min(1),
    runtime: z.string().min(1),
    rootPath: z.string().min(1).optional(),
    ownerId: z.string().trim().min(1).optional(),
    serviceName: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-_]*[a-z0-9])?$/i, "serviceName may only contain letters, numbers, hyphen, and underscore.")
      .transform((value) => value.toLowerCase())
      .optional(),
    agentsMd: z.string().min(1).optional(),
    toolServers: z.record(z.string(), jsonObjectSchema).optional(),
    skills: z.array(workspaceSkillInputSchema).optional(),
    executionPolicy: z.enum(["local", "container", "remote_runner"]).default("local")
  });

export const putWorkspaceFileRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: workspaceFileEncodingSchema.default("utf8"),
  overwrite: z.boolean().default(true),
  ifMatch: z.string().optional()
});

export const createWorkspaceDirectoryRequestSchema = z.object({
  path: z.string().min(1),
  createParents: z.boolean().default(true)
});

export const moveWorkspaceEntryRequestSchema = z.object({
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
  overwrite: z.boolean().default(false)
});

export const workspaceEntriesQuerySchema = z.object({
  path: z.string().optional().default("."),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  sortBy: workspaceEntrySortBySchema.default("name"),
  sortOrder: sortOrderSchema.default("asc")
});

export const workspaceEntryPathQuerySchema = z.object({
  path: z.string().min(1)
});

export const workspaceDeleteEntryQuerySchema = z.object({
  path: z.string().min(1),
  recursive: z.coerce.boolean().default(false)
});

export const workspaceFileContentQuerySchema = z.object({
  path: z.string().min(1),
  encoding: workspaceFileEncodingSchema.default("utf8"),
  maxBytes: z.coerce.number().int().min(1).optional()
});

export const workspaceFileUploadQuerySchema = z.object({
  path: z.string().min(1),
  overwrite: z.coerce.boolean().default(true),
  ifMatch: z.string().optional()
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspacePage = z.infer<typeof workspacePageSchema>;
export type WorkspaceEntryType = z.infer<typeof workspaceEntryTypeSchema>;
export type WorkspaceFileEncoding = z.infer<typeof workspaceFileEncodingSchema>;
export type WorkspaceEntrySortBy = z.infer<typeof workspaceEntrySortBySchema>;
export type SortOrder = z.infer<typeof sortOrderSchema>;
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
export type WorkspaceEntryPage = z.infer<typeof workspaceEntryPageSchema>;
export type WorkspaceFileContent = z.infer<typeof workspaceFileContentSchema>;
export type WorkspaceDeleteResult = z.infer<typeof workspaceDeleteResultSchema>;
export type WorkspaceSkillInput = z.infer<typeof workspaceSkillInputSchema>;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;
export type PutWorkspaceFileRequest = z.infer<typeof putWorkspaceFileRequestSchema>;
export type CreateWorkspaceDirectoryRequest = z.infer<typeof createWorkspaceDirectoryRequestSchema>;
export type MoveWorkspaceEntryRequest = z.infer<typeof moveWorkspaceEntryRequestSchema>;
export type WorkspaceEntriesQuery = z.infer<typeof workspaceEntriesQuerySchema>;
export type WorkspaceEntryPathQuery = z.infer<typeof workspaceEntryPathQuerySchema>;
export type WorkspaceDeleteEntryQuery = z.infer<typeof workspaceDeleteEntryQuerySchema>;
export type WorkspaceFileContentQuery = z.infer<typeof workspaceFileContentQuerySchema>;
export type WorkspaceFileUploadQuery = z.infer<typeof workspaceFileUploadQuerySchema>;
