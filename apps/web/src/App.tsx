import { startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  CircleSlash2,
  Database,
  Download,
  Folder,
  FolderPlus,
  Network,
  Orbit,
  RefreshCw,
  Send,
  Sparkles,
  Trash2
} from "lucide-react";

import type {
  Message,
  MessageAccepted,
  ModelGenerateResponse,
  Run,
  RunStep,
  Session,
  SessionEventContract,
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisKeyDetail,
  StorageRedisKeyPage,
  Workspace,
  WorkspaceHistoryMirrorStatus,
  WorkspaceCatalog,
  WorkspaceTemplateList
} from "@oah/api-contracts";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";

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
  createdAt: string;
  lastOpenedAt: string;
}

interface SessionDraft {
  title: string;
  agentName: string;
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

interface SseFrame {
  cursor?: string;
  event: string;
  data: Record<string, unknown>;
}

interface HealthReportResponse {
  status: "ok" | "degraded";
  storage: {
    primary: "postgres" | "memory";
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

type InspectorTab = "run" | "llm" | "steps" | "events" | "catalog" | "model" | "storage";
type MainViewMode = "conversation" | "inspector";

interface ModelCallTraceMessage {
  role: Message["role"];
  content: string;
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

const storageKeys = {
  connection: "oah.web.connection",
  workspaceDraft: "oah.web.workspaceDraft",
  sessionDraft: "oah.web.sessionDraft",
  modelDraft: "oah.web.modelDraft",
  workspaceId: "oah.web.workspaceId",
  sessionId: "oah.web.sessionId",
  savedWorkspaces: "oah.web.savedWorkspaces",
  savedSessions: "oah.web.savedSessions",
  recentWorkspaces: "oah.web.recentWorkspaces",
  recentSessions: "oah.web.recentSessions"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
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
    const content = entry.content;
    if (!["system", "user", "assistant", "tool"].includes(String(role)) || typeof content !== "string") {
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

  return {
    id: step.id,
    seq: step.seq,
    ...(step.name ? { name: step.name } : {}),
    ...(step.agentName ? { agentName: step.agentName } : {}),
    status: step.status,
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt ? { endedAt: step.endedAt } : {}),
    input: {
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.canonicalModelRef === "string" ? { canonicalModelRef: input.canonicalModelRef } : {}),
      ...(typeof input.provider === "string" ? { provider: input.provider } : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxTokens === "number" ? { maxTokens: input.maxTokens } : {}),
      ...(typeof input.messageCount === "number" ? { messageCount: input.messageCount } : {}),
      activeToolNames: readStringArray(input.activeToolNames),
      runtimeToolNames: readStringArray(input.runtimeToolNames),
      runtimeTools: readModelCallTraceRuntimeTools(input.runtimeTools),
      toolServers: readModelCallTraceToolServers(input.toolServers),
      messages: readModelCallTraceMessages(input.messages)
    },
    output: {
      ...(typeof output.finishReason === "string" ? { finishReason: output.finishReason } : {}),
      ...(typeof output.toolCallsCount === "number" ? { toolCallsCount: output.toolCallsCount } : {}),
      ...(typeof output.toolResultsCount === "number" ? { toolResultsCount: output.toolResultsCount } : {}),
      ...(typeof output.errorMessage === "string" ? { errorMessage: output.errorMessage } : {}),
      toolCalls: readModelCallTraceToolCalls(output.toolCalls),
      toolResults: readModelCallTraceToolResults(output.toolResults)
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

function addRecentId(list: string[], id: string) {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, 8);
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

function isTerminalRunEvent(event: string) {
  return event === "run.completed" || event === "run.failed" || event === "run.cancelled";
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
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "running":
    case "waiting_tool":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "queued":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "cancelled":
      return "border-slate-200 bg-slate-100 text-slate-600";
    case "failed":
    case "timed_out":
      return "border-rose-200 bg-rose-50 text-rose-700";
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

export function App() {
  const [connection, setConnection] = usePersistentState<ConnectionSettings>(storageKeys.connection, {
    baseUrl: "",
    token: ""
  });
  const [workspaceDraft, setWorkspaceDraft] = usePersistentState<WorkspaceDraft>(storageKeys.workspaceDraft, {
    name: "debug-playground",
    template: "workspace",
    rootPath: ""
  });
  const [sessionDraft, setSessionDraft] = usePersistentState<SessionDraft>(storageKeys.sessionDraft, {
    title: "",
    agentName: ""
  });
  const [modelDraft, setModelDraft] = usePersistentState<ModelDraft>(storageKeys.modelDraft, {
    model: "",
    prompt: "你好，请简短回复一句话，确认模型链路已经接通。"
  });
  const [workspaceId, setWorkspaceId] = usePersistentState(storageKeys.workspaceId, "");
  const [sessionId, setSessionId] = usePersistentState(storageKeys.sessionId, "");
  const [savedWorkspaces, setSavedWorkspaces] = usePersistentState<SavedWorkspaceRecord[]>(storageKeys.savedWorkspaces, []);
  const [savedSessions, setSavedSessions] = usePersistentState<SavedSessionRecord[]>(storageKeys.savedSessions, []);
  const [recentWorkspaces, setRecentWorkspaces] = usePersistentState<string[]>(storageKeys.recentWorkspaces, []);
  const [recentSessions, setRecentSessions] = usePersistentState<string[]>(storageKeys.recentSessions, []);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [mirrorStatus, setMirrorStatus] = useState<WorkspaceHistoryMirrorStatus | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SessionEventContract[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [draftMessage, setDraftMessage] = useState("你好，帮我简单确认一下当前 session 和 run 是否正常工作。");
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const [healthStatus, setHealthStatus] = useState("idle");
  const [healthReport, setHealthReport] = useState<HealthReportResponse | null>(null);
  const [readinessReport, setReadinessReport] = useState<ReadinessReportResponse | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderRecord[]>([]);
  const [storageOverview, setStorageOverview] = useState<StorageOverview | null>(null);
  const [selectedStorageTable, setSelectedStorageTable] = useState<StoragePostgresTableName>("runs");
  const [storageTablePage, setStorageTablePage] = useState<StoragePostgresTablePage | null>(null);
  const [redisKeyPattern, setRedisKeyPattern] = useState("oah:*");
  const [redisKeyPage, setRedisKeyPage] = useState<StorageRedisKeyPage | null>(null);
  const [selectedRedisKey, setSelectedRedisKey] = useState("");
  const [redisKeyDetail, setRedisKeyDetail] = useState<StorageRedisKeyDetail | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "listening" | "open" | "error">("idle");
  const [activity, setActivity] = useState("等待连接");
  const [errorMessage, setErrorMessage] = useState("");
  const [generateOutput, setGenerateOutput] = useState<ModelGenerateResponse | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [autoStream, setAutoStream] = useState(true);
  const [filterSelectedRun, setFilterSelectedRun] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const [sidebarMode, setSidebarMode] = useState<"workspaces" | "sessions">("workspaces");
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("conversation");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("run");
  const [showSessionCreator, setShowSessionCreator] = useState(false);
  const [showWorkspaceCreator, setShowWorkspaceCreator] = useState(false);
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);
  const [mirrorToggleBusy, setMirrorToggleBusy] = useState(false);
  const [mirrorRebuildBusy, setMirrorRebuildBusy] = useState(false);
  const [workspaceManagementEnabled, setWorkspaceManagementEnabled] = useState(true);

  const deferredEvents = useDeferredValue(events);
  const streamAbortRef = useRef<AbortController | null>(null);
  const lastCursorRef = useRef<string | undefined>(undefined);
  const messageRefreshTimerRef = useRef<number | undefined>(undefined);
  const runRefreshTimerRef = useRef<number | undefined>(undefined);
  const activeWorkspaceSessions = [...savedSessions]
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => {
      const timestampComparison = compareIsoTimestampDesc(left.createdAt, right.createdAt);
      if (timestampComparison !== 0) {
        return timestampComparison;
      }

      return right.id.localeCompare(left.id);
    });
  const orderedSavedWorkspaces = [...savedWorkspaces].sort((left, right) => {
    const timestampComparison = compareIsoTimestampDesc(left.createdAt, right.createdAt);
    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return right.id.localeCompare(left.id);
  });
  const selectedRunIdValue = selectedRunId.trim();
  const streamRunId = filterSelectedRun ? selectedRunIdValue : "";
  const modelCallTraces = runSteps.map(toModelCallTrace).filter((trace): trace is ModelCallTrace => trace !== null);
  const firstModelCallTrace = modelCallTraces[0] ?? null;
  const latestModelCallTrace = modelCallTraces.at(-1) ?? null;
  const composedSystemMessages = firstModelCallTrace?.input.messages.filter((message) => message.role === "system") ?? [];
  const storedMessageCounts = countMessagesByRole(messages);
  const latestModelMessageCounts = countMessagesByRole(latestModelCallTrace?.input.messages ?? []);
  const allRuntimeToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.runtimeToolNames));
  const allAdvertisedToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.activeToolNames));
  const allRuntimeTools = [
    ...new Map(modelCallTraces.flatMap((trace) => trace.input.runtimeTools).map((tool) => [tool.name, tool])).values()
  ];
  const allToolServers = [...new Map(modelCallTraces.flatMap((trace) => trace.input.toolServers).map((server) => [server.name, server])).values()];
  const resolvedModelNames = uniqueStrings(modelCallTraces.map((trace) => trace.input.model).filter((value): value is string => Boolean(value)));
  const resolvedModelRefs = uniqueStrings(
    modelCallTraces.map((trace) => trace.input.canonicalModelRef).filter((value): value is string => Boolean(value))
  );

  async function request<T>(path: string, init?: RequestInit, options?: { auth?: boolean }) {
    const headers = new Headers(init?.headers);
    const authRequired = options?.auth ?? true;
    const token = connection.token.trim();

    if (authRequired && token) {
      headers.set("authorization", `Bearer ${token}`);
    }

    const response = await fetch(buildUrl(connection.baseUrl, path), {
      ...init,
      headers
    });

    if (!response.ok) {
      const body = await readJsonResponse<{ error?: { message?: string } }>(response).catch(() => undefined);
      throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    }

    return readJsonResponse<T>(response);
  }

  function downloadSessionTrace() {
    const selectedOrLatestRunId = run?.id ?? (selectedRunIdValue || "latest");
    const exportPayload = {
      format: "oah.session-trace.v2",
      exportedAt: new Date().toISOString(),
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            rootPath: workspace.rootPath,
            kind: workspace.kind,
            status: workspace.status,
            readOnly: workspace.readOnly,
            historyMirrorEnabled: workspace.historyMirrorEnabled
          }
        : null,
      session: session
        ? {
            id: session.id,
            title: session.title ?? currentSessionName,
            workspaceId: session.workspaceId,
            agentName: session.agentName,
            activeAgentName: session.activeAgentName,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
          }
        : null,
      run: run
        ? {
            id: run.id,
            sessionId: run.sessionId,
            parentRunId: run.parentRunId,
            triggerType: run.triggerType,
            triggerRef: run.triggerRef,
            agentName: run.agentName,
            effectiveAgentName: run.effectiveAgentName,
            status: run.status,
            startedAt: run.startedAt,
            heartbeatAt: run.heartbeatAt,
            endedAt: run.endedAt,
            errorCode: run.errorCode,
            errorMessage: run.errorMessage
          }
        : {
            id: selectedOrLatestRunId
          },
      ui: {
        sessionName: currentSessionName,
        workspaceName: currentWorkspaceName,
        activity,
        streamState
      },
      messages: messages.map((message) => ({
        id: message.id,
        sessionId: message.sessionId,
        ...(message.runId ? { runId: message.runId } : {}),
        role: message.role,
        content: message.content,
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.metadata ? { metadata: message.metadata } : {}),
        createdAt: message.createdAt
      })),
      llm: {
        modelCallCount: modelCallTraces.length,
        calls: modelCallTraces.map((trace) => ({
          seq: trace.seq,
          status: trace.status,
          ...(trace.agentName ? { agentName: trace.agentName } : {}),
          model: trace.input.model,
          canonicalModelRef: trace.input.canonicalModelRef,
          provider: trace.input.provider,
          temperature: trace.input.temperature,
          maxTokens: trace.input.maxTokens,
          finishReason: trace.output.finishReason,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt,
          systemPrompt: trace.input.messages.find((message) => message.role === "system")?.content ?? "",
          messages: trace.input.messages,
          tools: {
            definitions: trace.input.runtimeTools,
            activeToolNames: trace.input.activeToolNames,
            toolServers: trace.input.toolServers
          },
          toolCalls: trace.output.toolCalls,
          toolResults: trace.output.toolResults
        }))
      },
      aiSdkLike: {
        messages: latestModelCallTrace?.input.messages ?? [],
        tools: {
          definitions: latestModelCallTrace?.input.runtimeTools ?? [],
          activeTools: latestModelCallTrace?.input.activeToolNames ?? [],
          toolServers: latestModelCallTrace?.input.toolServers ?? []
        },
        steps: modelCallTraces.map((trace) => ({
          stepNumber: trace.seq,
          model: trace.input.model,
          canonicalModelRef: trace.input.canonicalModelRef,
          provider: trace.input.provider,
          finishReason: trace.output.finishReason,
          messages: trace.input.messages,
          toolCalls: trace.output.toolCalls,
          toolResults: trace.output.toolResults,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt,
          status: trace.status
        }))
      },
      downloadsMeta: {
        selectedRunId: selectedOrLatestRunId,
        note: "LLM-page export keeps a compact session trace and omits SSE event feed."
      }
    };

