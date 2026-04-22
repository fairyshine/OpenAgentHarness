import type { Message } from "@oah/api-contracts";

import { toolResultContent } from "../execution-message-content.js";
import type { EngineMessage } from "./engine-messages.js";

export type ProjectionView = "transcript" | "model" | "compact" | "debug" | "export";

export interface ProjectedMessageBase {
  view: ProjectionView;
  role: Message["role"];
  semanticType: string;
  sourceMessageIds: string[];
  content: Message["content"];
  metadata?: {
    hiddenFromTranscript?: boolean | undefined;
    hiddenFromModel?: boolean | undefined;
    truncated?: boolean | undefined;
    compacted?: boolean | undefined;
    notes?: string[] | undefined;
  };
}

export interface TranscriptMessage extends ProjectedMessageBase {
  view: "transcript";
}

export interface DebugMessage extends ProjectedMessageBase {
  view: "debug";
}

export interface CompactMessage extends ProjectedMessageBase {
  view: "compact";
}

export interface ModelMessage extends ProjectedMessageBase {
  view: "model";
}

export interface ProjectionContext {
  sessionId: string;
  activeAgentName: string;
  modelRef?: string | undefined;
  provider?: string | undefined;
  includeReasoning?: boolean | undefined;
  includeToolResults?: boolean | undefined;
  toolResultSoftLimitChars?: number | undefined;
  applyCompactBoundary?: boolean | undefined;
  injectRuntimeReminder?: boolean | undefined;
}

export interface ProjectionResult<TMessage extends ProjectedMessageBase> {
  messages: TMessage[];
  diagnostics: {
    hiddenMessageIds: string[];
    truncatedMessageIds: string[];
    appliedCompactBoundaryId?: string | undefined;
    injectedNotes: string[];
  };
}

function copyNotes(notes: string[] | undefined, note: string): string[] {
  return [...(notes ?? []), note];
}

function isEligibleForModelContext(message: EngineMessage): boolean {
  return message.metadata?.eligibleForModelContext !== false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLatestCompactBoundaryIndex(messages: EngineMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "compact_boundary") {
      return index;
    }
  }

  return -1;
}

function readCompactThroughMessageId(boundaryMessage: EngineMessage): string | undefined {
  const extra = boundaryMessage.metadata?.extra;
  if (!isRecord(extra)) {
    return undefined;
  }

  return typeof extra.compactThroughMessageId === "string" ? extra.compactThroughMessageId : undefined;
}

function findSummaryForBoundary(messages: EngineMessage[], boundaryId: string): EngineMessage | undefined {
  return messages.find(
    (message) =>
      message.kind === "compact_summary" &&
      (message.metadata?.summaryForBoundaryId === boundaryId || message.metadata?.compactBoundaryId === boundaryId)
  );
}

function applyLatestCompactBoundary(messages: EngineMessage[]): {
  messages: EngineMessage[];
  appliedCompactBoundaryId?: string | undefined;
} {
  const boundaryIndex = findLatestCompactBoundaryIndex(messages);
  if (boundaryIndex < 0) {
    return { messages };
  }

  const boundaryMessage = messages[boundaryIndex];
  if (!boundaryMessage) {
    return { messages };
  }

  const compactThroughMessageId = readCompactThroughMessageId(boundaryMessage);
  if (!compactThroughMessageId) {
    return {
      messages: messages.slice(boundaryIndex + 1),
      appliedCompactBoundaryId: boundaryMessage.id
    };
  }

  const compactThroughIndex = messages.findIndex((message) => message.id === compactThroughMessageId);
  if (compactThroughIndex < 0) {
    return {
      messages: messages.slice(boundaryIndex + 1),
      appliedCompactBoundaryId: boundaryMessage.id
    };
  }

  const summaryMessage = findSummaryForBoundary(messages, boundaryMessage.id);
  const recentMessages = messages.filter(
    (message, index) =>
      index > compactThroughIndex &&
      message.kind !== "compact_boundary" &&
      message.id !== summaryMessage?.id
  );

  return {
    messages: [...(summaryMessage ? [summaryMessage] : []), ...recentMessages],
    appliedCompactBoundaryId: boundaryMessage.id
  };
}

function hoistTransientMemoryContextNotes(messages: EngineMessage[]): EngineMessage[] {
  const transientMemoryNotes = messages.filter((message) => isTransientMemoryContextNote(message));
  if (transientMemoryNotes.length === 0) {
    return messages;
  }

  const leadingSystemMessages: EngineMessage[] = [];
  const remainingMessages: EngineMessage[] = [];
  let stillLeading = true;

  for (const message of messages) {
    if (isTransientMemoryContextNote(message)) {
      continue;
    }

    if (stillLeading && message.role === "system") {
      leadingSystemMessages.push(message);
      continue;
    }

    stillLeading = false;
    remainingMessages.push(message);
  }

  return [...leadingSystemMessages, ...transientMemoryNotes, ...remainingMessages];
}

function projectGenericMessage<TView extends ProjectionView>(
  engineMessage: EngineMessage,
  view: TView
): Extract<ProjectedMessageBase, { view: TView }> {
  return {
    view,
    role: engineMessage.role,
    semanticType: engineMessage.kind,
    sourceMessageIds: [engineMessage.id],
    content: engineMessage.content
  } as Extract<ProjectedMessageBase, { view: TView }>;
}

