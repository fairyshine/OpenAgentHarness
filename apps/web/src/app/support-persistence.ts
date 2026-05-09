import { useEffect, useState } from "react";

const storageKeys = {
  connection: "oah.web.connection",
  workspaceDraft: "oah.web.workspaceDraft",
  workspaceRuntimeFilter: "oah.web.workspaceRuntimeFilter",
  serviceScope: "oah.web.serviceScope",
  sessionDraft: "oah.web.sessionDraft",
  modelDraft: "oah.web.modelDraft",
  workspaceId: "oah.web.workspaceId",
  sessionId: "oah.web.sessionId",
  recentWorkspaces: "oah.web.recentWorkspaces",
  recentSessions: "oah.web.recentSessions",
  expandedWorkspaces: "oah.web.expandedWorkspaces",
  expandedSessions: "oah.web.expandedSessions"
} as const;

function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }

    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return initialValue;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

export { storageKeys, usePersistentState };