    const sessionSegment = sanitizeFileSegment(session?.title ?? session?.id ?? currentSessionName);
    const runSegment = sanitizeFileSegment(selectedOrLatestRunId);
    downloadJsonFile(`${sessionSegment}-${runSegment}-trace.json`, exportPayload);
  }

  function rememberWorkspace(
    workspaceRecord: Workspace,
    options?: {
      template?: string;
    }
  ) {
    const now = new Date().toISOString();
    setSavedWorkspaces((current) => {
      const existing = current.find((entry) => entry.id === workspaceRecord.id);
      const nextRecord: SavedWorkspaceRecord = {
        id: workspaceRecord.id,
        name: workspaceRecord.name,
        rootPath: workspaceRecord.rootPath,
        status: workspaceRecord.status,
        createdAt: workspaceRecord.createdAt ?? existing?.createdAt,
        lastOpenedAt: now
      };
      const templateValue = options?.template ?? existing?.template;
      if (templateValue) {
        nextRecord.template = templateValue;
      }

      if (existing) {
        return current.map((entry) => (entry.id === workspaceRecord.id ? nextRecord : entry));
      }

      return [...current, nextRecord].slice(-24);
    });
  }

  function rememberSession(sessionRecord: Session) {
    const now = new Date().toISOString();
    const nextRecord: SavedSessionRecord = {
      id: sessionRecord.id,
      workspaceId: sessionRecord.workspaceId,
      createdAt: sessionRecord.createdAt,
      lastOpenedAt: now
    };

    if (sessionRecord.title) {
      nextRecord.title = sessionRecord.title;
    }

    if (sessionRecord.activeAgentName) {
      nextRecord.agentName = sessionRecord.activeAgentName;
    }

    setSavedSessions((current) => [
      nextRecord,
      ...current.filter((entry) => entry.id !== sessionRecord.id)
    ].slice(0, 48));
  }

