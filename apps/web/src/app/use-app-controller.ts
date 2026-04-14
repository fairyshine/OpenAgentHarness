import { startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  healthReportSchema,
  readinessReportSchema,
  type Message,
  type MessageAccepted,
  type ModelGenerateResponse,
  type Run,
  type RunPage,
  type RunStep,
  type SessionEventContract
} from "@oah/api-contracts";

import {
  buildRuntimeConsoleEntries,
  buildMessageRecord,
  buildUrl,
  contentToolRefs,
  consumeSse,
  createHttpRequestError,
  downloadJsonFile,
  hasDisplayableRunMessages,
  inferCompletedMessageRole,
  isNotFoundError,
  isRecord,
  isTerminalRunEvent,
  isTerminalRunStatus,
  normalizeMessageContent,
  readJsonResponse,
  sanitizeFileSegment,
  storageKeys,
  toErrorSummary,
  toErrorMessage,
  upsertSessionMessage,
  usePersistentState,
  type AppRequestErrorSummary,
  type ConsoleFilter,
  type ConnectionSettings,
  type HealthReportResponse,
  type InspectorTab,
  type LiveConversationMessageRecord,
  type MainViewMode,
  type ModelDraft,
  type PlatformModelListResponse,
  type PlatformModelRecord,
  type ModelProviderListResponse,
  type ModelProviderRecord,
  type ReadinessReportResponse,
  type RuntimeConsoleEntry,
  type SurfaceMode,
  type PlatformModelSnapshotResponse,
  type SseFrame
} from "./support";
import { buildAiSdkLikeRequest, buildAiSdkLikeStoredMessages } from "./primitives";
import { useNavigationActions } from "./use-navigation-actions";
import { buildRuntimeViewModel } from "./runtime-view-model";
import { useNavigationState } from "./use-navigation-state";
import { useStorageController } from "./use-storage-controller";
import { useWorkspaceFileManager } from "./use-workspace-file-manager";

