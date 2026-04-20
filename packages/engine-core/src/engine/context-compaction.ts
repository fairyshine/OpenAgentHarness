import type { Message, Run, Session } from "@oah/api-contracts";

import type { EngineLogger, MessageRepository, ModelGateway, SessionEvent, WorkspaceRecord } from "../types.js";
import type { EngineMessage } from "./engine-messages.js";
import { EngineMessageProjector, type CompactMessage } from "./message-projections.js";
import type { ResolvedRunModel } from "./model-resolver.js";

const DEFAULT_CONTEXT_WINDOW_RATIO = 0.7;
const DEFAULT_RECENT_GROUP_COUNT = 3;
const COMPACT_TOOL_RESULT_SOFT_LIMIT_CHARS = 4_000;
const COMPACT_SUMMARY_MAX_TOKENS = 1_200;
const COMPACT_SYSTEM_PROMPT = [
  "Summarize the earlier conversation context for a coding agent that will continue immediately.",
  "Focus on the user's goal, important findings, files or code touched, key tool results, constraints, and the next useful step.",
  "Write plain text only. Do not address the user. Do not mention compaction."
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  buildEngineMessagesForSession: (sessionId: string, persistedMessages?: Message[]) => Promise<EngineMessage[]>;
}

export class ContextCompactionService {
  readonly #logger?: EngineLogger | undefined;
  readonly #messageRepository: ContextCompactionServiceDependencies["messageRepository"];
  readonly #modelGateway: ContextCompactionServiceDependencies["modelGateway"];
  readonly #appendEvent: ContextCompactionServiceDependencies["appendEvent"];
  readonly #recordSystemStep: ContextCompactionServiceDependencies["recordSystemStep"];
  readonly #scheduleEngineMessageSync: ContextCompactionServiceDependencies["scheduleEngineMessageSync"];
  readonly #createId: ContextCompactionServiceDependencies["createId"];
  readonly #nowIso: ContextCompactionServiceDependencies["nowIso"];
  readonly #resolveRunModel: ContextCompactionServiceDependencies["resolveRunModel"];
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
    this.#buildEngineMessagesForSession = dependencies.buildEngineMessagesForSession;
  }

  async prepareMessagesForModelInput(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    activeAgentName: string;
    messages: Message[];
  }): Promise<EngineMessage[]> {
    const engineMessages = await this.#buildEngineMessagesForSession(input.session.id, input.messages);
    const resolvedModel = this.#resolveRunModel(input.workspace, input.session, input.run, input.activeAgentName);
    const contextWindowTokens = readContextWindowTokens(resolvedModel);
    if (!contextWindowTokens) {
      return engineMessages;
    }

    const compactProjection = this.#projector.projectToCompact(engineMessages, {
      sessionId: input.session.id,
      activeAgentName: input.activeAgentName,
      ...(input.session.modelRef ? { modelRef: input.session.modelRef } : {}),
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      applyCompactBoundary: true,
      includeReasoning: true,
      includeToolResults: true,
      toolResultSoftLimitChars: COMPACT_TOOL_RESULT_SOFT_LIMIT_CHARS
    });
    const estimatedInputTokens = estimateCompactTokenUsage(compactProjection.messages);
    const compactThresholdTokens = readCompactThresholdTokens(resolvedModel, contextWindowTokens);
    if (estimatedInputTokens < compactThresholdTokens) {
      return engineMessages;
    }

    const engineMessagesById = new Map(engineMessages.map((message) => [message.id, message]));
    const groups = groupMessagesForCompaction(compactProjection.messages, engineMessagesById);
    const recentGroupCount = readRecentGroupCount(resolvedModel);
    if (groups.length <= recentGroupCount) {
      return engineMessages;
    }

    const messagesToSummarize = groups.slice(0, -recentGroupCount).flat();
    if (messagesToSummarize.length === 0) {
      return engineMessages;
    }

    try {
      const summaryResponse = await this.#modelGateway.generate({
        model: resolvedModel.model,
        ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
        ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
        maxTokens: COMPACT_SUMMARY_MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: COMPACT_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: renderCompactMessages(messagesToSummarize)
          }
        ]
      });
      const summaryText = summaryResponse.text.trim();
      if (!summaryText) {
        return engineMessages;
      }
      const compactThroughMessageId = messagesToSummarize.at(-1)?.sourceMessageIds[0];

      const boundaryMessage: Message = {
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
            compactedBy: "auto",
            contextWindowTokens,
            compactThresholdTokens,
            estimatedInputTokens,
            summarizedMessageCount: messagesToSummarize.length,
            ...(compactThroughMessageId ? { compactThroughMessageId } : {})
          }
        },
        createdAt: this.#nowIso()
      };
      const summaryMessage: Message = {
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
            compactedBy: "auto",
            contextWindowTokens,
            compactThresholdTokens,
            estimatedInputTokens,
            summarizedMessageCount: messagesToSummarize.length,
            recentGroupCount,
            ...(compactThroughMessageId ? { compactThroughMessageId } : {})
          }
        },
        createdAt: this.#nowIso()
      };

      await this.#messageRepository.create(boundaryMessage);
      await this.#appendEvent({
        sessionId: input.session.id,
        runId: input.run.id,
        event: "message.completed",
        data: {
          runId: input.run.id,
          messageId: boundaryMessage.id,
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
          content: summaryMessage.content,
          ...(summaryMessage.metadata ? { metadata: summaryMessage.metadata } : {})
        }
      });

      input.messages.push(boundaryMessage, summaryMessage);
      await this.#scheduleEngineMessageSync(input.session.id);
      await this.#recordSystemStep(input.run, "context_compact", {
        boundaryMessageId: boundaryMessage.id,
        summaryMessageId: summaryMessage.id,
        contextWindowTokens,
        compactThresholdTokens,
        estimatedInputTokens,
        summarizedMessageCount: messagesToSummarize.length,
        ...(compactThroughMessageId ? { compactThroughMessageId } : {}),
        summaryUsage: isRecord(summaryResponse.usage) ? summaryResponse.usage : undefined
      });

      return this.#buildEngineMessagesForSession(input.session.id, input.messages);
    } catch (error) {
      this.#logger?.warn?.("Runtime auto-compaction failed; continuing with un-compacted context.", {
        sessionId: input.session.id,
        runId: input.run.id,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      return engineMessages;
    }
  }
}
