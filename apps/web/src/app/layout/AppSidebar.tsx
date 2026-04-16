import { useRef, useState, type ReactNode } from "react";

import {
  Bot,
  Database,
  FolderPlus,
  Lock,
  Network,
  Orbit,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  Table2,
  Upload,
  Workflow
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { probeTone, streamTone, toneBadgeClass, type SavedSessionRecord, type StatusSemanticTone } from "../support";
import type { useAppController } from "../use-app-controller";
import { SessionNavItem, WorkspaceNavItem } from "./sidebar-items";

type SidebarProps = ReturnType<typeof useAppController>["sidebarSurfaceProps"];

function tableLabel(name: string) {
  return name.replace(/_/g, " ");
}

function compactFilterCount(values: string[]) {
  return values.filter((value) => value.trim().length > 0).length;
}

function SidebarSection(props: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-black/8 pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{props.title}</p>
          {props.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p> : null}
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function SidebarHero(props: {
  icon: ReactNode;
  eyebrow?: string;
  title?: string;
  description?: string;
  accentClassName?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`border-b border-black/8 pb-4 ${props.accentClassName ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-black/10 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
            {props.icon}
          </div>
          {props.eyebrow || props.title || props.description ? (
            <div className="min-w-0">
              {props.eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{props.eyebrow}</p> : null}
              {props.title ? <p className="mt-1 text-sm font-semibold tracking-tight text-foreground">{props.title}</p> : null}
              {props.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p> : null}
            </div>
          ) : null}
        </div>
        {props.action}
      </div>
      {props.children ? <div className="mt-4 space-y-3">{props.children}</div> : null}
    </section>
  );
}

function SidebarMetric(props: {
  label: string;
  value: string;
  tone?: StatusSemanticTone;
  detail?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`border ${props.compact ? "rounded-xl px-3 py-2" : "rounded-[1.6rem] px-3.5 py-3"} ${toneBadgeClass(props.tone ?? "sky")} ${
        props.className ?? ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className={`uppercase ${props.compact ? "text-[9px] tracking-[0.18em]" : "text-[10px] tracking-[0.2em]"}`}>{props.label}</p>
      </div>
      <p className={`truncate font-semibold tracking-tight ${props.compact ? "mt-1.5 text-sm" : "mt-2 text-[0.95rem]"}`}>{props.value}</p>
      {props.detail ? <p className={`text-current/72 ${props.compact ? "mt-0.5 text-[10px]" : "mt-1 text-[11px]"}`}>{props.detail}</p> : null}
    </div>
  );
}

function SidebarFilterField(props: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{props.label}</span>
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        className="h-8 rounded-xl border-black/10 bg-white/68 text-xs shadow-none"
      />
    </label>
  );
}

function SidebarModeToggle(props: {
  items: Array<{ key: string; label: string; icon: ReactNode }>;
  activeKey: string;
  onChange: (key: string) => void;
}) {
  return (
    <div
      className="info-panel grid gap-1.5 rounded-[1.7rem] p-1.5"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, props.items.length)}, minmax(0, 1fr))` }}
    >
      {props.items.map((item) => (
        <Button
          key={item.key}
          variant="ghost"
          className={`h-12 justify-center rounded-[1.25rem] px-3 text-sm transition-all ${
            props.activeKey === item.key
              ? "border border-black/10 bg-white text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_10px_24px_-18px_rgba(17,17,17,0.4)]"
              : "text-muted-foreground hover:bg-white/55 hover:text-foreground"
          }`}
          onClick={() => props.onChange(item.key)}
        >
          <span className="mr-2.5 opacity-80">{item.icon}</span>
          <span>{item.label}</span>
        </Button>
      ))}
    </div>
  );
}

function SidebarActionItem(props: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  active?: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className={`h-auto w-full justify-start rounded-2xl px-3 py-3 text-left transition-all ${
        props.active
          ? "info-panel ob-list-item-active"
          : "info-panel info-panel-hoverable"
      }`}
      onClick={props.onClick}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {props.icon ? (
          <div
            className={`ob-list-item-icon mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
              props.active ? "ob-list-item-icon-active" : ""
            }`}
          >
            {props.icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">{props.title}</span>
            {props.badge ? <Badge variant="outline">{props.badge}</Badge> : null}
          </div>
          {props.subtitle ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{props.subtitle}</p> : null}
        </div>
      </div>
    </Button>
  );
}

function ToggleRow(props: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="info-panel flex items-center justify-between gap-3 rounded-xl px-3 py-2">
      <span className="text-sm text-foreground">{props.label}</span>
      <Switch checked={props.checked} onCheckedChange={props.onCheckedChange} />
    </label>
  );
}

function RuntimeSidebar(props: SidebarProps) {
  const showFilteredWorkspaceCount = props.filteredSavedWorkspaces.length !== props.orderedSavedWorkspaces.length;
  const workspaceCountLabel = showFilteredWorkspaceCount
    ? `${props.filteredSavedWorkspaces.length} of ${props.orderedSavedWorkspaces.length} workspaces`
    : `${props.orderedSavedWorkspaces.length} workspaces`;
  const sessionCountLabel =
    props.savedSessionsCount === props.totalSavedSessionsCount
      ? `${props.savedSessionsCount} sessions`
      : `${props.savedSessionsCount} of ${props.totalSavedSessionsCount} sessions`;

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
        (props.expandedSessionIds.includes(sessionEntry.id) ||
          (props.sessionId === sessionEntry.id ? true : hasActiveDescendant(sessionEntry.id, childSessionsByParentId ?? new Map(), props.sessionId)));
      return (
        <div key={sessionEntry.id} className={depth === 0 ? "space-y-1" : "space-y-0.5"}>
          <SessionNavItem
            entry={sessionEntry}
            depth={depth}
            active={sessionEntry.id === props.sessionId}
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="space-y-3 px-2 py-3">
          <div className="flex items-center justify-between gap-2 px-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Workspaces</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {workspaceCountLabel} · {sessionCountLabel} · {props.selectedServiceScopeLabel}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={props.refreshWorkspaceIndex} title="Refresh workspace list">
                <RotateCcw className="h-4 w-4" />
              </Button>
              {props.workspaceManagementEnabled ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => {
                    props.setWorkspaceDraft((current) => ({ ...current, blueprint: "" }));
                    props.setShowWorkspaceCreator(true);
                  }}
                  title="New Workspace"
                >
                  <FolderPlus className="h-4 w-4" />
                </Button>
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
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
                <Bot className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <label className="space-y-1 px-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Blueprint</span>
            <Select
              value={props.workspaceBlueprintFilter || "__all_blueprints__"}
              onValueChange={(value) => props.setWorkspaceBlueprintFilter(value === "__all_blueprints__" ? "" : value)}
            >
              <SelectTrigger className="h-8 w-full rounded-xl border-black/10 bg-white/68 text-xs shadow-none" aria-label="Workspace blueprint filter">
                <SelectValue placeholder="All blueprints" />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="__all_blueprints__">All blueprints</SelectItem>
                {props.workspaceBlueprintFilterOptions.map((blueprint) => (
                  <SelectItem key={blueprint} value={blueprint}>
                    {blueprint}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {props.filteredSavedWorkspaces.length === 0 ? (
            <div className="rounded-xl border border-dashed border-black/12 bg-white/32 px-4 py-8 text-center">
              <p className="text-sm font-medium text-foreground">
                {props.workspaceBlueprintFilter ? "No matching workspaces" : "No workspaces"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {props.workspaceBlueprintFilter
                  ? "Try another blueprint or service filter."
                  : props.serviceScope !== "__all__"
                    ? "Switch service scope or create a workspace in this service."
                    : "Create or load one."}
              </p>
            </div>
          ) : (
            props.filteredSavedWorkspaces.map((entry) => {
              const workspaceSessions = props.sessionsByWorkspaceId.get(entry.id) ?? [];
              const sessionIds = new Set(workspaceSessions.map((sessionEntry) => sessionEntry.id));
              const childSessionsByParentId = new Map<string, typeof workspaceSessions>();
              for (const sessionEntry of workspaceSessions) {
                if (!sessionEntry.parentSessionId || !sessionIds.has(sessionEntry.parentSessionId)) {
                  continue;
                }
                const children = childSessionsByParentId.get(sessionEntry.parentSessionId) ?? [];
                children.push(sessionEntry);
                childSessionsByParentId.set(sessionEntry.parentSessionId, children);
              }
              const topLevelSessions = workspaceSessions.filter(
                (sessionEntry) => !sessionEntry.parentSessionId || !sessionIds.has(sessionEntry.parentSessionId)
              );
              const isExpanded = props.expandedWorkspaceIds.includes(entry.id) || entry.id === props.activeWorkspaceId;
              const lastEditedAt = workspaceSessions.reduce<string | undefined>((latest, sessionEntry) => {
                if (!sessionEntry.lastRunAt) {
                  return latest;
                }

                if (!latest) {
                  return sessionEntry.lastRunAt;
                }

                return Date.parse(sessionEntry.lastRunAt) > Date.parse(latest) ? sessionEntry.lastRunAt : latest;
              }, undefined);

              return (
                <div key={entry.id} className="runtime-workspace-group space-y-1.5">
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
                    <div className="runtime-session-tree ml-2 space-y-1.5 pl-1">
                      {topLevelSessions.length === 0 ? (
                        <div className="rounded-lg px-3 py-2.5 text-xs text-muted-foreground">No sessions yet.</div>
                      ) : (
                        renderSessionTree(topLevelSessions, {
                          childSessionsByParentId,
                          workspaceId: entry.id
                        })
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-3 border-t border-black/8 px-3 py-3">
        <div className="grid gap-2">
          <ToggleRow label="Auto SSE" checked={props.autoStream} onCheckedChange={(checked) => props.setAutoStream(checked)} />
          <ToggleRow label="Current Run" checked={props.filterSelectedRun} onCheckedChange={(checked) => props.setFilterSelectedRun(checked)} />
        </div>
      </div>
    </div>
  );
}

function StorageSidebar(props: SidebarProps) {
  const postgresAvailable = props.storageOverview?.postgres.available ?? false;
  const redisAvailable = props.storageOverview?.redis.available ?? false;
  const postgresTableCount = props.storageOverview?.postgres.tables.length ?? 0;
  const redisLoadedCount = props.redisKeyPage?.items.length ?? 0;
  const runsTableSelected = props.selectedStorageTable === "runs";
  const postgresFilterCount = compactFilterCount([
    props.storageTableSearch ?? "",
    props.storageTableWorkspaceId ?? "",
    props.storageTableSessionId ?? "",
    props.storageTableRunId ?? "",
    ...(runsTableSelected
      ? [props.storageTableStatus ?? "", props.storageTableErrorCode ?? "", props.storageTableRecoveryState ?? ""]
      : [])
  ]);
  const redisHotCount =
    (props.storageOverview?.redis.sessionQueues.length ?? 0) +
    (props.storageOverview?.redis.sessionLocks.length ?? 0) +
    (props.storageOverview?.redis.eventBuffers.length ?? 0);
  const activeWorkerCount = props.healthReport?.worker.summary.active ?? props.healthReport?.worker.activeWorkers.length ?? 0;
  const targetWorkerCount = props.healthReport?.worker.pool?.desiredWorkers ?? activeWorkerCount;
  const lateWorkerCount =
    props.healthReport?.worker.summary.late ??
    props.healthReport?.worker.activeWorkers.filter((entry) => entry.health === "late").length ??
    0;
  const storageModeItems = props.storageRedisEnabled
    ? [
        { key: "postgres", label: "Postgres", icon: <Database className="h-4 w-4" /> },
        { key: "redis", label: "Redis", icon: <Workflow className="h-4 w-4" /> }
      ]
    : [{ key: "postgres", label: "Postgres", icon: <Database className="h-4 w-4" /> }];

  return (
    <div className="space-y-5 px-3 py-4">
      <div className="space-y-3 pb-1">
        <SidebarModeToggle activeKey={props.storageBrowserTab} onChange={(key) => props.onStorageBrowserTabChange(key as "postgres" | "redis")} items={storageModeItems} />
        <div className="grid grid-cols-3 gap-2">
          <SidebarMetric
            label="Postgres"
            value={postgresAvailable ? "online" : "offline"}
            detail={`${postgresTableCount} tables`}
            tone={postgresAvailable ? "emerald" : "rose"}
            compact
          />
          <SidebarMetric
            label="Scope"
            value={props.selectedServiceScopeLabel}
            detail={props.serviceScope === "__all__" ? "cross-service" : "active scope"}
            tone={props.serviceScope === "__all__" ? "sky" : "emerald"}
            compact
          />
          <SidebarMetric
            label="Redis"
            value={redisAvailable ? "online" : "offline"}
            detail={`${props.storageOverview?.redis.dbSize ?? 0} keys`}
            tone={redisAvailable ? "emerald" : "rose"}
            compact
          />
        </div>
      </div>

      {props.storageBrowserTab === "postgres" ? (
        <>
          <SidebarSection
            title="Filters"
            {...(postgresFilterCount > 0 ? { description: `${postgresFilterCount} active` } : {})}
            {...(postgresFilterCount > 0
              ? { action: <Badge variant="outline">{postgresFilterCount} active</Badge> }
              : {})}
          >
          {!postgresAvailable ? (
            <p className="text-sm text-muted-foreground">Postgres 当前不可用。</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2">
                <SidebarFilterField
                  label="Search"
                  value={props.storageTableSearch ?? ""}
                  onChange={props.onStorageTableSearchChange}
                  placeholder="Search row JSON"
                />
                <div className="grid grid-cols-2 gap-2">
                  <SidebarFilterField
                    label="Workspace"
                    value={props.storageTableWorkspaceId ?? ""}
                    onChange={props.onStorageTableWorkspaceIdChange}
                    placeholder="workspaceId"
                  />
                  <SidebarFilterField
                    label="Session"
                    value={props.storageTableSessionId ?? ""}
                    onChange={props.onStorageTableSessionIdChange}
                    placeholder="sessionId"
                  />
                </div>
                <SidebarFilterField
                  label="Run"
                  value={props.storageTableRunId ?? ""}
                  onChange={props.onStorageTableRunIdChange}
                  placeholder="runId"
                />
                {runsTableSelected ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Status</span>
                        <Select
                          value={props.storageTableStatus || "__all_run_statuses__"}
                          onValueChange={(value) => props.onStorageTableStatusChange(value === "__all_run_statuses__" ? "" : value)}
                        >
                          <SelectTrigger className="h-8 rounded-xl border-black/10 bg-white/68 text-xs shadow-none" aria-label="Run status filter">
                            <SelectValue placeholder="All statuses" />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value="__all_run_statuses__">All statuses</SelectItem>
                            <SelectItem value="failed">failed</SelectItem>
                            <SelectItem value="timed_out">timed_out</SelectItem>
                            <SelectItem value="queued">queued</SelectItem>
                            <SelectItem value="running">running</SelectItem>
                            <SelectItem value="waiting_tool">waiting_tool</SelectItem>
                            <SelectItem value="completed">completed</SelectItem>
                            <SelectItem value="cancelled">cancelled</SelectItem>
                          </SelectContent>
                        </Select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recovery</span>
                        <Select
                          value={props.storageTableRecoveryState || "__all_recovery_states__"}
                          onValueChange={(value) =>
                            props.onStorageTableRecoveryStateChange(value === "__all_recovery_states__" ? "" : value)
                          }
                        >
                          <SelectTrigger className="h-8 rounded-xl border-black/10 bg-white/68 text-xs shadow-none" aria-label="Run recovery state filter">
                            <SelectValue placeholder="All recovery states" />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value="__all_recovery_states__">All recovery states</SelectItem>
                            <SelectItem value="quarantined">quarantined</SelectItem>
                            <SelectItem value="failed">failed</SelectItem>
                            <SelectItem value="requeued">requeued</SelectItem>
                          </SelectContent>
                        </Select>
                      </label>
                    </div>
                    <SidebarFilterField
                      label="Error Code"
                      value={props.storageTableErrorCode ?? ""}
                      onChange={props.onStorageTableErrorCodeChange}
                      placeholder="worker_recovery_failed"
                    />
                  </>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" className="h-9 rounded-xl" onClick={props.onRefreshStorageTable} disabled={props.storageBusy}>
                  <Search className="h-4 w-4" />
                  Apply
                </Button>
                <Button variant="outline" className="h-9 rounded-xl" onClick={props.onClearStorageTableFilters} disabled={props.storageBusy}>
                  Clear
                </Button>
              </div>
            </div>
          )}
          </SidebarSection>

          {!postgresAvailable ? (
            <div className="border-t border-black/8 pt-4">
              <p className="text-sm text-muted-foreground">Postgres 当前不可用。</p>
            </div>
          ) : (
            <div className="space-y-1.5 border-t border-black/8 pt-4">
              {props.storageOverview?.postgres.tables.map((table) => (
                <SidebarActionItem
                  key={table.name}
                  title={tableLabel(table.name)}
                  subtitle={`${table.description} · order by ${table.orderBy}`}
                  badge={String(table.rowCount)}
                  icon={<Database className="h-4 w-4" />}
                  active={props.selectedStorageTable === table.name}
                  onClick={() => {
                    props.onStorageBrowserTabChange("postgres");
                    props.onSelectStorageTable(table.name);
                  }}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <SidebarSection title="Pattern">
            <div className="flex gap-2">
              <Input
                value={props.redisKeyPattern}
                onChange={(event) => props.onRedisKeyPatternChange(event.target.value)}
                placeholder="oah:*"
                className="h-9 rounded-xl border-black/10 bg-white/68 text-xs shadow-none"
              />
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9 rounded-xl"
                onClick={() => {
                  props.onStorageBrowserTabChange("redis");
                  props.onRefreshRedisKeys();
                }}
                disabled={props.storageBusy}
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SidebarMetric label="Pattern" value={props.redisKeyPage?.pattern ?? (props.redisKeyPattern || "oah:*")} tone="sky" />
              <SidebarMetric label="Loaded" value={`${redisLoadedCount} keys`} tone="sky" />
            </div>
          </SidebarSection>

          <SidebarSection
            title="Hot Paths"
            {...(redisHotCount > 0 ? { description: `${redisHotCount} entries` } : {})}
          >
            <div className="grid grid-cols-3 gap-2">
              <SidebarMetric label="Queues" value={String(props.storageOverview?.redis.sessionQueues.length ?? 0)} tone="amber" />
              <SidebarMetric label="Locks" value={String(props.storageOverview?.redis.sessionLocks.length ?? 0)} tone="rose" />
              <SidebarMetric label="Buffers" value={String(props.storageOverview?.redis.eventBuffers.length ?? 0)} tone="sky" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <SidebarMetric label="Workers" value={String(activeWorkerCount)} tone={activeWorkerCount > 0 ? "emerald" : "sky"} />
              <SidebarMetric label="Target" value={String(targetWorkerCount)} tone="sky" />
              <SidebarMetric label="Late" value={String(lateWorkerCount)} tone={lateWorkerCount > 0 ? "amber" : "emerald"} />
            </div>
            <div className="space-y-1.5">
              {props.storageOverview?.redis.sessionQueues.slice(0, 4).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.sessionId}
                  subtitle={item.key}
                  badge={`${item.length}`}
                  icon={<Workflow className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {props.storageOverview?.redis.sessionLocks.slice(0, 3).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.sessionId}
                  subtitle={item.key}
                  badge={item.ttlMs !== undefined ? `${item.ttlMs}ms` : "lock"}
                  icon={<Lock className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {props.storageOverview?.redis.eventBuffers.slice(0, 3).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.sessionId}
                  subtitle={item.key}
                  badge={`${item.length}`}
                  icon={<Rows3 className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {(props.storageOverview?.redis.sessionQueues.length ?? 0) === 0 &&
              (props.storageOverview?.redis.sessionLocks.length ?? 0) === 0 &&
              (props.storageOverview?.redis.eventBuffers.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">当前没有活跃的 queue、lock 或 event buffer。</p>
              ) : null}
            </div>
          </SidebarSection>

          <SidebarSection title="Loaded Keys" description="从当前 pattern 的结果里快速切换到具体 key。">
            <div className="space-y-1.5">
              {props.redisKeyPage?.items.slice(0, 10).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.key}
                  subtitle={item.type}
                  {...(item.size !== undefined ? { badge: `${item.size}` } : {})}
                  icon={<Rows3 className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {redisLoadedCount === 0 ? <p className="text-sm text-muted-foreground">还没有加载到 Redis key。</p> : null}
            </div>
          </SidebarSection>
        </>
      )}
    </div>
  );
}

function ProviderSidebar(props: SidebarProps) {
  const defaultModel = props.platformModels.find((model) => model.isDefault);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        <div className="space-y-5">
          <div className="space-y-3 border-b border-black/8 pb-4">
            <div className="grid grid-cols-2 gap-2">
              <SidebarMetric label="Health" value={props.healthStatus} tone={probeTone(props.healthStatus)} />
              <SidebarMetric label="Stream" value={props.streamState} tone={streamTone(props.streamState)} />
              <SidebarMetric label="Models" value={String(props.platformModels.length)} tone="emerald" />
              <SidebarMetric label="Providers" value={String(props.modelProviders.length)} tone="sky" />
            </div>
            <div className="space-y-2 border-l border-black/8 pl-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Base URL</p>
              <p className="truncate text-xs text-foreground">{props.connection.baseUrl || "not configured"}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className={toneBadgeClass(probeTone(props.readinessReport?.status ?? "unknown"))}>
                  {`ready ${props.readinessReport?.status ?? "unknown"}`}
                </Badge>
                {defaultModel ? <Badge variant="outline">default {defaultModel.id}</Badge> : null}
              </div>
            </div>
          </div>

          <SidebarSection title="Quick Actions">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" className="h-10 justify-start rounded-2xl" onClick={props.pingHealth}>
                <Network className="h-4 w-4" />
                Health
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={() => props.setStreamRevision((current) => current + 1)}>
                <Orbit className="h-4 w-4" />
                SSE
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={props.refreshModelProviders}>
                <RefreshCw className="h-4 w-4" />
                Providers
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={props.refreshPlatformModels}>
                <Workflow className="h-4 w-4" />
                Models
              </Button>
            </div>
          </SidebarSection>

          <SidebarSection title="Models" description="点击切换当前 Playground 模型。">
            <div className="space-y-1.5">
              {props.platformModels.length === 0 ? (
                <p className="text-sm text-muted-foreground">当前还没有加载到平台模型。</p>
              ) : (
                props.platformModels.map((model) => (
                  <SidebarActionItem
                    key={model.id}
                    icon={<Workflow className="h-4 w-4" />}
                    title={model.id}
                    subtitle={[
                      model.modelName,
                      model.provider,
                      model.hasKey ? "key ready" : "no key"
                    ].join(" · ")}
                    badge={model.isDefault ? "default" : model.provider}
                    active={props.modelDraft.model === model.id}
                    onClick={() => props.setModelDraft((current) => ({ ...current, model: model.id }))}
                  />
                ))
              )}
            </div>
          </SidebarSection>
        </div>
      </div>
    </div>
  );
}

export function AppSidebar(props: SidebarProps) {
  const uploadTemplateInputRef = useRef<HTMLInputElement>(null);
  const [uploadTemplateName, setUploadTemplateName] = useState("");
  const [uploadTemplateOverwrite, setUploadTemplateOverwrite] = useState(false);
  const [uploadTemplateFile, setUploadTemplateFile] = useState<File | null>(null);
  const [showUploadTemplateDialog, setShowUploadTemplateDialog] = useState(false);

  const icon =
    props.surfaceMode === "storage" ? <Table2 className="h-4 w-4" /> : props.surfaceMode === "provider" ? <Network className="h-4 w-4" /> : <Bot className="h-4 w-4" />;
  const title = props.surfaceMode === "storage" ? "Storage" : props.surfaceMode === "provider" ? "Provider" : "Runtime";
  const subtitle =
    props.surfaceMode === "storage"
      ? "Inspect Postgres tables and Redis keyspace."
      : props.surfaceMode === "provider"
        ? "Connection, health, and provider registry."
        : "Navigate workspaces and sessions.";

  return (
    <>
      <aside className="app-sidebar-surface flex min-h-0 w-[288px] shrink-0 flex-col border-r border-black/10">
        <div className="border-b border-black/8 bg-gradient-to-b from-white/34 to-transparent px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-black/10 bg-white/72 shadow-[inset_0_1px_0_rgba(255,255,255,0.74),0_14px_24px_-22px_rgba(17,17,17,0.42)]">
                {icon}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold tracking-tight text-foreground">{title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</p>
              </div>
            </div>
            {props.surfaceMode === "storage" ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-xl"
                onClick={props.onRefreshStorageOverview}
                disabled={props.storageBusy}
                title="Refresh storage overview"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {props.surfaceMode === "storage" ? (
            <div className="h-full overflow-y-auto overflow-x-hidden">
              <StorageSidebar {...props} />
            </div>
          ) : props.surfaceMode === "provider" ? (
            <div className="h-full overflow-y-auto overflow-x-hidden">
              <ProviderSidebar {...props} />
            </div>
          ) : (
            <RuntimeSidebar {...props} />
          )}
        </div>
      </aside>

      <Dialog open={props.showWorkspaceCreator} onOpenChange={props.setShowWorkspaceCreator}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Workspace</DialogTitle>
            <DialogDescription>
              Leave Root path empty to create a managed workspace folder named with a generated workspace id.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={props.workspaceDraft.name ?? ""}
              onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Workspace name"
            />
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <Select
                  value={props.workspaceDraft.blueprint?.trim() ?? ""}
                  onValueChange={(value) => props.setWorkspaceDraft((current) => ({ ...current, blueprint: value }))}
                >
                  <SelectTrigger className="h-10 flex-1 rounded-xl border-black/10 bg-white/68 text-sm shadow-none" aria-label="Workspace blueprint">
                    <SelectValue placeholder={props.workspaceBlueprints.length > 0 ? "Select blueprint" : "No blueprints available"} />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {props.workspaceBlueprints.length > 0 ? (
                      props.workspaceBlueprints.map((blueprint) => (
                        <SelectItem key={blueprint} value={blueprint}>
                          {blueprint}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__no_templates__" disabled>
                        No blueprints available
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <input
                  ref={uploadTemplateInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const derivedName = file.name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
                    setUploadTemplateName(derivedName);
                    setUploadTemplateFile(file);
                    setUploadTemplateOverwrite(false);
                    setShowUploadTemplateDialog(true);
                    event.target.value = "";
                  }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 shrink-0 rounded-xl"
                  onClick={() => uploadTemplateInputRef.current?.click()}
                  title="Upload blueprint (.zip)"
                >
                  <Upload className="h-4 w-4" />
                </Button>
              </div>
              <p className="px-1 text-xs leading-5 text-muted-foreground">
                {props.workspaceBlueprints.length > 0
                  ? "Choose a blueprint or upload a .zip folder as a new blueprint."
                  : "Blueprint list is empty. Upload a .zip or use the refresh button."}
              </p>
            </div>
            <Input
              value={props.workspaceDraft.rootPath ?? ""}
              onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, rootPath: event.target.value }))}
              placeholder="Root path"
            />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Input
                  value={props.workspaceDraft.ownerId ?? ""}
                  onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, ownerId: event.target.value }))}
                  placeholder="Owner ID (optional)"
                />
                <p className="px-1 text-xs leading-5 text-muted-foreground">
                  Only set this when the workspace should stay bound to one owner.
                </p>
              </div>
              <div className="space-y-1">
                <Input
                  value={props.workspaceDraft.serviceName ?? ""}
                  onChange={(event) =>
                    props.setWorkspaceDraft((current) => ({ ...current, serviceName: event.target.value }))
                  }
                  placeholder="Service name (optional)"
                />
                <p className="px-1 text-xs leading-5 text-muted-foreground">
                  Leave empty to use the default OAH service namespace.
                </p>
              </div>
            </div>
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Managed mode: auto-create under workspace_dir/workspace_id. Custom mode: use the path you enter here.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => props.refreshWorkspaceBlueprints()}>
              <RefreshCw className="h-4 w-4" />
              Blueprints
            </Button>
            <Button
              onClick={() => {
                props.createWorkspace();
                props.setShowWorkspaceCreator(false);
              }}
            >
              <FolderPlus className="h-4 w-4" />
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showUploadTemplateDialog} onOpenChange={setShowUploadTemplateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Blueprint</DialogTitle>
            <DialogDescription>
              Upload a .zip file containing the blueprint folder structure. It will be extracted as a new workspace blueprint.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={uploadTemplateName}
              onChange={(event) => setUploadTemplateName(event.target.value.replace(/[^a-zA-Z0-9_-]/g, "_"))}
              placeholder="Blueprint name"
            />
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Only alphanumeric characters, hyphens, and underscores are allowed.
            </p>
            <div className="flex items-center gap-2">
              <Switch
                checked={uploadTemplateOverwrite}
                onCheckedChange={setUploadTemplateOverwrite}
                id="overwrite-blueprint"
              />
              <label htmlFor="overwrite-blueprint" className="text-sm text-muted-foreground">
                Overwrite if exists
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowUploadTemplateDialog(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!uploadTemplateName.trim() || !uploadTemplateFile}
              onClick={async () => {
                if (!uploadTemplateFile) return;
                const ok = await props.uploadWorkspaceBlueprint(
                  uploadTemplateFile,
                  uploadTemplateName.trim(),
                  uploadTemplateOverwrite
                );
                if (ok) {
                  setShowUploadTemplateDialog(false);
                  setUploadTemplateFile(null);
                  setUploadTemplateName("");
                  setUploadTemplateOverwrite(false);
                  props.setWorkspaceDraft((current) => ({
                    ...current,
                    blueprint: uploadTemplateName.trim()
                  }));
                }
              }}
            >
              <Upload className="h-4 w-4" />
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
