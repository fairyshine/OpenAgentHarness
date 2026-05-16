import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import type { Run, Session, SessionEventContract, SystemProfile, Workspace, WorkspaceCatalog, WorkspaceRuntime } from "@oah/api-contracts";

import { OahApiClient, type OahConnection } from "../../api/oah-api.js";
import type { AskUserQuestionSelection, ChatLine, Dialog, MemoryDialog, Notice, SessionStartupMode, WorkspaceCreateDialog } from "../domain/types.js";
import {
  createWorkspaceDialog,
  formatSessionActivity,
  insertTextAt,
  latestSessionRun,
  mergeRefreshedChatLines,
  messageToChatLines,
  runFailureToChatLine,
  shortId,
  updateChatLinesFromEvent
} from "../domain/utils.js";

function useOahClient(connection: OahConnection) {
  return useMemo(() => new OahApiClient(connection), [connection.baseUrl, connection.token]);
}

export function useOahReplState(
  connection: OahConnection,
  options: { initialWorkspaceId?: string | undefined; sessionStartupMode?: SessionStartupMode | undefined } = {}
) {
  const client = useOahClient(connection);
  const [systemProfile, setSystemProfile] = useState<SystemProfile | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [runtimes, setRuntimes] = useState<WorkspaceRuntime[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionLatestRuns, setSessionLatestRuns] = useState<Record<string, Run | undefined>>({});
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [, setEvents] = useState<SessionEventContract[]>([]);
  const [composer, setComposer] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [slashSelection, setSlashSelection] = useState(0);
  const [askUserQuestionSelection, setAskUserQuestionSelection] = useState<AskUserQuestionSelection | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice>({ level: "info", message: "Loading workspaces..." });
  const [streamState, setStreamState] = useState("idle");
  const dialogRef = useRef<Dialog | null>(null);
  const lastCursorRef = useRef<string | undefined>(undefined);
  const composerRef = useRef("");
  const composerCursorRef = useRef(0);
  const loadingWorkspaceIdRef = useRef<string | null>(null);
  const startupModeConsumedRef = useRef(false);

  const setError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setNotice({ level: "error", message });
  }, []);

  useEffect(() => {
    dialogRef.current = dialog;
  }, [dialog]);

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
      const [nextProfile, nextWorkspaces, nextRuntimes] = await Promise.all([
        client.getSystemProfile().catch(() => null),
        client.listAllWorkspaces(),
        client.listWorkspaceRuntimes().catch(() => [])
      ]);
      setSystemProfile(nextProfile);
      setWorkspaces(nextWorkspaces);
      setRuntimes(nextRuntimes);
      if (!currentWorkspace) {
        const initialWorkspace = options.initialWorkspaceId
          ? nextWorkspaces.find((workspace) => workspace.id === options.initialWorkspaceId)
          : undefined;
        if (initialWorkspace ?? nextWorkspaces[0]) {
          setCurrentWorkspace(initialWorkspace ?? nextWorkspaces[0]!);
        }
      }
      setNotice({ level: "info", message: `Loaded ${nextWorkspaces.length} workspaces from ${nextProfile?.displayName ?? client.baseUrl}` });
    } catch (error) {
      setError(error);
    }
  }, [client, currentWorkspace, options.initialWorkspaceId, setError]);

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

  const fetchLatestSessionRuns = useCallback(
    async (nextSessions: Session[]) => {
      const entries = await Promise.all(
        nextSessions.map(async (session) => {
          try {
            return [session.id, latestSessionRun(await client.listSessionRuns(session.id))] as const;
          } catch {
            return [session.id, undefined] as const;
          }
        })
      );
      return Object.fromEntries(entries) as Record<string, Run | undefined>;
    },
    [client]
  );

  const createSessionForWorkspace = useCallback(
    async (workspace: Workspace, title?: string, options?: { noticePrefix?: string | undefined }) => {
      const session = await client.createSession(workspace.id, {
        ...(title?.trim() ? { title: title.trim() } : {})
      });
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSessionLatestRuns((current) => ({ ...current, [session.id]: undefined }));
      setCurrentSession(session);
      resetSessionView();
      setDialog(null);
      setNotice({ level: "info", message: `${options?.noticePrefix ?? "Created"} session ${shortId(session.id)}` });
      return session;
    },
    [client, resetSessionView]
  );

  const loadWorkspace = useCallback(
    async (workspace: Workspace) => {
      try {
        if (loadingWorkspaceIdRef.current === workspace.id) {
          return;
        }
        loadingWorkspaceIdRef.current = workspace.id;
        setCurrentWorkspace(workspace);
        setSessions([]);
        setSessionLatestRuns({});
        setCatalog(null);
        setCurrentSession(null);
        resetSessionView();
        setNotice({ level: "info", message: `Loading ${workspace.name}...` });
        const [nextSessions, nextCatalog] = await Promise.all([
          client.listWorkspaceSessions(workspace.id),
          client.getWorkspaceCatalog(workspace.id).catch(() => null)
        ]);
        const latestRuns = await fetchLatestSessionRuns(nextSessions);
        setSessions(nextSessions);
        setSessionLatestRuns(latestRuns);
        setCatalog(nextCatalog);
        const sessionStartupMode = startupModeConsumedRef.current ? "resume" : (options.sessionStartupMode ?? "resume");
        startupModeConsumedRef.current = true;
        if (sessionStartupMode === "new") {
          await createSessionForWorkspace(workspace, undefined, { noticePrefix: "Created fresh" });
        } else if (nextSessions[0]) {
          const session = nextSessions.find((item) => !item.parentSessionId) ?? nextSessions[0]!;
          const activity = formatSessionActivity(session, latestRuns[session.id]);
          setCurrentSession(session);
          setNotice({ level: "info", message: `Resumed ${activity.label} session ${shortId(session.id)} (${activity.detail})` });
        } else {
          setNotice({ level: "info", message: "No sessions yet. Type a message or use /new-session to create one." });
        }
        setDialog(null);
      } catch (error) {
        setError(error);
      } finally {
        if (loadingWorkspaceIdRef.current === workspace.id) {
          loadingWorkspaceIdRef.current = null;
        }
      }
    },
    [client, createSessionForWorkspace, fetchLatestSessionRuns, options.sessionStartupMode, resetSessionView, setError]
  );

  const refreshCurrentWorkspaceSessions = useCallback(async () => {
    if (!currentWorkspace) {
      return;
    }
    try {
      const nextSessions = await client.listWorkspaceSessions(currentWorkspace.id);
      setSessions(nextSessions);
      setSessionLatestRuns(await fetchLatestSessionRuns(nextSessions));
    } catch (error) {
      setError(error);
    }
  }, [client, currentWorkspace, fetchLatestSessionRuns, setError]);

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

  const openMemoryDialog = useCallback(
    async (query = "") => {
      if (!currentWorkspace) {
        setNotice({ level: "error", message: "Select a workspace first." });
        return;
      }

      const trimmedQuery = query.trim();
      setDialog({
        kind: "memory",
        mode: "files",
        selectedIndex: 0,
        query: trimmedQuery,
        corpus: "all",
        status: null,
        files: [],
        proposals: [],
        detail: null,
        loading: true
      });
      try {
        const [status, files, proposals] = await Promise.all([
          client.getWorkspaceMemoryStatus(currentWorkspace.id),
          trimmedQuery
            ? client.searchWorkspaceMemory(currentWorkspace.id, { query: trimmedQuery, maxResults: 12 }).then((result) => result.items)
            : client.listWorkspaceMemory(currentWorkspace.id).then((result) => result.items),
          client.listWorkspaceMemoryProposals(currentWorkspace.id).then((result) => result.items)
        ]);
        setDialog((dialog) =>
          dialog?.kind === "memory"
            ? {
                ...dialog,
                status,
                files,
                proposals,
                loading: false,
                error: undefined,
                selectedIndex: 0,
                detail: null
              }
            : dialog
        );
        setNotice({ level: "info", message: `Loaded workspace memory for ${currentWorkspace.name}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDialog((dialog) => (dialog?.kind === "memory" ? { ...dialog, loading: false, error: message } : dialog));
        setNotice({ level: "error", message });
      }
    },
    [client, currentWorkspace]
  );

  const refreshMemoryDialog = useCallback(async () => {
    const dialog = dialogRef.current;
    if (dialog?.kind !== "memory") {
      return;
    }
    await openMemoryDialog(dialog.query);
  }, [openMemoryDialog]);

  const readMemorySelection = useCallback(async () => {
    const dialog = dialogRef.current;
    if (dialog?.kind !== "memory" || !currentWorkspace) {
      return;
    }
    const item = dialog.mode === "proposals" ? dialog.proposals[dialog.selectedIndex] : dialog.files[dialog.selectedIndex];
    if (!item) {
      return;
    }
    setDialog({ ...dialog, loading: true, error: undefined });
    try {
      const detail = await client.readWorkspaceMemory(currentWorkspace.id, { path: item.path, lines: 160 });
      setDialog((current) =>
        current?.kind === "memory"
          ? {
              ...current,
              mode: "detail",
              detail,
              loading: false,
              error: undefined
            }
          : current
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDialog((current) => (current?.kind === "memory" ? { ...current, loading: false, error: message } : current));
      setNotice({ level: "error", message });
    }
  }, [client, currentWorkspace]);

  const applyMemoryProposalSelection = useCallback(async () => {
    const dialog = dialogRef.current;
    if (dialog?.kind !== "memory" || !currentWorkspace) {
      return;
    }
    const proposal = dialog.proposals[dialog.selectedIndex];
    if (!proposal) {
      return;
    }
    setDialog({ ...dialog, loading: true, error: undefined });
    try {
      await client.applyWorkspaceMemoryProposal(currentWorkspace.id, proposal.path);
      setNotice({ level: "info", message: `Applied memory proposal ${proposal.path}` });
      await openMemoryDialog(dialog.query);
      setDialog((current) =>
        current?.kind === "memory"
          ? { ...current, mode: "proposals", selectedIndex: Math.min(dialog.selectedIndex, Math.max(0, current.proposals.length - 1)) }
          : current
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDialog((current) => (current?.kind === "memory" ? { ...current, loading: false, error: message } : current));
      setNotice({ level: "error", message });
    }
  }, [client, currentWorkspace, openMemoryDialog]);

  const rejectMemoryProposalSelection = useCallback(async () => {
    const dialog = dialogRef.current;
    if (dialog?.kind !== "memory" || !currentWorkspace) {
      return;
    }
    const proposal = dialog.proposals[dialog.selectedIndex];
    if (!proposal) {
      return;
    }
    setDialog({ ...dialog, loading: true, error: undefined });
    try {
      await client.rejectWorkspaceMemoryProposal(currentWorkspace.id, proposal.path);
      setNotice({ level: "info", message: `Rejected memory proposal ${proposal.path}` });
      await openMemoryDialog(dialog.query);
      setDialog((current) =>
        current?.kind === "memory"
          ? { ...current, mode: "proposals", selectedIndex: Math.min(dialog.selectedIndex, Math.max(0, current.proposals.length - 1)) }
          : current
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDialog((current) => (current?.kind === "memory" ? { ...current, loading: false, error: message } : current));
      setNotice({ level: "error", message });
    }
  }, [client, currentWorkspace, openMemoryDialog]);

  const createSession = useCallback(
    async (title?: string) => {
      if (!currentWorkspace) {
        setNotice({ level: "error", message: "Select a workspace first." });
        return;
      }
      try {
        await createSessionForWorkspace(currentWorkspace, title);
      } catch (error) {
        setError(error);
      }
    },
    [createSessionForWorkspace, currentWorkspace, setError]
  );

  const selectSession = useCallback(
    (session: Session) => {
      const activity = formatSessionActivity(session, sessionLatestRuns[session.id]);
      setCurrentSession(session);
      resetSessionView();
      setDialog(null);
      setNotice({ level: "info", message: `Selected ${activity.label} session ${shortId(session.id)} (${activity.detail})` });
    },
    [resetSessionView, sessionLatestRuns]
  );

  const applyComposerValue = useCallback((value: string, cursor: number) => {
    const nextCursor = Math.max(0, Math.min(cursor, value.length));
    composerRef.current = value;
    composerCursorRef.current = nextCursor;
    setComposer(value);
    setComposerCursor(nextCursor);
    setSlashSelection(0);
  }, []);

  const setComposerCursorValue = useCallback((value: SetStateAction<number>) => {
    const nextCursor = typeof value === "function" ? value(composerCursorRef.current) : value;
    const clampedCursor = Math.max(0, Math.min(nextCursor, composerRef.current.length));
    composerCursorRef.current = clampedCursor;
    setComposerCursor(clampedCursor);
  }, []);

  const setComposerValue = useCallback(
    (value: string) => {
      applyComposerValue(value, value.length);
    },
    [applyComposerValue]
  );

  const insertComposerInput = useCallback(
    (input: string) => {
      const current = composerRef.current;
      const cursor = composerCursorRef.current;
      applyComposerValue(insertTextAt(current, cursor, input), cursor + input.length);
    },
    [applyComposerValue]
  );

  const deleteComposerInput = useCallback(() => {
    const current = composerRef.current;
    const cursor = composerCursorRef.current;
    if (cursor <= 0) {
      return;
    }
    applyComposerValue(`${current.slice(0, cursor - 1)}${current.slice(cursor)}`, cursor - 1);
  }, [applyComposerValue]);

  const openWorkspaceCreator = useCallback(() => {
    setDialog(createWorkspaceDialog(currentWorkspace?.runtime ?? runtimes[0]?.name, runtimes));
  }, [currentWorkspace?.runtime, runtimes]);

  const sendComposer = useCallback(
    async (override?: string) => {
      const content = (override ?? composerRef.current).trim();
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
      if (content === "/memory" || content.startsWith("/memory ")) {
        setComposerValue("");
        await openMemoryDialog(content.slice("/memory".length));
        return;
      }
      setComposerValue("");
      let targetSession = currentSession;
      if (!targetSession) {
        if (!currentWorkspace) {
          setNotice({ level: "error", message: "Select a workspace first." });
          return;
        }
        try {
          targetSession = await createSessionForWorkspace(currentWorkspace, undefined, { noticePrefix: "Created" });
        } catch (error) {
          setError(error);
          return;
        }
      }
      const optimistic: ChatLine = {
        id: `pending:${Date.now()}`,
        role: "user",
        text: content,
        createdAt: new Date().toISOString()
      };
      setMessages((current) => [...current, optimistic]);
      try {
        const accepted = await client.sendMessage(targetSession.id, content);
        setNotice({ level: "info", message: `Queued run ${shortId(accepted.runId)}` });
        void refreshSession(targetSession);
      } catch (error) {
        setMessages((current) => current.filter((line) => line.id !== optimistic.id));
        setError(error);
      }
    },
    [client, createSessionForWorkspace, currentSession, currentWorkspace, openMemoryDialog, openWorkspaceCreator, refreshSession, setComposerValue, setError]
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
    systemProfile,
    workspaces,
    runtimes,
    currentWorkspace,
    catalog,
    sessions,
    sessionLatestRuns,
    currentSession,
    messages,
    runs,
    composer,
    composerCursor,
    slashSelection,
    askUserQuestionSelection,
    dialog,
    notice,
    streamState,
    setComposerCursor: setComposerCursorValue,
    setComposerValue,
    setSlashSelection,
    setAskUserQuestionSelection,
    setDialog,
    insertComposerInput,
    deleteComposerInput,
    refreshRuntimes,
    refreshWorkspaces,
    refreshCurrentWorkspaceSessions,
    openMemoryDialog,
    refreshMemoryDialog,
    readMemorySelection,
    applyMemoryProposalSelection,
    rejectMemoryProposalSelection,
    loadWorkspace,
    createWorkspace,
    createSession,
    selectSession,
    sendComposer
  };
}
