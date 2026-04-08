import { MessageSquareText, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { useAppController } from "../use-app-controller";
import { ConversationWorkspace } from "../chat/ConversationWorkspace";
import { InspectorWorkspace } from "../inspector/InspectorWorkspace";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];
const AUTO_SESSION_MODEL_VALUE = "__session_model_auto__";

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
  const sessionModelOptions = [
    ...new Map(
      (sessionWorkspaceCatalog?.models ?? [])
        .map((model) => [model.ref, model] as const)
        .concat(
          props.session?.modelRef
            ? [
                [
                  props.session.modelRef,
                  {
                    ref: props.session.modelRef,
                    name: props.session.modelRef.replace(/^(platform|workspace)\//, ""),
                    source: props.session.modelRef.startsWith("workspace/") ? "workspace" : "platform",
                    provider: "custom"
                  }
                ] as const
              ]
            : []
        )
    ).values()
  ].sort((left, right) => {
    if (left.source === right.source) {
      return left.name.localeCompare(right.name);
    }

    return left.source === "workspace" ? -1 : 1;
  });
  const selectedSessionModelValue = props.pendingSessionModelRef ?? props.session?.modelRef ?? AUTO_SESSION_MODEL_VALUE;
  const sessionModelLocked =
    props.messages.length > 0 ||
    props.sessionRuns.length > 0 ||
    (props.run?.sessionId != null && props.run.sessionId === props.session?.id) ||
    props.isRunning;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="app-toolbar-strip flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-5">
        <Tabs value={props.mainViewMode} onValueChange={(value) => props.setMainViewMode(value as RuntimeProps["mainViewMode"])}>
          <TabsList className="h-9 rounded-2xl p-1">
            <TabsTrigger value="conversation" className="h-7 rounded-xl px-3 text-xs">
              <MessageSquareText className="h-4 w-4" />
              Conversation
            </TabsTrigger>
            <TabsTrigger value="inspector" className="h-7 rounded-xl px-3 text-xs">
              <Sparkles className="h-4 w-4" />
              Inspector
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          {props.mainViewMode === "conversation" ? (
            props.hasActiveSession ? (
              <>
                <span className="text-xs text-muted-foreground">{props.messages.length} messages</span>
                {agentSelectorSession ? (
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedSessionModelValue}
                      disabled={!props.session || props.isSwitchingSessionModel || sessionModelLocked}
                      onValueChange={(value) => {
                        if (!props.session) {
                          return;
                        }

                        const nextModelRef = value === AUTO_SESSION_MODEL_VALUE ? null : value;
                        const currentModelRef = props.session.modelRef ?? null;
                        if (nextModelRef !== currentModelRef) {
                          props.updateSessionModel(props.session.id, nextModelRef);
                        }
                      }}
                    >
                      <SelectTrigger className="min-w-44" size="sm" aria-label="Session model">
                        <SelectValue placeholder="Select model">
                          {selectedSessionModelValue === AUTO_SESSION_MODEL_VALUE
                            ? "Model · Auto"
                            : `Model · ${
                                sessionModelOptions.find((model) => model.ref === selectedSessionModelValue)?.name ??
                                selectedSessionModelValue
                              }`}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO_SESSION_MODEL_VALUE}>Auto · workspace / agent default</SelectItem>
                        {sessionModelOptions.map((model) => (
                          <SelectItem key={model.ref} value={model.ref}>
                            {model.name} · {model.source} · {model.provider}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                    ) : props.isSwitchingSessionModel ? (
                      <span className="text-xs text-muted-foreground">Updating model…</span>
                    ) : props.isRunning ? (
                      <span className="text-xs text-muted-foreground">Applies to the next run</span>
                    ) : null}
                  </div>
                ) : (
                  <Badge variant="secondary">{selectedAgentName || "no agent"}</Badge>
                )}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Choose a session to start</span>
            )
          ) : props.hasActiveSession ? (
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
                <Select
                  value={selectedSessionModelValue}
                  disabled={!props.session || props.isSwitchingSessionModel || sessionModelLocked}
                  onValueChange={(value) => {
                    if (!props.session) {
                      return;
                    }

                    const nextModelRef = value === AUTO_SESSION_MODEL_VALUE ? null : value;
                    const currentModelRef = props.session.modelRef ?? null;
                    if (nextModelRef !== currentModelRef) {
                      props.updateSessionModel(props.session.id, nextModelRef);
                    }
                  }}
                >
                  <SelectTrigger className="min-w-44" size="sm" aria-label="Session model">
                    <SelectValue placeholder="Select model">
                      {selectedSessionModelValue === AUTO_SESSION_MODEL_VALUE
                        ? "Model · Auto"
                        : `Model · ${
                            sessionModelOptions.find((model) => model.ref === selectedSessionModelValue)?.name ??
                            selectedSessionModelValue
                          }`}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_SESSION_MODEL_VALUE}>Auto · workspace / agent default</SelectItem>
                    {sessionModelOptions.map((model) => (
                      <SelectItem key={model.ref} value={model.ref}>
                        {model.name} · {model.source} · {model.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {props.isSwitchingSessionAgent ? (
                  <span className="text-xs text-muted-foreground">Updating…</span>
                ) : props.isSwitchingSessionModel ? (
                  <span className="text-xs text-muted-foreground">Updating model…</span>
                ) : props.isRunning ? (
                  <span className="text-xs text-muted-foreground">Applies to the next run</span>
                ) : null}
              </div>
            ) : (
              <Badge variant="secondary">{selectedAgentName || "no agent"}</Badge>
            )
          ) : null}
          {props.mainViewMode === "inspector" ? (
            <>
              <Badge variant="secondary">{props.runSteps.length} steps</Badge>
              <Badge variant="secondary">{props.deferredEvents.length} events</Badge>
            </>
          ) : null}
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
