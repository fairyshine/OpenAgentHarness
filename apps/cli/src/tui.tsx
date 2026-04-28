import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { Message, Run, Session, SessionEventContract, Workspace } from "@oah/api-contracts";

import { OahApiClient, type OahConnection } from "./oah-api.js";

type Notice = {
  level: "info" | "error";
  message: string;
};

type ChatLine = {
  id: string;
  role: string;
  text: string;
  createdAt?: string;
  tone?: "normal" | "muted" | "error";
};

type Dialog =
  | { kind: "workspace-list"; selectedIndex: number }
  | { kind: "workspace-create"; draft: string }
  | { kind: "session-list"; selectedIndex: number }
  | { kind: "session-create"; draft: string }
  | { kind: "help" };

type VisibleWindow<T> = {
  items: T[];
  offset: number;
};

const STATUS_COLORS: Record<string, string> = {
  active: "green",
  archived: "yellow",
  closed: "yellow",
  disabled: "red",
  queued: "yellow",
  running: "cyan",
  waiting_tool: "magenta",
  completed: "green",
  failed: "red",
  cancelled: "yellow",
  timed_out: "red"
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SLASH_COMMANDS = [
  { command: "/workspace", description: "Switch workspace" },
  { command: "/session", description: "Switch session in current workspace" },
  { command: "/new-workspace", description: "Create workspace" },
  { command: "/new-session", description: "Create session" }
];

function useOahClient(connection: OahConnection) {
  return useMemo(() => new OahApiClient(connection), [connection.baseUrl, connection.token]);
}

function clampIndex(index: number, length: number) {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

function visibleWindow<T>(items: T[], selectedIndex: number, limit: number): VisibleWindow<T> {
  if (items.length <= limit) {
    return { items, offset: 0 };
  }
  const half = Math.floor(limit / 2);
  const offset = Math.max(0, Math.min(selectedIndex - half, items.length - limit));
  return {
    items: items.slice(offset, offset + limit),
    offset
  };
}

function shortId(id: string | undefined) {
  if (!id) {
    return "-";
  }
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function formatTime(value: string | undefined) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyPart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (isRecord(part)) {
          if (part.type === "text" && typeof part.text === "string") {
            return part.text;
          }
          if (part.type === "reasoning" && typeof part.text === "string") {
            return `[reasoning] ${part.text}`;
          }
          if (part.type === "tool-call" && typeof part.toolName === "string") {
            return `[tool-call] ${part.toolName}`;
          }
          if (part.type === "tool-result" && typeof part.toolName === "string") {
            return `[tool-result] ${part.toolName}`;
          }
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(value);
}

function messageToChatLine(message: Message): ChatLine {
  return {
    id: message.id,
    role: message.role,
    text: stringifyPart(message.content),
    createdAt: message.createdAt
  };
}

function eventChatLine(event: SessionEventContract): ChatLine | null {
  const toolName = typeof event.data.toolName === "string" ? event.data.toolName : undefined;
  const errorMessage = typeof event.data.errorMessage === "string" ? event.data.errorMessage : undefined;
  switch (event.event) {
    case "tool.started":
      return {
        id: `event:${event.id}`,
        role: "tool",
        text: toolName ? `Using ${toolName}` : "Using tool",
        createdAt: event.createdAt,
        tone: "muted"
      };
    case "tool.completed":
      return {
        id: `event:${event.id}`,
        role: "tool",
        text: toolName ? `Done ${toolName}` : "Tool completed",
        createdAt: event.createdAt,
        tone: "muted"
      };
    case "tool.failed":
      return {
        id: `event:${event.id}`,
        role: "tool",
        text: errorMessage ?? (toolName ? `Failed ${toolName}` : "Tool failed"),
        createdAt: event.createdAt,
        tone: "error"
      };
    case "agent.switched":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: typeof event.data.toAgent === "string" ? `Switched to ${event.data.toAgent}` : "Agent switched",
        createdAt: event.createdAt,
        tone: "muted"
      };
    case "run.failed":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: errorMessage ?? "Run failed",
        createdAt: event.createdAt,
        tone: "error"
      };
    case "run.cancelled":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: "Run cancelled",
        createdAt: event.createdAt,
        tone: "muted"
      };
    default:
      return null;
  }
}

