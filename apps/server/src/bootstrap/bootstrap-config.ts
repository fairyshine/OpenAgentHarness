import type { ServerConfig } from "@oah/config";

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parsePositiveIntEnvWithMin(name: string, fallback: number, minimum: number): number {
  return Math.max(minimum, parsePositiveIntEnv(name, fallback));
}

export function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  return fallback;
}

export function resolveObjectStorageMirrorBlockingInit(): boolean {
  const latencyFirst = parseBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false);
  return parseBooleanEnv("OAH_OBJECT_STORAGE_MIRROR_BLOCKING_INIT", !latencyFirst);
}

export function resolveWorkspacePrewarmConfig(): { enabled: boolean; delayMs: number; coalesceWindowMs: number } {
  const latencyFirst = parseBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false);
  return {
    enabled: parseBooleanEnv("OAH_WORKSPACE_PREWARM_ENABLED", true),
    delayMs: parseNonNegativeIntEnv("OAH_WORKSPACE_PREWARM_DELAY_MS", latencyFirst ? 250 : 0),
    coalesceWindowMs: parseNonNegativeIntEnv("OAH_WORKSPACE_PREWARM_COALESCE_MS", latencyFirst ? 1_000 : 0)
  };
}

export function resolveWorkspaceMaterializationConfig(
  config: Pick<ServerConfig, "workspace">
): { idleTtlMs: number; maintenanceIntervalMs: number } {
  return {
    idleTtlMs: parsePositiveIntEnv(
      "OAH_WORKSPACE_MATERIALIZATION_IDLE_TTL_MS",
      config.workspace?.materialization?.idle_ttl_ms ?? 900_000
    ),
    maintenanceIntervalMs: parsePositiveIntEnv(
      "OAH_WORKSPACE_MATERIALIZATION_MAINTENANCE_INTERVAL_MS",
      config.workspace?.materialization?.maintenance_interval_ms ?? 5_000
    )
  };
}

export function resolveWorkspaceRegistryPollingConfig(): { enabled: boolean; intervalMs: number } {
  const latencyFirst = parseBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false);
  const intervalMs = parseNonNegativeIntEnv(
    "OAH_WORKSPACE_REGISTRY_POLL_INTERVAL_MS",
    latencyFirst ? 2_000 : 15_000
  );
  return {
    enabled: intervalMs > 0,
    intervalMs
  };
}
