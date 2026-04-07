import { Download, RefreshCw } from "lucide-react";

import type {
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisKeyDetail,
  StorageRedisKeyPage
} from "@oah/api-contracts";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

import {
  contentPreview,
  contentText,
  contentToolRefs,
  formatTimestamp,
  isRecord,
  normalizeMessageContent,
  prettyJson,
  statusTone,
  storageMessageFromRow,
  storageRunStepFromRow,
  storageSessionEventFromRow,
  storageToolCallFromRow,
  toModelCallTrace,
  type StorageBrowserTab
} from "./support";
import { EmptyState, InsightRow, JsonBlock, PayloadValueView, modelMessageTone } from "./primitives";
import { InspectorPanelHeader, MessageContentDetail, MessageToolRefChips, ModelCallTraceCard } from "./inspector-panels";

const STORAGE_TABLE_META: Record<
  StoragePostgresTableName,
  {
    label: string;
  }
> = {
  workspaces: {
    label: "Workspaces"
  },
  sessions: {
    label: "Sessions"
  },
  runs: {
    label: "Runs"
  },
  messages: {
    label: "Messages"
  },
  run_steps: {
    label: "Run Steps"
  },
  session_events: {
    label: "Session Events"
  },
  tool_calls: {
    label: "Tool Calls"
  },
  hook_runs: {
    label: "Hook Runs"
  },
  artifacts: {
    label: "Artifacts"
  },
  history_events: {
    label: "History Events"
  }
};

function StorageTableNavItem(props: {
  label: string;
  description: string;
  orderBy: string;
  rowCount: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "w-full rounded-[18px] border px-3 py-3 text-left transition",
        props.active
          ? "border-foreground/12 bg-foreground/[0.045]"
          : "border-transparent bg-transparent hover:border-border/70 hover:bg-muted/26"
      )}
      onClick={props.onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{props.label}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p>
        </div>
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{props.rowCount}</span>
      </div>
      <p className="mt-2 truncate text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{props.orderBy}</p>
    </button>
  );
}

function StorageToolbarMeta(props: { label: string; value: string | number }) {
  return (
    <div className="rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground">
      <span className="uppercase tracking-[0.12em]">{props.label}</span>
      <span className="ml-1.5 font-medium tracking-normal text-foreground">{props.value}</span>
    </div>
  );
}

function StorageWorkbench(props: {
  browserTab: StorageBrowserTab;
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  selectedRedisKeys: string[];
  onSelectedRedisKeysChange: (keys: string[]) => void;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshTable: () => void;
  onPreviousTablePage: () => void;
  onNextTablePage: () => void;
  onClearTableFilters: () => void;
  onDownloadTableCsv: () => void;
  onRefreshRedisKeys: () => void;
  onLoadMoreRedisKeys: () => void;
  onRefreshRedisKey: () => void;
  onDeleteRedisKey: () => void;
  onDeleteSelectedRedisKeys: () => void;
  onClearRedisSessionQueue: (key: string) => void;
  onReleaseRedisSessionLock: (key: string) => void;
  busy: boolean;
}) {
  return (
    <section className="flex min-h-0 flex-col">
      {props.browserTab === "postgres" ? (
        <StoragePostgresPanel
          overview={props.overview}
          tablePage={props.tablePage}
          selectedTable={props.selectedTable}
          selectedRow={props.selectedRow}
          onSelectRow={props.onSelectRow}
          onRefresh={props.onRefreshTable}
          onPreviousPage={props.onPreviousTablePage}
          onNextPage={props.onNextTablePage}
          onClearFilters={props.onClearTableFilters}
          onDownloadCsv={props.onDownloadTableCsv}
          busy={props.busy}
        />
      ) : (
        <StorageRedisPanel
          overview={props.overview}
          redisKeyPage={props.redisKeyPage}
          selectedRedisKey={props.selectedRedisKey}
          selectedRedisKeys={props.selectedRedisKeys}
          onSelectedRedisKeysChange={props.onSelectedRedisKeysChange}
          onSelectRedisKey={props.onSelectRedisKey}
          redisKeyDetail={props.redisKeyDetail}
          onRefreshKeys={props.onRefreshRedisKeys}
          onLoadMoreKeys={props.onLoadMoreRedisKeys}
          onRefreshKey={props.onRefreshRedisKey}
          onDeleteKey={props.onDeleteRedisKey}
          onDeleteSelectedKeys={props.onDeleteSelectedRedisKeys}
          onClearSessionQueue={props.onClearRedisSessionQueue}
          onReleaseSessionLock={props.onReleaseRedisSessionLock}
          busy={props.busy}
        />
      )}
    </section>
  );
}

