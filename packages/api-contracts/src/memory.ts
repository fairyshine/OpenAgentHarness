import { z } from "zod";

import { timestampSchema, workspaceMemoryWritePolicySchema } from "./common.js";

export const workspaceMemoryCorpusSchema = z.enum(["all", "index", "topics", "sessions", "daily", "dreams"]);

export const workspaceMemoryStatusSchema = z.object({
  workspaceId: z.string(),
  enabled: z.boolean(),
  writePolicy: workspaceMemoryWritePolicySchema,
  rootPath: z.literal(".openharness/memory"),
  rootExists: z.boolean(),
  indexExists: z.boolean(),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  topics: z.number().int().min(0),
  sessions: z.number().int().min(0),
  daily: z.number().int().min(0),
  dreams: z.number().int().min(0),
  pendingProposals: z.number().int().min(0)
});

export const workspaceMemoryFileSchema = z.object({
  path: z.string(),
  corpus: workspaceMemoryCorpusSchema,
  title: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  sizeBytes: z.number().int().min(0),
  updatedAt: timestampSchema
});

export const workspaceMemoryIndexSchema = z.object({
  workspaceId: z.string(),
  items: z.array(workspaceMemoryFileSchema)
});

export const workspaceMemorySearchQuerySchema = z.object({
  query: z.string().trim().min(1),
  corpus: workspaceMemoryCorpusSchema.default("all"),
  maxResults: z.coerce.number().int().min(1).max(50).default(10)
});

export const workspaceMemorySearchResultSchema = workspaceMemoryFileSchema.extend({
  score: z.number(),
  snippet: z.string().optional()
});

export const workspaceMemorySearchResponseSchema = z.object({
  workspaceId: z.string(),
  query: z.string(),
  corpus: workspaceMemoryCorpusSchema,
  items: z.array(workspaceMemorySearchResultSchema)
});

export const workspaceMemoryReadQuerySchema = z.object({
  path: z.string().min(1),
  from: z.coerce.number().int().positive().default(1),
  lines: z.coerce.number().int().positive().max(1000).default(200)
});

export const workspaceMemoryReadResponseSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  from: z.number().int().positive(),
  returnedLines: z.number().int().min(0),
  totalLines: z.number().int().min(0),
  truncated: z.boolean(),
  content: z.string()
});

export const workspaceMemoryProposalSchema = z.object({
  path: z.string(),
  status: z.string(),
  tool: z.string(),
  targetPath: z.string().optional(),
  createdAt: timestampSchema.optional(),
  summary: z.string().optional()
});

export const workspaceMemoryProposalPageSchema = z.object({
  workspaceId: z.string(),
  items: z.array(workspaceMemoryProposalSchema)
});

export const workspaceMemoryApplyProposalRequestSchema = z.object({
  path: z.string().min(1)
});

export const workspaceMemoryRejectProposalRequestSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1).max(220).optional()
});

export const workspaceMemoryProposalActionResultSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  status: z.enum(["applied", "rejected"]),
  output: z.string()
});

export type WorkspaceMemoryCorpus = z.infer<typeof workspaceMemoryCorpusSchema>;
export type WorkspaceMemoryStatus = z.infer<typeof workspaceMemoryStatusSchema>;
export type WorkspaceMemoryFile = z.infer<typeof workspaceMemoryFileSchema>;
export type WorkspaceMemoryIndex = z.infer<typeof workspaceMemoryIndexSchema>;
export type WorkspaceMemorySearchQuery = z.infer<typeof workspaceMemorySearchQuerySchema>;
export type WorkspaceMemorySearchResponse = z.infer<typeof workspaceMemorySearchResponseSchema>;
export type WorkspaceMemoryReadQuery = z.infer<typeof workspaceMemoryReadQuerySchema>;
export type WorkspaceMemoryReadResponse = z.infer<typeof workspaceMemoryReadResponseSchema>;
export type WorkspaceMemoryProposal = z.infer<typeof workspaceMemoryProposalSchema>;
export type WorkspaceMemoryProposalPage = z.infer<typeof workspaceMemoryProposalPageSchema>;
export type WorkspaceMemoryApplyProposalRequest = z.infer<typeof workspaceMemoryApplyProposalRequestSchema>;
export type WorkspaceMemoryRejectProposalRequest = z.infer<typeof workspaceMemoryRejectProposalRequestSchema>;
export type WorkspaceMemoryProposalActionResult = z.infer<typeof workspaceMemoryProposalActionResultSchema>;
