import type { ChatMessage, Message, Run, Session } from "@oah/api-contracts";

import type { EngineLogger, MessageRepository, ModelGateway, SessionEvent, WorkspaceRecord } from "../types.js";
import type { ContextPreparationModule } from "./context-modules.js";
import type { EngineMessage } from "./engine-messages.js";
import { EngineMessageProjector, type CompactMessage } from "./message-projections.js";
import type { ResolvedRunModel } from "./model-resolver.js";

const DEFAULT_CONTEXT_WINDOW_RATIO = 0.7;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 250_000;
const DEFAULT_UNKNOWN_MODEL_COMPACT_THRESHOLD_TOKENS = 200_000;
const DEFAULT_RECENT_GROUP_COUNT = 3;
const COMPACT_TOOL_RESULT_SOFT_LIMIT_CHARS = 4_000;
const COMPACT_SUMMARY_MAX_TOKENS = 1_200;
const COMPACT_SUMMARY_MESSAGE_SOFT_LIMIT_CHARS = 1_200;
const COMPACT_ESTIMATION_MIN_RESERVE_TOKENS = 1_024;
const COMPACT_ESTIMATION_RESERVE_RATIO = 0.05;
const COMPACT_SYSTEM_PROMPT = [
  "Summarize the earlier conversation context as a durable handoff summary for a coding agent that will continue immediately.",
  "Summarize only stable facts from the earlier conversation: the user's goal, decisions made, files or code touched, important findings, constraints, completed work, unresolved issues, and the next useful step.",
  "Write in concise plain text with short section labels when useful.",
  "Do not write as the assistant currently speaking. Do not say you will continue, check, inspect, read, run, or tackle anything.",
  "Do not emit tool calls, pseudo tool calls, XML/HTML/DSML/protocol tags, JSON payloads, stack traces, message numbers, or raw logs.",
  "When a tool call matters, describe its result as a fact instead of copying invocation syntax.",
  "Do not address the user. Do not mention compaction."
].join(" ");

