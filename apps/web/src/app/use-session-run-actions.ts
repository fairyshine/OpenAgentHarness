import { startTransition, useEffectEvent, useRef, type Dispatch, type SetStateAction } from "react";

import type { Run, RunPage, RunStep, Session, SessionPage, SessionQueue, SessionQueuedRun } from "@oah/api-contracts";

import { isTerminalRunStatus, type SavedSessionRecord } from "./support";
import { mergeRunStepsForRun, mergeSavedSessionRecords, savedSessionFromSession, sortRunSteps } from "./app-controller-utils";

type SessionIdRef = {
  current: string;
};

export function useSessionRunActions(input: {
  sessionId: string;
  selectedRunId: string;
  activeSessionIdRef: SessionIdRef;
  visibleSidebarSessionIds: string[];
  savedSessions: SavedSessionRecord[];
  sessionsByWorkspaceId: Map<string, SavedSessionRecord[]>;
  sidebarSessionRunsById: Record<string, Run[]>;
  request: <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;
  clearActiveError: () => void;
  reportError: (error: unknown) => void;
  setSelectedRunId: Dispatch<SetStateAction<string>>;
  setSessionRuns: Dispatch<SetStateAction<Run[]>>;
  setRun: Dispatch<SetStateAction<Run | null>>;
  setRunSteps: Dispatch<SetStateAction<RunStep[]>>;
  setSessionQueuedRuns: Dispatch<SetStateAction<SessionQueuedRun[]>>;
  setSavedSessions: Dispatch<SetStateAction<SavedSessionRecord[]>>;
  setSidebarSessionRunsById: Dispatch<SetStateAction<Record<string, Run[]>>>;
}) {
  const sessionQueueRefreshSeqRef = useRef(0);
  const sidebarSessionRunsRefreshSeqRef = useRef(0);

  const refreshSessionRunStepsForRuns = useEffectEvent(async (runs: Run[], quiet = false) => {
    if (runs.length === 0) {
      startTransition(() => {
        input.setRunSteps([]);
      });
      return;
    }

    try {
      const pages = await Promise.all(
        runs.map(async (sessionRun) => {
          const page = await input.request<{ items: RunStep[] }>(`/api/v1/runs/${sessionRun.id}/steps?pageSize=200`);
          return page.items;
        })
      );

      startTransition(() => {
        input.setRunSteps(sortRunSteps(pages.flatMap((items) => items)));
      });

      if (!quiet) {
        input.clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
    }
  });

  const refreshSessionRuns = useEffectEvent(async (quiet = false, options?: { includeSteps?: boolean | "selected" }) => {
    if (!input.sessionId.trim()) {
      return;
    }

    try {
      const page = await input.request<RunPage>(`/api/v1/sessions/${input.sessionId}/runs?pageSize=200`);
      startTransition(() => {
        input.setSessionRuns(page.items);
      });
      const activeSelectedRunId = input.selectedRunId.trim();
      const nextSelectedRun = page.items.find((item) => item.id === activeSelectedRunId) ?? page.items[0];
      if (options?.includeSteps === true) {
        await refreshSessionRunStepsForRuns(page.items, true);
      } else if (options?.includeSteps === "selected" && nextSelectedRun) {
        await refreshSessionRunStepsForRuns([nextSelectedRun], true);
      } else if (!nextSelectedRun) {
        startTransition(() => {
          input.setRunSteps([]);
        });
      }

      if (nextSelectedRun && nextSelectedRun.id !== activeSelectedRunId) {
        startTransition(() => {
          input.setSelectedRunId(nextSelectedRun.id);
          input.setRun(nextSelectedRun);
        });
      } else if (!nextSelectedRun) {
        startTransition(() => {
          input.setSelectedRunId("");
          input.setRun(null);
          input.setRunSteps([]);
        });
      }

      if (!quiet) {
        input.clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
    }
  });

  const refreshVisibleSidebarChildSessions = useEffectEvent(
    async (rootSessionIds: string[]): Promise<SavedSessionRecord[]> => {
      const parentSessionIds = Array.from(new Set(rootSessionIds.map((entry) => entry.trim()).filter(Boolean)));
      if (parentSessionIds.length === 0) {
        return [];
      }

      const pages = await Promise.allSettled(
        parentSessionIds.map(async (parentSessionId) => {
          const page = await input.request<SessionPage>(`/api/v1/sessions/${parentSessionId}/children?pageSize=100`);
          return page.items;
        })
      );
      const childSessions = pages
        .filter((result): result is PromiseFulfilledResult<Session[]> => result.status === "fulfilled")
        .flatMap((result) => result.value);
      if (childSessions.length === 0) {
        return [];
      }

      const existingById = new Map(input.savedSessions.map((entry) => [entry.id, entry]));
      const childRecords = childSessions.map((entry) => savedSessionFromSession(entry, existingById.get(entry.id)));
      startTransition(() => {
        input.setSavedSessions((current) => mergeSavedSessionRecords(current, childRecords));
      });

      return childRecords;
    }
  );

  const refreshSidebarSessionRuns = useEffectEvent(async (quiet = true): Promise<boolean> => {
    const sessionIds = input.visibleSidebarSessionIds.slice(0, 80);
    const seq = ++sidebarSessionRunsRefreshSeqRef.current;

    if (sessionIds.length === 0) {
      startTransition(() => {
        input.setSidebarSessionRunsById({});
      });
      return false;
    }

    try {
      const refreshedChildSessions = await refreshVisibleSidebarChildSessions(sessionIds);
      const workspaceSessionsById = new Map<string, SavedSessionRecord[]>();
      for (const [targetWorkspaceId, workspaceSessions] of input.sessionsByWorkspaceId) {
        workspaceSessionsById.set(targetWorkspaceId, [...workspaceSessions]);
      }
      for (const childSession of refreshedChildSessions) {
        const workspaceSessions = workspaceSessionsById.get(childSession.workspaceId) ?? [];
        const existingIndex = workspaceSessions.findIndex((entry) => entry.id === childSession.id);
        if (existingIndex >= 0) {
          workspaceSessions[existingIndex] = {
            ...workspaceSessions[existingIndex],
            ...childSession
          };
        } else {
          workspaceSessions.push(childSession);
        }
        workspaceSessionsById.set(childSession.workspaceId, workspaceSessions);
      }
      const effectiveSessionIds = Array.from(
        new Set(
          [
            ...sessionIds,
            ...refreshedChildSessions
              .filter((entry) => entry.parentSessionId && sessionIds.includes(entry.parentSessionId))
              .map((entry) => entry.id)
          ].slice(0, 120)
        )
      );
      const entries = await Promise.all(
        effectiveSessionIds.map(async (targetSessionId) => {
          const page = await input.request<RunPage>(`/api/v1/sessions/${targetSessionId}/runs?pageSize=20`);
          return [targetSessionId, page.items] as const;
        })
      );

      if (seq !== sidebarSessionRunsRefreshSeqRef.current) {
        return false;
      }

      const activeRunEntries = entries.filter(([, runs]) => runs.some((item) => !isTerminalRunStatus(item.status)));
      const activeRunEntryIds = new Set(activeRunEntries.map(([targetSessionId]) => targetSessionId));
      const activeRunParentIds = new Set<string>();
      for (const workspaceSessions of workspaceSessionsById.values()) {
        for (const sessionEntry of workspaceSessions) {
          if (sessionEntry.parentSessionId && activeRunEntryIds.has(sessionEntry.id)) {
            activeRunParentIds.add(sessionEntry.parentSessionId);
          }
        }
      }
      const hasNonTerminalRun = activeRunEntries.length > 0;

      startTransition(() => {
        const retainedIdSet = new Set(effectiveSessionIds);
        const visibleIdSet = new Set(sessionIds);
        input.setSidebarSessionRunsById((current) => {
          const next: Record<string, Run[]> = {};
          for (const [targetSessionId, runs] of Object.entries(current)) {
            if (retainedIdSet.has(targetSessionId)) {
              next[targetSessionId] = runs;
            }
          }
          for (const [targetSessionId, runs] of entries) {
            next[targetSessionId] = runs;
          }
          for (const parentSessionId of activeRunParentIds) {
            if (!visibleIdSet.has(parentSessionId) || next[parentSessionId]?.some((item) => !isTerminalRunStatus(item.status))) {
              continue;
            }

            const representativeRun = activeRunEntries
              .find(([targetSessionId]) => {
                for (const workspaceSessions of workspaceSessionsById.values()) {
                  const childSession = workspaceSessions.find((entry) => entry.id === targetSessionId);
                  if (childSession?.parentSessionId === parentSessionId) {
                    return true;
                  }
                }
                return false;
              })
              ?.[1]
              .find((item) => !isTerminalRunStatus(item.status));
            if (representativeRun) {
              next[parentSessionId] = [
                {
                  ...representativeRun,
                  id: `${parentSessionId}:active-child:${representativeRun.id}`,
                  sessionId: parentSessionId,
                  metadata: {
                    ...(representativeRun.metadata ?? {}),
                    statusDerivedFromChildRunId: representativeRun.id,
                    statusDerivedFromChildSessionId: representativeRun.sessionId
                  }
                },
                ...(next[parentSessionId] ?? [])
              ];
            }
          }
          return next;
        });
      });

      return hasNonTerminalRun;
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
      return Object.values(input.sidebarSessionRunsById)
        .flat()
        .some((item) => !isTerminalRunStatus(item.status));
    }
  });

  const refreshRun = useEffectEvent(async (targetId = input.selectedRunId, quiet = false) => {
    if (!targetId.trim()) {
      return;
    }

    try {
      const runResponse = await input.request<Run>(`/api/v1/runs/${targetId}`);
      startTransition(() => {
        input.setRun(runResponse);
        input.setSelectedRunId(targetId);
      });
      if (!quiet) {
        input.clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
    }
  });

  const refreshRunSteps = useEffectEvent(async (targetId = input.selectedRunId, quiet = false) => {
    if (!targetId.trim()) {
      return;
    }

    try {
      const page = await input.request<{ items: RunStep[] }>(`/api/v1/runs/${targetId}/steps?pageSize=200`);
      startTransition(() => {
        input.setRunSteps((current) => mergeRunStepsForRun(current, targetId, page.items));
      });
      if (!quiet) {
        input.clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
    }
  });

  const refreshSessionQueue = useEffectEvent(async (quiet = false) => {
    const targetSessionId = input.sessionId.trim();
    if (!targetSessionId) {
      startTransition(() => {
        input.setSessionQueuedRuns([]);
      });
      return;
    }

    const refreshSeq = sessionQueueRefreshSeqRef.current + 1;
    sessionQueueRefreshSeqRef.current = refreshSeq;

    try {
      const queue = await input.request<SessionQueue>(`/api/v1/sessions/${targetSessionId}/queue`);
      if (input.activeSessionIdRef.current !== targetSessionId || sessionQueueRefreshSeqRef.current !== refreshSeq) {
        return;
      }

      startTransition(() => {
        input.setSessionQueuedRuns(queue.items);
      });
      if (!quiet) {
        input.clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
    }
  });

  return {
    refreshSessionRuns,
    refreshSidebarSessionRuns,
    refreshRun,
    refreshRunSteps,
    refreshSessionQueue
  };
}
