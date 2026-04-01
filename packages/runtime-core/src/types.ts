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
  finishReason?: string | undefined;
  toolCalls: ModelToolCall[];
  toolResults: ModelToolResult[];
}

export interface ModelStreamOptions {
  signal?: AbortSignal | undefined;
  tools?: RuntimeToolSet | undefined;
  mcpServers?: McpServerDefinition[] | undefined;
  maxSteps?: number | undefined;
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
    mcp: string[];
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

export interface McpServerDefinition {
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
    order: Array<"base" | "llm_optimized" | "agent" | "actions" | "project_agents_md" | "skills">;
    includeEnvironment: boolean;
  };
}

export interface WorkspaceSettingsDefinition {
  defaultAgent?: string | undefined;
  skillDirs?: string[] | undefined;
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
  mcpServers: Record<string, McpServerDefinition>;
  hooks: Record<string, HookDefinition>;
  catalog: WorkspaceCatalog;
}

export interface WorkspaceInitializationResult {
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
  mcpServers: Record<string, McpServerDefinition>;
  hooks: Record<string, HookDefinition>;
  catalog: WorkspaceCatalog;
}

export interface WorkspaceInitializer {
  initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult>;
}

export interface RuntimeServiceOptions {
  defaultModel: string;
  modelGateway: ModelGateway;
  platformModels?: Record<string, ModelDefinition> | undefined;
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  workspaceInitializer?: WorkspaceInitializer | undefined;
}

export interface WorkspaceRepository {
  create(input: WorkspaceRecord): Promise<WorkspaceRecord>;
  upsert(input: WorkspaceRecord): Promise<WorkspaceRecord>;
  getById(id: string): Promise<WorkspaceRecord | null>;
}

export interface SessionRepository {
  create(input: Session): Promise<Session>;
  getById(id: string): Promise<Session | null>;
  update(input: Session): Promise<Session>;
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

export interface RunStepListResult {
  items: RunStep[];
  nextCursor?: string | undefined;
}

export function createEmptyCatalog(workspaceId: string, models: ModelCatalogItem[] = []): WorkspaceCatalog {
  return {
    workspaceId,
    agents: [],
    models,
    actions: [],
    skills: [],
    mcp: [],
    hooks: [],
    nativeTools: []
  };
}

export function withCatalogActions(catalog: WorkspaceCatalog, actions: ActionCatalogItem[]): WorkspaceCatalog {
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
