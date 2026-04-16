import { useEffect, useState } from "react";

import type {
  ErrorResponse,
  HealthReport,
  Message,
  MessageContent,
  ReadinessReport,
  RuntimeLogCategory,
  RuntimeLogEventData,
  RuntimeLogLevel,
  Run,
  RunStep,
  SessionEventContract,
  StoragePostgresTableName,
  Workspace
} from "@oah/api-contracts";

interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

interface WorkspaceDraft {
  name: string;
  blueprint?: string;
  rootPath: string;
  ownerId: string;
  serviceName: string;
}

interface SavedWorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  blueprint?: string;
  serviceName?: string;
  status: Workspace["status"];
  createdAt?: string;
  lastOpenedAt: string;
}

interface SavedSessionRecord {
  id: string;
  workspaceId: string;
  parentSessionId?: string | undefined;
  title?: string | undefined;
  modelRef?: string | undefined;
  agentName?: string | undefined;
  lastRunAt?: string | undefined;
  createdAt: string;
  lastOpenedAt: string;
}

interface ModelDraft {
  model: string;
  prompt: string;
}

interface ModelProviderRecord {
  id: "openai" | "openai-compatible";
  packageName: string;
  description: string;
  requiresUrl: boolean;
  useCases: string[];
}

interface PlatformModelRecord {
  id: string;
  provider: string;
  modelName: string;
  url?: string;
  hasKey: boolean;
  metadata?: Record<string, unknown>;
  isDefault: boolean;
}

interface SseFrame {
  cursor?: string;
  event: string;
  data: Record<string, unknown>;
}

type HealthReportResponse = HealthReport;
type ReadinessReportResponse = ReadinessReport;

interface ModelProviderListResponse {
  items: ModelProviderRecord[];
}

interface PlatformModelListResponse {
  items: PlatformModelRecord[];
}

interface PlatformModelSnapshotResponse {
  revision: number;
  items: PlatformModelRecord[];
}

type InspectorTab = "overview" | "timeline" | "workspace";
type MainViewMode = "conversation" | "inspector";
type SurfaceMode = "runtime" | "storage" | "provider";
type StorageBrowserTab = "postgres" | "redis";
type ServiceScope = string;
type ConsoleFilter = "all" | "errors" | "runs" | "tools" | "hooks" | "model" | "system";
type MessageParts = Extract<Message["content"], unknown[]>;
type MessagePart = MessageParts[number];
type SystemMessageContent = Extract<Message, { role: "system" }>["content"];
type UserMessageContent = Extract<Message, { role: "user" }>["content"];
type AssistantMessageContent = Extract<Message, { role: "assistant" }>["content"];
type ToolMessageContent = Extract<Message, { role: "tool" }>["content"];
type AgentMode = "primary" | "subagent" | "all";
type StatusSemanticTone = "sky" | "emerald" | "rose" | "amber" | "plum";

interface ModelCallTraceMessage {
  role: Message["role"];
  content: Message["content"];
}

interface MessageAgentSnapshot {
  name?: string;
  mode?: AgentMode;
}

interface LiveConversationMessageRecord {
  persistedMessageId?: string;
  toolCallId?: string;
  runId: string;
  sessionId: string;
  role?: "assistant" | "tool";
  content: Message["content"];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface ModelCallTraceToolCall {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

interface ModelCallTraceToolResult {
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
}

interface ModelCallTraceToolServer {
  name: string;
  transportType?: string;
  toolPrefix?: string;
  timeout?: number;
  include?: string[];
  exclude?: string[];
}

interface ModelCallTraceRuntimeTool {
  name: string;
  description?: string;
  retryPolicy?: string;
  inputSchema?: unknown;
}

interface ModelCallTraceInput {
  model?: string;
  canonicalModelRef?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  messageCount?: number;
  activeToolNames: string[];
  runtimeToolNames: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  toolServers: ModelCallTraceToolServer[];
  messages: ModelCallTraceMessage[];
}

interface ModelCallTraceOutput {
  stepType?: string;
  text?: string;
  content?: unknown[];
  reasoning?: unknown[];
  usage?: Record<string, unknown>;
  warnings?: unknown[];
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  finishReason?: string;
  toolCallsCount?: number;
  toolResultsCount?: number;
  toolCalls: ModelCallTraceToolCall[];
  toolResults: ModelCallTraceToolResult[];
  errorMessage?: string;
}

interface ModelCallTrace {
  id: string;
  seq: number;
  name?: string;
  agentName?: string;
  status: RunStep["status"];
  startedAt?: string;
  endedAt?: string;
  input: ModelCallTraceInput;
  output: ModelCallTraceOutput;
  rawInput: unknown;
  rawOutput: unknown;
}

interface AppRequestErrorSummary {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  statusCode?: number;
  statusText?: string;
  timestamp?: string;
}

interface RuntimeConsoleEntry {
  id: string;
  timestamp: string;
  level: RuntimeLogLevel;
  category: RuntimeLogCategory;
  message: string;
  details?: unknown;
  source: "server" | "web";
  eventId?: string;
  eventName?: SessionEventContract["event"];
  runId?: string;
  cursor?: string;
  stepId?: string;
}

const storagePostgresTables: StoragePostgresTableName[] = [
  "workspaces",
  "sessions",
  "runs",
  "messages",
  "run_steps",
  "session_events",
  "tool_calls",
  "hook_runs",
  "artifacts",
  "history_events",
  "archives"
];

function storageTablePreviewLimit(table: StoragePostgresTableName) {
  switch (table) {
    case "session_events":
    case "run_steps":
      return 20;
    case "messages":
    case "tool_calls":
    case "hook_runs":
    case "archives":
      return 25;
    default:
      return 50;
  }
}

const SERVICE_SCOPE_ALL = "__all__";
const SERVICE_SCOPE_DEFAULT = "__default__";

const storageKeys = {
  connection: "oah.web.connection",
  workspaceDraft: "oah.web.workspaceDraft",
  workspaceBlueprintFilter: "oah.web.workspaceBlueprintFilter",
  serviceScope: "oah.web.serviceScope",
  sessionDraft: "oah.web.sessionDraft",
  modelDraft: "oah.web.modelDraft",
  workspaceId: "oah.web.workspaceId",
  sessionId: "oah.web.sessionId",
  recentWorkspaces: "oah.web.recentWorkspaces",
  recentSessions: "oah.web.recentSessions",
  expandedWorkspaces: "oah.web.expandedWorkspaces",
  expandedSessions: "oah.web.expandedSessions"
} as const;

function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }

    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return initialValue;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function normalizeBaseUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/\/+$/u, "");
}