function buildModelMessage(
  engineMessage: EngineMessage,
  context: ProjectionContext
): { message?: ModelMessage | undefined; truncated: boolean } {
  if (engineMessage.kind === "compact_boundary") {
    return { truncated: false };
  }

  if (engineMessage.kind === "assistant_reasoning" && context.includeReasoning === false) {
    return { truncated: false };
  }

  if (engineMessage.kind === "tool_result" && context.includeToolResults === false) {
    return { truncated: false };
  }

  let content = engineMessage.content;
  let metadata: ModelMessage["metadata"] | undefined;
  let truncated = false;

  if (engineMessage.kind === "tool_result" && engineMessage.metadata?.compactedAt) {
    const toolResultPart = Array.isArray(engineMessage.content)
      ? engineMessage.content.find((part) => part.type === "tool-result")
      : undefined;
    if (toolResultPart) {
      content = toolResultContent({
        toolCallId: toolResultPart.toolCallId,
        toolName: toolResultPart.toolName,
        output: "[Old tool result content cleared]"
      });
      metadata = {
        compacted: true,
        notes: ["tool result compacted for model context"]
      };
      truncated = true;
    }
  }

  if (
    engineMessage.kind === "tool_result" &&
    !truncated &&
    typeof context.toolResultSoftLimitChars === "number" &&
    context.toolResultSoftLimitChars > 0 &&
    Array.isArray(content)
  ) {
    const toolResultPart = content.find((part) => part.type === "tool-result");
    if (
      toolResultPart &&
      (toolResultPart.output.type === "text" || toolResultPart.output.type === "error-text") &&
      toolResultPart.output.value.length > context.toolResultSoftLimitChars
    ) {
      content = toolResultContent({
        toolCallId: toolResultPart.toolCallId,
        toolName: toolResultPart.toolName,
        output: `${toolResultPart.output.value.slice(0, context.toolResultSoftLimitChars)}...`
      });
      metadata = {
        ...(metadata ?? {}),
        truncated: true,
        notes: copyNotes(metadata?.notes, `tool result truncated to ${context.toolResultSoftLimitChars} chars`)
      };
      truncated = true;
    }
  }

  return {
    message: {
      view: "model",
      role: engineMessage.role,
      semanticType: engineMessage.kind,
      sourceMessageIds: [engineMessage.id],
      content,
      ...(metadata ? { metadata } : {})
    },
    truncated
  };
}

export class EngineMessageProjector {
  projectToTranscript(
    engineMessages: EngineMessage[],
    _context: ProjectionContext
  ): ProjectionResult<TranscriptMessage> {
    return {
      messages: engineMessages
        .filter((message) => message.metadata?.visibleInTranscript !== false)
        .map((message) => projectGenericMessage(message, "transcript")),
      diagnostics: {
        hiddenMessageIds: engineMessages
          .filter((message) => message.metadata?.visibleInTranscript === false)
          .map((message) => message.id),
        truncatedMessageIds: [],
        injectedNotes: []
      }
    };
  }

  projectToModel(engineMessages: EngineMessage[], context: ProjectionContext): ProjectionResult<ModelMessage> {
    const hiddenMessageIds: string[] = [];
    const truncatedMessageIds: string[] = [];
    const injectedNotes: string[] = [];

    let messages = engineMessages;
    let appliedCompactBoundaryId: string | undefined;
    if (context.applyCompactBoundary !== false) {
      const bounded = applyLatestCompactBoundary(engineMessages);
      messages = bounded.messages;
      appliedCompactBoundaryId = bounded.appliedCompactBoundaryId;
    }

    messages = hoistTransientMemoryContextNotes(messages);

    const projected = messages.flatMap((message) => {
      if (!isEligibleForModelContext(message)) {
        hiddenMessageIds.push(message.id);
        return [];
      }

      const result = buildModelMessage(message, context);
      if (!result.message) {
        hiddenMessageIds.push(message.id);
        return [];
      }

      if (result.truncated) {
        truncatedMessageIds.push(message.id);
      }

      return [result.message];
    });

    if (context.injectRuntimeReminder) {
      projected.push({
        view: "model",
        role: "system",
        semanticType: "runtime_reminder",
        sourceMessageIds: [],
        content: "Continue from the current task state. Re-read files or rerun tools if prior outputs were compacted."
      });
      injectedNotes.push("runtime reminder injected");
    }

    return {
      messages: projected,
      diagnostics: {
        hiddenMessageIds,
        truncatedMessageIds,
        ...(appliedCompactBoundaryId ? { appliedCompactBoundaryId } : {}),
        injectedNotes
      }
    };
  }

  projectToDebug(engineMessages: EngineMessage[], _context: ProjectionContext): ProjectionResult<DebugMessage> {
    return {
      messages: engineMessages.map((message) => ({
        view: "debug" as const,
        role: message.role,
        semanticType: message.kind,
        sourceMessageIds: [message.id],
        content: message.content,
        metadata: {
          ...(message.metadata?.eligibleForModelContext === false ? { hiddenFromModel: true } : {}),
          ...(message.metadata?.visibleInTranscript === false ? { hiddenFromTranscript: true } : {}),
          ...(message.metadata?.compactedAt ? { compacted: true } : {})
        }
      })),
      diagnostics: {
        hiddenMessageIds: [],
        truncatedMessageIds: [],
        injectedNotes: []
      }
    };
  }

  projectToCompact(engineMessages: EngineMessage[], context: ProjectionContext): ProjectionResult<CompactMessage> {
    const modelProjection = this.projectToModel(engineMessages, {
      ...context,
      injectRuntimeReminder: false
    });

    return {
      messages: modelProjection.messages.map((message) => ({
        ...message,
        view: "compact"
      })),
      diagnostics: modelProjection.diagnostics
    };
  }
}