function buildCompactSystemPrompt(customInstructions?: string): string {
  const trimmed = customInstructions?.trim();
  if (!trimmed) {
    return COMPACT_SYSTEM_PROMPT;
  }

  return `${COMPACT_SYSTEM_PROMPT} Follow these additional instructions for this manual compaction: ${trimmed}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CompactSystemMessage = Extract<Message, { role: "system" }>;

function readNumericMetadataValue(metadata: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!metadata) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = metadata[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readContextWindowTokens(model: ResolvedRunModel): number | undefined {
  return readNumericMetadataValue(model.modelDefinition?.metadata, [
    "max_model_len",
    "contextWindowTokens",
    "context_window_tokens",
    "maxInputTokens",
    "max_input_tokens",
    "contextWindow",
    "context_window"
  ]);
}

type ContextWindowResolution = {
  tokens: number;
  source: "model_metadata" | "default";
};

function resolveContextWindowTokens(model: ResolvedRunModel): ContextWindowResolution {
  const metadataTokens = readContextWindowTokens(model);
  return metadataTokens
    ? {
        tokens: metadataTokens,
        source: "model_metadata"
      }
    : {
        tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        source: "default"
      };
}

function readCompactThresholdTokens(model: ResolvedRunModel, contextWindow: ContextWindowResolution): number {
  const explicitThreshold = readNumericMetadataValue(model.modelDefinition?.metadata, [
    "compactThresholdTokens",
    "compact_threshold_tokens"
  ]);
  if (explicitThreshold) {
    return explicitThreshold;
  }

  const explicitRatio = readNumericMetadataValue(model.modelDefinition?.metadata, [
    "compactThresholdRatio",
    "compact_threshold_ratio"
  ]);
  if (!explicitRatio && contextWindow.source === "default") {
    return DEFAULT_UNKNOWN_MODEL_COMPACT_THRESHOLD_TOKENS;
  }

  const ratio =
    explicitRatio && explicitRatio > 0 && explicitRatio < 1 ? explicitRatio : DEFAULT_CONTEXT_WINDOW_RATIO;

  return Math.max(1, Math.floor(contextWindow.tokens * ratio));
}

function readRecentGroupCount(model: ResolvedRunModel): number {
  const configured = readNumericMetadataValue(model.modelDefinition?.metadata, [
    "compactRecentGroupCount",
    "compact_recent_group_count"
  ]);
  return configured ? Math.max(1, Math.floor(configured)) : DEFAULT_RECENT_GROUP_COUNT;
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function sanitizeSummaryText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.includes("<｜｜DSML｜｜") &&
        !trimmed.includes("<｜｜invoke") &&
        !trimmed.includes("</｜｜invoke>") &&
        !trimmed.includes("<｜｜parameter") &&
        !trimmed.includes("</｜｜parameter>") &&
        !looksLikeToolInvocationLine(trimmed)
      );
    })
    .join("\n")
    .trim();
}

function looksLikeToolInvocationLine(value: string): boolean {
  return (
    /^<\s*[a-z][\w:-]*(?:\s+[^<>]*)?\/?\s*>$/iu.test(value) ||
    /^<\s*\/\s*[a-z][\w:-]*\s*>$/iu.test(value) ||
    /^\s*(?:read|write|edit|bash|grep|glob|ls|python|node|apply_patch)\s*\(/iu.test(value) ||
    /^\s*(?:read|write|edit|bash|grep|glob|ls|python|node|apply_patch)\s+[\w.-]+\s*=/iu.test(value)
  );
}

function sanitizeCompactSummaryOutput(value: string): string {
  const sanitized = sanitizeSummaryText(value)
    .replace(/<\s*[a-z][\w:-]*(?:\s+[^<>]*)?\/\s*>/giu, "")
    .replace(/<\s*[a-z][\w:-]*(?:\s+[^<>]*)?>/giu, "")
    .replace(/<\s*\/\s*[a-z][\w:-]*\s*>/giu, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => {
      if (looksLikeToolInvocationLine(line.trim())) {
        return false;
      }
      return line.trim().length > 0 || (index > 0 && lines[index - 1]?.trim().length !== 0);
    })
    .join("\n")
    .trim();

  if (!sanitized) {
    return "";
  }

  return sanitized
    .replace(/\b(?:I'll|I will|I'm going to|Let me)\s+(?:continue|check|inspect|read|run|tackle|look)\b/giu, "Next step: review")
    .trim();
}

function stringifyContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "reasoning":
          return part.text;
        case "tool-call":
          return `tool-call ${part.toolName}: ${JSON.stringify(part.input)}`;
        case "tool-result": {
          switch (part.output.type) {
            case "text":
            case "error-text":
              return `tool-result ${part.toolName}: ${part.output.value}`;
            case "json":
            case "error-json":
              return `tool-result ${part.toolName}: ${JSON.stringify(part.output.value)}`;
            case "execution-denied":
              return `tool-result ${part.toolName}: ${part.output.reason ?? "Execution denied."}`;
            case "content":
              return `tool-result ${part.toolName}: ${JSON.stringify(part.output.value)}`;
          }
        }
        case "tool-approval-request":
          return `tool-approval-request ${part.toolCallId}`;
        case "tool-approval-response":
          return `tool-approval-response ${part.approvalId}: ${part.approved ? "approved" : "denied"}`;
        case "image":
          return "[image]";
        case "file":
          return `[file:${part.filename ?? "unnamed"}]`;
      }
    })
    .join("\n\n");
}

function stringifyContentForSummary(content: Message["content"]): string {
  if (typeof content === "string") {
    return sanitizeSummaryText(content);
  }

  return content
    .flatMap((part) => {
      switch (part.type) {
        case "text":
          return [sanitizeSummaryText(part.text)];
        case "reasoning":
          return [];
        case "tool-call":
          return [`Tool call requested: ${part.toolName}. Do not copy invocation syntax into the summary.`];
        case "tool-result":
          switch (part.output.type) {
            case "text":
            case "error-text":
              return [`Tool result from ${part.toolName}: ${truncateText(sanitizeSummaryText(part.output.value), COMPACT_SUMMARY_MESSAGE_SOFT_LIMIT_CHARS)}`];
            case "json":
            case "error-json":
              return [`Tool result from ${part.toolName}: ${truncateText(JSON.stringify(part.output.value), COMPACT_SUMMARY_MESSAGE_SOFT_LIMIT_CHARS)}`];
            case "execution-denied":
              return [`Tool result from ${part.toolName}: ${part.output.reason ?? "Execution denied."}`];
            case "content":
              return [`Tool result from ${part.toolName}: ${truncateText(JSON.stringify(part.output.value), COMPACT_SUMMARY_MESSAGE_SOFT_LIMIT_CHARS)}`];
          }
        case "tool-approval-request":
          return [`Tool approval requested for ${part.toolCallId}`];
        case "tool-approval-response":
          return [`Tool approval ${part.approvalId}: ${part.approved ? "approved" : "denied"}`];
        case "image":
          return ["[image]"];
        case "file":
          return [`[file:${part.filename ?? "unnamed"}]`];
      }
    })
    .join("\n\n");
}

function renderChatMessages(messages: ChatMessage[]): string {
  return messages
    .map((message, index) => `#${index + 1} ${message.role}\n${stringifyContent(message.content)}`.trim())
    .join("\n\n");
}