function buildUrl(baseUrl: string, path: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}${path}` : path;
}

function normalizeServiceName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === SERVICE_SCOPE_ALL || normalized === SERVICE_SCOPE_DEFAULT) {
    return undefined;
  }

  return normalized;
}

function normalizeServiceScope(value: string | undefined): ServiceScope {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === SERVICE_SCOPE_ALL) {
    return SERVICE_SCOPE_ALL;
  }

  if (trimmed === SERVICE_SCOPE_DEFAULT) {
    return SERVICE_SCOPE_DEFAULT;
  }

  return normalizeServiceName(trimmed) ?? SERVICE_SCOPE_ALL;
}

function serviceScopeMatches(scope: string, serviceName: string | undefined): boolean {
  const normalizedScope = normalizeServiceScope(scope);
  if (normalizedScope === SERVICE_SCOPE_ALL) {
    return true;
  }

  if (normalizedScope === SERVICE_SCOPE_DEFAULT) {
    return !normalizeServiceName(serviceName);
  }

  return normalizeServiceName(serviceName) === normalizedScope;
}

function serviceScopeLabel(scope: string): string {
  const normalizedScope = normalizeServiceScope(scope);
  if (normalizedScope === SERVICE_SCOPE_ALL) {
    return "All Services";
  }

  if (normalizedScope === SERVICE_SCOPE_DEFAULT) {
    return "Default (OAH)";
  }

  return normalizedScope;
}

function toStorageServiceNameParam(scope: string): string | undefined {
  const normalizedScope = normalizeServiceScope(scope);
  if (normalizedScope === SERVICE_SCOPE_ALL) {
    return undefined;
  }

  if (normalizedScope === SERVICE_SCOPE_DEFAULT) {
    return "@default";
  }

  return normalizedScope;
}

function buildAuthHeaders(connection: ConnectionSettings, extraHeaders?: HeadersInit): Headers {
  const headers = new Headers(extraHeaders);
  const token = connection.token.trim();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) {
    return undefined as T;
  }

  return JSON.parse(raw) as T;
}

class HttpRequestError extends Error {
  readonly code?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly statusCode: number;
  readonly statusText: string;

  constructor(input: {
    message: string;
    statusCode: number;
    statusText: string;
    code?: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "HttpRequestError";
    this.code = input.code;
    this.details = input.details;
    this.statusCode = input.statusCode;
    this.statusText = input.statusText;
  }
}

async function createHttpRequestError(response: Response): Promise<HttpRequestError> {
  const body = await readJsonResponse<ErrorResponse>(response).catch(() => undefined);
  return new HttpRequestError({
    message: body?.error?.message ?? `${response.status} ${response.statusText}`,
    statusCode: response.status,
    statusText: response.statusText,
    ...(body?.error?.code ? { code: body.error.code } : {}),
    ...(body?.error?.details ? { details: body.error.details } : {})
  });
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error instanceof HttpRequestError && error.code) {
      return `${error.code}: ${error.message}`;
    }

    return error.message;
  }

  return String(error);
}

function toErrorSummary(error: unknown): AppRequestErrorSummary | null {
  if (error instanceof HttpRequestError) {
    return {
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
      statusCode: error.statusCode,
      statusText: error.statusText,
      timestamp: new Date().toISOString()
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      timestamp: new Date().toISOString()
    };
  }

  if (typeof error === "string") {
    return {
      message: error,
      timestamp: new Date().toISOString()
    };
  }

  return null;
}

function isNotFoundError(error: unknown) {
  const message = toErrorMessage(error);
  return message.startsWith("404 ") || message.toLowerCase().includes("not found");
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeFileSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function pathLeaf(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/g, "");
  if (!normalized) {
    return "";
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function downloadJsonFile(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadCsvFile(filename: string, columns: string[], rows: Array<Record<string, unknown>>) {
  const escapeCsv = (value: unknown) => {
    const text =
      typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
    return `"${text.replaceAll('"', '""')}"`;
  };

  const csv = [columns.map(escapeCsv).join(","), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))].join("\n");
  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function isAgentMode(value: unknown): value is AgentMode {
  return value === "primary" || value === "subagent" || value === "all";
}

