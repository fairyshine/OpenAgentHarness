import { startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react";

import type {
  Message,
  MessageAccepted,
  ModelGenerateResponse,
  Run,
  RunPage,
  RunStep,
  SessionEventContract
} from "@oah/api-contracts";

import {
  buildMessageRecord,
  buildUrl,
  consumeSse,
  downloadJsonFile,
  inferCompletedMessageRole,
  isNotFoundError,
  isTerminalRunEvent,
  isTerminalRunStatus,
  normalizeMessageContent,
  readJsonResponse,
  sanitizeFileSegment,
  storageKeys,
  toErrorMessage,
  upsertSessionMessage,
  usePersistentState,
  type ConnectionSettings,
  type HealthReportResponse,
  type InspectorTab,
  type MainViewMode,
  type ModelDraft,
  type PlatformModelListResponse,
  type PlatformModelRecord,
  type ModelProviderListResponse,
  type ModelProviderRecord,
  type ReadinessReportResponse,
  type SurfaceMode,
  type SseFrame
} from "./support";
import { buildAiSdkLikeRequest, buildAiSdkLikeStoredMessages } from "./primitives";
import { useNavigationActions } from "./use-navigation-actions";
import { buildRuntimeViewModel } from "./runtime-view-model";
import { useNavigationState } from "./use-navigation-state";
import { useStorageController } from "./use-storage-controller";
import { useWorkspaceFileManager } from "./use-workspace-file-manager";

export function useAppController() {
  const [connection, setConnection] = usePersistentState<ConnectionSettings>(storageKeys.connection, {
    baseUrl: "",
    token: ""
  });
  const [workspaceTemplateFilter, setWorkspaceTemplateFilter] = usePersistentState<string>(storageKeys.workspaceTemplateFilter, "");
  const [modelDraft, setModelDraft] = usePersistentState<ModelDraft>(storageKeys.modelDraft, {
    model: "",
    prompt: "你好，请简短回复一句话，确认模型链路已经接通。"
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SessionEventContract[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [sessionRuns, setSessionRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [draftMessage, setDraftMessage] = useState("");
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const [healthStatus, setHealthStatus] = useState("idle");
  const [healthReport, setHealthReport] = useState<HealthReportResponse | null>(null);
  const [readinessReport, setReadinessReport] = useState<ReadinessReportResponse | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderRecord[]>([]);
  const [platformModels, setPlatformModels] = useState<PlatformModelRecord[]>([]);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "listening" | "open" | "error">("idle");
  const [activity, setActivity] = useState("等待连接");
  const [errorMessage, setErrorMessage] = useState("");
  const [generateOutput, setGenerateOutput] = useState<ModelGenerateResponse | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [autoStream, setAutoStream] = useState(true);
  const [filterSelectedRun, setFilterSelectedRun] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("runtime");
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("conversation");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [selectedStepId, setSelectedStepId] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [timelineInspectorMode, setTimelineInspectorMode] = useState<"all" | "execution" | "messages" | "calls" | "steps" | "events">("all");
  const [pendingSessionAgentName, setPendingSessionAgentName] = useState<string | null>(null);
  const [switchingSessionAgentId, setSwitchingSessionAgentId] = useState<string | null>(null);
  const [pendingSessionModelRef, setPendingSessionModelRef] = useState<string | null>(null);
  const [switchingSessionModelId, setSwitchingSessionModelId] = useState<string | null>(null);
  const navigation = useNavigationState();
  const {
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
    mirrorStatus,
    setMirrorStatus,
    session,
    setSession,
    showWorkspaceCreator,
    setShowWorkspaceCreator,
    mirrorRebuildBusy,
    setMirrorRebuildBusy,
    workspaceManagementEnabled,
    setWorkspaceManagementEnabled,
    orderedSavedWorkspaces,
    sessionsByWorkspaceId,
    activeWorkspaceId,
    currentWorkspaceName,
    currentSessionName,
    hasActiveSession
  } = navigation;

  const deferredEvents = useDeferredValue(events);
  const streamAbortRef = useRef<AbortController | null>(null);
  const lastCursorRef = useRef<string | undefined>(undefined);
  const messageRefreshTimerRef = useRef<number | undefined>(undefined);
  const runRefreshTimerRef = useRef<number | undefined>(undefined);
  const workspaceIndexRefreshTimerRef = useRef<number | undefined>(undefined);
  const runPollingTimerRef = useRef<number | undefined>(undefined);
  const sessionAgentSwitchRef = useRef<{ sessionId: string; promise: Promise<boolean> } | null>(null);
  const sessionAgentSwitchSeqRef = useRef(0);
  const sessionModelUpdateRef = useRef<{ sessionId: string; promise: Promise<boolean> } | null>(null);
  const sessionModelUpdateSeqRef = useRef(0);
  const conversationThreadRef = useRef<HTMLDivElement | null>(null);
  const conversationTailRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowConversationRef = useRef(true);
  const selectedRunIdValue = selectedRunId.trim();
  const streamRunId = filterSelectedRun ? selectedRunIdValue : "";
  const workspaceTemplateFilterValue = workspaceTemplateFilter.trim();
  const workspaceTemplateFilterOptions = Array.from(
    new Set(
      [...workspaceTemplates, ...orderedSavedWorkspaces.map((entry) => entry.template ?? ""), workspaceTemplateFilterValue]
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
  const filteredSavedWorkspaces = workspaceTemplateFilterValue
    ? orderedSavedWorkspaces.filter((entry) => (entry.template ?? "").trim() === workspaceTemplateFilterValue)
    : orderedSavedWorkspaces;
  const filteredSavedSessionsCount = filteredSavedWorkspaces.reduce(
    (count, entry) => count + (sessionsByWorkspaceId.get(entry.id)?.length ?? 0),
    0
  );
  const runtimeViewModel = buildRuntimeViewModel({
    messages,
    runSteps,
    deferredEvents,
    liveOutput,
    selectedTraceId,
    selectedMessageId,
    selectedStepId,
    selectedEventId,
    sessionId
  });
  const {
    modelCallTraces,
    firstModelCallTrace,
    latestModelCallTrace,
    selectedModelCallTrace,
    composedSystemMessages,
    storedMessageCounts,
    latestModelMessageCounts,
    selectedSessionMessage,
    selectedMessageSystemMessages,
    selectedRunStep,
    selectedSessionEvent,
    allRuntimeToolNames,
    allAdvertisedToolNames,
    allRuntimeTools,
    allToolServers,
    resolvedModelNames,
    resolvedModelRefs,
    messageFeed
  } = runtimeViewModel;

  async function request<T>(path: string, init?: RequestInit, options?: { auth?: boolean }) {
    const headers = new Headers(init?.headers);
    const authRequired = options?.auth ?? true;
    const token = connection.token.trim();

    if (authRequired && token) {
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

  const storageController = useStorageController({
    connection,
    enabled: surfaceMode === "storage",
    healthReport,
    request,
    setActivity,
    setErrorMessage
  });
  const workspaceFileManager = useWorkspaceFileManager({
    connection,
    request,
    workspaceId: activeWorkspaceId,
    workspace: workspace,
    enabled: surfaceMode === "runtime" && mainViewMode === "conversation",
    setActivity,
    setErrorMessage
  });
  const navigationActions = useNavigationActions({
    request,
    setActivity,
    setErrorMessage,
    navigation: {
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
      setRecentSessions,
      expandedWorkspaceIds,
      setExpandedWorkspaceIds,
      setExpandedSessionIds,
      workspace,
      setWorkspace,
      setWorkspaceTemplates,
      setCatalog,
      setMirrorStatus,
      session,
      setSession,
      setShowWorkspaceCreator,
      setMirrorRebuildBusy,
      setWorkspaceManagementEnabled
    },
    runtime: {
      setMessages,
      setEvents,
      setSelectedRunId,
      setRun,
      setRunSteps,
      setLiveOutput,
      setStreamState,
      streamAbortRef,
      lastCursorRef,
      runPollingTimerRef
    }
  });

  function downloadSessionTrace() {
    const selectedOrLatestRunId = run?.id ?? (selectedRunIdValue || "latest");
    const latestRequest = buildAiSdkLikeRequest(latestModelCallTrace);
    const exportPayload = {
      format: "oah.ai-sdk-session.v2",
      exportedAt: new Date().toISOString(),
      basic: {
        workspace: workspace
          ? {
              id: workspace.id,
              name: workspace.name,
              kind: workspace.kind,
              rootPath: workspace.rootPath,
              readOnly: workspace.readOnly
            }
          : null,
        session: session
          ? {
              id: session.id,
              title: session.title ?? currentSessionName,
              workspaceId: session.workspaceId,
              modelRef: session.modelRef,
              agentName: session.agentName,
              activeAgentName: session.activeAgentName,
              status: session.status,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt
            }
          : null,
        run: run
          ? {
              id: run.id,
              sessionId: run.sessionId,
              parentRunId: run.parentRunId,
              agentName: run.agentName,
              effectiveAgentName: run.effectiveAgentName,
              status: run.status,
              startedAt: run.startedAt,
              heartbeatAt: run.heartbeatAt,
              endedAt: run.endedAt
            }
          : {
              id: selectedOrLatestRunId
            },
        model: latestRequest
          ? {
              model: latestRequest.model,
              canonicalModelRef: latestRequest.canonicalModelRef,
              provider: latestRequest.provider,
              ...(latestRequest.temperature !== undefined ? { temperature: latestRequest.temperature } : {}),
              ...(latestRequest.maxTokens !== undefined ? { maxTokens: latestRequest.maxTokens } : {})
            }
          : null
      },
      tools: latestRequest
        ? {
            definitions: latestRequest.tools,
            activeTools: latestRequest.activeTools,
            toolServers: latestRequest.toolServers
          }
        : {
            definitions: {},
            activeTools: [],
            toolServers: []
          },
      Messages: buildAiSdkLikeStoredMessages(messages)
    };

    const sessionSegment = sanitizeFileSegment(session?.title ?? session?.id ?? currentSessionName);
    const runSegment = sanitizeFileSegment(selectedOrLatestRunId);
    downloadJsonFile(`${sessionSegment}-${runSegment}-session.json`, exportPayload);
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

  function scheduleWorkspaceIndexRefresh() {
    window.clearTimeout(workspaceIndexRefreshTimerRef.current);
    workspaceIndexRefreshTimerRef.current = window.setTimeout(() => {
      void navigationActions.refreshWorkspaceIndex(true);
    }, 140);
  }

  async function pingHealth() {
    try {
      setHealthStatus("checking");
      const [healthResponse, readinessResponse] = await Promise.all([
        fetch(buildUrl(connection.baseUrl, "/healthz")),
        fetch(buildUrl(connection.baseUrl, "/readyz"))
      ]);

      if (!healthResponse.ok) {
        throw new Error(`${healthResponse.status} ${healthResponse.statusText}`);
      }

      const healthPayload = (await readJsonResponse<HealthReportResponse>(healthResponse)) ?? null;
      const readinessPayload = await readJsonResponse<ReadinessReportResponse>(readinessResponse).catch(() => null);

      setHealthReport(healthPayload);
      setReadinessReport(readinessPayload);
      setHealthStatus(healthPayload?.status ?? (readinessResponse.ok ? "ok" : "degraded"));
      setActivity(
        healthPayload?.status === "degraded" || readinessPayload?.status === "not_ready"
          ? "服务探针发现降级项"
          : "服务健康检查通过"
      );
      setErrorMessage("");
    } catch (error) {
      setHealthStatus("error");
      setHealthReport(null);
      setReadinessReport(null);
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshModelProviders(quiet = false) {
    try {
      const response = await request<ModelProviderListResponse>("/api/v1/model-providers");
      startTransition(() => {
        setModelProviders(response.items);
      });
      if (!quiet) {
        setActivity(`已加载 ${response.items.length} 个模型 provider`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshPlatformModels(quiet = false) {
    try {
      const response = await request<PlatformModelListResponse>("/api/v1/platform-models");
      startTransition(() => {
        setPlatformModels(response.items);
      });
      if (!quiet) {
        setActivity(`已加载 ${response.items.length} 个平台模型`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
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

  function sortRunSteps(items: RunStep[]) {
    return [...items].sort((left, right) => {
      const leftTime = left.endedAt ?? left.startedAt ?? "";
      const rightTime = right.endedAt ?? right.startedAt ?? "";
      if (leftTime !== rightTime) {
        return leftTime.localeCompare(rightTime);
      }

      if (left.runId !== right.runId) {
        return left.runId.localeCompare(right.runId);
      }

      if (left.seq !== right.seq) {
        return left.seq - right.seq;
      }

      return left.id.localeCompare(right.id);
    });
  }

  function mergeRunStepsForRun(current: RunStep[], targetRunId: string, nextItems: RunStep[]) {
    return sortRunSteps([...current.filter((step) => step.runId !== targetRunId), ...nextItems]);
  }

  async function refreshSessionRunStepsForRuns(runs: Run[], quiet = false) {
    if (runs.length === 0) {
      startTransition(() => {
        setRunSteps([]);
      });
      return;
    }

    try {
      const pages = await Promise.all(
        runs.map(async (sessionRun) => {
          const page = await request<{ items: RunStep[] }>(`/api/v1/runs/${sessionRun.id}/steps?pageSize=200`);
          return page.items;
        })
      );

      startTransition(() => {
        setRunSteps(sortRunSteps(pages.flatMap((items) => items)));
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

  async function refreshSessionRuns(quiet = false, options?: { includeSteps?: boolean }) {
    if (!sessionId.trim()) {
      return;
    }

    try {
      const page = await request<RunPage>(`/api/v1/sessions/${sessionId}/runs?pageSize=200`);
      startTransition(() => {
        setSessionRuns(page.items);
      });
      if (options?.includeSteps) {
        await refreshSessionRunStepsForRuns(page.items, true);
      }

      const activeSelectedRunId = selectedRunId.trim();
      const nextSelectedRun = page.items.find((item) => item.id === activeSelectedRunId) ?? page.items[0];
      if (nextSelectedRun && nextSelectedRun.id !== activeSelectedRunId) {
        startTransition(() => {
          setSelectedRunId(nextSelectedRun.id);
          setRun(nextSelectedRun);
        });
      } else if (!nextSelectedRun) {
        startTransition(() => {
          setSelectedRunId("");
          setRun(null);
          setRunSteps([]);
        });
      }

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
        setRunSteps((current) => mergeRunStepsForRun(current, targetId, page.items));
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

  useEffect(() => {
    setPendingSessionAgentName(null);
    setSwitchingSessionAgentId(null);
    sessionAgentSwitchRef.current = null;
    setPendingSessionModelRef(null);
    setSwitchingSessionModelId(null);
    sessionModelUpdateRef.current = null;
  }, [session?.id]);

  async function switchSessionAgent(targetId: string, activeAgentName: string) {
    const nextAgentName = activeAgentName.trim();
    if (!targetId.trim() || !nextAgentName) {
      return false;
    }

    const currentSession = session?.id === targetId ? session : null;
    const switchSeq = sessionAgentSwitchSeqRef.current + 1;
    sessionAgentSwitchSeqRef.current = switchSeq;
    setSwitchingSessionAgentId(targetId);
    if (currentSession) {
      setPendingSessionAgentName(nextAgentName);
      setSession({
        ...currentSession,
        activeAgentName: nextAgentName,
        updatedAt: new Date().toISOString()
      });
    }

    const switchPromise = navigationActions.switchSessionAgent(targetId, nextAgentName).then((updated) => updated !== null);
    sessionAgentSwitchRef.current = {
      sessionId: targetId,
      promise: switchPromise
    };

    try {
      const switched = await switchPromise;
      if (!switched) {
        if (currentSession) {
          setSession(currentSession);
        }
        return false;
      }

      if (sessionId === targetId) {
        await navigationActions.refreshSession(targetId, true);
        await refreshSessionRuns(true, { includeSteps: true });
      }

      return true;
    } finally {
      if (sessionAgentSwitchSeqRef.current === switchSeq) {
        sessionAgentSwitchRef.current = null;
        setSwitchingSessionAgentId(null);
        setPendingSessionAgentName(null);
      }
    }
  }

  async function updateSessionModel(targetId: string, modelRef: string | null) {
    if (!targetId.trim()) {
      return false;
    }

    const currentSession = session?.id === targetId ? session : null;
    const normalizedModelRef = modelRef?.trim() ? modelRef.trim() : null;
    const updateSeq = sessionModelUpdateSeqRef.current + 1;
    sessionModelUpdateSeqRef.current = updateSeq;
    setSwitchingSessionModelId(targetId);
    setPendingSessionModelRef(normalizedModelRef);
    if (currentSession) {
      setSession({
        ...currentSession,
        ...(normalizedModelRef ? { modelRef: normalizedModelRef } : {}),
        ...(normalizedModelRef === null ? { modelRef: undefined } : {}),
        updatedAt: new Date().toISOString()
      });
    }

    const updatePromise = navigationActions.updateSessionModel(targetId, normalizedModelRef).then((updated) => updated !== null);
    sessionModelUpdateRef.current = {
      sessionId: targetId,
      promise: updatePromise
    };

    try {
      const updated = await updatePromise;
      if (!updated) {
        if (currentSession) {
          setSession(currentSession);
        }
        return false;
      }

      if (sessionId === targetId) {
        await navigationActions.refreshSession(targetId, true);
      }

      return true;
    } finally {
      if (sessionModelUpdateSeqRef.current === updateSeq) {
        sessionModelUpdateRef.current = null;
        setSwitchingSessionModelId(null);
        setPendingSessionModelRef(null);
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
      const pendingAgentSwitch = sessionAgentSwitchRef.current;
      if (pendingAgentSwitch?.sessionId === sessionId) {
        const switched = await pendingAgentSwitch.promise;
        if (!switched) {
          return;
        }
      }

      const pendingModelUpdate = sessionModelUpdateRef.current;
      if (pendingModelUpdate?.sessionId === sessionId) {
        const updated = await pendingModelUpdate.promise;
        if (!updated) {
          return;
        }
      }

      shouldAutoFollowConversationRef.current = true;
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
      await Promise.all([
        refreshMessages(true),
        refreshSessionRuns(true, { includeSteps: true }),
        refreshRun(accepted.runId, true),
        refreshRunSteps(accepted.runId, true)
      ]);
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

  function syncCurrentSessionAgent(agentName: string, updatedAt: string) {
    const nextAgentName = agentName.trim();
    if (!sessionId.trim() || !nextAgentName) {
      return;
    }

    startTransition(() => {
      setSession((current) =>
        current?.id === sessionId
          ? {
              ...current,
              activeAgentName: nextAgentName,
              updatedAt
            }
          : current
      );
      setSavedSessions((current) =>
        current.map((entry) => (entry.id === sessionId ? { ...entry, agentName: nextAgentName } : entry))
      );
    });
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
      const messageId = typeof event.data.messageId === "string" ? event.data.messageId : undefined;
      const content = normalizeMessageContent(event.data.content);
      if (messageId && content !== null) {
        const completedMessage = buildMessageRecord({
          id: messageId,
          sessionId,
          runId: event.runId,
          role: inferCompletedMessageRole(event.data),
          content,
          createdAt: event.createdAt
        });
        if (!completedMessage) {
          return;
        }

        startTransition(() => {
          setMessages((current) => upsertSessionMessage(current, completedMessage));
        });
      }
      setLiveOutput((current) => {
        const next = { ...current };
        delete next[event.runId!];
        return next;
      });
      scheduleMessagesRefresh();
      scheduleRunRefresh(event.runId);
    }

    if (event.event === "agent.switched" && typeof event.data.toAgent === "string") {
      syncCurrentSessionAgent(event.data.toAgent, event.createdAt);
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
      void refreshSessionRuns(true);
      scheduleRunRefresh(event.runId);
    }

    if (event.event === "agent.delegate.started") {
      scheduleWorkspaceIndexRefresh();
    }

    if (typeof event.runId === "string" && isTerminalRunEvent(event.event)) {
      void navigationActions.refreshSession(sessionId, true);
      scheduleMessagesRefresh();
    }

    setActivity(`${event.event}${event.runId ? ` · ${event.runId}` : ""}`);
  });

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      window.clearTimeout(messageRefreshTimerRef.current);
      window.clearTimeout(runRefreshTimerRef.current);
      window.clearTimeout(workspaceIndexRefreshTimerRef.current);
      window.clearTimeout(runPollingTimerRef.current);
    };
  }, []);

  useEffect(() => {
    shouldAutoFollowConversationRef.current = true;
  }, [sessionId]);

  useEffect(() => {
    void navigationActions.refreshWorkspaceIndex(true);
    void navigationActions.refreshWorkspaceTemplates(true);
    void refreshModelProviders(true);
    void refreshPlatformModels(true);
  }, [connection.baseUrl, connection.token, sessionId, workspaceId]);

  useEffect(() => {
    if (sessionId.trim()) {
      void navigationActions.refreshSession(sessionId, true);
      void refreshSessionRuns(true, { includeSteps: true });
      return;
    }

    startTransition(() => {
      setSessionRuns([]);
      setRun(null);
      setRunSteps([]);
      setSelectedRunId("");
    });

    if (workspaceId.trim()) {
      void navigationActions.refreshWorkspace(workspaceId, true);
    }
  }, [connection.baseUrl, connection.token, sessionId, workspaceId]);

  useEffect(() => {
    if (!sessionId.trim() || !autoStream || session?.id !== sessionId) {
      streamAbortRef.current?.abort();
      setStreamState("idle");
      return;
    }

    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    setStreamState("connecting");
    const listeningTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        setStreamState((current) => (current === "connecting" ? "listening" : current));
      }
    }, 1200);

    const query = new URLSearchParams();
    if (streamRunId) {
      query.set("runId", streamRunId);
    }
    if (lastCursorRef.current) {
      query.set("cursor", lastCursorRef.current);
    }

    void (async () => {
      try {
        const headers = new Headers();
        const token = connection.token.trim();
        if (token) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const response = await fetch(
          buildUrl(connection.baseUrl, `/api/v1/sessions/${sessionId}/events${query.size > 0 ? `?${query.toString()}` : ""}`),
          {
            signal: controller.signal,
            headers
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
          if (isNotFoundError(error)) {
            navigationActions.clearSessionSelection(sessionId, { forgetSession: true });
            setActivity(`Session ${sessionId} 不存在，已清除本地选择`);
            setErrorMessage("");
            return;
          }
          setStreamState("error");
          setErrorMessage(toErrorMessage(error));
        }
      }
    })();

    return () => {
      window.clearTimeout(listeningTimer);
      controller.abort();
    };
  }, [
    autoStream,
    connection.baseUrl,
    connection.token,
    filterSelectedRun,
    session?.id,
    sessionId,
    streamRevision,
    streamRunId
  ]);

  useEffect(() => {
    window.clearTimeout(runPollingTimerRef.current);

    if (!sessionId.trim() || !selectedRunIdValue) {
      return;
    }

    if (run?.id === selectedRunIdValue && isTerminalRunStatus(run.status)) {
      return;
    }

    let cancelled = false;

    const pollRunSnapshot = async () => {
      try {
        const [nextRun, nextSteps, nextMessages] = await Promise.all([
          request<Run>(`/api/v1/runs/${selectedRunIdValue}`),
          request<{ items: RunStep[] }>(`/api/v1/runs/${selectedRunIdValue}/steps?pageSize=200`),
          request<{ items: Message[] }>(`/api/v1/sessions/${sessionId}/messages?pageSize=200`)
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setRun(nextRun);
          setSessionRuns((current) => {
            const next = [...current.filter((item) => item.id !== nextRun.id), nextRun];
            return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
          });
          setRunSteps((current) => mergeRunStepsForRun(current, selectedRunIdValue, nextSteps.items));
          setMessages(nextMessages.items);
        });

        const hasPersistedAssistant = nextMessages.items.some(
          (message) => message.runId === selectedRunIdValue && message.role === "assistant"
        );
        const shouldKeepPollingForCompletedMessage = nextRun.status === "completed" && !hasPersistedAssistant;

        if (!isTerminalRunStatus(nextRun.status) || shouldKeepPollingForCompletedMessage) {
          runPollingTimerRef.current = window.setTimeout(() => {
            void pollRunSnapshot();
          }, shouldKeepPollingForCompletedMessage ? 400 : 1000);
          return;
        }

        setLiveOutput((current) => {
          const next = { ...current };
          delete next[selectedRunIdValue];
          return next;
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        runPollingTimerRef.current = window.setTimeout(() => {
          void pollRunSnapshot();
        }, 1500);

        if (streamState === "error") {
          setErrorMessage(toErrorMessage(error));
        }
      }
    };

    runPollingTimerRef.current = window.setTimeout(() => {
      void pollRunSnapshot();
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(runPollingTimerRef.current);
    };
  }, [connection.baseUrl, connection.token, run?.id, run?.status, selectedRunIdValue, sessionId, streamState]);

  useEffect(() => {
    if (!shouldAutoFollowConversationRef.current) {
      return;
    }

    const thread = conversationThreadRef.current;
    const tail = conversationTailRef.current;
    if (!thread || !tail) {
      return;
    }

    window.requestAnimationFrame(() => {
      tail.scrollIntoView({ block: "end" });
    });
  }, [liveOutput, messageFeed.length, selectedRunIdValue]);

  const latestEvent = deferredEvents[0];
  const inspectorSubtitle =
    inspectorTab === "overview"
      ? "Session / run summary, quick controls, and raw records"
      : inspectorTab === "timeline"
        ? "Messages, model calls, steps, and events in one feed"
        : "Workspace controls, catalog inventory, and raw records";

  return {
    errorMessage,
    surfaceMode,
    headerProps: {
      surfaceMode,
      mainViewMode,
      setMainViewMode,
      hasActiveSession,
      currentSessionName,
      currentWorkspaceName,
      selectedRunId,
      latestEvent,
      storageHealthLabel: `${storageController.storageSurfaceProps.healthReport?.storage.primary ?? "unknown"} / ${storageController.storageSurfaceProps.healthReport?.storage.runQueue ?? "unknown"}`,
      mirrorHealthLabel: storageController.storageSurfaceProps.healthReport?.mirror
        ? `mirror ${storageController.storageSurfaceProps.healthReport.mirror.enabledWorkspaces}/${storageController.storageSurfaceProps.healthReport.mirror.errorWorkspaces}`
        : null,
      healthStatus,
      streamState,
      onSurfaceModeChange: setSurfaceMode
    },
    storageSurfaceProps: storageController.storageSurfaceProps,
    providerSurfaceProps: {
      connection,
      setConnection,
      pingHealth: () => void pingHealth(),
      setStreamRevision,
      healthStatus,
      healthReport,
      readinessReport,
      streamState,
      modelProviders,
      refreshModelProviders: () => void refreshModelProviders(),
      platformModels,
      refreshPlatformModels: () => void refreshPlatformModels(),
      modelDraft,
      setModelDraft,
      generateOnce: () => void generateOnce(),
      generateBusy,
      generateOutput
    },
    sidebarSurfaceProps: {
      surfaceMode,
      workspaceTemplateFilter,
      setWorkspaceTemplateFilter,
      workspaceTemplateFilterOptions,
      filteredSavedWorkspaces,
      orderedSavedWorkspaces,
      savedSessionsCount: filteredSavedSessionsCount,
      totalSavedSessionsCount: savedSessions.length,
      workspaceManagementEnabled,
      showWorkspaceCreator,
      setShowWorkspaceCreator,
      activeWorkspaceId,
      expandWorkspaceInSidebar: navigationActions.expandWorkspaceInSidebar,
      workspaceDraft,
      setWorkspaceDraft,
      workspaceTemplates,
      createWorkspace: () => void navigationActions.createWorkspace(),
      refreshWorkspaceTemplates: () => void navigationActions.refreshWorkspaceTemplates(),
      refreshWorkspaceIndex: () => void navigationActions.refreshWorkspaceIndex(),
      createSession: () => void navigationActions.createSession(),
      sessionId,
      refreshSessionById: (targetId: string) => void navigationActions.refreshSession(targetId),
      removeSavedSession: navigationActions.removeSavedSession,
      renameSession: (targetId: string, title: string) => void navigationActions.renameSession(targetId, title),
      sessionsByWorkspaceId,
      expandedWorkspaceIds,
      expandedSessionIds,
      openWorkspace: navigationActions.openWorkspace,
      toggleWorkspaceExpansion: navigationActions.toggleWorkspaceExpansion,
      toggleSessionExpansion: (targetId: string) =>
        setExpandedSessionIds((current) =>
          current.includes(targetId) ? current.filter((entry) => entry !== targetId) : [targetId, ...current].slice(0, 64)
        ),
      deleteWorkspace: (targetId: string) => void navigationActions.deleteWorkspace(targetId),
      autoStream,
      setAutoStream,
      filterSelectedRun,
      setFilterSelectedRun,
      storageOverview: storageController.storageSurfaceProps.storageOverview,
      storageBrowserTab: storageController.storageSurfaceProps.storageBrowserTab,
      onStorageBrowserTabChange: storageController.storageSurfaceProps.onStorageBrowserTabChange,
      onRefreshStorageOverview: storageController.storageSurfaceProps.onRefreshStorageOverview,
      selectedStorageTable: storageController.storageSurfaceProps.selectedStorageTable,
      onSelectStorageTable: storageController.storageSurfaceProps.onSelectStorageTable,
      storageTableSearch: storageController.storageSurfaceProps.storageTableSearch,
      onStorageTableSearchChange: storageController.storageSurfaceProps.onStorageTableSearchChange,
      storageTableWorkspaceId: storageController.storageSurfaceProps.storageTableWorkspaceId,
      onStorageTableWorkspaceIdChange: storageController.storageSurfaceProps.onStorageTableWorkspaceIdChange,
      storageTableSessionId: storageController.storageSurfaceProps.storageTableSessionId,
      onStorageTableSessionIdChange: storageController.storageSurfaceProps.onStorageTableSessionIdChange,
      storageTableRunId: storageController.storageSurfaceProps.storageTableRunId,
      onStorageTableRunIdChange: storageController.storageSurfaceProps.onStorageTableRunIdChange,
      onRefreshStorageTable: storageController.storageSurfaceProps.onRefreshStorageTable,
      onClearStorageTableFilters: storageController.storageSurfaceProps.onClearStorageTableFilters,
      redisKeyPattern: storageController.storageSurfaceProps.redisKeyPattern,
      onRedisKeyPatternChange: storageController.storageSurfaceProps.onRedisKeyPatternChange,
      redisKeyPage: storageController.storageSurfaceProps.redisKeyPage,
      selectedRedisKey: storageController.storageSurfaceProps.selectedRedisKey,
      onSelectRedisKey: storageController.storageSurfaceProps.onSelectRedisKey,
      onRefreshRedisKeys: storageController.storageSurfaceProps.onRefreshRedisKeys,
      storageBusy: storageController.storageSurfaceProps.storageBusy,
      connection,
      setConnection,
      pingHealth: () => void pingHealth(),
      refreshModelProviders: () => void refreshModelProviders(),
      platformModels,
      refreshPlatformModels: () => void refreshPlatformModels(),
      modelDraft,
      setModelDraft,
      setStreamRevision,
      healthStatus,
      healthReport,
      readinessReport,
      streamState,
      modelProviders
    },
    runtimeDetailSurfaceProps: {
      mainViewMode,
      setMainViewMode,
      setSurfaceMode,
      hasActiveSession,
      currentSessionName,
      currentWorkspaceName,
      inspectorSubtitle,
      latestEvent,
      inspectorTab,
      setInspectorTab,
      session,
      workspace,
      workspaceId,
      selectedRunId,
      sessionRuns,
      refreshSessionRuns: () => void refreshSessionRuns(false, { includeSteps: true }),
      setSelectedRunId,
      run,
      runSteps,
      deferredEvents,
      messageFeed,
      refreshRunById: (targetId: string) => void refreshRun(targetId, true),
      refreshRunStepsById: (targetId: string) => void refreshRunSteps(targetId, true),
      conversationThreadRef,
      conversationTailRef,
      shouldAutoFollowConversationRef,
      messages,
      draftMessage,
      setDraftMessage,
      refreshMessages: () => void refreshMessages(),
      sendMessage: () => void sendMessage(),
      refreshRun: () => void refreshRun(),
      refreshRunSteps: () => void refreshRunSteps(),
      cancelCurrentRun: () => void cancelCurrentRun(),
      modelCallTraces,
      latestModelCallTrace,
      firstModelCallTrace,
      composedSystemMessages,
      selectedSessionMessage,
      selectedMessageSystemMessages,
      setSelectedMessageId,
      selectedModelCallTrace,
      setSelectedTraceId,
      storedMessageCounts,
      latestModelMessageCounts,
      resolvedModelNames,
      resolvedModelRefs,
      allRuntimeTools,
      allRuntimeToolNames,
      allAdvertisedToolNames,
      allToolServers,
      downloadSessionTrace,
      timelineInspectorMode,
      setTimelineInspectorMode,
      selectedRunStep,
      setSelectedStepId,
      selectedSessionEvent,
      setSelectedEventId,
      catalog,
      pendingSessionAgentName,
      isSwitchingSessionAgent: switchingSessionAgentId === session?.id && pendingSessionAgentName !== null,
      switchSessionAgent: (targetId: string, activeAgentName: string) => void switchSessionAgent(targetId, activeAgentName),
      pendingSessionModelRef,
      isSwitchingSessionModel: switchingSessionModelId === session?.id,
      updateSessionModel: (targetId: string, modelRef: string | null) => void updateSessionModel(targetId, modelRef),
      mirrorStatus,
      mirrorRebuildBusy,
      refreshWorkspace: (targetId: string) => void navigationActions.refreshWorkspace(targetId, true),
      rebuildWorkspaceHistoryMirror: () => void navigationActions.rebuildWorkspaceHistoryMirror(),
      streamState,
      isRunning: !isTerminalRunStatus(run?.status) && run?.status != null,
      fileManager: workspaceFileManager.fileManagerSurfaceProps
    }
  };
}
