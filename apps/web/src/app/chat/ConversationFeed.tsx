import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Bot, Folder, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Message } from "@oah/api-contracts";

import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { buildMessageAgentInfoIndex } from "./message-agent-info";
import { CONVERSATION_OVERSCAN_PX, CONVERSATION_VIRTUALIZATION_THRESHOLD, isTaskNotificationMessage, readRuntimeKind, type RuntimeProps } from "./conversation-model";
import { estimateMarkdownBlockHeight } from "./conversation-markdown";
import { ConversationMessageRow, type ConversationMessageRowProps } from "./ConversationMessage";

type ConversationFeedProps = Pick<
  RuntimeProps,
  | "hasActiveSession"
  | "currentWorkspaceName"
  | "messagesLoading"
  | "messageFeed"
  | "conversationTailRef"
  | "catalog"
  | "session"
  | "sessionEvents"
  | "refreshRunById"
  | "refreshRunStepsById"
  | "openSessionById"
  | "answerAskUserQuestion"
> & {
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => void;
  scrollTop: number;
  viewportHeight: number;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
};

type ConversationVirtualMessageRowProps = ConversationMessageRowProps & {
  onHeightChange: (messageId: string, height: number) => void;
};

function estimateConversationMessageHeight(message: Message) {
  const runtimeKind = readRuntimeKind(message.metadata);
  if (runtimeKind === "compact_boundary") {
    return 160;
  }
  if (runtimeKind === "compact_summary") {
    return 260;
  }

  if (typeof message.content === "string") {
    return Math.min(720, Math.max(120, estimateMarkdownBlockHeight(message.content)));
  }

  let estimate = 120;
  for (const part of message.content) {
    switch (part.type) {
      case "text":
      case "reasoning":
        estimate += Math.min(320, Math.max(40, Math.ceil((part.text?.length ?? 0) / 10)));
        break;
      case "image":
        estimate += 220;
        break;
      case "tool-call":
      case "tool-result":
        estimate += 140;
        break;
      case "tool-approval-request":
      case "tool-approval-response":
        estimate += 36;
        break;
    }
  }

  return Math.min(960, estimate);
}

const ConversationVirtualMessageRow = memo(function ConversationVirtualMessageRow(props: ConversationVirtualMessageRowProps) {
  const { message, agentName, agentMode, onInspectRun, onOpenSession, onAnswerAskUserQuestion, onHeightChange } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const reportHeight = () => {
      onHeightChange(message.id, Math.ceil(element.getBoundingClientRect().height));
    };

    reportHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      reportHeight();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [agentMode, agentName, message, onHeightChange]);

  return (
    <div ref={containerRef}>
      <ConversationMessageRow
        message={message}
        {...(agentName ? { agentName } : {})}
        {...(agentMode ? { agentMode } : {})}
        onInspectRun={onInspectRun}
        {...(onOpenSession ? { onOpenSession } : {})}
        {...(onAnswerAskUserQuestion ? { onAnswerAskUserQuestion } : {})}
      />
    </div>
  );
});

