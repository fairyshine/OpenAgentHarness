import type {
  ActionCatalogItem,
  ChatMessage,
  CreateMessageRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  Message,
  ModelCatalogItem,
  ModelGenerateRequest,
  ModelGenerateResponse,
  Run,
  RunStep,
  Session,
  Workspace,
  WorkspaceCatalog
} from "@oah/api-contracts";
import type { ZodTypeAny } from "zod";

export type RunStatus = Run["status"];
export type WorkspaceKind = "project" | "chat";
export type AgentMode = "primary" | "subagent" | "all";
export type RunStepType = RunStep["stepType"];
export type RunStepStatus = RunStep["status"];
export type ActionRetryPolicy = "manual" | "safe";
export type RuntimeWorkspaceCatalog = WorkspaceCatalog;
export type SessionEventName =
  | "run.queued"
  | "run.started"
  | "message.delta"
  | "message.completed"
  | "agent.switch.requested"
  | "agent.switched"
  | "agent.delegate.started"
  | "agent.delegate.completed"
  | "agent.delegate.failed"
  | "hook.notice"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface CallerContext {
  subjectRef: string;
  authSource: string;
  scopes: string[];
  workspaceAccess: string[];
}

export interface SessionEvent {
  id: string;
  cursor: string;
  sessionId: string;
  runId?: string;
  event: SessionEventName;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ModelDefinition {
  provider: string;
  key?: string;
  url?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface GenerateModelInput extends ModelGenerateRequest {
  modelDefinition?: ModelDefinition | undefined;
}

export interface RuntimeToolExecutionContext {
  abortSignal?: AbortSignal | undefined;
  toolCallId?: string | undefined;
}

export interface RuntimeToolDefinition {
  description: string;
  inputSchema: ZodTypeAny;
  retryPolicy?: ActionRetryPolicy | undefined;
  execute(input: unknown, context: RuntimeToolExecutionContext): Promise<unknown> | unknown;
}

export type RuntimeToolSet = Record<string, RuntimeToolDefinition>;

export interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ModelToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
}

export interface ModelStepResult {
  stepType?: string | undefined;
  text?: string | undefined;
  content?: unknown[] | undefined;
  reasoning?: unknown[] | undefined;
  usage?: Record<string, unknown> | undefined;
  warnings?: unknown[] | undefined;
  request?: Record<string, unknown> | undefined;
  response?: Record<string, unknown> | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
  finishReason?: string | undefined;
  toolCalls: ModelToolCall[];
  toolResults: ModelToolResult[];
}

export interface ModelStreamOptions {
  signal?: AbortSignal | undefined;
  tools?: RuntimeToolSet | undefined;
  toolServers?: ToolServerDefinition[] | undefined;
  maxSteps?: number | undefined;
  parallelToolCalls?: boolean | undefined;
  prepareStep?:
    | ((stepNumber: number) => Promise<ModelStepPreparation | undefined> | ModelStepPreparation | undefined)
    | undefined;
  onToolCallStart?: ((toolCall: ModelToolCall) => Promise<void> | void) | undefined;
  onToolCallFinish?: ((toolResult: ModelToolResult) => Promise<void> | void) | undefined;
  onStepFinish?: ((step: ModelStepResult) => Promise<void> | void) | undefined;
}

export interface ModelStepPreparation {
  model?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
  systemMessages?: Array<{ role: "system"; content: string }> | undefined;
  activeToolNames?: string[] | undefined;
}

export interface StreamedModelResponse {
  readonly chunks: AsyncIterable<string>;
  readonly completed: Promise<ModelGenerateResponse>;
}

export interface AgentDefinition {
  name: string;
  mode: AgentMode;
  description?: string | undefined;
  prompt: string;
  systemReminder?: string | undefined;
  modelRef?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  tools: {
    native: string[];
    actions: string[];
    skills: string[];
    external: string[];
  };
  switch: string[];
  subagents: string[];
  policy?: {
    maxSteps?: number | undefined;
    runTimeoutSeconds?: number | undefined;
    toolTimeoutSeconds?: number | undefined;
    parallelToolCalls?: boolean | undefined;
    maxConcurrentSubagents?: number | undefined;
  } | undefined;
}

export interface ActionDefinition {
  name: string;
  description: string;
  callableByApi: boolean;
  callableByUser: boolean;
  exposeToLlm: boolean;
  retryPolicy?: ActionRetryPolicy | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  directory: string;
  entry: {
    command: string;
    environment?: Record<string, string> | undefined;
    cwd?: string | undefined;
    timeoutSeconds?: number | undefined;
  };
}

export interface SkillDefinition {
  name: string;
  description?: string | undefined;
  exposeToLlm: boolean;
  directory: string;
  sourceRoot: string;
  content: string;
}

export interface ToolServerDefinition {
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  toolPrefix?: string | undefined;
  command?: string | undefined;
  url?: string | undefined;
  environment?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  timeout?: number | undefined;
  oauth?: boolean | Record<string, unknown> | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

export interface HookDefinition {
  name: string;
  events: string[];
  matcher?: string | undefined;
  handlerType: "command" | "http" | "prompt" | "agent";
  capabilities: string[];
  definition: Record<string, unknown>;
}

export interface WorkspaceSystemPromptSettings {
  base?: {
    content: string;
  } | undefined;
  llmOptimized?: {
    providers?: Record<string, { content: string }> | undefined;
    models?: Record<string, { content: string }> | undefined;
  } | undefined;
  compose: {
    order: Array<
      | "base"
      | "llm_optimized"
      | "agent"
      | "actions"
      | "project_agents_md"
      | "skills"
      | "agent_switches"
      | "subagents"
      | "environment"
    >;
    includeEnvironment: boolean;
  };
}

export interface WorkspaceSettingsDefinition {
  defaultAgent?: string | undefined;
  skillDirs?: string[] | undefined;
  historyMirrorEnabled?: boolean | undefined;
  systemPrompt?: WorkspaceSystemPromptSettings | undefined;
}

export interface ModelGateway {
  generate(input: GenerateModelInput, options?: { signal?: AbortSignal }): Promise<ModelGenerateResponse>;
  stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse>;
}

export interface WorkspaceRecord extends Workspace {
  kind: WorkspaceKind;
  readOnly: boolean;
  historyMirrorEnabled: boolean;
  defaultAgent?: string | undefined;
  projectAgentsMd?: string | undefined;
  settings: WorkspaceSettingsDefinition;
  workspaceModels: Record<string, ModelDefinition>;
  agents: Record<string, AgentDefinition>;
  actions: Record<string, ActionDefinition>;
  skills: Record<string, SkillDefinition>;
  toolServers: Record<string, ToolServerDefinition>;
  hooks: Record<string, HookDefinition>;
  catalog: RuntimeWorkspaceCatalog;
}

export interface WorkspaceInitializationResult {
  id?: string | undefined;
  rootPath: string;
  kind?: WorkspaceKind | undefined;
  readOnly?: boolean | undefined;
  historyMirrorEnabled?: boolean | undefined;
  defaultAgent?: string | undefined;
  projectAgentsMd?: string | undefined;
  settings: WorkspaceSettingsDefinition;
  workspaceModels: Record<string, ModelDefinition>;
  agents: Record<string, AgentDefinition>;
  actions: Record<string, ActionDefinition>;
  skills: Record<string, SkillDefinition>;
  toolServers: Record<string, ToolServerDefinition>;
  hooks: Record<string, HookDefinition>;
  catalog: RuntimeWorkspaceCatalog;
}

export interface WorkspaceInitializer {
  initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult>;
}

export interface WorkspaceDeletionHandler {
  deleteWorkspace(workspace: WorkspaceRecord): Promise<void>;
}

export interface WorkspaceSettingsManager {
  updateHistoryMirrorEnabled(workspace: WorkspaceRecord, enabled: boolean): Promise<WorkspaceRecord>;
}

export type ToolCallSourceType = "action" | "skill" | "agent" | "tool" | "native";

export interface ToolCallAuditRecord {
  id: string;
  runId: string;
  stepId?: string | undefined;
  sourceType: ToolCallSourceType;
  toolName: string;
  request?: Record<string, unknown> | undefined;
  response?: Record<string, unknown> | undefined;
  status: "completed" | "failed" | "cancelled";
  durationMs?: number | undefined;
  startedAt: string;
  endedAt: string;
}

export interface HookRunAuditRecord {
  id: string;
  runId: string;
  hookName: string;
  eventName: string;
  capabilities: string[];
  patch?: Record<string, unknown> | undefined;
  status: "completed" | "failed";
  startedAt: string;
  endedAt: string;
  errorMessage?: string | undefined;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  type: string;
  path?: string | undefined;
  contentRef?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export type HistoryEventEntityType =
  | "session"
  | "message"
  | "run"
  | "run_step"
  | "tool_call"
  | "hook_run"
  | "artifact";

export type HistoryEventOperation = "upsert" | "delete" | "replace";

export interface HistoryEventRecord {
  id: number;
  workspaceId: string;
  entityType: HistoryEventEntityType;
  entityId: string;
  op: HistoryEventOperation;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface ToolCallAuditRepository {
  create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord>;
}

export interface HookRunAuditRepository {
  create(input: HookRunAuditRecord): Promise<HookRunAuditRecord>;
}

export interface ArtifactRepository {
  create(input: ArtifactRecord): Promise<ArtifactRecord>;
  listByRunId(runId: string): Promise<ArtifactRecord[]>;
}

export interface HistoryEventRepository {
  append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord>;
  listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]>;
}

export interface RuntimeServiceOptions {
  defaultModel: string;
  modelGateway: ModelGateway;
  runHeartbeatIntervalMs?: number | undefined;
  platformModels?: Record<string, ModelDefinition> | undefined;
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  runQueue?: RunQueue | undefined;
  toolCallAuditRepository?: ToolCallAuditRepository | undefined;
  hookRunAuditRepository?: HookRunAuditRepository | undefined;
  artifactRepository?: ArtifactRepository | undefined;
  historyEventRepository?: HistoryEventRepository | undefined;
  workspaceDeletionHandler?: WorkspaceDeletionHandler | undefined;
  workspaceSettingsManager?: WorkspaceSettingsManager | undefined;
  workspaceInitializer?: WorkspaceInitializer | undefined;
}

export interface RunQueue {
  enqueue(sessionId: string, runId: string): Promise<void>;
}

export interface WorkspaceRepository {
  create(input: WorkspaceRecord): Promise<WorkspaceRecord>;
  upsert(input: WorkspaceRecord): Promise<WorkspaceRecord>;
  getById(id: string): Promise<WorkspaceRecord | null>;
  list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]>;
  delete(id: string): Promise<void>;
}

export interface SessionRepository {
  create(input: Session): Promise<Session>;
  getById(id: string): Promise<Session | null>;
  update(input: Session): Promise<Session>;
  listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]>;
  delete(id: string): Promise<void>;
}

export interface MessageRepository {
  create(input: Message): Promise<Message>;
  getById(id: string): Promise<Message | null>;
  update(input: Message): Promise<Message>;
  listBySessionId(sessionId: string): Promise<Message[]>;
}

export interface RunRepository {
  create(input: Run): Promise<Run>;
  getById(id: string): Promise<Run | null>;
  update(input: Run): Promise<Run>;
  listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]>;
}

