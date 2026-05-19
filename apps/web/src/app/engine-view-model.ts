import type { Message, RunStep, SessionEventContract } from "@oah/api-contracts";

import {
  buildMessageRecord,
  compareMessagesChronologically,
  contentText,
  contentToolRefs,
  countMessagesByRole,
  isRecord,
  readMessageModelCallStepRef,
  readMessageSystemPromptSnapshot,
  toModelCallTrace,
  uniqueStrings,
  type LiveConversationMessageRecord,
  type ModelCallTrace
} from "./support";

type AssistantMessageContent = Extract<Message, { role: "assistant" }>["content"];

function readEventMessageId(event: SessionEventContract) {
  return typeof event.data.messageId === "string" ? event.data.messageId : undefined;
}

function readEventCursorValue(event: SessionEventContract) {
  const numericCursor = Number.parseInt(event.cursor, 10);
  return Number.isFinite(numericCursor) ? numericCursor : Number.MAX_SAFE_INTEGER;
}

function readComparableMessageId(message: Pick<Message, "id">) {
  return message.id.startsWith("live:") ? message.id.slice("live:".length) : message.id;
}

function parseComparableTimestamp(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function resolveRunDisplayAnchorTimestamp(
  messages: Message[],
  events: SessionEventContract[],
  readMessageTimestamp: (message: Message) => number = (message) => parseComparableTimestamp(message.createdAt),
  readEventTimestamp: (event: SessionEventContract) => number = (event) => parseComparableTimestamp(event.createdAt)
) {
  const earliestMessageTimestamp = messages.reduce((current, message) => {
    const timestamp = readMessageTimestamp(message);
    if (!Number.isFinite(timestamp)) {
      return current;
    }
    return Number.isFinite(current) ? Math.min(current, timestamp) : timestamp;
  }, Number.NaN);

  const executionTimestamp = events.reduce((current, event) => {
    const isExecutionAnchor =
      event.event === "run.started" ||
      (event.event === "queue.updated" && event.data.action === "dequeued");
    if (!isExecutionAnchor) {
      return current;
    }

    const timestamp = readEventTimestamp(event);
    if (!Number.isFinite(timestamp)) {
      return current;
    }
    return Number.isFinite(current) ? Math.min(current, timestamp) : timestamp;
  }, Number.NaN);

  if (Number.isFinite(earliestMessageTimestamp) && Number.isFinite(executionTimestamp)) {
    return Math.max(earliestMessageTimestamp, executionTimestamp);
  }
  if (Number.isFinite(executionTimestamp)) {
    return executionTimestamp;
  }
  return earliestMessageTimestamp;
}

function isToolOnlyAssistantMessage(message: Message) {
  if (message.role !== "assistant" || typeof message.content === "string") {
    return false;
  }

  const hasText = message.content.some(
    (part) => (part.type === "text" || part.type === "reasoning") && typeof part.text === "string" && part.text.trim().length > 0
  );
  const hasToolOrApproval = message.content.some(
    (part) =>
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request"
  );

  return hasToolOrApproval && !hasText;
}

function hasDisplayableConversationContent(content: Message["content"]) {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  return content.some((part) => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return typeof part.text === "string" && part.text.trim().length > 0;
      case "image":
      case "file":
      case "tool-call":
      case "tool-result":
      case "tool-approval-request":
      case "tool-approval-response":
        return true;
    }
  });
}

function hasDisplayableConversationMessage(message: Message) {
  return hasDisplayableConversationContent(message.content);
}

function readStructuredEventContent(event: SessionEventContract): AssistantMessageContent | null {
  const content = event.data.content;
  return Array.isArray(content) ? (content as AssistantMessageContent) : null;
}

function normalizeNarrativeAssistantPart(value: unknown): Extract<AssistantMessageContent, unknown[]>[number] | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  if (value.type === "text" && typeof value.text === "string" && value.text.trim().length > 0) {
    return value as Extract<Extract<AssistantMessageContent, unknown[]>[number], { type: "text" }>;
  }

  if (value.type === "reasoning" && typeof value.text === "string" && value.text.trim().length > 0) {
    return value as Extract<Extract<AssistantMessageContent, unknown[]>[number], { type: "reasoning" }>;
  }

  if (value.type === "file" && typeof value.data === "string" && typeof value.mediaType === "string") {
    return value as Extract<Extract<AssistantMessageContent, unknown[]>[number], { type: "file" }>;
  }

  return null;
}

