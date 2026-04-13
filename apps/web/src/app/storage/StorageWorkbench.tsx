import { StoragePostgresPanel } from "./StoragePostgresPanel";
import { StorageRedisPanel } from "./StorageRedisPanel";
import type { StorageWorkbenchProps } from "./types";

export function StorageWorkbench(props: StorageWorkbenchProps) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
          onDownloadCsv={props.onDownloadTableCsv}
          onManualRequeueRun={props.onManualRequeueRun}
          onManualRequeueRuns={props.onManualRequeueRuns}
          busy={props.busy}
        />
      ) : (
        <StorageRedisPanel
          healthReport={props.healthReport}
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
