import type { Readable } from "node:stream";
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
  RuntimeLogEventData,
  Run,
  RunStep,
  Session,
  Workspace,
  WorkspaceCatalog
} from "@oah/api-contracts";
import type { ZodTypeAny } from "zod";
import { contentToPromptMessage } from "./runtime-message-content.js";
import type { RuntimeMessage } from "./runtime/runtime-messages.js";

export type RunStatus = Run["status"];
export type WorkspaceKind = "project";
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
  | "runtime.log"
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

export type { RuntimeLogEventData };

export interface RuntimeLogger {
  debug?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
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
  messages?: ChatMessage[] | undefined;
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
  topP?: number | undefined;
  maxTokens?: number | undefined;
  background?: boolean | undefined;
  hidden?: boolean | undefined;
  color?: string | undefined;
  tools: {
    native: string[];
    external: string[];
    /**
     * Deprecated compatibility fields. Prefer top-level `actions` / `skills`.
     */
    actions?: string[] | undefined;
    skills?: string[] | undefined;
  };
  actions?: string[] | undefined;
  skills?: string[] | undefined;
  disallowed?: {
    tools?: {
      native?: string[] | undefined;
      external?: string[] | undefined;
    } | undefined;
    actions?: string[] | undefined;
    skills?: string[] | undefined;
  } | undefined;
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
  workingDirectory?: string | undefined;
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
  blueprint?: string | undefined;
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
  toolServers: Record<string, ToolServerDefinition>;
  hooks: Record<string, HookDefinition>;
  catalog: RuntimeWorkspaceCatalog;
}

