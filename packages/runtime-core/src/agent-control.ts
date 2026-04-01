import { z } from "zod";

import { AppError } from "./errors.js";
import type { AgentDefinition, RuntimeToolSet } from "./types.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildAvailableAgentSwitchesMessage(
  currentAgentName: string,
  currentAgent: AgentDefinition | undefined,
  agents: Record<string, AgentDefinition>
): string {
  const switchTargets = currentAgent?.switch ?? [];
  if (switchTargets.length === 0) {
    return "";
  }

  const entries = switchTargets
    .map((agentName) => {
      const agent = agents[agentName];
      return [
        "  <agent>",
        `    <name>${escapeXml(agentName)}</name>`,
        ...(agent?.description ? [`    <description>${escapeXml(agent.description)}</description>`] : []),
        ...(agent?.mode ? [`    <mode>${escapeXml(agent.mode)}</mode>`] : []),
        "  </agent>"
      ].join("\n");
    })
    .join("\n");

  return [
    "## Switchable Agents",
    "",
    `<available_agent_switches current_agent="${escapeXml(currentAgentName)}">`,
    entries,
    "</available_agent_switches>",
    "",
    "When the task should continue under a different specialist persona, call `agent.switch` with one of the allowed target agent names.",
    "Only switch when the target agent is a better fit for the next step."
  ].join("\n");
}

export function buildAvailableSubagentsMessage(
  currentAgentName: string,
  currentAgent: AgentDefinition | undefined,
  agents: Record<string, AgentDefinition>
): string {
  const subagentTargets = currentAgent?.subagents ?? [];
  if (subagentTargets.length === 0) {
    return "";
  }

  const entries = subagentTargets
    .map((agentName) => {
      const agent = agents[agentName];
      return [
        "  <agent>",
        `    <name>${escapeXml(agentName)}</name>`,
        ...(agent?.description ? [`    <description>${escapeXml(agent.description)}</description>`] : []),
        ...(agent?.mode ? [`    <mode>${escapeXml(agent.mode)}</mode>`] : []),
        "  </agent>"
      ].join("\n");
    })
    .join("\n");

  return [
    "## Available Subagents",
    "",
    `<available_subagents current_agent="${escapeXml(currentAgentName)}">`,
    entries,
    "</available_subagents>",
    "",
    "When a bounded specialist task should run in the background, call `agent.delegate` with an allowed target agent and a concise task.",
    "When you need the result later in the same run, call `agent.await` with the delegated child run id."
  ].join("\n");
}

export function createAgentSwitchTool(
  getCurrentAgentName: () => string,
  getCurrentAgent: () => AgentDefinition | undefined,
  getAgents: () => Record<string, AgentDefinition>,
  switchAgent: (targetAgentName: string, currentAgentName: string) => Promise<void>
): RuntimeToolSet {
  return {
    "agent.switch": {
      description: "Switch the current run to another allowed agent persona within the same run.",
      inputSchema: z.object({
        agentName: z.string().min(1).describe("Name of the target agent to switch to.")
      }),
      async execute(rawInput) {
        const { agentName } = z
          .object({
            agentName: z.string().min(1)
          })
          .parse(rawInput);
        const currentAgentName = getCurrentAgentName();
        const currentAgent = getCurrentAgent();
        const agents = getAgents();
        const allowedTargets = currentAgent?.switch ?? [];

        if (!allowedTargets.includes(agentName)) {
          throw new AppError(
            403,
            "agent_switch_not_allowed",
            `Agent ${currentAgentName} is not allowed to switch to ${agentName}.`
          );
        }

        const targetAgent = agents[agentName];
        if (!targetAgent) {
          throw new AppError(404, "agent_not_found", `Agent ${agentName} was not found.`);
        }

        if (targetAgent.mode === "subagent") {
          throw new AppError(
            409,
            "invalid_agent_switch_target",
            `Agent ${agentName} is a subagent and cannot be used as a switch target.`
          );
        }

        await switchAgent(agentName, currentAgentName);
        return `<agent_switch from="${escapeXml(currentAgentName)}" to="${escapeXml(agentName)}" />`;
      }
    }
  };
}

