import { startTransition, useEffectEvent, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { Message, MessagePage } from "@oah/api-contracts";

import { mergeSessionMessages, type LiveConversationMessageRecord } from "./support";
import { buildMessagePagePath, mergeMessageCursor } from "./app-controller-utils";

const MESSAGE_WINDOW_MAX = 168;
const MESSAGE_WINDOW_TARGET = 120;

type SessionIdRef = {
  current: string;
};

function encodeMessageBoundaryCursor(message: Pick<Message, "createdAt" | "id">): string {
  const payload = JSON.stringify({
    createdAt: message.createdAt,
    id: message.id
  });
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function firstMessageCursor(messages: Message[]): string | null {
  const message = messages[0];
  return message ? encodeMessageBoundaryCursor(message) : null;
}

function lastMessageCursor(messages: Message[]): string | null {
  const message = messages.at(-1);
  return message ? encodeMessageBoundaryCursor(message) : null;
}

function trimMessageWindow(
  messages: Message[],
  edge: "older" | "newer" | "latest"
): {
  items: Message[];
  olderCursor?: string | null | undefined;
  newerCursor?: string | null | undefined;
} {
  if (messages.length <= MESSAGE_WINDOW_MAX) {
    return { items: messages };
  }

  if (edge === "older") {
    const items = messages.slice(0, MESSAGE_WINDOW_TARGET);
    return {
      items,
      newerCursor: lastMessageCursor(items)
    };
  }

  const items = messages.slice(-MESSAGE_WINDOW_TARGET);
  return {
    items,
    olderCursor: firstMessageCursor(items)
  };
}

export function useSessionMessages(input: {
  sessionId: string;
  activeSessionIdRef: SessionIdRef;
  request: <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setLiveMessagesByKey: Dispatch<SetStateAction<Record<string, LiveConversationMessageRecord>>>;
  clearActiveError: () => void;
  reportError: (error: unknown) => void;
}) {
  const [messagesNextCursor, setMessagesNextCursor] = useState<string | null>(null);
  const [newerMessagesCursor, setNewerMessagesCursor] = useState<string | null>(null);
  const [messagesTotalCount, setMessagesTotalCount] = useState<number | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesReadySessionId, setMessagesReadySessionId] = useState<string | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [loadingNewerMessages, setLoadingNewerMessages] = useState(false);
  const messageRefreshSeqRef = useRef(0);
  const messageLoadingDelayTimerRef = useRef<number | undefined>(undefined);
  const olderMessagesSeqRef = useRef(0);
  const newerMessagesSeqRef = useRef(0);

  const refreshMessages = useEffectEvent(
    async (
      quiet = false,
      options?: {
        pageSize?: number | undefined;
        reset?: boolean | undefined;
      }
    ) => {
      const targetSessionId = input.sessionId.trim();
      if (!targetSessionId) {
        startTransition(() => {
          input.setMessages([]);
          setMessagesNextCursor(null);
          setMessagesTotalCount(null);
          setMessagesReadySessionId(null);
        });
        return;
      }

      const refreshSeq = messageRefreshSeqRef.current + 1;
      messageRefreshSeqRef.current = refreshSeq;
      window.clearTimeout(messageLoadingDelayTimerRef.current);
      messageLoadingDelayTimerRef.current = window.setTimeout(() => {
        if (messageRefreshSeqRef.current === refreshSeq) {
          setMessagesLoading(true);
        }
      }, 120);

      try {
        const messagePage = await input.request<MessagePage>(
          buildMessagePagePath(targetSessionId, { pageSize: options?.pageSize })
        );
        if (input.activeSessionIdRef.current !== targetSessionId || messageRefreshSeqRef.current !== refreshSeq) {
          return;
        }

        startTransition(() => {
          input.setMessages((current) => {
            const merged = options?.reset ? messagePage.items : mergeSessionMessages(current, messagePage.items);
            const windowed = trimMessageWindow(merged, "latest");
            setMessagesNextCursor((currentCursor) =>
              windowed.olderCursor !== undefined
                ? windowed.olderCursor
                : options?.reset
                  ? (messagePage.nextCursor ?? null)
                  : mergeMessageCursor(currentCursor, messagePage.nextCursor)
            );
            setNewerMessagesCursor(windowed.newerCursor ?? null);
            return windowed.items;
          });
          setMessagesTotalCount((current) =>
            typeof messagePage.totalCount === "number" && Number.isFinite(messagePage.totalCount)
              ? messagePage.totalCount
              : options?.reset
                ? messagePage.items.length
                : current
          );
          input.setLiveMessagesByKey((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([, entry]) => {
                if (entry.role !== "user" || !entry.persistedMessageId) {
                  return true;
                }

                return !messagePage.items.some((message) => message.id === entry.persistedMessageId);
              })
            )
          );
          setMessagesReadySessionId(targetSessionId);
        });
        if (!quiet) {
          input.clearActiveError();
        }
      } catch (error) {
        if (input.activeSessionIdRef.current === targetSessionId && messageRefreshSeqRef.current === refreshSeq) {
          setMessagesReadySessionId(targetSessionId);
        }
        if (!quiet) {
          input.reportError(error);
        }
      } finally {
        if (messageRefreshSeqRef.current === refreshSeq) {
          window.clearTimeout(messageLoadingDelayTimerRef.current);
          setMessagesLoading(false);
        }
      }
    }
  );

  const loadOlderMessages = useEffectEvent(async () => {
    const targetSessionId = input.sessionId.trim();
    const cursor = messagesNextCursor?.trim();
    if (!targetSessionId || !cursor || loadingOlderMessages) {
      return;
    }

    const olderSeq = olderMessagesSeqRef.current + 1;
    olderMessagesSeqRef.current = olderSeq;
    setLoadingOlderMessages(true);

    try {
      const messagePage = await input.request<MessagePage>(buildMessagePagePath(targetSessionId, { cursor }));
      if (input.activeSessionIdRef.current !== targetSessionId || olderMessagesSeqRef.current !== olderSeq) {
        return;
      }

      startTransition(() => {
        input.setMessages((current) => {
          const windowed = trimMessageWindow(mergeSessionMessages(current, messagePage.items), "older");
          setMessagesNextCursor(windowed.olderCursor !== undefined ? windowed.olderCursor : (messagePage.nextCursor ?? null));
          if (windowed.newerCursor !== undefined) {
            setNewerMessagesCursor(windowed.newerCursor);
          }
          return windowed.items;
        });
        if (typeof messagePage.totalCount === "number" && Number.isFinite(messagePage.totalCount)) {
          setMessagesTotalCount(messagePage.totalCount);
        }
      });
      input.clearActiveError();
    } catch (error) {
      input.reportError(error);
    } finally {
      if (olderMessagesSeqRef.current === olderSeq) {
        setLoadingOlderMessages(false);
      }
    }
  });

  const loadNewerMessages = useEffectEvent(async () => {
    const targetSessionId = input.sessionId.trim();
    const cursor = newerMessagesCursor?.trim();
    if (!targetSessionId || !cursor || loadingNewerMessages) {
      return;
    }

    const newerSeq = newerMessagesSeqRef.current + 1;
    newerMessagesSeqRef.current = newerSeq;
    setLoadingNewerMessages(true);

    try {
      const messagePage = await input.request<MessagePage>(
        buildMessagePagePath(targetSessionId, {
          cursor,
          direction: "forward"
        })
      );
      if (input.activeSessionIdRef.current !== targetSessionId || newerMessagesSeqRef.current !== newerSeq) {
        return;
      }

      startTransition(() => {
        input.setMessages((current) => {
          const windowed = trimMessageWindow(mergeSessionMessages(current, messagePage.items), "newer");
          if (windowed.olderCursor !== undefined) {
            setMessagesNextCursor(windowed.olderCursor);
          }
          setNewerMessagesCursor(windowed.newerCursor !== undefined ? windowed.newerCursor : (messagePage.nextCursor ?? null));
          return windowed.items;
        });
        if (typeof messagePage.totalCount === "number" && Number.isFinite(messagePage.totalCount)) {
          setMessagesTotalCount(messagePage.totalCount);
        }
      });
      input.clearActiveError();
    } catch (error) {
      input.reportError(error);
    } finally {
      if (newerMessagesSeqRef.current === newerSeq) {
        setLoadingNewerMessages(false);
      }
    }
  });

  const resetMessagePaging = useEffectEvent(() => {
    window.clearTimeout(messageLoadingDelayTimerRef.current);
    setMessagesLoading(false);
    setMessagesNextCursor(null);
    setNewerMessagesCursor(null);
    setMessagesTotalCount(null);
    setMessagesReadySessionId(null);
    setLoadingOlderMessages(false);
    setLoadingNewerMessages(false);
    olderMessagesSeqRef.current = 0;
    newerMessagesSeqRef.current = 0;
  });

  const markMessagesReady = useEffectEvent((targetSessionId?: string | undefined) => {
    const normalizedSessionId = (targetSessionId ?? input.sessionId).trim();
    setMessagesReadySessionId(normalizedSessionId || null);
  });

  const mergeMessagePageCursor = useEffectEvent((incoming: string | undefined, totalCount?: number | undefined) => {
    setMessagesNextCursor((current) => mergeMessageCursor(current, incoming));
    if (typeof totalCount === "number" && Number.isFinite(totalCount)) {
      setMessagesTotalCount(totalCount);
    }
  });

  return {
    messagesNextCursor,
    newerMessagesCursor,
    messagesTotalCount,
    messagesLoading,
    messagesReady: input.sessionId.trim() ? messagesReadySessionId === input.sessionId.trim() : true,
    loadingOlderMessages,
    loadingNewerMessages,
    setMessagesLoading,
    markMessagesReady,
    refreshMessages,
    loadOlderMessages,
    loadNewerMessages,
    resetMessagePaging,
    mergeMessagePageCursor
  };
}