export const ConversationFeed = memo(function ConversationFeed(props: ConversationFeedProps) {
  const run = useStreamStore((state) => state.run);
  const runSteps = useStreamStore((state) => state.runSteps);
  const setSelectedRunId = useStreamStore((state) => state.setSelectedRunId);
  const setMainViewMode = useUiStore((state) => state.setMainViewMode);
  const setInspectorTab = useUiStore((state) => state.setInspectorTab);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const rowHeightsRef = useRef(new Map<string, number>());
  const [rowHeightVersion, setRowHeightVersion] = useState(0);
  const [listTopWithinScroll, setListTopWithinScroll] = useState(0);
  const virtualizationEnabled = props.messageFeed.length >= CONVERSATION_VIRTUALIZATION_THRESHOLD;
  const handleInspectRun = useCallback(
    (runId: string) => {
      if (!runId) {
        return;
      }

      setSelectedRunId(runId);
      setMainViewMode("inspector");
      setInspectorTab("timeline");
      props.refreshRunById(runId);
      props.refreshRunStepsById(runId);
    },
    [props.refreshRunById, props.refreshRunStepsById, setInspectorTab, setMainViewMode, setSelectedRunId]
  );
  const updateListTopWithinScroll = useCallback(() => {
    const scrollViewport = props.scrollViewportRef.current;
    const listElement = messageListRef.current;
    if (!scrollViewport || !listElement) {
      return;
    }

    const nextTop = listElement.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top + scrollViewport.scrollTop;
    setListTopWithinScroll((current) => (Math.abs(current - nextTop) < 1 ? current : nextTop));
  }, [props.scrollViewportRef]);
  const handleMessageRowHeightChange = useCallback((messageId: string, height: number) => {
    const normalizedHeight = Math.max(72, height);
    if (rowHeightsRef.current.get(messageId) === normalizedHeight) {
      return;
    }

    rowHeightsRef.current.set(messageId, normalizedHeight);
    setRowHeightVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    updateListTopWithinScroll();
  }, [updateListTopWithinScroll, props.hasMoreMessages, props.loadingOlderMessages, props.messageFeed.length]);

  useEffect(() => {
    const scrollViewport = props.scrollViewportRef.current;
    const listElement = messageListRef.current;
    if (!scrollViewport || !listElement || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateListTopWithinScroll();
    });
    observer.observe(scrollViewport);
    observer.observe(listElement);
    return () => {
      observer.disconnect();
    };
  }, [props.scrollViewportRef, updateListTopWithinScroll]);

  const virtualRows = useMemo(() => {
    if (!virtualizationEnabled) {
      return {
        items: props.messageFeed,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0
      };
    }

    const visibleTop = Math.max(0, props.scrollTop - listTopWithinScroll - CONVERSATION_OVERSCAN_PX);
    const visibleBottom = Math.max(0, props.scrollTop - listTopWithinScroll + props.viewportHeight + CONVERSATION_OVERSCAN_PX);
    let topSpacerHeight = 0;
    let totalHeight = 0;
    let renderStartIndex = 0;
    let renderEndIndex = props.messageFeed.length;
    let foundStart = false;
    let foundEnd = false;

    for (let index = 0; index < props.messageFeed.length; index += 1) {
      const message = props.messageFeed[index];
      if (!message) {
        continue;
      }

      const estimatedHeight = rowHeightsRef.current.get(message.id) ?? estimateConversationMessageHeight(message);
      const itemTop = totalHeight;
      const itemBottom = itemTop + estimatedHeight;

      if (!foundStart && itemBottom >= visibleTop) {
        renderStartIndex = index;
        topSpacerHeight = itemTop;
        foundStart = true;
      }

      if (!foundEnd && itemTop > visibleBottom) {
        renderEndIndex = index;
        foundEnd = true;
      }

      totalHeight = itemBottom;
    }

    const items = props.messageFeed.slice(renderStartIndex, renderEndIndex);
    const renderedHeight = items.reduce(
      (sum, message) => sum + (rowHeightsRef.current.get(message.id) ?? estimateConversationMessageHeight(message)),
      0
    );

    return {
      items,
      topSpacerHeight,
      bottomSpacerHeight: Math.max(0, totalHeight - topSpacerHeight - renderedHeight)
    };
  }, [listTopWithinScroll, props.messageFeed, props.scrollTop, props.viewportHeight, rowHeightVersion, virtualizationEnabled]);
  const messagesForAgentInfo = virtualizationEnabled ? virtualRows.items : props.messageFeed;
  const messageAgentInfoById = useMemo(
    () =>
      buildMessageAgentInfoIndex({
        messages: messagesForAgentInfo,
        catalog: props.catalog,
        runSteps,
        run,
        session: props.session,
        sessionEvents: props.sessionEvents
      }),
    [messagesForAgentInfo, props.catalog, props.session, props.sessionEvents, run, runSteps]
  );

  if (!props.hasActiveSession) {
    return (
      <div className="flex min-h-[52vh] items-center justify-center py-10">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/85 text-muted-foreground shadow-sm">
            <Folder className="h-5 w-5" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">No Session Selected</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">Choose a session from the sidebar, or create one in {props.currentWorkspaceName}.</p>
        </div>
      </div>
    );
  }

  if (props.messagesLoading && props.messageFeed.length === 0) {
    return (
      <div className="flex min-h-[52vh] items-center justify-center py-10">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/85 text-muted-foreground shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Loading Conversation</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">Fetching the latest message block for this session.</p>
        </div>
      </div>
    );
  }

  if (props.messageFeed.length === 0) {
    return (
      <div className="flex min-h-[52vh] items-center justify-center py-10">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background shadow-lg">
            <Bot className="h-5 w-5" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">OpenAgentHarness</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">Send a message to start this session. Tool calls, traces, and engine output will appear as the conversation unfolds.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {props.hasMoreMessages || props.loadingOlderMessages ? (
        <div className="mb-5 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={props.onLoadOlderMessages}
            disabled={props.loadingOlderMessages}
            className="rounded-full bg-background/85 px-4 shadow-sm backdrop-blur-sm"
          >
            {props.loadingOlderMessages ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            {props.loadingOlderMessages ? "Loading earlier messages" : "Load earlier messages"}
          </Button>
        </div>
      ) : null}
      <div ref={messageListRef}>
        {virtualRows.topSpacerHeight > 0 ? <div style={{ height: virtualRows.topSpacerHeight }} aria-hidden="true" /> : null}
        {virtualRows.items.map((message) => {
          const messageAgentInfo = messageAgentInfoById.get(message.id);
          if (!virtualizationEnabled) {
            return (
              <ConversationMessageRow
                key={message.id}
                message={message}
                {...(messageAgentInfo?.name ? { agentName: messageAgentInfo.name } : {})}
                {...(messageAgentInfo?.mode ? { agentMode: messageAgentInfo.mode } : {})}
                onInspectRun={handleInspectRun}
                onOpenSession={props.openSessionById}
                onAnswerAskUserQuestion={props.answerAskUserQuestion}
              />
            );
          }

          return (
            <ConversationVirtualMessageRow
              key={message.id}
              message={message}
              {...(messageAgentInfo?.name ? { agentName: messageAgentInfo.name } : {})}
              {...(messageAgentInfo?.mode ? { agentMode: messageAgentInfo.mode } : {})}
              onInspectRun={handleInspectRun}
              onOpenSession={props.openSessionById}
              onAnswerAskUserQuestion={props.answerAskUserQuestion}
              onHeightChange={handleMessageRowHeightChange}
            />
          );
        })}
        {virtualRows.bottomSpacerHeight > 0 ? <div style={{ height: virtualRows.bottomSpacerHeight }} aria-hidden="true" /> : null}
      </div>
      {props.hasActiveSession ? <div className="h-36" aria-hidden="true" /> : null}
      <div ref={props.conversationTailRef} aria-hidden="true" />
    </>
  );
});