function StoragePostgresPanel(props: {
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  onRefresh: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onClearFilters: () => void;
  onDownloadCsv: () => void;
  busy: boolean;
}) {
  const selectedMeta = STORAGE_TABLE_META[props.selectedTable];

  return (
    <section className="min-w-0">
      {!props.overview?.postgres.available ? (
        <EmptyState title="Postgres unavailable" description="当前服务没有启用 Postgres，或者 Postgres 暂时不可达。" />
      ) : props.tablePage ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 border-b border-border/70 pb-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{selectedMeta.label}</Badge>
              {props.tablePage.appliedFilters ? <Badge variant="outline">filtered</Badge> : null}
              <Badge variant="outline">{props.tablePage.rows.length} rows</Badge>
              <StorageToolbarMeta label="total" value={props.tablePage.rowCount} />
              <StorageToolbarMeta label="order" value={props.tablePage.orderBy} />
              <StorageToolbarMeta label="offset" value={props.tablePage.offset} />
              <StorageToolbarMeta label="limit" value={props.tablePage.limit} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={props.onRefresh} disabled={props.busy}>
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
              <Button variant="ghost" size="sm" onClick={props.onDownloadCsv}>
                <Download className="h-4 w-4" />
                CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={props.onPreviousPage} disabled={props.busy || props.tablePage.offset === 0}>
                Prev
              </Button>
              <Button variant="ghost" size="sm" onClick={props.onNextPage} disabled={props.busy || props.tablePage.nextOffset === undefined}>
                Next
              </Button>
            </div>
          </div>

          <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1.24fr)_minmax(320px,0.76fr)]">
            <StorageDataGrid
              tableName={props.tablePage.table}
              columns={props.tablePage.columns}
              rows={props.tablePage.rows}
              selectedRow={props.selectedRow}
              onSelectRow={props.onSelectRow}
            />

            <div className="space-y-3 border-t border-border/70 pt-4 2xl:border-t-0 2xl:border-l 2xl:pt-0 2xl:pl-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-foreground">
                  {props.tablePage.table === "messages"
                    ? "Message Detail"
                    : props.tablePage.table === "run_steps"
                      ? "Run Step Detail"
                      : props.tablePage.table === "tool_calls"
                        ? "Tool Call Detail"
                        : props.tablePage.table === "session_events"
                          ? "Session Event Detail"
                          : "Row Detail"}
                </p>
                {props.selectedRow ? <Badge variant="outline">selected</Badge> : null}
              </div>

              {props.selectedRow ? (
                props.tablePage.table === "messages" ? (
                  <StorageMessageRowDetail row={props.selectedRow} />
                ) : props.tablePage.table === "run_steps" ? (
                  <StorageRunStepRowDetail row={props.selectedRow} />
                ) : props.tablePage.table === "tool_calls" ? (
                  <StorageToolCallRowDetail row={props.selectedRow} />
                ) : props.tablePage.table === "session_events" ? (
                  <StorageSessionEventRowDetail row={props.selectedRow} />
                ) : (
                  <JsonBlock title="Row" value={props.selectedRow} />
                )
              ) : (
                <EmptyState title="No row selected" description="Select a row from the preview grid to inspect the stored record." />
              )}
            </div>
          </div>
        </div>
      ) : (
        <EmptyState title="No table selected" description="Select a Postgres table from the left rail to inspect recent rows." />
      )}
    </section>
  );
}

