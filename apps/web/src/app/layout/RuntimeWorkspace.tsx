import { MessageSquareText, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { useAppController } from "../use-app-controller";
import { ConversationWorkspace } from "../chat/ConversationWorkspace";
import { InspectorWorkspace } from "../inspector/InspectorWorkspace";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

export function RuntimeWorkspace(props: RuntimeProps) {
  const selectedAgentName = props.session?.activeAgentName ?? props.run?.effectiveAgentName ?? "";
  const workspacePrimaryAgents = (props.catalog?.agents ?? []).filter(
    (agent) => agent.mode === "primary" && agent.source === "workspace"
  );
  const visiblePrimaryAgents =
    selectedAgentName && !workspacePrimaryAgents.some((agent) => agent.name === selectedAgentName)
      ? [
          ...workspacePrimaryAgents,
          ...(props.catalog?.agents ?? []).filter(
            (agent) => agent.mode === "primary" && agent.name === selectedAgentName
          )
        ]
      : workspacePrimaryAgents;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-5">
        <Tabs value={props.mainViewMode} onValueChange={(value) => props.setMainViewMode(value as RuntimeProps["mainViewMode"])}>
          <TabsList className="h-8">
            <TabsTrigger value="conversation" className="text-xs">
              <MessageSquareText className="h-4 w-4" />
              Conversation
            </TabsTrigger>
            <TabsTrigger value="inspector" className="text-xs">
              <Sparkles className="h-4 w-4" />
              Inspector
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          {props.hasActiveSession ? (
            visiblePrimaryAgents.length > 0 && props.session ? (
              <div className="flex items-center gap-2">
                <Select
                  value={selectedAgentName}
                  onValueChange={(value) => {
                    if (value !== props.session?.activeAgentName) {
                      props.switchSessionAgent(props.session.id, value);
                    }
                  }}
                >
                  <SelectTrigger className="min-w-36" size="sm" aria-label="Session agent">
                    <SelectValue placeholder="Select agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {visiblePrimaryAgents.map((agent) => (
                      <SelectItem key={agent.name} value={agent.name}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {props.isRunning ? <span className="text-xs text-muted-foreground">Applies to the next run</span> : null}
              </div>
            ) : (
              <Badge variant="secondary">{selectedAgentName || "no agent"}</Badge>
            )
          ) : null}
          {props.selectedRunId ? <Badge variant="outline">run {props.selectedRunId}</Badge> : null}
          {props.mainViewMode === "inspector" ? (
            <>
              <Badge variant="secondary">{props.runSteps.length} steps</Badge>
              <Badge variant="secondary">{props.deferredEvents.length} events</Badge>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {props.hasActiveSession ? `${props.messages.length} messages` : "Choose a session to start"}
            </span>
          )}
        </div>
      </div>

      {props.mainViewMode === "conversation" ? (
        <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
          <ConversationWorkspace {...props} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-5 md:py-5">
          <InspectorWorkspace {...props} />
        </div>
      )}
    </section>
  );
}
