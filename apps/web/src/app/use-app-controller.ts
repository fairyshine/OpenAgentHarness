import { startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";

import {
  type ActionRunAccepted,
  type CreateMessageRequest,
  type GuideQueuedRunAccepted,
  healthReportSchema,
  readinessReportSchema,
  type Message,
  type MessageAccepted,
  type MessagePage,
  type ModelGenerateResponse,
  type Run,
  type RunPage,
  type RunStep,
  type SessionQueue,
  type SessionQueuedRun,
  type SessionEventContract
} from "@oah/api-contracts";

import {
  SERVICE_SCOPE_ALL,
  SERVICE_SCOPE_DEFAULT,
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
  normalizeServiceName,
  normalizeServiceScope,
  normalizeMessageContent,
  readJsonResponse,
  sanitizeFileSegment,
  serviceScopeLabel,
  serviceScopeMatches,
  toErrorSummary,
  toErrorMessage,
  upsertSessionMessage,
  type AppRequestErrorSummary,
  type HealthReportResponse,
  type LiveConversationMessageRecord,
  type PlatformModelListResponse,
  type PlatformModelRecord,
  type ModelProviderListResponse,
  type ReadinessReportResponse,
  type RuntimeConsoleEntry,
  type PlatformModelSnapshotResponse,
  type SseFrame
} from "./support";
import { buildAiSdkLikeRequest, buildAiSdkLikeStoredMessages } from "./primitives";
import { useNavigationActions } from "./use-navigation-actions";
import { buildRuntimeViewModel } from "./engine-view-model";
import { useNavigationState } from "./use-navigation-state";
import { useStorageController } from "./use-storage-controller";
import { useWorkspaceFileManager } from "./use-workspace-file-manager";
import { useHealthStore } from "./stores/health-store";
import { useModelsStore } from "./stores/models-store";
import { useSessionAgentStore } from "./stores/session-agent-store";
import { useSettingsStore } from "./stores/settings-store";
import { useStreamStore } from "./stores/stream-store";
import { useUiStore } from "./stores/ui-store";
import { buildComposerMessageContent, summarizeComposerMessageContent } from "./chat/composer-content";

const COMPLETED_RUN_RESULT_POLL_LIMIT = 5;
const MESSAGE_PAGE_SIZE = 120;

function buildMessagePagePath(
  sessionId: string,
  options?: {
    cursor?: string | undefined;
    direction?: "forward" | "backward" | undefined;
    pageSize?: number | undefined;
  }
) {
  const query = new URLSearchParams({
    pageSize: String(options?.pageSize ?? MESSAGE_PAGE_SIZE),
    direction: options?.direction ?? "backward"
  });
  if (options?.cursor) {
    query.set("cursor", options.cursor);
  }

  return `/api/v1/sessions/${sessionId}/messages?${query.toString()}`;
}

function mergeSessionMessages(current: Message[], incoming: Message[]) {
  let next = current;
  for (const message of incoming) {
    next = upsertSessionMessage(next, message);
  }

  return next;
}

function mergeMessageCursor(current: string | null, incoming: string | undefined) {
  const normalizedCurrent = current?.trim() ? current : null;
  const normalizedIncoming = incoming?.trim() ? incoming : null;

  if (!normalizedCurrent) {
    return normalizedIncoming;
  }
  if (!normalizedIncoming) {
    return normalizedCurrent;
  }

  const currentOffset = Number.parseInt(normalizedCurrent, 10);
  const incomingOffset = Number.parseInt(normalizedIncoming, 10);
  if (Number.isFinite(currentOffset) && Number.isFinite(incomingOffset)) {
    return String(Math.min(currentOffset, incomingOffset));
  }

  return normalizedCurrent;
}

function readQueuedRunsFromEventData(data: Record<string, unknown>): SessionQueuedRun[] | null {
  if (!Array.isArray(data.items)) {
    return null;
  }

  const items: SessionQueuedRun[] = [];
  for (const item of data.items) {
    if (!isRecord(item)) {
      return null;
    }
    if (
      typeof item.runId !== "string" ||
      typeof item.messageId !== "string" ||
      typeof item.content !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.position !== "number"
    ) {
      return null;
    }

    items.push({
      runId: item.runId,
      messageId: item.messageId,
      content: item.content,
      createdAt: item.createdAt,
      position: item.position
    });
  }

  return items;
}

const SESSION_RUN_LIST_REFRESH_EVENTS = new Set<SessionEventContract["event"]>([
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "agent.delegate.started",
  "agent.delegate.completed",
  "agent.delegate.failed"
]);

const RUN_DETAIL_REFRESH_EVENTS = new Set<SessionEventContract["event"]>([
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
]);

const ACTIVITY_VISIBLE_EVENTS = new Set<SessionEventContract["event"]>([
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "queue.updated",
  "agent.switched",
  "agent.delegate.started",
  "agent.delegate.completed",
  "agent.delegate.failed",
  "tool.failed"
]);

export function useAppController() {
  const {
    connection,
    workspaceRuntimeFilter,
    serviceScope,
    modelDraft,
    setConnection,
    setWorkspaceRuntimeFilter,
    setServiceScope,
    setModelDraft
  } = useSettingsStore(
    useShallow((state) => ({
      connection: state.connection,
      workspaceRuntimeFilter: state.workspaceRuntimeFilter,
      serviceScope: state.serviceScope,
      modelDraft: state.modelDraft,
      setConnection: state.setConnection,
      setWorkspaceRuntimeFilter: state.setWorkspaceRuntimeFilter,
      setServiceScope: state.setServiceScope,
      setModelDraft: state.setModelDraft
    }))
  );
  const {
    messages,
    events,
    selectedRunId,
    sessionRuns,
    run,
    runSteps,
    liveMessagesByKey,
    streamState,
    setMessages,
    setEvents,
    setSelectedRunId,
    setSessionRuns,
    setRun,
    setRunSteps,
    setLiveMessagesByKey,
    setStreamState,
    setGenerateOutput,
    setGenerateBusy
  } = useStreamStore(
    useShallow((state) => ({
      messages: state.messages,
      events: state.events,
      selectedRunId: state.selectedRunId,
      sessionRuns: state.sessionRuns,
      run: state.run,
      runSteps: state.runSteps,
      liveMessagesByKey: state.liveMessagesByKey,
      streamState: state.streamState,
      setMessages: state.setMessages,
      setEvents: state.setEvents,
      setSelectedRunId: state.setSelectedRunId,
      setSessionRuns: state.setSessionRuns,
      setRun: state.setRun,
      setRunSteps: state.setRunSteps,
      setLiveMessagesByKey: state.setLiveMessagesByKey,
      setStreamState: state.setStreamState,
      setGenerateOutput: state.setGenerateOutput,
      setGenerateBusy: state.setGenerateBusy
    }))
  );
  const { healthStatus, healthReport, readinessReport, setHealthStatus, setHealthReport, setReadinessReport } = useHealthStore(
    useShallow((state) => ({
      healthStatus: state.healthStatus,
      healthReport: state.healthReport,
      readinessReport: state.readinessReport,
      setHealthStatus: state.setHealthStatus,
      setHealthReport: state.setHealthReport,
      setReadinessReport: state.setReadinessReport
    }))
  );
  const { modelProviders, platformModels, setModelProviders, setPlatformModels } = useModelsStore(
    useShallow((state) => ({
      modelProviders: state.modelProviders,
      platformModels: state.platformModels,
      setModelProviders: state.setModelProviders,
      setPlatformModels: state.setPlatformModels
    }))
  );
  const {
    surfaceMode,
    mainViewMode,
    inspectorTab,
    timelineInspectorMode,
    selectedTraceId,
    selectedMessageId,
    selectedStepId,
    selectedEventId,
    consoleOpen,
    consoleFilter,
    errorMessage,
    activeError,
    streamRevision,
    setSurfaceMode,
    setMainViewMode,
    setInspectorTab,
    setTimelineInspectorMode,
    setSelectedTraceId,
    setSelectedMessageId,
    setSelectedStepId,
    setSelectedEventId,
    setConsoleOpen,
    setConsoleFilter,
    setActivity,
    setErrorMessage,
    setActiveError,
    setStreamRevision
  } = useUiStore(
    useShallow((state) => ({
      surfaceMode: state.surfaceMode,
      mainViewMode: state.mainViewMode,
      inspectorTab: state.inspectorTab,
      timelineInspectorMode: state.timelineInspectorMode,
      selectedTraceId: state.selectedTraceId,
      selectedMessageId: state.selectedMessageId,
      selectedStepId: state.selectedStepId,
      selectedEventId: state.selectedEventId,
      consoleOpen: state.consoleOpen,
      consoleFilter: state.consoleFilter,
      errorMessage: state.errorMessage,
      activeError: state.activeError,
      streamRevision: state.streamRevision,
      setSurfaceMode: state.setSurfaceMode,
      setMainViewMode: state.setMainViewMode,
      setInspectorTab: state.setInspectorTab,
      setTimelineInspectorMode: state.setTimelineInspectorMode,
      setSelectedTraceId: state.setSelectedTraceId,
      setSelectedMessageId: state.setSelectedMessageId,
      setSelectedStepId: state.setSelectedStepId,
      setSelectedEventId: state.setSelectedEventId,
      setConsoleOpen: state.setConsoleOpen,
      setConsoleFilter: state.setConsoleFilter,
      setActivity: state.setActivity,
      setErrorMessage: state.setErrorMessage,
      setActiveError: state.setActiveError,
      setStreamRevision: state.setStreamRevision
    }))
  );
  const {
    pendingSessionAgentName,
    switchingSessionAgentId,
    pendingSessionModelRef,
    switchingSessionModelId,
    setPendingSessionAgentName,
    setSwitchingSessionAgentId,
    setPendingSessionModelRef,
    setSwitchingSessionModelId
  } = useSessionAgentStore(
    useShallow((state) => ({
      pendingSessionAgentName: state.pendingSessionAgentName,
      switchingSessionAgentId: state.switchingSessionAgentId,
      pendingSessionModelRef: state.pendingSessionModelRef,
      switchingSessionModelId: state.switchingSessionModelId,
      setPendingSessionAgentName: state.setPendingSessionAgentName,
      setSwitchingSessionAgentId: state.setSwitchingSessionAgentId,
      setPendingSessionModelRef: state.setPendingSessionModelRef,
      setSwitchingSessionModelId: state.setSwitchingSessionModelId
    }))
  );
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
    workspaceRuntimes,
    setWorkspaceRuntimes,
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
  const [messagesNextCursor, setMessagesNextCursor] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [sessionQueuedRuns, setSessionQueuedRuns] = useState<SessionQueuedRun[]>([]);
  const completedRunResultPollsRef = useRef<Record<string, number>>({});
  const streamAbortRef = useRef<AbortController | null>(null);
  const platformModelStreamAbortRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef("");
  const lastCursorRef = useRef<string | undefined>(undefined);
  const messageRefreshTimerRef = useRef<number | undefined>(undefined);
  const messageRefreshSeqRef = useRef(0);
  const olderMessagesSeqRef = useRef(0);
  const sessionQueueRefreshSeqRef = useRef(0);
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
  const hasActiveSessionRun = useMemo(
    () => sessionRuns.some((item) => !isTerminalRunStatus(item.status)),
    [sessionRuns]
  );
  const normalizedServiceScope = useMemo(() => normalizeServiceScope(serviceScope), [serviceScope]);
  const serviceFilteredWorkspaces = useMemo(
    () => orderedSavedWorkspaces.filter((entry) => serviceScopeMatches(normalizedServiceScope, entry.serviceName)),
    [normalizedServiceScope, orderedSavedWorkspaces]
  );
  const knownServiceNames = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...orderedSavedWorkspaces.map((entry) => normalizeServiceName(entry.serviceName)),
            normalizeServiceName(workspace?.serviceName),
            normalizeServiceName(normalizedServiceScope)
          ].filter((entry): entry is string => Boolean(entry))
        )
      ).sort((left, right) => left.localeCompare(right)),
    [normalizedServiceScope, orderedSavedWorkspaces, workspace?.serviceName]
  );
  const serviceScopeOptions = useMemo(
    () => [
      {
        value: SERVICE_SCOPE_ALL,
        label: serviceScopeLabel(SERVICE_SCOPE_ALL)
      },
      {
        value: SERVICE_SCOPE_DEFAULT,
        label: serviceScopeLabel(SERVICE_SCOPE_DEFAULT)
      },
      ...knownServiceNames.map((entry) => ({
        value: entry,
        label: serviceScopeLabel(entry)
      }))
    ],
    [knownServiceNames]
  );
  const selectedServiceScopeLabel = useMemo(() => serviceScopeLabel(normalizedServiceScope), [normalizedServiceScope]);
  const workspaceRuntimeFilterValue = workspaceRuntimeFilter.trim();
  const workspaceRuntimeFilterOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...workspaceRuntimes,
            ...serviceFilteredWorkspaces.map((entry) => entry.runtime ?? ""),
            workspaceRuntimeFilterValue
          ]
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        )
      ).sort((left, right) => left.localeCompare(right)),
    [serviceFilteredWorkspaces, workspaceRuntimeFilterValue, workspaceRuntimes]
  );
  const filteredSavedWorkspaces = useMemo(
    () =>
      workspaceRuntimeFilterValue
        ? serviceFilteredWorkspaces.filter((entry) => (entry.runtime ?? "").trim() === workspaceRuntimeFilterValue)
        : serviceFilteredWorkspaces,
    [serviceFilteredWorkspaces, workspaceRuntimeFilterValue]
  );
  const filteredSavedSessionsCount = useMemo(
    () =>
      filteredSavedWorkspaces.reduce((count, entry) => count + (sessionsByWorkspaceId.get(entry.id)?.length ?? 0), 0),
    [filteredSavedWorkspaces, sessionsByWorkspaceId]
  );
  const queuedMessageIds = useMemo(() => new Set(sessionQueuedRuns.map((item) => item.messageId)), [sessionQueuedRuns]);
  const runtimeViewModel = useMemo(
    () =>
      buildRuntimeViewModel({
        messages,
        queuedMessageIds,
        runSteps,
        deferredEvents,
        liveMessagesByKey,
        selectedTraceId,
        selectedMessageId,
        selectedStepId,
        selectedEventId,
        sessionId
      }),
    [
      deferredEvents,
      liveMessagesByKey,
      messages,
      queuedMessageIds,
      runSteps,
      selectedEventId,
      selectedMessageId,
      selectedStepId,
      selectedTraceId,
      sessionId
    ]
  );
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
    allEngineToolNames,
    allAdvertisedToolNames,
    allEngineTools,
    allToolServers,
    resolvedModelNames,
    resolvedModelRefs,
    messageFeed
  } = runtimeViewModel;
  const isConsoleVisible = consoleOpen && surfaceMode === "engine";
  const consoleEntries = useMemo(() => {
    if (!isConsoleVisible) {
      return [];
    }

    return buildRuntimeConsoleEntries(events, activeError);
  }, [activeError, events, isConsoleVisible]);

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

  useEffect(() => {
    const targetWorkspaceId = activeWorkspaceId.trim();
    if (!targetWorkspaceId) {
      return;
    }

    const activeWorkspaceServiceName =
      workspace?.id === targetWorkspaceId
        ? workspace.serviceName
        : savedWorkspaces.find((entry) => entry.id === targetWorkspaceId)?.serviceName;
    if (serviceScopeMatches(normalizedServiceScope, activeWorkspaceServiceName)) {
      return;
    }

    streamAbortRef.current?.abort();
    lastCursorRef.current = undefined;
    sessionAgentSwitchRef.current = null;
    sessionModelUpdateRef.current = null;
    window.clearTimeout(messageRefreshTimerRef.current);
    window.clearTimeout(runRefreshTimerRef.current);
    window.clearTimeout(workspaceIndexRefreshTimerRef.current);
    window.clearTimeout(runPollingTimerRef.current);

    startTransition(() => {
      setWorkspaceId("");
      setWorkspace(null);
      setCatalog(null);
      setSessionId("");
      setSession(null);
      setMessages([]);
      setEvents([]);
      setSelectedRunId("");
      setSessionRuns([]);
      setRun(null);
      setRunSteps([]);
      setLiveMessagesByKey({});
      setSelectedTraceId("");
      setSelectedMessageId("");
      setSelectedStepId("");
      setSelectedEventId("");
      setPendingSessionAgentName(null);
      setSwitchingSessionAgentId(null);
      setPendingSessionModelRef(null);
      setSwitchingSessionModelId(null);
      setStreamState("idle");
    });
    setMessagesNextCursor(null);
    setMessagesLoading(false);
    setLoadingOlderMessages(false);
  }, [activeWorkspaceId, normalizedServiceScope, savedWorkspaces, setCatalog, setSession, setSessionId, setWorkspace, setWorkspaceId, workspace]);

  const storageController = useStorageController({
    connection,
    enabled: surfaceMode === "storage",
    serviceScope: normalizedServiceScope,
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
    enabled: surfaceMode === "engine" && mainViewMode === "conversation",
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
      setWorkspaceRuntimes,
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

  async function listAllSessionMessages(targetSessionId: string): Promise<Message[]> {
    let cursor: string | undefined;
    let allMessages: Message[] = [];

    while (true) {
      const page = await request<MessagePage>(buildMessagePagePath(targetSessionId, { cursor, direction: "forward" }));
      allMessages = mergeSessionMessages(allMessages, page.items);
      if (!page.nextCursor) {
        return allMessages;
      }
      cursor = page.nextCursor;
    }
  }

  async function downloadSessionTrace() {
    const targetSessionId = session?.id?.trim();
    const exportMessages = targetSessionId ? await listAllSessionMessages(targetSessionId) : messages;
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
      Messages: buildAiSdkLikeStoredMessages(exportMessages)
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

  async function refreshMessages(
    quiet = false,
    options?: {
      reset?: boolean | undefined;
    }
  ) {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      startTransition(() => {
        setMessages([]);
        setMessagesNextCursor(null);
      });
      return;
    }

    const refreshSeq = messageRefreshSeqRef.current + 1;
    messageRefreshSeqRef.current = refreshSeq;
    setMessagesLoading(true);

    try {
      const messagePage = await request<MessagePage>(buildMessagePagePath(targetSessionId));
      if (activeSessionIdRef.current !== targetSessionId || messageRefreshSeqRef.current !== refreshSeq) {
        return;
      }

      startTransition(() => {
        setMessages((current) => (options?.reset ? messagePage.items : mergeSessionMessages(current, messagePage.items)));
        setMessagesNextCursor((current) =>
          options?.reset ? (messagePage.nextCursor ?? null) : mergeMessageCursor(current, messagePage.nextCursor)
        );
        setLiveMessagesByKey((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([, entry]) => {
              if (entry.role !== "user" || !entry.persistedMessageId) {
                return true;
              }

              return !messagePage.items.some((message) => message.id === entry.persistedMessageId);
            })
          )
        );
      });
      if (!quiet) {
        clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        reportError(error);
      }
    } finally {
      if (messageRefreshSeqRef.current === refreshSeq) {
        setMessagesLoading(false);
      }
    }
  }

  async function loadOlderMessages() {
    const targetSessionId = sessionId.trim();
    const cursor = messagesNextCursor?.trim();
    if (!targetSessionId || !cursor || loadingOlderMessages) {
      return;
    }

    const olderSeq = olderMessagesSeqRef.current + 1;
    olderMessagesSeqRef.current = olderSeq;
    setLoadingOlderMessages(true);

    try {
      const messagePage = await request<MessagePage>(buildMessagePagePath(targetSessionId, { cursor }));
      if (activeSessionIdRef.current !== targetSessionId || olderMessagesSeqRef.current !== olderSeq) {
        return;
      }

      startTransition(() => {
        setMessages((current) => mergeSessionMessages(current, messagePage.items));
        setMessagesNextCursor(messagePage.nextCursor ?? null);
      });
      clearActiveError();
    } catch (error) {
      reportError(error);
    } finally {
      if (olderMessagesSeqRef.current === olderSeq) {
        setLoadingOlderMessages(false);
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

  async function refreshSessionQueue(quiet = false) {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      startTransition(() => {
        setSessionQueuedRuns([]);
      });
      return;
    }

    const refreshSeq = sessionQueueRefreshSeqRef.current + 1;
    sessionQueueRefreshSeqRef.current = refreshSeq;

    try {
      const queue = await request<SessionQueue>(`/api/v1/sessions/${targetSessionId}/queue`);
      if (activeSessionIdRef.current !== targetSessionId || sessionQueueRefreshSeqRef.current !== refreshSeq) {
        return;
      }

      startTransition(() => {
        setSessionQueuedRuns(queue.items);
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

  const submitSessionMessage = useEffectEvent(
    async (
      content: CreateMessageRequest["content"],
      options?: {
        clearDraft?: boolean;
        runningRunBehavior?: "queue" | "interrupt";
        activityLabel?: string;
      }
    ) => {
      if (!sessionId.trim()) {
        reportError("请先创建或加载 session。");
        return;
      }

      const contentPreview = summarizeComposerMessageContent(content).trim();
      if (!contentPreview) {
        return;
      }

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

      const runningRunBehavior = options?.runningRunBehavior ?? "queue";

      shouldAutoFollowConversationRef.current = true;
      const accepted = await request<MessageAccepted>(`/api/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          content,
          runningRunBehavior
        })
      });
      const shouldDisplayAsQueued = accepted.delivery === "session_queue";

      startTransition(() => {
        if (options?.clearDraft !== false) {
          useStreamStore.getState().setDraftMessage("");
          useStreamStore.getState().setDraftAttachments([]);
        }
        if (shouldDisplayAsQueued) {
          setSessionQueuedRuns((current) => {
            const nextCreatedAt = accepted.createdAt ?? new Date().toISOString();
            const nextPosition = accepted.queuedPosition ?? current.length + 1;
            const nextItem: SessionQueuedRun = {
              runId: accepted.runId,
              messageId: accepted.messageId,
              content: contentPreview,
              createdAt: nextCreatedAt,
              position: nextPosition
            };
            const deduped = current.filter((item) => item.runId !== accepted.runId);
            return [...deduped, nextItem].sort((left, right) => left.position - right.position);
          });
        }
        if (!shouldDisplayAsQueued) {
          setSelectedRunId(accepted.runId);
          setLiveMessagesByKey((current) => ({
            ...current,
            [`pending-user:${accepted.messageId}`]: {
              persistedMessageId: accepted.messageId,
              runId: "",
              sessionId,
              role: "user",
              content,
              createdAt: new Date().toISOString()
            }
          }));
        }
      });
      setStreamRevision((current) => current + 1);
      const refreshes: Array<Promise<unknown>> = [refreshSessionRuns(true, { includeSteps: true })];
      if (!shouldDisplayAsQueued) {
        refreshes.unshift(refreshMessages(true));
      }
      if (!shouldDisplayAsQueued) {
        refreshes.push(refreshRun(accepted.runId, true), refreshRunSteps(accepted.runId, true));
      }

      await Promise.all(refreshes);
      setActivity(
        options?.activityLabel ??
          (shouldDisplayAsQueued ? `消息已加入后续队列，run=${accepted.runId}` : `消息已入队，run=${accepted.runId}`)
      );
      clearActiveError();
    }
  );

  async function sendMessage() {
    if (!sessionId.trim()) {
      reportError("请先创建或加载 session。");
      return;
    }

    const { draftMessage, draftAttachments } = useStreamStore.getState();
    const content = buildComposerMessageContent(draftMessage, draftAttachments);
    if (!content) {
      return;
    }

    try {
      await submitSessionMessage(content, {
        clearDraft: true
      });
    } catch (error) {
      reportError(error);
      openConsoleForErrors();
    }
  }

  async function guideMessage() {
    if (!sessionId.trim()) {
      reportError("请先创建或加载 session。");
      return;
    }

    const { draftMessage, draftAttachments } = useStreamStore.getState();
    const content = buildComposerMessageContent(draftMessage, draftAttachments);
    if (!content) {
      return;
    }

    try {
      await submitSessionMessage(content, {
        clearDraft: true,
        runningRunBehavior: "interrupt",
        activityLabel: "已引导当前 run，正在切换到新的处理轮次"
      });
    } catch (error) {
      reportError(error);
      openConsoleForErrors();
    }
  }

  async function guideQueuedSessionInput(runId: string) {
    if (!sessionId.trim() || !runId.trim()) {
      reportError("请先创建或加载 session。");
      return;
    }

    try {
      await request<GuideQueuedRunAccepted>(`/api/v1/runs/${runId}/guide`, {
        method: "POST"
      });
      await refreshSessionRuns(true, { includeSteps: true });
      setActivity("已引导排队消息，正在切换到新的处理轮次");
      clearActiveError();
    } catch (error) {
      const summary = toErrorSummary(error);
      if (summary?.code === "queued_run_not_found") {
        await Promise.all([refreshSessionQueue(true), refreshSessionRuns(true, { includeSteps: true })]);
        setActivity("该排队消息已离开队列，已刷新当前状态");
        clearActiveError();
        return;
      }
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

  async function triggerWorkspaceAction(input: {
    workspaceId: string;
    actionName: string;
    input?: unknown;
  }): Promise<boolean> {
    const targetWorkspaceId = input.workspaceId.trim();
    const targetActionName = input.actionName.trim();
    if (!targetWorkspaceId || !targetActionName) {
      return false;
    }

    try {
      const attachedSessionId =
        session?.workspaceId === targetWorkspaceId && session.id.trim().length > 0 ? session.id : undefined;
      const accepted = await request<ActionRunAccepted>(
        `/api/v1/workspaces/${targetWorkspaceId}/actions/${encodeURIComponent(targetActionName)}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            ...(attachedSessionId ? { sessionId: attachedSessionId } : {}),
            ...(input.input !== undefined ? { input: input.input } : {}),
            triggerSource: "user"
          })
        }
      );

      if (accepted.sessionId && accepted.sessionId !== sessionId) {
        await navigationActions.refreshSession(accepted.sessionId, true);
      } else if (accepted.sessionId) {
        await refreshSessionRuns(true, { includeSteps: true });
      }

      startTransition(() => {
        setSelectedRunId(accepted.runId);
      });
      await Promise.all([refreshRun(accepted.runId, true), refreshRunSteps(accepted.runId, true)]);
      setActivity(`Action 已入队，run=${accepted.runId}`);
      clearActiveError();
      return true;
    } catch (error) {
      reportError(error);
      return false;
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
      createdAt: frame.createdAt ?? new Date().toISOString()
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
    const eventStructuredContent = normalizeMessageContent(event.data.content);
    const eventToolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
    const eventToolName = typeof event.data.toolName === "string" ? event.data.toolName : undefined;
    const eventToolStatus =
      eventMetadata?.toolStatus === "running" ||
      eventMetadata?.toolStatus === "started" ||
      eventMetadata?.toolStatus === "completed" ||
      eventMetadata?.toolStatus === "failed"
        ? eventMetadata.toolStatus
        : undefined;
    const eventQueueSnapshot = event.event === "queue.updated" ? readQueuedRunsFromEventData(event.data) : null;
    const eventQueueAction = typeof event.data.action === "string" ? event.data.action : undefined;

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
      (typeof event.data.delta === "string" || eventStructuredContent !== null)
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
          content:
            eventStructuredContent ??
            `${typeof current[liveMessageKey]?.content === "string" ? current[liveMessageKey].content : ""}${
              typeof event.data.delta === "string" ? event.data.delta : ""
            }`,
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
              toolStatus: event.event === "tool.failed" ? "failed" : (eventToolStatus ?? "completed"),
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
                toolStatus: event.event === "tool.failed" ? "failed" : (eventToolStatus ?? "completed"),
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

    if (event.event === "queue.updated") {
      if (eventQueueSnapshot) {
        startTransition(() => {
          setSessionQueuedRuns(eventQueueSnapshot);
        });
      } else {
        void refreshSessionQueue(true);
      }
      if (eventQueueAction === "dequeued" || eventQueueAction === "removed") {
        scheduleMessagesRefresh();
      }
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
      if (SESSION_RUN_LIST_REFRESH_EVENTS.has(event.event)) {
        void refreshSessionRuns(true);
      }
      if (RUN_DETAIL_REFRESH_EVENTS.has(event.event)) {
        scheduleRunRefresh(event.runId);
      }
    }

    if (event.event === "agent.delegate.started") {
      scheduleWorkspaceIndexRefresh();
    }

    if (typeof event.runId === "string" && isTerminalRunEvent(event.event)) {
      void navigationActions.refreshSession(sessionId, true);
      scheduleMessagesRefresh();
    }

    if (ACTIVITY_VISIBLE_EVENTS.has(event.event)) {
      setActivity(`${event.event}${event.runId ? ` · ${event.runId}` : ""}`);
    }
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
    activeSessionIdRef.current = sessionId.trim();
  }, [sessionId]);

  useEffect(() => {
    shouldAutoFollowConversationRef.current = true;
    setMessagesNextCursor(null);
    setLoadingOlderMessages(false);
    olderMessagesSeqRef.current = 0;

    if (!sessionId.trim()) {
      startTransition(() => {
        setMessages([]);
        setSessionQueuedRuns([]);
      });
      setMessagesLoading(false);
      return;
    }

    setMessagesLoading(true);
    void refreshMessages(true, { reset: true });
    void refreshSessionQueue(true);
  }, [sessionId]);

  useEffect(() => {
    void navigationActions.refreshWorkspaceIndex(true);
    void navigationActions.refreshWorkspaceRuntimes(true);
    void refreshModelProviders(true);
    void refreshPlatformModels(true);
  }, [connection.baseUrl, connection.token]);

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
  }, [connection.baseUrl, connection.token, sessionId]);

  useEffect(() => {
    if (!sessionId.trim() || session?.id !== sessionId) {
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
    connection.baseUrl,
    connection.token,
    session?.id,
    sessionId,
    streamRevision
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
          request<MessagePage>(buildMessagePagePath(sessionId))
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
          setMessages((current) => mergeSessionMessages(current, nextMessages.items));
          setMessagesNextCursor((current) => mergeMessageCursor(current, nextMessages.nextCursor));
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

  const handlePingHealth = useEffectEvent(() => {
    void pingHealth();
  });
  const handleRefreshModelProviders = useEffectEvent(() => {
    void refreshModelProviders();
  });
  const handleRefreshPlatformModels = useEffectEvent(() => {
    void refreshPlatformModels();
  });
  const handleGenerateOnce = useEffectEvent(() => {
    void generateOnce();
  });
  const handleRefreshSessionRuns = useEffectEvent(() => {
    void refreshSessionRuns(false, { includeSteps: true });
  });
  const handleRefreshRunById = useEffectEvent((targetId: string) => {
    void refreshRun(targetId, true);
  });
  const handleRefreshRunStepsById = useEffectEvent((targetId: string) => {
    void refreshRunSteps(targetId, true);
  });
  const handleLoadOlderMessages = useEffectEvent(() => {
    void loadOlderMessages();
  });
  const handleRefreshMessages = useEffectEvent(() => {
    void refreshMessages();
  });
  const handleSendMessage = useEffectEvent(() => {
    void sendMessage();
  });
  const handleGuideMessage = useEffectEvent(() => {
    void guideMessage();
  });
  const handleGuideQueuedSessionInput = useEffectEvent((runId: string) => {
    void guideQueuedSessionInput(runId);
  });
  const handleRefreshRun = useEffectEvent(() => {
    void refreshRun();
  });
  const handleRefreshRunSteps = useEffectEvent(() => {
    void refreshRunSteps();
  });
  const handleCancelCurrentRun = useEffectEvent(() => {
    void cancelCurrentRun();
  });
  const handleSwitchSessionAgent = useEffectEvent((targetId: string, activeAgentName: string) => {
    void switchSessionAgent(targetId, activeAgentName);
  });
  const handleUpdateSessionModel = useEffectEvent((targetId: string, modelRef: string | null) => {
    void updateSessionModel(targetId, modelRef);
  });
  const handleRefreshWorkspace = useEffectEvent((targetId: string) => {
    void navigationActions.refreshWorkspace(targetId, true);
  });
  const handleInspectConsoleEntry = useEffectEvent((entry: RuntimeConsoleEntry) => {
    inspectConsoleEntry(entry);
  });
  const headerProps = useMemo(
    () => ({
      serviceScopeOptions
    }),
    [serviceScopeOptions]
  );
  const providerSurfaceProps = useMemo(
    () => ({
      pingHealth: handlePingHealth,
      refreshModelProviders: handleRefreshModelProviders,
      refreshPlatformModels: handleRefreshPlatformModels,
      generateOnce: handleGenerateOnce
    }),
    [handleGenerateOnce, handlePingHealth, handleRefreshModelProviders, handleRefreshPlatformModels]
  );
  const sidebarSurfaceProps = useMemo(
    () => ({
      serviceScope: normalizedServiceScope,
      selectedServiceScopeLabel,
      workspaceRuntimeFilterOptions,
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
      workspaceRuntimes,
      createWorkspace: navigationActions.createWorkspace,
      refreshWorkspaceRuntimes: navigationActions.refreshWorkspaceRuntimes,
      uploadWorkspaceRuntime: navigationActions.uploadWorkspaceRuntime,
      deleteWorkspaceRuntime: navigationActions.deleteWorkspaceRuntime,
      refreshWorkspaceIndex: navigationActions.refreshWorkspaceIndex,
      createSession: navigationActions.createSession,
      sessionId,
      refreshSessionById: navigationActions.refreshSession,
      removeSavedSession: navigationActions.removeSavedSession,
      renameSession: navigationActions.renameSession,
      sessionsByWorkspaceId,
      expandedWorkspaceIds,
      expandedSessionIds,
      openWorkspace: navigationActions.openWorkspace,
      toggleWorkspaceExpansion: navigationActions.toggleWorkspaceExpansion,
      toggleSessionExpansion: (targetId: string) =>
        setExpandedSessionIds((current) =>
          current.includes(targetId) ? current.filter((entry) => entry !== targetId) : [targetId, ...current].slice(0, 64)
        ),
      deleteWorkspace: navigationActions.deleteWorkspace,
      storageOverview: storageController.storageSurfaceProps.storageOverview,
      storageRedisEnabled: storageController.storageSurfaceProps.storageRedisEnabled,
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
      pingHealth: handlePingHealth,
      refreshModelProviders: handleRefreshModelProviders,
      refreshPlatformModels: handleRefreshPlatformModels,
      modelProviders
    }),
    [
      activeWorkspaceId,
      expandedSessionIds,
      expandedWorkspaceIds,
      filteredSavedSessionsCount,
      filteredSavedWorkspaces,
      handlePingHealth,
      handleRefreshModelProviders,
      handleRefreshPlatformModels,
      modelProviders,
      navigationActions.createSession,
      navigationActions.createWorkspace,
      navigationActions.deleteWorkspace,
      navigationActions.deleteWorkspaceRuntime,
      navigationActions.expandWorkspaceInSidebar,
      navigationActions.openWorkspace,
      navigationActions.refreshSession,
      navigationActions.refreshWorkspaceIndex,
      navigationActions.refreshWorkspaceRuntimes,
      navigationActions.removeSavedSession,
      navigationActions.renameSession,
      navigationActions.toggleWorkspaceExpansion,
      navigationActions.uploadWorkspaceRuntime,
      normalizedServiceScope,
      orderedSavedWorkspaces,
      savedSessions.length,
      selectedServiceScopeLabel,
      sessionId,
      sessionsByWorkspaceId,
      setExpandedSessionIds,
      setShowWorkspaceCreator,
      setWorkspaceDraft,
      showWorkspaceCreator,
      storageController.storageSurfaceProps.onClearStorageTableFilters,
      storageController.storageSurfaceProps.onRedisKeyPatternChange,
      storageController.storageSurfaceProps.onRefreshRedisKeys,
      storageController.storageSurfaceProps.onRefreshStorageOverview,
      storageController.storageSurfaceProps.onRefreshStorageTable,
      storageController.storageSurfaceProps.onSelectRedisKey,
      storageController.storageSurfaceProps.onSelectStorageTable,
      storageController.storageSurfaceProps.onStorageBrowserTabChange,
      storageController.storageSurfaceProps.onStorageTableErrorCodeChange,
      storageController.storageSurfaceProps.onStorageTableRecoveryStateChange,
      storageController.storageSurfaceProps.onStorageTableRunIdChange,
      storageController.storageSurfaceProps.onStorageTableSearchChange,
      storageController.storageSurfaceProps.onStorageTableSessionIdChange,
      storageController.storageSurfaceProps.onStorageTableStatusChange,
      storageController.storageSurfaceProps.onStorageTableWorkspaceIdChange,
      storageController.storageSurfaceProps.redisKeyPage,
      storageController.storageSurfaceProps.redisKeyPattern,
      storageController.storageSurfaceProps.selectedRedisKey,
      storageController.storageSurfaceProps.selectedStorageTable,
      storageController.storageSurfaceProps.storageBrowserTab,
      storageController.storageSurfaceProps.storageBusy,
      storageController.storageSurfaceProps.storageOverview,
      storageController.storageSurfaceProps.storageRedisEnabled,
      storageController.storageSurfaceProps.storageTableErrorCode,
      storageController.storageSurfaceProps.storageTableRecoveryState,
      storageController.storageSurfaceProps.storageTableRunId,
      storageController.storageSurfaceProps.storageTableSearch,
      storageController.storageSurfaceProps.storageTableSessionId,
      storageController.storageSurfaceProps.storageTableStatus,
      storageController.storageSurfaceProps.storageTableWorkspaceId,
      workspaceDraft,
      workspaceManagementEnabled,
      workspaceRuntimeFilterOptions,
      workspaceRuntimes
    ]
  );
  const runtimeDetailSurfaceProps = useMemo(
    () => ({
      mainViewMode,
      setMainViewMode,
      setSurfaceMode,
      hasActiveSession,
      currentSessionName,
      currentWorkspaceName,
      inspectorSubtitle,
      latestEvent,
      session,
      workspace,
      workspaceId,
      sessionRuns,
      refreshSessionRuns: handleRefreshSessionRuns,
      sessionEvents: events,
      deferredEvents,
      messageFeed,
      refreshRunById: handleRefreshRunById,
      refreshRunStepsById: handleRefreshRunStepsById,
      conversationThreadRef,
      conversationTailRef,
      shouldAutoFollowConversationRef,
      hasMoreMessages: Boolean(messagesNextCursor),
      messagesLoading,
      loadingOlderMessages,
      queuedSessionRuns: sessionQueuedRuns,
      loadOlderMessages: handleLoadOlderMessages,
      refreshMessages: handleRefreshMessages,
      sendMessage: handleSendMessage,
      guideMessage: handleGuideMessage,
      guideQueuedSessionInput: handleGuideQueuedSessionInput,
      guideMessageSupported: true,
      refreshRun: handleRefreshRun,
      refreshRunSteps: handleRefreshRunSteps,
      cancelCurrentRun: handleCancelCurrentRun,
      modelCallTraces,
      latestModelCallTrace,
      firstModelCallTrace,
      composedSystemMessages,
      selectedSessionMessage,
      selectedMessageSystemMessages,
      selectedModelCallTrace,
      storedMessageCounts,
      latestModelMessageCounts,
      resolvedModelNames,
      resolvedModelRefs,
      allEngineTools,
      allEngineToolNames,
      allAdvertisedToolNames,
      allToolServers,
      downloadSessionTrace,
      selectedRunStep,
      selectedSessionEvent,
      catalog,
      isSwitchingSessionAgent: switchingSessionAgentId === session?.id && pendingSessionAgentName !== null,
      switchSessionAgent: handleSwitchSessionAgent,
      isSwitchingSessionModel: switchingSessionModelId === session?.id,
      updateSessionModel: handleUpdateSessionModel,
      triggerWorkspaceAction,
      refreshWorkspace: handleRefreshWorkspace,
      isRunning: hasActiveSessionRun,
      fileManager: workspaceFileManager.fileManagerSurfaceProps
    }),
    [
      allAdvertisedToolNames,
      allEngineToolNames,
      allEngineTools,
      allToolServers,
      catalog,
      composedSystemMessages,
      conversationTailRef,
      conversationThreadRef,
      currentSessionName,
      currentWorkspaceName,
      deferredEvents,
      downloadSessionTrace,
      events,
      workspaceFileManager.fileManagerSurfaceProps,
      firstModelCallTrace,
      handleCancelCurrentRun,
      handleGuideMessage,
      handleGuideQueuedSessionInput,
      handleLoadOlderMessages,
      handleRefreshMessages,
      handleRefreshRun,
      handleRefreshRunById,
      handleRefreshRunSteps,
      handleRefreshRunStepsById,
      handleRefreshSessionRuns,
      handleRefreshWorkspace,
      handleSendMessage,
      handleSwitchSessionAgent,
      handleUpdateSessionModel,
      hasActiveSession,
      hasActiveSessionRun,
      inspectorSubtitle,
      latestEvent,
      latestModelCallTrace,
      latestModelMessageCounts,
      loadingOlderMessages,
      mainViewMode,
      messageFeed,
      messagesLoading,
      messagesNextCursor,
      modelCallTraces,
      pendingSessionAgentName,
      queuedMessageIds,
      resolvedModelNames,
      resolvedModelRefs,
      selectedModelCallTrace,
      selectedRunStep,
      selectedSessionEvent,
      selectedSessionMessage,
      selectedMessageSystemMessages,
      session,
      sessionRuns,
      sessionQueuedRuns,
      setMainViewMode,
      setSurfaceMode,
      shouldAutoFollowConversationRef,
      storedMessageCounts,
      switchingSessionAgentId,
      switchingSessionModelId,
      triggerWorkspaceAction,
      workspace,
      workspaceFileManager.fileManagerSurfaceProps,
      workspaceId
    ]
  );
  const consolePanelProps = useMemo(
    () => ({
      isOpen: consoleOpen && surfaceMode === "engine",
      entries: consoleEntries,
      onEntryInspect: handleInspectConsoleEntry,
      openErrors: openConsoleForErrors
    }),
    [consoleEntries, consoleOpen, handleInspectConsoleEntry, openConsoleForErrors, surfaceMode]
  );

  return {
    errorMessage,
    activeError,
    surfaceMode,
    headerProps,
    storageSurfaceProps: storageController.storageSurfaceProps,
    providerSurfaceProps,
    sidebarSurfaceProps,
    runtimeDetailSurfaceProps,
    consolePanelProps
  };
}
