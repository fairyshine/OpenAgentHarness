import type { Run } from "@oah/api-contracts";

import type { DelegatedRunRecord } from "./agent-coordination-types.js";

export const delegatedOutputFollowUpPrompt = [
  "Your previous delegated run completed, but it did not produce a readable final output for the parent agent.",
  "Please respond now with only the final result of the delegated task.",
  "Do not call tools. Do not quote raw tool output. Synthesize the answer from the work already done.",
  "If there is nothing to report, say that explicitly."
].join("\n");

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function delegatedRunRecords(run: Run): DelegatedRunRecord[] {
  const rawRecords = run.metadata?.delegatedRuns;
  if (!Array.isArray(rawRecords)) {
    return [];
  }

  return rawRecords.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const { childRunId, childSessionId, targetAgentName, parentAgentName, notifyParentOnCompletion, toolUseId } =
      entry;
    if (
      typeof childRunId !== "string" ||
      typeof childSessionId !== "string" ||
      typeof targetAgentName !== "string" ||
      typeof parentAgentName !== "string"
    ) {
      return [];
    }

    return [
      {
        childRunId,
        childSessionId,
        targetAgentName,
        parentAgentName,
        ...(typeof notifyParentOnCompletion === "boolean" ? { notifyParentOnCompletion } : {}),
        ...(typeof toolUseId === "string" ? { toolUseId } : {})
      }
    ];
  });
}