function renderCompactMessagesForSummary(messages: CompactMessage[]): string {
  return messages
    .flatMap((message, index) => {
      if (message.semanticType === "assistant_reasoning") {
        return [];
      }

      const rendered = truncateText(stringifyContentForSummary(message.content), COMPACT_SUMMARY_MESSAGE_SOFT_LIMIT_CHARS);
      if (!rendered.trim()) {
        return [];
      }

      return [`#${index + 1} ${message.semanticType} (${message.role})\n${rendered}`.trim()];
    })
    .join("\n\n");
}

function compactMessageToChatMessage(message: Pick<CompactMessage, "role" | "content">): ChatMessage {
  switch (message.role) {
    case "system":
      return {
        role: "system",
        content: typeof message.content === "string" ? message.content : stringifyContent(message.content)
      };
    case "user":
      return {
        role: "user",
        content: message.content as Extract<ChatMessage, { role: "user" }>["content"]
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content as Extract<ChatMessage, { role: "assistant" }>["content"]
      };
    case "tool":
      return {
        role: "tool",
        content: message.content as Extract<ChatMessage, { role: "tool" }>["content"]
      };
  }
}

function renderCompactMessages(messages: CompactMessage[]): string {
  return messages
    .map((message, index) => {
      const rendered = truncateText(stringifyContent(message.content), COMPACT_TOOL_RESULT_SOFT_LIMIT_CHARS);
      return `#${index + 1} ${message.semanticType} (${message.role})\n${rendered}`.trim();
    })
    .join("\n\n");
}

function estimateCompactTokenUsage(messages: CompactMessage[]): number {
  const rendered = renderCompactMessages(messages);
  return Math.max(1, Math.ceil(rendered.length / 4));
}

function estimateChatMessageTokenUsage(messages: ChatMessage[]): number {
  const rendered = renderChatMessages(messages);
  return Math.max(1, Math.ceil(rendered.length / 4));
}

function readCompactionReserveTokens(contextWindowTokens: number): number {
  return Math.max(COMPACT_ESTIMATION_MIN_RESERVE_TOKENS, Math.floor(contextWindowTokens * COMPACT_ESTIMATION_RESERVE_RATIO));
}

function readCompactionGroupKey(message: CompactMessage, source: EngineMessage | undefined): string {
  const modelCallStepSeq = source?.metadata?.["modelCallStepSeq"];
  if (typeof modelCallStepSeq === "number" && Number.isFinite(modelCallStepSeq)) {
    return `step:${modelCallStepSeq}`;
  }

  if (source?.kind === "user_input") {
    return `user:${source.id}`;
  }

  if (source?.kind === "compact_summary") {
    return `summary:${source.id}`;
  }

  if (source?.runId) {
    return `run:${source.runId}:${source.kind}:${source.id}`;
  }

  return `message:${source?.id ?? message.sourceMessageIds[0] ?? message.semanticType}`;
}

