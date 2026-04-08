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
import { EmptyState, modelMessageTone } from "./primitives";
import { MessageToolRefChips } from "./inspector-panels";

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

function StoragePlainRowDetail(props: { row: Record<string, unknown> }) {
  return (
    <div className="min-w-0">
      <pre className="overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80">{prettyJson(props.row)}</pre>
    </div>
  );
}

function StorageDetailFacts(props: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {props.items.map((item) => (
        <div key={item.label} className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{item.label}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

function StorageDetailSection(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{props.title}</p>
      {props.children}
    </section>
  );
}

function StorageDetailPre(props: { value: string; maxHeightClassName?: string }) {
  return (
    <pre
      className={cn(
        "min-w-0 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80",
        props.maxHeightClassName
      )}
    >
      {props.value}
    </pre>
  );
}

function StorageDetailJson(props: { value: unknown; maxHeightClassName?: string }) {
  return <StorageDetailPre value={prettyJson(props.value)} maxHeightClassName={props.maxHeightClassName} />;
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!props.overview?.postgres.available ? (
        <EmptyState title="Postgres unavailable" description="当前服务没有启用 Postgres，或者 Postgres 暂时不可达。" />
      ) : props.tablePage ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
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

          <div className="grid min-h-0 min-w-0 flex-1 gap-3 [grid-template-rows:minmax(11rem,0.58fr)_minmax(24rem,1.42fr)]">
            <div className="min-h-0 min-w-0 overflow-hidden">
              <div className="flex h-full min-h-0 min-w-0 flex-col">
                <div className="flex items-start justify-between gap-3 px-1 py-1">
                  <div>
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
                  </div>
                  {props.selectedRow ? <Badge variant="outline">selected</Badge> : null}
                </div>

                <div className="min-h-0 min-w-0 flex-1 overflow-auto px-1 py-2">
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
                      <StoragePlainRowDetail row={props.selectedRow} />
                    )
                  ) : (
                    <EmptyState title="No row selected" description="Select a row from the preview grid to inspect the stored record." />
                  )}
                </div>
              </div>
            </div>

            <div className="min-h-0 min-w-0 flex flex-col gap-3 overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Table Preview</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    下半区展示当前页记录，保留更大的滚动空间来浏览表格内容。
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{props.tablePage.columns.length} cols</Badge>
                  <Badge variant="outline">{props.tablePage.rows.length} rows</Badge>
                </div>
              </div>

              <StorageDataGrid
                tableName={props.tablePage.table}
                columns={props.tablePage.columns}
                rows={props.tablePage.rows}
                selectedRow={props.selectedRow}
                onSelectRow={props.onSelectRow}
              />
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!props.overview?.redis.available ? (
        <EmptyState title="Redis unavailable" description="当前服务没有启用 Redis，或者 Redis 暂时不可达。" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
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

          <div className="grid min-h-0 min-w-0 flex-1 gap-3 [grid-template-rows:minmax(11rem,0.58fr)_minmax(24rem,1.42fr)]">
            <div className="min-h-0 min-w-0 overflow-hidden">
              <div className="flex h-full min-h-0 min-w-0 flex-col">
                <div className="flex flex-wrap items-start justify-between gap-3 px-1 py-1">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Selected Key</p>
                    <p className="mt-0.5 break-all text-xs leading-5 text-muted-foreground">
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

                <div className="min-h-0 min-w-0 flex-1 overflow-auto px-1 py-2">
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

            <div className="min-h-0 min-w-0 flex flex-col gap-3 overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Key Table</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">下半区保留更大的键列表浏览空间，方便批量勾选和连续检查。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{props.redisKeyPage?.items.length ?? 0} loaded</Badge>
                  {selectedCount > 0 ? <Badge variant="outline">{selectedCount} selected</Badge> : null}
                </div>
              </div>

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
    <div className="data-grid-shell flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-border/70 bg-background/80">
      <div className="min-h-0 flex-1 overflow-auto">
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
    return <StoragePlainRowDetail row={props.row} />;
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
      <StorageDetailFacts
        items={[
          { label: "Message ID", value: message.id },
          { label: "Session ID", value: message.sessionId },
          { label: "Parts", value: String(Array.isArray(message.content) ? message.content.length : 1) },
          { label: "Text Size", value: String(text.length) }
        ]}
      />

      <StorageDetailSection title="Message Content">
        <StorageDetailPre value={text || prettyJson(message.content)} maxHeightClassName="max-h-[18rem]" />
      </StorageDetailSection>

      {refs.length > 0 ? (
        <StorageDetailSection title="Tool Trace">
          <div className="flex flex-wrap gap-2">
            {refs.map((ref, index) => (
              <Badge key={`${ref.type}:${ref.toolCallId}:${index}`}>{`${ref.type} · ${ref.toolName} · ${ref.toolCallId}`}</Badge>
            ))}
          </div>
        </StorageDetailSection>
      ) : null}

      {message.metadata ? (
        <StorageDetailSection title="Metadata">
          <StorageDetailJson value={message.metadata} maxHeightClassName="max-h-40" />
        </StorageDetailSection>
      ) : null}
      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} maxHeightClassName="max-h-56" />
      </StorageDetailSection>
    </div>
  );
}

