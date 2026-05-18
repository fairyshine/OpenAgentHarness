import { startTransition, useEffect, useEffectEvent, useRef, type Dispatch, type SetStateAction } from "react";

import type { Message, SessionEventContract, SessionQueuedRun } from "@oah/api-contracts";

import {
  buildMessageRecord,
  contentToolRefs,
  inferCompletedMessageRole,
  isRecord,
  isTerminalRunEvent,
  normalizeMessageContent,
  upsertSessionMessage,
  type LiveConversationMessageRecord,
  type SseFrame
} from "./support";
import {
  ACTIVITY_VISIBLE_EVENTS,
  RUN_DETAIL_REFRESH_EVENTS,
  SESSION_RUN_LIST_REFRESH_EVENTS,
  readQueuedRunsFromEventData
} from "./app-controller-utils";
import { createClientId } from "./client-id";

const MAX_LIVE_SESSION_EVENTS = 600;
const LIVE_SESSION_EVENT_FLUSH_MS = 80;
const MAX_LIVE_STREAMING_TOOL_INPUT_CHARS = 16000;
const MAX_LIVE_TOOL_PAYLOAD_CHARS = 32000;
const MAX_LIVE_TOOL_COLLECTION_ITEMS = 80;

type CursorRef = {
  current: string | undefined;
};

