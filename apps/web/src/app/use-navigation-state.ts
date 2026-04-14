import { useEffect, useState } from "react";

import type { Session, Workspace, WorkspaceCatalog } from "@oah/api-contracts";

import {
  storageKeys,
  usePersistentState,
  type SavedSessionRecord,
  type SavedWorkspaceRecord,
  type WorkspaceDraft
} from "./support";

export function useNavigationState() {
  const [workspaceDraft, setWorkspaceDraft] = usePersistentState<WorkspaceDraft>(storageKeys.workspaceDraft, {
    name: "debug-playground",
    template: "",
    rootPath: ""
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
  const [workspaceTemplates, setWorkspaceTemplates] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [showWorkspaceCreator, setShowWorkspaceCreator] = useState(false);
  const [workspaceManagementEnabled, setWorkspaceManagementEnabled] = useState(true);

  useEffect(() => {
    window.localStorage.removeItem("oah.web.savedWorkspaces");
    window.localStorage.removeItem("oah.web.savedSessions");
  }, []);

  const orderedSavedWorkspaces = savedWorkspaces;
  const sessionsByWorkspaceId = new Map<string, SavedSessionRecord[]>();
  for (const entry of savedSessions) {
    const group = sessionsByWorkspaceId.get(entry.workspaceId) ?? [];
    group.push(entry);
    sessionsByWorkspaceId.set(entry.workspaceId, group);
  }
  const activeWorkspaceId = session?.workspaceId || workspaceId;
  const activeSavedWorkspace = savedWorkspaces.find((entry) => entry.id === activeWorkspaceId);
  const activeWorkspace = workspace?.id === activeWorkspaceId ? workspace : null;
  const currentWorkspaceName = activeWorkspace?.name ?? activeSavedWorkspace?.name ?? activeWorkspaceId ?? "No workspace";
  const currentSessionName = session?.title?.trim() || session?.id || "No session";
  const hasActiveSession = Boolean(sessionId.trim() && session);

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
    workspaceTemplates,
    setWorkspaceTemplates,
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
