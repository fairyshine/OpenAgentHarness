import { z } from "zod";

export const timestampSchema = z.string().datetime({ offset: true });
export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

export const workspaceSchema = z.object({
  id: z.string(),
  externalRef: z.string().optional(),
  name: z.string(),
  template: z.string().min(1).optional(),
  rootPath: z.string(),
  executionPolicy: z.enum(["local", "container", "remote_runner"]),
  status: z.enum(["active", "archived", "disabled"]),
  kind: z.enum(["project", "chat"]),
  readOnly: z.boolean(),
  historyMirrorEnabled: z.boolean(),
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

export const workspaceHistoryMirrorStatusSchema = z.object({
  workspaceId: z.string(),
  supported: z.boolean(),
  enabled: z.boolean(),
  dbPath: z.string().optional(),
  state: z.enum(["unsupported", "disabled", "missing", "idle", "error"]),
  lastEventId: z.number().int().optional(),
  lastSyncedAt: timestampSchema.optional(),
  errorMessage: z.string().optional()
});

export const agentCatalogItemSchema = z.object({
  name: z.string(),
  mode: z.enum(["primary", "subagent", "all"]),
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

export const actionRetryPolicySchema = z.enum(["manual", "safe"]);

export const actionCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposeToLlm: z.boolean().optional(),
  callableByUser: z.boolean().optional(),
  callableByApi: z.boolean().optional(),
  retryPolicy: actionRetryPolicySchema.optional()
});

export const skillCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposeToLlm: z.boolean().optional()
});

export const toolCatalogItemSchema = z.object({
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
  tools: z.array(toolCatalogItemSchema).optional(),
  hooks: z.array(hookCatalogItemSchema),
  nativeTools: z.array(z.string()),
  runtimeTools: z.array(z.string()).optional()
});

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

export const runSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string().optional(),
  parentRunId: z.string().optional(),
  initiatorRef: z.string().optional(),
  triggerType: z.enum(["message", "manual_action", "api_action", "hook", "system"]),
  triggerRef: z.string().optional(),
  agentName: z.string().optional(),
  effectiveAgentName: z.string(),
  switchCount: z.number().int().min(0).optional(),
  status: z.enum(["queued", "running", "waiting_tool", "completed", "failed", "cancelled", "timed_out"]),
  cancelRequestedAt: timestampSchema.optional(),
  startedAt: timestampSchema.optional(),
  heartbeatAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  metadata: jsonObjectSchema.optional()
});

export const runPageSchema = z.object({
  items: z.array(runSchema),
  nextCursor: z.string().optional()
});

export const runStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().min(1),
  stepType: z.enum(["model_call", "tool_call", "agent_switch", "agent_delegate", "hook", "system"]),
  name: z.string().optional(),
  agentName: z.string().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
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

export const storagePostgresTableNameSchema = z.enum([
  "workspaces",
  "sessions",
  "runs",
  "messages",
  "run_steps",
  "session_events",
  "tool_calls",
  "hook_runs",
  "artifacts",
  "history_events"
]);

export const storagePostgresTableSummarySchema = z.object({
  name: storagePostgresTableNameSchema,
  rowCount: z.number().int().min(0),
  orderBy: z.string(),
  description: z.string()
});

export const storageRedisKeySummarySchema = z.object({
  key: z.string(),
  type: z.string(),
  ttlMs: z.number().int().optional(),
  size: z.number().int().min(0).optional()
});

export const storageRedisQueueSummarySchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  length: z.number().int().min(0)
});

export const storageRedisLockSummarySchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  ttlMs: z.number().int().optional(),
  owner: z.string().optional()
});

export const storageOverviewSchema = z.object({
  postgres: z.object({
    configured: z.boolean(),
    available: z.boolean(),
    primaryStorage: z.boolean(),
    database: z.string().optional(),
    tables: z.array(storagePostgresTableSummarySchema)
  }),
  redis: z.object({
    configured: z.boolean(),
    available: z.boolean(),
    keyPrefix: z.string(),
    eventBusEnabled: z.boolean(),
    runQueueEnabled: z.boolean(),
    dbSize: z.number().int().min(0).optional(),
    readyQueue: z
      .object({
        key: z.string(),
        length: z.number().int().min(0)
      })
      .optional(),
    sessionQueues: z.array(storageRedisQueueSummarySchema),
    sessionLocks: z.array(storageRedisLockSummarySchema),
    eventBuffers: z.array(storageRedisQueueSummarySchema)
  })
});

export const storagePostgresTablePageSchema = z.object({
  table: storagePostgresTableNameSchema,
  rowCount: z.number().int().min(0),
  orderBy: z.string(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(200),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), jsonValueSchema)),
  appliedFilters: z
    .object({
      q: z.string().optional(),
      workspaceId: z.string().optional(),
      sessionId: z.string().optional(),
      runId: z.string().optional()
    })
    .optional(),
  nextOffset: z.number().int().min(0).optional()
});

export const storageRedisKeyPageSchema = z.object({
  pattern: z.string(),
  items: z.array(storageRedisKeySummarySchema),
  nextCursor: z.string().optional()
});

export const storageRedisKeyDetailSchema = z.object({
  key: z.string(),
  type: z.string(),
  ttlMs: z.number().int().optional(),
  size: z.number().int().min(0).optional(),
  value: jsonValueSchema.optional()
});

export const storageRedisDeleteKeyResponseSchema = z.object({
  key: z.string(),
  deleted: z.boolean()
});

export const storageRedisDeleteKeysRequestSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(200)
});

export const storageRedisDeleteKeysResponseSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      deleted: z.boolean()
    })
  )
});

export const storageRedisMaintenanceRequestSchema = z.object({
  key: z.string().min(1)
});

