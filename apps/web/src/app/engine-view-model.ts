import type { Message, RunStep, SessionEventContract } from "@oah/api-contracts";

import {
  buildMessageRecord,
  compareMessagesChronologically,
  contentText,
  contentToolRefs,
  countMessagesByRole,
  readMessageModelCallStepRef,
  readMessageSystemPromptSnapshot,
  toModelCallTrace,
  uniqueStrings,
  type LiveConversationMessageRecord,
  type ModelCallTrace
} from "./support";

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

function resolveRunDisplayAnchorTimestamp(messages: Message[], events: SessionEventContract[]) {
  const earliestMessageTimestamp = messages.reduce((current, message) => {
    const timestamp = parseComparableTimestamp(message.createdAt);
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

    const timestamp = parseComparableTimestamp(event.createdAt);
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

    if (event.event === "message.delta" && messageId && runMessagesById.has(messageId)) {
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

  const firstProjectedMessageIndex = messages.findIndex(
    (message) => seenProjectedMessageIds.has(readComparableMessageId(message)) || isStreamedAssistantTextMessage(message, deltaMessageIds)
  );
  if (firstProjectedMessageIndex <= 0) {
    return [...projected, ...fallbackMessages];
  }

  const fallbackMessageIds = new Set(fallbackMessages.map((message) => message.id));
  const leadingFallbackMessages = messages.slice(0, firstProjectedMessageIndex).filter((message) => fallbackMessageIds.has(message.id));
  const leadingFallbackIds = new Set(leadingFallbackMessages.map((message) => message.id));
  const trailingFallbackMessages = fallbackMessages.filter((message) => !leadingFallbackIds.has(message.id));

  return [...leadingFallbackMessages, ...projected, ...trailingFallbackMessages];
}

function buildProjectedMessageFeed(params: {
  messages: Message[];
  deferredEvents: SessionEventContract[];
  liveMessages: Message[];
}) {
  const orderedMessages = [...params.messages].sort(compareMessagesChronologically);
  const orderedEvents = [...params.deferredEvents].sort((left, right) => readEventCursorValue(left) - readEventCursorValue(right));
  const eventsByRunId = new Map<string, SessionEventContract[]>();
  const messagesByRunId = new Map<string, Message[]>();

  for (const event of orderedEvents) {
    if (!event.runId) {
      continue;
    }

    const current = eventsByRunId.get(event.runId) ?? [];
    current.push(event);
    eventsByRunId.set(event.runId, current);
  }

  const mergedMessagesById = new Map<string, Message>();
  for (const message of orderedMessages) {
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
    runDisplayAnchorTimestamps.set(runId, resolveRunDisplayAnchorTimestamp(runMessages, runEvents));
  }

  const orderedFeedEntries = [...mergedMessages].sort((left, right) => {
    const leftTimestamp = left.runId
      ? (runDisplayAnchorTimestamps.get(left.runId) ?? parseComparableTimestamp(left.createdAt))
      : parseComparableTimestamp(left.createdAt);
    const rightTimestamp = right.runId
      ? (runDisplayAnchorTimestamps.get(right.runId) ?? parseComparableTimestamp(right.createdAt))
      : parseComparableTimestamp(right.createdAt);
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
  const visibleMessages = params.messages.filter((message) => !params.queuedMessageIds.has(message.id));
  const modelCallTraces = params.runSteps.map(toModelCallTrace).filter((trace): trace is ModelCallTrace => trace !== null);
  const modelCallTracesById = new Map(modelCallTraces.map((trace) => [trace.id, trace] as const));
  const modelCallTracesBySeq = new Map(modelCallTraces.map((trace) => [trace.seq, trace] as const));
  const firstModelCallTrace = modelCallTraces[0] ?? null;
  const latestModelCallTrace = modelCallTraces.at(-1) ?? null;
  const selectedModelCallTrace = modelCallTraces.find((trace) => trace.id === params.selectedTraceId) ?? firstModelCallTrace;
  const composedSystemMessages = firstModelCallTrace?.input.messages.filter((message) => message.role === "system") ?? [];
  const storedMessageCounts = countMessagesByRole(visibleMessages);
  const latestModelMessageCounts = countMessagesByRole(latestModelCallTrace?.input.messages ?? []);
  const selectedSessionMessage =
    visibleMessages.find((message) => message.id === params.selectedMessageId) ?? visibleMessages[0] ?? null;
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
  const allEngineToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.engineToolNames));
  const allAdvertisedToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.activeToolNames));
  const allEngineTools = [
    ...new Map(modelCallTraces.flatMap((trace) => trace.input.engineTools).map((tool) => [tool.name, tool])).values()
  ];
  const allToolServers = [...new Map(modelCallTraces.flatMap((trace) => trace.input.toolServers).map((server) => [server.name, server])).values()];
  const resolvedModelNames = uniqueStrings(modelCallTraces.map((trace) => trace.input.model).filter((value): value is string => Boolean(value)));
  const resolvedModelRefs = uniqueStrings(
    modelCallTraces.map((trace) => trace.input.canonicalModelRef).filter((value): value is string => Boolean(value))
  );
  const persistedMessagesById = new Map(visibleMessages.map((message) => [message.id, message] as const));
  const persistedToolRefKeys = new Set<string>();
  for (const message of visibleMessages) {
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
    messages: visibleMessages,
    deferredEvents: params.deferredEvents,
    liveMessages
  });

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
