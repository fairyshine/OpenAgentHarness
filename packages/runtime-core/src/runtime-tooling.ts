import type { Run, Session } from "@oah/api-contracts";

import { createRunActionTool } from "./action-dispatch.js";
import { createAgentSwitchTool, createSubAgentTool } from "./agent-control.js";
import { AppError } from "./errors.js";
import {
  createNativeToolSet,
  getNativeToolRetryPolicy,
  isNativeToolName,
  NATIVE_TOOL_NAMES
} from "./native-tools.js";
import { createDynamicActivateSkillTool } from "./skill-activation.js";
import type {
  ActionDefinition,
  ActionRetryPolicy,
  ModelGateway,
  RuntimeToolExecutionContext,
  RuntimeToolSet,
  SkillDefinition,
  ToolServerDefinition,
  WorkspaceRecord
} from "./types.js";

export type RuntimeToolSourceType = "action" | "skill" | "agent" | "tool" | "native";

function configuredAgentActions(workspace: WorkspaceRecord, activeAgentName: string): string[] {
  const activeAgent = workspace.agents[activeAgentName];
  return activeAgent?.actions ?? activeAgent?.tools?.actions ?? [];
}

function configuredAgentSkills(workspace: WorkspaceRecord, activeAgentName: string): string[] {
  const activeAgent = workspace.agents[activeAgentName];
  return activeAgent?.skills ?? activeAgent?.tools?.skills ?? [];
}

function excludedActionNames(workspace: WorkspaceRecord, activeAgentName: string): Set<string> {
  return new Set(workspace.agents[activeAgentName]?.disallowed?.actions ?? []);
}

function excludedSkillNames(workspace: WorkspaceRecord, activeAgentName: string): Set<string> {
  return new Set(workspace.agents[activeAgentName]?.disallowed?.skills ?? []);
}

function excludedExternalToolServerNames(workspace: WorkspaceRecord, activeAgentName: string): Set<string> {
  return new Set(workspace.agents[activeAgentName]?.disallowed?.tools?.external ?? []);
}

function excludedNativeToolNames(workspace: WorkspaceRecord, activeAgentName: string): Set<string> {
  return new Set(workspace.agents[activeAgentName]?.disallowed?.tools?.native ?? []);
}

export function visibleSkills(
  workspace: WorkspaceRecord,
  activeAgentName: string
): WorkspaceRecord["skills"][string][] {
  const configuredSkills = configuredAgentSkills(workspace, activeAgentName);
  const excludedSkills = excludedSkillNames(workspace, activeAgentName);
  if (configuredSkills.length === 0) {
    return Object.values(workspace.skills).filter((skill) => !excludedSkills.has(skill.name));
  }

  return configuredSkills.map((skillName) => {
    const skill = workspace.skills[skillName];
    if (!skill) {
      throw new AppError(404, "skill_not_found", `Skill ${skillName} was not found in workspace ${workspace.id}.`);
    }
    if (excludedSkills.has(skillName)) {
      throw new AppError(409, "skill_disallowed", `Skill ${skillName} is disallowed for agent ${activeAgentName}.`);
    }

    return skill;
  });
}

export function visibleLlmSkills(
  workspace: WorkspaceRecord,
  activeAgentName: string
): WorkspaceRecord["skills"][string][] {
  return visibleSkills(workspace, activeAgentName).filter((skill) => skill.exposeToLlm !== false);
}

export function visibleActions(
  workspace: WorkspaceRecord,
  activeAgentName: string
): WorkspaceRecord["actions"][string][] {
  const configuredActions = configuredAgentActions(workspace, activeAgentName);
  const excludedActions = excludedActionNames(workspace, activeAgentName);
  if (configuredActions.length === 0) {
    return Object.values(workspace.actions).filter((action) => !excludedActions.has(action.name));
  }

  return configuredActions.map((actionName) => {
    const action = workspace.actions[actionName];
    if (!action) {
      throw new AppError(404, "action_not_found", `Action ${actionName} was not found in workspace ${workspace.id}.`);
    }
    if (excludedActions.has(actionName)) {
      throw new AppError(409, "action_disallowed", `Action ${actionName} is disallowed for agent ${activeAgentName}.`);
    }

    return action;
  });
}

export function visibleLlmActions(
  workspace: WorkspaceRecord,
  activeAgentName: string
): WorkspaceRecord["actions"][string][] {
  return visibleActions(workspace, activeAgentName).filter((action) => action.exposeToLlm);
}