export interface RunStepRepository {
  create(input: RunStep): Promise<RunStep>;
  update(input: RunStep): Promise<RunStep>;
  listByRunId(runId: string): Promise<RunStep[]>;
}

export interface SessionEventStore {
  append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent>;
  listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]>;
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void;
}

export interface CreateWorkspaceParams {
  input: CreateWorkspaceRequest;
}

export interface CreateSessionParams {
  workspaceId: string;
  caller: CallerContext;
  input: CreateSessionRequest;
}

export interface UpdateSessionParams {
  sessionId: string;
  input: import("@oah/api-contracts").UpdateSessionRequest;
}

export interface CreateSessionMessageParams {
  sessionId: string;
  caller: CallerContext;
  input: CreateMessageRequest;
}

export interface TriggerActionRunParams {
  workspaceId: string;
  caller: CallerContext;
  actionName: string;
  sessionId?: string | undefined;
  agentName?: string | undefined;
  input?: Record<string, unknown> | null | undefined;
}

export interface CancelRunResult {
  runId: string;
  status: "cancellation_requested";
}

export interface ActionRunAcceptedResult {
  runId: string;
  status: "queued";
  actionName: string;
  sessionId?: string | undefined;
}

export interface MessageListResult {
  items: Message[];
  nextCursor?: string | undefined;
}