function readRunStepNarrativeContent(step: RunStep): AssistantMessageContent | null {
  const response = isRecord(step.output) && isRecord(step.output.response) ? step.output.response : null;
  if (!response) {
    return null;
  }

  const parts: Extract<AssistantMessageContent, unknown[]> = [];
  const seen = new Set<string>();
  const pushPart = (part: Extract<AssistantMessageContent, unknown[]>[number]) => {
    const serialized = JSON.stringify(part);
    if (seen.has(serialized)) {
      return;
    }
    seen.add(serialized);
    parts.push(part);
  };

  for (const rawPart of Array.isArray(response.content) ? response.content : []) {
    const part = normalizeNarrativeAssistantPart(rawPart);
    if (part) {
      pushPart(part);
    }
  }

  for (const rawPart of Array.isArray(response.reasoning) ? response.reasoning : []) {
    const part = normalizeNarrativeAssistantPart(rawPart);
    if (part?.type === "reasoning") {
      pushPart(part);
    }
  }

  if (parts.length > 0) {
    return parts;
  }

  return typeof response.text === "string" && response.text.trim().length > 0 ? response.text : null;
}

function hydrateEmptyAssistantMessageFromRunStep(
  message: Message,
  contentByStepId: ReadonlyMap<string, AssistantMessageContent>,
  contentByStepSeq: ReadonlyMap<number, AssistantMessageContent>
): Message {
  if (message.role !== "assistant" || hasDisplayableConversationContent(message.content)) {
    return message;
  }

  const stepRef = readMessageModelCallStepRef(message);
  const content =
    (stepRef?.stepId ? contentByStepId.get(stepRef.stepId) : undefined) ??
    (stepRef?.stepSeq !== undefined ? contentByStepSeq.get(stepRef.stepSeq) : undefined);
  return content ? { ...message, content } : message;
}

function isStreamedAssistantTextMessage(message: Message, deltaMessageIds: Set<string>) {
  if (message.role !== "assistant" || !deltaMessageIds.has(readComparableMessageId(message))) {
    return false;
  }

  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }

  const containsStructuredParts = message.content.some((part) => part.type !== "text");
  return !containsStructuredParts && contentText(message.content).trim().length > 0;
}

