import type { StorageOverview, StorageRedisKeyDetail, StorageRedisKeyPage } from "@oah/api-contracts";
import { RefreshCw } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../primitives";
import { toneBadgeClass, workerHealthTone, workerStateTone, type HealthReportResponse } from "../support";
import { StorageDetailFacts, StorageDetailSection } from "./storage-detail-primitives";
import { StoragePanelToolbar } from "./StoragePanelToolbar";
import { StorageRedisKeyGrid } from "./StorageRedisKeyGrid";
import { StorageSurfaceLayout } from "./StorageSurfaceLayout";
import { renderStorageEmptyDetail, renderStorageRedisDetail } from "./storage-detail-renderers";
import { StorageToolbarMeta } from "./storage-meta";

function formatWorkerLeaseAge(ageMs: number) {
  if (ageMs < 1_000) {
    return `${ageMs} ms`;
  }

  if (ageMs < 60_000) {
    return `${(ageMs / 1_000).toFixed(ageMs >= 10_000 ? 0 : 1)} s`;
  }

  const minutes = ageMs / 60_000;
  if (minutes < 60) {
    return `${minutes.toFixed(minutes >= 10 ? 0 : 1)} min`;
  }

  const hours = minutes / 60;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)} h`;
}

function formatPoolReason(reason: NonNullable<NonNullable<HealthReportResponse["worker"]["pool"]>["lastRebalanceReason"]>) {
  switch (reason) {
    case "scale_up":
      return "scale up";
    case "scale_down":
      return "scale down";
    case "cooldown_hold":
      return "cooldown hold";
    default:
      return reason;
  }
}

function renderWorkerLeaseSummary(healthReport: HealthReportResponse | null) {
  const activeWorkers = healthReport?.worker.activeWorkers ?? [];
  const localSlots = healthReport?.worker.localSlots ?? healthReport?.worker.pool?.slots ?? [];
  const summary = healthReport?.worker.summary;
  const pool = healthReport?.worker.pool;
  const lateWorkerCount = summary?.late ?? activeWorkers.filter((entry) => entry.health === "late").length;
  const healthyWorkerCount = summary?.healthy ?? activeWorkers.length - lateWorkerCount;

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">worker leases</Badge>
        <Badge variant="outline">{`mode ${healthReport?.worker.mode ?? "unknown"}`}</Badge>
        <Badge variant="outline">{`serial ${healthReport?.worker.sessionSerialBoundary ?? "unknown"}`}</Badge>
        <Badge variant="outline">{`${summary?.active ?? activeWorkers.length} active`}</Badge>
        <Badge className={healthyWorkerCount > 0 ? toneBadgeClass("emerald") : undefined} variant="outline">
          {`${healthyWorkerCount} healthy`}
        </Badge>
        <Badge className={lateWorkerCount > 0 ? toneBadgeClass("amber") : undefined} variant="outline">
          {`${lateWorkerCount} late`}
        </Badge>
      </div>

      <StorageDetailFacts
        items={[
          { label: "Worker Mode", value: healthReport?.worker.mode ?? "unknown" },
          { label: "Session Boundary", value: healthReport?.worker.sessionSerialBoundary ?? "unknown" },
          { label: "Storage Queue", value: healthReport?.storage.runQueue ?? "unknown" },
          { label: "Redis Check", value: healthReport?.checks.redisRunQueue ?? "unknown" },
          { label: "Process Mode", value: healthReport?.process.label ?? "unknown" }
        ]}
      />

      {pool ? (
        <div className="space-y-3">
          <StorageDetailFacts
            items={[
              { label: "Pool Target", value: `${pool.desiredWorkers} / ${pool.slotCapacity}` },
              {
                label: "Suggested",
                value: `local ${pool.suggestedWorkers} · global ${pool.globalSuggestedWorkers ?? pool.suggestedWorkers} · reserve ${pool.reservedWorkers ?? 0}`
              },
              {
                label: "Busy / Idle",
                value: `${pool.busySlots ?? pool.busyWorkers} busy · ${pool.idleSlots ?? pool.idleWorkers} idle · headroom ${pool.availableIdleCapacity}`
              },
              {
                label: "Global / Remote",
                value: `global ${pool.globalActiveWorkers ?? pool.activeWorkers}/${pool.globalBusyWorkers ?? pool.busyWorkers} · remote ${pool.remoteActiveWorkers ?? 0}/${pool.remoteBusyWorkers ?? 0}`
              },
              { label: "Local Slots", value: `${localSlots.length} observed` },
              { label: "Schedulable Sessions", value: String(pool.readySessionCount ?? 0) },
              {
                label: "Ready Queue",
                value: `depth ${pool.readyQueueDepth ?? 0} · unique ${pool.uniqueReadySessionCount ?? 0}`
              },
              {
                label: "Subagent Pressure",
                value: `schedulable ${pool.subagentReadySessionCount ?? 0} · depth ${pool.subagentReadyQueueDepth ?? 0} · target ${pool.subagentReserveTarget} · deficit ${pool.subagentReserveDeficit}`
              },
              {
                label: "Ready Density",
                value: `per worker ${pool.readySessionsPerActiveWorker?.toFixed(2) ?? "n/a"}`
              },
              {
                label: "Held / Stale",
                value: `locked ${pool.lockedReadySessionCount ?? 0} · stale ${pool.staleReadySessionCount ?? 0}`
              },
              {
                label: "Age Trigger",
                value: `oldest ${formatWorkerLeaseAge(pool.oldestSchedulableReadyAgeMs ?? 0)} · busy ${(pool.scaleUpBusyRatioThreshold * 100).toFixed(0)}% · age ${formatWorkerLeaseAge(pool.scaleUpMaxReadyAgeMs)}`
              },
              { label: "Last Rebalance", value: pool.lastRebalanceReason ? formatPoolReason(pool.lastRebalanceReason) : "n/a" },
              {
                label: "Cooldowns",
                value: `up ${formatWorkerLeaseAge(pool.scaleUpCooldownRemainingMs)} / down ${formatWorkerLeaseAge(pool.scaleDownCooldownRemainingMs)}`
              },
              {
                label: "Pressure Window",
                value: `up ${pool.scaleUpPressureStreak}/${pool.scaleUpSampleSize} · down ${pool.scaleDownPressureStreak}/${pool.scaleDownSampleSize}`
              }
            ]}
          />

          {pool.recentDecisions.length > 0 ? (
            <StorageDetailSection title="Recent Pool Decisions">
              <div className="space-y-2">
                {pool.recentDecisions.slice().reverse().map((decision) => (
                  <div key={`${decision.timestamp}:${decision.reason}:${decision.desiredWorkers}:${decision.activeWorkers}`} className="info-panel rounded-xl px-3 py-2 text-xs text-foreground/80">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{formatPoolReason(decision.reason)}</Badge>
                      <Badge variant="outline">{`suggested ${decision.suggestedWorkers}`}</Badge>
                      {typeof decision.globalSuggestedWorkers === "number" ? (
                        <Badge variant="outline">{`global ${decision.globalSuggestedWorkers}`}</Badge>
                      ) : null}
                      <Badge variant="outline">{`desired ${decision.desiredWorkers}`}</Badge>
                      <Badge variant="outline">{`active ${decision.activeWorkers}`}</Badge>
                      {typeof decision.busyWorkers === "number" ? <Badge variant="outline">{`busy ${decision.busyWorkers}`}</Badge> : null}
                      <span className="text-muted-foreground">{decision.timestamp}</span>
                    </div>
                    <div className="mt-2 text-muted-foreground">{`schedulable ${decision.readySessionCount ?? 0} · depth ${decision.readyQueueDepth ?? 0} · unique ${decision.uniqueReadySessionCount ?? 0} · subagent ${decision.subagentReadySessionCount ?? 0}/${decision.subagentReadyQueueDepth ?? 0} · reserve ${decision.reservedWorkers ?? 0}/${decision.reservedSubagentCapacity ?? 0} · headroom ${decision.availableIdleCapacity ?? 0} · deficit ${decision.subagentReserveDeficit ?? 0} · ready/worker ${typeof decision.readySessionsPerActiveWorker === "number" ? decision.readySessionsPerActiveWorker.toFixed(2) : "n/a"} · locked ${decision.lockedReadySessionCount ?? 0} · stale ${decision.staleReadySessionCount ?? 0} · oldest ${formatWorkerLeaseAge(decision.oldestSchedulableReadyAgeMs ?? 0)} · global ${decision.globalActiveWorkers ?? decision.activeWorkers}/${decision.globalBusyWorkers ?? decision.busyWorkers ?? 0} · remote ${decision.remoteActiveWorkers ?? 0}/${decision.remoteBusyWorkers ?? 0}`}</div>
                  </div>
                ))}
              </div>
            </StorageDetailSection>
          ) : null}

          {localSlots.length > 0 ? (
            <StorageDetailSection title="Local Execution Slots">
              <div className="grid gap-2 xl:grid-cols-2">
                {localSlots.map((slot) => (
                  <div key={slot.slotId} className="info-panel rounded-xl px-3 py-2 text-xs text-foreground/80">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="max-w-full truncate font-mono">
                        {slot.slotId}
                      </Badge>
                      <Badge variant="outline" className={toneBadgeClass(workerStateTone(slot.state))}>
                        {slot.state}
                      </Badge>
                      <Badge variant="outline">{slot.processKind}</Badge>
                      {slot.currentSessionId ? (
                        <Badge variant="outline" className="max-w-full truncate font-mono">
                          {`session ${slot.currentSessionId}`}
                        </Badge>
                      ) : null}
                      {slot.currentRunId ? (
                        <Badge variant="outline" className="max-w-full truncate font-mono">
                          {`run ${slot.currentRunId}`}
                        </Badge>
                      ) : null}
                      {slot.currentWorkspaceId ? (
                        <Badge variant="outline" className="max-w-full truncate font-mono">
                          {`workspace ${slot.currentWorkspaceId}`}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </StorageDetailSection>
          ) : null}
        </div>
      ) : null}

      {activeWorkers.length === 0 ? (
        <p className="text-sm leading-6 text-muted-foreground">
          当前还没有上报中的 Redis worker lease。若服务运行在 API only 模式，或外部 worker 尚未启动，这里会保持为空。
        </p>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {activeWorkers.map((worker) => (
            <section key={worker.workerId} className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="max-w-full truncate font-mono">
                  {worker.workerId}
                </Badge>
                <Badge variant="outline" className={toneBadgeClass(workerStateTone(worker.state))}>
                  {worker.state}
                </Badge>
                <Badge variant="outline" className={toneBadgeClass(workerHealthTone(worker.health))}>
                  {worker.health}
                </Badge>
                <Badge variant="outline">{worker.processKind}</Badge>
                {worker.currentSessionId ? (
                  <Badge variant="outline" className="max-w-full truncate font-mono">
                    {`session ${worker.currentSessionId}`}
                  </Badge>
                ) : null}
                {worker.currentRunId ? (
                  <Badge variant="outline" className="max-w-full truncate font-mono">
                    {`run ${worker.currentRunId}`}
                  </Badge>
                ) : null}
                {worker.currentWorkspaceId ? (
                  <Badge variant="outline" className="max-w-full truncate font-mono">
                    {`workspace ${worker.currentWorkspaceId}`}
                  </Badge>
                ) : null}
              </div>

              <StorageDetailFacts
                items={[
                  { label: "Last Seen", value: worker.lastSeenAt },
                  { label: "Seen Age", value: formatWorkerLeaseAge(worker.lastSeenAgeMs) },
                  { label: "Expires", value: worker.expiresAt },
                  { label: "Lease TTL", value: formatWorkerLeaseAge(worker.leaseTtlMs) }
                ]}
              />
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

export function StorageRedisPanel(props: {
  healthReport: HealthReportResponse | null;
  overview: StorageOverview | null;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  selectedRedisKeys: string[];
  onSelectedRedisKeysChange: (keys: string[]) => void;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshKeys: () => void;
  onLoadMoreKeys: () => void;
  onRefreshKey: () => void;
  onDeleteKey: () => void;
  onDeleteSelectedKeys: () => void;
  onClearSessionQueue: (key: string) => void;
  onReleaseSessionLock: (key: string) => void;
  busy: boolean;
}) {
  const selectedCount = props.selectedRedisKeys.length;
  const activeWorkers = props.healthReport?.worker.activeWorkers ?? [];
  const workerSummary = props.healthReport?.worker.summary;
  const workerPool = props.healthReport?.worker.pool;
  const activeWorkerCount = workerSummary?.active ?? activeWorkers.length;
  const lateWorkerCount = workerSummary?.late ?? activeWorkers.filter((entry) => entry.health === "late").length;

  return (
    <section className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[5.25rem_minmax(0,1fr)] gap-4 overflow-hidden">
      {!props.overview?.redis.available ? (
        <EmptyState title="Redis unavailable" description="当前服务没有启用 Redis，或者 Redis 暂时不可达。" />
      ) : (
        <>
          <StoragePanelToolbar
            leading={
              <>
                <Badge variant="secondary">Redis Keys</Badge>
                <Badge variant="outline">{props.redisKeyPage?.items.length ?? 0} loaded</Badge>
                {selectedCount > 0 ? <Badge variant="outline">{selectedCount} selected</Badge> : null}
              </>
            }
            meta={
              <>
                <StorageToolbarMeta label="dbsize" value={props.overview.redis.dbSize ?? 0} />
                <StorageToolbarMeta label="ready" value={props.overview.redis.readyQueue?.length ?? 0} />
                <StorageToolbarMeta label="workers" value={activeWorkerCount} />
                <StorageToolbarMeta label="target" value={workerPool?.desiredWorkers ?? activeWorkerCount} />
                <StorageToolbarMeta label="late" value={lateWorkerCount} />
              </>
            }
            actions={
              <>
                <Button variant="secondary" size="sm" onClick={props.onRefreshKeys} disabled={props.busy}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                <Button variant="destructive" onClick={props.onDeleteSelectedKeys} disabled={props.busy || selectedCount === 0}>
                  Delete Selected
                </Button>
              </>
            }
          />

          <StorageSurfaceLayout
            detailTitle="Key Detail"
            detailSummary={
              props.redisKeyDetail?.key ? (
                <span className="block break-all">{props.redisKeyDetail.key}</span>
              ) : (
                "Pick a key from the list or from the queue / lock snapshots."
              )
            }
            detailAction={
              <div className="flex flex-nowrap justify-end gap-2 whitespace-nowrap">
                <Button variant="secondary" size="sm" onClick={props.onRefreshKey} disabled={props.busy || !props.selectedRedisKey}>
                  Refresh
                </Button>
                {props.selectedRedisKey.endsWith(":queue") ? (
                  <Button variant="secondary" size="sm" onClick={() => props.onClearSessionQueue(props.selectedRedisKey)} disabled={props.busy}>
                    Clear Queue
                  </Button>
                ) : null}
                {props.selectedRedisKey.endsWith(":lock") ? (
                  <Button variant="secondary" size="sm" onClick={() => props.onReleaseSessionLock(props.selectedRedisKey)} disabled={props.busy}>
                    Release Lock
                  </Button>
                ) : null}
                <Button variant="destructive" size="sm" onClick={props.onDeleteKey} disabled={props.busy || !props.selectedRedisKey}>
                  Delete Key
                </Button>
              </div>
            }
            detailBody={
              <div className="space-y-4">
                {renderWorkerLeaseSummary(props.healthReport)}
                {props.redisKeyDetail
                  ? renderStorageRedisDetail(props.redisKeyDetail)
                  : renderStorageEmptyDetail("No key selected", "Choose a Redis key to inspect its current value and metadata.")}
              </div>
            }
            previewMeta={
              <>
                <Badge variant="outline">{props.redisKeyPage?.items.length ?? 0} loaded</Badge>
                {selectedCount > 0 ? <Badge variant="outline">{selectedCount} selected</Badge> : null}
                <Badge variant="outline">{`${activeWorkerCount} workers`}</Badge>
                {workerPool ? <Badge variant="outline">{`target ${workerPool.desiredWorkers}`}</Badge> : null}
                {lateWorkerCount > 0 ? (
                  <Badge variant="outline" className={toneBadgeClass("amber")}>
                    {`${lateWorkerCount} late`}
                  </Badge>
                ) : null}
              </>
            }
            previewContent={
              <StorageRedisKeyGrid
                items={props.redisKeyPage?.items ?? []}
                selectedKey={props.selectedRedisKey}
                selectedKeys={props.selectedRedisKeys}
                onToggleSelected={(key) =>
                  props.onSelectedRedisKeysChange(
                    props.selectedRedisKeys.includes(key)
                      ? props.selectedRedisKeys.filter((entry) => entry !== key)
                      : [...props.selectedRedisKeys, key]
                  )
                }
                onToggleSelectAll={(keys) =>
                  props.onSelectedRedisKeysChange(
                    keys.every((key) => props.selectedRedisKeys.includes(key))
                      ? props.selectedRedisKeys.filter((entry) => !keys.includes(entry))
                      : [...new Set([...props.selectedRedisKeys, ...keys])]
                  )
                }
                onSelect={props.onSelectRedisKey}
              />
            }
            previewFooter={
              props.redisKeyPage?.nextCursor ? (
                <Button variant="ghost" size="sm" onClick={props.onLoadMoreKeys} disabled={props.busy}>
                  Load More
                </Button>
              ) : undefined
            }
          />
        </>
      )}
    </section>
  );
}