type PendingLiveMessageDelta = {
  persistedMessageId: string;
  runId: string;
  sessionId: string;
  contentDelta: string;
  content?: Message["content"];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

function readEventMessageId(event: SessionEventContract) {
  return typeof event.data.messageId === "string" ? event.data.messageId : undefined;
}

function canCoalesceTextDelta(left: SessionEventContract, right: SessionEventContract) {
  return (
    left.event === "message.delta" &&
    right.event === "message.delta" &&
    left.runId === right.runId &&
    readEventMessageId(left) === readEventMessageId(right) &&
    typeof left.data.delta === "string" &&
    typeof right.data.delta === "string" &&
    left.data.content === undefined &&
    right.data.content === undefined
  );
}

function mergeTextDeltaEvent(left: SessionEventContract, right: SessionEventContract): SessionEventContract {
  return {
    ...left,
    data: {
      ...left.data,
      delta: `${left.data.delta}${right.data.delta}`
    }
  };
}

function coalesceChronologicalEvents(events: SessionEventContract[]) {
  const coalesced: SessionEventContract[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (previous && canCoalesceTextDelta(previous, event)) {
      coalesced[coalesced.length - 1] = mergeTextDeltaEvent(previous, event);
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function compactMessageDeltaMetadata(metadata: unknown) {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const compacted: Record<string, unknown> = {};
  for (const key of [
    "agentName",
    "effectiveAgentName",
    "agentMode",
    "modelCallStepId",
    "modelCallStepSeq",
    "toolStatus",
    "toolSourceType",
    "toolDurationMs"
  ]) {
    if (metadata[key] !== undefined) {
      compacted[key] = metadata[key];
    }
  }

  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactLivePayloadValue(value: unknown, limit = MAX_LIVE_TOOL_PAYLOAD_CHARS) {
  const seen = new WeakSet<object>();
  let remaining = limit;
  let truncated = false;

  const consume = (amount: number) => {
    remaining -= amount;
    if (remaining < 0) {
      truncated = true;
      return false;
    }
    return true;
  };

  const walk = (entry: unknown, depth: number): unknown => {
    if (remaining <= 0) {
      truncated = true;
      return "[truncated]";
    }

    if (typeof entry === "string") {
      if (consume(entry.length)) {
        return entry;
      }
      return `${entry.slice(0, Math.max(0, remaining + entry.length))}... truncated`;
    }

    if (entry === null || typeof entry !== "object") {
      consume(String(entry).length);
      return entry;
    }

    if (seen.has(entry)) {
      return "[Circular]";
    }

    if (depth >= 8) {
      truncated = true;
      return "[Max depth]";
    }

    seen.add(entry);
    if (Array.isArray(entry)) {
      const next: unknown[] = [];
      for (let index = 0; index < entry.length && index < MAX_LIVE_TOOL_COLLECTION_ITEMS; index += 1) {
        next.push(walk(entry[index], depth + 1));
        if (remaining <= 0) {
          break;
        }
      }
      if (entry.length > next.length) {
        truncated = true;
        next.push(`... ${entry.length - next.length} more items`);
      }
      seen.delete(entry);
      return next;
    }

    const next: Record<string, unknown> = {};
    let copiedCount = 0;
    for (const key in entry as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) {
        continue;
      }
      if (copiedCount >= MAX_LIVE_TOOL_COLLECTION_ITEMS || remaining <= 0) {
        truncated = true;
        break;
      }
      consume(key.length);
      next[key] = walk((entry as Record<string, unknown>)[key], depth + 1);
      copiedCount += 1;
    }
    seen.delete(entry);
    return next;
  };

  const compacted = walk(value, 0);
  if (!truncated) {
    return compacted;
  }

  if (isRecord(compacted)) {
    return {
      ...compacted,
      __previewTruncated: true
    };
  }

  return compacted;
}

function compactSessionEventForState(event: SessionEventContract): SessionEventContract {
  if (event.event === "tool.started") {
    return {
      ...event,
      data: {
        ...event.data,
        ...(event.data.input !== undefined ? { input: compactLivePayloadValue(event.data.input) } : {})
      }
    };
  }

  if (event.event === "tool.completed" || event.event === "tool.failed") {
    return {
      ...event,
      data: {
        ...event.data,
        ...(event.data.output !== undefined ? { output: compactLivePayloadValue(event.data.output) } : {}),
        ...(typeof event.data.errorMessage === "string" ? { errorMessage: capStreamingToolInputText(event.data.errorMessage).__streamingInput } : {})
      }
    };
  }

  if (event.event !== "message.delta") {
    return event;
  }

  const data: Record<string, unknown> = { ...event.data };
  delete data.content;

  const compactedMetadata = compactMessageDeltaMetadata(data.metadata);
  if (compactedMetadata) {
    data.metadata = compactedMetadata;
  } else {
    delete data.metadata;
  }

  return {
    ...event,
    data
  };
}

function isStreamingToolInput(value: unknown): value is { __streamingInput: string } {
  return isRecord(value) && typeof value.__streamingInput === "string";
}

function findStreamingTextOverlap(existingText: string, nextText: string) {
  const maxOverlap = Math.min(existingText.length, nextText.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existingText.endsWith(nextText.slice(0, overlap))) {
      return overlap;
    }
  }

  return 0;
}

function capStreamingToolInputText(text: string, alreadyTruncatedChars = 0) {
  if (text.length <= MAX_LIVE_STREAMING_TOOL_INPUT_CHARS) {
    return {
      __streamingInput: text,
      ...(alreadyTruncatedChars > 0 ? { __streamingInputTruncatedChars: alreadyTruncatedChars } : {})
    };
  }

  return {
    __streamingInput: text.slice(-MAX_LIVE_STREAMING_TOOL_INPUT_CHARS),
    __streamingInputTruncatedChars: alreadyTruncatedChars + text.length - MAX_LIVE_STREAMING_TOOL_INPUT_CHARS
  };
}

function mergeStreamingToolInputText(existingText: string, nextText: string) {
  if (!existingText) {
    return nextText;
  }

  if (!nextText) {
    return existingText;
  }

  if (nextText.startsWith(existingText) || nextText.includes(existingText)) {
    return nextText;
  }

  if (existingText.includes(nextText)) {
    return existingText;
  }

  const overlap = findStreamingTextOverlap(existingText, nextText);
  return `${existingText}${nextText.slice(overlap)}`;
}

function mergeStreamingToolInputContent(
  existingContent: Message["content"] | undefined,
  nextContent: Message["content"]
): Message["content"] {
  if (!Array.isArray(nextContent)) {
    return nextContent;
  }

  return nextContent.map((part) => {
    if (part.type !== "tool-call" || !isStreamingToolInput(part.input)) {
      return part;
    }

    const existingPart = Array.isArray(existingContent)
      ? existingContent.find((candidate) => candidate.type === "tool-call" && candidate.toolCallId === part.toolCallId)
      : undefined;
    if (existingPart?.type !== "tool-call" || !isStreamingToolInput(existingPart.input)) {
      return {
        ...part,
        input: capStreamingToolInputText(part.input.__streamingInput)
      };
    }

    const nextText = part.input.__streamingInput;
    const existingText = existingPart.input.__streamingInput;
    const existingTruncatedChars =
      isRecord(existingPart.input) &&
      typeof existingPart.input.__streamingInputTruncatedChars === "number" &&
      Number.isFinite(existingPart.input.__streamingInputTruncatedChars)
        ? existingPart.input.__streamingInputTruncatedChars
        : 0;
    const mergedText = mergeStreamingToolInputText(existingText, nextText);
    return {
      ...part,
      input: capStreamingToolInputText(mergedText, existingTruncatedChars)
    };
  });
}

export function useSessionEventHandler(input: {
  sessionId: string;
  messages: Message[];
  liveMessagesByKey: Record<string, LiveConversationMessageRecord>;
  lastCursorRef: CursorRef;
  setEvents: Dispatch<SetStateAction<SessionEventContract[]>>;
  setSelectedRunId: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setLiveMessagesByKey: Dispatch<SetStateAction<Record<string, LiveConversationMessageRecord>>>;
  setSessionQueuedRuns: Dispatch<SetStateAction<SessionQueuedRun[]>>;
  setActivity: (value: string) => void;
  scheduleMessagesRefresh: () => void;
  scheduleRunRefresh: (runId: string) => void;
  scheduleWorkspaceIndexRefresh: () => void;
  refreshSessionQueue: (quiet?: boolean) => Promise<void>;
  scheduleSessionRunsRefresh: () => void;
  refreshSidebarSessionRuns: (quiet?: boolean, options?: { includeChildren?: boolean }) => Promise<boolean>;
  refreshSessionById: (targetId: string, quiet?: boolean) => Promise<unknown>;
  syncCurrentSessionAgent: (agentName: string, updatedAt: string) => void;
}) {
  const pendingEventsRef = useRef<SessionEventContract[]>([]);
  const pendingEventFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingLiveMessageDeltasRef = useRef<Record<string, PendingLiveMessageDelta>>({});
  const pendingLiveMessageFlushTimerRef = useRef<number | undefined>(undefined);

  const flushPendingEvents = useEffectEvent(() => {
    window.clearTimeout(pendingEventFlushTimerRef.current);
    pendingEventFlushTimerRef.current = undefined;
    const pendingEvents = coalesceChronologicalEvents(pendingEventsRef.current);
    pendingEventsRef.current = [];
    if (pendingEvents.length === 0) {
      return;
    }

    startTransition(() => {
      input.setEvents((current) => {
        let next = current;
        for (const event of pendingEvents) {
          const previousHead = next[0];
          if (previousHead && canCoalesceTextDelta(previousHead, event)) {
            next = [mergeTextDeltaEvent(previousHead, event), ...next.slice(1)];
          } else {
            next = [event, ...next];
          }
        }
        return next.slice(0, MAX_LIVE_SESSION_EVENTS);
      });
    });
  });

  const scheduleEventFlush = useEffectEvent((event: SessionEventContract) => {
    pendingEventsRef.current.push(compactSessionEventForState(event));
    if (pendingEventFlushTimerRef.current !== undefined) {
      return;
    }

    pendingEventFlushTimerRef.current = window.setTimeout(flushPendingEvents, LIVE_SESSION_EVENT_FLUSH_MS);
  });

  const flushPendingLiveMessageDeltas = useEffectEvent(() => {
    window.clearTimeout(pendingLiveMessageFlushTimerRef.current);
    pendingLiveMessageFlushTimerRef.current = undefined;
    const pendingByKey = pendingLiveMessageDeltasRef.current;
    pendingLiveMessageDeltasRef.current = {};
    const pendingEntries = Object.entries(pendingByKey);
    if (pendingEntries.length === 0) {
      return;
    }

    input.setLiveMessagesByKey((current) => {
      let next: Record<string, LiveConversationMessageRecord> | undefined;
      for (const [liveMessageKey, pending] of pendingEntries) {
        const existingEntry = (next ?? current)[liveMessageKey];
        const content =
          pending.content !== undefined
            ? mergeStreamingToolInputContent(existingEntry?.content, pending.content)
            : `${typeof existingEntry?.content === "string" ? existingEntry.content : ""}${pending.contentDelta}`;
        const metadata = existingEntry?.metadata ?? pending.metadata;
        next = next ?? { ...current };
        next[liveMessageKey] = {
          ...(existingEntry?.persistedMessageId ? { persistedMessageId: existingEntry.persistedMessageId } : {}),
          persistedMessageId: pending.persistedMessageId,
          runId: pending.runId,
          sessionId: pending.sessionId,
          role: "assistant",
          content,
          ...(metadata ? { metadata } : {}),
          createdAt: existingEntry?.createdAt ?? pending.createdAt
        };
      }

      return next ?? current;
    });
  });

  const scheduleLiveMessageDeltaFlush = useEffectEvent((inputDelta: PendingLiveMessageDelta) => {
    const liveMessageKey = `message:${inputDelta.persistedMessageId}`;
    const existingDelta = pendingLiveMessageDeltasRef.current[liveMessageKey];
    pendingLiveMessageDeltasRef.current[liveMessageKey] = {
      ...inputDelta,
      contentDelta: `${existingDelta?.contentDelta ?? ""}${inputDelta.contentDelta}`,
      ...(inputDelta.content !== undefined ? { content: inputDelta.content } : existingDelta?.content !== undefined ? { content: existingDelta.content } : {}),
      ...(existingDelta?.metadata ?? inputDelta.metadata ? { metadata: existingDelta?.metadata ?? inputDelta.metadata } : {}),
      createdAt: existingDelta?.createdAt ?? inputDelta.createdAt
    };

    if (pendingLiveMessageFlushTimerRef.current !== undefined) {
      return;
    }

    pendingLiveMessageFlushTimerRef.current = window.setTimeout(flushPendingLiveMessageDeltas, LIVE_SESSION_EVENT_FLUSH_MS);
  });

  useEffect(() => {
    return () => {
      window.clearTimeout(pendingEventFlushTimerRef.current);
      window.clearTimeout(pendingLiveMessageFlushTimerRef.current);
      pendingEventsRef.current = [];
      pendingLiveMessageDeltasRef.current = {};
      pendingEventFlushTimerRef.current = undefined;
      pendingLiveMessageFlushTimerRef.current = undefined;
    };
  }, [input.sessionId]);

  return useEffectEvent((frame: SseFrame) => {
    const event = {
      id: frame.cursor ?? createClientId(),
      cursor: frame.cursor ?? String(Date.now()),
      sessionId: input.sessionId,
      runId: typeof frame.data.runId === "string" ? frame.data.runId : undefined,
      event: frame.event as SessionEventContract["event"],
      data: frame.data,
      createdAt: frame.createdAt ?? new Date().toISOString()
    } satisfies SessionEventContract;

    if (frame.cursor) {
      input.lastCursorRef.current = frame.cursor;
    }

    scheduleEventFlush(event);

    if (event.runId) {
      input.setSelectedRunId((current) => current || event.runId || "");
    }

    const eventMessageId = typeof event.data.messageId === "string" ? event.data.messageId : undefined;
    const eventMetadata = isRecord(event.data.metadata) ? event.data.metadata : undefined;
    const eventStructuredContent = normalizeMessageContent(event.data.content);
    const eventToolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
    const eventToolName = typeof event.data.toolName === "string" ? event.data.toolName : undefined;
    const eventToolStatus =
      eventMetadata?.toolStatus === "running" ||
      eventMetadata?.toolStatus === "started" ||
      eventMetadata?.toolStatus === "completed" ||
      eventMetadata?.toolStatus === "failed"
        ? eventMetadata.toolStatus
        : undefined;
    const eventQueueSnapshot = event.event === "queue.updated" ? readQueuedRunsFromEventData(event.data) : null;
    const eventQueueAction = typeof event.data.action === "string" ? event.data.action : undefined;

    const normalizeToolCallInput = (value: unknown): Record<string, unknown> | undefined => {
      const compactedValue = compactLivePayloadValue(value);
      if (isRecord(value)) {
        return isRecord(compactedValue) ? compactedValue : { value: compactedValue };
      }

      if (value === undefined) {
        return undefined;
      }

      return {
        value: compactedValue
      };
    };

    const normalizeToolResultOutput = (value: unknown, failed: boolean, fallback?: string) => {
      if (isRecord(value) && typeof value.type === "string") {
        return {
          ...value,
          ...(value.value !== undefined ? { value: compactLivePayloadValue(value.value) } : {})
        };
      }

      if (typeof value === "string") {
        return {
          type: failed ? "error-text" : "text",
          value: compactLivePayloadValue(value)
        };
      }

      if (value === undefined) {
        return {
          type: failed ? "error-text" : "text",
          value: fallback ?? (failed ? "Tool execution failed." : "")
        };
      }

      return {
        type: failed ? "error-json" : "json",
        value: compactLivePayloadValue(value)
      };
    };

    const upsertLiveToolMessage = (upsertInput: {
      key: string;
      role: "assistant" | "tool";
      content: Message["content"];
      createdAt: string;
      metadata?: Record<string, unknown>;
      toolCallId?: string;
    }) => {
      input.setLiveMessagesByKey((current) => {
        const existingEntry = current[upsertInput.key];
        return {
          ...current,
          [upsertInput.key]: {
            ...(existingEntry?.persistedMessageId ? { persistedMessageId: existingEntry.persistedMessageId } : {}),
            ...(() => {
              const toolCallId = upsertInput.toolCallId ?? existingEntry?.toolCallId;
              return toolCallId ? { toolCallId } : {};
            })(),
            runId: event.runId ?? "",
            sessionId: input.sessionId,
            role: upsertInput.role,
            content: upsertInput.content,
            ...(() => {
              const metadata = {
                ...(isRecord(existingEntry?.metadata) ? existingEntry.metadata : {}),
                ...(eventMetadata ?? {}),
                ...(upsertInput.metadata ?? {})
              };
              return Object.keys(metadata).length > 0 ? { metadata } : {};
            })(),
            createdAt: existingEntry?.createdAt ?? upsertInput.createdAt
          }
        };
      });
    };

    if (
      event.event === "message.delta" &&
      typeof event.runId === "string" &&
      typeof eventMessageId === "string" &&
      (typeof event.data.delta === "string" || eventStructuredContent !== null)
    ) {
      const runId = event.runId;
      const liveMessageKey = `message:${eventMessageId}`;
      const needsMessageHydration =
        !pendingLiveMessageDeltasRef.current[liveMessageKey] &&
        !input.liveMessagesByKey[liveMessageKey] &&
        !input.messages.some((message) => message.id === eventMessageId);
      scheduleLiveMessageDeltaFlush({
        persistedMessageId: eventMessageId,
        runId,
        sessionId: input.sessionId,
        contentDelta: typeof event.data.delta === "string" ? event.data.delta : "",
        ...(eventStructuredContent !== null ? { content: eventStructuredContent } : {}),
        ...(eventMetadata ? { metadata: eventMetadata } : {}),
        createdAt: event.createdAt
      });
      if (needsMessageHydration) {
        input.scheduleMessagesRefresh();
      }
    }

    if (event.event === "tool.started" && typeof event.runId === "string" && eventToolCallId && eventToolName) {
      const toolCallContent = normalizeMessageContent([
        {
          type: "tool-call",
          toolCallId: eventToolCallId,
          toolName: eventToolName,
          input: normalizeToolCallInput(event.data.input) ?? {}
        }
      ]);
      if (toolCallContent !== null) {
        const toolCallMessage = buildMessageRecord({
          id: `live-tool-call:${eventToolCallId}`,
          sessionId: input.sessionId,
          runId: event.runId,
          role: "assistant",
          content: toolCallContent,
          ...(eventMetadata ? { metadata: eventMetadata } : {}),
          createdAt: event.createdAt
        });
        if (toolCallMessage) {
          upsertLiveToolMessage({
            key: `tool-call:${eventToolCallId}`,
            role: "assistant",
            content: toolCallMessage.content,
            createdAt: event.createdAt,
            metadata: {
              toolStatus: "running",
              ...(typeof event.data.sourceType === "string" ? { toolSourceType: event.data.sourceType } : {})
            },
            toolCallId: eventToolCallId
          });
        }
      }
    }

    if (
      (event.event === "tool.completed" || event.event === "tool.failed") &&
      typeof event.runId === "string" &&
      eventToolCallId &&
      eventToolName
    ) {
      const toolResultContent = normalizeMessageContent([
        {
          type: "tool-result",
          toolCallId: eventToolCallId,
          toolName: eventToolName,
          output: normalizeToolResultOutput(
            event.data.output,
            event.event === "tool.failed",
            typeof event.data.errorMessage === "string" ? event.data.errorMessage : undefined
          )
        }
      ]);
      if (toolResultContent !== null) {
        const toolResultMessage = buildMessageRecord({
          id: `live-tool-result:${eventToolCallId}`,
          sessionId: input.sessionId,
          runId: event.runId,
          role: "tool",
          content: toolResultContent,
          ...(eventMetadata ? { metadata: eventMetadata } : {}),
          createdAt: event.createdAt
        });
        if (toolResultMessage) {
          upsertLiveToolMessage({
            key: `tool-result:${eventToolCallId}`,
            role: "tool",
            content: toolResultMessage.content,
            createdAt: event.createdAt,
            metadata: {
              toolStatus: event.event === "tool.failed" ? "failed" : (eventToolStatus ?? "completed"),
              ...(typeof event.data.sourceType === "string" ? { toolSourceType: event.data.sourceType } : {}),
              ...(typeof event.data.durationMs === "number" ? { toolDurationMs: event.data.durationMs } : {})
            },
            toolCallId: eventToolCallId
          });
        }
        input.setLiveMessagesByKey((current) => {
          const toolCallKey = `tool-call:${eventToolCallId}`;
          const currentEntry = current[toolCallKey];
          if (!currentEntry) {
            return current;
          }

          return {
            ...current,
            [toolCallKey]: {
              ...currentEntry,
              metadata: {
                ...(isRecord(currentEntry.metadata) ? currentEntry.metadata : {}),
                toolStatus: event.event === "tool.failed" ? "failed" : (eventToolStatus ?? "completed"),
                ...(typeof event.data.sourceType === "string" ? { toolSourceType: event.data.sourceType } : {}),
                ...(typeof event.data.durationMs === "number" ? { toolDurationMs: event.data.durationMs } : {})
              }
            }
          };
        });
      }
    }

    if (event.event === "message.completed" && typeof event.runId === "string") {
      const messageId = eventMessageId;
      const runId = event.runId;
      const content = normalizeMessageContent(event.data.content);
      if (messageId) {
        delete pendingLiveMessageDeltasRef.current[`message:${messageId}`];
        delete pendingLiveMessageDeltasRef.current[messageId];
      }
      if (messageId && content !== null) {
        startTransition(() => {
          input.setMessages((current) => {
            const existingMessage = current.find((message) => message.id === messageId);
            const completedMessage = buildMessageRecord({
              id: messageId,
              sessionId: input.sessionId,
              runId,
              role: inferCompletedMessageRole(event.data),
              content,
              ...(() => {
                const metadata =
                  existingMessage?.metadata ?? input.liveMessagesByKey[`message:${messageId}`]?.metadata ?? eventMetadata;
                return metadata ? { metadata } : {};
              })(),
              createdAt:
                existingMessage?.createdAt ?? input.liveMessagesByKey[`message:${messageId}`]?.createdAt ?? event.createdAt
            });
            return completedMessage ? upsertSessionMessage(current, completedMessage) : current;
          });
        });
      }
      input.setLiveMessagesByKey((current) => {
        const next = { ...current };
        if (messageId) {
          delete next[`message:${messageId}`];
        }
        if (content !== null) {
          const completedRefs = new Set(
            contentToolRefs(content).map((ref) => `${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`)
          );
          for (const [key, entry] of Object.entries(next)) {
            const entryRefs = contentToolRefs(entry.content).map(
              (ref) => `${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`
            );
            if (entryRefs.some((ref) => completedRefs.has(ref))) {
              delete next[key];
            }
          }
        }
        return next;
      });
      input.scheduleMessagesRefresh();
      input.scheduleRunRefresh(runId);
    }

    if (event.event === "agent.switched" && typeof event.data.toAgent === "string") {
      input.syncCurrentSessionAgent(event.data.toAgent, event.createdAt);
      input.scheduleMessagesRefresh();
    }

    if (event.event === "queue.updated") {
      if (eventQueueSnapshot) {
        startTransition(() => {
          input.setSessionQueuedRuns(eventQueueSnapshot);
        });
      } else {
        void input.refreshSessionQueue(true);
      }
      if (eventQueueAction === "dequeued" || eventQueueAction === "removed") {
        input.scheduleMessagesRefresh();
      }
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
      if (SESSION_RUN_LIST_REFRESH_EVENTS.has(event.event)) {
        input.scheduleSessionRunsRefresh();
      }
      if (RUN_DETAIL_REFRESH_EVENTS.has(event.event)) {
        input.scheduleRunRefresh(event.runId);
      }
    }

    if (event.event === "agent.delegate.started") {
      input.scheduleWorkspaceIndexRefresh();
    }

    if (
      event.event === "agent.delegate.started" ||
      event.event === "agent.delegate.completed" ||
      event.event === "agent.delegate.failed"
    ) {
      void input.refreshSidebarSessionRuns(true, { includeChildren: true });
    }

    if (typeof event.runId === "string" && isTerminalRunEvent(event.event)) {
      void input.refreshSessionById(input.sessionId, true);
      input.scheduleMessagesRefresh();
    }

    if (ACTIVITY_VISIBLE_EVENTS.has(event.event)) {
      input.setActivity(`${event.event}${event.runId ? ` · ${event.runId}` : ""}`);
    }
  });
}
