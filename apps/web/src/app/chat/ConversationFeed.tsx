import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CircleCheck, Database, Folder, Loader2, MessageSquareText, Radio, SendHorizontal } from "lucide-react";

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
  | "sessionId"
  | "currentSessionName"
  | "currentWorkspaceName"
  | "messagesTotalCount"
  | "messagesLoading"
  | "messageFeed"
  | "conversationTailRef"
  | "hasNewerMessages"
  | "loadingNewerMessages"
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
  onLoadNewerMessages: () => void;
  scrollTop: number;
  viewportHeight: number;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
};

type ConversationVirtualMessageRowProps = ConversationMessageRowProps & {
  onHeightChange: (messageId: string, height: number) => void;
};

type LoadingStepProps = {
  icon: typeof Database;
  label: string;
  detail: string;
  active?: boolean;
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
        estimate +=
          part.type === "tool-call" &&
          typeof part.input === "object" &&
          part.input !== null &&
          !Array.isArray(part.input) &&
          typeof (part.input as { __streamingInput?: unknown }).__streamingInput === "string"
            ? 220
            : 140;
        break;
      case "tool-approval-request":
      case "tool-approval-response":
        estimate += 36;
        break;
    }
  }

  return Math.min(960, estimate);
}

function useLatestValueRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

