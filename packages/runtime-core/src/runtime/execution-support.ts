import type { WorkspaceRecord } from "../types.js";
import type { ModelExecutionInput } from "./model-input.js";
import type { RunStep } from "@oah/api-contracts";

export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {
    value
  };
}

export function buildGeneratedMessageMetadata(
  workspace: WorkspaceRecord,
  agentName: string,
  modelInput: Pick<ModelExecutionInput, "messages">,
  modelCallStep?: Pick<RunStep, "id" | "seq"> | undefined
): Record<string, unknown> {
  const systemMessages = modelInput.messages
    .filter((message): message is { role: "system"; content: string } => message.role === "system" && typeof message.content === "string")
    .map((message) => ({
      role: "system" as const,
      content: message.content
    }));
  const agentMode = workspace.agents[agentName]?.mode;

  return {
    agentName,
    effectiveAgentName: agentName,
    ...(agentMode ? { agentMode } : {}),
    ...(modelCallStep ? { modelCallStepId: modelCallStep.id, modelCallStepSeq: modelCallStep.seq } : {}),
    ...(systemMessages.length > 0 ? { systemMessages } : {})
  };
}
