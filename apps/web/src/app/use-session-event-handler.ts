import { startTransition, useEffectEvent, type Dispatch, type SetStateAction } from "react";

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

type CursorRef = {
  current: string | undefined;
};

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
  refreshSessionRuns: (quiet?: boolean, options?: { includeSteps?: boolean | "selected" }) => Promise<void>;
  refreshSidebarSessionRuns: (quiet?: boolean) => Promise<boolean>;
  refreshSessionById: (targetId: string, quiet?: boolean) => Promise<unknown>;
  syncCurrentSessionAgent: (agentName: string, updatedAt: string) => void;
}) {
  return useEffectEvent((frame: SseFrame) => {
    const event = {
      id: frame.cursor ?? crypto.randomUUID(),
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

    startTransition(() => {
      input.setEvents((current) => [event, ...current].slice(0, 5000));
    });

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
      if (isRecord(value)) {
        return value;
      }

      if (value === undefined) {
        return undefined;
      }

      return {
        value
      };
    };

    const normalizeToolResultOutput = (value: unknown, failed: boolean, fallback?: string) => {
      if (isRecord(value) && typeof value.type === "string") {
        return value;
      }

      if (typeof value === "string") {
        return {
          type: failed ? "error-text" : "text",
          value
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
        value
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
        !input.liveMessagesByKey[liveMessageKey] &&
        !input.messages.some((message) => message.id === eventMessageId);
      input.setLiveMessagesByKey((current) => ({
        ...current,
        [liveMessageKey]: {
          persistedMessageId: eventMessageId,
          runId,
          sessionId: input.sessionId,
          role: "assistant",
          content:
            eventStructuredContent ??
            `${typeof current[liveMessageKey]?.content === "string" ? current[liveMessageKey].content : ""}${
              typeof event.data.delta === "string" ? event.data.delta : ""
            }`,
          ...(() => {
            const metadata = current[liveMessageKey]?.metadata ?? eventMetadata;
            return metadata ? { metadata } : {};
          })(),
          createdAt: current[liveMessageKey]?.createdAt ?? event.createdAt
        }
      }));
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
        void input.refreshSessionRuns(true);
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
      void input.refreshSidebarSessionRuns(true);
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
