import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ArrowDown } from "lucide-react";

import { WorkspaceFileManagerContainer } from "./WorkspaceFileManagerPanel";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationFeed } from "./ConversationFeed";
import { QueuedRunsPanel } from "./QueuedRunsPanel";
import { ConversationStatusBar, TerminalInteractionDialog } from "./ConversationStatusBar";
import {
  CONVERSATION_BOTTOM_THRESHOLD_PX,
  buildConversationTerminalStates,
  buildConversationTodoProgress,
  isTaskNotificationMessage,
  type RuntimeProps
} from "./conversation-model";

const CONVERSATION_HISTORY_LOAD_EDGE_PX = 720;

type ConversationScrollAnchor = {
  messageId?: string | undefined;
  top?: number | undefined;
  scrollHeight: number;
  scrollTop: number;
};

function summarizeAuxiliaryValue(value: unknown) {
  if (typeof value === "string") {
    return value.length <= 160 ? value : `${value.slice(0, 80)}…${value.slice(-80)}:${value.length}`;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `array:${value.length}`;
  }

  if (typeof value === "object") {
    let count = 0;
    for (const key in value as Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        count += 1;
        if (count > 160) {
          return "object:160+";
        }
      }
    }
    return `object:${count}`;
  }

  return typeof value;
}

function summarizeTodoValue(value: unknown) {
  if (!Array.isArray(value)) {
    return summarizeAuxiliaryValue(value);
  }

  return value
    .slice(0, 80)
    .map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return `${index}:${summarizeAuxiliaryValue(item)}`;
      }

      const record = item as { content?: unknown; activeForm?: unknown; status?: unknown };
      return [
        index,
        summarizeAuxiliaryValue(record.status),
        summarizeAuxiliaryValue(record.content),
        summarizeAuxiliaryValue(record.activeForm)
      ].join(":");
    })
    .join("|");
}

function buildConversationAuxiliaryStateKey(messages: RuntimeProps["messageFeed"]) {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolName === "TodoWrite") {
        const todos = typeof part.input === "object" && part.input !== null && !Array.isArray(part.input)
          ? (part.input as { todos?: unknown }).todos
          : undefined;
        parts.push(`${message.id}:${message.createdAt}:todo:${summarizeTodoValue(todos)}`);
        continue;
      }

      if (part.type !== "tool-call" && part.type !== "tool-result") {
        continue;
      }

      if (part.toolName !== "TerminalOutput" && part.toolName !== "TerminalInput") {
        continue;
      }

      const payload =
        part.type === "tool-call"
          ? part.input
          : typeof part.output === "object" && part.output !== null && "value" in part.output
            ? (part.output as { value?: unknown }).value
            : part.output;
      parts.push(`${message.id}:${message.createdAt}:${part.type}:${part.toolName}:${part.toolCallId}:${summarizeAuxiliaryValue(payload)}`);
    }
  }

  return parts.join("\n");
}