function readMessageAgentSnapshot(message: Pick<Message, "metadata">): MessageAgentSnapshot | null {
  if (!message.metadata || !isRecord(message.metadata)) {
    return null;
  }

  const metadata = message.metadata;
  const name =
    typeof metadata.agentName === "string" && metadata.agentName.trim()
      ? metadata.agentName
      : typeof metadata.effectiveAgentName === "string" && metadata.effectiveAgentName.trim()
        ? metadata.effectiveAgentName
        : undefined;
  const mode = isAgentMode(metadata.agentMode) ? metadata.agentMode : undefined;

  if (!name && !mode) {
    return null;
  }

  return {
    ...(name ? { name } : {}),
    ...(mode ? { mode } : {})
  };
}

function readMessageSystemPromptSnapshot(message: Pick<Message, "metadata">): ModelCallTraceMessage[] {
  if (!message.metadata || !isRecord(message.metadata) || !Array.isArray(message.metadata.systemMessages)) {
    return [];
  }

  return message.metadata.systemMessages.flatMap((entry) => {
    if (
      isRecord(entry) &&
      entry.role === "system" &&
      typeof entry.content === "string"
    ) {
      return [
        {
          role: "system" as const,
          content: entry.content
        }
      ];
    }

    return [];
  });
}

function readMessageModelCallStepRef(message: Pick<Message, "metadata">): { stepId?: string; stepSeq?: number } | null {
  if (!message.metadata || !isRecord(message.metadata)) {
    return null;
  }

  const stepId =
    typeof message.metadata.modelCallStepId === "string" && message.metadata.modelCallStepId.trim()
      ? message.metadata.modelCallStepId
      : undefined;
  const stepSeq =
    typeof message.metadata.modelCallStepSeq === "number" && Number.isInteger(message.metadata.modelCallStepSeq)
      ? message.metadata.modelCallStepSeq
      : undefined;

  if (!stepId && stepSeq === undefined) {
    return null;
  }

  return {
    ...(stepId ? { stepId } : {}),
    ...(stepSeq !== undefined ? { stepSeq } : {})
  };
}

function isMessagePart(value: unknown): value is MessagePart {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.image === "string";
    case "file":
      return typeof value.data === "string" && typeof value.mediaType === "string";
    case "reasoning":
      return typeof value.text === "string";
    case "tool-call":
      return typeof value.toolCallId === "string" && typeof value.toolName === "string";
    case "tool-result":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        isRecord(value.output) &&
        typeof value.output.type === "string"
      );
    case "tool-approval-request":
      return typeof value.approvalId === "string" && typeof value.toolCallId === "string";
    case "tool-approval-response":
      return typeof value.approvalId === "string" && typeof value.approved === "boolean";
    default:
      return false;
  }
}

function normalizeMessageContent(value: unknown): MessageContent | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.every((entry) => isMessagePart(entry))) {
    return value as MessageContent;
  }

  return null;
}

function contentMatchesRole(role: Message["role"], content: MessageContent): boolean {
  if (role === "system") {
    return typeof content === "string";
  }

  if (role === "user") {
    return (
      typeof content === "string" ||
      (Array.isArray(content) && content.every((part) => part.type === "text" || part.type === "image" || part.type === "file"))
    );
  }

  if (role === "assistant") {
    return (
      typeof content === "string" ||
      (Array.isArray(content) &&
        content.every(
          (part) =>
            part.type === "text" ||
            part.type === "file" ||
            part.type === "reasoning" ||
            part.type === "tool-call" ||
            part.type === "tool-result" ||
            part.type === "tool-approval-request"
        ))
    );
  }

  return (
    Array.isArray(content) &&
    content.every((part) => part.type === "tool-result" || part.type === "tool-approval-response")
  );
}

function buildMessageRecord(input: {
  id: string;
  sessionId: string;
  role: Message["role"];
  content: MessageContent;
  runId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}): Message | null {
  if (!contentMatchesRole(input.role, input.content)) {
    return null;
  }

  const base = {
    id: input.id,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: input.createdAt
  };

  switch (input.role) {
    case "system":
      return {
        ...base,
        role: "system",
        content: input.content as SystemMessageContent
      };
    case "user":
      return {
        ...base,
        role: "user",
        content: input.content as UserMessageContent
      };
    case "assistant":
      return {
        ...base,
        role: "assistant",
        content: input.content as AssistantMessageContent
      };
    case "tool":
      return {
        ...base,
        role: "tool",
        content: input.content as ToolMessageContent
      };
  }
}

