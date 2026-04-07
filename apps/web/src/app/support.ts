import { useEffect, useState } from "react";

import type {
  Message,
  MessageContent,
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
  template: string;
  rootPath: string;
}

interface SavedWorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  template?: string;
  status: Workspace["status"];
  createdAt?: string;
  lastOpenedAt: string;
}

interface SavedSessionRecord {
  id: string;
  workspaceId: string;
  title?: string;
  agentName?: string;
  lastRunAt?: string;
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

interface HealthReportResponse {
  status: "ok" | "degraded";
  storage: {
    primary: "postgres" | "sqlite";
    events: "redis" | "memory";
    runQueue: "redis" | "in_process";
  };
  process: {
    mode: "api_embedded_worker" | "api_only" | "standalone_worker";
    label: "API + embedded worker" | "API only" | "standalone worker";
    execution: "redis_queue" | "local_inline" | "none";
  };
  checks: {
    postgres: "up" | "down" | "not_configured";
    redisEvents: "up" | "down" | "not_configured";
    redisRunQueue: "up" | "down" | "not_configured";
    historyMirror: "up" | "degraded" | "not_configured";
  };
  worker: {
    mode: "embedded" | "external" | "disabled";
  };
  mirror: {
    worker: "running" | "disabled";
    enabledWorkspaces: number;
    idleWorkspaces: number;
    missingWorkspaces: number;
    errorWorkspaces: number;
  };
}

interface ReadinessReportResponse {
  status: "ready" | "not_ready";
  checks: {
    postgres: "up" | "down" | "not_configured";
    redisEvents: "up" | "down" | "not_configured";
    redisRunQueue: "up" | "down" | "not_configured";
  };
}

interface ModelProviderListResponse {
  items: ModelProviderRecord[];
}

interface PlatformModelListResponse {
  items: PlatformModelRecord[];
}

type InspectorTab = "overview" | "timeline" | "workspace";
type MainViewMode = "conversation" | "inspector";
type SurfaceMode = "runtime" | "storage" | "provider";
type StorageBrowserTab = "postgres" | "redis";
type MessageParts = Extract<Message["content"], unknown[]>;
type MessagePart = MessageParts[number];
type SystemMessageContent = Extract<Message, { role: "system" }>["content"];
type UserMessageContent = Extract<Message, { role: "user" }>["content"];
type AssistantMessageContent = Extract<Message, { role: "assistant" }>["content"];
type ToolMessageContent = Extract<Message, { role: "tool" }>["content"];

interface ModelCallTraceMessage {
  role: Message["role"];
  content: Message["content"];
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
  "history_events"
];

function storageTablePreviewLimit(table: StoragePostgresTableName) {
  switch (table) {
    case "session_events":
    case "run_steps":
      return 20;
    case "messages":
    case "tool_calls":
    case "hook_runs":
      return 25;
    default:
      return 50;
  }
}

const storageKeys = {
  connection: "oah.web.connection",
  workspaceDraft: "oah.web.workspaceDraft",
  sessionDraft: "oah.web.sessionDraft",
  modelDraft: "oah.web.modelDraft",
  workspaceId: "oah.web.workspaceId",
  sessionId: "oah.web.sessionId",
  recentWorkspaces: "oah.web.recentWorkspaces",
  recentSessions: "oah.web.recentSessions",
  expandedWorkspaces: "oah.web.expandedWorkspaces"
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

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) {
    return undefined as T;
  }

  return JSON.parse(raw) as T;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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

function upsertSessionMessage(current: Message[], incoming: Message) {
  const existingIndex = current.findIndex((message) => message.id === incoming.id);
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = incoming;
    return next;
  }

  return [...current, incoming].sort((left, right) => {
    const leftValue = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
    const rightValue = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
    const timestampComparison =
      Number.isFinite(leftValue) && Number.isFinite(rightValue) ? leftValue - rightValue : 0;
    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return left.id.localeCompare(right.id);
  });
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

function statusTone(status: string) {
  switch (status) {
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400";
    case "running":
    case "waiting_tool":
      return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-400";
    case "queued":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400";
    case "cancelled":
      return "border-border bg-muted text-muted-foreground";
    case "failed":
    case "timed_out":
      return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-400";
    default:
      return "";
  }
}

function probeTone(status: string): "sky" | "emerald" | "rose" | "amber" {
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

export {
  storageKeys,
  storagePostgresTables,
  storageTablePreviewLimit,
  usePersistentState,
  normalizeBaseUrl,
  buildUrl,
  readJsonResponse,
  toErrorMessage,
  isNotFoundError,
  prettyJson,
  sanitizeFileSegment,
  pathLeaf,
  downloadJsonFile,
  downloadCsvFile,
  isRecord,
  readStringArray,
  normalizeMessageContent,
  buildMessageRecord,
  contentText,
  contentToolRefs,
  contentPreview,
  storageMessageFromRow,
  storageRunStepFromRow,
  storageSessionEventFromRow,
  storageToolCallFromRow,
  toModelCallTrace,
  uniqueStrings,
  countMessagesByRole,
  upsertSessionMessage,
  inferCompletedMessageRole,
  addRecentId,
  filterStable,
  compareIsoTimestampDesc,
  compareSavedNavigationItemsDesc,
  isTerminalRunEvent,
  isTerminalRunStatus,
  formatTimestamp,
  statusTone,
  probeTone,
  consumeSse
};

export type {
  ConnectionSettings,
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
  InspectorTab,
  MainViewMode,
  SurfaceMode,
  StorageBrowserTab,
  ModelCallTraceMessage,
  ModelCallTraceToolCall,
  ModelCallTraceToolResult,
  ModelCallTraceToolServer,
  ModelCallTraceRuntimeTool,
  ModelCallTraceInput,
  ModelCallTraceOutput,
  ModelCallTrace,
  StorageToolCallRecord
};
