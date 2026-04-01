import { z } from "zod";

export const timestampSchema = z.string().datetime({ offset: true });
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const workspaceSchema = z.object({
  id: z.string(),
  externalRef: z.string().optional(),
  name: z.string(),
  rootPath: z.string(),
  executionPolicy: z.enum(["local", "container", "remote_runner"]),
  status: z.enum(["active", "archived", "disabled"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const agentCatalogItemSchema = z.object({
  name: z.string(),
  source: z.enum(["platform", "workspace"]),
  description: z.string().optional()
});

export const modelCatalogItemSchema = z.object({
  ref: z.string().regex(/^(platform|workspace)\/.+$/),
  name: z.string(),
  source: z.enum(["platform", "workspace"]),
  provider: z.string(),
  modelName: z.string().optional(),
  url: z.string().optional()
});

export const actionCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposeToLlm: z.boolean().optional(),
  callableByUser: z.boolean().optional(),
  callableByApi: z.boolean().optional()
});

export const skillCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposeToLlm: z.boolean().optional()
});

export const mcpCatalogItemSchema = z.object({
  name: z.string(),
  transportType: z.string().optional(),
  toolPrefix: z.string().optional()
});

export const hookCatalogItemSchema = z.object({
  name: z.string(),
  matcher: z.string().optional(),
  handlerType: z.enum(["command", "http", "prompt", "agent"]).optional(),
  events: z.array(z.string()).optional()
});

export const workspaceCatalogSchema = z.object({
  workspaceId: z.string(),
  agents: z.array(agentCatalogItemSchema),
  models: z.array(modelCatalogItemSchema),
  actions: z.array(actionCatalogItemSchema),
  skills: z.array(skillCatalogItemSchema),
  mcp: z.array(mcpCatalogItemSchema),
  hooks: z.array(hookCatalogItemSchema),
  nativeTools: z.array(z.string())
});

export const sessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  subjectRef: z.string(),
  agentName: z.string().optional(),
  activeAgentName: z.string(),
  title: z.string().optional(),
  status: z.enum(["active", "archived", "closed"]),
  lastRunAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const messageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  metadata: jsonObjectSchema.optional(),
  createdAt: timestampSchema
});

export const messagePageSchema = z.object({
  items: z.array(messageSchema),
  nextCursor: z.string().optional()
});

export const runSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string().optional(),
  initiatorRef: z.string().optional(),
  triggerType: z.enum(["message", "manual_action", "api_action", "hook", "system"]),
  triggerRef: z.string().optional(),
  agentName: z.string().optional(),
  effectiveAgentName: z.string(),
  switchCount: z.number().int().min(0).optional(),
  status: z.enum(["queued", "running", "waiting_tool", "completed", "failed", "cancelled", "timed_out"]),
  cancelRequestedAt: timestampSchema.optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  metadata: jsonObjectSchema.optional()
});

export const runStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().min(1),
  stepType: z.enum(["model_call", "tool_call", "agent_switch", "agent_delegate", "hook", "system"]),
  name: z.string().optional(),
  agentName: z.string().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  input: jsonObjectSchema.optional(),
  output: jsonObjectSchema.optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional()
});

export const runStepPageSchema = z.object({
  items: z.array(runStepSchema),
  nextCursor: z.string().optional()
});

export const workspaceSkillInputSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1)
});

export const workspaceTemplateSchema = z.object({
  name: z.string()
});

export const workspaceTemplateListSchema = z.object({
  items: z.array(workspaceTemplateSchema)
});

export const createWorkspaceRequestSchema = z.object({
  externalRef: z.string().optional(),
  name: z.string().min(1),
  template: z.string().min(1),
  rootPath: z.string().min(1).optional(),
  agentsMd: z.string().min(1).optional(),
  mcpServers: z.record(z.string(), jsonObjectSchema).optional(),
  skills: z.array(workspaceSkillInputSchema).optional(),
  executionPolicy: z.enum(["local", "container", "remote_runner"]).default("local")
});

export const createSessionRequestSchema = z.object({
  title: z.string().optional(),
  agentName: z.string().optional()
});

export const createMessageRequestSchema = z.object({
  content: z.string().min(1),
  metadata: jsonObjectSchema.optional()
});

export const messageAcceptedSchema = z.object({
  messageId: z.string(),
  runId: z.string(),
  status: z.literal("queued")
});

export const cancelRunAcceptedSchema = z.object({
  runId: z.string(),
  status: z.literal("cancellation_requested")
});

export const createActionRunRequestSchema = z.object({
  sessionId: z.string().optional(),
  agentName: z.string().optional(),
  input: z.union([jsonObjectSchema, z.null()]).optional()
});

export const actionRunAcceptedSchema = z.object({
  runId: z.string(),
  status: z.literal("queued"),
  actionName: z.string(),
  sessionId: z.string().optional()
});

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string()
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
  finishReason: z.string().optional(),
  usage: usageSchema.optional()
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

export const runEventsQuerySchema = z.object({
  runId: z.string().optional(),
  cursor: z.string().optional()
});

export const sessionEventSchema = z.object({
  id: z.string(),
  cursor: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  event: z.enum([
    "run.queued",
    "run.started",
    "message.delta",
    "message.completed",
    "agent.switch.requested",
    "agent.switched",
    "agent.delegate.started",
    "agent.delegate.completed",
    "agent.delegate.failed",
    "tool.started",
    "tool.completed",
    "tool.failed",
    "run.completed",
    "run.failed",
    "run.cancelled"
  ]),
  data: jsonObjectSchema,
  createdAt: timestampSchema
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
export type AgentCatalogItem = z.infer<typeof agentCatalogItemSchema>;
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;
export type ActionCatalogItem = z.infer<typeof actionCatalogItemSchema>;
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
export type McpCatalogItem = z.infer<typeof mcpCatalogItemSchema>;
export type HookCatalogItem = z.infer<typeof hookCatalogItemSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessagePage = z.infer<typeof messagePageSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunStep = z.infer<typeof runStepSchema>;
export type RunStepPage = z.infer<typeof runStepPageSchema>;
export type WorkspaceTemplate = z.infer<typeof workspaceTemplateSchema>;
export type WorkspaceTemplateList = z.infer<typeof workspaceTemplateListSchema>;
export type WorkspaceSkillInput = z.infer<typeof workspaceSkillInputSchema>;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
export type MessageAccepted = z.infer<typeof messageAcceptedSchema>;
export type CancelRunAccepted = z.infer<typeof cancelRunAcceptedSchema>;
export type CreateActionRunRequest = z.infer<typeof createActionRunRequestSchema>;
export type ActionRunAccepted = z.infer<typeof actionRunAcceptedSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type ModelGenerateRequest = z.infer<typeof modelGenerateRequestSchema>;
export type ModelStreamRequest = z.infer<typeof modelStreamRequestSchema>;
export type ModelGenerateResponse = z.infer<typeof modelGenerateResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;
export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>;
export type SessionEventContract = z.infer<typeof sessionEventSchema>;