function contentParts(content: Message["content"]): MessagePart[] {
  return Array.isArray(content) ? content : [];
}

function contentText(content: Message["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return [part.text];
      }

      if (
        part.type === "tool-result" &&
        isRecord(part.output) &&
        (part.output.type === "text" || part.output.type === "error-text") &&
        typeof part.output.value === "string"
      ) {
        return [part.output.value];
      }

      return [];
    })
    .join("\n\n");
}

function contentToolRefs(content: Message["content"]) {
  return contentParts(content).flatMap((part) => {
    if (part.type === "tool-call" || part.type === "tool-result") {
      return [
        {
          type: part.type,
          toolName: part.toolName,
          toolCallId: part.toolCallId
        }
      ];
    }

    return [];
  });
}

function contentPreview(content: Message["content"], limit = 120) {
  const text = contentText(content).trim();
  if (text.length > 0) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  const refs = contentToolRefs(content);
  if (refs.length > 0) {
    return refs
      .map((ref) => `${ref.type}:${ref.toolName}`)
      .join(" · ");
  }

  return prettyJson(content);
}

function hasDisplayableRunMessages(messages: Message[], runId: string) {
  return messages.some((message) => {
    if (message.runId !== runId) {
      return false;
    }

    return contentText(message.content).trim().length > 0 || contentToolRefs(message.content).length > 0;
  });
}

function storageMessageFromRow(row: Record<string, unknown>): Message | null {
  const role = row.role;
  const content = normalizeMessageContent(row.content);
  const id = row.id;
  const sessionId = row.session_id;
  const createdAt = row.created_at;
  if (
    typeof id !== "string" ||
    typeof sessionId !== "string" ||
    typeof createdAt !== "string" ||
    !["system", "user", "assistant", "tool"].includes(String(role)) ||
    content === null
  ) {
    return null;
  }

  return buildMessageRecord({
    id,
    sessionId,
    role: role as Message["role"],
    content,
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
    ...(isRecord(row.metadata) ? { metadata: row.metadata } : {}),
    createdAt
  });
}

function storageRunStepFromRow(row: Record<string, unknown>): RunStep | null {
  if (
    typeof row.id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.seq !== "number" ||
    typeof row.step_type !== "string" ||
    typeof row.status !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    stepType: row.step_type as RunStep["stepType"],
    status: row.status as RunStep["status"],
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.agent_name === "string" ? { agentName: row.agent_name } : {}),
    ...("input" in row ? { input: row.input } : {}),
    ...("output" in row ? { output: row.output } : {}),
    ...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
    ...(typeof row.ended_at === "string" ? { endedAt: row.ended_at } : {})
  };
}

function storageSessionEventFromRow(row: Record<string, unknown>): SessionEventContract | null {
  if (
    typeof row.id !== "string" ||
    typeof row.cursor !== "number" ||
    typeof row.session_id !== "string" ||
    typeof row.event !== "string" ||
    !isRecord(row.data) ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    cursor: String(row.cursor),
    sessionId: row.session_id,
    event: row.event as SessionEventContract["event"],
    data: row.data,
    createdAt: row.created_at,
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {})
  };
}

interface StorageToolCallRecord {
  id: string;
  runId: string;
  stepId?: string;
  sourceType: string;
  toolName: string;
  request?: unknown;
  response?: unknown;
  status: string;
  durationMs?: number;
  startedAt: string;
  endedAt: string;
}

function storageToolCallFromRow(row: Record<string, unknown>): StorageToolCallRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.source_type !== "string" ||
    typeof row.tool_name !== "string" ||
    typeof row.status !== "string" ||
    typeof row.started_at !== "string" ||
    typeof row.ended_at !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    sourceType: row.source_type,
    toolName: row.tool_name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(typeof row.step_id === "string" ? { stepId: row.step_id } : {}),
    ...("request" in row ? { request: row.request } : {}),
    ...("response" in row ? { response: row.response } : {}),
    ...(typeof row.duration_ms === "number" ? { durationMs: row.duration_ms } : {})
  };
}

function readModelCallTraceMessages(value: unknown): ModelCallTraceMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const role = entry.role;
    const content = normalizeMessageContent(entry.content);
    if (!["system", "user", "assistant", "tool"].includes(String(role)) || content === null) {
      return [];
    }

    return [
      {
        role: role as Message["role"],
        content
      }
    ];
  });
}

