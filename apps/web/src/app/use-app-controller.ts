import { startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  readinessReportSchema,
  type Run,
  type RunPage,
  type RunStep,
  type SessionQueuedRun,
} from "@oah/api-contracts";

import {
  buildRuntimeConsoleEntries,
  downloadJsonFile,
  isNotFoundError,
  sanitizeFileSegment,
  serviceScopeMatches,
  toErrorSummary,
  toErrorMessage,
  type AppRequestErrorSummary,
  type HealthReportResponse,
  type LiveConversationMessageRecord,
  type ReadinessReportResponse,
  type RuntimeConsoleEntry,
  type SystemProfileResponse
} from "./support";
import { useNavigationActions } from "./use-navigation-actions";
import { buildRuntimeViewModel } from "./engine-view-model";
import { appControllerRequest, listAllSessionMessages } from "./app-controller-request";
import { buildSessionTraceExportPayload } from "./session-trace-export";
import { useSidebarDerivedState } from "./use-sidebar-derived-state";
import { useNavigationState } from "./use-navigation-state";
import { useStorageController } from "./use-storage-controller";
import { useWorkspaceFileManager } from "./use-workspace-file-manager";
import { useSessionEventHandler } from "./use-session-event-handler";
import { useSessionMessages } from "./use-session-messages";
import { useSessionRunActions } from "./use-session-run-actions";
import { useSessionSubmitActions } from "./use-session-submit-actions";
import { useSessionUtilityActions } from "./use-session-utility-actions";
import { useSessionSettingsActions } from "./use-session-settings-actions";
import { useSystemModelActions } from "./use-system-model-actions";
import { usePlatformModelStream } from "./use-platform-model-stream";
import { useSelectedRunPolling } from "./use-selected-run-polling";
import { useSessionEventStream } from "./use-session-event-stream";
import { useAppControllerStores } from "./use-app-controller-stores";
import { useAppControllerSurfaceProps } from "./use-app-controller-surface-props";
import {
  buildMessagePagePath,
  sortRunSteps
} from "./app-controller-utils";