export const storageRedisMaintenanceResponseSchema = z.object({
  key: z.string(),
  changed: z.boolean()
});

export const createWorkspaceRequestSchema = z.object({
  externalRef: z.string().optional(),
  name: z.string().min(1),
  template: z.string().min(1),
  rootPath: z.string().min(1).optional(),
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

export const chatMessageSchema = z.union([
  systemChatMessageSchema,
  userChatMessageSchema,
  assistantChatMessageSchema,
  toolChatMessageSchema
]);

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

export const runEventsQuerySchema = z.object({
  runId: z.string().optional(),
  cursor: z.string().optional()
});

export const storageTableQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().optional(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional()
});

export const storageRedisKeysQuerySchema = z.object({
  pattern: z.string().optional().default("oah:*"),
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(100)
});

export const storageRedisKeyQuerySchema = z.object({
  key: z.string().min(1)
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
    "hook.notice",
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
export type WorkspacePage = z.infer<typeof workspacePageSchema>;
export type WorkspaceEntryType = z.infer<typeof workspaceEntryTypeSchema>;
export type WorkspaceFileEncoding = z.infer<typeof workspaceFileEncodingSchema>;
export type WorkspaceEntrySortBy = z.infer<typeof workspaceEntrySortBySchema>;
export type SortOrder = z.infer<typeof sortOrderSchema>;
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
export type WorkspaceEntryPage = z.infer<typeof workspaceEntryPageSchema>;
export type WorkspaceFileContent = z.infer<typeof workspaceFileContentSchema>;
export type WorkspaceDeleteResult = z.infer<typeof workspaceDeleteResultSchema>;
export type WorkspaceHistoryMirrorStatus = z.infer<typeof workspaceHistoryMirrorStatusSchema>;
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
export type AgentCatalogItem = z.infer<typeof agentCatalogItemSchema>;
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;
export type ActionRetryPolicy = z.infer<typeof actionRetryPolicySchema>;
export type ActionCatalogItem = z.infer<typeof actionCatalogItemSchema>;
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
export type ToolCatalogItem = z.infer<typeof toolCatalogItemSchema>;
export type HookCatalogItem = z.infer<typeof hookCatalogItemSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionPage = z.infer<typeof sessionPageSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessagePage = z.infer<typeof messagePageSchema>;
export type MessagePart = z.infer<typeof messagePartSchema>;
export type MessageContent = z.infer<typeof messageContentSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunPage = z.infer<typeof runPageSchema>;
export type RunStep = z.infer<typeof runStepSchema>;
export type RunStepPage = z.infer<typeof runStepPageSchema>;
export type WorkspaceTemplate = z.infer<typeof workspaceTemplateSchema>;
export type WorkspaceTemplateList = z.infer<typeof workspaceTemplateListSchema>;
export type PlatformModel = z.infer<typeof platformModelSchema>;
export type PlatformModelList = z.infer<typeof platformModelListSchema>;
export type StoragePostgresTableName = z.infer<typeof storagePostgresTableNameSchema>;
export type StoragePostgresTableSummary = z.infer<typeof storagePostgresTableSummarySchema>;
export type StorageRedisKeySummary = z.infer<typeof storageRedisKeySummarySchema>;
export type StorageRedisQueueSummary = z.infer<typeof storageRedisQueueSummarySchema>;
export type StorageRedisLockSummary = z.infer<typeof storageRedisLockSummarySchema>;
export type StorageOverview = z.infer<typeof storageOverviewSchema>;
export type StoragePostgresTablePage = z.infer<typeof storagePostgresTablePageSchema>;
export type StorageRedisKeyPage = z.infer<typeof storageRedisKeyPageSchema>;
export type StorageRedisKeyDetail = z.infer<typeof storageRedisKeyDetailSchema>;
export type StorageRedisDeleteKeyResponse = z.infer<typeof storageRedisDeleteKeyResponseSchema>;
export type StorageRedisDeleteKeysRequest = z.infer<typeof storageRedisDeleteKeysRequestSchema>;
export type StorageRedisDeleteKeysResponse = z.infer<typeof storageRedisDeleteKeysResponseSchema>;
export type StorageRedisMaintenanceRequest = z.infer<typeof storageRedisMaintenanceRequestSchema>;
export type StorageRedisMaintenanceResponse = z.infer<typeof storageRedisMaintenanceResponseSchema>;
export type WorkspaceSkillInput = z.infer<typeof workspaceSkillInputSchema>;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;
export type PutWorkspaceFileRequest = z.infer<typeof putWorkspaceFileRequestSchema>;
export type CreateWorkspaceDirectoryRequest = z.infer<typeof createWorkspaceDirectoryRequestSchema>;
export type MoveWorkspaceEntryRequest = z.infer<typeof moveWorkspaceEntryRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;
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
export type WorkspaceEntriesQuery = z.infer<typeof workspaceEntriesQuerySchema>;
export type WorkspaceEntryPathQuery = z.infer<typeof workspaceEntryPathQuerySchema>;
export type WorkspaceDeleteEntryQuery = z.infer<typeof workspaceDeleteEntryQuerySchema>;
export type WorkspaceFileContentQuery = z.infer<typeof workspaceFileContentQuerySchema>;
export type WorkspaceFileUploadQuery = z.infer<typeof workspaceFileUploadQuerySchema>;
export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>;
export type StorageTableQuery = z.infer<typeof storageTableQuerySchema>;
export type StorageRedisKeysQuery = z.infer<typeof storageRedisKeysQuerySchema>;
export type StorageRedisKeyQuery = z.infer<typeof storageRedisKeyQuerySchema>;
export type SessionEventContract = z.infer<typeof sessionEventSchema>;