function readModelCallTraceToolServers(value: unknown): ModelCallTraceToolServer[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return [];
    }

    return [
      {
        name: entry.name,
        ...(typeof entry.transportType === "string" ? { transportType: entry.transportType } : {}),
        ...(typeof entry.toolPrefix === "string" ? { toolPrefix: entry.toolPrefix } : {}),
        ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
        ...(Array.isArray(entry.include) ? { include: readStringArray(entry.include) } : {}),
        ...(Array.isArray(entry.exclude) ? { exclude: readStringArray(entry.exclude) } : {})
      }
    ];
  });
}

function readModelCallTraceRuntimeTools(value: unknown): ModelCallTraceRuntimeTool[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return [];
    }

    return [
      {
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.retryPolicy === "string" ? { retryPolicy: entry.retryPolicy } : {}),
        ...("inputSchema" in entry ? { inputSchema: entry.inputSchema } : {})
      }
    ];
  });
}

function readModelCallTraceToolCalls(value: unknown): ModelCallTraceToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        ...(typeof entry.toolCallId === "string" ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.toolName === "string" ? { toolName: entry.toolName } : {}),
        ...("input" in entry ? { input: entry.input } : {})
      }
    ];
  });
}

function readModelCallTraceToolResults(value: unknown): ModelCallTraceToolResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        ...(typeof entry.toolCallId === "string" ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.toolName === "string" ? { toolName: entry.toolName } : {}),
        ...("output" in entry ? { output: entry.output } : {})
      }
    ];
  });
}

function toModelCallTrace(step: RunStep): ModelCallTrace | null {
  if (step.stepType !== "model_call") {
    return null;
  }

  const input = isRecord(step.input) ? step.input : {};
  const output = isRecord(step.output) ? step.output : {};
  const request = isRecord(input.request) ? input.request : {};
  const inputRuntime = isRecord(input.runtime) ? input.runtime : {};
  const response = isRecord(output.response) ? output.response : {};
  const outputRuntime = isRecord(output.runtime) ? output.runtime : {};

  return {
    id: step.id,
    seq: step.seq,
    ...(step.name ? { name: step.name } : {}),
    ...(step.agentName ? { agentName: step.agentName } : {}),
    status: step.status,
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt ? { endedAt: step.endedAt } : {}),
    input: {
      ...(typeof request.model === "string" ? { model: request.model } : {}),
      ...(typeof request.canonicalModelRef === "string" ? { canonicalModelRef: request.canonicalModelRef } : {}),
      ...(typeof request.provider === "string" ? { provider: request.provider } : {}),
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(typeof request.maxTokens === "number" ? { maxTokens: request.maxTokens } : {}),
      ...(typeof inputRuntime.messageCount === "number" ? { messageCount: inputRuntime.messageCount } : {}),
      activeToolNames: readStringArray(inputRuntime.activeToolNames),
      runtimeToolNames: readStringArray(inputRuntime.runtimeToolNames),
      runtimeTools: readModelCallTraceRuntimeTools(inputRuntime.runtimeTools),
      toolServers: readModelCallTraceToolServers(inputRuntime.toolServers),
      messages: readModelCallTraceMessages(request.messages)
    },
    output: {
      ...(typeof response.stepType === "string" ? { stepType: response.stepType } : {}),
      ...(typeof response.text === "string" ? { text: response.text } : {}),
      ...(Array.isArray(response.content) ? { content: response.content } : {}),
      ...(Array.isArray(response.reasoning) ? { reasoning: response.reasoning } : {}),
      ...(isRecord(response.usage) ? { usage: response.usage } : {}),
      ...(Array.isArray(response.warnings) ? { warnings: response.warnings } : {}),
      ...(isRecord(response.request) ? { request: response.request } : {}),
      ...(isRecord(response.response) ? { response: response.response } : {}),
      ...(isRecord(response.providerMetadata) ? { providerMetadata: response.providerMetadata } : {}),
      ...(typeof response.finishReason === "string" ? { finishReason: response.finishReason } : {}),
      ...(typeof outputRuntime.toolCallsCount === "number" ? { toolCallsCount: outputRuntime.toolCallsCount } : {}),
      ...(typeof outputRuntime.toolResultsCount === "number" ? { toolResultsCount: outputRuntime.toolResultsCount } : {}),
      ...(typeof response.errorMessage === "string" ? { errorMessage: response.errorMessage } : {}),
      toolCalls: readModelCallTraceToolCalls(response.toolCalls),
      toolResults: readModelCallTraceToolResults(response.toolResults)
    },
    rawInput: step.input,
    rawOutput: step.output
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function countMessagesByRole(messages: Array<{ role: Message["role"] }>) {
  return {
    system: messages.filter((message) => message.role === "system").length,
    user: messages.filter((message) => message.role === "user").length,
    assistant: messages.filter((message) => message.role === "assistant").length,
    tool: messages.filter((message) => message.role === "tool").length
  };
}

function compareMessagesChronologically(left: Pick<Message, "createdAt" | "id">, right: Pick<Message, "createdAt" | "id">) {
  const leftValue = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
  const rightValue = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
  const timestampComparison =
    Number.isFinite(leftValue) && Number.isFinite(rightValue) ? leftValue - rightValue : 0;

  if (timestampComparison !== 0) {
    return timestampComparison;
  }

  return left.id.localeCompare(right.id);
}

function upsertSessionMessage(current: Message[], incoming: Message) {
  const existingIndex = current.findIndex((message) => message.id === incoming.id);
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = incoming;
    return next;
  }

  return [...current, incoming].sort(compareMessagesChronologically);
}

