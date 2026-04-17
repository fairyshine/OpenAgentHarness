import { memo } from "react";

import { StorageWorkbench } from "./StorageWorkbench";
import { useHealthStore } from "../stores/health-store";
import type { useAppController } from "../use-app-controller";

type StorageProps = ReturnType<typeof useAppController>["storageSurfaceProps"];

function StorageWorkspaceImpl(props: StorageProps) {
  const healthReport = useHealthStore((state) => state.healthReport);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 h-full flex-1 overflow-hidden px-5 py-5">
        <StorageWorkbench
          browserTab={props.storageBrowserTab}
          healthReport={healthReport}
          overview={props.storageOverview}
          tablePage={props.storageTablePage}
          selectedTable={props.selectedStorageTable}
          selectedRow={props.selectedStorageRow}
          onSelectRow={props.onSelectedStorageRowChange}
          redisKeyPage={props.redisKeyPage}
          selectedRedisKey={props.selectedRedisKey}
          selectedRedisKeys={props.selectedRedisKeys}
          onSelectedRedisKeysChange={props.onSelectedRedisKeysChange}
          onSelectRedisKey={props.onSelectRedisKey}
          redisKeyDetail={props.redisKeyDetail}
          onRefreshTable={props.onRefreshStorageTable}
          onPreviousTablePage={props.onPreviousStorageTablePage}
          onNextTablePage={props.onNextStorageTablePage}
          onClearTableFilters={props.onClearStorageTableFilters}
          onDownloadTableCsv={props.onDownloadStorageTableCsv}
          onManualRequeueRun={props.onManualRequeueRun}
          onManualRequeueRuns={props.onManualRequeueRuns}
          onRefreshRedisKeys={props.onRefreshRedisKeys}
          onLoadMoreRedisKeys={props.onLoadMoreRedisKeys}
          onRefreshRedisKey={props.onRefreshRedisKeyDetail}
          onDeleteRedisKey={props.onDeleteRedisKey}
          onDeleteSelectedRedisKeys={props.onDeleteSelectedRedisKeys}
          onClearRedisSessionQueue={props.onClearRedisSessionQueue}
          onReleaseRedisSessionLock={props.onReleaseRedisSessionLock}
          busy={props.storageBusy}
        />
      </div>
    </section>
  );
}

export const StorageWorkspace = memo(StorageWorkspaceImpl);
