import type { Run } from "@oah/api-contracts";

import type { AgentCoordinationPersistence } from "./agent-coordination-types.js";
import { isRecord, readNonNegativeInteger } from "./agent-coordination-records.js";

export async function summarizeChildRunUsage(
  run: Run,
  runSteps: AgentCoordinationPersistence["runSteps"]
): Promise<Record<string, unknown> | undefined> {
  if (!runSteps) {
    return undefined;
  }

  const steps = await runSteps.listByRunId(run.id).catch(() => []);
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let toolUses = 0;

  for (const step of steps) {
    if (step.stepType === "tool_call") {
      toolUses += 1;
    }

    const output = isRecord(step.output) ? step.output : undefined;
    const response = isRecord(output?.response) ? output.response : undefined;
    const usage = isRecord(response?.usage) ? response.usage : undefined;
    inputTokens += readNonNegativeInteger(usage?.inputTokens);
    outputTokens += readNonNegativeInteger(usage?.outputTokens);
    totalTokens += readNonNegativeInteger(usage?.totalTokens);

    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls.length : 0;
    const toolResults = Array.isArray(response?.toolResults) ? response.toolResults.length : 0;
    const toolErrors = Array.isArray(response?.toolErrors) ? response.toolErrors.length : 0;
    toolUses += Math.max(toolCalls, toolResults, toolErrors);
  }

  const durationMs = run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined;
  const usage: Record<string, unknown> = {};
  if (inputTokens > 0) usage.inputTokens = inputTokens;
  if (outputTokens > 0) usage.outputTokens = outputTokens;
  if (totalTokens > 0) usage.totalTokens = totalTokens;
  if (toolUses > 0) usage.toolUses = toolUses;
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) usage.durationMs = durationMs;

  return Object.keys(usage).length > 0 ? usage : undefined;
}
