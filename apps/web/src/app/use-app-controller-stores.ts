import { useShallow } from "zustand/shallow";

import { useHealthStore } from "./stores/health-store";
import { useModelsStore } from "./stores/models-store";
import { useSessionAgentStore } from "./stores/session-agent-store";
import { useSettingsStore } from "./stores/settings-store";
import { useStreamStore } from "./stores/stream-store";
import { useUiStore } from "./stores/ui-store";

function useAppControllerStores() {
  const settings = useSettingsStore(
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
  const stream = useStreamStore(
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
  const health = useHealthStore(
    useShallow((state) => ({
      healthStatus: state.healthStatus,
      systemProfile: state.systemProfile,
      healthReport: state.healthReport,
      readinessReport: state.readinessReport,
      setHealthStatus: state.setHealthStatus,
      setSystemProfile: state.setSystemProfile,
      setHealthReport: state.setHealthReport,
      setReadinessReport: state.setReadinessReport
    }))
  );
  const models = useModelsStore(
    useShallow((state) => ({
      modelProviders: state.modelProviders,
      platformModels: state.platformModels,
      setModelProviders: state.setModelProviders,
      setPlatformModels: state.setPlatformModels
    }))
  );
  const ui = useUiStore(
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
  const sessionAgent = useSessionAgentStore(
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

  return {
    health,
    models,
    sessionAgent,
    settings,
    stream,
    ui
  };
}

export { useAppControllerStores };
