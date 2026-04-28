import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Run, Session, SessionEventContract, Workspace, WorkspaceCatalog, WorkspaceRuntime } from "@oah/api-contracts";

import { OahApiClient, type OahConnection } from "../../api/oah-api.js";
import type { ChatLine, Dialog, Notice, WorkspaceCreateDialog } from "../domain/types.js";
import {
  createWorkspaceDialog,
  insertTextAt,
  mergeRefreshedChatLines,
  messageToChatLines,
  runFailureToChatLine,
  shortId,
  updateChatLinesFromEvent
} from "../domain/utils.js";

function useOahClient(connection: OahConnection) {
  return useMemo(() => new OahApiClient(connection), [connection.baseUrl, connection.token]);
}

export function useOahReplState(connection: OahConnection) {
  const client = useOahClient(connection);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [runtimes, setRuntimes] = useState<WorkspaceRuntime[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [, setEvents] = useState<SessionEventContract[]>([]);
  const [composer, setComposer] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [slashSelection, setSlashSelection] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice>({ level: "info", message: "Loading workspaces..." });
  const [streamState, setStreamState] = useState("idle");
  const lastCursorRef = useRef<string | undefined>(undefined);

  const setError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setNotice({ level: "error", message });
  }, []);

  const resetSessionView = useCallback(() => {
    setMessages([]);
    setRuns([]);
    setEvents([]);
    lastCursorRef.current = undefined;
  }, []);

  const refreshRuntimes = useCallback(async () => {
    try {
      setRuntimes(await client.listWorkspaceRuntimes());
    } catch (error) {
      setError(error);
    }
  }, [client, setError]);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const [nextWorkspaces, nextRuntimes] = await Promise.all([client.listAllWorkspaces(), client.listWorkspaceRuntimes().catch(() => [])]);
      setWorkspaces(nextWorkspaces);
      setRuntimes(nextRuntimes);
      if (!currentWorkspace && nextWorkspaces[0]) {
        setCurrentWorkspace(nextWorkspaces[0]);
      }
      setNotice({ level: "info", message: `Loaded ${nextWorkspaces.length} workspaces from ${client.baseUrl}` });
    } catch (error) {
      setError(error);
    }
  }, [client, currentWorkspace, setError]);

  const refreshSession = useCallback(
    async (session: Session) => {
      try {
        const [nextMessages, nextRuns] = await Promise.all([client.listSessionMessages(session.id), client.listSessionRuns(session.id)]);
        const nextLines = nextMessages.flatMap(messageToChatLines);
        const runFailureLine = nextRuns[0] ? runFailureToChatLine(nextRuns[0]) : null;
        const refreshedLines = runFailureLine ? [...nextLines, runFailureLine] : nextLines;
        setMessages((current) => mergeRefreshedChatLines(current, refreshedLines));
        setRuns(nextRuns);
      } catch (error) {
        setError(error);
      }
    },
    [client, setError]
  );

  const refreshSessionRuns = useCallback(
    async (session: Session) => {
      try {
        setRuns(await client.listSessionRuns(session.id));
      } catch (error) {
        setError(error);
      }
    },
    [client, setError]
  );

  const loadWorkspace = useCallback(
    async (workspace: Workspace) => {
      try {
        setCurrentWorkspace(workspace);
        setSessions([]);
        setCatalog(null);
        setCurrentSession(null);
        resetSessionView();
        setNotice({ level: "info", message: `Loading ${workspace.name}...` });
        const [nextSessions, nextCatalog] = await Promise.all([
          client.listWorkspaceSessions(workspace.id),
          client.getWorkspaceCatalog(workspace.id).catch(() => null)
        ]);
        setSessions(nextSessions);
        setCatalog(nextCatalog);
        if (nextSessions[0]) {
          setCurrentSession(nextSessions[0]);
        }
        setDialog(null);
        setNotice({ level: "info", message: `Workspace ready: ${workspace.name}` });
      } catch (error) {
        setError(error);
      }
    },
    [client, resetSessionView, setError]
  );

  const refreshCurrentWorkspaceSessions = useCallback(async () => {
    if (!currentWorkspace) {
      return;
    }
    try {
      setSessions(await client.listWorkspaceSessions(currentWorkspace.id));
    } catch (error) {
      setError(error);
    }
  }, [client, currentWorkspace, setError]);

  const createWorkspace = useCallback(
    async (draft: WorkspaceCreateDialog) => {
      const name = draft.name.trim();
      const runtime = draft.runtime.trim();
      const rootPath = draft.rootPath.trim();
      const ownerId = draft.ownerId.trim();
      const serviceName = draft.serviceName.trim();
      if (!name) {
        setNotice({ level: "error", message: "Workspace name is required." });
        return;
      }
      if (!runtime) {
        setNotice({ level: "error", message: "No workspace runtime is available." });
        return;
      }
      try {
        const workspace = await client.createWorkspace({
          name,
          runtime,
          ...(rootPath ? { rootPath } : {}),
          ...(ownerId ? { ownerId } : {}),
          ...(serviceName ? { serviceName } : {})
        });
        setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
        await loadWorkspace(workspace);
      } catch (error) {
        setError(error);
      }
    },
    [client, loadWorkspace, setError]
  );

  const createSession = useCallback(
    async (title?: string) => {
      if (!currentWorkspace) {
        setNotice({ level: "error", message: "Select a workspace first." });
        return;
      }
      try {
        const session = await client.createSession(currentWorkspace.id, {
          ...(title?.trim() ? { title: title.trim() } : {})
        });
        setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
        setCurrentSession(session);
        resetSessionView();
        setDialog(null);
        setNotice({ level: "info", message: `Created session ${shortId(session.id)}` });
      } catch (error) {
        setError(error);
      }
    },
    [client, currentWorkspace, resetSessionView, setError]
  );

  const selectSession = useCallback(
    (session: Session) => {
      setCurrentSession(session);
      resetSessionView();
      setDialog(null);
      setNotice({ level: "info", message: `Selected session ${shortId(session.id)}` });
    },
    [resetSessionView]
  );

  const setComposerValue = useCallback((value: string) => {
    setComposer(value);
    setComposerCursor(value.length);
    setSlashSelection(0);
  }, []);

  const insertComposerInput = useCallback(
    (input: string) => {
      const cursor = composerCursor;
      setComposer((current) => insertTextAt(current, cursor, input));
      setComposerCursor(cursor + input.length);
      setSlashSelection(0);
    },
    [composerCursor]
  );

  const deleteComposerInput = useCallback(() => {
    if (composerCursor <= 0) {
      return;
    }
    setComposer((current) => `${current.slice(0, composerCursor - 1)}${current.slice(composerCursor)}`);
    setComposerCursor((cursor) => Math.max(0, cursor - 1));
    setSlashSelection(0);
  }, [composerCursor]);

  const openWorkspaceCreator = useCallback(() => {
    setDialog(createWorkspaceDialog(currentWorkspace?.runtime ?? runtimes[0]?.name, runtimes));
  }, [currentWorkspace?.runtime, runtimes]);

  const sendComposer = useCallback(
    async (override?: string) => {
      const content = (override ?? composer).trim();
      if (!content) {
        return;
      }
      if (content === "/help") {
        setComposerValue("");
        setDialog({ kind: "help" });
        return;
      }
      if (content === "/clear") {
        setComposerValue("");
        setMessages([]);
        setRuns([]);
        setNotice({ level: "info", message: "Cleared transcript." });
        return;
      }
      if (content === "/workspace") {
        setComposerValue("");
        setDialog({ kind: "workspace-list", selectedIndex: 0 });
        return;
      }
      if (content === "/session") {
        setComposerValue("");
        setDialog({ kind: "session-list", selectedIndex: 0 });
        return;
      }
      if (content === "/new-session") {
        setComposerValue("");
        setDialog({ kind: "session-create", draft: "" });
        return;
      }
      if (content === "/new-workspace") {
        setComposerValue("");
        openWorkspaceCreator();
        return;
      }
      if (!currentSession) {
        setNotice({ level: "error", message: "Create or select a session first." });
        return;
      }

      setComposerValue("");
      const optimistic: ChatLine = {
        id: `pending:${Date.now()}`,
        role: "user",
        text: content,
        createdAt: new Date().toISOString()
      };
      setMessages((current) => [...current, optimistic]);
      try {
        const accepted = await client.sendMessage(currentSession.id, content);
        setNotice({ level: "info", message: `Queued run ${shortId(accepted.runId)}` });
        void refreshSession(currentSession);
      } catch (error) {
        setMessages((current) => current.filter((line) => line.id !== optimistic.id));
        setError(error);
      }
    },
    [client, composer, currentSession, openWorkspaceCreator, refreshSession, setComposerValue, setError]
  );

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (currentWorkspace) {
      void loadWorkspace(currentWorkspace);
    }
  }, [currentWorkspace?.id]);

  useEffect(() => {
    if (currentSession) {
      void refreshSession(currentSession);
    }
  }, [currentSession?.id]);

  useEffect(() => {
    if (!currentSession) {
      setStreamState("idle");
      return;
    }
    const controller = new AbortController();
    setStreamState("connecting");
    void client
      .streamSessionEvents(currentSession.id, {
        ...(lastCursorRef.current ? { cursor: lastCursorRef.current } : {}),
        signal: controller.signal,
        onOpen: () => {
          if (!controller.signal.aborted) {
            setStreamState("open");
          }
        },
        onEvent: (event) => {
          lastCursorRef.current = event.cursor || lastCursorRef.current;
          setStreamState("open");
          setEvents((current) => [...current.slice(-199), event]);
          setMessages((current) => updateChatLinesFromEvent(current, event));
          if (
            event.event === "run.queued" ||
            event.event === "run.completed" ||
            event.event === "run.failed" ||
            event.event === "run.cancelled" ||
            event.event === "message.completed"
          ) {
            void refreshSession(currentSession);
            return;
          }
          if (event.event === "run.started" || event.event.startsWith("tool.")) {
            void refreshSessionRuns(currentSession);
          }
        }
      })
      .then(() => {
        if (!controller.signal.aborted) {
          setStreamState("closed");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setStreamState("error");
          setError(error);
        }
      });

    return () => {
      controller.abort();
    };
  }, [client, currentSession?.id, refreshSession, refreshSessionRuns, setError]);

  return {
    workspaces,
    runtimes,
    currentWorkspace,
    catalog,
    sessions,
    currentSession,
    messages,
    runs,
    composer,
    composerCursor,
    slashSelection,
    dialog,
    notice,
    streamState,
    setComposerCursor,
    setComposerValue,
    setSlashSelection,
    setDialog,
    insertComposerInput,
    deleteComposerInput,
    refreshRuntimes,
    refreshWorkspaces,
    refreshCurrentWorkspaceSessions,
    loadWorkspace,
    createWorkspace,
    createSession,
    selectSession,
    sendComposer
  };
}
