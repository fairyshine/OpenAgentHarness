import { startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  Activity,
  Bot,
  CircleSlash2,
  Folder,
  FolderPlus,
  Network,
  Orbit,
  RefreshCw,
  Send,
  Sparkles,
  Trash2
} from "lucide-react";

import type {
  Message,
  MessageAccepted,
  ModelGenerateResponse,
  Run,
  RunStep,
  Session,
  SessionEventContract,
  Workspace,
  WorkspaceCatalog,
  WorkspaceTemplateList
} from "@oah/api-contracts";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";

interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

interface WorkspaceDraft {
  name: string;
  template: string;
  rootPath: string;
}

interface SavedWorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  template?: string;
  status: Workspace["status"];
  lastOpenedAt: string;
}

interface SavedSessionRecord {
  id: string;
  workspaceId: string;
  title?: string;
  agentName?: string;
  createdAt: string;
  lastOpenedAt: string;
}

interface SessionDraft {
  title: string;
  agentName: string;
}

interface ModelDraft {
  model: string;
  prompt: string;
}

interface SseFrame {
  cursor?: string;
  event: string;
  data: Record<string, unknown>;
}

const storageKeys = {
  connection: "oah.web.connection",
  workspaceDraft: "oah.web.workspaceDraft",
  sessionDraft: "oah.web.sessionDraft",
  modelDraft: "oah.web.modelDraft",
  workspaceId: "oah.web.workspaceId",
  sessionId: "oah.web.sessionId",
  savedWorkspaces: "oah.web.savedWorkspaces",
  savedSessions: "oah.web.savedSessions",
  recentWorkspaces: "oah.web.recentWorkspaces",
  recentSessions: "oah.web.recentSessions"
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

function normalizeBaseUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/\/+$/u, "");
}