export interface WorkspaceListResult {
  items: Workspace[];
  nextCursor?: string | undefined;
}

export interface SessionListResult {
  items: Session[];
  nextCursor?: string | undefined;
}

export interface RunStepListResult {
  items: RunStep[];
  nextCursor?: string | undefined;
}

export function createEmptyCatalog(workspaceId: string, models: ModelCatalogItem[] = []): RuntimeWorkspaceCatalog {
  return {
    workspaceId,
    agents: [],
    models,
    actions: [],
    skills: [],
    tools: [],
    hooks: [],
    nativeTools: [],
    runtimeTools: []
  };
}

export function withCatalogActions(catalog: RuntimeWorkspaceCatalog, actions: ActionCatalogItem[]): RuntimeWorkspaceCatalog {
  return {
    ...catalog,
    actions
  };
}

export function toPublicWorkspace(workspace: WorkspaceRecord): Workspace {
  return {
    id: workspace.id,
    externalRef: workspace.externalRef,
    name: workspace.name,
    rootPath: workspace.rootPath,
    executionPolicy: workspace.executionPolicy,
    status: workspace.status,
    kind: workspace.kind,
    readOnly: workspace.readOnly,
    historyMirrorEnabled: workspace.historyMirrorEnabled,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt
  };
}

export function toChatMessages(messages: Message[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}
