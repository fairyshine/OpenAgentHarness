import { Database, Lock, Rows3, Search, Workflow } from "lucide-react";
import { useShallow } from "zustand/shallow";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { useHealthStore } from "../stores/health-store";
import { useSettingsStore } from "../stores/settings-store";
import {
  SidebarActionItem,
  SidebarFilterField,
  SidebarMetric,
  SidebarModeToggle,
  SidebarSection,
  compactFilterCount,
  tableLabel
} from "./sidebar-primitives";
import type { SidebarProps } from "./sidebar-types";

function StorageSidebar(props: SidebarProps) {
  const { healthReport } = useHealthStore(
    useShallow((state) => ({
      healthReport: state.healthReport
    }))
  );
  const { serviceScope } = useSettingsStore(
    useShallow((state) => ({
      serviceScope: state.serviceScope
    }))
  );
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
  const activeWorkerCount = healthReport?.worker.summary.active ?? healthReport?.worker.activeWorkers.length ?? 0;
  const targetWorkerCount = healthReport?.worker.pool?.desiredWorkers ?? activeWorkerCount;
  const lateWorkerCount =
    healthReport?.worker.summary.late ??
    healthReport?.worker.activeWorkers.filter((entry) => entry.health === "late").length ??
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
            detail={serviceScope === "__all__" ? "cross-service" : "active scope"}
            tone={serviceScope === "__all__" ? "sky" : "emerald"}
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

export { StorageSidebar };
