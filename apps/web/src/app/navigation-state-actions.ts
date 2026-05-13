import type { Session, Workspace } from "@oah/api-contracts";

import {
  addRecentId,
  compareSavedSessionsByRecency,
  type SavedSessionRecord,
  type SavedWorkspaceRecord
} from "./support";
import type { NavigationActionParams } from "./navigation-action-types";

function createNavigationStateActions(params: NavigationActionParams) {
  function rememberWorkspace(
    workspaceRecord: Workspace,
    options?: {
      runtime?: string;
    }
  ) {
    const now = new Date().toISOString();
    params.navigation.setSavedWorkspaces((current) => {
      const existing = current.find((entry) => entry.id === workspaceRecord.id);
      const nextRecord: SavedWorkspaceRecord = {
        id: workspaceRecord.id,
        name: workspaceRecord.name,
        rootPath: workspaceRecord.rootPath,
        status: workspaceRecord.status,
        createdAt: workspaceRecord.createdAt ?? existing?.createdAt,
        updatedAt: workspaceRecord.updatedAt ?? existing?.updatedAt,
        lastOpenedAt: now,
        ...(workspaceRecord.serviceName ? { serviceName: workspaceRecord.serviceName } : {})
      };
      const runtimeValue = options?.runtime ?? existing?.runtime;
      if (runtimeValue) {
        nextRecord.runtime = runtimeValue;
      }

      if (existing) {
        return current.map((entry) => (entry.id === workspaceRecord.id ? nextRecord : entry));
      }

      return [...current, nextRecord].slice(-24);
    });
  }

  function touchSavedWorkspace(targetWorkspaceId: string) {
    if (!targetWorkspaceId.trim()) {
      return;
    }

    const now = new Date().toISOString();
    params.navigation.setSavedWorkspaces((current) =>
      current.map((entry) =>
        entry.id === targetWorkspaceId
          ? {
              ...entry,
              lastOpenedAt: now
            }
          : entry
      )
    );
    params.navigation.setRecentWorkspaces((current) => addRecentId(current, targetWorkspaceId));
  }

  function rememberSession(sessionRecord: Session) {
    const now = new Date().toISOString();
    const nextRecord: SavedSessionRecord = {
      id: sessionRecord.id,
      workspaceId: sessionRecord.workspaceId,
      ...(sessionRecord.parentSessionId ? { parentSessionId: sessionRecord.parentSessionId } : {}),
      title: sessionRecord.title,
      modelRef: sessionRecord.modelRef,
      agentName: sessionRecord.activeAgentName,
      lastRunAt: sessionRecord.lastRunAt,
      createdAt: sessionRecord.createdAt,
      lastOpenedAt: now
    };

    params.navigation.setSavedSessions((current) => {
      const existingIndex = current.findIndex((entry) => entry.id === sessionRecord.id);
      if (existingIndex >= 0) {
        return current.map((entry, index) => (index === existingIndex ? { ...entry, ...nextRecord } : entry)).sort(compareSavedSessionsByRecency);
      }

      return [...current, nextRecord].sort(compareSavedSessionsByRecency).slice(0, 48);
    });
  }

  function collectSessionTreeIds(rootSessionId: string, sessions: SavedSessionRecord[]): string[] {
    const childIdsByParentId = new Map<string, string[]>();
    for (const entry of sessions) {
      if (!entry.parentSessionId) {
        continue;
      }

      const childIds = childIdsByParentId.get(entry.parentSessionId) ?? [];
      childIds.push(entry.id);
      childIdsByParentId.set(entry.parentSessionId, childIds);
    }

    const collectedIds: string[] = [];
    const visit = (sessionId: string) => {
      collectedIds.push(sessionId);
      for (const childSessionId of childIdsByParentId.get(sessionId) ?? []) {
        visit(childSessionId);
      }
    };

    visit(rootSessionId);
    return collectedIds;
  }

  function expandWorkspaceInSidebar(targetWorkspaceId: string) {
    if (!targetWorkspaceId.trim()) {
      return;
    }

    params.navigation.setExpandedWorkspaceIds((current) =>
      current.includes(targetWorkspaceId) ? current : [targetWorkspaceId, ...current].slice(0, 24)
    );
  }

  function toggleWorkspaceExpansion(targetWorkspaceId: string) {
    if (!targetWorkspaceId.trim()) {
      return;
    }

    params.navigation.setExpandedWorkspaceIds((current) =>
      current.includes(targetWorkspaceId)
        ? current.filter((entry) => entry !== targetWorkspaceId)
        : [targetWorkspaceId, ...current].slice(0, 24)
    );
  }

  function clearSessionSelection(sessionToClearId?: string, options?: { forgetSession?: boolean }) {
    const targetId = sessionToClearId ?? params.navigation.sessionId;
    params.runtime.lastCursorRef.current = undefined;
    params.runtime.streamAbortRef.current?.abort();
    window.clearTimeout(params.runtime.runPollingTimerRef.current);
    params.runtime.setStreamState("idle");
    params.navigation.setSessionId("");
    params.navigation.setSession(null);
    params.runtime.setMessages([]);
    params.runtime.setEvents([]);
    params.runtime.setSelectedRunId("");
    params.runtime.setRun(null);
    params.runtime.setRunSteps([]);
    params.runtime.setLiveMessagesByKey({});

    if (targetId && options?.forgetSession) {
      params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== targetId));
      params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== targetId));
    }
  }

  function clearWorkspaceSelection(workspaceToClearId?: string) {
    const targetId = workspaceToClearId ?? params.navigation.workspaceId;
    clearSessionSelection();
    params.navigation.setWorkspaceId("");
    params.navigation.setWorkspace(null);
    params.navigation.setCatalog(null);

    if (targetId) {
      params.navigation.setSavedWorkspaces((current) => current.filter((entry) => entry.id !== targetId));
      params.navigation.setRecentWorkspaces((current) => current.filter((entry) => entry !== targetId));
      params.navigation.setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== targetId));
      params.navigation.setRecentSessions((current) =>
        current.filter(
          (entryId) => !params.navigation.savedSessions.some((entry) => entry.id === entryId && entry.workspaceId === targetId)
        )
      );
      params.navigation.setExpandedWorkspaceIds((current) => current.filter((entry) => entry !== targetId));
    }
  }

  function forgetWorkspace(workspaceToRemoveId: string) {
    if (params.navigation.workspaceId === workspaceToRemoveId) {
      clearWorkspaceSelection(workspaceToRemoveId);
      return;
    }

    params.navigation.setSavedWorkspaces((current) => current.filter((entry) => entry.id !== workspaceToRemoveId));
    params.navigation.setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== workspaceToRemoveId));
    params.navigation.setRecentWorkspaces((current) => current.filter((entry) => entry !== workspaceToRemoveId));
    params.navigation.setRecentSessions((current) =>
      current.filter(
        (entryId) =>
          !params.navigation.savedSessions.some((entry) => entry.id === entryId && entry.workspaceId === workspaceToRemoveId)
      )
    );
    params.navigation.setExpandedWorkspaceIds((current) => current.filter((entry) => entry !== workspaceToRemoveId));
  }

  function forgetWorkspaces(workspaceIdsToRemove: string[]) {
    const workspaceIdsToRemoveSet = new Set(workspaceIdsToRemove.filter((entry) => entry.trim().length > 0));
    if (workspaceIdsToRemoveSet.size === 0) {
      return;
    }

    if (params.navigation.workspaceId && workspaceIdsToRemoveSet.has(params.navigation.workspaceId)) {
      clearSessionSelection();
      params.navigation.setWorkspaceId("");
      params.navigation.setWorkspace(null);
      params.navigation.setCatalog(null);
    }

    params.navigation.setSavedWorkspaces((current) => current.filter((entry) => !workspaceIdsToRemoveSet.has(entry.id)));
    params.navigation.setSavedSessions((current) => current.filter((entry) => !workspaceIdsToRemoveSet.has(entry.workspaceId)));
    params.navigation.setRecentWorkspaces((current) => current.filter((entry) => !workspaceIdsToRemoveSet.has(entry)));
    params.navigation.setRecentSessions((current) =>
      current.filter(
        (entryId) =>
          !params.navigation.savedSessions.some(
            (entry) => entry.id === entryId && workspaceIdsToRemoveSet.has(entry.workspaceId)
          )
      )
    );
    params.navigation.setExpandedWorkspaceIds((current) => current.filter((entry) => !workspaceIdsToRemoveSet.has(entry)));
  }

  return {
    clearSessionSelection,
    clearWorkspaceSelection,
    collectSessionTreeIds,
    expandWorkspaceInSidebar,
    forgetWorkspace,
    forgetWorkspaces,
    rememberSession,
    rememberWorkspace,
    toggleWorkspaceExpansion,
    touchSavedWorkspace
  };
}

export { createNavigationStateActions };
