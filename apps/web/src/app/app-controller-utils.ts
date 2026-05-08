import type { RunStep, Session, SessionEventContract, SessionQueuedRun } from "@oah/api-contracts";

import { compareSavedSessionsByRecency, isRecord, type SavedSessionRecord } from "./support";

const MESSAGE_PAGE_SIZE = 120;

export function buildMessagePagePath(
  sessionId: string,
  options?: {
    cursor?: string | undefined;
    direction?: "forward" | "backward" | undefined;
    pageSize?: number | undefined;
  }
) {
  const query = new URLSearchParams({
    pageSize: String(options?.pageSize ?? MESSAGE_PAGE_SIZE),
    direction: options?.direction ?? "backward"
  });
  if (options?.cursor) {
    query.set("cursor", options.cursor);
  }

  return `/api/v1/sessions/${sessionId}/messages?${query.toString()}`;
}

export function mergeMessageCursor(current: string | null, incoming: string | undefined) {
  const normalizedCurrent = current?.trim() ? current : null;
  const normalizedIncoming = incoming?.trim() ? incoming : null;

  if (!normalizedCurrent) {
    return normalizedIncoming;
  }
  if (!normalizedIncoming) {
    return normalizedCurrent;
  }

  const currentOffset = Number.parseInt(normalizedCurrent, 10);
  const incomingOffset = Number.parseInt(normalizedIncoming, 10);
  if (Number.isFinite(currentOffset) && Number.isFinite(incomingOffset)) {
    return String(Math.min(currentOffset, incomingOffset));
  }

  return normalizedCurrent;
}

export function savedSessionFromSession(sessionRecord: Session, existing?: SavedSessionRecord): SavedSessionRecord {
  return {
    id: sessionRecord.id,
    workspaceId: sessionRecord.workspaceId,
    ...(sessionRecord.parentSessionId ? { parentSessionId: sessionRecord.parentSessionId } : {}),
    title: sessionRecord.title,
    modelRef: sessionRecord.modelRef,
    agentName: sessionRecord.activeAgentName,
    lastRunAt: sessionRecord.lastRunAt,
    createdAt: sessionRecord.createdAt,
    lastOpenedAt: existing?.lastOpenedAt ?? sessionRecord.createdAt
  };
}

export function readQueuedRunsFromEventData(data: Record<string, unknown>): SessionQueuedRun[] | null {
  if (!Array.isArray(data.items)) {
    return null;
  }

  const items: SessionQueuedRun[] = [];
  for (const item of data.items) {
    if (!isRecord(item)) {
      return null;
    }
    if (
      typeof item.runId !== "string" ||
      typeof item.messageId !== "string" ||
      typeof item.content !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.position !== "number"
    ) {
      return null;
    }

    items.push({
      runId: item.runId,
      messageId: item.messageId,
      content: item.content,
      createdAt: item.createdAt,
      position: item.position
    });
  }

  return items;
}

export const SESSION_RUN_LIST_REFRESH_EVENTS = new Set<SessionEventContract["event"]>([
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "agent.delegate.started",
  "agent.delegate.completed",
  "agent.delegate.failed"
]);

export const RUN_DETAIL_REFRESH_EVENTS = new Set<SessionEventContract["event"]>([
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "agent.switched",
  "agent.delegate.started",
  "agent.delegate.completed",
  "agent.delegate.failed"
]);

export const ACTIVITY_VISIBLE_EVENTS = new Set<SessionEventContract["event"]>([
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "queue.updated",
  "agent.switched",
  "agent.delegate.started",
  "agent.delegate.completed",
  "agent.delegate.failed",
  "tool.failed"
]);

export function sortRunSteps(items: RunStep[]) {
  return [...items].sort((left, right) => {
    const leftTime = left.endedAt ?? left.startedAt ?? "";
    const rightTime = right.endedAt ?? right.startedAt ?? "";
    if (leftTime !== rightTime) {
      return leftTime.localeCompare(rightTime);
    }

    if (left.runId !== right.runId) {
      return left.runId.localeCompare(right.runId);
    }

    if (left.seq !== right.seq) {
      return left.seq - right.seq;
    }

    return left.id.localeCompare(right.id);
  });
}

export function mergeRunStepsForRun(current: RunStep[], targetRunId: string, nextItems: RunStep[]) {
  return sortRunSteps([...current.filter((step) => step.runId !== targetRunId), ...nextItems]);
}

export function mergeSavedSessionRecords(current: SavedSessionRecord[], incoming: SavedSessionRecord[]) {
  const nextById = new Map(current.map((entry) => [entry.id, entry]));
  for (const record of incoming) {
    const existing = nextById.get(record.id);
    nextById.set(record.id, existing ? { ...existing, ...record } : record);
  }

  return Array.from(nextById.values()).sort(compareSavedSessionsByRecency);
}