function StorageRunStepRowDetail(props: { row: Record<string, unknown> }) {
  const step = storageRunStepFromRow(props.row);

  if (!step) {
    return <StoragePlainRowDetail row={props.row} />;
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
      <StorageDetailFacts
        items={[
          { label: "Step ID", value: step.id },
          { label: "Run ID", value: step.runId },
          { label: "Started", value: formatTimestamp(step.startedAt) },
          { label: "Ended", value: formatTimestamp(step.endedAt) }
        ]}
      />

      {modelTrace ? (
        <StorageDetailSection title="Model Call Trace">
          <StorageDetailJson value={modelTrace} maxHeightClassName="max-h-[18rem]" />
        </StorageDetailSection>
      ) : (
        <>
          <StorageDetailSection title="Input">
            <StorageDetailJson value={step.input ?? {}} maxHeightClassName="max-h-40" />
          </StorageDetailSection>
          <StorageDetailSection title="Output">
            <StorageDetailJson value={step.output ?? {}} maxHeightClassName="max-h-40" />
          </StorageDetailSection>
        </>
      )}

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} maxHeightClassName="max-h-56" />
      </StorageDetailSection>
    </div>
  );
}

function StorageToolCallRowDetail(props: { row: Record<string, unknown> }) {
  const record = storageToolCallFromRow(props.row);

  if (!record) {
    return <StoragePlainRowDetail row={props.row} />;
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
      <StorageDetailFacts
        items={[
          { label: "Tool Call ID", value: record.id },
          { label: "Run ID", value: record.runId },
          { label: "Started", value: formatTimestamp(record.startedAt) },
          { label: "Ended", value: formatTimestamp(record.endedAt) }
        ]}
      />

      <StorageDetailSection title="Request">
        <StorageDetailJson value={record.request ?? {}} maxHeightClassName="max-h-40" />
      </StorageDetailSection>
      <StorageDetailSection title="Response">
        <StorageDetailJson value={record.response ?? {}} maxHeightClassName="max-h-40" />
      </StorageDetailSection>

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} maxHeightClassName="max-h-56" />
      </StorageDetailSection>
    </div>
  );
}

function StorageSessionEventRowDetail(props: { row: Record<string, unknown> }) {
  const event = storageSessionEventFromRow(props.row);

  if (!event) {
    return <StoragePlainRowDetail row={props.row} />;
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
      <StorageDetailFacts
        items={[
          { label: "Event ID", value: event.id },
          { label: "Session ID", value: event.sessionId },
          { label: "Created", value: formatTimestamp(event.createdAt) },
          { label: "Payload Keys", value: String(Object.keys(event.data).length) }
        ]}
      />

      {eventContent !== null ? (
        <StorageDetailSection title="Message Payload">
          <StorageDetailJson value={eventContent} maxHeightClassName="max-h-[18rem]" />
        </StorageDetailSection>
      ) : null}

      <StorageDetailSection title="Event Data">
        <StorageDetailJson value={event.data} maxHeightClassName="max-h-40" />
      </StorageDetailSection>
      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} maxHeightClassName="max-h-56" />
      </StorageDetailSection>
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
    <div className="data-grid-shell flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-border/70 bg-background/80">
      <div className="min-h-0 flex-1 overflow-auto">
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
