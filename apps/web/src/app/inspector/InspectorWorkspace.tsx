import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  OverviewWorkbench,
  TimelineWorkbench,
  WorkspaceWorkbench
} from "../inspector-panels";
import { statusTone } from "../support";
import type { useAppController } from "../use-app-controller";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

export function InspectorWorkspace(props: RuntimeProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Tabs value={props.inspectorTab} onValueChange={(value) => props.setInspectorTab(value as RuntimeProps["inspectorTab"])} className="flex min-h-0 flex-1 flex-col">
        <div className="app-toolbar-strip px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <TabsList variant="line" className="gap-1 p-0">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="workspace">Workspace</TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap gap-2">
              {props.session?.id ? <Badge variant="outline">{props.session.id}</Badge> : null}
              {props.selectedRunId || props.run?.id ? <Badge variant="outline">{props.selectedRunId || props.run?.id}</Badge> : null}
              {props.run?.status ? <Badge className={statusTone(props.run.status)}>{props.run.status}</Badge> : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="secondary">messages {props.messages.length}</Badge>
            <Badge variant="secondary">calls {props.modelCallTraces.length}</Badge>
            <Badge variant="secondary">steps {props.runSteps.length}</Badge>
            <Badge variant="secondary">events {props.deferredEvents.length}</Badge>
            <span className="self-center text-xs text-muted-foreground">{props.inspectorSubtitle}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
            <TabsContent value="overview">
              <OverviewWorkbench
                session={props.session}
                run={props.run}
                workspace={props.workspace}
                sessionName={props.currentSessionName}
                workspaceName={props.currentWorkspaceName}
                selectedRunId={props.selectedRunId}
                sessionRuns={props.sessionRuns}
                onSelectedRunIdChange={props.setSelectedRunId}
                onRefreshSessionRuns={props.refreshSessionRuns}
                onRefreshRun={props.refreshRun}
                onRefreshRunSteps={props.refreshRunSteps}
                onLoadRunById={props.refreshRunById}
                onLoadRunStepsById={props.refreshRunStepsById}
                onCancelRun={props.cancelCurrentRun}
                modelCallCount={props.modelCallTraces.length}
                stepCount={props.runSteps.length}
                eventCount={props.deferredEvents.length}
                messageCount={props.messages.length}
                latestEvent={props.latestEvent}
                events={props.deferredEvents}
                runSteps={props.runSteps}
                messages={props.messages}
                latestTrace={props.latestModelCallTrace}
                onOpenTimeline={() => props.setInspectorTab("timeline")}
              />
            </TabsContent>

            <TabsContent value="timeline">
              <TimelineWorkbench
                mode={props.timelineInspectorMode}
                onModeChange={props.setTimelineInspectorMode}
                systemMessages={props.composedSystemMessages}
                selectedMessageSystemMessages={props.selectedMessageSystemMessages}
                firstTrace={props.firstModelCallTrace}
                messages={props.messages}
                selectedMessage={props.selectedSessionMessage}
                onSelectMessage={props.setSelectedMessageId}
                traces={props.modelCallTraces}
                selectedTrace={props.selectedModelCallTrace}
                onSelectTrace={props.setSelectedTraceId}
                latestTrace={props.latestModelCallTrace}
                latestModelMessageCounts={props.latestModelMessageCounts}
                resolvedModelNames={props.resolvedModelNames}
                resolvedModelRefs={props.resolvedModelRefs}
                runtimeTools={props.allRuntimeTools}
                runtimeToolNames={props.allRuntimeToolNames}
                activeToolNames={props.allAdvertisedToolNames}
                toolServers={props.allToolServers}
                onDownload={props.downloadSessionTrace}
                steps={props.runSteps}
                selectedStep={props.selectedRunStep}
                onSelectStep={props.setSelectedStepId}
                events={props.deferredEvents}
                selectedEvent={props.selectedSessionEvent}
                onSelectEvent={props.setSelectedEventId}
              />
            </TabsContent>

            <TabsContent value="workspace">
              <WorkspaceWorkbench
                workspace={props.workspace}
                session={props.session}
                run={props.run}
                catalog={props.catalog}
                runtimeTools={props.allRuntimeTools}
                runtimeToolNames={props.allRuntimeToolNames}
                activeToolNames={props.allAdvertisedToolNames}
                toolServers={props.allToolServers}
                refreshWorkspace={props.refreshWorkspace}
              />
            </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
