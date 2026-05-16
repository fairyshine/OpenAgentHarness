import type { Run, Session } from "@oah/api-contracts";

import type { WorkspaceMemoryWritePolicy, WorkspaceRecord } from "../types.js";

export function isWorkspaceMemoryWritePolicy(value: unknown): value is WorkspaceMemoryWritePolicy {
  return value === "explicit-only" || value === "confirm-suggested" || value === "auto-extract";
}

function readPolicyFromObject(value: unknown): WorkspaceMemoryWritePolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return isWorkspaceMemoryWritePolicy(record.writePolicy)
    ? record.writePolicy
    : isWorkspaceMemoryWritePolicy(record.write_policy)
      ? record.write_policy
      : undefined;
}

function readRunWorkspaceMemoryWritePolicy(run?: Run | undefined): WorkspaceMemoryWritePolicy | undefined {
  const metadata = run?.metadata;
  if (!metadata) {
    return undefined;
  }

  return readPolicyFromObject(metadata.workspaceMemory) ?? readPolicyFromObject(metadata.workspace_memory);
}

function readSessionWorkspaceMemoryWritePolicy(session?: Session | undefined): WorkspaceMemoryWritePolicy | undefined {
  return readPolicyFromObject((session as { workspaceMemory?: unknown } | undefined)?.workspaceMemory);
}

export function resolveEffectiveWorkspaceMemoryWritePolicy(input: {
  workspace?: WorkspaceRecord | undefined;
  agentName?: string | undefined;
  session?: Session | undefined;
  run?: Run | undefined;
}): WorkspaceMemoryWritePolicy {
  return (
    readRunWorkspaceMemoryWritePolicy(input.run) ??
    readSessionWorkspaceMemoryWritePolicy(input.session) ??
    (input.agentName ? input.workspace?.agents[input.agentName]?.policy?.workspaceMemory?.writePolicy : undefined) ??
    input.workspace?.settings.engine?.workspaceMemory?.writePolicy ??
    "explicit-only"
  );
}