function isTransientMemoryContextNote(message: EngineMessage): boolean {
  return (
    message.role === "system" &&
    message.kind === "system_note" &&
    message.metadata?.synthetic === true &&
    message.metadata?.eligibleForModelContext === true &&
    Array.isArray(message.metadata?.tags) &&
    (message.metadata.tags.includes("session-memory") || message.metadata.tags.includes("workspace-memory"))
  );
}

function mergeEphemeralContextNotes(engineMessages: EngineMessage[], ephemeralNotes: EngineMessage[]): EngineMessage[] {
  if (ephemeralNotes.length === 0) {
    return engineMessages;
  }

  const merged = [...engineMessages];
  const existingIds = new Set(engineMessages.map((message) => message.id));
  for (const note of ephemeralNotes) {
    if (!existingIds.has(note.id)) {
      merged.push(note);
      existingIds.add(note.id);
    }
  }

  return merged;
}

function groupMessagesForCompaction(
  messages: CompactMessage[],
  engineMessagesById: Map<string, EngineMessage>
): CompactMessage[][] {
  const groups: CompactMessage[][] = [];
  let currentGroup: CompactMessage[] = [];
  let currentKey: string | undefined;

  for (const message of messages) {
    const source = engineMessagesById.get(message.sourceMessageIds[0] ?? "");
    const nextKey = readCompactionGroupKey(message, source);
    if (currentGroup.length > 0 && nextKey !== currentKey) {
      groups.push(currentGroup);
      currentGroup = [];
    }

    currentGroup.push(message);
    currentKey = nextKey;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

export interface ContextCompactionServiceDependencies {
  logger?: EngineLogger | undefined;
  messageRepository: Pick<MessageRepository, "create">;
  modelGateway: ModelGateway;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown> | undefined) => Promise<unknown>;
  scheduleEngineMessageSync: (sessionId: string) => Promise<void>;
  createId: (prefix: string) => string;
  nowIso: () => string;
  resolveRunModel: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string
  ) => ResolvedRunModel;
  buildModelContextMessages: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    engineMessages: EngineMessage[],
    activeAgentName: string,
    options?: {
      applyHooks?: boolean | undefined;
    }
  ) => Promise<ChatMessage[]>;
  applyCompactionHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_compact" | "after_context_compact",
    context: Record<string, unknown> & {
      messages?: ChatMessage[] | undefined;
    }
  ) => Promise<
    Record<string, unknown> & {
      messages?: ChatMessage[] | undefined;
    }
  >;
  captureWorkspaceMemoryBeforeCompaction?: ((input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    messages: Message[];
    summarizedMessageCount: number;
    compactThroughMessageId?: string | undefined;
  }) => Promise<{ captured: boolean; path?: string | undefined; reason?: string | undefined }>) | undefined;
  buildEngineMessagesForSession: (sessionId: string, persistedMessages?: Message[]) => Promise<EngineMessage[]>;
}

export interface ContextCompactionResult {
  engineMessages: EngineMessage[];
  compacted: boolean;
  reason?: "insufficient_history" | "summary_empty" | undefined;
  boundaryMessageId?: string | undefined;
  summaryMessageId?: string | undefined;
  summarizedMessageCount?: number | undefined;
}

