import { useMemo, useState, type ReactNode } from "react";

import type { Run } from "@oah/api-contracts";
import { Bot, FolderPlus, MessageSquareText, RotateCcw, Settings2, Sparkles, Trash2 } from "lucide-react";
import { useShallow } from "zustand/shallow";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { useSettingsStore } from "../stores/settings-store";
import { useUiStore } from "../stores/ui-store";
import type { MainViewMode, SavedSessionRecord } from "../support";
import { SessionNavItem, WorkspaceNavItem } from "./sidebar-items";
import { SidebarModeToggle } from "./sidebar-primitives";
import type { SidebarProps } from "./sidebar-types";

function RuntimeSidebar(props: SidebarProps & { onOpenRuntimeAssets?: () => void }) {
  const [runtimeWorkspaceDeleteBusy, setRuntimeWorkspaceDeleteBusy] = useState(false);
  const { mainViewMode, setMainViewMode } = useUiStore(
    useShallow((state) => ({
      mainViewMode: state.mainViewMode,
      setMainViewMode: state.setMainViewMode
    }))
  );
  const { workspaceRuntimeFilter, setWorkspaceRuntimeFilter, serviceScope } = useSettingsStore(
    useShallow((state) => ({
      workspaceRuntimeFilter: state.workspaceRuntimeFilter,
      setWorkspaceRuntimeFilter: state.setWorkspaceRuntimeFilter,
      serviceScope: state.serviceScope
    }))
  );
  const expandedWorkspaceIdSet = useMemo(() => new Set(props.expandedWorkspaceIds), [props.expandedWorkspaceIds]);
  const expandedSessionIdSet = useMemo(() => new Set(props.expandedSessionIds), [props.expandedSessionIds]);
  const loadingSessionWorkspaceIdSet = useMemo(
    () => new Set(props.workspaceSessionLoadingIds),
    [props.workspaceSessionLoadingIds]
  );
  const engineViewLabel = mainViewMode === "inspector" ? "Inspector" : "Conversation";
  const selectedRuntimeWorkspaceIds = useMemo(
    () => (workspaceRuntimeFilter.trim() ? props.filteredSavedWorkspaces.map((entry) => entry.id) : []),
    [props.filteredSavedWorkspaces, workspaceRuntimeFilter]
  );
  const canDeleteRuntimeWorkspaces =
    props.workspaceManagementEnabled &&
    workspaceRuntimeFilter.trim().length > 0 &&
    selectedRuntimeWorkspaceIds.length > 0 &&
    !runtimeWorkspaceDeleteBusy;
  const workspaceSessionGroups = useMemo(
    () =>
      props.filteredSavedWorkspaces.map((entry) => {
        const workspaceSessions = props.sessionsByWorkspaceId.get(entry.id) ?? [];
        const childSessionsByParentId = new Map<string, SavedSessionRecord[]>();
        for (const sessionEntry of workspaceSessions) {
          if (!sessionEntry.parentSessionId) {
            continue;
          }
          const children = childSessionsByParentId.get(sessionEntry.parentSessionId) ?? [];
          children.push(sessionEntry);
          childSessionsByParentId.set(sessionEntry.parentSessionId, children);
        }

        const topLevelSessions = workspaceSessions.filter((sessionEntry) => !sessionEntry.parentSessionId);
        const lastEditedAt = workspaceSessions.reduce<string | undefined>((latest, sessionEntry) => {
          if (!sessionEntry.lastRunAt) {
            return latest;
          }
          if (!latest) {
            return sessionEntry.lastRunAt;
          }

          return Date.parse(sessionEntry.lastRunAt) > Date.parse(latest) ? sessionEntry.lastRunAt : latest;
        }, undefined);

        return {
          entry,
          workspaceSessions,
          childSessionsByParentId,
          topLevelSessions,
          lastEditedAt
        };
      }),
    [props.filteredSavedWorkspaces, props.sessionsByWorkspaceId]
  );
  const sessionRunStatusById = useMemo(() => {
    const statusRank: Record<Run["status"], number> = {
      running: 0,
      waiting_tool: 1,
      queued: 2,
      failed: 3,
      timed_out: 4,
      cancelled: 5,
      completed: 6
    };
    const next = new Map<string, Run["status"]>();
    for (const sessionRun of props.sessionRuns) {
      const sessionIdValue = sessionRun.sessionId?.trim();
      if (!sessionIdValue) {
        continue;
      }
      const current = next.get(sessionIdValue);
      if (!current || statusRank[sessionRun.status] < statusRank[current]) {
        next.set(sessionIdValue, sessionRun.status);
      }
    }
    return next;
  }, [props.sessionRuns]);

  function hasActiveDescendant(
    sessionId: string,
    childSessionsByParentId: Map<string, SavedSessionRecord[]>,
    activeSessionId: string
  ): boolean {
    const childSessions = childSessionsByParentId.get(sessionId) ?? [];
    for (const childSession of childSessions) {
      if (childSession.id === activeSessionId || hasActiveDescendant(childSession.id, childSessionsByParentId, activeSessionId)) {
        return true;
      }
    }
    return false;
  }

  function renderSessionTree(
    entries: SavedSessionRecord[],
    options?: {
      depth?: number;
      childSessionsByParentId?: Map<string, SavedSessionRecord[]>;
      workspaceId?: string;
    }
  ): ReactNode {
    const depth = options?.depth ?? 0;
    const childSessionsByParentId = options?.childSessionsByParentId;
    const workspaceId = options?.workspaceId ?? "";

    return entries.map((sessionEntry) => {
      const childSessions = childSessionsByParentId?.get(sessionEntry.id) ?? [];
      const shouldExpand =
        childSessions.length > 0 &&
        (expandedSessionIdSet.has(sessionEntry.id) ||
          (props.sessionId === sessionEntry.id
            ? true
            : childSessionsByParentId
              ? hasActiveDescendant(sessionEntry.id, childSessionsByParentId, props.sessionId)
              : false));
      return (
        <div key={sessionEntry.id} className={depth === 0 ? "space-y-1" : "space-y-0.5"}>
          <SessionNavItem
            entry={sessionEntry}
            depth={depth}
            active={sessionEntry.id === props.sessionId}
            {...(sessionRunStatusById.has(sessionEntry.id)
              ? { runStatus: sessionRunStatusById.get(sessionEntry.id) as Run["status"] }
              : {})}
            expanded={shouldExpand}
            hasChildren={childSessions.length > 0}
            onSelect={() => {
              if (workspaceId.trim()) {
                props.expandWorkspaceInSidebar(workspaceId);
              }
              props.refreshSessionById(sessionEntry.id);
            }}
            onToggleExpanded={() => props.toggleSessionExpansion(sessionEntry.id)}
            onRename={(title) => props.renameSession(sessionEntry.id, title)}
            onRemove={() => props.removeSavedSession(sessionEntry.id)}
          />
          {childSessions.length > 0 && shouldExpand ? (
            <div className="mt-1 space-y-0.5">
              {renderSessionTree(childSessions, {
                depth: depth + 1,
                ...(childSessionsByParentId ? { childSessionsByParentId } : {}),
                workspaceId
              })}
            </div>
          ) : null}
        </div>
      );
    });
  }

  async function handleDeleteCurrentRuntimeWorkspaces() {
    if (!canDeleteRuntimeWorkspaces) {
      return;
    }
    setRuntimeWorkspaceDeleteBusy(true);
    try {
      await props.deleteWorkspacesForRuntime(workspaceRuntimeFilter, selectedRuntimeWorkspaceIds);
    } finally {
      setRuntimeWorkspaceDeleteBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-2.5">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <SidebarModeToggle
                activeKey={mainViewMode}
                onChange={(key) => setMainViewMode(key as MainViewMode)}
                iconOnly
                items={[
                  { key: "conversation", label: "Conversation", icon: <MessageSquareText className="h-4 w-4" /> },
                  { key: "inspector", label: "Inspector", icon: <Sparkles className="h-4 w-4" /> }
                ]}
              />
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => {
                    void props.refreshWorkspaceIndex();
                  }}
                  disabled={props.workspaceIndexLoading}
                  title="Refresh workspace list"
                >
                  <RotateCcw className={`h-3.5 w-3.5 ${props.workspaceIndexLoading ? "animate-spin-reverse" : ""}`} />
                </Button>
                {props.workspaceManagementEnabled ? (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => props.onOpenRuntimeAssets?.()}
                      title="Manage runtime assets"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        props.setWorkspaceDraft((current) => ({ ...current, runtime: "" }));
                        props.setShowWorkspaceCreator(true);
                      }}
                      title="New Workspace"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={!props.activeWorkspaceId.trim()}
                  title="New Session"
                  onClick={() => {
                    if (!props.activeWorkspaceId.trim()) {
                      return;
                    }
                    props.expandWorkspaceInSidebar(props.activeWorkspaceId);
                    props.createSession();
                  }}
                >
                  <Bot className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <p className="truncate px-1 text-[12px] font-medium leading-4 text-muted-foreground">
              Engine View <span className="text-muted-foreground/50">·</span> <span className="text-foreground">{engineViewLabel}</span>
            </p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium leading-4 text-muted-foreground">Runtime</span>
            </div>
            <div className="flex items-center gap-1">
              <Select
                value={workspaceRuntimeFilter || "__all_runtimes__"}
                onValueChange={(value) => setWorkspaceRuntimeFilter(value === "__all_runtimes__" ? "" : value)}
              >
                <SelectTrigger className="h-8 min-w-0 flex-1 rounded-lg border-black/10 bg-white/58 text-xs shadow-none" aria-label="Workspace runtime filter">
                  <SelectValue placeholder="All runtimes" />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="__all_runtimes__">All runtimes</SelectItem>
                  {props.workspaceRuntimeFilterOptions.map((runtime) => (
                    <SelectItem key={runtime} value={runtime}>
                      {runtime}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {props.workspaceManagementEnabled ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={!canDeleteRuntimeWorkspaces}
                  onClick={() => {
                    void handleDeleteCurrentRuntimeWorkspaces();
                  }}
                  title={
                    workspaceRuntimeFilter.trim()
                      ? `Delete ${selectedRuntimeWorkspaceIds.length} workspace${selectedRuntimeWorkspaceIds.length === 1 ? "" : "s"} for this runtime`
                      : "Select a runtime to delete its workspaces"
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
          {props.workspaceIndexLoading && props.filteredSavedWorkspaces.length === 0 ? (
            <div className="sidebar-empty-state rounded-xl border border-dashed border-black/12 bg-white/32 px-4 py-8 text-center">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl border border-black/8 bg-white/60 shadow-sm">
                <RotateCcw className="h-4 w-4 animate-spin-reverse text-muted-foreground" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">Loading workspaces</p>
            </div>
          ) : props.filteredSavedWorkspaces.length === 0 ? (
            <div className="sidebar-empty-state rounded-xl border border-dashed border-black/12 bg-white/32 px-4 py-8 text-center">
              <p className="text-sm font-medium text-foreground">
                {workspaceRuntimeFilter ? "No matching workspaces" : "No workspaces"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {workspaceRuntimeFilter
                  ? "Try another runtime or service filter."
                  : serviceScope !== "__all__"
                    ? "Switch service scope or create a workspace in this service."
                    : "Create or load one."}
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {workspaceSessionGroups.map(({ entry, workspaceSessions, childSessionsByParentId, topLevelSessions, lastEditedAt }) => {
                const isExpanded = expandedWorkspaceIdSet.has(entry.id);
                const sessionsLoading = loadingSessionWorkspaceIdSet.has(entry.id);
                return (
                  <div key={entry.id} className="runtime-workspace-group space-y-1">
                    <WorkspaceNavItem
                      entry={entry}
                      active={entry.id === props.activeWorkspaceId}
                      expanded={isExpanded}
                      sessionCount={workspaceSessions.length}
                      {...(lastEditedAt ? { lastEditedAt } : {})}
                      canRemove={props.workspaceManagementEnabled}
                      onSelect={() => props.openWorkspace(entry.id)}
                      onToggleExpanded={() => props.toggleWorkspaceExpansion(entry.id)}
                      onRemove={() => props.deleteWorkspace(entry.id)}
                    />
                    {isExpanded ? (
                      <div className="runtime-session-tree space-y-1.5">
                        {sessionsLoading && topLevelSessions.length === 0 ? (
                          <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-muted-foreground">
                            <RotateCcw className="h-3.5 w-3.5 animate-spin-reverse" />
                            Loading sessions
                          </div>
                        ) : topLevelSessions.length === 0 ? (
                          <div className="rounded-lg px-3 py-2.5 text-xs text-muted-foreground">No sessions yet.</div>
                        ) : (
                          <>
                            {sessionsLoading ? (
                              <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] text-muted-foreground">
                                <RotateCcw className="h-3 w-3 animate-spin-reverse" />
                                Updating sessions
                              </div>
                            ) : null}
                            {renderSessionTree(topLevelSessions, {
                              childSessionsByParentId,
                              workspaceId: entry.id
                            })}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { RuntimeSidebar };
