import { z } from "zod";

import { AppError } from "./errors.js";
import { formatToolOutput } from "./tool-output.js";
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
    "When the task should continue under a different specialist persona, call `AgentSwitch` with `to` set to one of the allowed target agent names.",
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
    "## Available Agent Types",
    "",
    `<available_agents current_agent="${escapeXml(currentAgentName)}">`,
    entries,
    "</available_agents>",
    "",
    "Use `SubAgent` to launch one of the allowed agent types for complex or multi-step work.",
    "Pass `subagent_type` to choose the agent, a short `description`, and a focused `prompt` with the task context.",
    "Pass `task_id` to continue a previously launched subagent session instead of starting a fresh one.",
    "Set `run_in_background` to true when you want the launched agent to continue in the background."
  ].join("\n");
}

export function createSubAgentTool(
  getCurrentAgentName: () => string,
  getCurrentAgent: () => AgentDefinition | undefined,
  getAgents: () => Record<string, AgentDefinition>,
  launchAgent: (
    input: {
      targetAgentName?: string | undefined;
      task: string;
      handoffSummary?: string | undefined;
      taskId?: string | undefined;
    },
    currentAgentName: string
  ) => Promise<{
    childSessionId: string;
    childRunId: string;
    targetAgentName: string;
  }>,
  awaitRuns: (input: { runIds: string[]; mode: "all" | "any" }) => Promise<string>
): RuntimeToolSet {
  const inputSchema = z.object({
    description: z.string().min(1).describe("A short 3-5 word description of the task."),
    prompt: z.string().min(1).describe("The task for the agent to perform, including needed context."),
    subagent_type: z.string().min(1).optional().describe("The allowed agent type to use for this task."),
    task_id: z
      .string()
      .min(1)
      .optional()
      .describe("Reuse a previous subagent session by task_id instead of creating a fresh one."),
    run_in_background: z.boolean().optional().describe("Set to true to run this agent in the background.")
  });

  return {
    SubAgent: {
      description: "Launch a new subagent to handle complex, multi-step tasks autonomously.",
      inputSchema,
      async execute(rawInput) {
        const {
          description,
          prompt,
          subagent_type: subagentType,
          task_id: taskId,
          run_in_background: runInBackground
        } = inputSchema.parse(rawInput);
        const currentAgentName = getCurrentAgentName();
        const currentAgent = getCurrentAgent();
        const agents = getAgents();
        const allowedTargets = currentAgent?.subagents ?? [];
        const targetAgentName = subagentType ?? (!taskId && allowedTargets.length === 1 ? allowedTargets[0] : undefined);
        const targetAgent = targetAgentName ? agents[targetAgentName] : undefined;

        if (!targetAgentName && !taskId) {
          throw new AppError(
            400,
            "agent_type_required",
            allowedTargets.length === 0
              ? `Agent ${currentAgentName} does not have any available subagents.`
              : `Agent requires subagent_type. Available agent types: ${allowedTargets.join(", ")}`
          );
        }

        if (targetAgentName) {
          if (!allowedTargets.includes(targetAgentName)) {
            throw new AppError(
              403,
              "agent_delegate_not_allowed",
              `Agent ${currentAgentName} is not allowed to delegate to ${targetAgentName}.`
            );
          }

          if (!targetAgent) {
            throw new AppError(404, "agent_not_found", `Agent ${targetAgentName} was not found.`);
          }

          if (targetAgent.mode === "primary") {
            throw new AppError(
              409,
              "invalid_subagent_target",
              `Agent ${targetAgentName} is a primary agent and cannot be used as a subagent target.`
            );
          }
        }

        const shouldRunInBackground = runInBackground ?? targetAgent?.background ?? false;

        const accepted = await launchAgent(
          {
            ...(targetAgentName ? { targetAgentName } : {}),
            task: prompt,
            handoffSummary: description,
            ...(taskId ? { taskId } : {})
          },
          currentAgentName
        );

        if (shouldRunInBackground) {
          return formatToolOutput([
            ["started", true],
            ["subagent_type", accepted.targetAgentName],
            ["description", description],
            ["task_id", accepted.childSessionId]
          ]);
        }

        const awaited = await awaitRuns({
          runIds: [accepted.childRunId],
          mode: "all"
        });

        return formatToolOutput(
          [
            ["completed", true],
            ["subagent_type", accepted.targetAgentName],
            ["description", description],
            ["task_id", accepted.childSessionId]
          ],
          [
            {
              title: "result",
              lines: awaited.split(/\r?\n/),
              emptyText: "(empty result)"
            }
          ]
        );
      }
    }
  };
}

export function createAgentSwitchTool(
  getCurrentAgentName: () => string,
  getCurrentAgent: () => AgentDefinition | undefined,
  getAgents: () => Record<string, AgentDefinition>,
  switchAgent: (targetAgentName: string, currentAgentName: string) => Promise<void>
): RuntimeToolSet {
  return {
    AgentSwitch: {
      description: "Switch the current run to another allowed agent persona within the same run.",
      inputSchema: z.object({
        to: z.string().min(1).describe("Name of the target agent to switch to.")
      }),
      async execute(rawInput) {
        const { to } = z
          .object({
            to: z.string().min(1)
          })
          .parse(rawInput);
        const currentAgentName = getCurrentAgentName();
        const currentAgent = getCurrentAgent();
        const agents = getAgents();
        const allowedTargets = currentAgent?.switch ?? [];

        if (!allowedTargets.includes(to)) {
          throw new AppError(
            403,
            "agent_switch_not_allowed",
            `Agent ${currentAgentName} is not allowed to switch to ${to}.`
          );
        }

        const targetAgent = agents[to];
        if (!targetAgent) {
          throw new AppError(404, "agent_not_found", `Agent ${to} was not found.`);
        }

        if (targetAgent.mode === "subagent") {
          throw new AppError(
            409,
            "invalid_agent_switch_target",
            `Agent ${to} is a subagent and cannot be used as a switch target.`
          );
        }

        await switchAgent(to, currentAgentName);
        return `switched_to: ${to}`;
      }
    }
  };
}
