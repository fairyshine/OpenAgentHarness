import { startTransition, useEffectEvent } from "react";

import { healthReportSchema, readinessReportSchema, systemProfileSchema } from "@oah/api-contracts";

import {
  buildUrl,
  readJsonResponse,
  type ConnectionSettings,
  type HealthReportResponse,
  type ModelProviderListResponse,
  type PlatformModelListResponse,
  type PlatformModelSnapshotResponse,
  type ReadinessReportResponse,
  type SystemProfileResponse
} from "./support";

export function useSystemModelActions(input: {
  connection: ConnectionSettings;
  request: <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;
  setActivity: (value: string) => void;
  clearActiveError: () => void;
  reportError: (error: unknown) => void;
  setHealthStatus: (status: string) => void;
  setSystemProfile: (profile: SystemProfileResponse | null) => void;
  setHealthReport: (report: HealthReportResponse | null) => void;
  setReadinessReport: (report: ReadinessReportResponse | null) => void;
  setModelProviders: (providers: ModelProviderListResponse["items"]) => void;
  setPlatformModels: (models: PlatformModelListResponse["items"]) => void;
}) {
  const pingHealth = useEffectEvent(async () => {
    try {
      input.setHealthStatus("checking");
      const [profilePayload, healthResponse, readinessResponse] = await Promise.all([
        fetch(buildUrl(input.connection.baseUrl, "/api/v1/system/profile"))
          .then((response) => (response.ok ? readJsonResponse<SystemProfileResponse>(response) : null))
          .then((payload) => (payload ? systemProfileSchema.parse(payload) : null))
          .catch(() => null),
        fetch(buildUrl(input.connection.baseUrl, "/healthz")),
        fetch(buildUrl(input.connection.baseUrl, "/readyz"))
      ]);

      if (!healthResponse.ok) {
        throw new Error(`${healthResponse.status} ${healthResponse.statusText}`);
      }

      const healthPayload = healthReportSchema.parse((await readJsonResponse<HealthReportResponse>(healthResponse)) ?? null);
      const readinessPayload = await readJsonResponse<ReadinessReportResponse>(readinessResponse)
        .then((payload) => (payload ? readinessReportSchema.parse(payload) : null))
        .catch(() => null);

      input.setSystemProfile(profilePayload);
      input.setHealthReport(healthPayload);
      input.setReadinessReport(readinessPayload);
      input.setHealthStatus(healthPayload?.status ?? (readinessResponse.ok ? "ok" : "degraded"));
      input.setActivity(
        healthPayload?.status === "degraded" || readinessPayload?.status === "not_ready"
          ? "服务探针发现降级项"
          : "服务健康检查通过"
      );
      input.clearActiveError();
    } catch (error) {
      input.setHealthStatus("error");
      input.setSystemProfile(null);
      input.setHealthReport(null);
      input.setReadinessReport(null);
      input.reportError(error);
    }
  });

  const refreshModelProviders = useEffectEvent(async (quiet = false) => {
    try {
      const response = await input.request<ModelProviderListResponse>("/api/v1/model-providers");
      startTransition(() => {
        input.setModelProviders(response.items);
      });
      if (!quiet) {
        input.setActivity(`已加载 ${response.items.length} 个模型 provider`);
        input.clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
    }
  });

  const refreshPlatformModels = useEffectEvent(async (quiet = false) => {
    try {
      const response = await input.request<PlatformModelListResponse>("/api/v1/platform-models");
      startTransition(() => {
        input.setPlatformModels(response.items);
      });
      if (!quiet) {
        input.setActivity(`已加载 ${response.items.length} 个平台模型`);
        input.clearActiveError();
      }
    } catch (error) {
      if (!quiet) {
        input.reportError(error);
      }
    }
  });

  const handlePlatformModelSnapshot = useEffectEvent((snapshot: PlatformModelSnapshotResponse, quiet = false) => {
    startTransition(() => {
      input.setPlatformModels(snapshot.items);
    });
    if (!quiet) {
      input.setActivity(`平台模型已热更新，当前 ${snapshot.items.length} 个`);
    }
  });

  return {
    pingHealth,
    refreshModelProviders,
    refreshPlatformModels,
    handlePlatformModelSnapshot
  };
}