function StorageRedisPanel(props: {
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

  return (
    <section className="min-w-0">
      {!props.overview?.redis.available ? (
        <EmptyState title="Redis unavailable" description="当前服务没有启用 Redis，或者 Redis 暂时不可达。" />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 border-b border-border/70 pb-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Redis Keys</Badge>
              <Badge variant="outline">{props.redisKeyPage?.items.length ?? 0} loaded</Badge>
              {selectedCount > 0 ? <Badge variant="outline">{selectedCount} selected</Badge> : null}
              <StorageToolbarMeta label="dbsize" value={props.overview.redis.dbSize ?? 0} />
              <StorageToolbarMeta label="ready" value={props.overview.redis.readyQueue?.length ?? 0} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={props.onRefreshKeys} disabled={props.busy}>
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
              <Button variant="destructive" onClick={props.onDeleteSelectedKeys} disabled={props.busy || selectedCount === 0}>
                Delete Selected
              </Button>
            </div>
          </div>

          <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,0.96fr)_minmax(320px,1.04fr)]">
            <div className="space-y-3">
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
              {props.redisKeyPage?.nextCursor ? (
                <Button variant="ghost" size="sm" onClick={props.onLoadMoreKeys} disabled={props.busy}>
                  Load More
                </Button>
              ) : null}
            </div>

            <div className="space-y-3 border-t border-border/70 pt-4 2xl:border-t-0 2xl:border-l 2xl:pt-0 2xl:pl-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Selected Key</p>
                  <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">
                    {props.redisKeyDetail?.key ?? "Pick a key from the list or from the queue / lock snapshots."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
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
              </div>

              {props.redisKeyDetail ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge>{props.redisKeyDetail.type}</Badge>
                    {props.redisKeyDetail.size !== undefined ? <Badge>{`size ${props.redisKeyDetail.size}`}</Badge> : null}
                    {props.redisKeyDetail.ttlMs !== undefined ? <Badge>{`ttl ${props.redisKeyDetail.ttlMs}ms`}</Badge> : <Badge>persistent</Badge>}
                  </div>
                  <JsonBlock title="Value" value={props.redisKeyDetail.value ?? {}} />
                </div>
              ) : (
                <EmptyState title="No key selected" description="Choose a Redis key to inspect its current value and metadata." />
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function formatStorageCellPreview(
  value: unknown,
  options?: {
    tableName?: StoragePostgresTableName;
    columnName?: string;
  }
) {
  if (options?.tableName === "messages" && options.columnName === "content") {
    const normalized = normalizeMessageContent(value);
    if (normalized !== null) {
      return contentPreview(normalized, 180);
    }
  }

  if (options?.tableName === "run_steps" && (options.columnName === "input" || options.columnName === "output") && isRecord(value)) {
    if (options.columnName === "input") {
      const request = isRecord(value.request) ? value.request : {};
      const runtime = isRecord(value.runtime) ? value.runtime : {};

      if (typeof request.model === "string") {
        const messageCount = typeof runtime.messageCount === "number" ? ` · ${runtime.messageCount} msgs` : "";
        return `${request.model}${messageCount}`;
      }

      if (typeof value.sourceType === "string") {
        return `${value.sourceType} input`;
      }
    }

    if (options.columnName === "output") {
      const response = isRecord(value.response) ? value.response : {};

      if (typeof response.finishReason === "string") {
        const calls = Array.isArray(response.toolCalls) ? response.toolCalls.length : 0;
        const results = Array.isArray(response.toolResults) ? response.toolResults.length : 0;
        return `${response.finishReason} · ${calls} calls · ${results} results`;
      }

      if (typeof value.sourceType === "string") {
        return `${value.sourceType} output`;
      }
    }
  }

  if (options?.tableName === "tool_calls") {
    if (options.columnName === "request" && isRecord(value)) {
      const sourceType = typeof value.sourceType === "string" ? value.sourceType : undefined;
      const actionName = typeof value.actionName === "string" ? value.actionName : undefined;
      if (actionName) {
        return `${actionName}${sourceType ? ` · ${sourceType}` : ""}`;
      }
      return sourceType ? `${sourceType} request` : "request";
    }

    if (options.columnName === "response" && isRecord(value)) {
      const sourceType = typeof value.sourceType === "string" ? value.sourceType : undefined;
      const duration = typeof value.durationMs === "number" ? ` · ${value.durationMs}ms` : "";
      return `${sourceType ?? "response"}${duration}`;
    }
  }

  if (options?.tableName === "session_events" && options.columnName === "data" && isRecord(value)) {
    const normalizedContent = normalizeMessageContent(value.content);
    if (normalizedContent !== null) {
      return contentPreview(normalizedContent, 180);
    }

    if (typeof value.toolName === "string") {
      return `${value.toolName}${typeof value.toolCallId === "string" ? ` · ${value.toolCallId}` : ""}`;
    }

    if (typeof value.status === "string") {
      return value.status;
    }
  }

  const raw =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) {
    return compact || " ";
  }

  return `${compact.slice(0, 180)}...`;
}

function StorageDataGrid(props: {
  tableName: StoragePostgresTableName;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown>) => void;
}) {
  if (props.rows.length === 0) {
    return <EmptyState title="No rows" description="This table is currently empty." />;
  }

  return (
    <div className="data-grid-shell overflow-hidden rounded-[18px] border border-border/70 bg-background/80">
      <div className="max-h-[34rem] overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-foreground/80">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
            <tr>
              {props.columns.map((column) => (
                <th key={column} className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, index) => (
              <tr
                key={`row:${index}`}
                className={cn(
                  "cursor-pointer align-top odd:bg-background even:bg-muted/20 hover:bg-muted/40",
                  props.selectedRow === row ? "bg-primary/5 even:bg-primary/5" : ""
                )}
                onClick={() => props.onSelectRow(row)}
              >
                {props.columns.map((column) => (
                  <td key={`${index}:${column}`} className="max-w-[280px] border-b border-border px-3 py-2">
                    <div
                      className="line-clamp-4 break-words text-xs leading-6 text-foreground/80"
                      title={typeof row[column] === "string" ? row[column] : prettyJson(row[column])}
                    >
                      {formatStorageCellPreview(row[column], {
                        tableName: props.tableName,
                        columnName: column
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StorageMessageRowDetail(props: { row: Record<string, unknown> }) {
  const message = storageMessageFromRow(props.row);

  if (!message) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const text = contentText(message.content);
  const refs = contentToolRefs(message.content);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
          {message.role}
        </span>
        {message.runId ? <Badge>{message.runId}</Badge> : null}
        <MessageToolRefChips content={message.content} />
        <Badge>{formatTimestamp(message.createdAt)}</Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Message ID" value={message.id} />
        <InsightRow label="Session ID" value={message.sessionId} />
        <InsightRow label="Parts" value={String(Array.isArray(message.content) ? message.content.length : 1)} />
        <InsightRow label="Text Size" value={String(text.length)} />
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Message Content</p>
        <div className="mt-3">
          <MessageContentDetail content={message.content} maxHeightClassName="max-h-[26rem]" />
        </div>
      </div>

      {refs.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Tool Trace</p>
          <div className="mt-3 space-y-2">
            {refs.map((ref, index) => (
              <div key={`${ref.type}:${ref.toolCallId}:${index}`} className="subtle-panel rounded-[16px] border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{ref.type}</Badge>
                  <Badge>{ref.toolName}</Badge>
                  <Badge>{ref.toolCallId}</Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {message.metadata ? <JsonBlock title="Metadata" value={message.metadata} /> : null}
      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageRunStepRowDetail(props: { row: Record<string, unknown> }) {
  const step = storageRunStepFromRow(props.row);

  if (!step) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const modelTrace = toModelCallTrace(step);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{`step ${step.seq}`}</Badge>
        <Badge>{step.stepType}</Badge>
        <Badge className={statusTone(step.status)}>{step.status}</Badge>
        {step.name ? <Badge>{step.name}</Badge> : null}
        {step.agentName ? <Badge>{step.agentName}</Badge> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Step ID" value={step.id} />
        <InsightRow label="Run ID" value={step.runId} />
        <InsightRow label="Started" value={formatTimestamp(step.startedAt)} />
        <InsightRow label="Ended" value={formatTimestamp(step.endedAt)} />
      </div>

      {modelTrace ? (
        <div className="space-y-3">
          <InspectorPanelHeader
            title="Model Call Trace"
            description="Storage 里的 run_step 已直接还原成 model call 视图，方便在数据库维度核对一次模型请求与返回。"
          />
          <ModelCallTraceCard trace={modelTrace} />
        </div>
      ) : (
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Structured Step Payload</p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <JsonBlock title="Input" value={step.input ?? {}} />
            <JsonBlock title="Output" value={step.output ?? {}} />
          </div>
        </div>
      )}

      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageToolCallRowDetail(props: { row: Record<string, unknown> }) {
  const record = storageToolCallFromRow(props.row);

  if (!record) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{record.toolName}</Badge>
        <Badge>{record.sourceType}</Badge>
        <Badge className={statusTone(record.status)}>{record.status}</Badge>
        {record.stepId ? <Badge>{record.stepId}</Badge> : null}
        {record.durationMs !== undefined ? <Badge>{`${record.durationMs}ms`}</Badge> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Tool Call ID" value={record.id} />
        <InsightRow label="Run ID" value={record.runId} />
        <InsightRow label="Started" value={formatTimestamp(record.startedAt)} />
        <InsightRow label="Ended" value={formatTimestamp(record.endedAt)} />
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Tool Audit Payload</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="panel-card overflow-hidden rounded-[18px] border">
            <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">Request</div>
            <div className="p-3">
              <PayloadValueView value={record.request ?? {}} maxHeightClassName="max-h-72" mode="input" />
            </div>
          </div>
          <div className="panel-card overflow-hidden rounded-[18px] border">
            <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">Response</div>
            <div className="p-3">
              <PayloadValueView value={record.response ?? {}} maxHeightClassName="max-h-72" mode="result" />
            </div>
          </div>
        </div>
      </div>

      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageSessionEventRowDetail(props: { row: Record<string, unknown> }) {
  const event = storageSessionEventFromRow(props.row);

  if (!event) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const eventContent = normalizeMessageContent(event.data.content);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{event.event}</Badge>
        {event.runId ? <Badge>{event.runId}</Badge> : null}
        <Badge>{`cursor ${event.cursor}`}</Badge>
        {typeof event.data.toolName === "string" ? <Badge>{String(event.data.toolName)}</Badge> : null}
        {typeof event.data.toolCallId === "string" ? <Badge>{String(event.data.toolCallId)}</Badge> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Event ID" value={event.id} />
        <InsightRow label="Session ID" value={event.sessionId} />
        <InsightRow label="Created" value={formatTimestamp(event.createdAt)} />
        <InsightRow label="Payload Keys" value={String(Object.keys(event.data).length)} />
      </div>

      {eventContent !== null ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Message Payload</p>
          <div className="mt-3">
            <MessageContentDetail content={eventContent} maxHeightClassName="max-h-[24rem]" />
          </div>
        </div>
      ) : null}

      <JsonBlock title="Event Data" value={event.data} />
      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageRedisKeyGrid(props: {
  items: StorageRedisKeyPage["items"];
  selectedKey: string;
  selectedKeys: string[];
  onToggleSelected: (key: string) => void;
  onToggleSelectAll: (keys: string[]) => void;
  onSelect: (key: string) => void;
}) {
  if (props.items.length === 0) {
    return <EmptyState title="No keys loaded" description="Load Redis keys by pattern to inspect current keyspace." />;
  }

  return (
    <div className="data-grid-shell overflow-hidden rounded-[18px] border border-border/70 bg-background/80">
      <div className="max-h-[34rem] overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-foreground/80">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
            <tr>
              <th className="w-10 border-b border-border px-3 py-2">
                <input
                  type="checkbox"
                  checked={props.items.length > 0 && props.items.every((item) => props.selectedKeys.includes(item.key))}
                  onChange={() => props.onToggleSelectAll(props.items.map((item) => item.key))}
                />
              </th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">key</th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">type</th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">size</th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">ttl</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <tr
                key={item.key}
                className={cn(
                  "cursor-pointer align-top transition odd:bg-background even:bg-muted/20 hover:bg-muted/40",
                  props.selectedKey === item.key ? "bg-primary/5 even:bg-primary/5" : ""
                )}
                onClick={() => props.onSelect(item.key)}
              >
                <td className="border-b border-border px-3 py-2" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={props.selectedKeys.includes(item.key)} onChange={() => props.onToggleSelected(item.key)} />
                </td>
                <td className="max-w-[520px] border-b border-border px-3 py-2">
                  <div className="break-all text-xs leading-6 text-foreground/80">{item.key}</div>
                </td>
                <td className="border-b border-border px-3 py-2">{item.type}</td>
                <td className="border-b border-border px-3 py-2">{item.size ?? "n/a"}</td>
                <td className="border-b border-border px-3 py-2">{item.ttlMs !== undefined ? `${item.ttlMs}ms` : "persistent"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { StorageWorkbench };