const ConversationVirtualMessageRow = memo(function ConversationVirtualMessageRow(props: ConversationVirtualMessageRowProps) {
  const { message, agentName, agentMode, onInspectRun, onOpenSession, onAnswerAskUserQuestion, onHeightChange } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const messageIdRef = useLatestValueRef(message.id);
  const onHeightChangeRef = useLatestValueRef(onHeightChange);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let animationFrameId: number | undefined;
    const reportHeight = () => {
      if (animationFrameId !== undefined) {
        return;
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = undefined;
        onHeightChangeRef.current(messageIdRef.current, Math.ceil(element.getBoundingClientRect().height));
      });
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
      if (animationFrameId !== undefined) {
        window.cancelAnimationFrame(animationFrameId);
      }
      observer.disconnect();
    };
  }, [message.id, messageIdRef, onHeightChangeRef]);

  return (
    <div ref={containerRef} data-conversation-message-id={message.id}>
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

function LoadingStep(props: LoadingStepProps) {
  const Icon = props.icon;

  return (
    <div className="flex items-start gap-3">
      <div
        className={[
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
          props.active
            ? "border-primary/25 bg-primary/10 text-primary"
            : "border-border/70 bg-background/90 text-muted-foreground"
        ].join(" ")}
      >
        {props.active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{props.label}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.detail}</p>
      </div>
    </div>
  );
}

function SessionLoadingState(props: {
  sessionId: string;
  currentSessionName: string;
  currentWorkspaceName: string;
  messagesTotalCount?: number | undefined;
}) {
  const sessionLabel = props.currentSessionName === "No session" ? props.sessionId : props.currentSessionName;
  const messageCountLabel =
    typeof props.messagesTotalCount === "number" && props.messagesTotalCount > 0
      ? `已索引 ${props.messagesTotalCount.toLocaleString()} 条消息`
      : "正在读取最新消息块";

  return (
    <div className="flex min-h-[58vh] items-center justify-center py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">会话加载中</p>
            <h2 className="mt-1 truncate text-xl font-semibold text-foreground">正在打开 {sessionLabel}</h2>
            <p className="mt-2 truncate text-sm text-muted-foreground">{props.currentWorkspaceName}</p>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-4 rounded-md border border-border/70 bg-background/80 p-4 shadow-sm">
            <LoadingStep
              icon={Database}
              label="读取会话快照"
              detail="优先读取已经整理好的最新状态，不回放完整历史。"
            />
            <LoadingStep
              icon={MessageSquareText}
              label="恢复最新消息"
              detail={messageCountLabel}
              active
            />
            <LoadingStep
              icon={Radio}
              label="连接实时更新"
              detail="事件流会从最新游标开始，只接收后续变更。"
            />
          </div>

          <div className="rounded-md border border-border/70 bg-muted/25 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">最新对话预览</p>
                <p className="mt-1 text-xs text-muted-foreground">加载完成后会直接停在当前状态</p>
              </div>
              <CircleCheck className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-3">
              <div className="h-16 rounded-md border border-border/60 bg-background/80 p-3">
                <div className="h-2.5 w-24 rounded-full bg-muted-foreground/20" />
                <div className="mt-3 h-2.5 w-4/5 rounded-full bg-muted-foreground/15" />
                <div className="mt-2 h-2.5 w-3/5 rounded-full bg-muted-foreground/15" />
              </div>
              <div className="ml-auto h-14 w-4/5 rounded-md border border-border/60 bg-background/80 p-3">
                <div className="h-2.5 w-20 rounded-full bg-primary/20" />
                <div className="mt-3 h-2.5 w-3/4 rounded-full bg-muted-foreground/15" />
              </div>
              <div className="h-20 rounded-md border border-border/60 bg-background/80 p-3">
                <div className="h-2.5 w-28 rounded-full bg-muted-foreground/20" />
                <div className="mt-3 h-2.5 w-11/12 rounded-full bg-muted-foreground/15" />
                <div className="mt-2 h-2.5 w-2/3 rounded-full bg-muted-foreground/15" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionReadyEmptyState(props: {
  sessionId: string;
  currentSessionName: string;
  currentWorkspaceName: string;
}) {
  const sessionLabel = props.currentSessionName === "No session" ? props.sessionId : props.currentSessionName;

  return (
    <div className="flex min-h-[58vh] items-center justify-center py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 shadow-sm">
            <CircleCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">会话已就绪</p>
            <h2 className="mt-1 truncate text-xl font-semibold text-foreground">{sessionLabel}</h2>
            <p className="mt-2 truncate text-sm text-muted-foreground">{props.currentWorkspaceName}</p>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-4 rounded-md border border-border/70 bg-background/80 p-4 shadow-sm">
            <LoadingStep
              icon={CircleCheck}
              label="会话状态"
              detail="已读取最新快照，当前没有历史消息。"
            />
            <LoadingStep
              icon={Radio}
              label="实时更新"
              detail="事件流已按最新游标连接，后续变化会直接显示。"
            />
            <LoadingStep
              icon={SendHorizontal}
              label="下一步"
              detail="在底部输入框发送第一条消息。"
              active
            />
          </div>

          <div className="rounded-md border border-border/70 bg-muted/25 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">空会话</p>
                <p className="mt-1 text-xs text-muted-foreground">新消息会从这里开始形成时间线</p>
              </div>
              <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-3">
              <div className="h-16 rounded-md border border-dashed border-border/70 bg-background/60 p-3">
                <div className="h-2.5 w-24 rounded-full bg-muted-foreground/20" />
                <div className="mt-3 h-2.5 w-4/5 rounded-full bg-muted-foreground/12" />
                <div className="mt-2 h-2.5 w-3/5 rounded-full bg-muted-foreground/12" />
              </div>
              <div className="ml-auto h-14 w-4/5 rounded-md border border-dashed border-border/70 bg-background/60 p-3">
                <div className="h-2.5 w-20 rounded-full bg-primary/20" />
                <div className="mt-3 h-2.5 w-3/4 rounded-full bg-muted-foreground/12" />
              </div>
              <div className="flex h-16 items-center justify-center rounded-md border border-border/60 bg-background/80 text-xs text-muted-foreground">
                等待第一条消息
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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

  if (props.messagesLoading && props.messageFeed.length === 0) {
    return (
      <SessionLoadingState
        sessionId={props.sessionId}
        currentSessionName={props.currentSessionName}
        currentWorkspaceName={props.currentWorkspaceName}
        messagesTotalCount={props.messagesTotalCount}
      />
    );
  }

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

  if (props.messageFeed.length === 0) {
    return (
      <SessionReadyEmptyState
        sessionId={props.sessionId}
        currentSessionName={props.currentSessionName}
        currentWorkspaceName={props.currentWorkspaceName}
      />
    );
  }

  return (
    <>
      {props.hasMoreMessages || props.loadingOlderMessages ? (
        <div className="mb-5 flex justify-center" aria-live="polite">
          <div className="inline-flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/85 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
            {props.loadingOlderMessages ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {props.loadingOlderMessages ? "Loading earlier messages" : "Scroll up for earlier messages"}
          </div>
        </div>
      ) : null}
      <div ref={messageListRef}>
        {virtualRows.topSpacerHeight > 0 ? <div style={{ height: virtualRows.topSpacerHeight }} aria-hidden="true" /> : null}
        {virtualRows.items.map((message) => {
          const messageAgentInfo = messageAgentInfoById.get(message.id);
          if (!virtualizationEnabled) {
            return (
              <div key={message.id} data-conversation-message-id={message.id}>
                <ConversationMessageRow
                  message={message}
                  {...(messageAgentInfo?.name ? { agentName: messageAgentInfo.name } : {})}
                  {...(messageAgentInfo?.mode ? { agentMode: messageAgentInfo.mode } : {})}
                  onInspectRun={handleInspectRun}
                  onOpenSession={props.openSessionById}
                  onAnswerAskUserQuestion={props.answerAskUserQuestion}
                />
              </div>
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
      {props.hasNewerMessages || props.loadingNewerMessages ? (
        <div className="mt-5 flex justify-center" aria-live="polite">
          <div className="inline-flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/85 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
            {props.loadingNewerMessages ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {props.loadingNewerMessages ? "Loading newer messages" : "Scroll down for newer messages"}
          </div>
        </div>
      ) : null}
      {props.hasActiveSession ? <div className="h-36" aria-hidden="true" /> : null}
      <div ref={props.conversationTailRef} aria-hidden="true" />
    </>
  );
});