const COMPLETED_RUN_RESULT_POLL_LIMIT = 5;

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
  const [liveMessagesByKey, setLiveMessagesByKey] = useState<Record<string, LiveConversationMessageRecord>>({});
  const [healthStatus, setHealthStatus] = useState("idle");
  const [healthReport, setHealthReport] = useState<HealthReportResponse | null>(null);
  const [readinessReport, setReadinessReport] = useState<ReadinessReportResponse | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderRecord[]>([]);
  const [platformModels, setPlatformModels] = useState<PlatformModelRecord[]>([]);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "listening" | "open" | "error">("idle");
  const [activity, setActivity] = useState("等待连接");
  const [errorMessage, setErrorMessage] = useState("");
  const [activeError, setActiveError] = useState<AppRequestErrorSummary | null>(null);
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
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(280);
  const [consoleFilter, setConsoleFilter] = useState<ConsoleFilter>("all");
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
  } = navigation;

  const deferredEvents = useDeferredValue(events);
  const completedRunResultPollsRef = useRef<Record<string, number>>({});
  const streamAbortRef = useRef<AbortController | null>(null);
  const platformModelStreamAbortRef = useRef<AbortController | null>(null);
  const lastCursorRef = useRef<string | undefined>(undefined);
  const messageRefreshTimerRef = useRef<number | undefined>(undefined);
  const runRefreshTimerRef = useRef<number | undefined>(undefined);
  const workspaceIndexRefreshTimerRef = useRef<number | undefined>(undefined);
  const runPollingTimerRef = useRef<number | undefined>(undefined);
  const platformModelReconnectTimerRef = useRef<number | undefined>(undefined);
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
    liveMessagesByKey,
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
  const consoleEntries = buildRuntimeConsoleEntries(events, activeError);

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
      throw await createHttpRequestError(response);
    }

    return readJsonResponse<T>(response);
  }

  const clearActiveError = useEffectEvent(() => {
    setErrorMessage("");
    setActiveError(null);
  });

  const reportError = useEffectEvent((error: unknown) => {
    const nextMessage = toErrorMessage(error);
    const summary = toErrorSummary(error);
    setErrorMessage(nextMessage);
    setActiveError(summary ? { ...summary, message: nextMessage } : { message: nextMessage, timestamp: new Date().toISOString() });
  });

  const openConsoleForErrors = useEffectEvent(() => {
    setConsoleOpen(true);
    setConsoleFilter("errors");
  });

  useEffect(() => {
    if (!errorMessage) {
      setActiveError(null);
      return;
    }

    setActiveError((current) =>
      current?.message === errorMessage ? current : { message: errorMessage, timestamp: new Date().toISOString() }
    );
  }, [errorMessage]);

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
    connection,
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
      session,
      setSession,
      setShowWorkspaceCreator,
      setWorkspaceManagementEnabled
    },
    runtime: {
      setMessages,
      setEvents,
      setSelectedRunId,
      setRun,
      setRunSteps,
      setLiveMessagesByKey,
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

      const healthPayload = healthReportSchema.parse((await readJsonResponse<HealthReportResponse>(healthResponse)) ?? null);
      const readinessPayload = await readJsonResponse<ReadinessReportResponse>(readinessResponse)
        .then((payload) => (payload ? readinessReportSchema.parse(payload) : null))
        .catch(() => null);

      setHealthReport(healthPayload);
      setReadinessReport(readinessPayload);
      setHealthStatus(healthPayload?.status ?? (readinessResponse.ok ? "ok" : "degraded"));
      setActivity(
        healthPayload?.status === "degraded" || readinessPayload?.status === "not_ready"
          ? "服务探针发现降级项"
          : "服务健康检查通过"
      );
      clearActiveError();
    } catch (error) {
      setHealthStatus("error");
      setHealthReport(null);
      setReadinessReport(null);
      reportError(error);
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
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
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
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
      }
    }
  }

  const handlePlatformModelSnapshot = useEffectEvent((snapshot: PlatformModelSnapshotResponse, quiet = false) => {
    startTransition(() => {
      setPlatformModels(snapshot.items);
    });
    if (!quiet) {
      setActivity(`平台模型已热更新，当前 ${snapshot.items.length} 个`);
    }
  });

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
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
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
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
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
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
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
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
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
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
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
      reportError("请先创建或加载 session。");
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
      clearActiveError();
    } catch (error) {
      reportError(error);
      openConsoleForErrors();
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
      clearActiveError();
    } catch (error) {
      reportError(error);
      openConsoleForErrors();
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
      clearActiveError();
    } catch (error) {
      reportError(error);
      openConsoleForErrors();
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
      setEvents((current) => [event, ...current].slice(0, 5000));
    });

    if (event.runId) {
      setSelectedRunId((current) => current || event.runId || "");
    }

    const eventMessageId = typeof event.data.messageId === "string" ? event.data.messageId : undefined;
    const eventMetadata = isRecord(event.data.metadata) ? event.data.metadata : undefined;
    const eventToolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
    const eventToolName = typeof event.data.toolName === "string" ? event.data.toolName : undefined;

    const normalizeToolCallInput = (value: unknown): Record<string, unknown> | undefined => {
      if (isRecord(value)) {
        return value;
      }

      if (value === undefined) {
        return undefined;
      }

      return {
        value
      };
    };

    const normalizeToolResultOutput = (value: unknown, failed: boolean, fallback?: string) => {
      if (isRecord(value) && typeof value.type === "string") {
        return value;
      }

      if (typeof value === "string") {
        return {
          type: failed ? "error-text" : "text",
          value
        };
      }

      if (value === undefined) {
        return {
          type: failed ? "error-text" : "text",
          value: fallback ?? (failed ? "Tool execution failed." : "")
        };
      }

      return {
        type: failed ? "error-json" : "json",
        value
      };
    };

    const upsertLiveToolMessage = (input: {
      key: string;
      role: "assistant" | "tool";
      content: Message["content"];
      createdAt: string;
      metadata?: Record<string, unknown>;
      toolCallId?: string;
    }) => {
      setLiveMessagesByKey((current) => {
        const existingEntry = current[input.key];
        return {
          ...current,
          [input.key]: {
            ...(existingEntry?.persistedMessageId ? { persistedMessageId: existingEntry.persistedMessageId } : {}),
            ...(() => {
              const toolCallId = input.toolCallId ?? existingEntry?.toolCallId;
              return toolCallId ? { toolCallId } : {};
            })(),
            runId: event.runId ?? "",
            sessionId,
            role: input.role,
            content: input.content,
            ...(() => {
              const metadata = {
                ...(isRecord(existingEntry?.metadata) ? existingEntry.metadata : {}),
                ...(eventMetadata ?? {}),
                ...(input.metadata ?? {})
              };
              return Object.keys(metadata).length > 0 ? { metadata } : {};
            })(),
            createdAt: existingEntry?.createdAt ?? input.createdAt
          }
        };
      });
    };

    if (
      event.event === "message.delta" &&
      typeof event.runId === "string" &&
      typeof eventMessageId === "string" &&
      typeof event.data.delta === "string"
    ) {
      const runId = event.runId;
      const liveMessageKey = `message:${eventMessageId}`;
      const needsMessageHydration =
        !liveMessagesByKey[liveMessageKey] &&
        !messages.some((message) => message.id === eventMessageId);
      setLiveMessagesByKey((current) => ({
        ...current,
        [liveMessageKey]: {
          persistedMessageId: eventMessageId,
          runId,
          sessionId,
          role: "assistant",
          content: `${typeof current[liveMessageKey]?.content === "string" ? current[liveMessageKey].content : ""}${event.data.delta}`,
          ...(() => {
            const metadata = current[liveMessageKey]?.metadata ?? eventMetadata;
            return metadata ? { metadata } : {};
          })(),
          createdAt: current[liveMessageKey]?.createdAt ?? event.createdAt
        }
      }));
      if (needsMessageHydration) {
        scheduleMessagesRefresh();
      }
    }

    if (event.event === "tool.started" && typeof event.runId === "string" && eventToolCallId && eventToolName) {
      const toolCallContent = normalizeMessageContent([
        {
          type: "tool-call",
          toolCallId: eventToolCallId,
          toolName: eventToolName,
          input: normalizeToolCallInput(event.data.input) ?? {}
        }
      ]);
      if (toolCallContent !== null) {
        const toolCallMessage = buildMessageRecord({
          id: `live-tool-call:${eventToolCallId}`,
          sessionId,
          runId: event.runId,
          role: "assistant",
          content: toolCallContent,
          ...(eventMetadata ? { metadata: eventMetadata } : {}),
          createdAt: event.createdAt
        });
        if (toolCallMessage) {
          upsertLiveToolMessage({
            key: `tool-call:${eventToolCallId}`,
            role: "assistant",
            content: toolCallMessage.content,
            createdAt: event.createdAt,
            metadata: {
              toolStatus: "running",
              ...(typeof event.data.sourceType === "string" ? { toolSourceType: event.data.sourceType } : {})
            },
            toolCallId: eventToolCallId
          });
        }
      }
    }

    if (
      (event.event === "tool.completed" || event.event === "tool.failed") &&
      typeof event.runId === "string" &&
      eventToolCallId &&
      eventToolName
    ) {
      const toolResultContent = normalizeMessageContent([
        {
          type: "tool-result",
          toolCallId: eventToolCallId,
          toolName: eventToolName,
          output: normalizeToolResultOutput(
            event.data.output,
            event.event === "tool.failed",
            typeof event.data.errorMessage === "string" ? event.data.errorMessage : undefined
          )
        }
      ]);
      if (toolResultContent !== null) {
        const toolResultMessage = buildMessageRecord({
          id: `live-tool-result:${eventToolCallId}`,
          sessionId,
          runId: event.runId,
          role: "tool",
          content: toolResultContent,
          ...(eventMetadata ? { metadata: eventMetadata } : {}),
          createdAt: event.createdAt
        });
        if (toolResultMessage) {
          upsertLiveToolMessage({
            key: `tool-result:${eventToolCallId}`,
            role: "tool",
            content: toolResultMessage.content,
            createdAt: event.createdAt,
            metadata: {
              toolStatus: event.event === "tool.failed" ? "failed" : "completed",
              ...(typeof event.data.sourceType === "string" ? { toolSourceType: event.data.sourceType } : {}),
              ...(typeof event.data.durationMs === "number" ? { toolDurationMs: event.data.durationMs } : {})
            },
            toolCallId: eventToolCallId
          });
        }
        setLiveMessagesByKey((current) => {
          const toolCallKey = `tool-call:${eventToolCallId}`;
          const currentEntry = current[toolCallKey];
          if (!currentEntry) {
            return current;
          }

          return {
            ...current,
            [toolCallKey]: {
              ...currentEntry,
              metadata: {
                ...(isRecord(currentEntry.metadata) ? currentEntry.metadata : {}),
                toolStatus: event.event === "tool.failed" ? "failed" : "completed",
                ...(typeof event.data.sourceType === "string" ? { toolSourceType: event.data.sourceType } : {}),
                ...(typeof event.data.durationMs === "number" ? { toolDurationMs: event.data.durationMs } : {})
              }
            }
          };
        });
      }
    }

    if (event.event === "message.completed" && typeof event.runId === "string") {
      const messageId = eventMessageId;
      const runId = event.runId;
      const content = normalizeMessageContent(event.data.content);
      if (messageId && content !== null) {
        startTransition(() => {
          setMessages((current) => {
            const existingMessage = current.find((message) => message.id === messageId);
            const completedMessage = buildMessageRecord({
              id: messageId,
              sessionId,
              runId,
              role: inferCompletedMessageRole(event.data),
              content,
              ...(() => {
                const metadata =
                  existingMessage?.metadata ?? liveMessagesByKey[`message:${messageId}`]?.metadata ?? eventMetadata;
                return metadata ? { metadata } : {};
              })(),
              createdAt:
                existingMessage?.createdAt ?? liveMessagesByKey[`message:${messageId}`]?.createdAt ?? event.createdAt
            });
            return completedMessage ? upsertSessionMessage(current, completedMessage) : current;
          });
        });
      }
      setLiveMessagesByKey((current) => {
        const next = { ...current };
        if (messageId) {
          delete next[`message:${messageId}`];
        }
        if (content !== null) {
          const completedRefs = new Set(
            contentToolRefs(content).map((ref) => `${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`)
          );
          for (const [key, entry] of Object.entries(next)) {
            const entryRefs = contentToolRefs(entry.content).map(
              (ref) => `${ref.type}:${ref.toolCallId ?? ""}:${ref.toolName ?? ""}`
            );
            if (entryRefs.some((ref) => completedRefs.has(ref))) {
              delete next[key];
            }
          }
        }
        return next;
      });
      scheduleMessagesRefresh();
      scheduleRunRefresh(runId);
    }

    if (event.event === "agent.switched" && typeof event.data.toAgent === "string") {
      syncCurrentSessionAgent(event.data.toAgent, event.createdAt);
      scheduleMessagesRefresh();
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
      platformModelStreamAbortRef.current?.abort();
      window.clearTimeout(messageRefreshTimerRef.current);
      window.clearTimeout(runRefreshTimerRef.current);
      window.clearTimeout(workspaceIndexRefreshTimerRef.current);
      window.clearTimeout(runPollingTimerRef.current);
      window.clearTimeout(platformModelReconnectTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        setConsoleOpen((current) => !current);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
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
    platformModelStreamAbortRef.current?.abort();
    window.clearTimeout(platformModelReconnectTimerRef.current);

    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }

      const controller = new AbortController();
      platformModelStreamAbortRef.current = controller;

      void (async () => {
        try {
          const headers = new Headers();
          const token = connection.token.trim();
          if (token) {
            headers.set("authorization", `Bearer ${token}`);
          }

          const response = await fetch(buildUrl(connection.baseUrl, "/api/v1/platform-models/events"), {
            signal: controller.signal,
            headers
          });

          if (response.status === 404 || response.status === 501) {
            return;
          }

          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }

          await consumeSse(
            response,
            (frame) => {
              const revision = frame.data.revision;
              const items = frame.data.items;
              if (typeof revision !== "number" || !Array.isArray(items)) {
                return;
              }

              handlePlatformModelSnapshot(
                {
                  revision,
                  items: items as PlatformModelRecord[]
                },
                frame.event === "platform-models.snapshot"
              );
            },
            controller.signal
          );
        } catch (error) {
          if (controller.signal.aborted || cancelled) {
            return;
          }

          if (isNotFoundError(error)) {
            return;
          }
        }

        if (!controller.signal.aborted && !cancelled) {
          platformModelReconnectTimerRef.current = window.setTimeout(connect, 1_500);
        }
      })();
    };

    connect();

    return () => {
      cancelled = true;
      platformModelStreamAbortRef.current?.abort();
      window.clearTimeout(platformModelReconnectTimerRef.current);
    };
  }, [connection.baseUrl, connection.token]);

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
            clearActiveError();
            return;
          }
          setStreamState("error");
          reportError(error);
          openConsoleForErrors();
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
      if (selectedRunIdValue) {
        delete completedRunResultPollsRef.current[selectedRunIdValue];
      }
      return;
    }

    if (run?.id === selectedRunIdValue && isTerminalRunStatus(run.status)) {
      delete completedRunResultPollsRef.current[selectedRunIdValue];
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

        const hasPersistedRunOutput = hasDisplayableRunMessages(nextMessages.items, selectedRunIdValue);
        const completedRunResultPolls = completedRunResultPollsRef.current[selectedRunIdValue] ?? 0;
        const shouldKeepPollingForCompletedMessage =
          nextRun.status === "completed" &&
          !hasPersistedRunOutput &&
          completedRunResultPolls < COMPLETED_RUN_RESULT_POLL_LIMIT;

        if (nextRun.status === "completed" && !hasPersistedRunOutput) {
          completedRunResultPollsRef.current[selectedRunIdValue] = completedRunResultPolls + 1;
        } else {
          delete completedRunResultPollsRef.current[selectedRunIdValue];
        }

        if (!isTerminalRunStatus(nextRun.status) || shouldKeepPollingForCompletedMessage) {
          runPollingTimerRef.current = window.setTimeout(() => {
            void pollRunSnapshot();
          }, shouldKeepPollingForCompletedMessage ? 400 : 1000);
          return;
        }

        setLiveMessagesByKey((current) => {
          return Object.fromEntries(
            Object.entries(current).filter(([, entry]) => entry.runId !== selectedRunIdValue)
          );
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        runPollingTimerRef.current = window.setTimeout(() => {
          void pollRunSnapshot();
        }, 1500);

        if (streamState === "error") {
          reportError(error);
        }
      }
    };

    runPollingTimerRef.current = window.setTimeout(() => {
      void pollRunSnapshot();
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(runPollingTimerRef.current);
      delete completedRunResultPollsRef.current[selectedRunIdValue];
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
  }, [liveMessagesByKey, messageFeed.length, selectedRunIdValue]);

  const latestEvent = deferredEvents[0];
  const inspectorSubtitle =
    inspectorTab === "overview"
      ? "Session / run summary, quick controls, and raw records"
      : inspectorTab === "timeline"
        ? "Messages, model calls, steps, and events in one feed"
        : "Workspace controls, catalog inventory, and raw records";

  function inspectConsoleEntry(entry: RuntimeConsoleEntry) {
    if (entry.runId) {
      setSelectedRunId(entry.runId);
      void refreshRun(entry.runId, true);
      void refreshRunSteps(entry.runId, true);
    }

    if (entry.stepId) {
      setSelectedStepId(entry.stepId);
    }

    if (entry.eventId) {
      setSelectedEventId(entry.eventId);
    }

    setMainViewMode("inspector");
    setInspectorTab("timeline");
  }

  return {
    errorMessage,
    activeError,
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
      healthStatus,
      streamState,
      onSurfaceModeChange: setSurfaceMode,
      consoleOpen,
      toggleConsole: () => setConsoleOpen((current) => !current)
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
      uploadWorkspaceTemplate: navigationActions.uploadWorkspaceTemplate,
      deleteWorkspaceTemplate: navigationActions.deleteWorkspaceTemplate,
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
      storageTableStatus: storageController.storageSurfaceProps.storageTableStatus,
      onStorageTableStatusChange: storageController.storageSurfaceProps.onStorageTableStatusChange,
      storageTableErrorCode: storageController.storageSurfaceProps.storageTableErrorCode,
      onStorageTableErrorCodeChange: storageController.storageSurfaceProps.onStorageTableErrorCodeChange,
      storageTableRecoveryState: storageController.storageSurfaceProps.storageTableRecoveryState,
      onStorageTableRecoveryStateChange: storageController.storageSurfaceProps.onStorageTableRecoveryStateChange,
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
      sessionEvents: events,
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
      refreshWorkspace: (targetId: string) => void navigationActions.refreshWorkspace(targetId, true),
      streamState,
      isRunning: !isTerminalRunStatus(run?.status) && run?.status != null,
      fileManager: workspaceFileManager.fileManagerSurfaceProps
    },
    consolePanelProps: {
      isOpen: consoleOpen && surfaceMode === "runtime",
      height: consoleHeight,
      onHeightChange: setConsoleHeight,
      onClose: () => setConsoleOpen(false),
      filter: consoleFilter,
      onFilterChange: setConsoleFilter,
      entries: consoleEntries,
      onEntryInspect: inspectConsoleEntry,
      openErrors: openConsoleForErrors,
      clearError: clearActiveError
    }
  };
}
