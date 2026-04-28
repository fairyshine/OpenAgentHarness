import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import type { Run, Session, SessionEventContract, Workspace, WorkspaceRuntime } from "@oah/api-contracts";

import { OahApiClient, type OahConnection } from "../api/oah-api.js";
import { HelpDialog, SessionDialog, WorkspaceDialog } from "./components/dialogs.js";
import { Messages, SpinnerLine, StatusLine } from "./components/messages.js";
import { PromptInput, SlashSuggestions } from "./components/prompt.js";
import type { ChatLine, Dialog, Notice, WorkspaceCreateDialog } from "./domain/types.js";
import {
  cleanControlInput,
  clampIndex,
  createWorkspaceDialog,
  cycleRuntime,
  hasRawControl,
  insertTextAt,
  isReturnInput,
  messageToChatLine,
  moveWorkspaceCreateField,
  shortId,
  SLASH_COMMANDS,
  updateChatLinesFromEvent
} from "./domain/utils.js";

function useOahClient(connection: OahConnection) {
  return useMemo(() => new OahApiClient(connection), [connection.baseUrl, connection.token]);
}

function OahApp(props: { children: React.ReactNode }) {
  return <Box flexDirection="column">{props.children}</Box>;
}

function OahRepl({ connection }: { connection: OahConnection }) {
  const app = useApp();
  const client = useOahClient(connection);
  const { rows: height } = useWindowSize();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [runtimes, setRuntimes] = useState<WorkspaceRuntime[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [, setEvents] = useState<SessionEventContract[]>([]);
  const [composer, setComposer] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice>({ level: "info", message: "Loading workspaces..." });
  const [streamState, setStreamState] = useState("idle");
  const lastCursorRef = useRef<string | undefined>(undefined);

  const setError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setNotice({ level: "error", message });
  }, []);

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
        setMessages(nextMessages.map(messageToChatLine));
        setRuns(nextRuns);
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
        setCurrentSession(null);
        setMessages([]);
        setRuns([]);
        setEvents([]);
        lastCursorRef.current = undefined;
        setNotice({ level: "info", message: `Loading ${workspace.name}...` });
        const nextSessions = await client.listWorkspaceSessions(workspace.id);
        setSessions(nextSessions);
        if (nextSessions[0]) {
          setCurrentSession(nextSessions[0]);
        }
        setDialog(null);
        setNotice({ level: "info", message: `Workspace ready: ${workspace.name}` });
      } catch (error) {
        setError(error);
      }
    },
    [client, setError]
  );

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
        setMessages([]);
        setRuns([]);
        setEvents([]);
        lastCursorRef.current = undefined;
        setDialog(null);
        setNotice({ level: "info", message: `Created session ${shortId(session.id)}` });
      } catch (error) {
        setError(error);
      }
    },
    [client, currentWorkspace, setError]
  );

  const setComposerValue = useCallback((value: string) => {
    setComposer(value);
    setComposerCursor(value.length);
  }, []);

  const insertComposerInput = useCallback(
    (input: string) => {
      const cursor = composerCursor;
      setComposer((current) => insertTextAt(current, cursor, input));
      setComposerCursor(cursor + input.length);
    },
    [composerCursor]
  );

  const deleteComposerInput = useCallback(() => {
    if (composerCursor <= 0) {
      return;
    }
    setComposer((current) => `${current.slice(0, composerCursor - 1)}${current.slice(composerCursor)}`);
    setComposerCursor((cursor) => Math.max(0, cursor - 1));
  }, [composerCursor]);

  const openWorkspaceCreator = useCallback(() => {
    setDialog(createWorkspaceDialog(currentWorkspace?.runtime ?? runtimes[0]?.name));
  }, [currentWorkspace?.runtime, runtimes]);

  const sendComposer = useCallback(
    async (override?: string) => {
      const content = (override ?? composer).trim();
      if (!content) {
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
        onEvent: (event) => {
          lastCursorRef.current = event.cursor || lastCursorRef.current;
          setStreamState("open");
          setEvents((current) => [...current.slice(-199), event]);
          setMessages((current) => updateChatLinesFromEvent(current, event));
          if (
            event.event === "run.queued" ||
            event.event === "run.started" ||
            event.event === "run.completed" ||
            event.event === "run.failed" ||
            event.event === "run.cancelled" ||
            event.event.startsWith("tool.")
          ) {
            void refreshSession(currentSession);
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
  }, [client, currentSession?.id, refreshSession, setError]);

  useInput((input, key) => {
    if ((input === "c" && key.ctrl) || hasRawControl(input, "\u0003")) {
      app.exit();
      return;
    }

    if (dialog) {
      if (key.escape) {
        if (dialog.kind === "workspace-create") {
          setDialog({ kind: "workspace-list", selectedIndex: 0 });
        } else if (dialog.kind === "session-create") {
          setDialog({ kind: "session-list", selectedIndex: 0 });
        } else {
          setDialog(null);
        }
        return;
      }
      if (dialog.kind === "help") {
        return;
      }
      if (dialog.kind === "workspace-create") {
        handleWorkspaceCreateInput({ input, key, dialog, client, runtimes, setDialog, setRuntimes, setError, createWorkspace });
        return;
      }
      if (dialog.kind === "session-create") {
        handleSessionCreateInput({ input, key, dialog, setDialog, createSession });
        return;
      }
      if (input === "n") {
        setDialog(dialog.kind === "workspace-list" ? createWorkspaceDialog(currentWorkspace?.runtime ?? runtimes[0]?.name) : { kind: "session-create", draft: "" });
        return;
      }
      if (input === "r") {
        if (dialog.kind === "workspace-list") {
          void refreshWorkspaces();
        } else if (currentWorkspace) {
          void client.listWorkspaceSessions(currentWorkspace.id).then(setSessions).catch(setError);
        }
        return;
      }
      if (key.downArrow || input === "j") {
        const length = dialog.kind === "workspace-list" ? workspaces.length : sessions.length;
        setDialog({ ...dialog, selectedIndex: clampIndex(dialog.selectedIndex + 1, length) });
        return;
      }
      if (key.upArrow || input === "k") {
        const length = dialog.kind === "workspace-list" ? workspaces.length : sessions.length;
        setDialog({ ...dialog, selectedIndex: clampIndex(dialog.selectedIndex - 1, length) });
        return;
      }
      if (isReturnInput(input, key)) {
        if (dialog.kind === "workspace-list") {
          const workspace = workspaces[dialog.selectedIndex];
          if (workspace) {
            void loadWorkspace(workspace);
          }
        } else {
          const session = sessions[dialog.selectedIndex];
          if (session) {
            setCurrentSession(session);
            setMessages([]);
            setRuns([]);
            setEvents([]);
            lastCursorRef.current = undefined;
            setDialog(null);
            setNotice({ level: "info", message: `Selected session ${shortId(session.id)}` });
          }
        }
      }
      return;
    }

    if ((input === "w" && key.ctrl) || hasRawControl(input, "\u0017")) {
      setDialog({ kind: "workspace-list", selectedIndex: Math.max(0, workspaces.findIndex((item) => item.id === currentWorkspace?.id)) });
      return;
    }
    if ((input === "o" && key.ctrl) || hasRawControl(input, "\u000f")) {
      setDialog({ kind: "session-list", selectedIndex: Math.max(0, sessions.findIndex((item) => item.id === currentSession?.id)) });
      return;
    }
    if (input === "?") {
      setDialog({ kind: "help" });
      return;
    }
    if (isReturnInput(input, key)) {
      const cleanInput = cleanControlInput(input);
      if (cleanInput) {
        const nextComposer = insertTextAt(composer, composerCursor, cleanInput);
        setComposerValue(nextComposer);
        void sendComposer(nextComposer);
      } else {
        void sendComposer();
      }
      return;
    }
    if (key.tab && composer.startsWith("/")) {
      const match = SLASH_COMMANDS.find((item) => item.command.startsWith(composer));
      if (match) {
        setComposerValue(match.command);
      }
      return;
    }
    if (key.leftArrow) {
      setComposerCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.rightArrow) {
      setComposerCursor((current) => Math.min(composer.length, current + 1));
      return;
    }
    if (input === "a" && key.ctrl) {
      setComposerCursor(0);
      return;
    }
    if (input === "e" && key.ctrl) {
      setComposerCursor(composer.length);
      return;
    }
    if ((input === "u" && key.ctrl) || hasRawControl(input, "\u0015")) {
      setComposerValue("");
      return;
    }
    if (key.backspace || key.delete) {
      deleteComposerInput();
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const cleanInput = cleanControlInput(input);
      if (cleanInput) {
        insertComposerInput(cleanInput);
      }
    }
  });

  const latestRun = runs[0] ?? null;
  const chromeRows = notice.level === "error" ? 6 : 5;
  const dialogRows = dialog ? Math.max(8, Math.min(Math.floor(height * 0.66), height - chromeRows - 3)) : 0;
  const transcriptHeight = Math.max(3, height - dialogRows - chromeRows);
  const activeDialog =
    dialog?.kind === "workspace-list" || dialog?.kind === "workspace-create" ? (
      <WorkspaceDialog dialog={dialog} workspaces={workspaces} currentWorkspace={currentWorkspace} runtimes={runtimes} rows={dialogRows} />
    ) : dialog?.kind === "session-list" || dialog?.kind === "session-create" ? (
      <SessionDialog dialog={dialog} sessions={sessions} currentSession={currentSession} workspace={currentWorkspace} rows={dialogRows} />
    ) : dialog?.kind === "help" ? (
      <HelpDialog rows={dialogRows} />
    ) : null;

  return (
    <Box flexDirection="column" height={height}>
      <StatusLine workspace={currentWorkspace} session={currentSession} run={latestRun} notice={notice} streamState={streamState} />
      <Box flexDirection="column" flexGrow={1}>
        <Messages lines={messages} session={currentSession} height={transcriptHeight} />
        <SpinnerLine run={latestRun} />
      </Box>
      {activeDialog}
      {!dialog ? <SlashSuggestions value={composer} /> : null}
      <PromptInput
        value={composer}
        cursor={composerCursor}
        disabled={dialog !== null}
        running={latestRun?.status === "queued" || latestRun?.status === "running" || latestRun?.status === "waiting_tool"}
      />
    </Box>
  );
}

function handleWorkspaceCreateInput(input: {
  input: string;
  key: { ctrl?: boolean; meta?: boolean; tab?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; backspace?: boolean; delete?: boolean; return?: boolean };
  dialog: WorkspaceCreateDialog;
  client: OahApiClient;
  runtimes: WorkspaceRuntime[];
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  setRuntimes: React.Dispatch<React.SetStateAction<WorkspaceRuntime[]>>;
  setError: (error: unknown) => void;
  createWorkspace: (draft: WorkspaceCreateDialog) => void;
}) {
  const { dialog, key } = input;
  if ((input.input === "u" && key.ctrl) || hasRawControl(input.input, "\u0015")) {
    input.setDialog({ ...dialog, [dialog.field]: "" });
    return;
  }
  if ((input.input === "r" && key.ctrl) || hasRawControl(input.input, "\u0012")) {
    void input.client.listWorkspaceRuntimes().then(input.setRuntimes).catch(input.setError);
    return;
  }
  if (key.tab || key.downArrow) {
    input.setDialog({ ...dialog, field: moveWorkspaceCreateField(dialog.field, 1) });
    return;
  }
  if (key.upArrow) {
    input.setDialog({ ...dialog, field: moveWorkspaceCreateField(dialog.field, -1) });
    return;
  }
  if (key.leftArrow && dialog.field === "runtime") {
    input.setDialog({ ...dialog, runtime: cycleRuntime(dialog.runtime, input.runtimes, -1) });
    return;
  }
  if (key.rightArrow && dialog.field === "runtime") {
    input.setDialog({ ...dialog, runtime: cycleRuntime(dialog.runtime, input.runtimes, 1) });
    return;
  }
  if (isReturnInput(input.input, key)) {
    const cleanInput = cleanControlInput(input.input);
    const nextDialog = dialog.field === "runtime" ? dialog : { ...dialog, [dialog.field]: `${dialog[dialog.field]}${cleanInput}` };
    input.createWorkspace(nextDialog);
    return;
  }
  if (key.backspace || key.delete) {
    if (dialog.field !== "runtime") {
      input.setDialog({ ...dialog, [dialog.field]: dialog[dialog.field].slice(0, -1) });
    }
    return;
  }
  if (input.input && !key.ctrl && !key.meta) {
    const cleanInput = cleanControlInput(input.input);
    if (cleanInput && dialog.field !== "runtime") {
      input.setDialog({ ...dialog, [dialog.field]: `${dialog[dialog.field]}${cleanInput}` });
    }
  }
}

function handleSessionCreateInput(input: {
  input: string;
  key: { ctrl?: boolean; meta?: boolean; backspace?: boolean; delete?: boolean; return?: boolean };
  dialog: Extract<Dialog, { kind: "session-create" }>;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  createSession: (title?: string) => void;
}) {
  if ((input.input === "u" && input.key.ctrl) || hasRawControl(input.input, "\u0015")) {
    input.setDialog({ ...input.dialog, draft: "" });
    return;
  }
  if (isReturnInput(input.input, input.key)) {
    input.createSession(`${input.dialog.draft}${cleanControlInput(input.input)}`);
    return;
  }
  if (input.key.backspace || input.key.delete) {
    input.setDialog({ ...input.dialog, draft: input.dialog.draft.slice(0, -1) });
    return;
  }
  if (input.input && !input.key.ctrl && !input.key.meta) {
    const cleanInput = cleanControlInput(input.input);
    if (cleanInput) {
      input.setDialog({ ...input.dialog, draft: `${input.dialog.draft}${cleanInput}` });
    }
  }
}

export function OahTui({ connection }: { connection: OahConnection }) {
  return (
    <OahApp>
      <OahRepl connection={connection} />
    </OahApp>
  );
}
