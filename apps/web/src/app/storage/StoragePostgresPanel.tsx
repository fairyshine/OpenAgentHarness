import type { StorageOverview, StoragePostgresTableName, StoragePostgresTablePage } from "@oah/api-contracts";
import { Download, RefreshCw } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../primitives";
import { StorageDataGrid } from "./StorageDataGrid";
import { StorageDetailFacts } from "./storage-detail-primitives";
import { StoragePanelToolbar } from "./StoragePanelToolbar";
import { StorageSurfaceLayout } from "./StorageSurfaceLayout";
import { getStoragePostgresDetailTitle, renderStorageEmptyDetail, renderStoragePostgresRowDetail } from "./storage-detail-renderers";
import { STORAGE_TABLE_META, StorageToolbarMeta } from "./storage-meta";

function formatStorageBytes(value: number | undefined) {
  if (!value || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function archiveIssueCount(archives: NonNullable<StorageOverview["postgres"]["archives"]> | undefined) {
  if (!archives) {
    return 0;
  }

  return (
    (archives.leftoverTempFiles ?? 0) +
    (archives.unexpectedFiles ?? 0) +
    (archives.unexpectedDirectories ?? 0) +
    (archives.missingChecksums ?? 0) +
    (archives.orphanChecksums ?? 0)
  );
}

function renderArchiveDirectoryDetail(archives: NonNullable<StorageOverview["postgres"]["archives"]>) {
  const issues = archiveIssueCount(archives);

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">archive dir</Badge>
        {archives.latestArchiveDate ? <Badge variant="outline">{`latest ${archives.latestArchiveDate}`}</Badge> : null}
        <Badge variant="outline">{`${archives.bundleCount ?? 0} bundles`}</Badge>
        <Badge variant="outline">{formatStorageBytes(archives.totalBytes)}</Badge>
        <Badge variant={issues > 0 ? "destructive" : "outline"}>{issues > 0 ? `${issues} issues` : "healthy"}</Badge>
      </div>

      <StorageDetailFacts
        items={[
          { label: "Export Root", value: archives.exportRoot ?? "n/a" },
          { label: "Bundle Count", value: String(archives.bundleCount ?? 0) },
          { label: "Checksum Count", value: String(archives.checksumCount ?? 0) },
          { label: "Bundle Size", value: formatStorageBytes(archives.totalBytes) },
          { label: "Leftover Temp", value: String(archives.leftoverTempFiles ?? 0) },
          { label: "Missing Checksums", value: String(archives.missingChecksums ?? 0) },
          { label: "Orphan Checksums", value: String(archives.orphanChecksums ?? 0) },
          { label: "Unexpected Entries", value: String((archives.unexpectedFiles ?? 0) + (archives.unexpectedDirectories ?? 0)) }
        ]}
      />
    </section>
  );
}

export function StoragePostgresPanel(props: {
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  onRefresh: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onDownloadCsv: () => void;
  busy: boolean;
}) {
  const selectedMeta = STORAGE_TABLE_META[props.selectedTable];
  const archiveOverview = props.overview?.postgres.archives;
  const archiveIssues = archiveIssueCount(archiveOverview);
  const archiveDetailSummary =
    props.selectedTable === "archives" && archiveOverview?.exportRoot
      ? `export root ${archiveOverview.exportRoot}`
      : undefined;
  const archiveDetailBody =
    props.selectedTable === "archives" && archiveOverview
      ? (
          <div className="space-y-4">
            {renderArchiveDirectoryDetail(archiveOverview)}
            {props.selectedRow
              ? renderStoragePostgresRowDetail(props.tablePage?.table ?? props.selectedTable, props.selectedRow)
              : renderStorageEmptyDetail("No row selected", "Select an archive row to inspect the exported payload metadata.")}
          </div>
        )
      : props.selectedRow
        ? renderStoragePostgresRowDetail(props.tablePage?.table ?? props.selectedTable, props.selectedRow)
        : renderStorageEmptyDetail("No row selected", "Select a row from the preview grid to inspect the stored record.");

  return (
    <section className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[5.25rem_minmax(0,1fr)] gap-4 overflow-hidden">
      {!props.overview?.postgres.available ? (
        <EmptyState title="Postgres unavailable" description="当前服务没有启用 Postgres，或者 Postgres 暂时不可达。" />
      ) : props.tablePage ? (
        <>
          <StoragePanelToolbar
            leading={
              <>
                <Badge variant="secondary">{selectedMeta.label}</Badge>
                {props.tablePage.appliedFilters ? <Badge variant="outline">filtered</Badge> : null}
                <Badge variant="outline">{props.tablePage.rows.length} rows</Badge>
              </>
            }
            meta={
              <>
                <StorageToolbarMeta label="total" value={props.tablePage.rowCount} />
                <StorageToolbarMeta label="order" value={props.tablePage.orderBy} />
                <StorageToolbarMeta label="offset" value={props.tablePage.offset} />
                <StorageToolbarMeta label="limit" value={props.tablePage.limit} />
                {props.overview?.postgres.historyEvents ? (
                  <>
                    <StorageToolbarMeta
                      label="hist keep"
                      value={`${props.overview.postgres.historyEvents.retentionDays}d`}
                    />
                    <StorageToolbarMeta
                      label="hist clean"
                      value={props.overview.postgres.historyEvents.cleanupEnabled ? "on" : "off"}
                    />
                  </>
                ) : null}
                {props.overview?.postgres.archives ? (
                  <>
                    <StorageToolbarMeta label="arch pend" value={props.overview.postgres.archives.pendingExports} />
                    <StorageToolbarMeta label="arch exp" value={props.overview.postgres.archives.exportedRows} />
                    <StorageToolbarMeta label="arch files" value={props.overview.postgres.archives.bundleCount ?? 0} />
                    <StorageToolbarMeta label="arch size" value={formatStorageBytes(props.overview.postgres.archives.totalBytes)} />
                    <StorageToolbarMeta label="arch warn" value={archiveIssues} />
                  </>
                ) : null}
              </>
            }
            actions={
              <>
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
              </>
            }
          />

          <StorageSurfaceLayout
            detailTitle={getStoragePostgresDetailTitle(props.tablePage.table)}
            detailSummary={archiveDetailSummary}
            detailAction={
              props.selectedTable === "archives" && archiveOverview ? (
                <div className="flex gap-2">
                  <Badge variant="outline">{`${archiveOverview.bundleCount ?? 0} bundles`}</Badge>
                  <Badge variant={archiveIssues > 0 ? "destructive" : "outline"}>{archiveIssues > 0 ? `${archiveIssues} issues` : "healthy"}</Badge>
                </div>
              ) : props.selectedRow ? (
                <Badge variant="outline">selected</Badge>
              ) : null
            }
            detailBody={archiveDetailBody}
            previewMeta={
              <>
                <Badge variant="outline">{props.tablePage.columns.length} cols</Badge>
                <Badge variant="outline">{props.tablePage.rows.length} rows</Badge>
                {props.tablePage.table === "history_events" && props.overview?.postgres.historyEvents?.oldestOccurredAt ? (
                  <Badge variant="outline">{`oldest ${props.overview.postgres.historyEvents.oldestOccurredAt}`}</Badge>
                ) : null}
                {props.tablePage.table === "archives" && props.overview?.postgres.archives?.oldestPendingArchiveDate ? (
                  <Badge variant="outline">{`pending since ${props.overview.postgres.archives.oldestPendingArchiveDate}`}</Badge>
                ) : null}
                {props.tablePage.table === "archives" && props.overview?.postgres.archives?.latestArchiveDate ? (
                  <Badge variant="outline">{`latest bundle ${props.overview.postgres.archives.latestArchiveDate}`}</Badge>
                ) : null}
              </>
            }
            previewContent={
              <StorageDataGrid
                tableName={props.tablePage.table}
                columns={props.tablePage.columns}
                rows={props.tablePage.rows}
                selectedRow={props.selectedRow}
                onSelectRow={props.onSelectRow as (row: Record<string, unknown>) => void}
              />
            }
          />
        </>
      ) : (
        <EmptyState title="No table selected" description="Select a Postgres table from the left rail to inspect recent rows." />
      )}
    </section>
  );
}
