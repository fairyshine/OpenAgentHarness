import type {
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisKeyDetail,
  StorageRedisKeyPage
} from "@oah/api-contracts";

import type { HealthReportResponse, StorageBrowserTab } from "../support";

export interface StorageWorkbenchProps {
  browserTab: StorageBrowserTab;
  healthReport: HealthReportResponse | null;
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
  onManualRequeueRun: (runId: string) => void;
  onManualRequeueRuns: (runIds: string[]) => void;
  onRefreshRedisKeys: () => void;
  onLoadMoreRedisKeys: () => void;
  onRefreshRedisKey: () => void;
  onDeleteRedisKey: () => void;
  onDeleteSelectedRedisKeys: () => void;
  onClearRedisSessionQueue: (key: string) => void;
  onReleaseRedisSessionLock: (key: string) => void;
  busy: boolean;
}
