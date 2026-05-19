import { startTransition, useEffectEvent, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { Message, MessagePage } from "@oah/api-contracts";

import { mergeSessionMessages, type LiveConversationMessageRecord } from "./support";
import { buildMessagePagePath, mergeMessageCursor } from "./app-controller-utils";

type SessionIdRef = {
  current: string;
};

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
  const [messagesTotalCount, setMessagesTotalCount] = useState<number | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const messageRefreshSeqRef = useRef(0);
  const messageLoadingDelayTimerRef = useRef<number | undefined>(undefined);
  const olderMessagesSeqRef = useRef(0);

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
          input.setMessages((current) =>
            options?.reset ? messagePage.items : mergeSessionMessages(current, messagePage.items)
          );
          setMessagesNextCursor((current) =>
            options?.reset ? (messagePage.nextCursor ?? null) : mergeMessageCursor(current, messagePage.nextCursor)
          );
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
        });
        if (!quiet) {
          input.clearActiveError();
        }
      } catch (error) {
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
        input.setMessages((current) => mergeSessionMessages(current, messagePage.items));
        setMessagesNextCursor(messagePage.nextCursor ?? null);
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

  const resetMessagePaging = useEffectEvent(() => {
    window.clearTimeout(messageLoadingDelayTimerRef.current);
    setMessagesLoading(false);
    setMessagesNextCursor(null);
    setMessagesTotalCount(null);
    setLoadingOlderMessages(false);
    olderMessagesSeqRef.current = 0;
  });

  const mergeMessagePageCursor = useEffectEvent((incoming: string | undefined, totalCount?: number | undefined) => {
    setMessagesNextCursor((current) => mergeMessageCursor(current, incoming));
    if (typeof totalCount === "number" && Number.isFinite(totalCount)) {
      setMessagesTotalCount(totalCount);
    }
  });

  return {
    messagesNextCursor,
    messagesTotalCount,
    messagesLoading,
    loadingOlderMessages,
    setMessagesLoading,
    refreshMessages,
    loadOlderMessages,
    resetMessagePaging,
    mergeMessagePageCursor
  };
}
