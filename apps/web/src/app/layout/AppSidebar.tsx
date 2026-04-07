import type { ReactNode } from "react";

import {
  Bot,
  Database,
  FolderPlus,
  Globe,
  Lock,
  Network,
  Orbit,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  Table2,
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
import { Switch } from "@/components/ui/switch";

import { probeTone } from "../support";
import type { useAppController } from "../use-app-controller";
import { SessionNavItem, WorkspaceNavItem } from "./sidebar-items";

type SidebarProps = ReturnType<typeof useAppController>["sidebarSurfaceProps"];

function statusClass(tone: "sky" | "emerald" | "rose" | "amber") {
  switch (tone) {
    case "emerald":
      return "border-emerald-200/80 bg-emerald-50/80 text-emerald-700 dark:border-emerald-800/80 dark:bg-emerald-950/40 dark:text-emerald-400";
    case "rose":
      return "border-rose-200/80 bg-rose-50/80 text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/40 dark:text-rose-400";
    case "amber":
      return "border-amber-200/80 bg-amber-50/80 text-amber-700 dark:border-amber-800/80 dark:bg-amber-950/40 dark:text-amber-400";
    default:
      return "border-sky-200/80 bg-sky-50/80 text-sky-700 dark:border-sky-800/80 dark:bg-sky-950/40 dark:text-sky-400";
  }
}

function streamTone(value: SidebarProps["streamState"]): "sky" | "emerald" | "rose" | "amber" {
  if (value === "open" || value === "listening") {
    return "emerald";
  }
  if (value === "error") {
    return "rose";
  }
  if (value === "connecting") {
    return "amber";
  }
  return "sky";
}

function tableLabel(name: string) {
  return name.replace(/_/g, " ");
}

function compactFilterCount(values: string[]) {
  return values.filter((value) => value.trim().length > 0).length;
}

function SidebarSection(props: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
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
    <section className={`border-b border-border/60 pb-4 ${props.accentClassName ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-muted/35">
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

function SidebarMetric(props: { label: string; value: string; tone?: "sky" | "emerald" | "rose" | "amber" }) {
  return (
    <div className={`rounded-2xl border px-3 py-2 ${statusClass(props.tone ?? "sky")}`}>
      <p className="text-[10px] uppercase tracking-[0.14em]">{props.label}</p>
      <p className="mt-1 truncate text-sm font-semibold tracking-tight">{props.value}</p>
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
        className="h-8 rounded-xl border-border/70 bg-background/85 text-xs shadow-none"
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
    <div className="grid grid-cols-2 gap-1 rounded-2xl border border-border/70 bg-muted/35 p-1">
      {props.items.map((item) => (
        <Button
          key={item.key}
          variant="ghost"
          className={`h-10 justify-start rounded-xl px-3 ${
            props.activeKey === item.key
              ? "border border-border/70 bg-background shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => props.onChange(item.key)}
        >
          {item.icon}
          {item.label}
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
      className={`h-auto w-full justify-start rounded-2xl border px-3 py-3 text-left transition-all ${
        props.active
          ? "border-foreground/10 bg-foreground/[0.06] shadow-sm"
          : "border-transparent bg-transparent hover:border-border/70 hover:bg-muted/35"
      }`}
      onClick={props.onClick}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {props.icon ? (
          <div
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${
              props.active ? "border-foreground/10 bg-background/85 text-foreground" : "border-border/60 bg-muted/45 text-muted-foreground"
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
    <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
      <span className="text-sm text-foreground">{props.label}</span>
      <Switch checked={props.checked} onCheckedChange={props.onCheckedChange} />
    </label>
  );
}

function RuntimeSidebar(props: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="space-y-3 px-2 py-3">
          <div className="flex items-center justify-between gap-2 px-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Workspaces</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {props.orderedSavedWorkspaces.length} workspaces · {props.savedSessionsCount} sessions
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
                    props.setWorkspaceDraft((current) => ({ ...current, template: "" }));
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
          {props.orderedSavedWorkspaces.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-8 text-center">
              <p className="text-sm font-medium text-foreground">No workspaces</p>
              <p className="mt-1 text-sm text-muted-foreground">Create or load one.</p>
            </div>
          ) : (
            props.orderedSavedWorkspaces.map((entry) => {
              const workspaceSessions = props.sessionsByWorkspaceId.get(entry.id) ?? [];
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
                <div key={entry.id} className="space-y-1">
                  <WorkspaceNavItem
                    entry={entry}
                    active={entry.id === props.activeWorkspaceId}
                    expanded={isExpanded}
                    sessionCount={workspaceSessions.length}
                    lastEditedAt={lastEditedAt}
                    canRemove={props.workspaceManagementEnabled}
                    onSelect={() => props.openWorkspace(entry.id)}
                    onToggleExpanded={() => props.toggleWorkspaceExpansion(entry.id)}
                    onRemove={() => props.deleteWorkspace(entry.id)}
                  />
                  {isExpanded ? (
                    <div className="ml-4 space-y-1">
                      {workspaceSessions.length === 0 ? (
                        <div className="rounded-md px-2 py-2 text-xs text-muted-foreground">No sessions yet.</div>
                      ) : (
                        workspaceSessions.map((sessionEntry) => (
                          <SessionNavItem
                            key={sessionEntry.id}
                            entry={sessionEntry}
                            active={sessionEntry.id === props.sessionId}
                            onSelect={() => {
                              props.expandWorkspaceInSidebar(entry.id);
                              props.refreshSessionById(sessionEntry.id);
                            }}
                            onRename={(title) => props.renameSession(sessionEntry.id, title)}
                            onRemove={() => props.removeSavedSession(sessionEntry.id)}
                          />
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-3 border-t border-border/80 px-3 py-3">
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
  const postgresFilterCount = compactFilterCount([
    props.storageTableSearch ?? "",
    props.storageTableWorkspaceId ?? "",
    props.storageTableSessionId ?? "",
    props.storageTableRunId ?? ""
  ]);
  const redisHotCount =
    (props.storageOverview?.redis.sessionQueues.length ?? 0) +
    (props.storageOverview?.redis.sessionLocks.length ?? 0) +
    (props.storageOverview?.redis.eventBuffers.length ?? 0);

  return (
    <div className="space-y-5 px-3 py-4">
      <SidebarHero
        icon={<Table2 className="h-4 w-4 text-foreground" />}
        action={
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={props.onRefreshStorageOverview} disabled={props.storageBusy}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      >
        <SidebarModeToggle
          activeKey={props.storageBrowserTab}
          onChange={(key) => props.onStorageBrowserTabChange(key as "postgres" | "redis")}
          items={[
            { key: "postgres", label: "Postgres", icon: <Database className="h-4 w-4" /> },
            { key: "redis", label: "Redis", icon: <Workflow className="h-4 w-4" /> }
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          <SidebarMetric label="Postgres" value={postgresAvailable ? "online" : "offline"} tone={postgresAvailable ? "emerald" : "rose"} />
          <SidebarMetric label="Redis" value={redisAvailable ? "online" : "offline"} tone={redisAvailable ? "emerald" : "rose"} />
        </div>
      </SidebarHero>

      {props.storageBrowserTab === "postgres" ? (
        <>
          <SidebarSection title="Entities" description={postgresTableCount > 0 ? `${postgresTableCount} tables` : undefined}>
            {!postgresAvailable ? (
              <p className="text-sm text-muted-foreground">Postgres 当前不可用。</p>
            ) : (
              <div className="space-y-1.5">
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
          </SidebarSection>

          <SidebarSection
            title="Filters"
            description={postgresFilterCount > 0 ? `${postgresFilterCount} active` : undefined}
            action={postgresFilterCount > 0 ? <Badge variant="outline">{postgresFilterCount} active</Badge> : undefined}
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
        </>
      ) : (
        <>
          <SidebarSection title="Pattern">
            <div className="flex gap-2">
              <Input
                value={props.redisKeyPattern}
                onChange={(event) => props.onRedisKeyPatternChange(event.target.value)}
                placeholder="oah:*"
                className="h-9 rounded-xl border-border/70 bg-background/85 text-xs shadow-none"
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

          <SidebarSection title="Hot Paths" description={redisHotCount > 0 ? `${redisHotCount} entries` : undefined}>
            <div className="grid grid-cols-3 gap-2">
              <SidebarMetric label="Queues" value={String(props.storageOverview?.redis.sessionQueues.length ?? 0)} tone="amber" />
              <SidebarMetric label="Locks" value={String(props.storageOverview?.redis.sessionLocks.length ?? 0)} tone="rose" />
              <SidebarMetric label="Buffers" value={String(props.storageOverview?.redis.eventBuffers.length ?? 0)} tone="sky" />
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
                  badge={item.size !== undefined ? `${item.size}` : undefined}
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
          <SidebarHero
            icon={<Network className="h-4 w-4 text-foreground" />}
            title="Provider"
          >
            <div className="grid grid-cols-2 gap-2">
              <SidebarMetric label="Health" value={props.healthStatus} tone={probeTone(props.healthStatus)} />
              <SidebarMetric label="Stream" value={props.streamState} tone={streamTone(props.streamState)} />
              <SidebarMetric label="Models" value={String(props.platformModels.length)} tone="emerald" />
              <SidebarMetric label="Providers" value={String(props.modelProviders.length)} tone="sky" />
            </div>
            <div className="space-y-2 rounded-[18px] border border-border/70 bg-background/80 px-3 py-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <Globe className="h-3.5 w-3.5" />
                Base URL
              </div>
              <p className="truncate text-xs text-foreground">{props.connection.baseUrl || "not configured"}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">ready {props.readinessReport?.status ?? "unknown"}</Badge>
                {defaultModel ? <Badge variant="outline">default {defaultModel.id}</Badge> : null}
              </div>
            </div>
          </SidebarHero>

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
      <aside className="bg-background flex min-h-0 w-[288px] shrink-0 flex-col border-r border-border">
        <div className="border-b border-border/80 bg-gradient-to-b from-muted/35 to-transparent px-3 py-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-background shadow-sm">
              {icon}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-tight text-foreground">{title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</p>
            </div>
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
            <Input value={props.workspaceDraft.name} onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Workspace name" />
            <Input list="workspace-template-options" value={props.workspaceDraft.template} onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, template: event.target.value }))} placeholder="Template" />
            <datalist id="workspace-template-options">
              {props.workspaceTemplates.map((template) => (
                <option key={template} value={template} />
              ))}
            </datalist>
            <Input value={props.workspaceDraft.rootPath} onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, rootPath: event.target.value }))} placeholder="Root path" />
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Managed mode: auto-create under workspace_dir/workspace_id. Custom mode: use the path you enter here.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => props.refreshWorkspaceTemplates()}>
              <RefreshCw className="h-4 w-4" />
              Templates
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
    </>
  );
}