export function useAppController() {
  const stores = useAppControllerStores();
  const {
    connection,
    workspaceRuntimeFilter,
    serviceScope,
    modelDraft,
    setConnection,
    setWorkspaceRuntimeFilter,
    setServiceScope,
    setModelDraft
  } = stores.settings;
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
  } = stores.stream;
  const { healthStatus, systemProfile, healthReport, readinessReport, setHealthStatus, setSystemProfile, setHealthReport, setReadinessReport } = stores.health;
  const { modelProviders, platformModels, setModelProviders, setPlatformModels } = stores.models;
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
  } = stores.ui;
  const {
    pendingSessionAgentName,
    switchingSessionAgentId,
    pendingSessionModelRef,
    switchingSessionModelId,
    setPendingSessionAgentName,
    setSwitchingSessionAgentId,
    setPendingSessionModelRef,
    setSwitchingSessionModelId
  } = stores.sessionAgent;
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
  const [sessionQueuedRuns, setSessionQueuedRuns] = useState<SessionQueuedRun[]>([]);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef("");
  const lastCursorRef = useRef<string | undefined>(undefined);
  const messageRefreshTimerRef = useRef<number | undefined>(undefined);
  const runRefreshTimerRef = useRef<number | undefined>(undefined);
  const workspaceIndexRefreshTimerRef = useRef<number | undefined>(undefined);
  const runPollingTimerRef = useRef<number | undefined>(undefined);
  const conversationThreadRef = useRef<HTMLDivElement | null>(null);
  const conversationTailRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowConversationRef = useRef(true);
  const selectedRunIdValue = selectedRunId.trim();
  const [sidebarSessionRunsById, setSidebarSessionRunsById] = useState<Record<string, Run[]>>({});
  const {
    normalizedServiceScope,
    serviceScopeOptions,
    selectedServiceScopeLabel,
    workspaceRuntimeFilterValue,
    workspaceRuntimeFilterOptions,
    filteredSavedWorkspaces,
    filteredSavedSessionsCount,
    visibleSidebarSessionIds,
    visibleSidebarSessionKey,
    sidebarSessionRuns,
    activeWorkspaceSessions,
    hasActiveSessionRun
  } = useSidebarDerivedState({
    serviceScope,
    workspaceRuntimeFilter,
    orderedSavedWorkspaces,
    sessionsByWorkspaceId,
    workspace,
    workspaceRuntimes,
    session,
    sessionId,
    sessionRuns,
    sidebarSessionRunsById
  });
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
    return appControllerRequest<T>(connection, path, init, options);
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

  const {
    messagesNextCursor,
    messagesLoading,
    loadingOlderMessages,
    setMessagesLoading,
    refreshMessages,
    loadOlderMessages,
    resetMessagePaging,
    mergeMessagePageCursor
  } = useSessionMessages({
    sessionId,
    activeSessionIdRef,
    request,
    setMessages,
    setLiveMessagesByKey,
    clearActiveError,
    reportError
  });

  const { refreshSessionRuns, refreshSidebarSessionRuns, refreshRun, refreshRunSteps, refreshSessionQueue } =
    useSessionRunActions({
      sessionId,
      selectedRunId,
      activeSessionIdRef,
      visibleSidebarSessionIds,
      savedSessions,
      sessionsByWorkspaceId,
      sidebarSessionRunsById,
      request,
      clearActiveError,
      reportError,
      setSelectedRunId,
      setSessionRuns,
      setRun,
      setRunSteps,
      setSessionQueuedRuns,
      setSavedSessions,
      setSidebarSessionRunsById
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
    resetMessagePaging();
    setMessagesLoading(false);
  }, [activeWorkspaceId, normalizedServiceScope, resetMessagePaging, savedWorkspaces, setCatalog, setSession, setSessionId, setWorkspace, setWorkspaceId, workspace]);

  const storageInspectionEnabled = systemProfile?.capabilities.storageInspection ?? true;

  useEffect(() => {
    if (!storageInspectionEnabled && surfaceMode === "storage") {
      setSurfaceMode("engine");
    }
  }, [setSurfaceMode, storageInspectionEnabled, surfaceMode]);

  const storageController = useStorageController({
    connection,
    enabled: surfaceMode === "storage" && storageInspectionEnabled,
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

  async function downloadSessionTrace() {
    const targetSessionId = session?.id?.trim();
    const exportMessages = targetSessionId ? await listAllSessionMessages({ request, sessionId: targetSessionId }) : messages;
    const selectedOrLatestRunId = run?.id ?? (selectedRunIdValue || "latest");
    const exportPayload = buildSessionTraceExportPayload({
      messages: exportMessages,
      workspace,
      session,
      run,
      selectedOrLatestRunId,
      latestModelCallTrace,
      currentSessionName
    });

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

  const { pingHealth, refreshModelProviders, refreshPlatformModels, handlePlatformModelSnapshot } = useSystemModelActions({
    connection,
    request,
    setActivity,
    clearActiveError,
    reportError,
    setHealthStatus,
    setSystemProfile,
    setHealthReport,
    setReadinessReport,
    setModelProviders,
    setPlatformModels
  });

  const { sessionAgentSwitchRef, sessionModelUpdateRef, switchSessionAgent, updateSessionModel } =
    useSessionSettingsActions({
      sessionId,
      session,
      refreshSessionRuns,
      refreshSessionById: navigationActions.refreshSession,
      switchSessionAgentById: navigationActions.switchSessionAgent,
      updateSessionModelById: navigationActions.updateSessionModel,
      setSession,
      setPendingSessionAgentName,
      setSwitchingSessionAgentId,
      setPendingSessionModelRef,
      setSwitchingSessionModelId
    });

  const { sendMessage, guideMessage, answerAskUserQuestion, guideQueuedSessionInput, cancelCurrentRun } =
    useSessionSubmitActions({
      sessionId,
      selectedRunId,
      sessionAgentSwitchRef,
      sessionModelUpdateRef,
      shouldAutoFollowConversationRef,
      request,
      refreshMessages,
      refreshSessionRuns,
      refreshRun,
      refreshRunSteps,
      refreshSessionQueue,
      setActivity,
      clearActiveError,
      reportError,
      openConsoleForErrors,
      setSelectedRunId,
      setLiveMessagesByKey,
      setSessionQueuedRuns,
      setStreamRevision
    });

  const { refreshSessionTerminal, sendSessionTerminalInput, triggerWorkspaceAction, generateOnce } =
    useSessionUtilityActions({
      sessionId,
      session,
      modelDraft,
      request,
      refreshSessionById: navigationActions.refreshSession,
      refreshSessionRuns,
      refreshRun,
      refreshRunSteps,
      setActivity,
      clearActiveError,
      reportError,
      openConsoleForErrors,
      setSelectedRunId,
      setGenerateOutput,
      setGenerateBusy
    });

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

  const handleSessionEvent = useSessionEventHandler({
    sessionId,
    messages,
    liveMessagesByKey,
    lastCursorRef,
    setEvents,
    setSelectedRunId,
    setMessages,
    setLiveMessagesByKey,
    setSessionQueuedRuns,
    setActivity,
    scheduleMessagesRefresh,
    scheduleRunRefresh,
    scheduleWorkspaceIndexRefresh,
    refreshSessionQueue,
    refreshSessionRuns,
    refreshSidebarSessionRuns,
    refreshSessionById: navigationActions.refreshSession,
    syncCurrentSessionAgent
  });

  usePlatformModelStream({
    connection,
    onSnapshot: handlePlatformModelSnapshot
  });

  useSessionEventStream({
    connection,
    sessionId,
    sessionRecordId: session?.id,
    streamRevision,
    streamAbortRef,
    lastCursorRef,
    setStreamState,
    onFrame: handleSessionEvent,
    onMissingSession: () => {
      navigationActions.clearSessionSelection(sessionId, { forgetSession: true });
      setActivity(`Session ${sessionId} 不存在，已清除本地选择`);
      clearActiveError();
    },
    reportError,
    openConsoleForErrors
  });

  useSelectedRunPolling({
    connection,
    sessionId,
    selectedRunIdValue,
    run,
    streamState,
    request,
    runPollingTimerRef,
    mergeMessagePageCursor,
    reportError,
    setRun,
    setSessionRuns,
    setRunSteps,
    setMessages,
    setLiveMessagesByKey
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
    resetMessagePaging();

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
    void pingHealth();
    void navigationActions.refreshWorkspaceIndex(true);
    void navigationActions.refreshWorkspaceRuntimes(true);
    void refreshModelProviders(true);
    void refreshPlatformModels(true);
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
    let cancelled = false;
    let timer: number | undefined;

    async function refreshLoop() {
      if (cancelled) {
        return;
      }

      const hasNonTerminalSidebarRun = await refreshSidebarSessionRuns(true);

      if (cancelled) {
        return;
      }

      timer = window.setTimeout(refreshLoop, hasNonTerminalSidebarRun ? 2_000 : 10_000);
    }

    void refreshLoop();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connection.baseUrl, connection.token, visibleSidebarSessionKey]);

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
  const handleAnswerAskUserQuestion = useEffectEvent((answer: string) => {
    void answerAskUserQuestion(answer);
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
  const {
    consolePanelProps,
    providerSurfaceProps,
    runtimeDetailSurfaceProps,
    sidebarSurfaceProps
  } = useAppControllerSurfaceProps({
    activeWorkspaceId,
    allAdvertisedToolNames,
    allEngineToolNames,
    allEngineTools,
    allToolServers,
    catalog,
    composedSystemMessages,
    consoleEntries,
    consoleOpen,
    conversationTailRef,
    conversationThreadRef,
    currentSessionName,
    currentWorkspaceName,
    deferredEvents,
    downloadSessionTrace,
    events,
    expandedSessionIds,
    expandedWorkspaceIds,
    filteredSavedSessionsCount,
    filteredSavedWorkspaces,
    firstModelCallTrace,
    handleAnswerAskUserQuestion,
    handleCancelCurrentRun,
    handleGenerateOnce,
    handleGuideMessage,
    handleGuideQueuedSessionInput,
    handleInspectConsoleEntry,
    handleLoadOlderMessages,
    handlePingHealth,
    handleRefreshMessages,
    handleRefreshModelProviders,
    handleRefreshPlatformModels,
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
    modelProviders,
    navigationActions,
    normalizedServiceScope,
    openConsoleForErrors,
    orderedSavedWorkspaces,
    pendingSessionAgentName,
    refreshSessionTerminal,
    resolvedModelNames,
    resolvedModelRefs,
    savedSessions,
    selectedMessageSystemMessages,
    selectedModelCallTrace,
    selectedRunStep,
    selectedServiceScopeLabel,
    selectedSessionEvent,
    selectedSessionMessage,
    sendSessionTerminalInput,
    serviceScopeOptions,
    session,
    sessionId,
    sessionQueuedRuns,
    sessionRuns,
    sessionsByWorkspaceId,
    setExpandedSessionIds,
    setMainViewMode,
    setShowWorkspaceCreator,
    setSurfaceMode,
    setWorkspaceDraft,
    shouldAutoFollowConversationRef,
    showWorkspaceCreator,
    sidebarSessionRuns,
    storageController,
    storageInspectionEnabled,
    storedMessageCounts,
    surfaceMode,
    switchingSessionAgentId,
    switchingSessionModelId,
    systemProfile,
    triggerWorkspaceAction,
    workspace,
    workspaceDraft,
    workspaceFileManager,
    workspaceId,
    workspaceManagementEnabled,
    workspaceRuntimeFilterOptions,
    workspaceRuntimes
  });

  return {
    errorMessage,
    activeError,
    surfaceMode,
    storageSurfaceProps: storageController.storageSurfaceProps,
    providerSurfaceProps,
    sidebarSurfaceProps,
    runtimeDetailSurfaceProps,
    consolePanelProps
  };
}
