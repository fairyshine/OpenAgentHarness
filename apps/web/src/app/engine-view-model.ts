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
  type ModelCallTrace,
  type ModelCallTraceMessage
} from "./support";

function resolveMessageSystemMessages(message: Message | null, traces: ModelCallTrace[]): ModelCallTraceMessage[] {
  if (!message) {
    return [];
  }

  const snapshot = readMessageSystemPromptSnapshot(message);
  if (snapshot.length > 0) {
    return snapshot;
  }

  const stepRef = readMessageModelCallStepRef(message);
  if (stepRef?.stepId) {
    const matchedTrace = traces.find((trace) => trace.id === stepRef.stepId);
    if (matchedTrace) {
      return matchedTrace.input.messages.filter((traceMessage) => traceMessage.role === "system");
    }
  }

  if (stepRef?.stepSeq !== undefined) {
    const matchedTrace = traces.find((trace) => trace.seq === stepRef.stepSeq);
    if (matchedTrace) {
      return matchedTrace.input.messages.filter((traceMessage) => traceMessage.role === "system");
    }
  }

  return [];
}

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
  const deltaMessageIds = new Set(
    events.flatMap((event) => (event.event === "message.delta" ? [readEventMessageId(event)].filter((value): value is string => Boolean(value)) : []))
  );
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

  return [...projected, ...fallbackMessages];
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
  for (const [runId, runMessages] of messagesByRunId) {
    const runEvents = eventsByRunId.get(runId) ?? [];
    projectedRuns.set(runId, projectRunConversation(runMessages, runEvents));
  }

  const seenRunIds = new Set<string>();
  const projectedFeed: Message[] = [];
  for (const message of mergedMessages) {
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
  runSteps: RunStep[];
  deferredEvents: SessionEventContract[];
  liveMessagesByKey: Record<string, LiveConversationMessageRecord>;
  selectedTraceId: string;
  selectedMessageId: string;
  selectedStepId: string;
  selectedEventId: string;
  sessionId: string;
}) {
  const modelCallTraces = params.runSteps.map(toModelCallTrace).filter((trace): trace is ModelCallTrace => trace !== null);
  const firstModelCallTrace = modelCallTraces[0] ?? null;
  const latestModelCallTrace = modelCallTraces.at(-1) ?? null;
  const selectedModelCallTrace = modelCallTraces.find((trace) => trace.id === params.selectedTraceId) ?? firstModelCallTrace;
  const composedSystemMessages = firstModelCallTrace?.input.messages.filter((message) => message.role === "system") ?? [];
  const storedMessageCounts = countMessagesByRole(params.messages);
  const latestModelMessageCounts = countMessagesByRole(latestModelCallTrace?.input.messages ?? []);
  const selectedSessionMessage = params.messages.find((message) => message.id === params.selectedMessageId) ?? params.messages[0] ?? null;
  const selectedMessageSystemMessages = resolveMessageSystemMessages(selectedSessionMessage, modelCallTraces);
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
  const persistedMessagesById = new Map(params.messages.map((message) => [message.id, message]));
  const persistedToolRefKeys = new Set(
    params.messages.flatMap((message) =>
      contentToolRefs(message.content).map((ref) => `${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`)
    )
  );
  const liveEntries = Object.entries(params.liveMessagesByKey).filter(([, entry]) => {
    const hasTextContent = contentText(entry.content).trim().length > 0;
    const toolRefKeys = contentToolRefs(entry.content).map(
      (ref) => `${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`
    );
    if (!hasTextContent && toolRefKeys.length === 0) {
      return false;
    }

    if (entry.persistedMessageId && persistedMessagesById.has(entry.persistedMessageId)) {
      return true;
    }

    if (toolRefKeys.length === 0) {
      return hasTextContent;
    }

    return toolRefKeys.some((key) => !persistedToolRefKeys.has(key));
  });
  const liveMessages = liveEntries.flatMap(([liveMessageKey, entry]) => {
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
    return liveMessage ? [liveMessage] : [];
  });
  const messageFeed = buildProjectedMessageFeed({
    messages: params.messages,
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