export class ContextCompactionService implements ContextPreparationModule {
  readonly name = "compact";
  readonly #logger?: EngineLogger | undefined;
  readonly #messageRepository: ContextCompactionServiceDependencies["messageRepository"];
  readonly #modelGateway: ContextCompactionServiceDependencies["modelGateway"];
  readonly #appendEvent: ContextCompactionServiceDependencies["appendEvent"];
  readonly #recordSystemStep: ContextCompactionServiceDependencies["recordSystemStep"];
  readonly #scheduleEngineMessageSync: ContextCompactionServiceDependencies["scheduleEngineMessageSync"];
  readonly #createId: ContextCompactionServiceDependencies["createId"];
  readonly #nowIso: ContextCompactionServiceDependencies["nowIso"];
  readonly #resolveRunModel: ContextCompactionServiceDependencies["resolveRunModel"];
  readonly #buildModelContextMessages: ContextCompactionServiceDependencies["buildModelContextMessages"];
  readonly #applyCompactionHooks: ContextCompactionServiceDependencies["applyCompactionHooks"];
  readonly #captureWorkspaceMemoryBeforeCompaction: ContextCompactionServiceDependencies["captureWorkspaceMemoryBeforeCompaction"];
  readonly #buildEngineMessagesForSession: ContextCompactionServiceDependencies["buildEngineMessagesForSession"];
  readonly #projector = new EngineMessageProjector();

  constructor(dependencies: ContextCompactionServiceDependencies) {
    this.#logger = dependencies.logger;
    this.#messageRepository = dependencies.messageRepository;
    this.#modelGateway = dependencies.modelGateway;
    this.#appendEvent = dependencies.appendEvent;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#scheduleEngineMessageSync = dependencies.scheduleEngineMessageSync;
    this.#createId = dependencies.createId;
    this.#nowIso = dependencies.nowIso;
    this.#resolveRunModel = dependencies.resolveRunModel;
    this.#buildModelContextMessages = dependencies.buildModelContextMessages;
    this.#applyCompactionHooks = dependencies.applyCompactionHooks;
    this.#captureWorkspaceMemoryBeforeCompaction = dependencies.captureWorkspaceMemoryBeforeCompaction;
    this.#buildEngineMessagesForSession = dependencies.buildEngineMessagesForSession;
  }

  isEnabled(workspace: WorkspaceRecord): boolean {
    return workspace.settings.engine?.compact?.enabled ?? true;
  }