export function createAgentDelegateTool(
  getCurrentAgentName: () => string,
  getCurrentAgent: () => AgentDefinition | undefined,
  getAgents: () => Record<string, AgentDefinition>,
  delegateAgent: (
    input: {
      targetAgentName: string;
      task: string;
      handoffSummary?: string | undefined;
    },
    currentAgentName: string
  ) => Promise<{
    childSessionId: string;
    childRunId: string;
  }>
): RuntimeToolSet {
  const inputSchema = z.object({
    agentName: z.string().min(1).describe("Name of the subagent to delegate to."),
    task: z.string().min(1).describe("Bounded task for the subagent to execute."),
    handoffSummary: z
      .string()
      .min(1)
      .optional()
      .describe("Optional compact handoff summary for the subagent.")
  });

  return {
    "agent.delegate": {
      description: "Delegate a bounded background task to an allowed subagent and return its child run id.",
      inputSchema,
      async execute(rawInput) {
        const { agentName, task, handoffSummary } = inputSchema.parse(rawInput);
        const currentAgentName = getCurrentAgentName();
        const currentAgent = getCurrentAgent();
        const agents = getAgents();
        const allowedTargets = currentAgent?.subagents ?? [];

        if (!allowedTargets.includes(agentName)) {
          throw new AppError(
            403,
            "agent_delegate_not_allowed",
            `Agent ${currentAgentName} is not allowed to delegate to ${agentName}.`
          );
        }

        const targetAgent = agents[agentName];
        if (!targetAgent) {
          throw new AppError(404, "agent_not_found", `Agent ${agentName} was not found.`);
        }

        if (targetAgent.mode === "primary") {
          throw new AppError(
            409,
            "invalid_subagent_target",
            `Agent ${agentName} is a primary agent and cannot be used as a subagent target.`
          );
        }

        const accepted = await delegateAgent(
          {
            targetAgentName: agentName,
            task,
            ...(handoffSummary ? { handoffSummary } : {})
          },
          currentAgentName
        );

        return [
          `<agent_delegate from="${escapeXml(currentAgentName)}" to="${escapeXml(agentName)}">`,
          `  <child_session_id>${escapeXml(accepted.childSessionId)}</child_session_id>`,
          `  <child_run_id>${escapeXml(accepted.childRunId)}</child_run_id>`,
          "</agent_delegate>"
        ].join("\n");
      }
    }
  };
}

export function createAgentAwaitTool(
  getAllowedChildRunIds: () => string[],
  awaitRuns: (input: { runIds: string[]; mode: "all" | "any" }) => Promise<string>
): RuntimeToolSet {
  const inputSchema = z
    .object({
      runId: z.string().min(1).optional().describe("Single delegated child run id to wait for."),
      runIds: z.array(z.string().min(1)).min(1).optional().describe("Multiple delegated child run ids to wait for."),
      mode: z.enum(["all", "any"]).default("all").describe("Whether to wait for all child runs or any one child run.")
    });

  return {
    "agent.await": {
      description:
        "Wait for one or more delegated child runs and return a compact result summary. If no run ids are provided, wait for all delegated child runs from the current parent run.",
      inputSchema,
      async execute(rawInput) {
        const { runId, runIds, mode } = inputSchema.parse(rawInput);
        const fallbackRunIds = getAllowedChildRunIds();
        const normalizedRunIds = Array.from(new Set([...(runId ? [runId] : []), ...(runIds ?? []), ...(runId || runIds ? [] : fallbackRunIds)]));
        if (normalizedRunIds.length === 0) {
          throw new AppError(409, "agent_await_no_children", "No delegated child runs are available to await.");
        }
        const allowedChildRunIds = new Set(getAllowedChildRunIds());
        const unauthorizedRunId = normalizedRunIds.find((childRunId) => !allowedChildRunIds.has(childRunId));

        if (unauthorizedRunId) {
          throw new AppError(
            403,
            "agent_await_not_allowed",
            `Child run ${unauthorizedRunId} is not attached to the current parent run.`
          );
        }

        return awaitRuns({
          runIds: normalizedRunIds,
          mode
        });
      }
    }
  };
}
