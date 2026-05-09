import type { Message, RunStep, SessionEventContract } from "@oah/api-contracts";

import { isRecord } from "./support-core";
import { buildMessageRecord, normalizeMessageContent } from "./message-content";
import type { StorageToolCallRecord } from "./support-types";

function storageMessageFromRow(row: Record<string, unknown>): Message | null {
  const role = row.role;
  const content = normalizeMessageContent(row.content);
  const id = row.id;
  const sessionId = row.session_id;
  const createdAt = row.created_at;
  if (
    typeof id !== "string" ||
    typeof sessionId !== "string" ||
    typeof createdAt !== "string" ||
    !["system", "user", "assistant", "tool"].includes(String(role)) ||
    content === null
  ) {
    return null;
  }

  return buildMessageRecord({
    id,
    sessionId,
    role: role as Message["role"],
    content,
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
    ...(isRecord(row.metadata) ? { metadata: row.metadata } : {}),
    createdAt
  });
}

function storageRunStepFromRow(row: Record<string, unknown>): RunStep | null {
  if (
    typeof row.id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.seq !== "number" ||
    typeof row.step_type !== "string" ||
    typeof row.status !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    stepType: row.step_type as RunStep["stepType"],
    status: row.status as RunStep["status"],
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.agent_name === "string" ? { agentName: row.agent_name } : {}),
    ...("input" in row ? { input: row.input } : {}),
    ...("output" in row ? { output: row.output } : {}),
    ...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
    ...(typeof row.ended_at === "string" ? { endedAt: row.ended_at } : {})
  };
}

function storageSessionEventFromRow(row: Record<string, unknown>): SessionEventContract | null {
  if (
    typeof row.id !== "string" ||
    typeof row.cursor !== "number" ||
    typeof row.session_id !== "string" ||
    typeof row.event !== "string" ||
    !isRecord(row.data) ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    cursor: String(row.cursor),
    sessionId: row.session_id,
    event: row.event as SessionEventContract["event"],
    data: row.data,
    createdAt: row.created_at,
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {})
  };
}

function storageToolCallFromRow(row: Record<string, unknown>): StorageToolCallRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.source_type !== "string" ||
    typeof row.tool_name !== "string" ||
    typeof row.status !== "string" ||
    typeof row.started_at !== "string" ||
    typeof row.ended_at !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    sourceType: row.source_type,
    toolName: row.tool_name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(typeof row.step_id === "string" ? { stepId: row.step_id } : {}),
    ...("request" in row ? { request: row.request } : {}),
    ...("response" in row ? { response: row.response } : {}),
    ...(typeof row.duration_ms === "number" ? { durationMs: row.duration_ms } : {})
  };
}

export {
  storageMessageFromRow,
  storageRunStepFromRow,
  storageSessionEventFromRow,
  storageToolCallFromRow
};
