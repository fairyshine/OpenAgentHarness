import type { Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type { CreateSessionParams, WorkspaceRecord } from "../types.js";

export function resolveWorkspaceDefaultAgentName(workspace: WorkspaceRecord): string | undefined {
  if (workspace.defaultAgent) {
    return workspace.defaultAgent;
  }

  const assistantAgent = workspace.agents.assistant;
  if (assistantAgent && assistantAgent.mode !== "subagent") {
    return assistantAgent.name;
  }

  return Object.values(workspace.agents)
    .filter((agent) => agent.mode === "primary" || agent.mode === "all")
    .sort((left, right) => left.name.localeCompare(right.name))
    .at(0)?.name;
}

export function buildSessionRecord(input: {
  workspace: WorkspaceRecord;
  caller: CreateSessionParams["caller"];
  sessionInput: CreateSessionParams["input"];
  normalizeModelRef: (workspace: WorkspaceRecord, modelRef?: string) => string | undefined;
  createId: (prefix: string) => string;
  nowIso: () => string;
}): Session {
  const { workspace, caller, sessionInput } = input;
  const activeAgentName = sessionInput.agentName ?? resolveWorkspaceDefaultAgentName(workspace);
  const modelRef = input.normalizeModelRef(workspace, sessionInput.modelRef);
  if (!activeAgentName) {
    throw new AppError(
      409,
      "missing_default_agent",
      `Workspace ${workspace.id} has no default agent. Provide agentName explicitly or configure .openharness/settings.yaml.`
    );
  }

  if (Object.keys(workspace.agents).length > 0 && !workspace.agents[activeAgentName]) {
    throw new AppError(404, "agent_not_found", `Agent ${activeAgentName} was not found in workspace ${workspace.id}.`);
  }

  const initialAgent = workspace.agents[activeAgentName];
  if (initialAgent?.mode === "subagent") {
    throw new AppError(
      409,
      "invalid_session_agent_target",
      `Agent ${activeAgentName} is a subagent and cannot be set as the active session agent.`
    );
  }

  const now = input.nowIso();
  return {
    id: input.createId("ses"),
    workspaceId: workspace.id,
    subjectRef: caller.subjectRef,
    ...(modelRef ? { modelRef } : {}),
    agentName: sessionInput.agentName,
    activeAgentName,
    title: sessionInput.title,
    status: "active",
    createdAt: now,
    updatedAt: now
  };
}
