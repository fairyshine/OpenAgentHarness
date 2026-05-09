import { startTransition, useEffectEvent, type Dispatch, type RefObject, type SetStateAction } from "react";

import type {
  CreateMessageRequest,
  GuideQueuedRunAccepted,
  Message,
  MessageAccepted,
  Run,
  RunStep,
  SessionQueuedRun
} from "@oah/api-contracts";

import { toErrorSummary, type LiveConversationMessageRecord } from "./support";
import { buildComposerMessageContent, summarizeComposerMessageContent } from "./chat/composer-content";
import { useStreamStore } from "./stores/stream-store";

type PendingOperationRef = RefObject<{ sessionId: string; promise: Promise<boolean> } | null>;
type AutoFollowRef = RefObject<boolean>;

export function useSessionSubmitActions(input: {
  sessionId: string;
  selectedRunId: string;
  sessionAgentSwitchRef: PendingOperationRef;
  sessionModelUpdateRef: PendingOperationRef;
  shouldAutoFollowConversationRef: AutoFollowRef;
  newEmptySessionIdRef: RefObject<string | null>;
  request: <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;
  refreshMessages: (quiet?: boolean, options?: { reset?: boolean | undefined }) => Promise<void>;
  refreshSessionRuns: (quiet?: boolean, options?: { includeSteps?: boolean }) => Promise<void>;
  refreshRun: (targetId?: string, quiet?: boolean) => Promise<void>;
  refreshRunSteps: (targetId?: string, quiet?: boolean) => Promise<void>;
  refreshSessionQueue: (quiet?: boolean) => Promise<void>;
  setActivity: (value: string) => void;
  clearActiveError: () => void;
  reportError: (error: unknown) => void;
  openConsoleForErrors: () => void;
  setSelectedRunId: Dispatch<SetStateAction<string>>;
  setLiveMessagesByKey: Dispatch<SetStateAction<Record<string, LiveConversationMessageRecord>>>;
  setSessionQueuedRuns: Dispatch<SetStateAction<SessionQueuedRun[]>>;
  setStreamRevision: Dispatch<SetStateAction<number>>;
}) {
  const submitSessionMessage = useEffectEvent(
    async (
      content: CreateMessageRequest["content"],
      options?: {
        clearDraft?: boolean;
        runningRunBehavior?: "queue" | "interrupt";
        activityLabel?: string;
      }
    ) => {
      if (!input.sessionId.trim()) {
        input.reportError("请先创建或加载 session。");
        return;
      }

      const contentPreview = summarizeComposerMessageContent(content).trim();
      if (!contentPreview) {
        return;
      }

      const pendingAgentSwitch = input.sessionAgentSwitchRef.current;
      if (pendingAgentSwitch?.sessionId === input.sessionId) {
        const switched = await pendingAgentSwitch.promise;
        if (!switched) {
          return;
        }
      }

      const pendingModelUpdate = input.sessionModelUpdateRef.current;
      if (pendingModelUpdate?.sessionId === input.sessionId) {
        const updated = await pendingModelUpdate.promise;
        if (!updated) {
          return;
        }
      }

      const runningRunBehavior = options?.runningRunBehavior ?? "queue";

      input.shouldAutoFollowConversationRef.current = true;
      if (input.newEmptySessionIdRef.current === input.sessionId) {
        input.newEmptySessionIdRef.current = null;
      }
      const accepted = await input.request<MessageAccepted>(`/api/v1/sessions/${input.sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          content,
          runningRunBehavior
        })
      });
      const shouldDisplayAsQueued = accepted.delivery === "session_queue";

      startTransition(() => {
        if (options?.clearDraft !== false) {
          useStreamStore.getState().setDraftMessage("");
          useStreamStore.getState().setDraftAttachments([]);
        }
        if (shouldDisplayAsQueued) {
          input.setSessionQueuedRuns((current) => {
            const nextCreatedAt = accepted.createdAt ?? new Date().toISOString();
            const nextPosition = accepted.queuedPosition ?? current.length + 1;
            const nextItem: SessionQueuedRun = {
              runId: accepted.runId,
              messageId: accepted.messageId,
              content: contentPreview,
              createdAt: nextCreatedAt,
              position: nextPosition
            };
            const deduped = current.filter((item) => item.runId !== accepted.runId);
            return [...deduped, nextItem].sort((left, right) => left.position - right.position);
          });
        }
        if (!shouldDisplayAsQueued) {
          input.setSelectedRunId(accepted.runId);
          if (accepted.run) {
            useStreamStore.getState().setSessionRuns((current) => {
              const next = [accepted.run as Run, ...current.filter((item) => item.id !== accepted.runId)];
              return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
            });
          }
          input.setLiveMessagesByKey((current) => ({
            ...current,
            [`pending-user:${accepted.messageId}`]: {
              persistedMessageId: accepted.messageId,
              runId: "",
              sessionId: input.sessionId,
              role: "user",
              content: content as Message["content"],
              createdAt: new Date().toISOString()
            }
          }));
        }
      });
      input.setStreamRevision((current) => current + 1);
      if (shouldDisplayAsQueued) {
        void input.refreshSessionQueue(true);
      }
      input.setActivity(
        options?.activityLabel ??
          (shouldDisplayAsQueued ? `消息已加入后续队列，run=${accepted.runId}` : `消息已入队，run=${accepted.runId}`)
      );
      input.clearActiveError();
    }
  );

  const sendMessage = useEffectEvent(async () => {
    if (!input.sessionId.trim()) {
      input.reportError("请先创建或加载 session。");
      return;
    }

    const { draftMessage, draftAttachments } = useStreamStore.getState();
    const content = buildComposerMessageContent(draftMessage, draftAttachments);
    if (!content) {
      return;
    }

    try {
      await submitSessionMessage(content, {
        clearDraft: true
      });
    } catch (error) {
      input.reportError(error);
      input.openConsoleForErrors();
    }
  });

  const guideMessage = useEffectEvent(async () => {
    if (!input.sessionId.trim()) {
      input.reportError("请先创建或加载 session。");
      return;
    }

    const { draftMessage, draftAttachments } = useStreamStore.getState();
    const content = buildComposerMessageContent(draftMessage, draftAttachments);
    if (!content) {
      return;
    }

    try {
      await submitSessionMessage(content, {
        clearDraft: true,
        runningRunBehavior: "interrupt",
        activityLabel: "已引导当前 run，正在切换到新的处理轮次"
      });
    } catch (error) {
      input.reportError(error);
      input.openConsoleForErrors();
    }
  });

  const answerAskUserQuestion = useEffectEvent(async (answer: string) => {
    if (!input.sessionId.trim()) {
      input.reportError("请先创建或加载 session。");
      return;
    }

    try {
      await submitSessionMessage(answer, {
        clearDraft: false,
        runningRunBehavior: "interrupt",
        activityLabel: "已发送问题答复，正在继续当前对话"
      });
    } catch (error) {
      input.reportError(error);
      input.openConsoleForErrors();
    }
  });

  const guideQueuedSessionInput = useEffectEvent(async (runId: string) => {
    if (!input.sessionId.trim() || !runId.trim()) {
      input.reportError("请先创建或加载 session。");
      return;
    }

    try {
      await input.request<GuideQueuedRunAccepted>(`/api/v1/runs/${runId}/guide`, {
        method: "POST"
      });
      await input.refreshSessionRuns(true, { includeSteps: true });
      input.setActivity("已引导排队消息，正在切换到新的处理轮次");
      input.clearActiveError();
    } catch (error) {
      const summary = toErrorSummary(error);
      if (summary?.code === "queued_run_not_found") {
        await Promise.all([input.refreshSessionQueue(true), input.refreshSessionRuns(true, { includeSteps: true })]);
        input.setActivity("该排队消息已离开队列，已刷新当前状态");
        input.clearActiveError();
        return;
      }
      input.reportError(error);
      input.openConsoleForErrors();
    }
  });

  const cancelCurrentRun = useEffectEvent(async () => {
    if (!input.selectedRunId.trim()) {
      return;
    }

    try {
      await input.request(`/api/v1/runs/${input.selectedRunId}/cancel`, {
        method: "POST"
      });
      await input.refreshRun(input.selectedRunId, true);
      input.setActivity(`已请求取消 run ${input.selectedRunId}`);
      input.clearActiveError();
    } catch (error) {
      input.reportError(error);
      input.openConsoleForErrors();
    }
  });

  return {
    sendMessage,
    guideMessage,
    answerAskUserQuestion,
    guideQueuedSessionInput,
    cancelCurrentRun
  };
}