function updateChatLinesFromEvent(lines: ChatLine[], event: SessionEventContract): ChatLine[] {
  const messageId = typeof event.data.messageId === "string" ? event.data.messageId : undefined;
  if (!messageId) {
    const line = eventChatLine(event);
    if (!line || lines.some((item) => item.id === line.id)) {
      return lines;
    }
    return [...lines, line];
  }

  if (event.event === "message.delta" && typeof event.data.delta === "string") {
    const existing = lines.find((line) => line.id === messageId);
    if (!existing) {
      return [
        ...lines,
        {
          id: messageId,
          role: "assistant",
          text: event.data.delta,
          createdAt: event.createdAt
        }
      ];
    }
    return lines.map((line) => (line.id === messageId ? { ...line, text: `${line.text}${event.data.delta}` } : line));
  }

  if (event.event === "message.completed" && event.data.content !== undefined) {
    const role = typeof event.data.role === "string" ? event.data.role : "assistant";
    const completed: ChatLine = {
      id: messageId,
      role,
      text: stringifyPart(event.data.content),
      createdAt: event.createdAt
    };
    return lines.some((line) => line.id === messageId)
      ? lines.map((line) => (line.id === messageId ? completed : line))
      : [...lines, completed];
  }

  return lines;
}

function parseWorkspaceDraft(draft: string) {
  const [namePart, runtimePart, rootPart] = draft.split("|").map((part) => part.trim());
  return {
    name: namePart ?? "",
    runtime: runtimePart || "local",
    rootPath: rootPart || undefined
  };
}

function StatusLine(props: { workspace: Workspace | null; session: Session | null; run: Run | null; notice: Notice; streamState: string }) {
  const runStatus = props.run ? props.run.status : "idle";
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color="cyan" bold>
            OAH
          </Text>{" "}
          <Text dimColor>{props.workspace?.name ?? "no workspace"}</Text>
        </Text>
        <Text dimColor>
          {props.session?.title ?? shortId(props.session?.id)} · {props.session?.activeAgentName ?? "no session"} · {runStatus} · {props.streamState}
        </Text>
      </Box>
      {props.notice.level === "error" ? (
        <Text color="red" wrap="truncate-end">
          {props.notice.message}
        </Text>
      ) : null}
    </Box>
  );
}

function Messages(props: { lines: ChatLine[]; session: Session | null; height: number }) {
  const visibleLines = props.lines.slice(-Math.max(4, props.height));
  if (!props.session) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor>Welcome. Press ctrl+w to choose a workspace, then ctrl+o to choose or create a session.</Text>
      </Box>
    );
  }

  if (visibleLines.length === 0) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor>Start typing. Enter sends. /workspace and /session open switchers.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={props.height} flexShrink={1} overflow="hidden">
      {visibleLines.map((line) => (
        <MessageRow key={line.id} line={line} />
      ))}
    </Box>
  );
}

function MessageRow(props: { line: ChatLine }) {
  if (props.line.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          ❯ <Text>{props.line.text}</Text>
        </Text>
      </Box>
    );
  }

  const color = props.line.tone === "error" ? "red" : props.line.role === "assistant" ? undefined : "gray";
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexShrink={0}>
        <Text dimColor>{"  "}⎿  </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"} wrap="wrap">
          {props.line.text}
        </Text>
      </Box>
    </Box>
  );
}

function PromptInput(props: { value: string; cursor: number; disabled?: boolean; running: boolean }) {
  const beforeCursor = props.value.slice(0, props.cursor);
  const afterCursor = props.value.slice(props.cursor);
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="row"
        alignItems="flex-start"
        borderStyle="round"
        borderColor={props.disabled ? "gray" : "cyan"}
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Text {...(props.disabled ? { color: "gray" } : {})} dimColor={Boolean(props.running || props.disabled)}>
          ❯{" "}
        </Text>
        {props.value ? (
          <Text wrap="truncate-end">
            {beforeCursor}
            {!props.disabled ? <Text inverse>{afterCursor[0] ?? " "}</Text> : null}
            {afterCursor.slice(1)}
          </Text>
        ) : (
          <Text dimColor>
            message OAH, or type /workspace{!props.disabled ? <Text inverse> </Text> : null}
          </Text>
        )}
      </Box>
      <PromptFooter {...(props.disabled === undefined ? {} : { disabled: props.disabled })} />
    </Box>
  );
}

function PromptFooter(props: { disabled?: boolean }) {
  const help = props.disabled ? "modal active" : "? for shortcuts";
  return (
    <Box paddingX={2}>
      <Text dimColor wrap="truncate-end">
        {help} · ctrl+w workspace · ctrl+o session · enter send · ctrl+c quit
      </Text>
    </Box>
  );
}

function SpinnerLine(props: { run: Run | null }) {
  const [frame, setFrame] = useState(0);
  const active = props.run?.status === "queued" || props.run?.status === "running" || props.run?.status === "waiting_tool";

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return null;
  }

  const verb = props.run?.status === "waiting_tool" ? "Waiting for tool" : props.run?.status === "queued" ? "Queued" : "Working";
  return (
    <Box marginTop={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
      <Text dimColor>
        {verb}… {shortId(props.run?.id)}
      </Text>
    </Box>
  );
}