function inferCompletedMessageRole(data: Record<string, unknown>): "assistant" | "tool" {
  return typeof data.toolName === "string" && typeof data.toolCallId === "string" ? "tool" : "assistant";
}

function addRecentId(list: string[], id: string) {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, 8);
}

function filterStable<T>(list: T[], predicate: (value: T) => boolean) {
  const next = list.filter(predicate);
  return next.length === list.length && next.every((value, index) => Object.is(value, list[index])) ? list : next;
}

function compareIsoTimestampDesc(left?: string, right?: string) {
  const leftValue = left ? Date.parse(left) : Number.NaN;
  const rightValue = right ? Date.parse(right) : Number.NaN;

  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    return rightValue - leftValue;
  }

  if (Number.isFinite(leftValue)) {
    return -1;
  }

  if (Number.isFinite(rightValue)) {
    return 1;
  }

  return 0;
}

function compareSavedNavigationItemsDesc<T extends { id: string; lastOpenedAt?: string; createdAt?: string }>(left: T, right: T) {
  const openedAtComparison = compareIsoTimestampDesc(left.lastOpenedAt, right.lastOpenedAt);
  if (openedAtComparison !== 0) {
    return openedAtComparison;
  }

  const createdAtComparison = compareIsoTimestampDesc(left.createdAt, right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return right.id.localeCompare(left.id);
}

function isTerminalRunEvent(event: string) {
  return event === "run.completed" || event === "run.failed" || event === "run.cancelled";
}

function isTerminalRunStatus(status?: Run["status"] | null) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function toneBadgeClass(tone: StatusSemanticTone) {
  switch (tone) {
    case "emerald":
      return "border-[color:var(--app-tone-emerald-border)] bg-[color:var(--app-tone-emerald-surface)] text-[color:var(--app-tone-emerald-foreground)]";
    case "rose":
      return "border-[color:var(--app-tone-rose-border)] bg-[color:var(--app-tone-rose-surface)] text-[color:var(--app-tone-rose-foreground)]";
    case "amber":
      return "border-[color:var(--app-tone-amber-border)] bg-[color:var(--app-tone-amber-surface)] text-[color:var(--app-tone-amber-foreground)]";
    case "plum":
      return "border-[color:var(--app-tone-plum-border)] bg-[color:var(--app-tone-plum-surface)] text-[color:var(--app-tone-plum-foreground)]";
    default:
      return "border-[color:var(--app-tone-sky-border)] bg-[color:var(--app-tone-sky-surface)] text-[color:var(--app-tone-sky-foreground)]";
  }
}

function toneSolidClass(tone: StatusSemanticTone) {
  switch (tone) {
    case "emerald":
      return "bg-[color:var(--app-tone-emerald-solid)]";
    case "rose":
      return "bg-[color:var(--app-tone-rose-solid)]";
    case "amber":
      return "bg-[color:var(--app-tone-amber-solid)]";
    case "plum":
      return "bg-[color:var(--app-tone-plum-solid)]";
    default:
      return "bg-[color:var(--app-tone-sky-solid)]";
  }
}

function toneTextClass(tone: StatusSemanticTone) {
  switch (tone) {
    case "emerald":
      return "text-[color:var(--app-tone-emerald-solid)]";
    case "rose":
      return "text-[color:var(--app-tone-rose-solid)]";
    case "amber":
      return "text-[color:var(--app-tone-amber-solid)]";
    case "plum":
      return "text-[color:var(--app-tone-plum-solid)]";
    default:
      return "text-[color:var(--app-tone-sky-solid)]";
  }
}

function streamTone(status: string): StatusSemanticTone {
  switch (status) {
    case "open":
    case "listening":
      return "emerald";
    case "connecting":
      return "amber";
    case "error":
      return "rose";
    default:
      return "sky";
  }
}

function workerStateTone(state: HealthReportResponse["worker"]["activeWorkers"][number]["state"]): StatusSemanticTone {
  switch (state) {
    case "idle":
      return "emerald";
    case "busy":
      return "sky";
    case "starting":
    case "stopping":
      return "amber";
    default:
      return "sky";
  }
}

function workerHealthTone(health: HealthReportResponse["worker"]["activeWorkers"][number]["health"]): StatusSemanticTone {
  return health === "late" ? "amber" : "emerald";
}

function statusTone(status: string) {
  switch (status) {
    case "completed":
      return toneBadgeClass("emerald");
    case "running":
    case "waiting_tool":
      return toneBadgeClass("sky");
    case "queued":
      return toneBadgeClass("amber");
    case "cancelled":
      return "border-border bg-muted text-muted-foreground";
    case "failed":
    case "timed_out":
      return toneBadgeClass("rose");
    default:
      return "";
  }
}

function probeTone(status: string): StatusSemanticTone {
  switch (status) {
    case "ok":
    case "ready":
    case "up":
      return "emerald";
    case "degraded":
    case "not_configured":
    case "checking":
    case "idle":
      return "amber";
    case "error":
    case "not_ready":
    case "down":
      return "rose";
    default:
      return "sky";
  }
}

async function consumeSse(
  response: Response,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("SSE response body is not readable.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let event = "message";
      let cursor: string | undefined;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("id:")) {
          cursor = line.slice(3).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      onFrame({
        event,
        data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
        ...(cursor ? { cursor } : {})
      });
    }
  }
}