function ConversationWorkspaceImpl(props: RuntimeProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const conversationContentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const autoFollowPausedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const scrollTopValueRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const followAnimationFrameRef = useRef<number | undefined>(undefined);
  const touchYRef = useRef<number | undefined>(undefined);
  const prevMessageCountRef = useRef(0);
  const restoredRef = useRef(false);
  const showScrollToBottomButtonRef = useRef(false);
  const paginationAnchorRef = useRef<ConversationScrollAnchor | null>(null);
  const pendingOlderAutoLoadRef = useRef(false);
  const pendingNewerAutoLoadRef = useRef(false);
  const messageFeedRef = useRef(props.messageFeed);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false);
  const [terminalDialogOpen, setTerminalDialogOpen] = useState(false);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | undefined>(undefined);

  const sessionId = props.session?.id ?? "";
  messageFeedRef.current = props.messageFeed;
  const messageCount = props.messageFeed.length;
  const hasStreamingMessage = useMemo(() => props.messageFeed.some((message) => message.id.startsWith("live:")), [props.messageFeed]);
  const shouldPinActiveRun = props.isRunning || hasStreamingMessage;
  const isRunning = props.isRunning;
  const queuedSessionRuns = props.queuedSessionRuns;
  const auxiliaryStateKey = useMemo(() => buildConversationAuxiliaryStateKey(props.messageFeed), [props.messageFeed]);
  const todoProgress = useMemo(() => buildConversationTodoProgress(messageFeedRef.current), [auxiliaryStateKey, sessionId]);
  const terminalStates = useMemo(() => buildConversationTerminalStates(messageFeedRef.current), [auxiliaryStateKey, sessionId]);
  const handleOpenTerminal = useCallback((terminalId?: string) => {
    setSelectedTerminalId(terminalId);
    setTerminalDialogOpen(true);
  }, []);
  const updateScrollTopState = useCallback((nextScrollTop: number) => {
    const previousScrollTop = scrollTopValueRef.current;
    scrollTopValueRef.current = nextScrollTop;
    if (Math.abs(previousScrollTop - nextScrollTop) > 0.5) {
      setScrollTop(nextScrollTop);
    }
  }, []);
  const setScrollToBottomButtonVisible = useCallback((visible: boolean) => {
    if (showScrollToBottomButtonRef.current === visible) {
      return;
    }

    showScrollToBottomButtonRef.current = visible;
    setShowScrollToBottomButton(visible);
  }, []);
  const updateBottomAffordance = useCallback(
    (el: HTMLDivElement) => {
      const bottomDistance = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
      const isNearBottom = bottomDistance <= CONVERSATION_BOTTOM_THRESHOLD_PX;
      const isProgrammaticScroll = Date.now() < programmaticScrollUntilRef.current;
      setScrollToBottomButtonVisible(props.hasActiveSession && messageCount > 0 && !isNearBottom && !isProgrammaticScroll);
      return isNearBottom;
    },
    [messageCount, props.hasActiveSession, setScrollToBottomButtonVisible]
  );
  const cancelPendingFollowFrames = useCallback(() => {
    if (followAnimationFrameRef.current !== undefined) {
      window.cancelAnimationFrame(followAnimationFrameRef.current);
      followAnimationFrameRef.current = undefined;
    }
  }, []);
  const pauseAutoFollow = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + 900;
    programmaticScrollUntilRef.current = 0;
    isNearBottomRef.current = false;
    autoFollowPausedRef.current = true;
    props.shouldAutoFollowConversationRef.current = false;
    cancelPendingFollowFrames();
  }, [cancelPendingFollowFrames, props.shouldAutoFollowConversationRef]);
  const pinConversationToBottom = useCallback((frames = 2) => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    if (props.hasNewerMessages) {
      return;
    }
    if (autoFollowPausedRef.current || !props.shouldAutoFollowConversationRef.current) {
      return;
    }

    const nextScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const distance = Math.abs(el.scrollTop - nextScrollTop);
    programmaticScrollUntilRef.current = Date.now() + 650;
    props.shouldAutoFollowConversationRef.current = true;
    isNearBottomRef.current = true;
    if (distance > 0.5) {
      el.scrollTop = nextScrollTop;
    }
    lastScrollTopRef.current = el.scrollTop;
    updateScrollTopState(el.scrollTop);
    updateBottomAffordance(el);

    if (followAnimationFrameRef.current !== undefined) {
      cancelPendingFollowFrames();
    }

    if (frames > 0) {
      followAnimationFrameRef.current = window.requestAnimationFrame(() => {
        followAnimationFrameRef.current = undefined;
        if (!autoFollowPausedRef.current && props.shouldAutoFollowConversationRef.current) {
          pinConversationToBottom(frames - 1);
        }
      });
    }
  }, [cancelPendingFollowFrames, props.hasNewerMessages, props.shouldAutoFollowConversationRef, updateScrollTopState]);
  const noteUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + 700;
  }, []);
  const captureScrollAnchor = useCallback((el: HTMLDivElement): ConversationScrollAnchor => {
    const viewportRect = el.getBoundingClientRect();
    const anchorLine = viewportRect.top + Math.min(260, Math.max(48, el.clientHeight * 0.32));
    const messageElements = Array.from(el.querySelectorAll<HTMLElement>("[data-conversation-message-id]"));
    const anchorElement =
      messageElements.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom >= anchorLine && rect.top <= viewportRect.bottom - 24;
      }) ??
      messageElements.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom >= viewportRect.top + 24 && rect.top <= viewportRect.bottom - 24;
      });

    return {
      messageId: anchorElement?.dataset.conversationMessageId,
      top: anchorElement?.getBoundingClientRect().top,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop
    };
  }, []);
  const restoreScrollAnchor = useCallback(
    (anchor: ConversationScrollAnchor) => {
      const el = scrollContainerRef.current;
      if (!el) {
        return;
      }

      let restored = false;
      if (anchor.messageId && anchor.top !== undefined) {
        const messageElements = Array.from(el.querySelectorAll<HTMLElement>("[data-conversation-message-id]"));
        const anchorElement = messageElements.find((element) => element.dataset.conversationMessageId === anchor.messageId);
        if (anchorElement) {
          const delta = anchorElement.getBoundingClientRect().top - anchor.top;
          el.scrollTop += delta;
          restored = true;
        }
      }

      if (!restored) {
        const heightDelta = el.scrollHeight - anchor.scrollHeight;
        el.scrollTop = Math.max(0, anchor.scrollTop + heightDelta);
      }

      updateScrollTopState(el.scrollTop);
      updateBottomAffordance(el);
    },
    [updateBottomAffordance, updateScrollTopState]
  );
  const requestLoadOlderMessages = useCallback(() => {
    if (props.loadingOlderMessages || !props.hasMoreMessages || pendingOlderAutoLoadRef.current) {
      return;
    }

    pauseAutoFollow();
    const el = scrollContainerRef.current;
    if (el) {
      paginationAnchorRef.current = captureScrollAnchor(el);
    }
    pendingOlderAutoLoadRef.current = true;
    props.loadOlderMessages();
  }, [captureScrollAnchor, pauseAutoFollow, props.hasMoreMessages, props.loadOlderMessages, props.loadingOlderMessages]);
  const requestLoadNewerMessages = useCallback(() => {
    if (props.loadingNewerMessages || !props.hasNewerMessages || pendingNewerAutoLoadRef.current) {
      return;
    }

    const el = scrollContainerRef.current;
    if (el) {
      paginationAnchorRef.current = captureScrollAnchor(el);
    }
    pendingNewerAutoLoadRef.current = true;
    props.loadNewerMessages();
  }, [captureScrollAnchor, props.hasNewerMessages, props.loadNewerMessages, props.loadingNewerMessages]);

  // Reset restored flag when session changes
  useEffect(() => {
    restoredRef.current = false;
    autoFollowPausedRef.current = false;
    props.shouldAutoFollowConversationRef.current = true;
    lastScrollTopRef.current = 0;
    scrollTopValueRef.current = 0;
    setScrollToBottomButtonVisible(false);
    userScrollIntentUntilRef.current = 0;
    programmaticScrollUntilRef.current = 0;
    touchYRef.current = undefined;
    paginationAnchorRef.current = null;
    pendingOlderAutoLoadRef.current = false;
    pendingNewerAutoLoadRef.current = false;
    cancelPendingFollowFrames();
  }, [cancelPendingFollowFrames, props.shouldAutoFollowConversationRef, sessionId, setScrollToBottomButtonVisible]);

  // Initial session open should land on the latest visible message block before the feed is revealed.
  useLayoutEffect(() => {
    if (restoredRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    if (messageCount === 0) {
      return;
    }

    setViewportHeight(el.clientHeight);
    isNearBottomRef.current = true;
    autoFollowPausedRef.current = false;
    props.shouldAutoFollowConversationRef.current = true;
    restoredRef.current = true;
    prevMessageCountRef.current = messageCount;
    let cancelled = false;
    let frameId: number | undefined;
    let remainingFrames = 6;
    const settle = () => {
      if (cancelled) {
        return;
      }

      pinConversationToBottom(0);
      remainingFrames -= 1;
      if (remainingFrames <= 0) {
        return;
      }

      frameId = window.requestAnimationFrame(settle);
    };

    settle();
    return () => {
      cancelled = true;
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [messageCount, pinConversationToBottom, props.shouldAutoFollowConversationRef, sessionId]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nextScrollTop = el.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    const now = Date.now();
    const hasRecentUserScrollIntent = now < userScrollIntentUntilRef.current;
    const bottomDistance = el.scrollHeight - nextScrollTop - el.clientHeight;
    const isNearBottom = bottomDistance <= CONVERSATION_BOTTOM_THRESHOLD_PX;
    updateScrollTopState(el.scrollTop);
    setViewportHeight(el.clientHeight);
    const isProgrammaticScroll = now < programmaticScrollUntilRef.current;
    setScrollToBottomButtonVisible(props.hasActiveSession && messageCount > 0 && !isNearBottom && !isProgrammaticScroll);
    if (isNearBottom && !props.hasNewerMessages) {
      isNearBottomRef.current = true;
      autoFollowPausedRef.current = false;
      props.shouldAutoFollowConversationRef.current = true;
    } else if (props.hasNewerMessages) {
      isNearBottomRef.current = false;
      props.shouldAutoFollowConversationRef.current = false;
    } else if (hasRecentUserScrollIntent && nextScrollTop < previousScrollTop - 1) {
      pauseAutoFollow();
    } else if (!props.shouldAutoFollowConversationRef.current) {
      isNearBottomRef.current = false;
    }
    if (props.hasMoreMessages && nextScrollTop <= CONVERSATION_HISTORY_LOAD_EDGE_PX) {
      requestLoadOlderMessages();
    } else if (props.hasNewerMessages && bottomDistance <= CONVERSATION_HISTORY_LOAD_EDGE_PX) {
      requestLoadNewerMessages();
    }
    lastScrollTopRef.current = nextScrollTop;
  }, [
    messageCount,
    pauseAutoFollow,
    props.hasActiveSession,
    props.hasMoreMessages,
    props.hasNewerMessages,
    props.shouldAutoFollowConversationRef,
    requestLoadNewerMessages,
    requestLoadOlderMessages,
    setScrollToBottomButtonVisible,
    updateScrollTopState
  ]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!restoredRef.current) return;
    if (paginationAnchorRef.current) return;
    const isNewMessage = messageCount > prevMessageCountRef.current;
    prevMessageCountRef.current = messageCount;

    if (isNewMessage && messageCount > 0) {
      const lastMsg = props.messageFeed[messageCount - 1];
      if (lastMsg?.role === "user" && !isTaskNotificationMessage(lastMsg)) {
        isNearBottomRef.current = true;
        autoFollowPausedRef.current = false;
        props.shouldAutoFollowConversationRef.current = true;
      }
    }

    if (isNewMessage && isNearBottomRef.current && !autoFollowPausedRef.current) {
      pinConversationToBottom(3);
    }
  }, [messageCount, pinConversationToBottom, props.messageFeed, props.shouldAutoFollowConversationRef]);

  // Streaming auto-scroll: pin to bottom without smooth animation
  useLayoutEffect(() => {
    if (paginationAnchorRef.current || autoFollowPausedRef.current || !shouldPinActiveRun) {
      return;
    }

    if (isNearBottomRef.current || props.shouldAutoFollowConversationRef.current) {
      pinConversationToBottom(2);
    }
  }, [messageCount, pinConversationToBottom, props.messageFeed, props.shouldAutoFollowConversationRef, shouldPinActiveRun]);

  useEffect(() => {
    return () => {
      cancelPendingFollowFrames();
    };
  }, [cancelPendingFollowFrames]);

  useLayoutEffect(() => {
    if (props.loadingOlderMessages || props.loadingNewerMessages) {
      return;
    }

    const anchor = paginationAnchorRef.current;
    if (!anchor) {
      return;
    }

    restoreScrollAnchor(anchor);
    prevMessageCountRef.current = messageCount;
    paginationAnchorRef.current = null;
  }, [messageCount, props.loadingNewerMessages, props.loadingOlderMessages, restoreScrollAnchor]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    const contentEl = conversationContentRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }

    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
      updateBottomAffordance(el);
      if (
        restoredRef.current &&
        !paginationAnchorRef.current &&
        !autoFollowPausedRef.current &&
        !props.hasNewerMessages &&
        props.shouldAutoFollowConversationRef.current
      ) {
        pinConversationToBottom(1);
      }
    });
    observer.observe(el);
    if (contentEl) {
      observer.observe(contentEl);
    }
    return () => {
      observer.disconnect();
    };
  }, [pinConversationToBottom, props.hasNewerMessages, props.shouldAutoFollowConversationRef, updateBottomAffordance]);

  const handleScrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }

    cancelPendingFollowFrames();
    userScrollIntentUntilRef.current = 0;
    programmaticScrollUntilRef.current = Date.now() + 1_200;
    autoFollowPausedRef.current = false;
    isNearBottomRef.current = true;
    props.shouldAutoFollowConversationRef.current = true;
    setScrollToBottomButtonVisible(false);

    const nextScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({
      top: nextScrollTop,
      behavior: "smooth"
    });
    lastScrollTopRef.current = nextScrollTop;
    updateScrollTopState(nextScrollTop);
  }, [cancelPendingFollowFrames, props.shouldAutoFollowConversationRef, setScrollToBottomButtonVisible, updateScrollTopState]);

  const handleLoadOlderMessages = requestLoadOlderMessages;
  const handleLoadNewerMessages = requestLoadNewerMessages;

  useEffect(() => {
    if (!props.loadingOlderMessages) {
      pendingOlderAutoLoadRef.current = false;
    }
  }, [props.loadingOlderMessages]);

  useEffect(() => {
    if (!props.loadingNewerMessages) {
      pendingNewerAutoLoadRef.current = false;
    }
  }, [props.loadingNewerMessages]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !restoredRef.current || !props.hasActiveSession || messageCount === 0) {
      return;
    }

    const bottomDistance = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    if (
      props.hasMoreMessages &&
      !props.loadingOlderMessages &&
      !pendingOlderAutoLoadRef.current &&
      el.scrollTop <= CONVERSATION_HISTORY_LOAD_EDGE_PX
    ) {
      requestLoadOlderMessages();
      return;
    }

    if (
      props.hasNewerMessages &&
      !props.loadingNewerMessages &&
      !pendingNewerAutoLoadRef.current &&
      bottomDistance <= CONVERSATION_HISTORY_LOAD_EDGE_PX
    ) {
      requestLoadNewerMessages();
    }
  }, [
    messageCount,
    props.hasActiveSession,
    props.hasMoreMessages,
    props.hasNewerMessages,
    props.loadingNewerMessages,
    props.loadingOlderMessages,
    requestLoadNewerMessages,
    requestLoadOlderMessages,
    scrollTop,
    viewportHeight
  ]);

  const totalMessagesCount = Math.max(props.messagesTotalCount ?? 0, props.messageFeed.length);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ConversationStatusBar
        hasActiveSession={props.hasActiveSession}
        isRunning={isRunning}
        messagesCount={totalMessagesCount}
        storedMessagesCount={
          props.storedMessageCounts.system +
          props.storedMessageCounts.user +
          props.storedMessageCounts.assistant +
          props.storedMessageCounts.tool
        }
        todoProgress={todoProgress}
        terminalStates={terminalStates}
        onOpenTerminal={handleOpenTerminal}
        session={props.session}
        workspace={props.workspace}
        workspaceId={props.workspaceId}
        catalog={props.catalog}
        sessionRuns={props.sessionRuns}
        isSwitchingSessionAgent={props.isSwitchingSessionAgent}
        switchSessionAgent={props.switchSessionAgent}
        isSwitchingSessionModel={props.isSwitchingSessionModel}
        updateSessionModel={props.updateSessionModel}
      />

      {props.hasActiveSession ? (
        <TerminalInteractionDialog
          open={terminalDialogOpen}
          onOpenChange={setTerminalDialogOpen}
          sessionId={sessionId}
          terminalStates={terminalStates}
          initialTerminalId={selectedTerminalId}
          refreshSessionTerminal={props.refreshSessionTerminal}
          sendSessionTerminalInput={props.sendSessionTerminalInput}
        />
      ) : null}

      <div
        ref={(el) => {
          (scrollContainerRef as MutableRefObject<HTMLDivElement | null>).current = el;
          if (props.conversationThreadRef) {
            (props.conversationThreadRef as MutableRefObject<HTMLDivElement | null>).current = el;
          }
        }}
        className="flex-1 overflow-y-auto min-h-0"
        onScroll={handleScroll}
        onPointerDown={noteUserScrollIntent}
        onWheel={(event) => {
          if (event.deltaY < -1) {
            pauseAutoFollow();
          } else {
            noteUserScrollIntent();
          }
        }}
        onTouchStart={(event) => {
          touchYRef.current = event.touches[0]?.clientY;
          noteUserScrollIntent();
        }}
        onTouchMove={(event) => {
          const nextY = event.touches[0]?.clientY;
          const previousY = touchYRef.current;
          if (nextY !== undefined && previousY !== undefined && nextY > previousY + 1) {
            pauseAutoFollow();
          } else {
            noteUserScrollIntent();
          }
          touchYRef.current = nextY;
        }}
      >
        <div
          ref={conversationContentRef}
          className="mx-auto flex w-full max-w-4xl flex-col px-4 py-6 md:px-6 md:py-8"
        >
          <ConversationFeed
            hasActiveSession={props.hasActiveSession}
            sessionId={props.sessionId}
            currentSessionName={props.currentSessionName}
            currentWorkspaceName={props.currentWorkspaceName}
            messagesTotalCount={props.messagesTotalCount}
            messagesLoading={props.messagesLoading}
            messagesReady={props.messagesReady}
            messageFeed={props.messageFeed}
            conversationTailRef={props.conversationTailRef}
            catalog={props.catalog}
            session={props.session}
            sessionEvents={props.sessionEvents}
            refreshRunById={props.refreshRunById}
            refreshRunStepsById={props.refreshRunStepsById}
            openSessionById={props.openSessionById}
            answerAskUserQuestion={props.answerAskUserQuestion}
            hasMoreMessages={props.hasMoreMessages}
            hasNewerMessages={props.hasNewerMessages}
            loadingOlderMessages={props.loadingOlderMessages}
            loadingNewerMessages={props.loadingNewerMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
            onLoadNewerMessages={handleLoadNewerMessages}
            scrollTop={scrollTop}
            viewportHeight={viewportHeight}
            scrollViewportRef={scrollContainerRef}
          />
        </div>
      </div>

      {props.hasActiveSession ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
          <div className="p-4 md:p-6">
            <div className="max-w-4xl mx-auto">
              {showScrollToBottomButton ? (
                <div className="mb-3 flex justify-center">
                  <button
                    type="button"
                    className="pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/70 bg-background/92 text-foreground shadow-[0_18px_44px_-24px_rgba(15,23,42,0.9)] backdrop-blur transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="返回最新消息"
                    title="返回最新消息"
                    onClick={handleScrollToBottom}
                  >
                    <ArrowDown className="h-5 w-5" />
                  </button>
                </div>
              ) : null}
              <QueuedRunsPanel
                items={queuedSessionRuns}
                guideQueuedSessionInput={props.guideQueuedSessionInput}
                guideMessageSupported={props.guideMessageSupported}
              />
              <ConversationComposer
                refreshMessages={props.refreshMessages}
                sendMessage={props.sendMessage}
                cancelCurrentRun={props.cancelCurrentRun}
                isRunning={isRunning}
                isSwitchingSessionAgent={props.isSwitchingSessionAgent}
              />
            </div>
          </div>
        </div>
      ) : null}

      <WorkspaceFileManagerContainer fileManager={props.fileManager} />
    </div>
  );
}

export const ConversationWorkspace = memo(ConversationWorkspaceImpl);