function WorkspaceDialog(props: {
  dialog: Extract<Dialog, { kind: "workspace-list" | "workspace-create" }>;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  rows: number;
}) {
  if (props.dialog.kind === "workspace-create") {
    return (
      <DialogBox title="New Workspace" rows={props.rows}>
        <Text>Name | runtime | rootPath</Text>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <Text>{props.dialog.draft}</Text>
          <Text inverse> </Text>
        </Box>
        <Text dimColor>Example: demo | local | /srv/demo</Text>
        <Text dimColor>runtime defaults to local. Esc returns, enter creates.</Text>
      </DialogBox>
    );
  }
  const selectedIndex = props.dialog.selectedIndex;
  const limit = Math.max(6, props.rows - 5);
  const window = visibleWindow(props.workspaces, selectedIndex, limit);

  return (
      <DialogBox title={`Workspaces ${props.workspaces.length > 0 ? `${selectedIndex + 1}/${props.workspaces.length}` : ""}`} rows={props.rows}>
      {props.workspaces.length === 0 ? (
        <Text dimColor>No workspaces. Press n to create one.</Text>
      ) : (
        window.items.map((workspace, index) => {
          const absoluteIndex = window.offset + index;
          const selected = absoluteIndex === selectedIndex;
          const current = props.currentWorkspace?.id === workspace.id;
          const color = selected ? "cyan" : current ? "green" : STATUS_COLORS[workspace.status];
          return (
            <Text key={workspace.id} {...(color ? { color } : {})} bold={selected || current} wrap="truncate-end">
              {selected ? "❯" : current ? "•" : " "} {workspace.name} <Text dimColor>{shortId(workspace.id)}</Text> {workspace.kind}/
              {workspace.executionPolicy}/{workspace.readOnly ? "ro" : "rw"} <Text dimColor>{workspace.runtime ?? "runtime -"}</Text>{" "}
              <Text dimColor>{workspace.rootPath}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor>enter switch · n new · r refresh · esc close</Text>
    </DialogBox>
  );
}

function SessionDialog(props: {
  dialog: Extract<Dialog, { kind: "session-list" | "session-create" }>;
  sessions: Session[];
  currentSession: Session | null;
  workspace: Workspace | null;
  rows: number;
}) {
  if (props.dialog.kind === "session-create") {
    return (
      <DialogBox title="New Session" rows={props.rows}>
        <Text>Title optional</Text>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <Text>{props.dialog.draft}</Text>
          <Text inverse> </Text>
        </Box>
        <Text dimColor>Esc returns, enter creates for {props.workspace?.name ?? "current workspace"}.</Text>
      </DialogBox>
    );
  }
  const selectedIndex = props.dialog.selectedIndex;
  const limit = Math.max(6, props.rows - 5);
  const window = visibleWindow(props.sessions, selectedIndex, limit);

  return (
    <DialogBox title={`Sessions ${props.sessions.length > 0 ? `${selectedIndex + 1}/${props.sessions.length}` : ""}`} rows={props.rows}>
      {props.sessions.length === 0 ? (
        <Text dimColor>No sessions in this workspace. Press n to create one.</Text>
      ) : (
        window.items.map((session, index) => {
          const absoluteIndex = window.offset + index;
          const selected = absoluteIndex === selectedIndex;
          const current = props.currentSession?.id === session.id;
          const color = selected ? "cyan" : current ? "green" : STATUS_COLORS[session.status];
          return (
            <Text key={session.id} {...(color ? { color } : {})} bold={selected || current} wrap="truncate-end">
              {selected ? "❯" : current ? "•" : " "} {session.title ?? shortId(session.id)} <Text dimColor>{shortId(session.id)}</Text>{" "}
              {session.activeAgentName} {session.status} <Text dimColor>{formatTime(session.lastRunAt ?? session.updatedAt)}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor>enter switch · n new · r refresh · esc close</Text>
    </DialogBox>
  );
}

function HelpDialog(props: { rows: number }) {
  return (
    <DialogBox title="Shortcuts" rows={props.rows}>
      <Text>Enter sends the current prompt.</Text>
      <Text>ctrl+w opens workspace switcher.</Text>
      <Text>ctrl+o opens session switcher.</Text>
      <Text>? opens this help pane.</Text>
      <Text>Esc closes panes. j/k or arrows move selection.</Text>
      <Box marginTop={1} flexDirection="column">
        {SLASH_COMMANDS.map((item) => (
          <Text key={item.command}>
            <Text color="cyan">{item.command}</Text> <Text dimColor>{item.description}</Text>
          </Text>
        ))}
      </Box>
    </DialogBox>
  );
}

function DialogBox(props: { title: string; rows: number; children: React.ReactNode }) {
  const { columns } = useWindowSize();
  return (
    <Box flexDirection="column" width="100%" height={props.rows} flexShrink={0} overflow="hidden">
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          {"  "}
          {props.title}
        </Text>
        <Text dimColor>Esc close  </Text>
      </Box>
      <Box flexDirection="column" paddingX={2}>
        {props.children}
      </Box>
    </Box>
  );
}

function SlashSuggestions(props: { value: string }) {
  if (!props.value.startsWith("/") || props.value.includes(" ")) {
    return null;
  }
  const matches = SLASH_COMMANDS.filter((item) => item.command.startsWith(props.value)).slice(0, 4);
  if (matches.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" paddingX={2}>
      {matches.map((item, index) => (
        <Text key={item.command} {...(index === 0 ? { color: "cyan" } : {})} dimColor={index !== 0}>
          {index === 0 ? "❯" : " "} {item.command} <Text dimColor>{item.description}</Text>
        </Text>
      ))}
    </Box>
  );
}

function OahApp(props: { children: React.ReactNode }) {
  return <Box flexDirection="column">{props.children}</Box>;
}

function OahRepl({ connection }: { connection: OahConnection }) {
  const app = useApp();
  const client = useOahClient(connection);
  const { rows: height } = useWindowSize();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [events, setEvents] = useState<SessionEventContract[]>([]);
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
      const nextWorkspaces = await client.listAllWorkspaces();
      setWorkspaces(nextWorkspaces);
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
    async (draft: string) => {
      const parsed = parseWorkspaceDraft(draft);
      if (!parsed.name) {
        setNotice({ level: "error", message: "Workspace name is required." });
        return;
      }
      try {
        const workspace = await client.createWorkspace({
          name: parsed.name,
          runtime: parsed.runtime,
          ...(parsed.rootPath ? { rootPath: parsed.rootPath } : {})
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

  const insertComposerInput = useCallback((input: string) => {
    const cursor = composerCursor;
    setComposer((current) => {
      return `${current.slice(0, cursor)}${input}${current.slice(cursor)}`;
    });
    setComposerCursor(cursor + input.length);
  }, [composerCursor]);

  const deleteComposerInput = useCallback(() => {
    if (composerCursor <= 0) {
      return;
    }
    setComposer((current) => `${current.slice(0, composerCursor - 1)}${current.slice(composerCursor)}`);
    setComposerCursor((cursor) => Math.max(0, cursor - 1));
  }, [composerCursor]);

  const sendComposer = useCallback(async () => {
    const content = composer.trim();
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
      setDialog({ kind: "workspace-create", draft: "" });
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
  }, [client, composer, currentSession, refreshSession, setComposerValue, setError]);

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
    if (input === "c" && key.ctrl) {
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
      if (dialog.kind === "workspace-create" || dialog.kind === "session-create") {
        if (key.return) {
          if (dialog.kind === "workspace-create") {
            void createWorkspace(dialog.draft);
          } else {
            void createSession(dialog.draft);
          }
          return;
        }
        if (key.backspace || key.delete) {
          setDialog({ ...dialog, draft: dialog.draft.slice(0, -1) });
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setDialog({ ...dialog, draft: `${dialog.draft}${input}` });
        }
        return;
      }
      if (input === "n") {
        setDialog(dialog.kind === "workspace-list" ? { kind: "workspace-create", draft: "" } : { kind: "session-create", draft: "" });
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
      if (key.return) {
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

    if (input === "w" && key.ctrl) {
      setDialog({ kind: "workspace-list", selectedIndex: Math.max(0, workspaces.findIndex((item) => item.id === currentWorkspace?.id)) });
      return;
    }
    if (input === "o" && key.ctrl) {
      setDialog({ kind: "session-list", selectedIndex: Math.max(0, sessions.findIndex((item) => item.id === currentSession?.id)) });
      return;
    }
    if (input === "?") {
      setDialog({ kind: "help" });
      return;
    }
    if (key.return) {
      void sendComposer();
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
    if (key.backspace || key.delete) {
      deleteComposerInput();
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      insertComposerInput(input);
    }
  });

  const latestRun = runs[0] ?? null;
  const chromeRows = notice.level === "error" ? 6 : 5;
  const dialogRows = dialog ? Math.max(8, Math.min(Math.floor(height * 0.66), height - chromeRows - 3)) : 0;
  const transcriptHeight = Math.max(3, height - dialogRows - chromeRows);
  const activeDialog =
    dialog?.kind === "workspace-list" || dialog?.kind === "workspace-create" ? (
      <WorkspaceDialog dialog={dialog} workspaces={workspaces} currentWorkspace={currentWorkspace} rows={dialogRows} />
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
      <PromptInput value={composer} cursor={composerCursor} disabled={dialog !== null} running={latestRun?.status === "queued" || latestRun?.status === "running" || latestRun?.status === "waiting_tool"} />
    </Box>
  );
}

export function OahTui({ connection }: { connection: OahConnection }) {
  return (
    <OahApp>
      <OahRepl connection={connection} />
    </OahApp>
  );
}