function isRuntimeLogLevel(value: unknown): value is RuntimeLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function isRuntimeLogCategory(value: unknown): value is RuntimeLogCategory {
  return value === "run" || value === "model" || value === "tool" || value === "hook" || value === "agent" || value === "http" || value === "system";
}

function runtimeLogDataFromEvent(event: SessionEventContract): RuntimeLogEventData | null {
  if (!isRecord(event.data)) {
    return null;
  }

  const { level, category, message, source, timestamp } = event.data;
  if (
    !isRuntimeLogLevel(level) ||
    !isRuntimeLogCategory(category) ||
    typeof message !== "string" ||
    (source !== "server" && source !== "web") ||
    typeof timestamp !== "string"
  ) {
    return null;
  }

  return {
    level,
    category,
    message,
    ...(event.data.details !== undefined ? { details: event.data.details } : {}),
    ...(isRecord(event.data.context) ? { context: event.data.context } : {}),
    source,
    timestamp
  };
}

function levelFromEventName(eventName: SessionEventContract["event"], data: Record<string, unknown>): RuntimeLogLevel {
  switch (eventName) {
    case "tool.failed":
    case "run.failed":
      return "error";
    case "hook.notice":
    case "run.cancelled":
      return typeof data.errorMessage === "string" || typeof data.errorCode === "string" ? "warn" : "info";
    default:
      return "info";
  }
}

function categoryFromEventName(eventName: SessionEventContract["event"]): RuntimeLogCategory | null {
  switch (eventName) {
    case "run.queued":
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return "run";
    case "tool.started":
    case "tool.completed":
    case "tool.failed":
      return "tool";
    case "hook.notice":
      return "hook";
    case "agent.switch.requested":
    case "agent.switched":
    case "agent.delegate.started":
    case "agent.delegate.completed":
    case "agent.delegate.failed":
      return "agent";
    default:
      return null;
  }
}

function consoleMessageFromEvent(event: SessionEventContract): string {
  switch (event.event) {
    case "run.queued":
      return `Run queued${typeof event.data.runId === "string" ? ` · ${event.data.runId}` : ""}`;
    case "run.started":
      return `Run started${typeof event.data.runId === "string" ? ` · ${event.data.runId}` : ""}`;
    case "run.completed":
      return `Run completed${typeof event.data.runId === "string" ? ` · ${event.data.runId}` : ""}`;
    case "run.failed":
      return typeof event.data.errorMessage === "string" ? event.data.errorMessage : "Run failed.";
    case "run.cancelled":
      return "Run cancelled.";
    case "tool.started":
      return `Tool started: ${typeof event.data.toolName === "string" ? event.data.toolName : "unknown"}`;
    case "tool.completed":
      return `Tool completed: ${typeof event.data.toolName === "string" ? event.data.toolName : "unknown"}`;
    case "tool.failed":
      return typeof event.data.errorMessage === "string"
        ? event.data.errorMessage
        : `Tool failed: ${typeof event.data.toolName === "string" ? event.data.toolName : "unknown"}`;
    case "hook.notice":
      return typeof event.data.errorMessage === "string"
        ? event.data.errorMessage
        : `Hook notice: ${typeof event.data.hookName === "string" ? event.data.hookName : "unknown"}`;
    case "agent.switch.requested":
      return `Agent switch requested${typeof event.data.toAgent === "string" ? ` → ${event.data.toAgent}` : ""}`;
    case "agent.switched":
      return `Agent switched${typeof event.data.toAgent === "string" ? ` → ${event.data.toAgent}` : ""}`;
    case "agent.delegate.started":
      return `Delegation started${typeof event.data.agentName === "string" ? ` · ${event.data.agentName}` : ""}`;
    case "agent.delegate.completed":
      return "Delegation completed.";
    case "agent.delegate.failed":
      return typeof event.data.errorMessage === "string" ? event.data.errorMessage : "Delegation failed.";
    default:
      return event.event;
  }
}

