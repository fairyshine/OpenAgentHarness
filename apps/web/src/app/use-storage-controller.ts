import { useEffect, useState } from "react";

import type {
  BatchRequeueRunsResponse,
  RequeueRunAccepted,
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisKeyDetail,
  StorageRedisKeyPage
} from "@oah/api-contracts";

import {
  downloadCsvFile,
  storageTablePreviewLimit,
  toErrorMessage,
  type ConnectionSettings,
  type HealthReportResponse,
  type StorageBrowserTab
} from "./support";

type AppRequest = <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;

export function useStorageController(params: {
  connection: ConnectionSettings;
  enabled: boolean;
  healthReport: HealthReportResponse | null;
  request: AppRequest;
  setActivity: (value: string) => void;
  setErrorMessage: (value: string) => void;
}) {
  const [storageOverview, setStorageOverview] = useState<StorageOverview | null>(null);
  const [selectedStorageTable, setSelectedStorageTable] = useState<StoragePostgresTableName>("runs");
  const [storageTablePage, setStorageTablePage] = useState<StoragePostgresTablePage | null>(null);
  const [storageTableOffset, setStorageTableOffset] = useState(0);
  const [selectedStorageRow, setSelectedStorageRow] = useState<Record<string, unknown> | null>(null);
  const [storageTableSearch, setStorageTableSearch] = useState("");
  const [storageTableWorkspaceId, setStorageTableWorkspaceId] = useState("");
  const [storageTableSessionId, setStorageTableSessionId] = useState("");
  const [storageTableRunId, setStorageTableRunId] = useState("");
  const [storageTableStatus, setStorageTableStatus] = useState("");
  const [storageTableErrorCode, setStorageTableErrorCode] = useState("");
  const [storageTableRecoveryState, setStorageTableRecoveryState] = useState("");
  const [redisKeyPattern, setRedisKeyPattern] = useState("oah:*");
  const [redisKeyPage, setRedisKeyPage] = useState<StorageRedisKeyPage | null>(null);
  const [selectedRedisKey, setSelectedRedisKey] = useState("");
  const [selectedRedisKeys, setSelectedRedisKeys] = useState<string[]>([]);
  const [redisKeyDetail, setRedisKeyDetail] = useState<StorageRedisKeyDetail | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageBrowserTab, setStorageBrowserTab] = useState<StorageBrowserTab>("postgres");

  async function refreshStorageOverview(quiet = false) {
    try {
      setStorageBusy(true);
      const response = await params.request<StorageOverview>("/api/v1/storage/overview");
      setStorageOverview(response);
      if (!quiet) {
        params.setActivity("已刷新 PG / Redis 存储概览");
        params.setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshStorageTable(
    table = selectedStorageTable,
    quiet = false,
    overrides?: {
      offset?: number;
      q?: string;
      workspaceId?: string;
      sessionId?: string;
      runId?: string;
      status?: string;
      errorCode?: string;
      recoveryState?: string;
      selectedRowId?: string;
    }
  ): Promise<StoragePostgresTablePage | null> {
    try {
      setStorageBusy(true);
      const pageSize = storageTablePreviewLimit(table);
      const runsTableSelected = table === "runs";
      const paramsValue = new URLSearchParams({
        limit: String(pageSize)
      });
      const offset = overrides?.offset ?? storageTableOffset;
      const q = overrides?.q ?? storageTableSearch;
      const workspaceId = overrides?.workspaceId ?? storageTableWorkspaceId;
      const sessionId = overrides?.sessionId ?? storageTableSessionId;
      const runId = overrides?.runId ?? storageTableRunId;
      const status = overrides?.status ?? storageTableStatus;
      const errorCode = overrides?.errorCode ?? storageTableErrorCode;
      const recoveryState = overrides?.recoveryState ?? storageTableRecoveryState;
      paramsValue.set("offset", String(offset));
      if (q.trim()) {
        paramsValue.set("q", q.trim());
      }
      if (workspaceId.trim()) {
        paramsValue.set("workspaceId", workspaceId.trim());
      }
      if (sessionId.trim()) {
        paramsValue.set("sessionId", sessionId.trim());
      }
      if (runId.trim()) {
        paramsValue.set("runId", runId.trim());
      }
      if (runsTableSelected && status.trim()) {
        paramsValue.set("status", status.trim());
      }
      if (runsTableSelected && errorCode.trim()) {
        paramsValue.set("errorCode", errorCode.trim());
      }
      if (runsTableSelected && recoveryState.trim()) {
        paramsValue.set("recoveryState", recoveryState.trim());
      }
      const response = await params.request<StoragePostgresTablePage>(
        `/api/v1/storage/postgres/tables/${table}?${paramsValue.toString()}`
      );
      setSelectedStorageTable(table);
      setStorageTableOffset(offset);
      setStorageTablePage(response);
      const selectedRowId = overrides?.selectedRowId?.trim();
      setSelectedStorageRow(
        (selectedRowId ? response.rows.find((row) => String(row.id ?? "") === selectedRowId) : undefined) ?? response.rows[0] ?? null
      );
      if (!quiet) {
        params.setActivity(`已加载 ${table} 表预览`);
        params.setErrorMessage("");
      }
      return response;
    } catch (error) {
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
      return null;
    } finally {
      setStorageBusy(false);
    }
  }

  async function manualRequeueRun(runId: string) {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    if (!window.confirm(`Manual requeue recovery run ${targetRunId}?`)) {
      return;
    }

    try {
      setStorageBusy(true);
      const accepted = await params.request<RequeueRunAccepted>(`/api/v1/runs/${targetRunId}/requeue`, {
        method: "POST"
      });
      await refreshStorageTable(selectedStorageTable, true, {
        offset: storageTableOffset,
        selectedRowId: accepted.runId
      });
      params.setActivity(`已重新入队 recovery run ${accepted.runId}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function manualRequeueRuns(runIds: string[]) {
    const uniqueRunIds = Array.from(new Set(runIds.map((runId) => runId.trim()).filter((runId) => runId.length > 0)));
    if (uniqueRunIds.length === 0) {
      return;
    }

    if (!window.confirm(`Manual requeue ${uniqueRunIds.length} recovery runs?`)) {
      return;
    }

    try {
      setStorageBusy(true);
      const response = await params.request<BatchRequeueRunsResponse>("/api/v1/runs/requeue", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          runIds: uniqueRunIds
        })
      });
      const queuedItems = response.items.filter((item) => item.status === "queued");
      const errorItems = response.items.filter((item) => item.status === "error");
      await refreshStorageTable(selectedStorageTable, true, {
        offset: storageTableOffset,
        selectedRowId: queuedItems[0]?.runId
      });
      params.setActivity(
        errorItems.length === 0
          ? `已批量重新入队 ${queuedItems.length} 个 recovery run`
          : `批量处理完成：${queuedItems.length} 个成功，${errorItems.length} 个失败`
      );
      params.setErrorMessage(
        errorItems.length > 0 ? errorItems.map((item) => `${item.runId}: ${item.errorCode}`).join(" | ") : ""
      );
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshRedisKeys(options?: { cursor?: string; quiet?: boolean }) {
    try {
      setStorageBusy(true);
      const pattern = redisKeyPattern.trim() || "oah:*";
      const paramsValue = new URLSearchParams({
        pattern
      });
      if (options?.cursor) {
        paramsValue.set("cursor", options.cursor);
      }
      paramsValue.set("pageSize", "100");
      const response = await params.request<StorageRedisKeyPage>(`/api/v1/storage/redis/keys?${paramsValue.toString()}`);
      setRedisKeyPage(response);
      if (!options?.quiet) {
        params.setActivity(`已加载 ${response.items.length} 个 Redis key`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (!options?.quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshRedisKeyDetail(key = selectedRedisKey, quiet = false) {
    const targetKey = key.trim();
    if (!targetKey) {
      setRedisKeyDetail(null);
      return;
    }

    try {
      setStorageBusy(true);
      const paramsValue = new URLSearchParams({
        key: targetKey
      });
      const response = await params.request<StorageRedisKeyDetail>(`/api/v1/storage/redis/key?${paramsValue.toString()}`);
      setSelectedRedisKey(targetKey);
      setRedisKeyDetail(response);
      if (!quiet) {
        params.setActivity(`已加载 Redis key ${targetKey}`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function deleteRedisKey() {
    const targetKey = selectedRedisKey.trim();
    if (!targetKey) {
      return;
    }

    if (!window.confirm(`Delete Redis key ${targetKey}?`)) {
      return;
    }

    try {
      setStorageBusy(true);
      const paramsValue = new URLSearchParams({
        key: targetKey
      });
      await params.request(`/api/v1/storage/redis/key?${paramsValue.toString()}`, {
        method: "DELETE"
      });
      setSelectedRedisKeys((current) => current.filter((key) => key !== targetKey));
      setRedisKeyDetail(null);
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      params.setActivity(`已删除 Redis key ${targetKey}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function deleteSelectedRedisKeys() {
    if (selectedRedisKeys.length === 0) {
      return;
    }

    if (!window.confirm(`Delete ${selectedRedisKeys.length} Redis keys?`)) {
      return;
    }

    try {
      setStorageBusy(true);
      await params.request("/api/v1/storage/redis/keys/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          keys: selectedRedisKeys
        })
      });
      setSelectedRedisKeys([]);
      if (selectedRedisKey && selectedRedisKeys.includes(selectedRedisKey)) {
        setSelectedRedisKey("");
        setRedisKeyDetail(null);
      }
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      params.setActivity(`已删除 ${selectedRedisKeys.length} 个 Redis key`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function clearRedisSessionQueue(key: string) {
    try {
      setStorageBusy(true);
      await params.request("/api/v1/storage/redis/session-queue/clear", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ key })
      });
      if (selectedRedisKey === key) {
        setRedisKeyDetail(null);
      }
      setSelectedRedisKeys((current) => current.filter((entry) => entry !== key));
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      params.setActivity(`已清空 queue ${key}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function releaseRedisSessionLock(key: string) {
    try {
      setStorageBusy(true);
      await params.request("/api/v1/storage/redis/session-lock/release", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ key })
      });
      if (selectedRedisKey === key) {
        setRedisKeyDetail(null);
      }
      setSelectedRedisKeys((current) => current.filter((entry) => entry !== key));
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      params.setActivity(`已释放 lock ${key}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  useEffect(() => {
    if (!params.enabled) {
      return;
    }

    void refreshStorageOverview(true);
    void refreshStorageTable(selectedStorageTable, true);
    void refreshRedisKeys({ quiet: true });
  }, [params.connection.baseUrl, params.connection.token, params.enabled, selectedStorageTable]);

  return {
    storageSurfaceProps: {
      healthReport: params.healthReport,
      storageBrowserTab,
      onStorageBrowserTabChange: setStorageBrowserTab,
      storageOverview,
      storageTablePage,
      selectedStorageTable,
      selectedStorageRow,
      onSelectedStorageRowChange: setSelectedStorageRow,
      storageTableSearch,
      onStorageTableSearchChange: setStorageTableSearch,
      storageTableWorkspaceId,
      onStorageTableWorkspaceIdChange: setStorageTableWorkspaceId,
      storageTableSessionId,
      onStorageTableSessionIdChange: setStorageTableSessionId,
      storageTableRunId,
      onStorageTableRunIdChange: setStorageTableRunId,
      storageTableStatus,
      onStorageTableStatusChange: setStorageTableStatus,
      storageTableErrorCode,
      onStorageTableErrorCodeChange: setStorageTableErrorCode,
      storageTableRecoveryState,
      onStorageTableRecoveryStateChange: setStorageTableRecoveryState,
      onSelectStorageTable: (table: StoragePostgresTableName) => void refreshStorageTable(table, false, { offset: 0 }),
      redisKeyPattern,
      onRedisKeyPatternChange: setRedisKeyPattern,
      redisKeyPage,
      selectedRedisKey,
      selectedRedisKeys,
      onSelectedRedisKeysChange: setSelectedRedisKeys,
      onSelectRedisKey: (key: string) => void refreshRedisKeyDetail(key),
      redisKeyDetail,
      onRefreshStorageOverview: () => void refreshStorageOverview(),
      onRefreshStorageTable: () => void refreshStorageTable(),
      onPreviousStorageTablePage: () =>
        void refreshStorageTable(selectedStorageTable, false, {
          offset: Math.max(0, storageTableOffset - (storageTablePage?.limit ?? storageTablePreviewLimit(selectedStorageTable)))
        }),
      onNextStorageTablePage: () =>
        void refreshStorageTable(
          selectedStorageTable,
          false,
          storageTablePage?.nextOffset !== undefined ? { offset: storageTablePage.nextOffset } : undefined
        ),
      onClearStorageTableFilters: () => {
        setStorageTableSearch("");
        setStorageTableWorkspaceId("");
        setStorageTableSessionId("");
        setStorageTableRunId("");
        setStorageTableStatus("");
        setStorageTableErrorCode("");
        setStorageTableRecoveryState("");
        setStorageTableOffset(0);
        void refreshStorageTable(selectedStorageTable, false, {
          offset: 0,
          q: "",
          workspaceId: "",
          sessionId: "",
          runId: "",
          status: "",
          errorCode: "",
          recoveryState: ""
        });
      },
      onDownloadStorageTableCsv: () => {
        if (!storageTablePage) {
          return;
        }

        downloadCsvFile(`${storageTablePage.table}.csv`, storageTablePage.columns, storageTablePage.rows);
      },
      onManualRequeueRun: (runId: string) => void manualRequeueRun(runId),
      onManualRequeueRuns: (runIds: string[]) => void manualRequeueRuns(runIds),
      onRefreshRedisKeys: () => void refreshRedisKeys(),
      onLoadMoreRedisKeys: () => void refreshRedisKeys(redisKeyPage?.nextCursor ? { cursor: redisKeyPage.nextCursor } : undefined),
      onRefreshRedisKeyDetail: () => void refreshRedisKeyDetail(),
      onDeleteRedisKey: () => void deleteRedisKey(),
      onDeleteSelectedRedisKeys: () => void deleteSelectedRedisKeys(),
      onClearRedisSessionQueue: (key: string) => void clearRedisSessionQueue(key),
      onReleaseRedisSessionLock: (key: string) => void releaseRedisSessionLock(key),
      storageBusy
    }
  };
}