  async prepareMessagesForModelInput(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    activeAgentName: string;
    messages: Message[];
    engineMessages: EngineMessage[];
    abortSignal?: AbortSignal | undefined;
    modelTimeoutMs?: number | undefined;
  }): Promise<EngineMessage[]> {
    const result = await this.#compactContext({
      ...input,
      force: false,
      compactionSource: "auto"
    });
    return result.engineMessages;
  }

  async compactSessionContext(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    activeAgentName: string;
    messages: Message[];
    engineMessages: EngineMessage[];
    instructions?: string | undefined;
  }): Promise<ContextCompactionResult> {
    return this.#compactContext({
      ...input,
      force: true,
      compactionSource: "manual"
    });
  }

  async #compactContext(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    activeAgentName: string;
    messages: Message[];
    engineMessages: EngineMessage[];
    force: boolean;
    compactionSource: "auto" | "manual";
    instructions?: string | undefined;
    abortSignal?: AbortSignal | undefined;
    modelTimeoutMs?: number | undefined;
  }): Promise<ContextCompactionResult> {
    const engineMessages = input.engineMessages;
    const ephemeralNotes = engineMessages.filter((message) => isTransientMemoryContextNote(message));
    const compactionSourceMessages =
      ephemeralNotes.length > 0 ? engineMessages.filter((message) => !isTransientMemoryContextNote(message)) : engineMessages;
    const resolvedModel = this.#resolveRunModel(input.workspace, input.session, input.run, input.activeAgentName);
    const contextWindow = resolveContextWindowTokens(resolvedModel);
    const contextWindowTokens = contextWindow.tokens;

    const compactProjection = this.#projector.projectToCompact(compactionSourceMessages, {
      sessionId: input.session.id,
      activeAgentName: input.activeAgentName,
      ...(input.session.modelRef ? { modelRef: input.session.modelRef } : {}),
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      applyCompactBoundary: true,
      includeReasoning: true,
      includeToolResults: true,
      toolResultSoftLimitChars: COMPACT_TOOL_RESULT_SOFT_LIMIT_CHARS
    });
    const estimatedModelContextMessages = await this.#buildModelContextMessages(
      input.workspace,
      input.session,
      input.run,
      engineMessages,
      input.activeAgentName,
      { applyHooks: false }
    );
    const estimatedInputTokens = Math.max(
      estimateCompactTokenUsage(compactProjection.messages),
      estimateChatMessageTokenUsage(estimatedModelContextMessages)
    );
    const compactThresholdTokens = readCompactThresholdTokens(resolvedModel, contextWindow);
    if (!input.force && compactThresholdTokens && estimatedInputTokens < compactThresholdTokens) {
      return {
        engineMessages,
        compacted: false
      };
    }

    const engineMessagesById = new Map(compactionSourceMessages.map((message) => [message.id, message]));
    const persistedMessagesById = new Map(input.messages.map((message) => [message.id, message]));
    const groups = groupMessagesForCompaction(compactProjection.messages, engineMessagesById);
    if (groups.length <= 1) {
      return {
        engineMessages,
        compacted: false,
        reason: "insufficient_history"
      };
    }

    const configuredRecentGroupCount = readRecentGroupCount(resolvedModel);
    const recentGroupTokenUsage = groups.map((group) => estimateCompactTokenUsage(group));
    const estimatedPromptOverheadTokens = Math.max(
      0,
      estimatedInputTokens - estimateCompactTokenUsage(compactProjection.messages)
    );
    const maxKeepRecentGroupCount = Math.max(1, Math.min(configuredRecentGroupCount, groups.length - 1));
    let keepRecentGroupCount = maxKeepRecentGroupCount;
    let estimatedPostCompactTokens =
      estimatedPromptOverheadTokens + recentGroupTokenUsage.slice(-keepRecentGroupCount).reduce((sum, value) => sum + value, 0) + COMPACT_SUMMARY_MAX_TOKENS;
    if (contextWindowTokens && compactThresholdTokens) {
      const reserveTokens = readCompactionReserveTokens(contextWindowTokens);
      estimatedPostCompactTokens += reserveTokens;
      while (keepRecentGroupCount > 1 && estimatedPostCompactTokens >= compactThresholdTokens) {
        keepRecentGroupCount -= 1;
        estimatedPostCompactTokens =
          estimatedPromptOverheadTokens +
          recentGroupTokenUsage.slice(-keepRecentGroupCount).reduce((sum, value) => sum + value, 0) +
          COMPACT_SUMMARY_MAX_TOKENS +
          reserveTokens;
      }
    }

    const messagesToSummarize = groups.slice(0, -keepRecentGroupCount).flat();
    if (messagesToSummarize.length === 0) {
      return {
        engineMessages,
        compacted: false,
        reason: "insufficient_history"
      };
    }

    const summarySourceMessages = messagesToSummarize.map(compactMessageToChatMessage);
    const defaultSummaryInputText = renderCompactMessagesForSummary(messagesToSummarize);
    const compactThroughMessageId = messagesToSummarize.at(-1)?.sourceMessageIds[0];
    const messagesToFlush = messagesToSummarize
      .flatMap((message) => message.sourceMessageIds)
      .map((messageId) => persistedMessagesById.get(messageId))
      .filter((message): message is Message => Boolean(message));
    const memoryFlush = await this.#captureWorkspaceMemoryBeforeCompaction?.({
      workspace: input.workspace,
      session: input.session,
      run: input.run,
      messages: messagesToFlush,
      summarizedMessageCount: messagesToSummarize.length,
      ...(compactThroughMessageId ? { compactThroughMessageId } : {})
    });
    const beforeHookContext = await this.#applyCompactionHooks(
      input.workspace,
      input.session,
      input.run,
      "before_context_compact",
      {
        messages: summarySourceMessages,
        compactedBy: input.compactionSource,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
        ...(compactThresholdTokens ? { compactThresholdTokens } : {}),
        estimatedInputTokens,
        estimatedPostCompactTokens,
        summarizedMessageCount: messagesToSummarize.length,
        ...(memoryFlush?.captured ? { workspaceMemoryFlushPath: memoryFlush.path } : {}),
        configuredRecentGroupCount,
        keepRecentGroupCount,
        ...(compactThroughMessageId ? { compactThroughMessageId } : {})
      }
    );
    const hookMessages = Array.isArray(beforeHookContext.messages) ? beforeHookContext.messages : undefined;
    const hookReplacedSummaryMessages = hookMessages !== undefined && hookMessages !== summarySourceMessages;
    const summaryInputText = hookReplacedSummaryMessages ? renderChatMessages(hookMessages) : defaultSummaryInputText;

    try {
      const summaryResponse = await this.#modelGateway.generate(
        {
          model: resolvedModel.model,
          ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
          ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
          maxTokens: COMPACT_SUMMARY_MAX_TOKENS,
          messages: [
            {
              role: "system",
              content: buildCompactSystemPrompt(input.compactionSource === "manual" ? input.instructions : undefined)
            },
            {
              role: "user",
              content: summaryInputText
            }
          ]
        },
        {
          signal: input.abortSignal,
          timeoutMs: input.modelTimeoutMs
        }
      );
      const summaryText = sanitizeCompactSummaryOutput(summaryResponse.text);
      if (!summaryText) {
        return {
          engineMessages,
          compacted: false,
          reason: "summary_empty"
        };
      }
      let boundaryMessage: CompactSystemMessage = {
        id: this.#createId("msg"),
        sessionId: input.session.id,
        runId: input.run.id,
        role: "system",
        content: "Conversation compacted",
        metadata: {
          runtimeKind: "compact_boundary",
          source: "engine",
          eligibleForModelContext: false,
          extra: {
            compactedBy: input.compactionSource,
            ...(contextWindowTokens ? { contextWindowTokens } : {}),
            ...(compactThresholdTokens ? { compactThresholdTokens } : {}),
            estimatedInputTokens,
            estimatedPostCompactTokens,
            summarizedMessageCount: messagesToSummarize.length,
            ...(memoryFlush?.captured ? { workspaceMemoryFlushPath: memoryFlush.path } : {}),
            configuredRecentGroupCount,
            keepRecentGroupCount,
            ...(compactThroughMessageId ? { compactThroughMessageId } : {})
          }
        },
        createdAt: this.#nowIso()
      };
      let summaryMessage: CompactSystemMessage = {
        id: this.#createId("msg"),
        sessionId: input.session.id,
        runId: input.run.id,
        role: "system",
        content: summaryText,
        metadata: {
          runtimeKind: "compact_summary",
          source: "engine",
          compactBoundaryId: boundaryMessage.id,
          summaryForBoundaryId: boundaryMessage.id,
          eligibleForModelContext: true,
          extra: {
            compactedBy: input.compactionSource,
            ...(contextWindowTokens ? { contextWindowTokens } : {}),
            ...(compactThresholdTokens ? { compactThresholdTokens } : {}),
            estimatedInputTokens,
            estimatedPostCompactTokens,
            summarizedMessageCount: messagesToSummarize.length,
            ...(memoryFlush?.captured ? { workspaceMemoryFlushPath: memoryFlush.path } : {}),
            configuredRecentGroupCount,
            keepRecentGroupCount,
            ...(compactThroughMessageId ? { compactThroughMessageId } : {})
          }
        },
        createdAt: this.#nowIso()
      };
      const afterHookContext = await this.#applyCompactionHooks(
        input.workspace,
        input.session,
        input.run,
        "after_context_compact",
        {
          summaryText,
          compactedBy: input.compactionSource,
          ...(input.instructions ? { instructions: input.instructions } : {}),
          boundaryMessage: {
            content: boundaryMessage.content,
            metadata: boundaryMessage.metadata
          },
          summaryMessage: {
            content: summaryMessage.content,
            metadata: summaryMessage.metadata
          },
          ...(contextWindowTokens ? { contextWindowTokens } : {}),
          ...(compactThresholdTokens ? { compactThresholdTokens } : {}),
          estimatedInputTokens,
          estimatedPostCompactTokens,
          summarizedMessageCount: messagesToSummarize.length,
          ...(memoryFlush?.captured ? { workspaceMemoryFlushPath: memoryFlush.path } : {}),
          configuredRecentGroupCount,
          keepRecentGroupCount,
          ...(compactThroughMessageId ? { compactThroughMessageId } : {})
        }
      );

      const boundaryPatch = isRecord(afterHookContext.boundaryMessage) ? afterHookContext.boundaryMessage : undefined;
      if (boundaryPatch) {
        boundaryMessage = {
          ...boundaryMessage,
          ...(typeof boundaryPatch.content === "string" ? { content: boundaryPatch.content } : {}),
          ...(isRecord(boundaryPatch.metadata)
            ? {
                metadata: {
                  ...(boundaryMessage.metadata ?? {}),
                  ...boundaryPatch.metadata
                }
              }
            : {})
        };
      }

      const summaryPatch = isRecord(afterHookContext.summaryMessage) ? afterHookContext.summaryMessage : undefined;
      if (summaryPatch) {
        summaryMessage = {
          ...summaryMessage,
          ...(typeof summaryPatch.content === "string" ? { content: summaryPatch.content } : {}),
          ...(isRecord(summaryPatch.metadata)
            ? {
                metadata: {
                  ...(summaryMessage.metadata ?? {}),
                  ...summaryPatch.metadata
                }
              }
            : {})
        };
      }

      if (typeof afterHookContext.summaryText === "string") {
        summaryMessage = {
          ...summaryMessage,
          content: afterHookContext.summaryText
        };
      }

      await this.#messageRepository.create(boundaryMessage);
      await this.#appendEvent({
        sessionId: input.session.id,
        runId: input.run.id,
        event: "message.completed",
        data: {
          runId: input.run.id,
          messageId: boundaryMessage.id,
          role: boundaryMessage.role,
          content: boundaryMessage.content,
          ...(boundaryMessage.metadata ? { metadata: boundaryMessage.metadata } : {})
        }
      });
      await this.#messageRepository.create(summaryMessage);
      await this.#appendEvent({
        sessionId: input.session.id,
        runId: input.run.id,
        event: "message.completed",
        data: {
          runId: input.run.id,
          messageId: summaryMessage.id,
          role: summaryMessage.role,
          content: summaryMessage.content,
          ...(summaryMessage.metadata ? { metadata: summaryMessage.metadata } : {})
        }
      });

      input.messages.push(boundaryMessage, summaryMessage);
      await this.#scheduleEngineMessageSync(input.session.id);
      await this.#recordSystemStep(input.run, "context_compact", {
        compactionSource: input.compactionSource,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        boundaryMessageId: boundaryMessage.id,
        summaryMessageId: summaryMessage.id,
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
        ...(compactThresholdTokens ? { compactThresholdTokens } : {}),
        estimatedInputTokens,
        estimatedPostCompactTokens,
        summarizedMessageCount: messagesToSummarize.length,
        summaryInputTokens: Math.max(1, Math.ceil(summaryInputText.length / 4)),
        ...(memoryFlush?.captured ? { workspaceMemoryFlushPath: memoryFlush.path } : {}),
        configuredRecentGroupCount,
        keepRecentGroupCount,
        ...(compactThroughMessageId ? { compactThroughMessageId } : {}),
        summaryUsage: isRecord(summaryResponse.usage) ? summaryResponse.usage : undefined
      });

      return {
        engineMessages: mergeEphemeralContextNotes(
          await this.#buildEngineMessagesForSession(input.session.id, input.messages),
          ephemeralNotes
        ),
        compacted: true,
        boundaryMessageId: boundaryMessage.id,
        summaryMessageId: summaryMessage.id,
        summarizedMessageCount: messagesToSummarize.length
      };
    } catch (error) {
      if (input.compactionSource === "auto") {
        this.#logger?.warn?.("Runtime auto-compaction failed; continuing with un-compacted context.", {
          sessionId: input.session.id,
          runId: input.run.id,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        return {
          engineMessages,
          compacted: false
        };
      }

      throw error;
    }
  }
}
