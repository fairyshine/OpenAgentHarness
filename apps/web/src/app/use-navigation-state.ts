import { useEffect, useMemo, useState } from "react";

import type { Session, Workspace, WorkspaceCatalog } from "@oah/api-contracts";

import {
  compareSavedNavigationItemsDesc,
  compareSavedSessionsByRecency,
  storageKeys,
  usePersistentState,
  type SavedSessionRecord,
  type SavedWorkspaceRecord,
  type WorkspaceDraft
} from "./support";

export function useNavigationState() {
  const [workspaceDraft, setWorkspaceDraft] = usePersistentState<WorkspaceDraft>(storageKeys.workspaceDraft, {
    name: "debug-playground",
    runtime: "",
    rootPath: "",
    ownerId: "",
    serviceName: ""
  });
  const [workspaceId, setWorkspaceId] = usePersistentState(storageKeys.workspaceId, "");
  const [sessionId, setSessionId] = usePersistentState(storageKeys.sessionId, "");
  const [savedWorkspaces, setSavedWorkspaces] = useState<SavedWorkspaceRecord[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSessionRecord[]>([]);
  const [recentWorkspaces, setRecentWorkspaces] = usePersistentState<string[]>(storageKeys.recentWorkspaces, []);
  const [recentSessions, setRecentSessions] = usePersistentState<string[]>(storageKeys.recentSessions, []);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = usePersistentState<string[]>(storageKeys.expandedWorkspaces, []);
  const [expandedSessionIds, setExpandedSessionIds] = usePersistentState<string[]>(storageKeys.expandedSessions, []);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceRuntimes, setWorkspaceRuntimes] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [showWorkspaceCreator, setShowWorkspaceCreator] = useState(false);
  const [workspaceManagementEnabled, setWorkspaceManagementEnabled] = useState(true);

  useEffect(() => {
    window.localStorage.removeItem("oah.web.savedWorkspaces");
    window.localStorage.removeItem("oah.web.savedSessions");
  }, []);

  const orderedSavedWorkspaces = useMemo(() => [...savedWorkspaces].sort(compareSavedNavigationItemsDesc), [savedWorkspaces]);
  const sessionsByWorkspaceId = useMemo(() => {
    const next = new Map<string, SavedSessionRecord[]>();
    for (const entry of savedSessions) {
      const group = next.get(entry.workspaceId) ?? [];
      group.push(entry);
      next.set(entry.workspaceId, group);
    }

    for (const [workspaceId, group] of next) {
      next.set(workspaceId, [...group].sort(compareSavedSessionsByRecency));
    }

    return next;
  }, [savedSessions]);
  const activeWorkspaceId = useMemo(() => session?.workspaceId || workspaceId, [session?.workspaceId, workspaceId]);
  const activeSavedWorkspace = useMemo(
    () => savedWorkspaces.find((entry) => entry.id === activeWorkspaceId),
    [activeWorkspaceId, savedWorkspaces]
  );
  const activeWorkspace = useMemo(
    () => (workspace?.id === activeWorkspaceId ? workspace : null),
    [activeWorkspaceId, workspace]
  );
  const currentWorkspaceName = useMemo(
    () => activeWorkspace?.name ?? activeSavedWorkspace?.name ?? activeWorkspaceId ?? "No workspace",
    [activeSavedWorkspace?.name, activeWorkspace?.name, activeWorkspaceId]
  );
  const currentSessionName = useMemo(() => session?.title?.trim() || session?.id || "No session", [session?.id, session?.title]);
  const hasActiveSession = useMemo(() => Boolean(sessionId.trim() && session), [session, sessionId]);

  return {
    workspaceDraft,
    setWorkspaceDraft,
    workspaceId,
    setWorkspaceId,
    sessionId,
    setSessionId,
    savedWorkspaces,
    setSavedWorkspaces,
    savedSessions,
    setSavedSessions,
    recentWorkspaces,
    setRecentWorkspaces,
    recentSessions,
    setRecentSessions,
    expandedWorkspaceIds,
    setExpandedWorkspaceIds,
    expandedSessionIds,
    setExpandedSessionIds,
    workspace,
    setWorkspace,
    workspaceRuntimes,
    setWorkspaceRuntimes,
    catalog,
    setCatalog,
    session,
    setSession,
    showWorkspaceCreator,
    setShowWorkspaceCreator,
    workspaceManagementEnabled,
    setWorkspaceManagementEnabled,
    orderedSavedWorkspaces,
    sessionsByWorkspaceId,
    activeWorkspaceId,
    currentWorkspaceName,
    currentSessionName,
    hasActiveSession
  };
}