export interface WorkspaceInitializationResult {
  id?: string | undefined;
  rootPath: string;
  kind?: WorkspaceKind | undefined;
  readOnly?: boolean | undefined;
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

export interface WorkspaceExecutionLease {
  workspace: WorkspaceRecord;
  release(options?: { dirty?: boolean | undefined }): Promise<void> | void;
}

/**
 * Host-adapter seam for run execution.
 *
 * The current server bootstrap wires this to local workspace materialization,
 * but the same boundary can later be backed by a sandbox host implementation
 * such as a self-hosted sandbox pod or an E2B-backed adapter.
 */
export interface WorkspaceExecutionProvider {
  acquire(input: {
    workspace: WorkspaceRecord;
    run: Run;
    session?: Session | undefined;
  }): Promise<WorkspaceExecutionLease>;
}

export interface WorkspaceFileAccessLease {
  workspace: WorkspaceRecord;
  release(options?: { dirty?: boolean | undefined }): Promise<void> | void;
}

/**
 * Host-adapter seam for workspace file access.
 *
 * This keeps runtime-core independent from whether the live workspace copy is
 * provided by local disk, a self-hosted sandbox pod, or a future compatible
 * remote sandbox backend.
 */
export interface WorkspaceFileAccessProvider {
  acquire(input: {
    workspace: WorkspaceRecord;
    access: "read" | "write";
    path?: string | undefined;
  }): Promise<WorkspaceFileAccessLease>;
}

export type SandboxHostProviderKind = "self_hosted" | "e2b";

export interface SandboxHostDiagnostics {
  materialization?: Record<string, unknown> | undefined;
}

/**
 * Stable host-adapter boundary for worker execution environments.
 *
 * The first backend is the self-hosted materialization-backed worker host.
 * Future E2B-backed adapters should implement the same contract without
 * changing runtime-core's workspace ownership semantics.
 */
export interface SandboxHost {
  providerKind: SandboxHostProviderKind;
  workspaceCommandExecutor: WorkspaceCommandExecutor;
  workspaceFileSystem: WorkspaceFileSystem;
  workspaceExecutionProvider: WorkspaceExecutionProvider;
  workspaceFileAccessProvider: WorkspaceFileAccessProvider;
  diagnostics(): SandboxHostDiagnostics;
  maintain(options: { idleBefore: string }): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceForegroundCommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkspaceBackgroundCommandExecutionResult {
  outputPath: string;
  taskId: string;
  pid: number;
}

export interface WorkspaceFileStat {
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  ino?: number | bigint | undefined;
}

export interface WorkspaceFileSystemEntry {
  name: string;
  kind: "file" | "directory" | "other";
}

export interface WorkspaceFileSystem {
  realpath(targetPath: string): Promise<string>;
  stat(targetPath: string): Promise<WorkspaceFileStat>;
  readFile(targetPath: string): Promise<Buffer>;
  openReadStream(targetPath: string): Readable;
  readdir(targetPath: string): Promise<WorkspaceFileSystemEntry[]>;
  mkdir(targetPath: string, options?: { recursive?: boolean | undefined }): Promise<void>;
  writeFile(targetPath: string, data: Buffer): Promise<void>;
  rm(targetPath: string, options?: { recursive?: boolean | undefined; force?: boolean | undefined }): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
}

export interface WorkspaceCommandExecutor {
  runForeground(input: {
    workspace: WorkspaceRecord;
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runProcess(input: {
    workspace: WorkspaceRecord;
    executable: string;
    args: string[];
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runBackground(input: {
    workspace: WorkspaceRecord;
    command: string;
    sessionId: string;
    description?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<WorkspaceBackgroundCommandExecutionResult>;
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

export interface WorkspaceArchiveRecord {
  id: string;
  workspaceId: string;
  scopeType: "workspace" | "session";
  scopeId: string;
  archiveDate: string;
  archivedAt: string;
  deletedAt: string;
  timezone: string;
  exportedAt?: string | undefined;
  exportPath?: string | undefined;
  workspace: WorkspaceRecord;
  sessions: Session[];
  runs: Run[];
  messages: Message[];
  runtimeMessages: RuntimeMessage[];
  runSteps: RunStep[];
  toolCalls: ToolCallAuditRecord[];
  hookRuns: HookRunAuditRecord[];
  artifacts: ArtifactRecord[];
}

export interface WorkspaceArchiveRepository {
  archiveWorkspace(input: {
    workspace: WorkspaceRecord;
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord>;
  archiveSessionTree(input: {
    workspace: WorkspaceRecord;
    rootSessionId: string;
    sessionIds: string[];
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord>;
  listPendingArchiveDates(beforeArchiveDate: string, limit: number): Promise<string[]>;
  listByArchiveDate(archiveDate: string): Promise<WorkspaceArchiveRecord[]>;
  markExported(ids: string[], input: { exportedAt: string; exportPath: string }): Promise<void>;
  pruneExportedBefore(beforeArchiveDate: string, limit: number): Promise<number>;
}

export interface RuntimeServiceOptions {
  defaultModel: string;
  modelGateway: ModelGateway;
  logger?: RuntimeLogger | undefined;
  runHeartbeatIntervalMs?: number | undefined;
  staleRunRecovery?:
    | {
        strategy?: "fail" | "requeue_running" | "requeue_all" | undefined;
        maxAttempts?: number | undefined;
      }
    | undefined;
  platformModels?: Record<string, ModelDefinition> | undefined;
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runtimeMessageRepository?: RuntimeMessageRepository | undefined;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  runQueue?: RunQueue | undefined;
  toolCallAuditRepository?: ToolCallAuditRepository | undefined;
  hookRunAuditRepository?: HookRunAuditRepository | undefined;
  artifactRepository?: ArtifactRepository | undefined;
  historyEventRepository?: HistoryEventRepository | undefined;
  workspaceArchiveRepository?: WorkspaceArchiveRepository | undefined;
  workspaceDeletionHandler?: WorkspaceDeletionHandler | undefined;
  workspaceInitializer?: WorkspaceInitializer | undefined;
  workspaceExecutionProvider?: WorkspaceExecutionProvider | undefined;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  workspaceFileSystem?: WorkspaceFileSystem | undefined;
  workspaceCommandExecutor?: WorkspaceCommandExecutor | undefined;
}

export type RunQueuePriority = "normal" | "subagent";

export interface RunQueue {
  enqueue(
    sessionId: string,
    runId: string,
    options?: {
      priority?: RunQueuePriority | undefined;
      preferredWorkerId?: string | undefined;
    }
  ): Promise<void>;
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

export interface RuntimeMessageRepository {
  replaceBySessionId(sessionId: string, messages: RuntimeMessage[]): Promise<void>;
  listBySessionId(sessionId: string): Promise<RuntimeMessage[]>;
}

export interface RuntimeMessageListResult {
  items: RuntimeMessage[];
  nextCursor?: string | undefined;
}

export interface RunRepository {
  create(input: Run): Promise<Run>;
  getById(id: string): Promise<Run | null>;
  update(input: Run): Promise<Run>;
  listBySessionId(sessionId: string): Promise<Run[]>;
  listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]>;
}

export interface RunStepRepository {
  create(input: RunStep): Promise<RunStep>;
  update(input: RunStep): Promise<RunStep>;
  listByRunId(runId: string): Promise<RunStep[]>;
}

export interface SessionEventStore {
  append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent>;
  deleteById(eventId: string): Promise<void>;
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
  input?: unknown;
  triggerSource?: "api" | "user" | undefined;
}

export interface CancelRunResult {
  runId: string;
  status: "cancellation_requested";
}

export interface RequeueRunResult {
  runId: string;
  status: "queued";
  previousStatus: "failed" | "timed_out";
  source: "manual_requeue";
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

export interface RunListResult {
  items: Run[];
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

export function normalizeWorkspaceRecord(workspace: WorkspaceRecord): WorkspaceRecord {
  const rawKind = (workspace as { kind?: string }).kind;
  if (rawKind === "project") {
    return workspace;
  }

  return {
    ...workspace,
    kind: "project",
    readOnly: false,
    historyMirrorEnabled: true
  };
}

export function toPublicWorkspace(workspace: WorkspaceRecord): Workspace {
  const normalizedWorkspace = normalizeWorkspaceRecord(workspace);
  const blueprint =
    normalizedWorkspace.blueprint ??
    normalizedWorkspace.settings.blueprint;
  return {
    id: normalizedWorkspace.id,
    externalRef: normalizedWorkspace.externalRef,
    name: normalizedWorkspace.name,
    ...(blueprint ? { blueprint } : {}),
    ...(normalizedWorkspace.serviceName ? { serviceName: normalizedWorkspace.serviceName } : {}),
    rootPath: normalizedWorkspace.rootPath,
    executionPolicy: normalizedWorkspace.executionPolicy,
    status: normalizedWorkspace.status,
    kind: normalizedWorkspace.kind,
    readOnly: normalizedWorkspace.readOnly,
    createdAt: normalizedWorkspace.createdAt,
    updatedAt: normalizedWorkspace.updatedAt
  };
}

export function toChatMessages(messages: Message[]): ChatMessage[] {
  return messages.map((message) => contentToPromptMessage(message.role, message.content));
}