function buildRuntimeConsoleEntries(events: SessionEventContract[], activeError: AppRequestErrorSummary | null): RuntimeConsoleEntry[] {
  const eventEntries = events
    .map((event): RuntimeConsoleEntry | null => {
      if (event.event === "message.delta" || event.event === "message.completed") {
        return null;
      }

      const runtimeLog = event.event === "runtime.log" ? runtimeLogDataFromEvent(event) : null;
      if (runtimeLog) {
        return {
          id: `console:${event.id}`,
          timestamp: runtimeLog.timestamp,
          level: runtimeLog.level,
          category: runtimeLog.category,
          message: runtimeLog.message,
          ...(runtimeLog.details !== undefined ? { details: runtimeLog.details } : {}),
          source: runtimeLog.source,
          eventId: event.id,
          eventName: event.event,
          ...(event.runId ? { runId: event.runId } : {}),
          cursor: event.cursor,
          ...(typeof runtimeLog.context?.stepId === "string" ? { stepId: runtimeLog.context.stepId } : {})
        };
      }

      const category = categoryFromEventName(event.event);
      if (!category) {
        return null;
      }

      return {
        id: `console:${event.id}`,
        timestamp: event.createdAt,
        level: levelFromEventName(event.event, event.data),
        category,
        message: consoleMessageFromEvent(event),
        details: event.data,
        source: "server",
        eventId: event.id,
        eventName: event.event,
        ...(event.runId ? { runId: event.runId } : {}),
        cursor: event.cursor,
        ...(typeof event.data.stepId === "string" ? { stepId: event.data.stepId } : {})
      };
    })
    .filter((entry): entry is RuntimeConsoleEntry => entry !== null);

  const errorEntries: RuntimeConsoleEntry[] = activeError
    ? [
        {
          id: "console:active-error",
          timestamp: activeError.timestamp ?? new Date().toISOString(),
          level: "error",
          category: "http",
          message: activeError.message,
          details: {
            ...(activeError.code ? { code: activeError.code } : {}),
            ...(activeError.details ? { details: activeError.details } : {}),
            ...(activeError.statusCode ? { statusCode: activeError.statusCode } : {}),
            ...(activeError.statusText ? { statusText: activeError.statusText } : {})
          },
          source: "web"
        }
      ]
    : [];

  return [...eventEntries, ...errorEntries].sort((left, right) => {
    const timestampCompare = left.timestamp.localeCompare(right.timestamp);
    if (timestampCompare !== 0) {
      return timestampCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

export {
  SERVICE_SCOPE_ALL,
  SERVICE_SCOPE_DEFAULT,
  storageKeys,
  storagePostgresTables,
  storageTablePreviewLimit,
  usePersistentState,
  normalizeBaseUrl,
  buildUrl,
  normalizeServiceName,
  normalizeServiceScope,
  serviceScopeMatches,
  serviceScopeLabel,
  toStorageServiceNameParam,
  buildAuthHeaders,
  createHttpRequestError,
  readJsonResponse,
  toErrorMessage,
  toErrorSummary,
  isNotFoundError,
  prettyJson,
  sanitizeFileSegment,
  pathLeaf,
  downloadJsonFile,
  downloadCsvFile,
  isRecord,
  readStringArray,
  readMessageAgentSnapshot,
  readMessageSystemPromptSnapshot,
  readMessageModelCallStepRef,
  normalizeMessageContent,
  buildMessageRecord,
  contentText,
  contentToolRefs,
  contentPreview,
  hasDisplayableRunMessages,
  storageMessageFromRow,
  storageRunStepFromRow,
  storageSessionEventFromRow,
  storageToolCallFromRow,
  toModelCallTrace,
  uniqueStrings,
  countMessagesByRole,
  compareMessagesChronologically,
  upsertSessionMessage,
  inferCompletedMessageRole,
  addRecentId,
  filterStable,
  compareIsoTimestampDesc,
  compareSavedNavigationItemsDesc,
  isTerminalRunEvent,
  isTerminalRunStatus,
  formatTimestamp,
  toneBadgeClass,
  toneSolidClass,
  toneTextClass,
  streamTone,
  workerStateTone,
  workerHealthTone,
  statusTone,
  probeTone,
  consumeSse,
  buildRuntimeConsoleEntries
};

export type {
  AppRequestErrorSummary,
  ConnectionSettings,
  ConsoleFilter,
  LiveConversationMessageRecord,
  WorkspaceDraft,
  SavedWorkspaceRecord,
  SavedSessionRecord,
  ModelDraft,
  ModelProviderRecord,
  PlatformModelRecord,
  SseFrame,
  HealthReportResponse,
  ReadinessReportResponse,
  ModelProviderListResponse,
  PlatformModelListResponse,
  PlatformModelSnapshotResponse,
  InspectorTab,
  MainViewMode,
  SurfaceMode,
  StorageBrowserTab,
  ServiceScope,
  RuntimeConsoleEntry,
  ModelCallTraceMessage,
  ModelCallTraceToolCall,
  ModelCallTraceToolResult,
  ModelCallTraceToolServer,
  ModelCallTraceRuntimeTool,
  ModelCallTraceInput,
  ModelCallTraceOutput,
  ModelCallTrace,
  AgentMode,
  MessageAgentSnapshot,
  StorageToolCallRecord,
  StatusSemanticTone
};
