import type { Run } from "@oah/api-contracts";

import type { SavedSessionRecord } from "./support-types";

function compareIsoTimestampDesc(left?: string, right?: string) {
  const leftValue = left ? Date.parse(left) : Number.NaN;
  const rightValue = right ? Date.parse(right) : Number.NaN;

  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    return rightValue - leftValue;
  }

  if (Number.isFinite(leftValue)) {
    return -1;
  }

  if (Number.isFinite(rightValue)) {
    return 1;
  }

  return 0;
}

function compareSavedNavigationItemsDesc<T extends { id: string; lastOpenedAt?: string; createdAt?: string }>(left: T, right: T) {
  const openedAtComparison = compareIsoTimestampDesc(left.lastOpenedAt, right.lastOpenedAt);
  if (openedAtComparison !== 0) {
    return openedAtComparison;
  }

  const createdAtComparison = compareIsoTimestampDesc(left.createdAt, right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return right.id.localeCompare(left.id);
}

function compareSavedSessionsByRecency(left: SavedSessionRecord, right: SavedSessionRecord) {
  const activityComparison = compareIsoTimestampDesc(left.lastRunAt ?? left.createdAt, right.lastRunAt ?? right.createdAt);
  if (activityComparison !== 0) {
    return activityComparison;
  }

  const createdAtComparison = compareIsoTimestampDesc(left.createdAt, right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return right.id.localeCompare(left.id);
}

function isTerminalRunEvent(event: string) {
  return event === "run.completed" || event === "run.failed" || event === "run.cancelled";
}

function isTerminalRunStatus(status?: Run["status"] | null) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function sessionDescendantIds(rootSessionId: string, sessions: SavedSessionRecord[]) {
  const normalizedRootSessionId = rootSessionId.trim();
  if (!normalizedRootSessionId) {
    return [];
  }

  const childIdsByParentId = new Map<string, string[]>();
  for (const sessionEntry of sessions) {
    if (!sessionEntry.parentSessionId) {
      continue;
    }

    const childIds = childIdsByParentId.get(sessionEntry.parentSessionId) ?? [];
    childIds.push(sessionEntry.id);
    childIdsByParentId.set(sessionEntry.parentSessionId, childIds);
  }

  const descendants: string[] = [];
  const visited = new Set<string>([normalizedRootSessionId]);
  const stack = [...(childIdsByParentId.get(normalizedRootSessionId) ?? [])];
  while (stack.length > 0) {
    const childId = stack.pop();
    if (!childId || visited.has(childId)) {
      continue;
    }

    visited.add(childId);
    descendants.push(childId);
    stack.push(...(childIdsByParentId.get(childId) ?? []));
  }

  return descendants;
}

function hasActiveRunForSessionTree(rootSessionId: string, sessions: SavedSessionRecord[], runs: Run[]) {
  const sessionIds = new Set([rootSessionId, ...sessionDescendantIds(rootSessionId, sessions)].filter((entry) => entry.trim().length > 0));
  return runs.some((run) => run.sessionId && sessionIds.has(run.sessionId) && !isTerminalRunStatus(run.status));
}

export {
  compareIsoTimestampDesc,
  compareSavedNavigationItemsDesc,
  compareSavedSessionsByRecency,
  hasActiveRunForSessionTree,
  isTerminalRunEvent,
  isTerminalRunStatus,
  sessionDescendantIds
};