  function forgetWorkspace(workspaceToRemoveId: string) {
    if (workspaceId === workspaceToRemoveId) {
      clearWorkspaceSelection(workspaceToRemoveId);
      return;
    }

    setSavedWorkspaces((current) => current.filter((entry) => entry.id !== workspaceToRemoveId));
    setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== workspaceToRemoveId));
    setRecentWorkspaces((current) => current.filter((entry) => entry !== workspaceToRemoveId));
  }

  async function deleteWorkspace(workspaceToRemoveId: string) {
    const targetWorkspace = savedWorkspaces.find((entry) => entry.id === workspaceToRemoveId);
    const confirmed = window.confirm(
      `确认删除 workspace "${targetWorkspace?.name ?? workspaceToRemoveId}" 吗？这会删除服务端记录，并同步清理受管目录中的 workspace 文件夹。`
    );
    if (!confirmed) {
      return;
    }

    try {
      await request<void>(`/api/v1/workspaces/${workspaceToRemoveId}`, {
        method: "DELETE"
      });
      forgetWorkspace(workspaceToRemoveId);
      void refreshWorkspaceIndex(true);
      setActivity(`Workspace ${workspaceToRemoveId} 已删除`);
      setErrorMessage("");
    } catch (error) {
      if (isNotFoundError(error)) {
        forgetWorkspace(workspaceToRemoveId);
        setActivity(`Workspace ${workspaceToRemoveId} 已从列表清理`);
        setErrorMessage("");
        return;
      }

      setErrorMessage(toErrorMessage(error));
    }
  }

  function removeSavedSession(sessionToRemoveId: string) {
    setSavedSessions((current) => current.filter((entry) => entry.id !== sessionToRemoveId));
    setRecentSessions((current) => current.filter((entry) => entry !== sessionToRemoveId));

    if (sessionId === sessionToRemoveId) {
      setSessionId("");
      setSession(null);
      setMessages([]);
      setEvents([]);
      setSelectedRunId("");
      setRun(null);
      setRunSteps([]);
      setLiveOutput({});
    }
  }

  function clearSessionSelection(sessionToClearId?: string) {
    const targetId = sessionToClearId ?? sessionId;
    lastCursorRef.current = undefined;
    streamAbortRef.current?.abort();
    setStreamState("idle");
    setSessionId("");
    setSession(null);
    setMessages([]);
    setEvents([]);
    setSelectedRunId("");
    setRun(null);
    setRunSteps([]);
    setLiveOutput({});

    if (targetId) {
      setSavedSessions((current) => current.filter((entry) => entry.id !== targetId));
      setRecentSessions((current) => current.filter((entry) => entry !== targetId));
    }
  }

  function clearWorkspaceSelection(workspaceToClearId?: string) {
    const targetId = workspaceToClearId ?? workspaceId;
    clearSessionSelection();
    setWorkspaceId("");
    setWorkspace(null);
    setCatalog(null);
    setMirrorStatus(null);

    if (targetId) {
      setSavedWorkspaces((current) => current.filter((entry) => entry.id !== targetId));
      setRecentWorkspaces((current) => current.filter((entry) => entry !== targetId));
      setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== targetId));
    }
  }

  function scheduleMessagesRefresh() {
    window.clearTimeout(messageRefreshTimerRef.current);
    messageRefreshTimerRef.current = window.setTimeout(() => {
      void refreshMessages(true);
    }, 120);
  }

  function scheduleRunRefresh(runId: string) {
    window.clearTimeout(runRefreshTimerRef.current);
    runRefreshTimerRef.current = window.setTimeout(() => {
      void refreshRun(runId, true);
      void refreshRunSteps(runId, true);
    }, 140);
  }

  async function pingHealth() {
    try {
      setHealthStatus("checking");
      const [healthResponse, readinessResponse] = await Promise.all([
        fetch(buildUrl(connection.baseUrl, "/healthz")),
        fetch(buildUrl(connection.baseUrl, "/readyz"))
      ]);

      if (!healthResponse.ok) {
        throw new Error(`${healthResponse.status} ${healthResponse.statusText}`);
      }

      const healthPayload = (await readJsonResponse<HealthReportResponse>(healthResponse)) ?? null;
      const readinessPayload = await readJsonResponse<ReadinessReportResponse>(readinessResponse).catch(() => null);

      setHealthReport(healthPayload);
      setReadinessReport(readinessPayload);
      setHealthStatus(healthPayload?.status ?? (readinessResponse.ok ? "ok" : "degraded"));
      setActivity(
        healthPayload?.status === "degraded" || readinessPayload?.status === "not_ready"
          ? "服务探针发现降级项"
          : "服务健康检查通过"
      );
      setErrorMessage("");
    } catch (error) {
      setHealthStatus("error");
      setHealthReport(null);
      setReadinessReport(null);
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshStorageOverview(quiet = false) {
    try {
      setStorageBusy(true);
      const response = await request<StorageOverview>("/api/v1/storage/overview");
      setStorageOverview(response);
      if (!quiet) {
        setActivity("已刷新 PG / Redis 存储概览");
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshStorageTable(table = selectedStorageTable, quiet = false) {
    try {
      setStorageBusy(true);
      const response = await request<StoragePostgresTablePage>(`/api/v1/storage/postgres/tables/${table}?limit=50`);
      setSelectedStorageTable(table);
      setStorageTablePage(response);
      if (!quiet) {
        setActivity(`已加载 ${table} 表预览`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshRedisKeys(options?: { cursor?: string; quiet?: boolean }) {
    try {
      setStorageBusy(true);
      const pattern = redisKeyPattern.trim() || "oah:*";
      const params = new URLSearchParams({
        pattern
      });
      if (options?.cursor) {
        params.set("cursor", options.cursor);
      }
      params.set("pageSize", "100");
      const response = await request<StorageRedisKeyPage>(`/api/v1/storage/redis/keys?${params.toString()}`);
      setRedisKeyPage(response);
      if (!options?.quiet) {
        setActivity(`已加载 ${response.items.length} 个 Redis key`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!options?.quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshRedisKeyDetail(key = selectedRedisKey, quiet = false) {
    const targetKey = key.trim();
    if (!targetKey) {
      setRedisKeyDetail(null);
      return;
    }

    try {
      setStorageBusy(true);
      const params = new URLSearchParams({
        key: targetKey
      });
      const response = await request<StorageRedisKeyDetail>(`/api/v1/storage/redis/key?${params.toString()}`);
      setSelectedRedisKey(targetKey);
      setRedisKeyDetail(response);
      if (!quiet) {
        setActivity(`已加载 Redis key ${targetKey}`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function deleteRedisKey() {
    const targetKey = selectedRedisKey.trim();
    if (!targetKey) {
      return;
    }

    if (!window.confirm(`Delete Redis key ${targetKey}?`)) {
      return;
    }

    try {
      setStorageBusy(true);
      const params = new URLSearchParams({
        key: targetKey
      });
      await request(`/api/v1/storage/redis/key?${params.toString()}`, {
        method: "DELETE"
      });
      setRedisKeyDetail(null);
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      setActivity(`已删除 Redis key ${targetKey}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshWorkspaceTemplates(quiet = false) {
    try {
      const response = await request<WorkspaceTemplateList>("/api/v1/workspace-templates");
      startTransition(() => {
        setWorkspaceManagementEnabled(true);
        setWorkspaceTemplates(response.items.map((item) => item.name));
      });
      if (!quiet) {
        setActivity(`已加载 ${response.items.length} 个模板`);
        setErrorMessage("");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("workspace_templates_unavailable") ||
          error.message.toLowerCase().includes("workspace templates are not available"))
      ) {
        startTransition(() => {
          setWorkspaceManagementEnabled(false);
          setWorkspaceTemplates([]);
        });
        if (!quiet) {
          setErrorMessage("");
        }
        return;
      }

      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshWorkspaceIndex(quiet = false) {
    try {
      const response = await request<{ items: Workspace[]; nextCursor?: string }>("/api/v1/workspaces?pageSize=200");
      startTransition(() => {
        setSavedWorkspaces((current) => {
          const currentById = new Map(current.map((entry) => [entry.id, entry]));
          return response.items.map((item) => {
            const existing = currentById.get(item.id);
            return {
              id: item.id,
              name: item.name,
              rootPath: item.rootPath,
              status: item.status,
              createdAt: item.createdAt,
              lastOpenedAt: existing?.lastOpenedAt ?? item.updatedAt,
              ...(existing?.template ? { template: existing.template } : {})
            } satisfies SavedWorkspaceRecord;
          });
        });
      });

      if (response.items.length === 1) {
        const onlyWorkspace = response.items[0]!;
        if (!sessionId.trim() && workspaceId !== onlyWorkspace.id) {
          setSidebarMode("sessions");
          void refreshWorkspace(onlyWorkspace.id, true);
        }
      } else if (workspaceId.trim() && !response.items.some((item) => item.id === workspaceId)) {
        clearWorkspaceSelection(workspaceId);
      }

      if (!quiet) {
        setActivity(`已同步 ${response.items.length} 个 workspace`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshModelProviders(quiet = false) {
    try {
      const response = await request<ModelProviderListResponse>("/api/v1/model-providers");
      startTransition(() => {
        setModelProviders(response.items);
      });
      if (!quiet) {
        setActivity(`已加载 ${response.items.length} 个模型 provider`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshWorkspace(targetId = workspaceId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const workspaceResponse = await request<Workspace>(`/api/v1/workspaces/${targetId}`);
      const [catalogResponse, mirrorStatusResponse] = await Promise.allSettled([
        request<WorkspaceCatalog>(`/api/v1/workspaces/${targetId}/catalog`),
        request<WorkspaceHistoryMirrorStatus>(`/api/v1/workspaces/${targetId}/history-mirror`)
      ]);
      const refreshWarnings = [catalogResponse, mirrorStatusResponse]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => toErrorMessage(result.reason));

      startTransition(() => {
        setWorkspace(workspaceResponse);
        setCatalog(catalogResponse.status === "fulfilled" ? catalogResponse.value : null);
        setMirrorStatus(mirrorStatusResponse.status === "fulfilled" ? mirrorStatusResponse.value : null);
        setWorkspaceId(targetId);
        setRecentWorkspaces((current) => addRecentId(current, targetId));
      });
      rememberWorkspace(workspaceResponse);
      setActivity(`Workspace ${targetId} 已加载`);
      if (!quiet && refreshWarnings.length > 0) {
        setErrorMessage(refreshWarnings.join(" | "));
      } else if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      setWorkspace(null);
      setCatalog(null);
      setMirrorStatus(null);
      if (isNotFoundError(error)) {
        clearWorkspaceSelection(targetId);
      }
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createWorkspace() {
    try {
      const created = await request<Workspace>("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: workspaceDraft.name.trim(),
          template: workspaceDraft.template.trim(),
          ...(workspaceDraft.rootPath.trim() ? { rootPath: workspaceDraft.rootPath.trim() } : {}),
          executionPolicy: "local"
        })
      });

      startTransition(() => {
        setWorkspaceId(created.id);
        setSelectedRunId("");
        setRun(null);
        setRunSteps([]);
        setSession(null);
        setSessionId("");
        setMessages([]);
        setEvents([]);
        setWorkspace(created);
        setRecentWorkspaces((current) => addRecentId(current, created.id));
      });
      rememberWorkspace(created, {
        template: workspaceDraft.template.trim()
      });
      lastCursorRef.current = undefined;
      setShowWorkspaceCreator(false);
      setSidebarMode("sessions");
      await refreshWorkspace(created.id, true);
      await refreshWorkspaceIndex(true);
      setActivity(`Workspace ${created.id} 已创建`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function updateWorkspaceHistoryMirrorEnabled(enabled: boolean) {
    if (!workspaceId.trim() || !workspace) {
      setErrorMessage("请先加载 workspace。");
      return;
    }

    try {
      setMirrorToggleBusy(true);
      const updated = await request<Workspace>(`/api/v1/workspaces/${workspaceId}/settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          historyMirrorEnabled: enabled
        })
      });

      startTransition(() => {
        setWorkspace(updated);
      });
      const nextMirrorStatus = await request<WorkspaceHistoryMirrorStatus>(
        `/api/v1/workspaces/${workspaceId}/history-mirror`
      );
      startTransition(() => {
        setMirrorStatus(nextMirrorStatus);
      });
      rememberWorkspace(updated);
      setActivity(`Mirror sync 已${enabled ? "开启" : "关闭"}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setMirrorToggleBusy(false);
    }
  }

  async function rebuildWorkspaceHistoryMirror() {
    if (!workspaceId.trim() || !workspace) {
      setErrorMessage("请先加载 workspace。");
      return;
    }

    try {
      setMirrorRebuildBusy(true);
      const nextMirrorStatus = await request<WorkspaceHistoryMirrorStatus>(
        `/api/v1/workspaces/${workspaceId}/history-mirror/rebuild`,
        {
          method: "POST"
        }
      );
      startTransition(() => {
        setMirrorStatus(nextMirrorStatus);
      });
      setActivity("Mirror sync 已重建");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setMirrorRebuildBusy(false);
    }
  }

  async function refreshSession(targetId = sessionId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const [sessionResponse, messagePage] = await Promise.all([
        request<Session>(`/api/v1/sessions/${targetId}`),
        request<{ items: Message[] }>(`/api/v1/sessions/${targetId}/messages?pageSize=200`)
      ]);
      const nextWorkspaceId = sessionResponse.workspaceId;
      const workspaceChanged = workspace?.id !== nextWorkspaceId;

      startTransition(() => {
        setSession(sessionResponse);
        setSessionId(targetId);
        setWorkspaceId(nextWorkspaceId);
        setMessages(messagePage.items);
        setRecentSessions((current) => addRecentId(current, targetId));
        if (workspaceChanged) {
          setWorkspace(null);
          setCatalog(null);
          setMirrorStatus(null);
        }
      });
      rememberSession(sessionResponse);
      if (workspaceChanged) {
        void refreshWorkspace(nextWorkspaceId, true);
      }
      setActivity(`Session ${targetId} 已加载`);
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      setSession(null);
      setMessages([]);
      if (isNotFoundError(error)) {
        clearSessionSelection(targetId);
      }
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createSession() {
    if (!workspaceId.trim()) {
      setErrorMessage("请先创建或加载 workspace。");
      return;
    }

    try {
      const created = await request<Session>(`/api/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...(sessionDraft.title.trim() ? { title: sessionDraft.title.trim() } : {}),
          ...(sessionDraft.agentName.trim() ? { agentName: sessionDraft.agentName.trim() } : {})
        })
      });

      lastCursorRef.current = undefined;
      startTransition(() => {
        setEvents([]);
        setSelectedRunId("");
        setRun(null);
        setRunSteps([]);
        setLiveOutput({});
      });
      setShowSessionCreator(false);
      await refreshSession(created.id, true);
      rememberSession(created);
      setActivity(`Session ${created.id} 已创建`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshMessages(quiet = false) {
    if (!sessionId.trim()) {
      return;
    }

    try {
      const messagePage = await request<{ items: Message[] }>(`/api/v1/sessions/${sessionId}/messages?pageSize=200`);
      startTransition(() => {
        setMessages(messagePage.items);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshRun(targetId = selectedRunId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const runResponse = await request<Run>(`/api/v1/runs/${targetId}`);
      startTransition(() => {
        setRun(runResponse);
        setSelectedRunId(targetId);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshRunSteps(targetId = selectedRunId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const page = await request<{ items: RunStep[] }>(`/api/v1/runs/${targetId}/steps?pageSize=200`);
      startTransition(() => {
        setRunSteps(page.items);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function sendMessage() {
    if (!sessionId.trim()) {
      setErrorMessage("请先创建或加载 session。");
      return;
    }

    const content = draftMessage.trim();
    if (!content) {
      return;
    }

    try {
      const accepted = await request<MessageAccepted>(`/api/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          content
        })
      });

      startTransition(() => {
        setDraftMessage("");
        setSelectedRunId(accepted.runId);
        setLiveOutput((current) => ({
          ...current,
          [accepted.runId]: ""
        }));
      });
      if (autoStream) {
        setStreamRevision((current) => current + 1);
      }
      await Promise.all([refreshMessages(true), refreshRun(accepted.runId, true), refreshRunSteps(accepted.runId, true)]);
      setActivity(`消息已入队，run=${accepted.runId}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function cancelCurrentRun() {
    if (!selectedRunId.trim()) {
      return;
    }

    try {
      await request(`/api/v1/runs/${selectedRunId}/cancel`, {
        method: "POST"
      });
      await refreshRun(selectedRunId, true);
      setActivity(`已请求取消 run ${selectedRunId}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function generateOnce() {
    try {
      setGenerateBusy(true);
      const response = await request<ModelGenerateResponse>(
        "/internal/v1/models/generate",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            prompt: modelDraft.prompt.trim(),
            ...(modelDraft.model.trim() ? { model: modelDraft.model.trim() } : {})
          })
        },
        { auth: false }
      );
      setGenerateOutput(response);
      setActivity(`内部模型网关 generate 成功，model=${response.model}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setGenerateBusy(false);
    }
  }

  const handleSessionEvent = useEffectEvent((frame: SseFrame) => {
    const event = {
      id: frame.cursor ?? crypto.randomUUID(),
      cursor: frame.cursor ?? String(Date.now()),
      sessionId,
      runId: typeof frame.data.runId === "string" ? frame.data.runId : undefined,
      event: frame.event as SessionEventContract["event"],
      data: frame.data,
      createdAt: new Date().toISOString()
    } satisfies SessionEventContract;

    if (frame.cursor) {
      lastCursorRef.current = frame.cursor;
    }

    startTransition(() => {
      setEvents((current) => [event, ...current].slice(0, 200));
    });

    if (event.runId) {
      setSelectedRunId((current) => current || event.runId || "");
    }

    if (event.event === "message.delta" && typeof event.runId === "string" && typeof event.data.delta === "string") {
      setLiveOutput((current) => ({
        ...current,
        [event.runId!]: `${current[event.runId!] ?? ""}${event.data.delta as string}`
      }));
    }

    if (event.event === "message.completed" && typeof event.runId === "string") {
      setLiveOutput((current) => {
        const next = { ...current };
        delete next[event.runId!];
        return next;
      });
      scheduleMessagesRefresh();
      scheduleRunRefresh(event.runId);
    }

    if (
      typeof event.runId === "string" &&
      [
        "run.queued",
        "run.started",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "tool.started",
        "tool.completed",
        "tool.failed",
        "agent.switched",
        "agent.delegate.started",
        "agent.delegate.completed",
        "agent.delegate.failed"
      ].includes(event.event)
    ) {
      scheduleRunRefresh(event.runId);
    }

    if (typeof event.runId === "string" && isTerminalRunEvent(event.event)) {
      scheduleMessagesRefresh();
    }

    setActivity(`${event.event}${event.runId ? ` · ${event.runId}` : ""}`);
  });

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      window.clearTimeout(messageRefreshTimerRef.current);
      window.clearTimeout(runRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    void refreshWorkspaceIndex(true);
    void refreshWorkspaceTemplates(true);
    void refreshModelProviders(true);
  }, [connection.baseUrl, connection.token]);

  useEffect(() => {
    if (sessionId.trim()) {
      void refreshSession(sessionId, true);
      return;
    }

    if (workspaceId.trim()) {
      void refreshWorkspace(workspaceId, true);
    }
  }, [connection.baseUrl, connection.token]);

  useEffect(() => {
    if (mainViewMode !== "inspector" || inspectorTab !== "storage") {
      return;
    }

    void refreshStorageOverview(true);
    void refreshStorageTable(selectedStorageTable, true);
    void refreshRedisKeys({ quiet: true });
  }, [mainViewMode, inspectorTab, connection.baseUrl, connection.token]);

  useEffect(() => {
    if (!sessionId.trim() || !autoStream || session?.id !== sessionId) {
      streamAbortRef.current?.abort();
      setStreamState("idle");
      return;
    }

    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    setStreamState("connecting");
    const listeningTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        setStreamState((current) => (current === "connecting" ? "listening" : current));
      }
    }, 1200);

    const query = new URLSearchParams();
    if (streamRunId) {
      query.set("runId", streamRunId);
    }
    if (lastCursorRef.current) {
      query.set("cursor", lastCursorRef.current);
    }

    void (async () => {
      try {
        const headers = new Headers();
        const token = connection.token.trim();
        if (token) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const response = await fetch(
          buildUrl(connection.baseUrl, `/api/v1/sessions/${sessionId}/events${query.size > 0 ? `?${query.toString()}` : ""}`),
          {
            signal: controller.signal,
            headers
          }
        );

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        setStreamState("open");
        await consumeSse(response, handleSessionEvent, controller.signal);
        if (!controller.signal.aborted) {
          setStreamState("idle");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (isNotFoundError(error)) {
            clearSessionSelection(sessionId);
            setActivity(`Session ${sessionId} 不存在，已清除本地选择`);
            setErrorMessage("");
            return;
          }
          setStreamState("error");
          setErrorMessage(toErrorMessage(error));
        }
      }
    })();

    return () => {
      window.clearTimeout(listeningTimer);
      controller.abort();
    };
  }, [
    autoStream,
    connection.baseUrl,
    connection.token,
    filterSelectedRun,
    session?.id,
    streamRunId,
    sessionId,
    streamRevision
  ]);

  const messageFeed = [...messages];
  if (selectedRunId && liveOutput[selectedRunId]) {
    messageFeed.push({
      id: `live:${selectedRunId}`,
      sessionId: sessionId || "live",
      runId: selectedRunId,
      role: "assistant",
      content: liveOutput[selectedRunId],
      createdAt: new Date().toISOString()
    });
  }

  const activeWorkspaceId = session?.workspaceId || workspaceId;
  const activeSavedWorkspace = savedWorkspaces.find((entry) => entry.id === activeWorkspaceId);
  const activeWorkspace = workspace?.id === activeWorkspaceId ? workspace : null;
  const currentWorkspaceName = activeWorkspace?.name ?? activeSavedWorkspace?.name ?? activeWorkspaceId ?? "No workspace";
  const currentSessionName = session?.title?.trim() || session?.id || "No session";
  const latestEvent = deferredEvents[0];

  return (
    <main className="overflow-x-hidden px-3 py-3 md:px-4 md:py-4 xl:h-screen xl:overflow-hidden xl:px-5 xl:py-5">
      <div className="mx-auto max-w-[1680px] xl:flex xl:h-full xl:flex-col xl:min-h-0">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-[color:var(--border)] bg-white/95 px-4 py-3 shadow-[0_12px_30px_rgba(15,15,15,0.04)]">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[color:var(--accent)] text-[color:var(--accent-foreground)]">
              <Bot className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold tracking-[-0.03em] text-[color:var(--foreground)]">Open Agent Harness</p>
              <p className="truncate text-xs text-[color:var(--muted-foreground)]">Workspace: {currentWorkspaceName}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-[#f6f6f3] text-[color:var(--foreground)]">{currentSessionName}</Badge>
            <StatusTile
              icon={Network}
              label="Health"
              value={healthStatus}
              tone={probeTone(healthStatus)}
              compact
            />
            <StatusTile
              icon={Orbit}
              label="Stream"
              value={streamState}
              tone={streamState === "open" ? "emerald" : streamState === "error" ? "rose" : streamState === "listening" ? "emerald" : "sky"}
              compact
            />
          </div>
        </header>

        {errorMessage ? (
          <div className="mb-4 rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {errorMessage}
          </div>
        ) : null}

        <section className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-w-0 xl:min-h-0">
            <Card className="overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className="border-b border-[color:var(--border)] bg-[#fbfbf9] px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--foreground)]">Navigator</p>
                      <p className="text-xs text-[color:var(--muted-foreground)]">{orderedSavedWorkspaces.length} workspaces · {activeWorkspaceSessions.length} sessions</p>
                    </div>
                    {sidebarMode === "workspaces" && !workspaceManagementEnabled ? null : (
                      <button
                        className="inline-flex h-9 items-center justify-center rounded-xl border border-[color:var(--border)] bg-white px-3 text-sm text-[color:var(--foreground)] transition hover:bg-[#f7f7f4]"
                        onClick={() => (sidebarMode === "workspaces" ? setShowWorkspaceCreator((current) => !current) : setShowSessionCreator((current) => !current))}
                      >
                        + New
                      </button>
                    )}
                  </div>
                  <div className="mt-4 flex gap-2 rounded-2xl bg-[#f3f2ed] p-1">
                    <button
                      className={cn(
                        "flex-1 rounded-xl px-3 py-2 text-xs font-medium transition",
                        sidebarMode === "workspaces" ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
                      )}
                      onClick={() => setSidebarMode("workspaces")}
                    >
                      Workspaces
                    </button>
                    <button
                      className={cn(
                        "flex-1 rounded-xl px-3 py-2 text-xs font-medium transition",
                        sidebarMode === "sessions" ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
                      )}
                      onClick={() => setSidebarMode("sessions")}
                    >
                      Sessions
                    </button>
                  </div>
                </div>

                <div className="flex-1 space-y-3 overflow-auto px-3 py-3 xl:min-h-0">
                  {sidebarMode === "workspaces" ? (
                    <>
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Workspace List</div>
                      {showWorkspaceCreator && workspaceManagementEnabled ? (
                        <div className="rounded-[20px] border border-[color:var(--border)] bg-[#f7f6f2] p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-[color:var(--foreground)]">New Workspace</p>
                            <button
                              className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                              onClick={() => setShowWorkspaceCreator(false)}
                            >
                              Close
                            </button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              value={workspaceDraft.name}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  name: event.target.value
                                }))
                              }
                              placeholder="Workspace name"
                            />
                            <Input
                              list="workspace-template-options"
                              value={workspaceDraft.template}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  template: event.target.value
                                }))
                              }
                              placeholder="Template"
                            />
                            <datalist id="workspace-template-options">
                              {workspaceTemplates.map((template) => (
                                <option key={template} value={template} />
                              ))}
                            </datalist>
                            <Input
                              value={workspaceDraft.rootPath}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  rootPath: event.target.value
                                }))
                              }
                              placeholder="Root path"
                            />
                            <div className="flex gap-2 pt-1">
                              <Button className="flex-1" onClick={() => void createWorkspace()}>
                                <FolderPlus className="h-4 w-4" />
                                Create
                              </Button>
                              <Button className="flex-1" variant="secondary" onClick={() => void refreshWorkspaceTemplates()}>
                                <RefreshCw className="h-4 w-4" />
                                Templates
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-1">
                        {orderedSavedWorkspaces.length === 0 ? (
                          <EmptyState title="No workspaces" description="Create or load one." />
                        ) : (
                          orderedSavedWorkspaces.map((entry) => (
                            <WorkspaceSidebarItem
                              key={entry.id}
                              entry={entry}
                              active={entry.id === workspaceId}
                              sessionCount={savedSessions.filter((sessionEntry) => sessionEntry.workspaceId === entry.id).length}
                              canRemove={workspaceManagementEnabled}
                              onSelect={() => {
                                setWorkspaceId(entry.id);
                                void refreshWorkspace(entry.id);
                              }}
                              onRemove={() => void deleteWorkspace(entry.id)}
                            />
                          ))
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Session List</div>
                      {showSessionCreator ? (
                        <div className="rounded-[20px] border border-[color:var(--border)] bg-[#f7f6f2] p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-[color:var(--foreground)]">New Session</p>
                            <button
                              className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                              onClick={() => setShowSessionCreator(false)}
                            >
                              Close
                            </button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              value={sessionDraft.title}
                              onChange={(event) =>
                                setSessionDraft((current) => ({
                                  ...current,
                                  title: event.target.value
                                }))
                              }
                              placeholder="Session title"
                            />
                            <Input
                              value={sessionDraft.agentName}
                              onChange={(event) =>
                                setSessionDraft((current) => ({
                                  ...current,
                                  agentName: event.target.value
                                }))
                              }
                              placeholder="Agent"
                            />
                            <div className="flex gap-2 pt-1">
                              <Button className="flex-1" onClick={() => void createSession()}>
                                Create
                              </Button>
                              <Button className="flex-1" variant="secondary" onClick={() => void refreshSession()}>
                                Load
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-1">
                        {activeWorkspaceSessions.length === 0 ? (
                          <EmptyState title="No sessions" description="Select a workspace, then create one." />
                        ) : (
                          activeWorkspaceSessions.map((entry) => (
                            <SessionSidebarItem
                              key={entry.id}
                              entry={entry}
                              active={entry.id === sessionId}
                              onSelect={() => {
                                setSessionId(entry.id);
                                void refreshSession(entry.id);
                              }}
                              onRemove={() => removeSavedSession(entry.id)}
                            />
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="border-t border-[color:var(--border)] bg-[#fbfbf9] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToggleChip active={autoStream} label="Auto SSE" onClick={() => setAutoStream((current) => !current)} />
                    <ToggleChip active={filterSelectedRun} label="Current Run" onClick={() => setFilterSelectedRun((current) => !current)} />
                    <button
                      className="rounded-full border border-[color:var(--border)] bg-white px-3 py-1.5 text-xs font-medium text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                      onClick={() => setShowConnectionPanel((current) => !current)}
                    >
                      Server
                    </button>
                  </div>
                  {showConnectionPanel ? (
                    <div className="mt-3 space-y-2 rounded-[18px] border border-[color:var(--border)] bg-white p-3">
                      <Input
                        value={connection.baseUrl}
                        onChange={(event) =>
                          setConnection((current) => ({
                            ...current,
                            baseUrl: event.target.value
                          }))
                        }
                        placeholder="Base URL"
                      />
                      <Input
                        value={connection.token}
                        onChange={(event) =>
                          setConnection((current) => ({
                            ...current,
                            token: event.target.value
                          }))
                        }
                        placeholder="Bearer token (optional)"
                      />
                      <div className="flex gap-2">
                        <Button className="flex-1" variant="secondary" onClick={() => void pingHealth()}>
                          Health
                        </Button>
                        <Button className="flex-1" variant="ghost" onClick={() => setStreamRevision((current) => current + 1)}>
                          SSE
                        </Button>
                      </div>
                      {healthReport || readinessReport ? (
                        <div className="grid gap-2 pt-1">
                          <StatusTile
                            icon={Activity}
                            label="Readiness"
                            value={readinessReport?.status ?? "unknown"}
                            tone={probeTone(readinessReport?.status ?? "idle")}
                          />
                          <div className="grid gap-2 sm:grid-cols-2">
                            <StatusTile
                              icon={Database}
                              label="Postgres"
                              value={`${healthReport?.storage.primary ?? "unknown"} · ${healthReport?.checks.postgres ?? "unknown"}`}
                              tone={probeTone(healthReport?.checks.postgres ?? "idle")}
                            />
                            <StatusTile
                              icon={Network}
                              label="Events"
                              value={`${healthReport?.storage.events ?? "unknown"} · ${healthReport?.checks.redisEvents ?? "unknown"}`}
                              tone={probeTone(healthReport?.checks.redisEvents ?? "idle")}
                            />
                            <StatusTile
                              icon={Orbit}
                              label="Run Queue"
                              value={`${healthReport?.storage.runQueue ?? "unknown"} · ${healthReport?.checks.redisRunQueue ?? "unknown"}`}
                              tone={probeTone(healthReport?.checks.redisRunQueue ?? "idle")}
                            />
                            <StatusTile
                              icon={Bot}
                              label="Process"
                              value={
                                healthReport
                                  ? `${healthReport.process.label} · ${healthReport.process.execution}`
                                  : "unknown"
                              }
                              tone={probeTone(healthReport?.process.execution === "none" ? "degraded" : "ok")}
                            />
                            <StatusTile
                              icon={Database}
                              label="Mirror"
                              value={
                                healthReport
                                  ? `${healthReport.checks.historyMirror} · ${healthReport.mirror.enabledWorkspaces} enabled / ${healthReport.mirror.errorWorkspaces} error / ${healthReport.mirror.missingWorkspaces} missing`
                                  : "unknown"
                              }
                              tone={probeTone(healthReport?.checks.historyMirror ?? "idle")}
                            />
                          </div>
                        </div>
                      ) : null}
                      <div className="pt-1">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
                            Model Providers
                          </p>
                          <button
                            className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                            onClick={() => void refreshModelProviders()}
                          >
                            Refresh
                          </button>
                        </div>
                        {modelProviders.length === 0 ? (
                          <div className="rounded-[18px] border border-[color:var(--border)] bg-[#f7f6f2] px-3 py-3 text-xs leading-6 text-[color:var(--muted-foreground)]">
                            暂无 provider 列表。
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {modelProviders.map((provider) => (
                              <div
                                key={provider.id}
                                className="rounded-[18px] border border-[color:var(--border)] bg-[#f7f6f2] px-3 py-3"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge>{provider.id}</Badge>
                                  <span className="text-xs text-[color:var(--muted-foreground)]">{provider.packageName}</span>
                                  <span className="text-xs text-[color:var(--muted-foreground)]">
                                    {provider.requiresUrl ? "requires url" : "url optional"}
                                  </span>
                                </div>
                                <p className="mt-2 text-sm leading-6 text-[color:var(--foreground)]">{provider.description}</p>
                                <p className="mt-2 text-xs leading-6 text-[color:var(--muted-foreground)]">
                                  {provider.useCases.join(" · ")}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
          </aside>

          <section className="min-w-0 xl:min-h-0">
            <Card className="overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className="border-b border-[color:var(--border)] bg-white/96 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h1 className="truncate text-[28px] font-semibold tracking-[-0.04em] text-[color:var(--foreground)]">
                        {mainViewMode === "conversation" ? "Conversation" : "Inspector"}
                      </h1>
                      <p className="truncate text-sm text-[color:var(--muted-foreground)]">
                        {mainViewMode === "conversation" ? `${currentSessionName} · ${streamState}` : activity}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex gap-2 rounded-2xl bg-[#f3f2ed] p-1">
                        <InspectorTabButton
                          label="Conversation"
                          active={mainViewMode === "conversation"}
                          onClick={() => setMainViewMode("conversation")}
                        />
                        <InspectorTabButton
                          label="Inspector"
                          active={mainViewMode === "inspector"}
                          onClick={() => setMainViewMode("inspector")}
                        />
                      </div>
                      <Badge className="bg-[#f6f6f3] text-[color:var(--foreground)]">{currentWorkspaceName}</Badge>
                      {latestEvent ? <Badge>{latestEvent.event}</Badge> : null}
                    </div>
                  </div>
                  {mainViewMode === "inspector" ? (
                    <div className="mt-4 flex flex-wrap gap-2 rounded-2xl bg-[#f3f2ed] p-1">
                      <InspectorTabButton label="Run" active={inspectorTab === "run"} onClick={() => setInspectorTab("run")} />
                      <InspectorTabButton label="LLM" active={inspectorTab === "llm"} onClick={() => setInspectorTab("llm")} />
                      <InspectorTabButton label="Steps" active={inspectorTab === "steps"} onClick={() => setInspectorTab("steps")} />
                      <InspectorTabButton label="Events" active={inspectorTab === "events"} onClick={() => setInspectorTab("events")} />
                      <InspectorTabButton label="Catalog" active={inspectorTab === "catalog"} onClick={() => setInspectorTab("catalog")} />
                      <InspectorTabButton label="Storage" active={inspectorTab === "storage"} onClick={() => setInspectorTab("storage")} />
                      <InspectorTabButton label="Model" active={inspectorTab === "model"} onClick={() => setInspectorTab("model")} />
                    </div>
                  ) : null}
                </div>

                {mainViewMode === "conversation" ? (
                  <>
                    <div className="flex-1 overflow-auto xl:min-h-0">
                      {messageFeed.length === 0 ? (
                        <div className="flex h-full items-center justify-center px-6 py-16">
                          <div className="max-w-md text-center">
                            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#f2f2ee] text-[color:var(--foreground)]">
                              <Bot className="h-5 w-5" />
                            </div>
                            <h2 className="text-2xl font-semibold tracking-[-0.04em] text-[color:var(--foreground)]">Ready to chat</h2>
                            <p className="mt-2 text-sm leading-7 text-[color:var(--muted-foreground)]">Select a workspace, open a session, and start the conversation.</p>
                          </div>
                        </div>
                      ) : (
                        messageFeed.map((message) => {
                          const isUser = message.role === "user";
                          const isStreaming = message.id.startsWith("live:");

                          return (
                            <article
                              key={message.id}
                              className={cn(
                                "border-t border-[color:var(--border)] transition-colors",
                                isUser ? "bg-[#f7f7f4]" : "bg-white"
                              )}
                            >
                              <div className="mx-auto grid max-w-3xl grid-cols-[44px_minmax(0,1fr)] gap-4 px-5 py-6 md:px-8">
                                <div
                                  className={cn(
                                    "flex h-11 w-11 items-center justify-center rounded-full text-sm font-semibold",
                                    isUser ? "bg-[#e9e7df] text-[color:var(--foreground)]" : "bg-[color:var(--accent)] text-[color:var(--accent-foreground)]"
                                  )}
                                >
                                  {isUser ? "U" : "AI"}
                                </div>
                                <div className="min-w-0">
                                  <div className="mb-3 flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium text-[color:var(--foreground)]">{isUser ? "You" : "Assistant"}</span>
                                    {message.runId ? (
                                      <button
                                        className="rounded-full border border-[color:var(--border)] bg-white px-2.5 py-1 text-[11px] text-[color:var(--muted-foreground)] transition hover:border-black/10 hover:text-[color:var(--foreground)]"
                                        onClick={() => {
                                          setSelectedRunId(message.runId ?? "");
                                          setMainViewMode("inspector");
                                          setInspectorTab("llm");
                                          void Promise.all([refreshRun(message.runId, true), refreshRunSteps(message.runId, true)]);
                                        }}
                                      >
                                        {message.runId}
                                      </button>
                                    ) : null}
                                    {isStreaming ? <span className="text-[11px] uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">Streaming</span> : null}
                                    <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                                  </div>
                                  <pre className="whitespace-pre-wrap break-words text-[15px] leading-8 tracking-[-0.01em] text-[color:var(--foreground)]">{message.content}</pre>
                                </div>
                              </div>
                            </article>
                          );
                        })
                      )}
                    </div>

                    <div className="border-t border-[color:var(--border)] bg-white/96 px-4 py-4 md:px-6">
                      <div className="mx-auto max-w-3xl">
                        <div className="rounded-[26px] border border-[color:var(--border)] bg-[#fbfbf9] p-3 shadow-[0_10px_26px_rgba(15,15,15,0.05)]">
                          <Textarea
                            value={draftMessage}
                            onChange={(event) => setDraftMessage(event.target.value)}
                            placeholder="Message the current session"
                            className="min-h-28 border-0 bg-transparent px-1 py-1 shadow-none focus:ring-0"
                          />
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--muted-foreground)]">
                              <span>{selectedRunId ? `Run ${selectedRunId}` : "No run selected"}</span>
                              <span>{streamState}</span>
                            </div>
                            <div className="flex gap-2">
                              <Button variant="ghost" size="sm" onClick={() => void refreshMessages()}>
                                <RefreshCw className="h-4 w-4" />
                                Refresh
                              </Button>
                              <Button className="min-w-[92px]" onClick={() => void sendMessage()}>
                                <Send className="h-4 w-4" />
                                Send
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 space-y-3 overflow-auto px-4 py-4 xl:min-h-0">
                    {inspectorTab === "run" ? (
                      <>
                        <div className="space-y-2 rounded-[20px] border border-[color:var(--border)] bg-[#f7f6f2] p-3">
                          <Input
                            value={selectedRunId}
                            onChange={(event) => setSelectedRunId(event.target.value)}
                            placeholder="Selected run"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <Button variant="secondary" onClick={() => void refreshRun()}>
                              Load Run
                            </Button>
                            <Button variant="secondary" onClick={() => void refreshRunSteps()}>
                              Load Steps
                            </Button>
                          </div>
                          <Button variant="destructive" onClick={() => void cancelCurrentRun()}>
                            <CircleSlash2 className="h-4 w-4" />
                            Cancel Run
                          </Button>
                        </div>
                        {run ? <EntityPreview title={run.id} data={run} /> : <EmptyState title="No run" description="Pick a run from the conversation." />}
                      </>
                    ) : null}

                    {inspectorTab === "llm" ? (
                      <>
                        <div className="grid gap-3 2xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.88fr)]">
                          <div className="space-y-3">
                            <SessionTraceOverviewCard
                              session={session}
                              run={run}
                              workspace={workspace}
                              sessionName={currentSessionName}
                              workspaceName={currentWorkspaceName}
                              modelCallCount={modelCallTraces.length}
                              storedMessageCounts={storedMessageCounts}
                              latestModelMessageCounts={latestModelMessageCounts}
                              resolvedModelNames={resolvedModelNames}
                              resolvedModelRefs={resolvedModelRefs}
                              runtimeTools={allRuntimeTools}
                              runtimeToolNames={allRuntimeToolNames}
                              activeToolNames={allAdvertisedToolNames}
                              toolServers={allToolServers}
                              latestTrace={latestModelCallTrace}
                              onDownload={downloadSessionTrace}
                            />
                            <ModelCallTimelineCard traces={modelCallTraces} />
                          </div>
                          <div className="space-y-3">
                            <SessionContextCard
                              systemMessages={composedSystemMessages}
                              firstTrace={firstModelCallTrace}
                              messages={messages}
                              storedMessageCounts={storedMessageCounts}
                            />
                          </div>
                        </div>
                      </>
                    ) : null}

                    {inspectorTab === "steps" ? (
                      runSteps.length === 0 ? (
                        <EmptyState title="No steps" description="Run steps appear here." />
                      ) : (
                        runSteps.map((step) => (
                          <article key={step.id} className="rounded-[18px] border border-[color:var(--border)] bg-white p-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <Badge>{step.seq}</Badge>
                              <Badge>{step.stepType}</Badge>
                              <Badge className={statusTone(step.status)}>{step.status}</Badge>
                              {step.name ? <Badge>{step.name}</Badge> : null}
                            </div>
                            <div className="space-y-2">
                              <JsonBlock title="Input" value={step.input ?? {}} />
                              <JsonBlock title="Output" value={step.output ?? {}} />
                            </div>
                          </article>
                        ))
                      )
                    ) : null}

                    {inspectorTab === "events" ? (
                      deferredEvents.length === 0 ? (
                        <EmptyState title="No events" description="SSE events appear here." />
                      ) : (
                        deferredEvents.map((event) => (
                          <article key={event.id} className="rounded-[18px] border border-[color:var(--border)] bg-white p-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <Badge>{event.event}</Badge>
                              {event.runId ? <Badge>{event.runId}</Badge> : null}
                              <span className="text-xs text-[color:var(--muted-foreground)]">cursor {event.cursor}</span>
                            </div>
                            <JsonBlock title={formatTimestamp(event.createdAt)} value={event.data} />
                          </article>
                        ))
                      )
                    ) : null}

                    {inspectorTab === "catalog" ? (
                      catalog ? (
                        <>
                          {workspace ? (
                            <div className="rounded-[20px] border border-[color:var(--border)] bg-[#f7f6f2] p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-[color:var(--foreground)]">Mirror Sync</p>
                                  <p className="mt-1 text-xs leading-6 text-[color:var(--muted-foreground)]">
                                    将中心历史异步同步到当前 workspace 的 <code>.openharness/data/history.db</code>。
                                  </p>
                                </div>
                                <Badge className={workspace.historyMirrorEnabled ? "bg-emerald-600 text-white" : ""}>
                                  {workspace.historyMirrorEnabled ? "Enabled" : "Disabled"}
                                </Badge>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Button
                                  variant={workspace.historyMirrorEnabled ? "secondary" : "default"}
                                  size="sm"
                                  disabled={mirrorToggleBusy || workspace.kind !== "project" || workspace.historyMirrorEnabled}
                                  onClick={() => void updateWorkspaceHistoryMirrorEnabled(true)}
                                >
                                  Enable
                                </Button>
                                <Button
                                  variant={!workspace.historyMirrorEnabled ? "secondary" : "default"}
                                  size="sm"
                                  disabled={mirrorToggleBusy || workspace.kind !== "project" || !workspace.historyMirrorEnabled}
                                  onClick={() => void updateWorkspaceHistoryMirrorEnabled(false)}
                                >
                                  Disable
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={mirrorToggleBusy || mirrorRebuildBusy}
                                  onClick={() => void refreshWorkspace(workspace.id, true)}
                                >
                                  Refresh
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={mirrorRebuildBusy || mirrorToggleBusy || workspace.kind !== "project" || !workspace.historyMirrorEnabled}
                                  onClick={() => void rebuildWorkspaceHistoryMirror()}
                                >
                                  Rebuild
                                </Button>
                              </div>
                              {mirrorStatus ? (
                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                  <CatalogLine label="mirrorState" value={mirrorStatus.state} />
                                  <CatalogLine label="lastEventId" value={mirrorStatus.lastEventId ? String(mirrorStatus.lastEventId) : "n/a"} />
                                  <CatalogLine label="lastSyncedAt" value={mirrorStatus.lastSyncedAt ? formatTimestamp(mirrorStatus.lastSyncedAt) : "n/a"} />
                                  <CatalogLine label="dbPath" value={mirrorStatus.dbPath ?? "n/a"} />
                                </div>
                              ) : null}
                              {mirrorStatus?.errorMessage ? (
                                <div className="mt-3 rounded-[18px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-6 text-rose-700">
                                  {mirrorStatus.errorMessage}
                                </div>
                              ) : null}
                              {workspace.kind !== "project" ? (
                                <p className="mt-2 text-xs text-[color:var(--muted-foreground)]">
                                  `chat` workspace 不支持本地 history mirror。
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="grid gap-2">
                            <CatalogLine label="agents" value={catalog.agents.length} />
                            <CatalogLine label="models" value={catalog.models.length} />
                            <CatalogLine label="actions" value={catalog.actions.length} />
                            <CatalogLine label="skills" value={catalog.skills.length} />
                            <CatalogLine label="tools" value={catalog.tools?.length ?? catalog.mcp?.length ?? 0} />
                            <CatalogLine label="hooks" value={catalog.hooks.length} />
                            <CatalogLine label="nativeTools" value={catalog.nativeTools.length} />
                          </div>
                          <EntityPreview title={catalog.workspaceId} data={catalog} />
                        </>
                      ) : (
                        <EmptyState title="No catalog" description="Load a workspace first." />
                      )
                    ) : null}

                    {inspectorTab === "storage" ? (
                      <StorageInspectorCard
                        overview={storageOverview}
                        tablePage={storageTablePage}
                        selectedTable={selectedStorageTable}
                        onSelectTable={(table) => void refreshStorageTable(table)}
                        redisKeyPattern={redisKeyPattern}
                        onRedisKeyPatternChange={setRedisKeyPattern}
                        redisKeyPage={redisKeyPage}
                        selectedRedisKey={selectedRedisKey}
                        onSelectRedisKey={(key) => void refreshRedisKeyDetail(key)}
                        redisKeyDetail={redisKeyDetail}
                        onRefreshOverview={() => void refreshStorageOverview()}
                        onRefreshTable={() => void refreshStorageTable()}
                        onRefreshRedisKeys={() => void refreshRedisKeys()}
                        onLoadMoreRedisKeys={() =>
                          void refreshRedisKeys(redisKeyPage?.nextCursor ? { cursor: redisKeyPage.nextCursor } : undefined)
                        }
                        onRefreshRedisKey={() => void refreshRedisKeyDetail()}
                        onDeleteRedisKey={() => void deleteRedisKey()}
                        busy={storageBusy}
                      />
                    ) : null}

                    {inspectorTab === "model" ? (
                      <div className="space-y-3">
                        <Input
                          value={modelDraft.model}
                          onChange={(event) =>
                            setModelDraft((current) => ({
                              ...current,
                              model: event.target.value
                            }))
                          }
                          placeholder="Model"
                        />
                        <Textarea
                          value={modelDraft.prompt}
                          onChange={(event) =>
                            setModelDraft((current) => ({
                              ...current,
                              prompt: event.target.value
                            }))
                          }
                          className="min-h-28"
                          placeholder="Prompt"
                        />
                        <Button onClick={() => void generateOnce()} disabled={generateBusy}>
                          <Sparkles className="h-4 w-4" />
                          Generate
                        </Button>
                        {generateOutput ? <EntityPreview title={generateOutput.model} data={generateOutput} /> : <EmptyState title="No output" description="Generate output appears here." />}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </Card>
          </section>
        </section>
      </div>
    </main>
  );
}

function WorkspaceSidebarItem(props: {
  entry: SavedWorkspaceRecord;
  active: boolean;
  sessionCount: number;
  canRemove: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-[18px] px-3 py-3 transition",
        props.active ? "bg-[#f3f2ed] shadow-[inset_0_0_0_1px_rgba(28,28,28,0.04)]" : "hover:bg-[#f7f6f2]"
      )}
    >
      <div className={cn("absolute left-0 top-2 bottom-2 w-1 rounded-full transition", props.active ? "bg-[color:var(--accent)]" : "bg-transparent")} />
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full",
            props.active ? "bg-[color:var(--accent)] text-white" : "bg-[#eceae3] text-[color:var(--muted-foreground)]"
          )}
        >
          <Folder className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[color:var(--foreground)]">{props.entry.name}</p>
          <p className="truncate text-xs text-[color:var(--muted-foreground)]">
            {props.entry.template ? `${props.entry.template} · ` : ""}
            {props.sessionCount} sessions
          </p>
        </div>
      </button>
      {props.canRemove ? (
        <button
          className="rounded-lg p-2 text-[color:var(--muted-foreground)] opacity-0 transition hover:bg-black/4 hover:text-[color:var(--foreground)] group-hover:opacity-100"
          onClick={props.onRemove}
          title="删除 workspace"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function SessionSidebarItem(props: {
  entry: SavedSessionRecord;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-[18px] px-3 py-3 transition",
        props.active ? "bg-[#f3f2ed] shadow-[inset_0_0_0_1px_rgba(28,28,28,0.04)]" : "hover:bg-[#f7f6f2]"
      )}
    >
      <div className={cn("absolute left-0 top-2 bottom-2 w-1 rounded-full transition", props.active ? "bg-[color:var(--accent)]" : "bg-transparent")} />
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full",
            props.active ? "bg-[color:var(--accent)] text-white" : "bg-[#eceae3] text-[color:var(--muted-foreground)]"
          )}
        >
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[color:var(--foreground)]">{props.entry.title || "Untitled session"}</p>
          <p className="truncate text-xs text-[color:var(--muted-foreground)]">
            {props.entry.agentName ? `${props.entry.agentName} · ` : ""}
            {formatTimestamp(props.entry.createdAt)}
          </p>
        </div>
      </button>
      <button
        className="rounded-lg p-2 text-[color:var(--muted-foreground)] opacity-0 transition hover:bg-black/4 hover:text-[color:var(--foreground)] group-hover:opacity-100"
        onClick={props.onRemove}
        title="从本地侧栏移除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function ToggleChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-black/10 bg-black text-white"
          : "border-[color:var(--border)] bg-white/74 text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InspectorTabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-xl px-3 py-1.5 text-xs font-medium transition",
        props.active ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InsightRow(props: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] border border-[color:var(--border)] bg-[#f7f7f4] px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">{props.label}</p>
      <p className="mt-2 truncate text-sm font-medium text-[color:var(--foreground)]">{props.value}</p>
    </div>
  );
}

function EntityPreview(props: { title: string; data: unknown }) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-[color:var(--border)] bg-white/76">
      <div className="border-b border-[color:var(--border)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
        {props.title}
      </div>
      <pre className="max-h-72 overflow-auto p-4 text-xs leading-6 text-slate-700">{prettyJson(props.data)}</pre>
    </div>
  );
}

function JsonBlock(props: { title: string; value: unknown }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-[color:var(--border)] bg-[#fcfbf7]">
      <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
        {props.title}
      </div>
      <pre className="max-h-64 overflow-auto p-3 text-xs leading-6 text-slate-700">{prettyJson(props.value)}</pre>
    </div>
  );
}

function modelMessageTone(role: Message["role"]) {
  switch (role) {
    case "system":
      return "bg-slate-900 text-white";
    case "user":
      return "bg-sky-100 text-sky-700";
    case "assistant":
      return "bg-emerald-100 text-emerald-700";
    case "tool":
      return "bg-amber-100 text-amber-700";
    default:
      return "";
  }
}

function InspectorPanelHeader(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.title}</p>
        <p className="mt-1 text-xs leading-6 text-[color:var(--muted-foreground)]">{props.description}</p>
      </div>
      {props.action ? <div className="shrink-0">{props.action}</div> : null}
    </div>
  );
}

function InspectorDisclosure(props: {
  title: string;
  description?: string;
  badge?: string | number;
  children: ReactNode;
}) {
  return (
    <details className="overflow-hidden rounded-[18px] border border-[color:var(--border)] bg-[#fcfbf7]">
      <summary className="list-none cursor-pointer px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[color:var(--foreground)]">{props.title}</p>
            {props.description ? <p className="mt-1 text-xs leading-6 text-[color:var(--muted-foreground)]">{props.description}</p> : null}
          </div>
          {props.badge !== undefined ? <Badge>{String(props.badge)}</Badge> : null}
        </div>
      </summary>
      <div className="border-t border-[color:var(--border)] p-3">{props.children}</div>
    </details>
  );
}

function ToolNameChips(props: { names: string[]; emptyLabel: string }) {
  if (props.names.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">{props.emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {props.names.map((name) => (
        <Badge key={name}>{name}</Badge>
      ))}
    </div>
  );
}

function RuntimeToolList(props: { tools: ModelCallTraceRuntimeTool[] }) {
  if (props.tools.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No runtime tool definitions recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.tools.map((tool) => (
        <div key={tool.name} className="rounded-[16px] border border-[color:var(--border)] bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{tool.name}</Badge>
            {tool.retryPolicy ? <Badge>{tool.retryPolicy}</Badge> : null}
          </div>
          {tool.description ? <p className="mt-2 text-xs leading-6 text-slate-700">{tool.description}</p> : null}
          {"inputSchema" in tool ? (
            <div className="mt-3">
              <JsonBlock title="Input Schema" value={tool.inputSchema} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ToolServerList(props: { servers: ModelCallTraceToolServer[] }) {
  if (props.servers.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No external tool server metadata recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.servers.map((server) => (
        <div key={server.name} className="rounded-[16px] border border-[color:var(--border)] bg-white px-3 py-2 text-xs leading-6 text-slate-700">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{server.name}</Badge>
            {server.transportType ? <Badge>{server.transportType}</Badge> : null}
            {server.toolPrefix ? <Badge>{server.toolPrefix}</Badge> : null}
            {server.timeout !== undefined ? <Badge>{`${server.timeout}ms`}</Badge> : null}
          </div>
          {server.include && server.include.length > 0 ? <p className="mt-2">include: {server.include.join(", ")}</p> : null}
          {server.exclude && server.exclude.length > 0 ? <p className="mt-1">exclude: {server.exclude.join(", ")}</p> : null}
        </div>
      ))}
    </div>
  );
}

function ModelMessageList(props: { traceId: string; messages: ModelCallTraceMessage[] }) {
  if (props.messages.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No recorded model-facing messages.</p>;
  }

  return (
    <div className="space-y-2">
      {props.messages.map((message, index) => (
        <div key={`${props.traceId}:message:${index}`} className="rounded-[16px] border border-[color:var(--border)] bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{index + 1}</Badge>
            <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
              {message.role}
            </span>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{message.content}</pre>
        </div>
      ))}
    </div>
  );
}

function SessionTraceOverviewCard(props: {
  session: Session | null;
  run: Run | null;
  workspace: Workspace | null;
  sessionName: string;
  workspaceName: string;
  modelCallCount: number;
  storedMessageCounts: ReturnType<typeof countMessagesByRole>;
  latestModelMessageCounts: ReturnType<typeof countMessagesByRole>;
  resolvedModelNames: string[];
  resolvedModelRefs: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  latestTrace: ModelCallTrace | null;
  onDownload: () => void;
}) {
  return (
    <section className="space-y-3 rounded-[20px] border border-[color:var(--border)] bg-white p-4">
      <InspectorPanelHeader
        title="LLM Trace Summary"
        description="先看这次 session / run 的核心上下文，再按需展开具体的 model call、tool 和原始 payload。"
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={!props.session && props.modelCallCount === 0}
            onClick={props.onDownload}
          >
            <Download className="h-4 w-4" />
            Download JSON
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Badge>{props.workspaceName}</Badge>
        <Badge>{props.sessionName}</Badge>
        {props.run?.id ? <Badge>{props.run.id}</Badge> : null}
        <Badge className={statusTone(props.run?.status ?? "idle")}>{props.run?.status ?? "no-run"}</Badge>
        <Badge>{`${props.modelCallCount} model calls`}</Badge>
        {props.latestTrace?.input.model ? <Badge>{`latest ${props.latestTrace.input.model}`}</Badge> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Workspace" value={props.workspace?.id ?? props.workspaceName} />
        <InsightRow label="Session" value={props.session?.id ?? props.sessionName} />
        <InsightRow label="Run" value={props.run?.id ?? "n/a"} />
        <InsightRow label="Agent" value={props.run?.effectiveAgentName ?? props.session?.activeAgentName ?? "n/a"} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Run Status" value={props.run?.status ?? "n/a"} />
        <InsightRow label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
        <InsightRow
          label="Stored Messages"
          value={`S ${props.storedMessageCounts.system} · U ${props.storedMessageCounts.user} · A ${props.storedMessageCounts.assistant} · T ${props.storedMessageCounts.tool}`}
        />
        <InsightRow
          label="Latest Call Messages"
          value={`S ${props.latestModelMessageCounts.system} · U ${props.latestModelMessageCounts.user} · A ${props.latestModelMessageCounts.assistant} · T ${props.latestModelMessageCounts.tool}`}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="resolved models" value={props.resolvedModelNames.length} />
        <CatalogLine label="runtime tools" value={props.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={props.activeToolNames.length} />
        <CatalogLine label="tool servers" value={props.toolServers.length} />
      </div>

      <InspectorDisclosure
        title="Resolved Models"
        description="这里汇总 run 中所有 model call 实际解析到的模型名与 canonical ref。"
        badge={props.resolvedModelNames.length + props.resolvedModelRefs.length}
      >
        <div className="space-y-3">
          <ToolNameChips names={props.resolvedModelNames} emptyLabel="No resolved model names recorded." />
          {props.resolvedModelRefs.length > 0 ? (
            <div className="space-y-2">
              {props.resolvedModelRefs.map((ref) => (
                <div key={ref} className="rounded-[16px] border border-[color:var(--border)] bg-white px-3 py-2 text-xs leading-6 text-slate-700">
                  {ref}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--muted-foreground)]">No canonical model refs recorded.</p>
          )}
        </div>
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Tools Snapshot"
        description="`runtime tools` 是本次真正注入 AI SDK 的工具定义；`active tools` 是当前 agent 对模型宣告可用的工具名快照。"
        badge={props.runtimeTools.length}
      >
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Names</p>
            <ToolNameChips names={props.runtimeToolNames} emptyLabel="No runtime tool names recorded." />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Active Tool Names</p>
            <ToolNameChips names={props.activeToolNames} emptyLabel="No active tool names recorded." />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Definitions</p>
            <RuntimeToolList tools={props.runtimeTools} />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">External Tool Servers</p>
            <ToolServerList servers={props.toolServers} />
          </div>
        </div>
      </InspectorDisclosure>
    </section>
  );
}

function SessionContextCard(props: {
  systemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
  storedMessageCounts: ReturnType<typeof countMessagesByRole>;
}) {
  return (
    <section className="space-y-3 rounded-[20px] border border-[color:var(--border)] bg-white p-4">
      <InspectorPanelHeader
        title="Session Context"
        description="这里集中看 session 持久化消息，以及首个 model call 中真正送给 LLM 的 system prompt。"
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow
          label="Stored Timeline"
          value={`S ${props.storedMessageCounts.system} · U ${props.storedMessageCounts.user} · A ${props.storedMessageCounts.assistant} · T ${props.storedMessageCounts.tool}`}
        />
        <InsightRow label="System Prompt Source" value={props.firstTrace ? `step ${props.firstTrace.seq}` : "n/a"} />
      </div>

      <InspectorDisclosure
        title="Composed System Prompt"
        description="读取首个 model call 的 system message 列表。当前 runtime 会将多个前置 system message 合并后再发送。"
        badge={props.systemMessages.length}
      >
        {props.systemMessages.length === 0 ? (
          <EmptyState title="No system prompt" description="Load a run with model calls to inspect system messages." />
        ) : (
          <div className="space-y-2">
            {props.systemMessages.map((message, index) => (
              <div key={`system-prompt:${index}`} className="rounded-[16px] border border-[color:var(--border)] bg-white p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{index + 1}</Badge>
                  <Badge>system</Badge>
                </div>
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{message.content}</pre>
              </div>
            ))}
          </div>
        )}
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Stored Session Messages"
        description="runtime 持久化后的消息时间线，包含 runId、toolName、toolCallId 以及 message metadata。"
        badge={props.messages.length}
      >
        {props.messages.length === 0 ? (
          <EmptyState title="No session messages" description="Open a session to inspect stored message records." />
        ) : (
          <div className="space-y-2">
            {props.messages.map((message) => (
              <article key={message.id} className="rounded-[16px] border border-[color:var(--border)] bg-white p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{message.role}</Badge>
                  {message.runId ? <Badge>{message.runId}</Badge> : null}
                  {message.toolName ? <Badge>{message.toolName}</Badge> : null}
                  {message.toolCallId ? <Badge>{message.toolCallId}</Badge> : null}
                  <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{message.content}</pre>
                {message.metadata ? (
                  <div className="mt-3">
                    <JsonBlock title="Metadata" value={message.metadata} />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </InspectorDisclosure>
    </section>
  );
}

function ModelCallTimelineCard(props: { traces: ModelCallTrace[] }) {
  return (
    <section className="space-y-3 rounded-[20px] border border-[color:var(--border)] bg-white p-4">
      <InspectorPanelHeader
        title="Model Call Timeline"
        description="按 step 顺序查看每次调用真正送给模型的 message list、tool 上下文、tool call 结果和原始 payload。"
      />
      {props.traces.length === 0 ? (
        <EmptyState title="No LLM trace" description="Load run steps to inspect the exact model-facing message list." />
      ) : (
        <div className="space-y-3">
          {props.traces.map((trace) => (
            <ModelCallTraceCard key={trace.id} trace={trace} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModelCallTraceCard(props: { trace: ModelCallTrace }) {
  const { trace } = props;

  return (
    <article className="rounded-[18px] border border-[color:var(--border)] bg-[#fcfbf7] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{`step ${trace.seq}`}</Badge>
        <Badge>{trace.name ?? trace.input.model ?? "model_call"}</Badge>
        <Badge className={statusTone(trace.status)}>{trace.status}</Badge>
        {trace.agentName ? <Badge>{trace.agentName}</Badge> : null}
        {trace.input.provider ? <Badge>{trace.input.provider}</Badge> : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Model" value={trace.input.model ?? "n/a"} />
        <InsightRow label="Canonical Ref" value={trace.input.canonicalModelRef ?? "n/a"} />
        <InsightRow label="Messages" value={String(trace.input.messageCount ?? trace.input.messages.length)} />
        <InsightRow label="Finish" value={trace.output.finishReason ?? "n/a"} />
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="runtime tools" value={trace.input.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={trace.input.activeToolNames.length} />
        <CatalogLine label="tool calls" value={trace.output.toolCalls.length} />
        <CatalogLine label="tool results" value={trace.output.toolResults.length} />
      </div>

      <div className="mt-3 space-y-2">
        <InspectorDisclosure
          title="LLM Messages"
          description="这一段就是当前 step 真正送给模型的 message list。"
          badge={trace.input.messages.length}
        >
          <ModelMessageList traceId={trace.id} messages={trace.input.messages} />
        </InspectorDisclosure>

        <InspectorDisclosure
          title="Tooling"
          description="查看这次调用里真正注入的 runtime tools、agent 声明的 active tools，以及外部 tool server 信息。"
          badge={trace.input.runtimeTools.length}
        >
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Names</p>
              <ToolNameChips names={trace.input.runtimeToolNames} emptyLabel="No runtime tool names recorded." />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Active Tool Names</p>
              <ToolNameChips names={trace.input.activeToolNames} emptyLabel="No active tool names recorded." />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Definitions</p>
              <RuntimeToolList tools={trace.input.runtimeTools} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">External Tool Servers</p>
              <ToolServerList servers={trace.input.toolServers} />
            </div>
          </div>
        </InspectorDisclosure>

        {(trace.output.toolCalls.length > 0 || trace.output.toolResults.length > 0) ? (
          <InspectorDisclosure
            title="Tool Calls And Results"
            description="查看这次 model call 产生的 tool 调用参数，以及回填给模型的结果。"
            badge={trace.output.toolCalls.length + trace.output.toolResults.length}
          >
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Calls</p>
                {trace.output.toolCalls.length === 0 ? (
                  <p className="text-sm text-[color:var(--muted-foreground)]">No tool calls recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolCalls.map((toolCall, index) => (
                      <div key={`${trace.id}:tool-call:${index}`} className="rounded-[16px] border border-[color:var(--border)] bg-white p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolCall.toolName ?? "unknown"}</Badge>
                          {toolCall.toolCallId ? <Badge>{toolCall.toolCallId}</Badge> : null}
                        </div>
                        <pre className="max-h-56 overflow-auto text-xs leading-6 text-slate-700">{prettyJson(toolCall.input ?? {})}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Results</p>
                {trace.output.toolResults.length === 0 ? (
                  <p className="text-sm text-[color:var(--muted-foreground)]">No tool results recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolResults.map((toolResult, index) => (
                      <div key={`${trace.id}:tool-result:${index}`} className="rounded-[16px] border border-[color:var(--border)] bg-white p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolResult.toolName ?? "unknown"}</Badge>
                          {toolResult.toolCallId ? <Badge>{toolResult.toolCallId}</Badge> : null}
                        </div>
                        <pre className="max-h-56 overflow-auto text-xs leading-6 text-slate-700">{prettyJson(toolResult.output)}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </InspectorDisclosure>
        ) : null}

        <InspectorDisclosure
          title="Raw Step Payload"
          description="保留原始 step.input / step.output，便于核对 audit 记录。"
          badge="raw"
        >
          <div className="space-y-2">
            <JsonBlock title="Raw Input" value={trace.rawInput ?? {}} />
            <JsonBlock title="Raw Output" value={trace.rawOutput ?? {}} />
          </div>
        </InspectorDisclosure>
      </div>
    </article>
  );
}

function StorageInspectorCard(props: {
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  onSelectTable: (table: StoragePostgresTableName) => void;
  redisKeyPattern: string;
  onRedisKeyPatternChange: (value: string) => void;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshOverview: () => void;
  onRefreshTable: () => void;
  onRefreshRedisKeys: () => void;
  onLoadMoreRedisKeys: () => void;
  onRefreshRedisKey: () => void;
  onDeleteRedisKey: () => void;
  busy: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="rounded-[20px] border border-[color:var(--border)] bg-white p-4">
        <InspectorPanelHeader
          title="Storage Admin"
          description="单独查看和维护当前服务所用的 Postgres / Redis。这里优先展示 OAH 自己关心的数据结构，而不是通用数据库工具式的原始页面。"
          action={
            <Button variant="secondary" size="sm" onClick={props.onRefreshOverview} disabled={props.busy}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          }
        />
        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <StorageBackendSummaryCard
            title="Postgres"
            status={props.overview?.postgres.available ? "connected" : props.overview?.postgres.configured ? "degraded" : "not configured"}
            description={
              props.overview?.postgres.database
                ? `database ${props.overview.postgres.database}`
                : "当前服务没有启用 Postgres 持久化。"
            }
            details={[
              `configured: ${props.overview?.postgres.configured ? "yes" : "no"}`,
              `primary: ${props.overview?.postgres.primaryStorage ? "yes" : "no"}`,
              `tables: ${props.overview?.postgres.tables.length ?? 0}`
            ]}
          />
          <StorageBackendSummaryCard
            title="Redis"
            status={props.overview?.redis.available ? "connected" : props.overview?.redis.configured ? "degraded" : "not configured"}
            description={
              props.overview?.redis.available
                ? `prefix ${props.overview.redis.keyPrefix} · dbsize ${props.overview.redis.dbSize ?? 0}`
                : "当前服务没有启用 Redis 或 Redis 当前不可达。"
            }
            details={[
              `configured: ${props.overview?.redis.configured ? "yes" : "no"}`,
              `event bus: ${props.overview?.redis.eventBusEnabled ? "yes" : "no"}`,
              `run queue: ${props.overview?.redis.runQueueEnabled ? "yes" : "no"}`
            ]}
          />
        </div>
      </div>

      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <StoragePostgresPanel
          overview={props.overview}
          tablePage={props.tablePage}
          selectedTable={props.selectedTable}
          onSelectTable={props.onSelectTable}
          onRefresh={props.onRefreshTable}
          busy={props.busy}
        />
        <StorageRedisPanel
          overview={props.overview}
          redisKeyPattern={props.redisKeyPattern}
          onRedisKeyPatternChange={props.onRedisKeyPatternChange}
          redisKeyPage={props.redisKeyPage}
          selectedRedisKey={props.selectedRedisKey}
          onSelectRedisKey={props.onSelectRedisKey}
          redisKeyDetail={props.redisKeyDetail}
          onRefreshKeys={props.onRefreshRedisKeys}
          onLoadMoreKeys={props.onLoadMoreRedisKeys}
          onRefreshKey={props.onRefreshRedisKey}
          onDeleteKey={props.onDeleteRedisKey}
          busy={props.busy}
        />
      </div>
    </section>
  );
}

function StorageBackendSummaryCard(props: {
  title: string;
  status: string;
  description: string;
  details: string[];
}) {
  return (
    <div className="rounded-[18px] border border-[color:var(--border)] bg-[#f8f7f3] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.title}</p>
        <Badge className={statusTone(props.status === "connected" ? "completed" : props.status === "degraded" ? "failed" : "queued")}>
          {props.status}
        </Badge>
      </div>
      <p className="mt-2 text-sm leading-6 text-[color:var(--foreground)]">{props.description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {props.details.map((detail) => (
          <Badge key={detail}>{detail}</Badge>
        ))}
      </div>
    </div>
  );
}

function StoragePostgresPanel(props: {
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  onSelectTable: (table: StoragePostgresTableName) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <section className="space-y-3 rounded-[20px] border border-[color:var(--border)] bg-white p-4">
      <InspectorPanelHeader
        title="Postgres Browser"
        description="按 OAH 自己的核心表浏览数据。左侧先看表规模，右侧直接看最近 50 行样本。"
        action={
          <Button variant="secondary" size="sm" onClick={props.onRefresh} disabled={props.busy || !props.overview?.postgres.available}>
            <RefreshCw className="h-4 w-4" />
            Refresh Table
          </Button>
        }
      />

      {!props.overview?.postgres.available ? (
        <EmptyState title="Postgres unavailable" description="当前服务没有启用 Postgres，或者 Postgres 暂时不可达。" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {props.overview.postgres.tables.map((table) => (
              <button
                key={table.name}
                className={cn(
                  "rounded-[18px] border p-3 text-left transition",
                  props.selectedTable === table.name ? "border-black/10 bg-[#f3f2ed]" : "border-[color:var(--border)] bg-[#fcfbf7] hover:bg-[#f7f6f2]"
                )}
                onClick={() => props.onSelectTable(table.name)}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-[color:var(--foreground)]">{table.name}</p>
                  <Badge>{table.rowCount}</Badge>
                </div>
                <p className="mt-2 text-xs leading-6 text-[color:var(--muted-foreground)]">{table.description}</p>
                <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">{table.orderBy}</p>
              </button>
            ))}
          </div>

          {props.tablePage ? (
            <div className="space-y-3 rounded-[18px] border border-[color:var(--border)] bg-[#fcfbf7] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.tablePage.table}</p>
                  <p className="text-xs text-[color:var(--muted-foreground)]">{props.tablePage.rowCount} rows · ordered by {props.tablePage.orderBy}</p>
                </div>
                <Badge>{props.tablePage.rows.length} preview rows</Badge>
              </div>
              <StorageDataGrid columns={props.tablePage.columns} rows={props.tablePage.rows} />
            </div>
          ) : (
            <EmptyState title="No table selected" description="Select a Postgres table to inspect recent rows." />
          )}
        </>
      )}
    </section>
  );
}

function StorageRedisPanel(props: {
  overview: StorageOverview | null;
  redisKeyPattern: string;
  onRedisKeyPatternChange: (value: string) => void;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshKeys: () => void;
  onLoadMoreKeys: () => void;
  onRefreshKey: () => void;
  onDeleteKey: () => void;
  busy: boolean;
}) {
  return (
    <section className="space-y-3 rounded-[20px] border border-[color:var(--border)] bg-white p-4">
      <InspectorPanelHeader
        title="Redis Browser"
        description="先看 OAH 自己的 ready queue / session queue / lock / event buffer，再按 pattern 浏览 key 并查看详情。"
        action={
          <Button variant="secondary" size="sm" onClick={props.onRefreshKeys} disabled={props.busy || !props.overview?.redis.available}>
            <RefreshCw className="h-4 w-4" />
            Refresh Keys
          </Button>
        }
      />

      {!props.overview?.redis.available ? (
        <EmptyState title="Redis unavailable" description="当前服务没有启用 Redis，或者 Redis 暂时不可达。" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <CatalogLine label="dbsize" value={props.overview.redis.dbSize ?? 0} />
            <CatalogLine label="ready queue" value={props.overview.redis.readyQueue?.length ?? 0} />
            <CatalogLine label="session queues" value={props.overview.redis.sessionQueues.length} />
            <CatalogLine label="session locks" value={props.overview.redis.sessionLocks.length} />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <InspectorDisclosure
              title="Queue And Lock Snapshot"
              description="优先暴露 run queue、session queue、lock 和 event buffer 这些最常见的排障对象。"
              badge={
                (props.overview.redis.sessionQueues.length ?? 0) +
                (props.overview.redis.sessionLocks.length ?? 0) +
                (props.overview.redis.eventBuffers.length ?? 0)
              }
            >
              <div className="space-y-4">
                <StorageKeySummaryList
                  title="Session Queues"
                  items={props.overview.redis.sessionQueues.map((item) => ({
                    label: item.sessionId,
                    value: `${item.length} items`,
                    keyName: item.key
                  }))}
                  emptyLabel="No queued sessions."
                  onSelect={props.onSelectRedisKey}
                />
                <StorageKeySummaryList
                  title="Session Locks"
                  items={props.overview.redis.sessionLocks.map((item) => ({
                    label: item.sessionId,
                    value: item.ttlMs !== undefined ? `${item.ttlMs}ms` : "ttl n/a",
                    keyName: item.key
                  }))}
                  emptyLabel="No active session locks."
                  onSelect={props.onSelectRedisKey}
                />
                <StorageKeySummaryList
                  title="Event Buffers"
                  items={props.overview.redis.eventBuffers.map((item) => ({
                    label: item.sessionId,
                    value: `${item.length} events`,
                    keyName: item.key
                  }))}
                  emptyLabel="No session event buffers."
                  onSelect={props.onSelectRedisKey}
                />
              </div>
            </InspectorDisclosure>

            <InspectorDisclosure title="Key Browser" description="按 pattern 扫描 Redis key，并点开单个 key 看详细值。" badge={props.redisKeyPage?.items.length ?? 0}>
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Input value={props.redisKeyPattern} onChange={(event) => props.onRedisKeyPatternChange(event.target.value)} placeholder="oah:*" />
                  <Button variant="secondary" onClick={props.onRefreshKeys} disabled={props.busy}>
                    Load
                  </Button>
                </div>
                {props.redisKeyPage?.items.length ? (
                  <div className="space-y-2">
                    {props.redisKeyPage.items.map((item) => (
                      <button
                        key={item.key}
                        className={cn(
                          "w-full rounded-[16px] border p-3 text-left transition",
                          props.selectedRedisKey === item.key ? "border-black/10 bg-[#f3f2ed]" : "border-[color:var(--border)] bg-white hover:bg-[#f7f6f2]"
                        )}
                        onClick={() => props.onSelectRedisKey(item.key)}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge>{item.type}</Badge>
                          {item.size !== undefined ? <Badge>{`size ${item.size}`}</Badge> : null}
                          {item.ttlMs !== undefined ? <Badge>{`ttl ${item.ttlMs}ms`}</Badge> : null}
                        </div>
                        <p className="mt-2 break-all text-xs leading-6 text-slate-700">{item.key}</p>
                      </button>
                    ))}
                    {props.redisKeyPage.nextCursor ? (
                      <Button variant="ghost" size="sm" onClick={props.onLoadMoreKeys} disabled={props.busy}>
                        Load More
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <EmptyState title="No keys loaded" description="Load Redis keys by pattern to inspect current keyspace." />
                )}
              </div>
            </InspectorDisclosure>
          </div>

          <div className="rounded-[18px] border border-[color:var(--border)] bg-[#fcfbf7] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[color:var(--foreground)]">Selected Redis Key</p>
                <p className="text-xs text-[color:var(--muted-foreground)]">{props.redisKeyDetail?.key ?? "Pick a key from the list or snapshot above."}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={props.onRefreshKey} disabled={props.busy || !props.selectedRedisKey}>
                  Refresh
                </Button>
                <Button variant="destructive" size="sm" onClick={props.onDeleteKey} disabled={props.busy || !props.selectedRedisKey}>
                  Delete Key
                </Button>
              </div>
            </div>
            {props.redisKeyDetail ? (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge>{props.redisKeyDetail.type}</Badge>
                  {props.redisKeyDetail.size !== undefined ? <Badge>{`size ${props.redisKeyDetail.size}`}</Badge> : null}
                  {props.redisKeyDetail.ttlMs !== undefined ? <Badge>{`ttl ${props.redisKeyDetail.ttlMs}ms`}</Badge> : null}
                </div>
                <JsonBlock title="Value" value={props.redisKeyDetail.value ?? {}} />
              </div>
            ) : (
              <EmptyState title="No key selected" description="Choose a Redis key to inspect its current value and metadata." />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function StorageKeySummaryList(props: {
  title: string;
  items: Array<{ label: string; value: string; keyName: string }>;
  emptyLabel: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">{props.title}</p>
      {props.items.length === 0 ? (
        <p className="text-sm text-[color:var(--muted-foreground)]">{props.emptyLabel}</p>
      ) : (
        <div className="space-y-2">
          {props.items.map((item) => (
            <button
              key={item.keyName}
              className="w-full rounded-[16px] border border-[color:var(--border)] bg-white px-3 py-2 text-left transition hover:bg-[#f7f6f2]"
              onClick={() => props.onSelect(item.keyName)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-[color:var(--foreground)]">{item.label}</span>
                <Badge>{item.value}</Badge>
              </div>
              <p className="mt-1 break-all text-xs leading-6 text-[color:var(--muted-foreground)]">{item.keyName}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StorageDataGrid(props: { columns: string[]; rows: Array<Record<string, unknown>> }) {
  if (props.rows.length === 0) {
    return <EmptyState title="No rows" description="This table is currently empty." />;
  }

  return (
    <div className="overflow-hidden rounded-[16px] border border-[color:var(--border)] bg-white">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-slate-700">
          <thead className="bg-[#f7f6f2]">
            <tr>
              {props.columns.map((column) => (
                <th key={column} className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, index) => (
              <tr key={`row:${index}`} className="align-top odd:bg-white even:bg-[#fcfbf7]">
                {props.columns.map((column) => (
                  <td key={`${index}:${column}`} className="max-w-[280px] border-b border-[color:var(--border)] px-3 py-2">
                    <pre className="whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">
                      {typeof row[column] === "string" ? String(row[column]) : prettyJson(row[column])}
                    </pre>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="rounded-[22px] border border-dashed border-[color:var(--border)] bg-[#f7f6f2] px-4 py-8 text-center">
      <p className="text-sm font-medium tracking-[-0.02em] text-[color:var(--foreground)]">{props.title}</p>
      <p className="mt-2 text-sm leading-6 text-[color:var(--muted-foreground)]">{props.description}</p>
    </div>
  );
}

function CatalogLine(props: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between rounded-[22px] border border-[color:var(--border)] bg-white/76 px-4 py-3 text-sm">
      <span className="text-[color:var(--muted-foreground)]">{props.label}</span>
      <span className="font-semibold text-[color:var(--foreground)]">{props.value}</span>
    </div>
  );
}

function StatusTile(props: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone: "sky" | "emerald" | "rose" | "amber";
  compact?: boolean;
}) {
  const colorClass =
    props.tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : props.tone === "rose"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : props.tone === "amber"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-sky-200 bg-sky-50 text-sky-700";

  const Icon = props.icon;

  if (props.compact) {
    return (
      <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs", colorClass)}>
        <Icon className="h-3.5 w-3.5" />
        <span className="uppercase tracking-[0.16em]">{props.label}</span>
        <span className="max-w-[120px] truncate font-medium normal-case tracking-normal">{props.value}</span>
      </div>
    );
  }

  return (
    <div className={cn("rounded-[22px] border px-4 py-3", colorClass)}>
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em]">
        <Icon className="h-4 w-4" />
        {props.label}
      </div>
      <div className="truncate text-sm font-medium">{props.value}</div>
    </div>
  );
}
