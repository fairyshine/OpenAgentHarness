import { startTransition, useEffect, useRef, type MutableRefObject } from "react";

import type { Message, MessagePage, Run, RunStep } from "@oah/api-contracts";

import {
  hasDisplayableRunMessages,
  isTerminalRunStatus,
  mergeSessionMessages,
  type ConnectionSettings,
  type LiveConversationMessageRecord
} from "./support";
import { buildLiveMessagePagePath, mergeRunStepsForRun } from "./app-controller-utils";

const COMPLETED_RUN_RESULT_POLL_LIMIT = 5;
const RUN_STEP_PAGE_SIZE = 100;
const STREAM_CONNECTED_POLL_INTERVAL_MS = 5_000;
const STREAM_DISCONNECTED_POLL_INTERVAL_MS = 1_200;

function useSelectedRunPolling(params: {
  connection: ConnectionSettings;
  sessionId: string;
  selectedRunIdValue: string;
  run: Run | null;
  streamState: "idle" | "connecting" | "listening" | "open" | "error";
  request: <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;
  runPollingTimerRef: MutableRefObject<number | undefined>;
  mergeMessagePageCursor: (cursor: string | undefined) => void;
  reportError: (error: unknown) => void;
  setRun: (value: Run | null | ((current: Run | null) => Run | null)) => void;
  setSessionRuns: (value: Run[] | ((current: Run[]) => Run[])) => void;
  setRunSteps: (value: RunStep[] | ((current: RunStep[]) => RunStep[])) => void;
  setMessages: (value: Message[] | ((current: Message[]) => Message[])) => void;
  setLiveMessagesByKey: (
    value:
      | Record<string, LiveConversationMessageRecord>
      | ((current: Record<string, LiveConversationMessageRecord>) => Record<string, LiveConversationMessageRecord>)
  ) => void;
}) {
  const completedRunResultPollsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    window.clearTimeout(params.runPollingTimerRef.current);

    if (!params.sessionId.trim() || !params.selectedRunIdValue) {
      if (params.selectedRunIdValue) {
        delete completedRunResultPollsRef.current[params.selectedRunIdValue];
      }
      return;
    }

    if (params.run?.id === params.selectedRunIdValue && isTerminalRunStatus(params.run.status)) {
      delete completedRunResultPollsRef.current[params.selectedRunIdValue];
      return;
    }

    let cancelled = false;
    const streamConnected = params.streamState === "open" || params.streamState === "listening";
    const fallbackPollInterval = streamConnected ? STREAM_CONNECTED_POLL_INTERVAL_MS : STREAM_DISCONNECTED_POLL_INTERVAL_MS;

    const pollRunSnapshot = async () => {
      try {
        const [nextRun, nextSteps, nextMessages] = await Promise.all([
          params.request<Run>(`/api/v1/runs/${params.selectedRunIdValue}`),
          params.request<{ items: RunStep[] }>(`/api/v1/runs/${params.selectedRunIdValue}/steps?pageSize=${RUN_STEP_PAGE_SIZE}`),
          params.request<MessagePage>(buildLiveMessagePagePath(params.sessionId))
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          params.setRun(nextRun);
          params.setSessionRuns((current) => {
            const next = [...current.filter((item) => item.id !== nextRun.id), nextRun];
            return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
          });
          params.setRunSteps((current) => mergeRunStepsForRun(current, params.selectedRunIdValue, nextSteps.items));
          params.setMessages((current) => mergeSessionMessages(current, nextMessages.items));
          params.mergeMessagePageCursor(nextMessages.nextCursor);
        });

        const hasPersistedRunOutput = hasDisplayableRunMessages(nextMessages.items, params.selectedRunIdValue);
        const completedRunResultPolls = completedRunResultPollsRef.current[params.selectedRunIdValue] ?? 0;
        const shouldKeepPollingForCompletedMessage =
          nextRun.status === "completed" &&
          !hasPersistedRunOutput &&
          completedRunResultPolls < COMPLETED_RUN_RESULT_POLL_LIMIT;

        if (nextRun.status === "completed" && !hasPersistedRunOutput) {
          completedRunResultPollsRef.current[params.selectedRunIdValue] = completedRunResultPolls + 1;
        } else {
          delete completedRunResultPollsRef.current[params.selectedRunIdValue];
        }

        if (!isTerminalRunStatus(nextRun.status) || shouldKeepPollingForCompletedMessage) {
          params.runPollingTimerRef.current = window.setTimeout(() => {
            void pollRunSnapshot();
          }, shouldKeepPollingForCompletedMessage ? 400 : fallbackPollInterval);
          return;
        }

        params.setLiveMessagesByKey((current) => {
          return Object.fromEntries(
            Object.entries(current).filter(([, entry]) => entry.runId !== params.selectedRunIdValue)
          );
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        params.runPollingTimerRef.current = window.setTimeout(() => {
          void pollRunSnapshot();
        }, streamConnected ? STREAM_CONNECTED_POLL_INTERVAL_MS : 1_500);

        if (params.streamState === "error") {
          params.reportError(error);
        }
      }
    };

    params.runPollingTimerRef.current = window.setTimeout(() => {
      void pollRunSnapshot();
    }, streamConnected ? 1_500 : 600);

    return () => {
      cancelled = true;
      window.clearTimeout(params.runPollingTimerRef.current);
      delete completedRunResultPollsRef.current[params.selectedRunIdValue];
    };
  }, [
    params.connection.baseUrl,
    params.connection.token,
    params.run?.id,
    params.run?.status,
    params.selectedRunIdValue,
    params.sessionId,
    params.streamState
  ]);
}

export { useSelectedRunPolling };
