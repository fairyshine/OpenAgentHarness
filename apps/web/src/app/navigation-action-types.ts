import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type {
  Message,
  Run,
  RunStep,
  Session,
  SessionEventContract,
  Workspace,
  WorkspaceCatalog
} from "@oah/api-contracts";

import type {
  ConnectionSettings,
  LiveConversationMessageRecord,
  SavedSessionRecord,
  SavedWorkspaceRecord,
  WorkspaceDraft
} from "./support";

type AppRequest = <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;

interface NavigationActionParams {
  request: AppRequest;
  connection: ConnectionSettings;
  setActivity: (value: string) => void;
  setErrorMessage: (value: string) => void;
  navigation: {
    workspaceDraft: WorkspaceDraft;
    setWorkspaceDraft: Dispatch<SetStateAction<WorkspaceDraft>>;
    workspaceId: string;
    activeWorkspaceIdRef: MutableRefObject<string>;
    setWorkspaceId: Dispatch<SetStateAction<string>>;
    sessionId: string;
    setSessionId: Dispatch<SetStateAction<string>>;
    savedWorkspaces: SavedWorkspaceRecord[];
    setSavedWorkspaces: Dispatch<SetStateAction<SavedWorkspaceRecord[]>>;
    savedSessions: SavedSessionRecord[];
    setSavedSessions: Dispatch<SetStateAction<SavedSessionRecord[]>>;
    recentWorkspaces: string[];
    setRecentWorkspaces: Dispatch<SetStateAction<string[]>>;
    setRecentSessions: Dispatch<SetStateAction<string[]>>;
    expandedWorkspaceIds: string[];
    setExpandedWorkspaceIds: Dispatch<SetStateAction<string[]>>;
    setExpandedSessionIds: Dispatch<SetStateAction<string[]>>;
    workspace: Workspace | null;
    setWorkspace: Dispatch<SetStateAction<Workspace | null>>;
    setWorkspaceRuntimes: Dispatch<SetStateAction<string[]>>;
    setCatalog: Dispatch<SetStateAction<WorkspaceCatalog | null>>;
    session: Session | null;
    setSession: Dispatch<SetStateAction<Session | null>>;
    setShowWorkspaceCreator: Dispatch<SetStateAction<boolean>>;
    setWorkspaceManagementEnabled: Dispatch<SetStateAction<boolean>>;
  };
  runtime: {
    setMessages: Dispatch<SetStateAction<Message[]>>;
    setEvents: Dispatch<SetStateAction<SessionEventContract[]>>;
    setSelectedRunId: Dispatch<SetStateAction<string>>;
    setRun: Dispatch<SetStateAction<Run | null>>;
    setRunSteps: Dispatch<SetStateAction<RunStep[]>>;
    setLiveMessagesByKey: Dispatch<SetStateAction<Record<string, LiveConversationMessageRecord>>>;
    setStreamState: Dispatch<SetStateAction<"idle" | "connecting" | "listening" | "open" | "error">>;
    streamAbortRef: MutableRefObject<AbortController | null>;
    activeSessionIdRef: MutableRefObject<string>;
    lastCursorRef: MutableRefObject<string | undefined>;
    runPollingTimerRef: MutableRefObject<number | undefined>;
    lastExplicitSessionRefreshRef: MutableRefObject<{ sessionId: string; at: number } | null>;
    newEmptySessionIdRef: MutableRefObject<string | null>;
  };
}

export type { AppRequest, NavigationActionParams };
