import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type {
  Message,
  Run,
  RunPage,
  RunStep,
  RunStepPage,
  Session,
  SessionEventContract,
  SessionQueuedRun,
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
    recentSessions: string[];
    setRecentSessions: Dispatch<SetStateAction<string[]>>;
    expandedWorkspaceIds: string[];
    setExpandedWorkspaceIds: Dispatch<SetStateAction<string[]>>;
    expandedSessionIds: string[];
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
    setSessionRuns: Dispatch<SetStateAction<Run[]>>;
    setRun: Dispatch<SetStateAction<Run | null>>;
    setRunSteps: Dispatch<SetStateAction<RunStep[]>>;
    setSessionQueuedRuns: Dispatch<SetStateAction<SessionQueuedRun[]>>;
    setLiveMessagesByKey: Dispatch<SetStateAction<Record<string, LiveConversationMessageRecord>>>;
    setStreamState: Dispatch<SetStateAction<"idle" | "connecting" | "listening" | "open" | "error">>;
    streamAbortRef: MutableRefObject<AbortController | null>;
    activeSessionIdRef: MutableRefObject<string>;
    lastCursorRef: MutableRefObject<string | undefined>;
    runPollingTimerRef: MutableRefObject<number | undefined>;
    lastExplicitSessionRefreshRef: MutableRefObject<{ sessionId: string; at: number } | null>;
    sessionSnapshotHydrationRef: MutableRefObject<{ sessionId: string; at: number } | null>;
    newEmptySessionIdRef: MutableRefObject<string | null>;
    mergeMessagePageCursor: (cursor: string | undefined) => void;
    refreshMessages: (quiet?: boolean, options?: { pageSize?: number | undefined; reset?: boolean | undefined }) => Promise<void>;
    refreshSessionQueue: (quiet?: boolean) => Promise<void>;
    refreshSessionRuns: (quiet?: boolean, options?: { includeSteps?: boolean | "selected" }) => Promise<void>;
  };
}

interface SessionSnapshotResponse {
  session: Session;
  messages: {
    items: Message[];
    nextCursor?: string | undefined;
  };
  runs: RunPage;
  selectedRunId?: string | undefined;
  selectedRunSteps?: RunStepPage | undefined;
  queue: {
    items: SessionQueuedRun[];
  };
}

export type { AppRequest, NavigationActionParams, SessionSnapshotResponse };