function projectRunConversation(messages: Message[], events: SessionEventContract[]) {
  if (messages.length === 0 || events.length === 0) {
    return messages;
  }

  const messagesById = new Map(messages.map((message) => [readComparableMessageId(message), message] as const));
  const deltaMessageIds = new Set<string>();
  for (const event of events) {
    if (event.event !== "message.delta") {
      continue;
    }

    const messageId = readEventMessageId(event);
    if (messageId) {
      deltaMessageIds.add(messageId);
    }
  }
  const runMessagesById = new Set(messages.map((message) => readComparableMessageId(message)));
  const projected: Message[] = [];
  const seenProjectedMessageIds = new Set<string>();
  const activeSegments = new Map<
    string,
    {
      index: number;
      content: string;
      createdAt: string;
    }
  >();
  const latestStructuredContentByMessageId = new Map<string, AssistantMessageContent>();
  const segmentCounts = new Map<string, number>();
  const flushSegment = (messageId: string) => {
    const activeSegment = activeSegments.get(messageId);
    if (!activeSegment || activeSegment.content.trim().length === 0) {
      activeSegments.delete(messageId);
      return;
    }

    const persistedMessage = messagesById.get(messageId);
    if (!persistedMessage) {
      activeSegments.delete(messageId);
      return;
    }

    projected.push({
      id: `segment:${messageId}:${activeSegment.index}`,
      sessionId: persistedMessage.sessionId,
      ...(persistedMessage.runId ? { runId: persistedMessage.runId } : {}),
      role: "assistant",
      content: activeSegment.content,
      ...(persistedMessage.metadata ? { metadata: persistedMessage.metadata } : {}),
      createdAt: activeSegment.createdAt
    });
    seenProjectedMessageIds.add(messageId);
    activeSegments.delete(messageId);
  };
  const flushAllSegments = () => {
    const activeMessageIds = [...activeSegments.keys()].sort((left, right) => left.localeCompare(right));
    for (const messageId of activeMessageIds) {
      flushSegment(messageId);
    }
  };

  for (const event of events) {
    const messageId = readEventMessageId(event);

    if ((event.event === "message.delta" || event.event === "message.completed") && messageId && runMessagesById.has(messageId)) {
      const structuredContent = readStructuredEventContent(event);
      if (structuredContent && hasDisplayableConversationContent(structuredContent)) {
        latestStructuredContentByMessageId.set(messageId, structuredContent);
      }
    }

    if (event.event === "message.delta" && messageId && runMessagesById.has(messageId)) {
      if (latestStructuredContentByMessageId.has(messageId)) {
        continue;
      }

      const existingSegment = activeSegments.get(messageId);
      if (existingSegment) {
        existingSegment.content += typeof event.data.delta === "string" ? event.data.delta : "";
        continue;
      }

      const nextIndex = (segmentCounts.get(messageId) ?? 0) + 1;
      segmentCounts.set(messageId, nextIndex);
      activeSegments.set(messageId, {
        index: nextIndex,
        content: typeof event.data.delta === "string" ? event.data.delta : "",
        createdAt: event.createdAt
      });
      continue;
    }

    if (event.event === "message.completed" && messageId && runMessagesById.has(messageId)) {
      for (const activeMessageId of [...activeSegments.keys()]) {
        if (activeMessageId !== messageId) {
          flushSegment(activeMessageId);
        }
      }

      const completedMessage = messagesById.get(messageId);
      if (!completedMessage) {
        continue;
      }

      if (isStreamedAssistantTextMessage(completedMessage, deltaMessageIds)) {
        flushSegment(messageId);
        continue;
      }

      const latestStructuredContent = latestStructuredContentByMessageId.get(messageId);
      if (completedMessage.role === "assistant" && !hasDisplayableConversationContent(completedMessage.content) && latestStructuredContent) {
        activeSegments.delete(messageId);
        projected.push({
          ...completedMessage,
          content: latestStructuredContent
        });
        seenProjectedMessageIds.add(messageId);
        continue;
      }

      activeSegments.delete(messageId);
      projected.push(completedMessage);
      seenProjectedMessageIds.add(messageId);
      continue;
    }

    if (
      event.event === "run.completed" ||
      event.event === "run.failed" ||
      event.event === "run.cancelled"
    ) {
      flushAllSegments();
    }
  }

  flushAllSegments();

  const fallbackMessages = messages.filter(
    (message) =>
      !seenProjectedMessageIds.has(readComparableMessageId(message)) &&
      !isStreamedAssistantTextMessage(message, deltaMessageIds)
  );

  if (projected.length === 0 || fallbackMessages.length === 0) {
    return [...fallbackMessages, ...projected];
  }

  const mergedProjectedMessages = [...projected];
  for (const fallbackMessage of [...fallbackMessages].sort(compareMessagesChronologically)) {
    const insertIndex = mergedProjectedMessages.findIndex(
      (projectedMessage) => compareMessagesChronologically(fallbackMessage, projectedMessage) < 0
    );
    if (insertIndex < 0) {
      mergedProjectedMessages.push(fallbackMessage);
    } else {
      mergedProjectedMessages.splice(insertIndex, 0, fallbackMessage);
    }
  }

  return mergedProjectedMessages;
}

function buildProjectedMessageFeed(params: {
  messages: Message[];
  deferredEvents: SessionEventContract[];
  liveMessages: Message[];
}) {
  const orderedEvents = [...params.deferredEvents].sort((left, right) => readEventCursorValue(left) - readEventCursorValue(right));
  const eventsByRunId = new Map<string, SessionEventContract[]>();
  const messagesByRunId = new Map<string, Message[]>();
  const messageTimestampById = new Map<string, number>();
  const eventTimestampById = new Map<string, number>();

  const readMessageTimestamp = (message: Message) => {
    const cached = messageTimestampById.get(message.id);
    if (cached !== undefined) {
      return cached;
    }

    const timestamp = parseComparableTimestamp(message.createdAt);
    messageTimestampById.set(message.id, timestamp);
    return timestamp;
  };

  const readEventTimestamp = (event: SessionEventContract) => {
    const cached = eventTimestampById.get(event.id);
    if (cached !== undefined) {
      return cached;
    }

    const timestamp = parseComparableTimestamp(event.createdAt);
    eventTimestampById.set(event.id, timestamp);
    return timestamp;
  };

  for (const event of orderedEvents) {
    if (!event.runId) {
      continue;
    }

    const current = eventsByRunId.get(event.runId) ?? [];
    current.push(event);
    eventsByRunId.set(event.runId, current);
  }

  const mergedMessagesById = new Map<string, Message>();
  for (const message of params.messages) {
    mergedMessagesById.set(readComparableMessageId(message), message);
  }
  for (const message of params.liveMessages) {
    mergedMessagesById.set(readComparableMessageId(message), message);
  }
  const mergedMessages = [...mergedMessagesById.values()].sort(compareMessagesChronologically);

  for (const message of mergedMessages) {
    if (!message.runId) {
      continue;
    }

    const current = messagesByRunId.get(message.runId) ?? [];
    current.push(message);
    messagesByRunId.set(message.runId, current);
  }

  const projectedRuns = new Map<string, Message[]>();
  const runDisplayAnchorTimestamps = new Map<string, number>();
  for (const [runId, runMessages] of messagesByRunId) {
    const runEvents = eventsByRunId.get(runId) ?? [];
    projectedRuns.set(runId, projectRunConversation(runMessages, runEvents));
    runDisplayAnchorTimestamps.set(runId, resolveRunDisplayAnchorTimestamp(runMessages, runEvents, readMessageTimestamp, readEventTimestamp));
  }

  const orderedFeedEntries = [...mergedMessages].sort((left, right) => {
    const leftTimestamp = left.runId
      ? (runDisplayAnchorTimestamps.get(left.runId) ?? readMessageTimestamp(left))
      : readMessageTimestamp(left);
    const rightTimestamp = right.runId
      ? (runDisplayAnchorTimestamps.get(right.runId) ?? readMessageTimestamp(right))
      : readMessageTimestamp(right);
    const timestampComparison =
      Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp) ? leftTimestamp - rightTimestamp : 0;
    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return compareMessagesChronologically(left, right);
  });

  const seenRunIds = new Set<string>();
  const projectedFeed: Message[] = [];
  for (const message of orderedFeedEntries) {
    if (!message.runId) {
      projectedFeed.push(message);
      continue;
    }

    if (seenRunIds.has(message.runId)) {
      continue;
    }

    seenRunIds.add(message.runId);
    projectedFeed.push(...(projectedRuns.get(message.runId) ?? [message]));
  }

  return projectedFeed;
}

