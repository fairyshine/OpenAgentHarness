import { MessageSquareText, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { useAppController } from "../use-app-controller";
import { ConversationWorkspace } from "../chat/ConversationWorkspace";
import { InspectorWorkspace } from "../inspector/InspectorWorkspace";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

function sessionAgentLabel(agent: { name: string; mode: "primary" | "subagent" | "all" }) {
  return `${agent.name} · ${agent.mode}`;
}

export function RuntimeWorkspace(props: RuntimeProps) {
  const sessionWorkspaceCatalog =
    props.session && (props.workspace?.id === props.session.workspaceId || props.workspaceId === props.session.workspaceId)
      ? props.catalog
      : null;
  const selectedAgentName = props.pendingSessionAgentName ?? props.session?.activeAgentName ?? props.run?.effectiveAgentName ?? "";
  const visibleSessionAgents = [...new Map(
    (sessionWorkspaceCatalog?.agents ?? [])
      .filter((agent) => agent.mode === "primary" || agent.mode === "all")
      .sort((left, right) => {
        if (left.source === right.source) {
          return left.name.localeCompare(right.name);
        }

        return left.source === "workspace" ? -1 : 1;
      })
      .map((agent) => [agent.name, agent] as const)
  ).values()];
  const selectedAgent = visibleSessionAgents.find((agent) => agent.name === selectedAgentName);
  const selectedAgentValue = selectedAgent?.name;
  const agentSelectorSession = visibleSessionAgents.length > 0 && props.session ? props.session : null;

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
            agentSelectorSession ? (
              <div className="flex items-center gap-2">
                <Select
                  {...(selectedAgentValue ? { value: selectedAgentValue } : {})}
                  disabled={props.isSwitchingSessionAgent}
                  onValueChange={(value) => {
                    if (value !== agentSelectorSession.activeAgentName) {
                      props.switchSessionAgent(agentSelectorSession.id, value);
                    }
                  }}
                >
                  <SelectTrigger className="min-w-36" size="sm" aria-label="Session agent">
                    <SelectValue placeholder="Select agent">{selectedAgent ? sessionAgentLabel(selectedAgent) : undefined}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {visibleSessionAgents.map((agent) => (
                      <SelectItem key={agent.name} value={agent.name}>
                        {sessionAgentLabel(agent)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {props.isSwitchingSessionAgent ? (
                  <span className="text-xs text-muted-foreground">Updating…</span>
                ) : props.isRunning ? (
                  <span className="text-xs text-muted-foreground">Applies to the next run</span>
                ) : null}
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
