import { memo } from "react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  OverviewWorkbench,
  TimelineWorkbench,
  WorkspaceWorkbench
} from "../inspector-panels";
import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { statusTone } from "../support";
import type { useAppController } from "../use-app-controller";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

function InspectorWorkspaceImpl(props: RuntimeProps) {
  const inspectorTab = useUiStore((state) => state.inspectorTab);
  const setInspectorTab = useUiStore((state) => state.setInspectorTab);
  const timelineInspectorMode = useUiStore((state) => state.timelineInspectorMode);
  const setTimelineInspectorMode = useUiStore((state) => state.setTimelineInspectorMode);
  const setSelectedTraceId = useUiStore((state) => state.setSelectedTraceId);
  const setSelectedMessageId = useUiStore((state) => state.setSelectedMessageId);
  const setSelectedStepId = useUiStore((state) => state.setSelectedStepId);
  const setSelectedEventId = useUiStore((state) => state.setSelectedEventId);
  const messages = useStreamStore((state) => state.messages);
  const run = useStreamStore((state) => state.run);
  const runSteps = useStreamStore((state) => state.runSteps);
  const selectedRunId = useStreamStore((state) => state.selectedRunId);
  const setSelectedRunId = useStreamStore((state) => state.setSelectedRunId);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Tabs value={inspectorTab} onValueChange={(value) => setInspectorTab(value as RuntimeProps["inspectorTab"])} className="flex min-h-0 flex-1 flex-col">
        <div className="app-toolbar-strip px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <TabsList variant="line" className="gap-1 p-0">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="workspace">Workspace</TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap gap-2">
              {props.session?.id ? <Badge variant="outline">{props.session.id}</Badge> : null}
              {selectedRunId || run?.id ? <Badge variant="outline">{selectedRunId || run?.id}</Badge> : null}
              {run?.status ? <Badge className={statusTone(run.status)}>{run.status}</Badge> : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="secondary">messages {messages.length}</Badge>
            <Badge variant="secondary">calls {props.modelCallTraces.length}</Badge>
            <Badge variant="secondary">steps {runSteps.length}</Badge>
            <Badge variant="secondary">events {props.deferredEvents.length}</Badge>
            <span className="self-center text-xs text-muted-foreground">{props.inspectorSubtitle}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
            <TabsContent value="overview">
              <OverviewWorkbench
                session={props.session}
                run={run}
                workspace={props.workspace}
                sessionName={props.currentSessionName}
                workspaceName={props.currentWorkspaceName}
                selectedRunId={selectedRunId}
                sessionRuns={props.sessionRuns}
                onSelectedRunIdChange={setSelectedRunId}
                onRefreshSessionRuns={props.refreshSessionRuns}
                onRefreshRun={props.refreshRun}
                onRefreshRunSteps={props.refreshRunSteps}
                onLoadRunById={props.refreshRunById}
                onLoadRunStepsById={props.refreshRunStepsById}
                onCancelRun={props.cancelCurrentRun}
                modelCallCount={props.modelCallTraces.length}
                stepCount={runSteps.length}
                eventCount={props.deferredEvents.length}
                messageCount={messages.length}
                latestEvent={props.latestEvent}
                events={props.deferredEvents}
                runSteps={runSteps}
                messages={messages}
                latestTrace={props.latestModelCallTrace}
                onOpenTimeline={() => setInspectorTab("timeline")}
              />
            </TabsContent>

            <TabsContent value="timeline">
              <TimelineWorkbench
                mode={timelineInspectorMode}
                onModeChange={setTimelineInspectorMode}
                systemMessages={props.composedSystemMessages}
                selectedMessageSystemMessages={props.selectedMessageSystemMessages}
                firstTrace={props.firstModelCallTrace}
                messages={messages}
                selectedMessage={props.selectedSessionMessage}
                onSelectMessage={setSelectedMessageId}
                traces={props.modelCallTraces}
                selectedTrace={props.selectedModelCallTrace}
                onSelectTrace={setSelectedTraceId}
                latestTrace={props.latestModelCallTrace}
                latestModelMessageCounts={props.latestModelMessageCounts}
                resolvedModelNames={props.resolvedModelNames}
                resolvedModelRefs={props.resolvedModelRefs}
                runtimeTools={props.allRuntimeTools}
                runtimeToolNames={props.allRuntimeToolNames}
                activeToolNames={props.allAdvertisedToolNames}
                toolServers={props.allToolServers}
                onDownload={props.downloadSessionTrace}
                steps={runSteps}
                selectedStep={props.selectedRunStep}
                onSelectStep={setSelectedStepId}
                events={props.deferredEvents}
                selectedEvent={props.selectedSessionEvent}
                onSelectEvent={setSelectedEventId}
              />
            </TabsContent>

            <TabsContent value="workspace">
              <WorkspaceWorkbench
                workspace={props.workspace}
                session={props.session}
                run={run}
                catalog={props.catalog}
                runtimeTools={props.allRuntimeTools}
                runtimeToolNames={props.allRuntimeToolNames}
                activeToolNames={props.allAdvertisedToolNames}
                toolServers={props.allToolServers}
                triggerWorkspaceAction={props.triggerWorkspaceAction}
                refreshWorkspace={props.refreshWorkspace}
              />
            </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

export const InspectorWorkspace = memo(InspectorWorkspaceImpl);