export function buildRuntimeViewModel(params: {
  messages: Message[];
  queuedMessageIds: ReadonlySet<string>;
  runSteps: RunStep[];
  deferredEvents: SessionEventContract[];
  liveMessagesByKey: Record<string, LiveConversationMessageRecord>;
  selectedTraceId: string;
  selectedMessageId: string;
  selectedStepId: string;
  selectedEventId: string;
  sessionId: string;
}) {
  const visibleMessages = params.messages.filter(
    (message) =>
      !params.queuedMessageIds.has(message.id) &&
      (!params.sessionId.trim() || !message.sessionId || message.sessionId === params.sessionId)
  );
  const modelCallTraces: ModelCallTrace[] = [];
  const modelCallTracesById = new Map<string, ModelCallTrace>();
  const modelCallTracesBySeq = new Map<number, ModelCallTrace>();
  const narrativeContentByStepId = new Map<string, AssistantMessageContent>();
  const narrativeContentByStepSeq = new Map<number, AssistantMessageContent>();
  const engineToolNames: string[] = [];
  const advertisedToolNames: string[] = [];
  const resolvedModelNameCandidates: string[] = [];
  const resolvedModelRefCandidates: string[] = [];
  const engineToolsByName = new Map<string, ModelCallTrace["input"]["engineTools"][number]>();
  const toolServersByName = new Map<string, ModelCallTrace["input"]["toolServers"][number]>();

  for (const step of params.runSteps) {
    const trace = toModelCallTrace(step);
    if (!trace) {
      continue;
    }

    const narrativeContent = readRunStepNarrativeContent(step);
    if (narrativeContent && hasDisplayableConversationContent(narrativeContent)) {
      narrativeContentByStepId.set(step.id, narrativeContent);
      narrativeContentByStepSeq.set(step.seq, narrativeContent);
    }

    modelCallTraces.push(trace);
    modelCallTracesById.set(trace.id, trace);
    modelCallTracesBySeq.set(trace.seq, trace);
    engineToolNames.push(...trace.input.engineToolNames);
    advertisedToolNames.push(...trace.input.activeToolNames);
    if (trace.input.model) {
      resolvedModelNameCandidates.push(trace.input.model);
    }
    if (trace.input.canonicalModelRef) {
      resolvedModelRefCandidates.push(trace.input.canonicalModelRef);
    }
    for (const tool of trace.input.engineTools) {
      engineToolsByName.set(tool.name, tool);
    }
    for (const server of trace.input.toolServers) {
      toolServersByName.set(server.name, server);
    }
  }

  const hydratedVisibleMessages = visibleMessages.map((message) =>
    hydrateEmptyAssistantMessageFromRunStep(message, narrativeContentByStepId, narrativeContentByStepSeq)
  );
  const firstModelCallTrace = modelCallTraces[0] ?? null;
  const latestModelCallTrace = modelCallTraces.at(-1) ?? null;
  const selectedModelCallTrace = modelCallTracesById.get(params.selectedTraceId) ?? firstModelCallTrace;
  const composedSystemMessages = firstModelCallTrace?.input.messages.filter((message) => message.role === "system") ?? [];
  const storedMessageCounts = countMessagesByRole(hydratedVisibleMessages);
  const latestModelMessageCounts = countMessagesByRole(latestModelCallTrace?.input.messages ?? []);
  const selectedSessionMessage =
    hydratedVisibleMessages.find((message) => message.id === params.selectedMessageId) ?? hydratedVisibleMessages[0] ?? null;
  const selectedMessageSystemMessages = (() => {
    if (!selectedSessionMessage) {
      return [];
    }

    const snapshot = readMessageSystemPromptSnapshot(selectedSessionMessage);
    if (snapshot.length > 0) {
      return snapshot;
    }

    const stepRef = readMessageModelCallStepRef(selectedSessionMessage);
    const matchedTrace =
      (stepRef?.stepId ? modelCallTracesById.get(stepRef.stepId) : undefined) ??
      (stepRef?.stepSeq !== undefined ? modelCallTracesBySeq.get(stepRef.stepSeq) : undefined);
    return matchedTrace?.input.messages.filter((message) => message.role === "system") ?? [];
  })();
  const selectedRunStep = params.runSteps.find((step) => step.id === params.selectedStepId) ?? params.runSteps[0] ?? null;
  const selectedSessionEvent =
    params.deferredEvents.find((event) => event.id === params.selectedEventId) ?? params.deferredEvents[0] ?? null;
  const allEngineToolNames = uniqueStrings(engineToolNames);
  const allAdvertisedToolNames = uniqueStrings(advertisedToolNames);
  const allEngineTools = [...engineToolsByName.values()];
  const allToolServers = [...toolServersByName.values()];
  const resolvedModelNames = uniqueStrings(resolvedModelNameCandidates);
  const resolvedModelRefs = uniqueStrings(resolvedModelRefCandidates);
  const persistedMessagesById = new Map(hydratedVisibleMessages.map((message) => [message.id, message] as const));
  const persistedToolRefKeys = new Set<string>();
  for (const message of hydratedVisibleMessages) {
    for (const ref of contentToolRefs(message.content)) {
      persistedToolRefKeys.add(`${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`);
    }
  }
  const liveMessages: Message[] = [];
  for (const [liveMessageKey, entry] of Object.entries(params.liveMessagesByKey)) {
    const hasTextContent = contentText(entry.content).trim().length > 0;
    const toolRefKeys = contentToolRefs(entry.content).map(
      (ref) => `${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`
    );
    if (!hasTextContent && toolRefKeys.length === 0) {
      continue;
    }

    if (
      toolRefKeys.length > 0 &&
      (!entry.persistedMessageId || !persistedMessagesById.has(entry.persistedMessageId)) &&
      !toolRefKeys.some((key) => !persistedToolRefKeys.has(key))
    ) {
      continue;
    }

    if (toolRefKeys.length === 0 && !hasTextContent) {
      continue;
    }

    const persistedMessage = entry.persistedMessageId ? persistedMessagesById.get(entry.persistedMessageId) : undefined;
    const liveMessage = buildMessageRecord({
      id: `live:${entry.persistedMessageId ?? liveMessageKey}`,
      sessionId: entry.sessionId || params.sessionId || "live",
      runId: entry.runId,
      role: persistedMessage?.role ?? entry.role ?? "assistant",
      content: entry.content,
      ...(persistedMessage?.metadata || entry.metadata ? { metadata: persistedMessage?.metadata ?? entry.metadata } : {}),
      createdAt: persistedMessage?.createdAt ?? entry.createdAt
    });
    if (liveMessage) {
      liveMessages.push(liveMessage);
    }
  }
  const messageFeed = buildProjectedMessageFeed({
    messages: hydratedVisibleMessages,
    deferredEvents: params.deferredEvents,
    liveMessages
  }).filter(hasDisplayableConversationMessage);

  return {
    modelCallTraces,
    firstModelCallTrace,
    latestModelCallTrace,
    selectedModelCallTrace,
    composedSystemMessages,
    storedMessageCounts,
    latestModelMessageCounts,
    selectedSessionMessage,
    selectedMessageSystemMessages,
    selectedRunStep,
    selectedSessionEvent,
    allEngineToolNames,
    allAdvertisedToolNames,
    allEngineTools,
    allToolServers,
    resolvedModelNames,
    resolvedModelRefs,
    messageFeed
  };
}

export type RuntimeViewModel = ReturnType<typeof buildRuntimeViewModel>;