export function visibleToolServers(
  workspace: WorkspaceRecord,
  activeAgentName: string
): WorkspaceRecord["toolServers"][string][] {
  const configuredToolServers = workspace.agents[activeAgentName]?.tools?.external ?? [];
  const excludedToolServers = excludedExternalToolServerNames(workspace, activeAgentName);
  if (configuredToolServers.length === 0) {
    return Object.values(workspace.toolServers).filter((server) => !excludedToolServers.has(server.name));
  }

  return configuredToolServers.map((serverName) => {
    const server = workspace.toolServers[serverName];
    if (!server) {
      throw new AppError(404, "tool_server_not_found", `Tool server ${serverName} was not found in workspace ${workspace.id}.`);
    }
    if (excludedToolServers.has(serverName)) {
      throw new AppError(
        409,
        "tool_server_disallowed",
        `Tool server ${serverName} is disallowed for agent ${activeAgentName}.`
      );
    }

    return server;
  });
}

export function visibleEnabledToolServers(
  workspace: WorkspaceRecord,
  activeAgentName: string
): WorkspaceRecord["toolServers"][string][] {
  return visibleToolServers(workspace, activeAgentName).filter((server) => server.enabled);
}

export function enabledToolServers(
  workspace: WorkspaceRecord
): WorkspaceRecord["toolServers"][string][] {
  return Object.values(workspace.toolServers).filter((server) => server.enabled);
}

export function visibleNativeToolNames(workspace: WorkspaceRecord, activeAgentName: string): string[] {
  const activeAgent = workspace.agents[activeAgentName];
  const configuredNativeTools = activeAgent?.tools?.native ?? [];
  const availableNativeTools = [...NATIVE_TOOL_NAMES];
  const excludedNativeTools = excludedNativeToolNames(workspace, activeAgentName);

  if (configuredNativeTools.length === 0) {
    return availableNativeTools.filter((toolName) => !excludedNativeTools.has(toolName));
  }

  return configuredNativeTools.map((toolName) => {
    if (!isNativeToolName(toolName)) {
      throw new AppError(
        404,
        "native_tool_not_found",
        `Native tool ${toolName} was not found in workspace ${workspace.id}.`
      );
    }
    if (excludedNativeTools.has(toolName)) {
      throw new AppError(409, "native_tool_disallowed", `Native tool ${toolName} is disallowed for agent ${activeAgentName}.`);
    }

    return toolName;
  });
}

export function canDelegateFromAgent(workspace: WorkspaceRecord, activeAgentName: string): boolean {
  const agent = workspace.agents[activeAgentName];
  return !!agent && agent.mode !== "subagent" && (agent.subagents?.length ?? 0) > 0;
}

export function activeToolNamesForAgent(
  workspace: WorkspaceRecord,
  activeAgentName: string
): string[] | undefined {
  if (visibleEnabledToolServers(workspace, activeAgentName).length > 0) {
    return undefined;
  }

  const names: string[] = [];
  names.push(...visibleNativeToolNames(workspace, activeAgentName));
  if (visibleLlmActions(workspace, activeAgentName).length > 0) {
    names.push("run_action");
  }
  if (visibleLlmSkills(workspace, activeAgentName).length > 0) {
    names.push("Skill");
  }
  if ((workspace.agents[activeAgentName]?.switch ?? []).length > 0) {
    names.push("AgentSwitch");
  }
  if (canDelegateFromAgent(workspace, activeAgentName)) {
    names.push("SubAgent");
  }
  return names.length > 0 ? names : undefined;
}

export function runtimeToolNamesForCatalog(workspace: WorkspaceRecord): string[] {
  const agentNames = Object.keys(workspace.agents);
  if (agentNames.length === 0) {
    return [...NATIVE_TOOL_NAMES];
  }

  const names = new Set<string>();
  for (const agentName of agentNames) {
    for (const toolName of visibleNativeToolNames(workspace, agentName)) {
      names.add(toolName);
    }
    if (visibleLlmActions(workspace, agentName).length > 0) {
      names.add("run_action");
    }
    if (visibleLlmSkills(workspace, agentName).length > 0) {
      names.add("Skill");
    }
    if ((workspace.agents[agentName]?.switch ?? []).length > 0) {
      names.add("AgentSwitch");
    }
    if (canDelegateFromAgent(workspace, agentName)) {
      names.add("SubAgent");
    }
  }

  return [...names];
}

