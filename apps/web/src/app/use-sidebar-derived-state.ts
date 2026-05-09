import { useMemo } from "react";

import type { Run, Session, Workspace } from "@oah/api-contracts";

import {
  SERVICE_SCOPE_ALL,
  SERVICE_SCOPE_DEFAULT,
  hasActiveRunForSessionTree,
  normalizeServiceName,
  normalizeServiceScope,
  serviceScopeLabel,
  serviceScopeMatches,
  type SavedSessionRecord,
  type SavedWorkspaceRecord
} from "./support";

export function useSidebarDerivedState(input: {
  serviceScope: string;
  workspaceRuntimeFilter: string;
  orderedSavedWorkspaces: SavedWorkspaceRecord[];
  sessionsByWorkspaceId: Map<string, SavedSessionRecord[]>;
  workspace: Workspace | null | undefined;
  workspaceRuntimes: string[];
  session: Session | null | undefined;
  sessionId: string;
  sessionRuns: Run[];
  sidebarSessionRunsById: Record<string, Run[]>;
}) {
  const normalizedServiceScope = useMemo(() => normalizeServiceScope(input.serviceScope), [input.serviceScope]);
  const serviceFilteredWorkspaces = useMemo(
    () => input.orderedSavedWorkspaces.filter((entry) => serviceScopeMatches(normalizedServiceScope, entry.serviceName)),
    [normalizedServiceScope, input.orderedSavedWorkspaces]
  );
  const knownServiceNames = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...input.orderedSavedWorkspaces.map((entry) => normalizeServiceName(entry.serviceName)),
            normalizeServiceName(input.workspace?.serviceName),
            normalizeServiceName(normalizedServiceScope)
          ].filter((entry): entry is string => Boolean(entry))
        )
      ).sort((left, right) => left.localeCompare(right)),
    [normalizedServiceScope, input.orderedSavedWorkspaces, input.workspace?.serviceName]
  );
  const serviceScopeOptions = useMemo(
    () => [
      {
        value: SERVICE_SCOPE_ALL,
        label: serviceScopeLabel(SERVICE_SCOPE_ALL)
      },
      {
        value: SERVICE_SCOPE_DEFAULT,
        label: serviceScopeLabel(SERVICE_SCOPE_DEFAULT)
      },
      ...knownServiceNames.map((entry) => ({
        value: entry,
        label: serviceScopeLabel(entry)
      }))
    ],
    [knownServiceNames]
  );
  const selectedServiceScopeLabel = useMemo(() => serviceScopeLabel(normalizedServiceScope), [normalizedServiceScope]);
  const workspaceRuntimeFilterValue = input.workspaceRuntimeFilter.trim();
  const workspaceRuntimeFilterOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...input.workspaceRuntimes,
            ...serviceFilteredWorkspaces.map((entry) => entry.runtime ?? ""),
            workspaceRuntimeFilterValue
          ]
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        )
      ).sort((left, right) => left.localeCompare(right)),
    [serviceFilteredWorkspaces, workspaceRuntimeFilterValue, input.workspaceRuntimes]
  );
  const filteredSavedWorkspaces = useMemo(
    () =>
      workspaceRuntimeFilterValue
        ? serviceFilteredWorkspaces.filter((entry) => (entry.runtime ?? "").trim() === workspaceRuntimeFilterValue)
        : serviceFilteredWorkspaces,
    [serviceFilteredWorkspaces, workspaceRuntimeFilterValue]
  );
  const filteredSavedSessionsCount = useMemo(
    () =>
      filteredSavedWorkspaces.reduce((count, entry) => count + (input.sessionsByWorkspaceId.get(entry.id)?.length ?? 0), 0),
    [filteredSavedWorkspaces, input.sessionsByWorkspaceId]
  );
  const visibleSidebarSessionIds = useMemo(() => {
    const ids: string[] = [];
    for (const workspaceEntry of filteredSavedWorkspaces) {
      for (const sessionEntry of input.sessionsByWorkspaceId.get(workspaceEntry.id) ?? []) {
        ids.push(sessionEntry.id);
      }
    }
    return ids;
  }, [filteredSavedWorkspaces, input.sessionsByWorkspaceId]);
  const visibleSidebarSessionKey = useMemo(() => visibleSidebarSessionIds.join("\n"), [visibleSidebarSessionIds]);
  const sidebarSessionRuns = useMemo(() => {
    const byRunId = new Map<string, Run>();

    for (const sessionRun of Object.values(input.sidebarSessionRunsById).flat()) {
      byRunId.set(sessionRun.id, sessionRun);
    }

    for (const sessionRun of input.sessionRuns) {
      byRunId.set(sessionRun.id, sessionRun);
    }

    return Array.from(byRunId.values());
  }, [input.sessionRuns, input.sidebarSessionRunsById]);
  const activeWorkspaceSessions = useMemo(() => {
    const activeSessionId = input.session?.id?.trim();
    const activeWorkspaceId = input.session?.workspaceId?.trim();
    if (!activeSessionId || !activeWorkspaceId) {
      return [];
    }

    return input.sessionsByWorkspaceId.get(activeWorkspaceId) ?? [];
  }, [input.session?.id, input.session?.workspaceId, input.sessionsByWorkspaceId]);
  const hasActiveSessionRun = useMemo(
    () => hasActiveRunForSessionTree(input.sessionId, activeWorkspaceSessions, sidebarSessionRuns),
    [activeWorkspaceSessions, input.sessionId, sidebarSessionRuns]
  );

  return {
    normalizedServiceScope,
    serviceScopeOptions,
    selectedServiceScopeLabel,
    workspaceRuntimeFilterValue,
    workspaceRuntimeFilterOptions,
    filteredSavedWorkspaces,
    filteredSavedSessionsCount,
    visibleSidebarSessionIds,
    visibleSidebarSessionKey,
    sidebarSessionRuns,
    activeWorkspaceSessions,
    hasActiveSessionRun
  };
}
