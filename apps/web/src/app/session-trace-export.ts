import type { Message, Run, Session, Workspace } from "@oah/api-contracts";

import { buildAiSdkLikeRequest, buildAiSdkLikeStoredMessages } from "./primitives";
import type { ModelCallTrace } from "./support";

export function buildSessionTraceExportPayload(input: {
  messages: Message[];
  workspace: Workspace | null | undefined;
  session: Session | null | undefined;
  run: Run | null | undefined;
  selectedOrLatestRunId: string;
  latestModelCallTrace: ModelCallTrace | null;
  currentSessionName: string;
}) {
  const latestRequest = buildAiSdkLikeRequest(input.latestModelCallTrace);

  return {
    format: "oah.ai-sdk-session.v2",
    exportedAt: new Date().toISOString(),
    basic: {
      workspace: input.workspace
        ? {
            id: input.workspace.id,
            name: input.workspace.name,
            kind: input.workspace.kind,
            rootPath: input.workspace.rootPath,
            readOnly: input.workspace.readOnly
          }
        : null,
      session: input.session
        ? {
            id: input.session.id,
            title: input.session.title ?? input.currentSessionName,
            workspaceId: input.session.workspaceId,
            modelRef: input.session.modelRef,
            agentName: input.session.agentName,
            activeAgentName: input.session.activeAgentName,
            status: input.session.status,
            createdAt: input.session.createdAt,
            updatedAt: input.session.updatedAt
          }
        : null,
      run: input.run
        ? {
            id: input.run.id,
            sessionId: input.run.sessionId,
            parentRunId: input.run.parentRunId,
            agentName: input.run.agentName,
            effectiveAgentName: input.run.effectiveAgentName,
            status: input.run.status,
            startedAt: input.run.startedAt,
            heartbeatAt: input.run.heartbeatAt,
            endedAt: input.run.endedAt
          }
        : {
            id: input.selectedOrLatestRunId
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
    Messages: buildAiSdkLikeStoredMessages(input.messages)
  };
}
