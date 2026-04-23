import type { ChatMessage, Message, Run, Session } from "@oah/api-contracts";

import type { EngineLogger, MessageRepository, ModelGateway, SessionEvent, WorkspaceRecord } from "../types.js";
import type { ContextPreparationModule } from "./context-modules.js";
import type { EngineMessage } from "./engine-messages.js";
import { EngineMessageProjector, type CompactMessage } from "./message-projections.js";
import type { ResolvedRunModel } from "./model-resolver.js";

const DEFAULT_CONTEXT_WINDOW_RATIO = 0.7;
const DEFAULT_RECENT_GROUP_COUNT = 3;
const COMPACT_TOOL_RESULT_SOFT_LIMIT_CHARS = 4_000;
const COMPACT_SUMMARY_MAX_TOKENS = 1_200;
const COMPACT_ESTIMATION_MIN_RESERVE_TOKENS = 1_024;
const COMPACT_ESTIMATION_RESERVE_RATIO = 0.05;
const COMPACT_SYSTEM_PROMPT = [
  "Summarize the earlier conversation context for a coding agent that will continue immediately.",
  "Focus on the user's goal, important findings, files or code touched, key tool results, constraints, and the next useful step.",
  "Write plain text only. Do not address the user. Do not mention compaction."
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

function readCompactThresholdTokens(model: ResolvedRunModel, contextWindowTokens: number): number {
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
  const ratio =
    explicitRatio && explicitRatio > 0 && explicitRatio < 1 ? explicitRatio : DEFAULT_CONTEXT_WINDOW_RATIO;

  return Math.max(1, Math.floor(contextWindowTokens * ratio));
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

function renderChatMessages(messages: ChatMessage[]): string {
  return messages
    .map((message, index) => `#${index + 1} ${message.role}\n${stringifyContent(message.content)}`.trim())
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
  }): Promise<ContextCompactionResult> {
    const engineMessages = input.engineMessages;
    const ephemeralNotes = engineMessages.filter((message) => isTransientMemoryContextNote(message));
    const compactionSourceMessages =
      ephemeralNotes.length > 0 ? engineMessages.filter((message) => !isTransientMemoryContextNote(message)) : engineMessages;
    const resolvedModel = this.#resolveRunModel(input.workspace, input.session, input.run, input.activeAgentName);
    const contextWindowTokens = readContextWindowTokens(resolvedModel);
    if (!contextWindowTokens && !input.force) {
      return {
        engineMessages,
        compacted: false
      };
    }

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
    const compactThresholdTokens = contextWindowTokens
      ? readCompactThresholdTokens(resolvedModel, contextWindowTokens)
      : undefined;
    if (!input.force && compactThresholdTokens && estimatedInputTokens < compactThresholdTokens) {
      return {
        engineMessages,
        compacted: false
      };
    }

    const engineMessagesById = new Map(compactionSourceMessages.map((message) => [message.id, message]));
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
    const compactThroughMessageId = messagesToSummarize.at(-1)?.sourceMessageIds[0];
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
        configuredRecentGroupCount,
        keepRecentGroupCount,
        ...(compactThroughMessageId ? { compactThroughMessageId } : {})
      }
    );
    const summaryInputMessages = Array.isArray(beforeHookContext.messages)
      ? beforeHookContext.messages
      : summarySourceMessages;

    try {
      const summaryResponse = await this.#modelGateway.generate({
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
            content: renderChatMessages(summaryInputMessages)
          }
        ]
      });
      const summaryText = summaryResponse.text.trim();
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
