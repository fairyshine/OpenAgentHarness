import type {
  EngineLogCategory,
  EngineLogLevel,
  HealthReport,
  Message,
  ReadinessReport,
  Run,
  SessionEventContract,
  SystemProfile,
  Workspace
} from "@oah/api-contracts";

interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

interface WorkspaceDraft {
  name: string;
  runtime?: string;
  rootPath: string;
  ownerId: string;
  serviceName: string;
}

interface SavedWorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  runtime?: string;
  serviceName?: string;
  status: Workspace["status"];
  createdAt?: string;
  updatedAt?: string;
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
  contextWindowTokens?: number;
  metadata?: Record<string, unknown>;
  isDefault: boolean;
}

interface SseFrame {
  cursor?: string;
  createdAt?: string;
  event: string;
  data: Record<string, unknown>;
}

type HealthReportResponse = HealthReport;
type ReadinessReportResponse = ReadinessReport;
type SystemProfileResponse = SystemProfile;

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
type SurfaceMode = "engine" | "storage" | "provider";
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

interface MessageAgentSnapshot {
  name?: string;
  mode?: AgentMode;
}

interface LiveConversationMessageRecord {
  persistedMessageId?: string;
  toolCallId?: string;
  runId: string;
  sessionId: string;
  role?: "user" | "assistant" | "tool";
  content: Message["content"];
  metadata?: Record<string, unknown>;
  createdAt: string;
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
  level: EngineLogLevel;
  category: EngineLogCategory;
  message: string;
  details?: unknown;
  source: "server" | "web";
  eventId?: string;
  eventName?: SessionEventContract["event"];
  runId?: string;
  cursor?: string;
  stepId?: string;
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

export type {
  AgentMode,
  AppRequestErrorSummary,
  AssistantMessageContent,
  ConnectionSettings,
  ConsoleFilter,
  HealthReportResponse,
  InspectorTab,
  LiveConversationMessageRecord,
  MainViewMode,
  MessageAgentSnapshot,
  MessagePart,
  MessageParts,
  ModelDraft,
  ModelProviderListResponse,
  ModelProviderRecord,
  PlatformModelListResponse,
  PlatformModelRecord,
  PlatformModelSnapshotResponse,
  ReadinessReportResponse,
  RuntimeConsoleEntry,
  SavedSessionRecord,
  SavedWorkspaceRecord,
  ServiceScope,
  SseFrame,
  StatusSemanticTone,
  StorageBrowserTab,
  StorageToolCallRecord,
  SurfaceMode,
  SystemMessageContent,
  SystemProfileResponse,
  ToolMessageContent,
  UserMessageContent,
  WorkspaceDraft
};