function buildUrl(baseUrl: string, path: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}${path}` : path;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) {
    return undefined as T;
  }

  return JSON.parse(raw) as T;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function addRecentId(list: string[], id: string) {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, 8);
}

function isTerminalRunEvent(event: string) {
  return event === "run.completed" || event === "run.failed" || event === "run.cancelled";
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function statusTone(status: string) {
  switch (status) {
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "running":
    case "waiting_tool":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "queued":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "cancelled":
      return "border-slate-200 bg-slate-100 text-slate-600";
    case "failed":
    case "timed_out":
      return "border-rose-200 bg-rose-50 text-rose-700";
    default:
      return "";
  }
}

async function consumeSse(
  response: Response,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("SSE response body is not readable.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let event = "message";
      let cursor: string | undefined;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("id:")) {
          cursor = line.slice(3).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      onFrame({
        event,
        data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
        ...(cursor ? { cursor } : {})
      });
    }
  }
}

export function App() {
  const [connection, setConnection] = usePersistentState<ConnectionSettings>(storageKeys.connection, {
    baseUrl: "",
    token: "debug-token"
  });
  const [workspaceDraft, setWorkspaceDraft] = usePersistentState<WorkspaceDraft>(storageKeys.workspaceDraft, {
    name: "debug-playground",
    template: "workspace",
    rootPath: ""
  });
  const [sessionDraft, setSessionDraft] = usePersistentState<SessionDraft>(storageKeys.sessionDraft, {
    title: "",
    agentName: ""
  });
  const [modelDraft, setModelDraft] = usePersistentState<ModelDraft>(storageKeys.modelDraft, {
    model: "",
    prompt: "你好，请简短回复一句话，确认模型链路已经接通。"
  });
  const [workspaceId, setWorkspaceId] = usePersistentState(storageKeys.workspaceId, "");
  const [sessionId, setSessionId] = usePersistentState(storageKeys.sessionId, "");
  const [savedWorkspaces, setSavedWorkspaces] = usePersistentState<SavedWorkspaceRecord[]>(storageKeys.savedWorkspaces, []);
  const [savedSessions, setSavedSessions] = usePersistentState<SavedSessionRecord[]>(storageKeys.savedSessions, []);
  const [recentWorkspaces, setRecentWorkspaces] = usePersistentState<string[]>(storageKeys.recentWorkspaces, []);
  const [recentSessions, setRecentSessions] = usePersistentState<string[]>(storageKeys.recentSessions, []);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SessionEventContract[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [draftMessage, setDraftMessage] = useState("你好，帮我简单确认一下当前 session 和 run 是否正常工作。");
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const [healthStatus, setHealthStatus] = useState("idle");
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "open" | "error">("idle");
  const [activity, setActivity] = useState("等待连接");
  const [errorMessage, setErrorMessage] = useState("");
  const [generateOutput, setGenerateOutput] = useState<ModelGenerateResponse | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [autoStream, setAutoStream] = useState(true);
  const [filterSelectedRun, setFilterSelectedRun] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const [sidebarMode, setSidebarMode] = useState<"workspaces" | "sessions">("workspaces");
  const [inspectorTab, setInspectorTab] = useState<"run" | "steps" | "events" | "catalog" | "model">("run");
  const [showSessionCreator, setShowSessionCreator] = useState(false);
  const [showWorkspaceCreator, setShowWorkspaceCreator] = useState(false);
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);

  const deferredEvents = useDeferredValue(events);
  const streamAbortRef = useRef<AbortController | null>(null);
  const lastCursorRef = useRef<string | undefined>(undefined);
  const messageRefreshTimerRef = useRef<number | undefined>(undefined);
  const runRefreshTimerRef = useRef<number | undefined>(undefined);
  const activeWorkspaceSessions = savedSessions.filter((entry) => entry.workspaceId === workspaceId);
  const selectedRunIdValue = selectedRunId.trim();
  const streamRunId = filterSelectedRun ? selectedRunIdValue : "";

  async function request<T>(path: string, init?: RequestInit, options?: { auth?: boolean }) {
    const headers = new Headers(init?.headers);
    const authRequired = options?.auth ?? true;

    if (authRequired) {
      const token = connection.token.trim();
      if (!token) {
        throw new Error("Bearer token 不能为空。");
      }

      headers.set("authorization", `Bearer ${token}`);
    }

    const response = await fetch(buildUrl(connection.baseUrl, path), {
      ...init,
      headers
    });

    if (!response.ok) {
      const body = await readJsonResponse<{ error?: { message?: string } }>(response).catch(() => undefined);
      throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    }

    return readJsonResponse<T>(response);
  }

  function rememberWorkspace(
    workspaceRecord: Workspace,
    options?: {
      template?: string;
    }
  ) {
    const now = new Date().toISOString();
    setSavedWorkspaces((current) => {
      const existing = current.find((entry) => entry.id === workspaceRecord.id);
      const nextRecord: SavedWorkspaceRecord = {
        id: workspaceRecord.id,
        name: workspaceRecord.name,
        rootPath: workspaceRecord.rootPath,
        status: workspaceRecord.status,
        lastOpenedAt: now
      };
      const templateValue = options?.template ?? existing?.template;
      if (templateValue) {
        nextRecord.template = templateValue;
      }

      return [
        nextRecord,
        ...current.filter((entry) => entry.id !== workspaceRecord.id)
      ].slice(0, 24);
    });
  }

  function rememberSession(sessionRecord: Session) {
    const now = new Date().toISOString();
    const nextRecord: SavedSessionRecord = {
      id: sessionRecord.id,
      workspaceId: sessionRecord.workspaceId,
      createdAt: sessionRecord.createdAt,
      lastOpenedAt: now
    };

    if (sessionRecord.title) {
      nextRecord.title = sessionRecord.title;
    }

    if (sessionRecord.activeAgentName) {
      nextRecord.agentName = sessionRecord.activeAgentName;
    }

    setSavedSessions((current) => [
      nextRecord,
      ...current.filter((entry) => entry.id !== sessionRecord.id)
    ].slice(0, 48));
  }

  function removeSavedWorkspace(workspaceToRemoveId: string) {
    setSavedWorkspaces((current) => current.filter((entry) => entry.id !== workspaceToRemoveId));
    setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== workspaceToRemoveId));
    setRecentWorkspaces((current) => current.filter((entry) => entry !== workspaceToRemoveId));

    if (workspaceId === workspaceToRemoveId) {
      setWorkspaceId("");
      setWorkspace(null);
      setCatalog(null);
      setSessionId("");
      setSession(null);
      setMessages([]);
      setEvents([]);
      setSelectedRunId("");
      setRun(null);
      setRunSteps([]);
      setLiveOutput({});
    }
  }

  function removeSavedSession(sessionToRemoveId: string) {
    setSavedSessions((current) => current.filter((entry) => entry.id !== sessionToRemoveId));
    setRecentSessions((current) => current.filter((entry) => entry !== sessionToRemoveId));

    if (sessionId === sessionToRemoveId) {
      setSessionId("");
      setSession(null);
      setMessages([]);
      setEvents([]);
      setSelectedRunId("");
      setRun(null);
      setRunSteps([]);
      setLiveOutput({});
    }
  }

  function scheduleMessagesRefresh() {
    window.clearTimeout(messageRefreshTimerRef.current);
    messageRefreshTimerRef.current = window.setTimeout(() => {
      void refreshMessages(true);
    }, 120);
  }

  function scheduleRunRefresh(runId: string) {
    window.clearTimeout(runRefreshTimerRef.current);
    runRefreshTimerRef.current = window.setTimeout(() => {
      void refreshRun(runId, true);
      void refreshRunSteps(runId, true);
    }, 140);
  }

  async function pingHealth() {
    try {
      setHealthStatus("checking");
      const response = await fetch(buildUrl(connection.baseUrl, "/healthz"));
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      setHealthStatus("ok");
      setActivity("服务健康检查通过");
      setErrorMessage("");
    } catch (error) {
      setHealthStatus("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshWorkspaceTemplates(quiet = false) {
    try {
      const response = await request<WorkspaceTemplateList>("/api/v1/workspace-templates");
      startTransition(() => {
        setWorkspaceTemplates(response.items.map((item) => item.name));
      });
      if (!quiet) {
        setActivity(`已加载 ${response.items.length} 个模板`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshWorkspace(targetId = workspaceId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const [workspaceResponse, catalogResponse] = await Promise.all([
        request<Workspace>(`/api/v1/workspaces/${targetId}`),
        request<WorkspaceCatalog>(`/api/v1/workspaces/${targetId}/catalog`)
      ]);

      startTransition(() => {
        setWorkspace(workspaceResponse);
        setCatalog(catalogResponse);
        setWorkspaceId(targetId);
        setRecentWorkspaces((current) => addRecentId(current, targetId));
      });
      rememberWorkspace(workspaceResponse);
      setActivity(`Workspace ${targetId} 已加载`);
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      setWorkspace(null);
      setCatalog(null);
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createWorkspace() {
    try {
      const created = await request<Workspace>("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: workspaceDraft.name.trim(),
          template: workspaceDraft.template.trim(),
          ...(workspaceDraft.rootPath.trim() ? { rootPath: workspaceDraft.rootPath.trim() } : {}),
          executionPolicy: "local"
        })
      });

      startTransition(() => {
        setWorkspaceId(created.id);
        setSelectedRunId("");
        setRun(null);
        setRunSteps([]);
        setSession(null);
        setSessionId("");
        setMessages([]);
        setEvents([]);
        setWorkspace(created);
        setRecentWorkspaces((current) => addRecentId(current, created.id));
      });
      rememberWorkspace(created, {
        template: workspaceDraft.template.trim()
      });
      lastCursorRef.current = undefined;
      setShowWorkspaceCreator(false);
      setSidebarMode("sessions");
      await refreshWorkspace(created.id, true);
      setActivity(`Workspace ${created.id} 已创建`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshSession(targetId = sessionId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const [sessionResponse, messagePage] = await Promise.all([
        request<Session>(`/api/v1/sessions/${targetId}`),
        request<{ items: Message[] }>(`/api/v1/sessions/${targetId}/messages?pageSize=200`)
      ]);

      startTransition(() => {
        setSession(sessionResponse);
        setSessionId(targetId);
        setMessages(messagePage.items);
        setRecentSessions((current) => addRecentId(current, targetId));
      });
      rememberSession(sessionResponse);
      if (workspaceId !== sessionResponse.workspaceId) {
        void refreshWorkspace(sessionResponse.workspaceId, true);
      }
      setActivity(`Session ${targetId} 已加载`);
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      setSession(null);
      setMessages([]);
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createSession() {
    if (!workspaceId.trim()) {
      setErrorMessage("请先创建或加载 workspace。");
      return;
    }

    try {
      const created = await request<Session>(`/api/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...(sessionDraft.title.trim() ? { title: sessionDraft.title.trim() } : {}),
          ...(sessionDraft.agentName.trim() ? { agentName: sessionDraft.agentName.trim() } : {})
        })
      });

      lastCursorRef.current = undefined;
      startTransition(() => {
        setEvents([]);
        setSelectedRunId("");
        setRun(null);
        setRunSteps([]);
        setLiveOutput({});
      });
      setShowSessionCreator(false);
      await refreshSession(created.id, true);
      rememberSession(created);
      setActivity(`Session ${created.id} 已创建`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshMessages(quiet = false) {
    if (!sessionId.trim()) {
      return;
    }

    try {
      const messagePage = await request<{ items: Message[] }>(`/api/v1/sessions/${sessionId}/messages?pageSize=200`);
      startTransition(() => {
        setMessages(messagePage.items);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshRun(targetId = selectedRunId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const runResponse = await request<Run>(`/api/v1/runs/${targetId}`);
      startTransition(() => {
        setRun(runResponse);
        setSelectedRunId(targetId);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshRunSteps(targetId = selectedRunId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const page = await request<{ items: RunStep[] }>(`/api/v1/runs/${targetId}/steps?pageSize=200`);
      startTransition(() => {
        setRunSteps(page.items);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function sendMessage() {
    if (!sessionId.trim()) {
      setErrorMessage("请先创建或加载 session。");
      return;
    }

    const content = draftMessage.trim();
    if (!content) {
      return;
    }

    try {
      const accepted = await request<MessageAccepted>(`/api/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          content
        })
      });

      startTransition(() => {
        setDraftMessage("");
        setSelectedRunId(accepted.runId);
        setLiveOutput((current) => ({
          ...current,
          [accepted.runId]: ""
        }));
      });
      if (autoStream) {
        setStreamRevision((current) => current + 1);
      }
      await Promise.all([refreshMessages(true), refreshRun(accepted.runId, true), refreshRunSteps(accepted.runId, true)]);
      setActivity(`消息已入队，run=${accepted.runId}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function cancelCurrentRun() {
    if (!selectedRunId.trim()) {
      return;
    }

    try {
      await request(`/api/v1/runs/${selectedRunId}/cancel`, {
        method: "POST"
      });
      await refreshRun(selectedRunId, true);
      setActivity(`已请求取消 run ${selectedRunId}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function generateOnce() {
    try {
      setGenerateBusy(true);
      const response = await request<ModelGenerateResponse>(
        "/internal/v1/models/generate",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            prompt: modelDraft.prompt.trim(),
            ...(modelDraft.model.trim() ? { model: modelDraft.model.trim() } : {})
          })
        },
        { auth: false }
      );
      setGenerateOutput(response);
      setActivity(`内部模型网关 generate 成功，model=${response.model}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setGenerateBusy(false);
    }
  }

  const handleSessionEvent = useEffectEvent((frame: SseFrame) => {
    const event = {
      id: frame.cursor ?? crypto.randomUUID(),
      cursor: frame.cursor ?? String(Date.now()),
      sessionId,
      runId: typeof frame.data.runId === "string" ? frame.data.runId : undefined,
      event: frame.event as SessionEventContract["event"],
      data: frame.data,
      createdAt: new Date().toISOString()
    } satisfies SessionEventContract;

    if (frame.cursor) {
      lastCursorRef.current = frame.cursor;
    }

    startTransition(() => {
      setEvents((current) => [event, ...current].slice(0, 200));
    });

    if (event.runId) {
      setSelectedRunId((current) => current || event.runId || "");
    }

    if (event.event === "message.delta" && typeof event.runId === "string" && typeof event.data.delta === "string") {
      setLiveOutput((current) => ({
        ...current,
        [event.runId!]: `${current[event.runId!] ?? ""}${event.data.delta as string}`
      }));
    }

    if (event.event === "message.completed" && typeof event.runId === "string") {
      setLiveOutput((current) => {
        const next = { ...current };
        delete next[event.runId!];
        return next;
      });
      scheduleMessagesRefresh();
      scheduleRunRefresh(event.runId);
    }

    if (
      typeof event.runId === "string" &&
      [
        "run.queued",
        "run.started",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "tool.started",
        "tool.completed",
        "tool.failed",
        "agent.switched",
        "agent.delegate.started",
        "agent.delegate.completed",
        "agent.delegate.failed"
      ].includes(event.event)
    ) {
      scheduleRunRefresh(event.runId);
    }

    if (typeof event.runId === "string" && event.runId === selectedRunIdValue && isTerminalRunEvent(event.event)) {
      streamAbortRef.current?.abort();
      setStreamState("idle");
    }

    setActivity(`${event.event}${event.runId ? ` · ${event.runId}` : ""}`);
  });

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      window.clearTimeout(messageRefreshTimerRef.current);
      window.clearTimeout(runRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    void refreshWorkspaceTemplates(true);
  }, [connection.baseUrl, connection.token]);

  useEffect(() => {
    if (!sessionId.trim() || !autoStream) {
      streamAbortRef.current?.abort();
      setStreamState("idle");
      return;
    }

    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    setStreamState("connecting");

    const query = new URLSearchParams();
    if (streamRunId) {
      query.set("runId", streamRunId);
    }
    if (lastCursorRef.current) {
      query.set("cursor", lastCursorRef.current);
    }

    void (async () => {
      try {
        const response = await fetch(
          buildUrl(connection.baseUrl, `/api/v1/sessions/${sessionId}/events${query.size > 0 ? `?${query.toString()}` : ""}`),
          {
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${connection.token.trim()}`
            }
          }
        );

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        setStreamState("open");
        await consumeSse(response, handleSessionEvent, controller.signal);
        if (!controller.signal.aborted) {
          setStreamState("idle");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setStreamState("error");
          setErrorMessage(toErrorMessage(error));
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    autoStream,
    connection.baseUrl,
    connection.token,
    filterSelectedRun,
    handleSessionEvent,
    streamRunId,
    sessionId,
    streamRevision
  ]);

  const messageFeed = [...messages];
  if (selectedRunId && liveOutput[selectedRunId]) {
    messageFeed.push({
      id: `live:${selectedRunId}`,
      sessionId: sessionId || "live",
      runId: selectedRunId,
      role: "assistant",
      content: liveOutput[selectedRunId],
      createdAt: new Date().toISOString()
    });
  }

  const currentWorkspaceName = workspace?.name ?? "No workspace";
  const currentSessionName = session?.title?.trim() || session?.id || "No session";
  const latestEvent = deferredEvents[0];

  return (
    <main className="min-h-screen px-3 py-3 md:px-5 md:py-5">
      <div className="mx-auto max-w-[1760px]">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-[color:var(--border)] bg-white/95 px-4 py-3 shadow-[0_12px_30px_rgba(15,15,15,0.04)]">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[color:var(--accent)] text-[color:var(--accent-foreground)]">
              <Bot className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold tracking-[-0.03em] text-[color:var(--foreground)]">Open Agent Harness</p>
              <p className="truncate text-xs text-[color:var(--muted-foreground)]">Workspace: {currentWorkspaceName}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-[#f6f6f3] text-[color:var(--foreground)]">{currentSessionName}</Badge>
            <StatusTile
              icon={Network}
              label="Health"
              value={healthStatus}
              tone={healthStatus === "ok" ? "emerald" : healthStatus === "error" ? "rose" : "sky"}
              compact
            />
            <StatusTile
              icon={Orbit}
              label="Stream"
              value={streamState}
              tone={streamState === "open" ? "emerald" : streamState === "error" ? "rose" : "sky"}
              compact
            />
          </div>
        </header>

        {errorMessage ? (
          <div className="mb-4 rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {errorMessage}
          </div>
        ) : null}

        <section className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className="xl:sticky xl:top-5 xl:h-[calc(100vh-2.5rem)]">
            <Card className="overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className="border-b border-[color:var(--border)] bg-[#fbfbf9] px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--foreground)]">Navigator</p>
                      <p className="text-xs text-[color:var(--muted-foreground)]">{savedWorkspaces.length} workspaces · {activeWorkspaceSessions.length} sessions</p>
                    </div>
                    <button
                      className="inline-flex h-9 items-center justify-center rounded-xl border border-[color:var(--border)] bg-white px-3 text-sm text-[color:var(--foreground)] transition hover:bg-[#f7f7f4]"
                      onClick={() => (sidebarMode === "workspaces" ? setShowWorkspaceCreator((current) => !current) : setShowSessionCreator((current) => !current))}
                    >
                      + New
                    </button>
                  </div>
                  <div className="mt-4 flex gap-2 rounded-2xl bg-[#f3f2ed] p-1">
                    <button
                      className={cn(
                        "flex-1 rounded-xl px-3 py-2 text-xs font-medium transition",
                        sidebarMode === "workspaces" ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
                      )}
                      onClick={() => setSidebarMode("workspaces")}
                    >
                      Workspaces
                    </button>
                    <button
                      className={cn(
                        "flex-1 rounded-xl px-3 py-2 text-xs font-medium transition",
                        sidebarMode === "sessions" ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
                      )}
                      onClick={() => setSidebarMode("sessions")}
                    >
                      Sessions
                    </button>
                  </div>
                </div>

                <div className="flex-1 space-y-3 overflow-auto px-3 py-3">
                  {sidebarMode === "workspaces" ? (
                    <>
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Workspace List</div>
                      {showWorkspaceCreator ? (
                        <div className="rounded-[20px] border border-[color:var(--border)] bg-[#f7f6f2] p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-[color:var(--foreground)]">New Workspace</p>
                            <button
                              className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                              onClick={() => setShowWorkspaceCreator(false)}
                            >
                              Close
                            </button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              value={workspaceDraft.name}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  name: event.target.value
                                }))
                              }
                              placeholder="Workspace name"
                            />
                            <Input
                              list="workspace-template-options"
                              value={workspaceDraft.template}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  template: event.target.value
                                }))
                              }
                              placeholder="Template"
                            />
                            <datalist id="workspace-template-options">
                              {workspaceTemplates.map((template) => (
                                <option key={template} value={template} />
                              ))}
                            </datalist>
                            <Input
                              value={workspaceDraft.rootPath}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  rootPath: event.target.value
                                }))
                              }
                              placeholder="Root path"
                            />
                            <div className="flex gap-2 pt-1">
                              <Button className="flex-1" onClick={() => void createWorkspace()}>
                                <FolderPlus className="h-4 w-4" />
                                Create
                              </Button>
                              <Button className="flex-1" variant="secondary" onClick={() => void refreshWorkspaceTemplates()}>
                                <RefreshCw className="h-4 w-4" />
                                Templates
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-1">
                        {savedWorkspaces.length === 0 ? (
                          <EmptyState title="No workspaces" description="Create or load one." />
                        ) : (
                          savedWorkspaces.map((entry) => (
                            <WorkspaceSidebarItem
                              key={entry.id}
                              entry={entry}
                              active={entry.id === workspaceId}
                              sessionCount={savedSessions.filter((sessionEntry) => sessionEntry.workspaceId === entry.id).length}
                              onSelect={() => {
                                setWorkspaceId(entry.id);
                                void refreshWorkspace(entry.id);
                              }}
                              onRemove={() => removeSavedWorkspace(entry.id)}
                            />
                          ))
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Session List</div>
                      {showSessionCreator ? (
                        <div className="rounded-[20px] border border-[color:var(--border)] bg-[#f7f6f2] p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-[color:var(--foreground)]">New Session</p>
                            <button
                              className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                              onClick={() => setShowSessionCreator(false)}
                            >
                              Close
                            </button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              value={sessionDraft.title}
                              onChange={(event) =>
                                setSessionDraft((current) => ({
                                  ...current,
                                  title: event.target.value
                                }))
                              }
                              placeholder="Session title"
                            />
                            <Input
                              value={sessionDraft.agentName}
                              onChange={(event) =>
                                setSessionDraft((current) => ({
                                  ...current,
                                  agentName: event.target.value
                                }))
                              }
                              placeholder="Agent"
                            />
                            <div className="flex gap-2 pt-1">
                              <Button className="flex-1" onClick={() => void createSession()}>
                                Create
                              </Button>
                              <Button className="flex-1" variant="secondary" onClick={() => void refreshSession()}>
                                Load
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-1">
                        {activeWorkspaceSessions.length === 0 ? (
                          <EmptyState title="No sessions" description="Select a workspace, then create one." />
                        ) : (
                          activeWorkspaceSessions.map((entry) => (
                            <SessionSidebarItem
                              key={entry.id}
                              entry={entry}
                              active={entry.id === sessionId}
                              onSelect={() => {
                                setSessionId(entry.id);
                                void refreshSession(entry.id);
                              }}
                              onRemove={() => removeSavedSession(entry.id)}
                            />
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="border-t border-[color:var(--border)] bg-[#fbfbf9] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToggleChip active={autoStream} label="Auto SSE" onClick={() => setAutoStream((current) => !current)} />
                    <ToggleChip active={filterSelectedRun} label="Current Run" onClick={() => setFilterSelectedRun((current) => !current)} />
                    <button
                      className="rounded-full border border-[color:var(--border)] bg-white px-3 py-1.5 text-xs font-medium text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                      onClick={() => setShowConnectionPanel((current) => !current)}
                    >
                      Server
                    </button>
                  </div>
                  {showConnectionPanel ? (
                    <div className="mt-3 space-y-2 rounded-[18px] border border-[color:var(--border)] bg-white p-3">
                      <Input
                        value={connection.baseUrl}
                        onChange={(event) =>
                          setConnection((current) => ({
                            ...current,
                            baseUrl: event.target.value
                          }))
                        }
                        placeholder="Base URL"
                      />
                      <Input
                        value={connection.token}
                        onChange={(event) =>
                          setConnection((current) => ({
                            ...current,
                            token: event.target.value
                          }))
                        }
                        placeholder="Bearer token"
                      />
                      <div className="flex gap-2">
                        <Button className="flex-1" variant="secondary" onClick={() => void pingHealth()}>
                          Health
                        </Button>
                        <Button className="flex-1" variant="ghost" onClick={() => setStreamRevision((current) => current + 1)}>
                          SSE
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
          </aside>

          <section className="xl:h-[calc(100vh-2.5rem)]">
            <Card className="overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className="border-b border-[color:var(--border)] bg-white/96 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h1 className="truncate text-[28px] font-semibold tracking-[-0.04em] text-[color:var(--foreground)]">Conversation</h1>
                      <p className="truncate text-sm text-[color:var(--muted-foreground)]">{currentSessionName} · {streamState}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-[#f6f6f3] text-[color:var(--foreground)]">{currentWorkspaceName}</Badge>
                      {latestEvent ? <Badge>{latestEvent.event}</Badge> : null}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-auto">
                  {messageFeed.length === 0 ? (
                    <div className="flex h-full items-center justify-center px-6 py-16">
                      <div className="max-w-md text-center">
                        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#f2f2ee] text-[color:var(--foreground)]">
                          <Bot className="h-5 w-5" />
                        </div>
                        <h2 className="text-2xl font-semibold tracking-[-0.04em] text-[color:var(--foreground)]">Ready to chat</h2>
                        <p className="mt-2 text-sm leading-7 text-[color:var(--muted-foreground)]">Select a workspace, open a session, and start the conversation.</p>
                      </div>
                    </div>
                  ) : (
                    messageFeed.map((message) => {
                      const isUser = message.role === "user";
                      const isStreaming = message.id.startsWith("live:");

                      return (
                        <article
                          key={message.id}
                          className={cn(
                            "border-t border-[color:var(--border)] transition-colors",
                            isUser ? "bg-[#f7f7f4]" : "bg-white"
                          )}
                        >
                          <div className="mx-auto grid max-w-3xl grid-cols-[44px_minmax(0,1fr)] gap-4 px-5 py-6 md:px-8">
                            <div
                              className={cn(
                                "flex h-11 w-11 items-center justify-center rounded-full text-sm font-semibold",
                                isUser ? "bg-[#e9e7df] text-[color:var(--foreground)]" : "bg-[color:var(--accent)] text-[color:var(--accent-foreground)]"
                              )}
                            >
                              {isUser ? "U" : "AI"}
                            </div>
                            <div className="min-w-0">
                              <div className="mb-3 flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-[color:var(--foreground)]">{isUser ? "You" : "Assistant"}</span>
                                {message.runId ? (
                                  <button
                                    className="rounded-full border border-[color:var(--border)] bg-white px-2.5 py-1 text-[11px] text-[color:var(--muted-foreground)] transition hover:border-black/10 hover:text-[color:var(--foreground)]"
                                    onClick={() => {
                                      setSelectedRunId(message.runId ?? "");
                                      setInspectorTab("run");
                                      void Promise.all([refreshRun(message.runId, true), refreshRunSteps(message.runId, true)]);
                                    }}
                                  >
                                    {message.runId}
                                  </button>
                                ) : null}
                                {isStreaming ? <span className="text-[11px] uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">Streaming</span> : null}
                                <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                              </div>
                              <pre className="whitespace-pre-wrap break-words text-[15px] leading-8 tracking-[-0.01em] text-[color:var(--foreground)]">{message.content}</pre>
                            </div>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>

                <div className="border-t border-[color:var(--border)] bg-white/96 px-4 py-4 md:px-6">
                  <div className="mx-auto max-w-3xl">
                    <div className="rounded-[26px] border border-[color:var(--border)] bg-[#fbfbf9] p-3 shadow-[0_10px_26px_rgba(15,15,15,0.05)]">
                      <Textarea
                        value={draftMessage}
                        onChange={(event) => setDraftMessage(event.target.value)}
                        placeholder="Message the current session"
                        className="min-h-28 border-0 bg-transparent px-1 py-1 shadow-none focus:ring-0"
                      />
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--muted-foreground)]">
                          <span>{selectedRunId ? `Run ${selectedRunId}` : "No run selected"}</span>
                          <span>{streamState}</span>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" onClick={() => void refreshMessages()}>
                            <RefreshCw className="h-4 w-4" />
                            Refresh
                          </Button>
                          <Button className="min-w-[92px]" onClick={() => void sendMessage()}>
                            <Send className="h-4 w-4" />
                            Send
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </section>

          <aside className="xl:sticky xl:top-5 xl:h-[calc(100vh-2.5rem)]">
            <Card className="overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className="border-b border-[color:var(--border)] bg-[#fbfbf9] px-4 py-4">
                  <p className="text-sm font-semibold text-[color:var(--foreground)]">Inspector</p>
                  <p className="text-xs text-[color:var(--muted-foreground)]">{activity}</p>
                  <div className="mt-4 flex flex-wrap gap-2 rounded-2xl bg-[#f3f2ed] p-1">
                    <InspectorTabButton label="Run" active={inspectorTab === "run"} onClick={() => setInspectorTab("run")} />
                    <InspectorTabButton label="Steps" active={inspectorTab === "steps"} onClick={() => setInspectorTab("steps")} />
                    <InspectorTabButton label="Events" active={inspectorTab === "events"} onClick={() => setInspectorTab("events")} />
                    <InspectorTabButton label="Catalog" active={inspectorTab === "catalog"} onClick={() => setInspectorTab("catalog")} />
                    <InspectorTabButton label="Model" active={inspectorTab === "model"} onClick={() => setInspectorTab("model")} />
                  </div>
                </div>

                <div className="flex-1 space-y-3 overflow-auto px-3 py-3">
                  {inspectorTab === "run" ? (
                    <>
                      <div className="space-y-2 rounded-[20px] border border-[color:var(--border)] bg-[#f7f6f2] p-3">
                        <Input
                          value={selectedRunId}
                          onChange={(event) => setSelectedRunId(event.target.value)}
                          placeholder="Selected run"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <Button variant="secondary" onClick={() => void refreshRun()}>
                            Load Run
                          </Button>
                          <Button variant="secondary" onClick={() => void refreshRunSteps()}>
                            Load Steps
                          </Button>
                        </div>
                        <Button variant="destructive" onClick={() => void cancelCurrentRun()}>
                          <CircleSlash2 className="h-4 w-4" />
                          Cancel Run
                        </Button>
                      </div>
                      {run ? <EntityPreview title={run.id} data={run} /> : <EmptyState title="No run" description="Pick a run from the conversation." />}
                    </>
                  ) : null}

                  {inspectorTab === "steps" ? (
                    runSteps.length === 0 ? (
                      <EmptyState title="No steps" description="Run steps appear here." />
                    ) : (
                      runSteps.map((step) => (
                        <article key={step.id} className="rounded-[18px] border border-[color:var(--border)] bg-white p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Badge>{step.seq}</Badge>
                            <Badge>{step.stepType}</Badge>
                            <Badge className={statusTone(step.status)}>{step.status}</Badge>
                            {step.name ? <Badge>{step.name}</Badge> : null}
                          </div>
                          <div className="space-y-2">
                            <JsonBlock title="Input" value={step.input ?? {}} />
                            <JsonBlock title="Output" value={step.output ?? {}} />
                          </div>
                        </article>
                      ))
                    )
                  ) : null}

                  {inspectorTab === "events" ? (
                    deferredEvents.length === 0 ? (
                      <EmptyState title="No events" description="SSE events appear here." />
                    ) : (
                      deferredEvents.map((event) => (
                        <article key={event.id} className="rounded-[18px] border border-[color:var(--border)] bg-white p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Badge>{event.event}</Badge>
                            {event.runId ? <Badge>{event.runId}</Badge> : null}
                            <span className="text-xs text-[color:var(--muted-foreground)]">cursor {event.cursor}</span>
                          </div>
                          <JsonBlock title={formatTimestamp(event.createdAt)} value={event.data} />
                        </article>
                      ))
                    )
                  ) : null}

                  {inspectorTab === "catalog" ? (
                    catalog ? (
                      <>
                        <div className="grid gap-2">
                          <CatalogLine label="agents" value={catalog.agents.length} />
                          <CatalogLine label="models" value={catalog.models.length} />
                          <CatalogLine label="actions" value={catalog.actions.length} />
                          <CatalogLine label="skills" value={catalog.skills.length} />
                          <CatalogLine label="mcp" value={catalog.mcp.length} />
                          <CatalogLine label="hooks" value={catalog.hooks.length} />
                          <CatalogLine label="nativeTools" value={catalog.nativeTools.length} />
                        </div>
                        <EntityPreview title={catalog.workspaceId} data={catalog} />
                      </>
                    ) : (
                      <EmptyState title="No catalog" description="Load a workspace first." />
                    )
                  ) : null}

                  {inspectorTab === "model" ? (
                    <div className="space-y-3">
                      <Input
                        value={modelDraft.model}
                        onChange={(event) =>
                          setModelDraft((current) => ({
                            ...current,
                            model: event.target.value
                          }))
                        }
                        placeholder="Model"
                      />
                      <Textarea
                        value={modelDraft.prompt}
                        onChange={(event) =>
                          setModelDraft((current) => ({
                            ...current,
                            prompt: event.target.value
                          }))
                        }
                        className="min-h-28"
                        placeholder="Prompt"
                      />
                      <Button onClick={() => void generateOnce()} disabled={generateBusy}>
                        <Sparkles className="h-4 w-4" />
                        Generate
                      </Button>
                      {generateOutput ? <EntityPreview title={generateOutput.model} data={generateOutput} /> : <EmptyState title="No output" description="Generate output appears here." />}
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
          </aside>
        </section>
      </div>
    </main>
  );
}

function WorkspaceSidebarItem(props: {
  entry: SavedWorkspaceRecord;
  active: boolean;
  sessionCount: number;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-[18px] px-3 py-3 transition",
        props.active ? "bg-[#f3f2ed] shadow-[inset_0_0_0_1px_rgba(28,28,28,0.04)]" : "hover:bg-[#f7f6f2]"
      )}
    >
      <div className={cn("absolute left-0 top-2 bottom-2 w-1 rounded-full transition", props.active ? "bg-[color:var(--accent)]" : "bg-transparent")} />
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full",
            props.active ? "bg-[color:var(--accent)] text-white" : "bg-[#eceae3] text-[color:var(--muted-foreground)]"
          )}
        >
          <Folder className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[color:var(--foreground)]">{props.entry.name}</p>
          <p className="truncate text-xs text-[color:var(--muted-foreground)]">
            {props.entry.template ? `${props.entry.template} · ` : ""}
            {props.sessionCount} sessions
          </p>
        </div>
      </button>
      <button
        className="rounded-lg p-2 text-[color:var(--muted-foreground)] opacity-0 transition hover:bg-black/4 hover:text-[color:var(--foreground)] group-hover:opacity-100"
        onClick={props.onRemove}
        title="从本地侧栏移除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function SessionSidebarItem(props: {
  entry: SavedSessionRecord;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-[18px] px-3 py-3 transition",
        props.active ? "bg-[#f3f2ed] shadow-[inset_0_0_0_1px_rgba(28,28,28,0.04)]" : "hover:bg-[#f7f6f2]"
      )}
    >
      <div className={cn("absolute left-0 top-2 bottom-2 w-1 rounded-full transition", props.active ? "bg-[color:var(--accent)]" : "bg-transparent")} />
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full",
            props.active ? "bg-[color:var(--accent)] text-white" : "bg-[#eceae3] text-[color:var(--muted-foreground)]"
          )}
        >
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[color:var(--foreground)]">{props.entry.title || "Untitled session"}</p>
          <p className="truncate text-xs text-[color:var(--muted-foreground)]">
            {props.entry.agentName ? `${props.entry.agentName} · ` : ""}
            {formatTimestamp(props.entry.lastOpenedAt)}
          </p>
        </div>
      </button>
      <button
        className="rounded-lg p-2 text-[color:var(--muted-foreground)] opacity-0 transition hover:bg-black/4 hover:text-[color:var(--foreground)] group-hover:opacity-100"
        onClick={props.onRemove}
        title="从本地侧栏移除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function ToggleChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-black/10 bg-black text-white"
          : "border-[color:var(--border)] bg-white/74 text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InspectorTabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-xl px-3 py-1.5 text-xs font-medium transition",
        props.active ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InsightRow(props: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] border border-[color:var(--border)] bg-[#f7f7f4] px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">{props.label}</p>
      <p className="mt-2 truncate text-sm font-medium text-[color:var(--foreground)]">{props.value}</p>
    </div>
  );
}

function EntityPreview(props: { title: string; data: unknown }) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-[color:var(--border)] bg-white/76">
      <div className="border-b border-[color:var(--border)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
        {props.title}
      </div>
      <pre className="max-h-72 overflow-auto p-4 text-xs leading-6 text-slate-700">{prettyJson(props.data)}</pre>
    </div>
  );
}

function JsonBlock(props: { title: string; value: unknown }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-[color:var(--border)] bg-[#fcfbf7]">
      <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
        {props.title}
      </div>
      <pre className="max-h-64 overflow-auto p-3 text-xs leading-6 text-slate-700">{prettyJson(props.value)}</pre>
    </div>
  );
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="rounded-[22px] border border-dashed border-[color:var(--border)] bg-[#f7f6f2] px-4 py-8 text-center">
      <p className="text-sm font-medium tracking-[-0.02em] text-[color:var(--foreground)]">{props.title}</p>
      <p className="mt-2 text-sm leading-6 text-[color:var(--muted-foreground)]">{props.description}</p>
    </div>
  );
}

function CatalogLine(props: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-[22px] border border-[color:var(--border)] bg-white/76 px-4 py-3 text-sm">
      <span className="text-[color:var(--muted-foreground)]">{props.label}</span>
      <span className="font-semibold text-[color:var(--foreground)]">{props.value}</span>
    </div>
  );
}

function StatusTile(props: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone: "sky" | "emerald" | "rose" | "amber";
  compact?: boolean;
}) {
  const colorClass =
    props.tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : props.tone === "rose"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : props.tone === "amber"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-sky-200 bg-sky-50 text-sky-700";

  const Icon = props.icon;

  if (props.compact) {
    return (
      <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs", colorClass)}>
        <Icon className="h-3.5 w-3.5" />
        <span className="uppercase tracking-[0.16em]">{props.label}</span>
        <span className="max-w-[120px] truncate font-medium normal-case tracking-normal">{props.value}</span>
      </div>
    );
  }

  return (
    <div className={cn("rounded-[22px] border px-4 py-3", colorClass)}>
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em]">
        <Icon className="h-4 w-4" />
        {props.label}
      </div>
      <div className="truncate text-sm font-medium">{props.value}</div>
    </div>
  );
}
