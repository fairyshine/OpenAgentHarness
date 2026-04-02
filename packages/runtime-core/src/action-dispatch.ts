import { z } from "zod";

import type { ActionDefinition, RuntimeToolExecutionContext, RuntimeToolSet } from "./types.js";

export interface ActionExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  output: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toInputSchemaSummary(action: ActionDefinition): string | undefined {
  if (!action.inputSchema) {
    return undefined;
  }

  try {
    return JSON.stringify(action.inputSchema);
  } catch {
    return undefined;
  }
}

function resolvedActionRetryPolicy(action: ActionDefinition): "manual" | "safe" {
  return action.retryPolicy ?? "manual";
}

export function buildAvailableActionsMessage(actions: ActionDefinition[]): string {
  if (actions.length === 0) {
    return "";
  }

  const catalog = actions
    .map((action) =>
      [
        "  <action>",
        `    <name>${escapeXml(action.name)}</name>`,
        ...(action.description ? [`    <description>${escapeXml(action.description)}</description>`] : []),
        `    <retry_policy>${escapeXml(resolvedActionRetryPolicy(action))}</retry_policy>`,
        ...(toInputSchemaSummary(action)
          ? [`    <input_schema>${escapeXml(toInputSchemaSummary(action) ?? "")}</input_schema>`]
          : []),
        "  </action>"
      ].join("\n")
    )
    .join("\n");

  return [
    "## Available Actions",
    "",
    "<available_actions>",
    catalog,
    "</available_actions>",
    "",
    "The actions listed above are named task entry points with stronger audit boundaries than normal text generation.",
    "Only actions marked with `<retry_policy>safe</retry_policy>` should be considered safe candidates for future automatic recovery.",
    "When one of them matches the task, call `run_action` with the action name and optional structured input.",
    "Do not invent action names or input fields that are not shown in the catalog."
  ].join("\n");
}

export function createRunActionTool(
  getActions: () => ActionDefinition[],
  executeAction: (
    action: ActionDefinition,
    input: unknown,
    context: RuntimeToolExecutionContext
  ) => Promise<ActionExecutionResult>
): RuntimeToolSet {
  const inputSchema = z.object({
    name: z.string().min(1).describe("Name of the action to execute."),
    input: z.unknown().optional().describe("Structured action input object.")
  });

  return {
    run_action: {
      description:
        "Run one of the available named actions. Use this for reusable task entry points that have stronger audit and execution boundaries.",
      inputSchema,
      async execute(rawInput, context) {
        const { name, input } = inputSchema.parse(rawInput);
        const llmActions = getActions().filter((action) => action.exposeToLlm);
        const actionNames = llmActions.map((action) => action.name);
        const actionsByName = new Map(llmActions.map((action) => [action.name, action]));
        const action = actionsByName.get(name);
        if (!action) {
          return `Error: Action "${name}" not found. Available actions: ${actionNames.join(", ")}`;
        }

        const result = await executeAction(action, input, context);
        return [
          `<action_result name="${escapeXml(action.name)}" exit_code="${result.exitCode}">`,
          "<output>",
          result.output,
          "</output>",
          ...(result.stdout.length > 0 ? ["<stdout>", result.stdout, "</stdout>"] : []),
          ...(result.stderr.length > 0 ? ["<stderr>", result.stderr, "</stderr>"] : []),
          "</action_result>"
        ].join("\n");
      }
    }
  };
}
