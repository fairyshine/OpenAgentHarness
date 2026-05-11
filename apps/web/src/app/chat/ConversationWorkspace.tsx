import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import { WorkspaceFileManagerPanel } from "./WorkspaceFileManagerPanel";
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

/** Persist scroll positions per session across component re-mounts */
const scrollPositions = new Map<string, number>();

function ConversationWorkspaceImpl(props: RuntimeProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const autoFollowPausedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const prevMessageCountRef = useRef(0);
  const restoredRef = useRef(false);
  const prependSnapshotRef = useRef<{ messageCount: number; scrollHeight: number; scrollTop: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [terminalDialogOpen, setTerminalDialogOpen] = useState(false);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | undefined>(undefined);

  const sessionId = props.session?.id ?? "";
  const messageCount = props.messageFeed.length;
  const hasStreamingMessage = useMemo(() => props.messageFeed.some((message) => message.id.startsWith("live:")), [props.messageFeed]);
  const isRunning = props.isRunning;
  const queuedSessionRuns = props.queuedSessionRuns;
  const todoProgress = useMemo(() => buildConversationTodoProgress(props.messageFeed), [props.messageFeed]);
  const terminalStates = useMemo(() => buildConversationTerminalStates(props.messageFeed), [props.messageFeed]);
  const handleOpenTerminal = useCallback((terminalId?: string) => {
    setSelectedTerminalId(terminalId);
    setTerminalDialogOpen(true);
  }, []);

  // Reset restored flag when session changes
  useEffect(() => {
    restoredRef.current = false;
    autoFollowPausedRef.current = false;
    lastScrollTopRef.current = 0;
    programmaticScrollUntilRef.current = 0;
  }, [sessionId]);

  // Restore saved scroll position once messages are loaded
  useEffect(() => {
    if (restoredRef.current) return;
    const el = scrollContainerRef.current;
    if (!el || messageCount === 0) return;

    setViewportHeight(el.clientHeight);
    const saved = scrollPositions.get(sessionId);
    if (saved != null) {
      requestAnimationFrame(() => {
        el.scrollTop = saved;
        setScrollTop(saved);
        lastScrollTopRef.current = el.scrollTop;
        isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= CONVERSATION_BOTTOM_THRESHOLD_PX;
        autoFollowPausedRef.current = !isNearBottomRef.current;
      });
    }
    restoredRef.current = true;
    prevMessageCountRef.current = messageCount;
  }, [sessionId, messageCount]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nextScrollTop = el.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    const isProgrammaticScroll = Date.now() < programmaticScrollUntilRef.current;
    const bottomDistance = el.scrollHeight - nextScrollTop - el.clientHeight;
    const isNearBottom = bottomDistance <= CONVERSATION_BOTTOM_THRESHOLD_PX;
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);
    isNearBottomRef.current = isNearBottom;
    if (isNearBottom) {
      autoFollowPausedRef.current = false;
    } else if (!isProgrammaticScroll && nextScrollTop < previousScrollTop - 1) {
      autoFollowPausedRef.current = true;
    }
    lastScrollTopRef.current = nextScrollTop;
    if (sessionId) {
      scrollPositions.set(sessionId, el.scrollTop);
    }
  }, [sessionId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!restoredRef.current) return;
    if (prependSnapshotRef.current) return;
    const isNewMessage = messageCount > prevMessageCountRef.current;
    prevMessageCountRef.current = messageCount;

    if (isNewMessage && messageCount > 0) {
      const lastMsg = props.messageFeed[messageCount - 1];
      if (lastMsg?.role === "user" && !isTaskNotificationMessage(lastMsg)) {
        isNearBottomRef.current = true;
        autoFollowPausedRef.current = false;
      }
    }

    if (isNewMessage && isNearBottomRef.current && !autoFollowPausedRef.current) {
      programmaticScrollUntilRef.current = Date.now() + 500;
      props.conversationTailRef?.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageCount, props.messageFeed, props.conversationTailRef]);

  // Streaming auto-scroll: pin to bottom without smooth animation
  useEffect(() => {
    if (!isNearBottomRef.current || autoFollowPausedRef.current || !hasStreamingMessage) return;
    const el = scrollContainerRef.current;
    if (el) {
      programmaticScrollUntilRef.current = Date.now() + 100;
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
      lastScrollTopRef.current = el.scrollTop;
    }
  });

  useEffect(() => {
    if (props.loadingOlderMessages) {
      return;
    }

    const snapshot = prependSnapshotRef.current;
    const el = scrollContainerRef.current;
    if (!snapshot || !el) {
      return;
    }

    const heightDelta = el.scrollHeight - snapshot.scrollHeight;
    el.scrollTop = snapshot.scrollTop + Math.max(0, heightDelta);
    setScrollTop(el.scrollTop);
    prevMessageCountRef.current = messageCount;
    prependSnapshotRef.current = null;
  }, [messageCount, props.loadingOlderMessages]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }

    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  const handleLoadOlderMessages = () => {
    const el = scrollContainerRef.current;
    if (el) {
      prependSnapshotRef.current = {
        messageCount,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop
      };
    }
    props.loadOlderMessages();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ConversationStatusBar
        hasActiveSession={props.hasActiveSession}
        isRunning={isRunning}
        messagesCount={props.messageFeed.length}
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
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-6 md:px-6 md:py-8">
          <ConversationFeed
            hasActiveSession={props.hasActiveSession}
            currentWorkspaceName={props.currentWorkspaceName}
            messagesLoading={props.messagesLoading}
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
            loadingOlderMessages={props.loadingOlderMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
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

      <WorkspaceFileManagerPanel fileManager={props.fileManager} />
    </div>
  );
}

export const ConversationWorkspace = memo(ConversationWorkspaceImpl);