export function buildEnvironmentMessage(workspace: WorkspaceRecord, activeAgentName: string): string {
  const activeAgent = workspace.agents[activeAgentName];
  const nativeTools = activeAgent ? visibleNativeToolNames(workspace, activeAgentName) : [];
  const actions = activeAgent ? visibleLlmActions(workspace, activeAgentName).map((action) => action.name) : [];
  const skills = activeAgent ? visibleLlmSkills(workspace, activeAgentName).map((skill) => skill.name) : [];
  const toolServers = activeAgent ? visibleToolServers(workspace, activeAgentName).map((server) => server.name) : [];

  return [
    "<environment>",
    `workspace_id: ${workspace.id}`,
    `workspace_root: ${workspace.rootPath}`,
    `workspace_kind: ${workspace.kind}`,
    `execution_policy: ${workspace.executionPolicy}`,
    `active_agent: ${activeAgentName}`,
    `available_native_tools: ${nativeTools.length > 0 ? nativeTools.join(", ") : "none"}`,
    `available_actions: ${actions.length > 0 ? actions.join(", ") : "none"}`,
    `available_skills: ${skills.length > 0 ? skills.join(", ") : "none"}`,
    `available_tool_servers: ${toolServers.length > 0 ? toolServers.join(", ") : "none"}`,
    "</environment>"
  ].join("\n");
}

export function toolSourceType(toolName: string): RuntimeToolSourceType {
  if (toolName === "run_action") {
    return "action";
  }

  if (toolName === "Skill") {
    return "skill";
  }

  if (toolName === "SubAgent" || toolName === "AgentSwitch" || toolName.startsWith("agent.")) {
    return "agent";
  }

  if (isNativeToolName(toolName)) {
    return "native";
  }

  return "tool";
}

export function toolRetryPolicy(
  workspace: WorkspaceRecord,
  toolName: string,
  input: unknown,
  definition?: RuntimeToolSet[string] | undefined
): ActionRetryPolicy {
  if (isNativeToolName(toolName)) {
    return getNativeToolRetryPolicy(toolName);
  }

  if (toolName === "run_action") {
    const actionInput =
      input && typeof input === "object" && !Array.isArray(input) ? (input as { name?: unknown }) : undefined;
    const actionName = typeof actionInput?.name === "string" ? actionInput.name : undefined;
    return actionName ? workspace.actions[actionName]?.retryPolicy ?? "manual" : "manual";
  }

  const definitionRetryPolicy = definition?.retryPolicy;
  return definitionRetryPolicy === "safe" || definitionRetryPolicy === "manual" ? definitionRetryPolicy : "manual";
}

export interface BuildRuntimeToolsInput {
  workspace: WorkspaceRecord;
  run: Run;
  session: Session;
  getCurrentAgentName: () => string;
  modelGateway: ModelGateway;
  defaultModel: string;
  executeAction: (
    action: ActionDefinition,
    input: unknown,
    context: RuntimeToolExecutionContext
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    output: string;
  }>;
  delegateAgent: (
    input: {
      targetAgentName?: string | undefined;
      task: string;
      handoffSummary?: string | undefined;
      taskId?: string | undefined;
      notifyParentOnCompletion?: boolean | undefined;
    },
    currentAgentName: string
  ) => Promise<{ childSessionId: string; childRunId: string; targetAgentName: string }>;
  awaitDelegatedRuns: (input: { runIds: string[]; mode: "all" | "any" }) => Promise<string>;
  switchAgent: (targetAgentName: string, currentAgentName: string) => Promise<void>;
  commandExecutor?: import("./types.js").WorkspaceCommandExecutor | undefined;
}

export function buildRuntimeTools(input: BuildRuntimeToolsInput): RuntimeToolSet {
  const { workspace, run, session, getCurrentAgentName, modelGateway, defaultModel } = input;
  return {
    ...createNativeToolSet(
      workspace.rootPath,
      () => visibleNativeToolNames(workspace, getCurrentAgentName()),
      {
        sessionId: session.id,
        modelGateway,
        webFetchModel: defaultModel,
        ...(input.commandExecutor ? { commandExecutor: input.commandExecutor } : {})
      }
    ),
    ...createRunActionTool(
      () => visibleLlmActions(workspace, getCurrentAgentName()),
      async (action, actionInput, context) => input.executeAction(action, actionInput, context)
    ),
    ...createDynamicActivateSkillTool(() => visibleLlmSkills(workspace, getCurrentAgentName())),
    ...createSubAgentTool(
      getCurrentAgentName,
      () => workspace.agents[getCurrentAgentName()],
      () => workspace.agents,
      async (agentInput, currentAgentName) => input.delegateAgent(agentInput, currentAgentName),
      async (awaitInput) => input.awaitDelegatedRuns(awaitInput)
    ),
    ...createAgentSwitchTool(
      getCurrentAgentName,
      () => workspace.agents[getCurrentAgentName()],
      () => workspace.agents,
      async (targetAgentName, currentAgentName) => input.switchAgent(targetAgentName, currentAgentName)
    )
  };
}
