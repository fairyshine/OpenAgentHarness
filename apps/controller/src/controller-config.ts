import type { ServerConfig } from "@oah/config-server-control";

export interface StandaloneControllerConfig {
  minReplicas: number;
  maxReplicas: number;
  readySessionsPerCapacityUnit: number;
  reservedSubagentCapacity: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
}

export interface SandboxFleetConfig {
  providerKind: "embedded" | "self_hosted" | "e2b";
  managedByController: boolean;
  minCount: number;
  maxCount: number;
  maxWorkspacesPerSandbox: number;
  ownerlessPool: "shared" | "dedicated";
  warmEmptyCount: number;
  resourceCpuPressureThreshold: number;
  resourceMemoryPressureThreshold: number;
  resourceDiskPressureThreshold: number;
}

function readEnv(names: string | string[]): string | undefined {
  for (const name of Array.isArray(names) ? names : [names]) {
    const raw = process.env[name];
    if (raw && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return undefined;
}

export function readPositiveIntEnv(names: string | string[], fallback: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(names: string | string[], fallback: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readRatioEnv(names: string | string[], fallback: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function readEnumEnv<TValue extends string>(
  names: string | string[],
  allowed: readonly TValue[],
  fallback: TValue
): TValue {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  return (allowed as readonly string[]).includes(raw) ? (raw as TValue) : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
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

export function resolveStandaloneControllerConfig(config: ServerConfig): StandaloneControllerConfig {
  const standalone = config.workers?.standalone;
  const controller = config.workers?.controller;
  const sandboxFleet = resolveSandboxFleetConfig(config);
  const defaultMinReplicas = standalone?.min_replicas ?? (sandboxFleet.managedByController ? sandboxFleet.minCount : 1);
  const minReplicas = readNonNegativeIntEnv("OAH_STANDALONE_WORKER_MIN_REPLICAS", defaultMinReplicas);
  const maxReplicas = Math.max(
    minReplicas,
    readPositiveIntEnv(
      "OAH_STANDALONE_WORKER_MAX_REPLICAS",
      standalone?.max_replicas ?? (sandboxFleet.managedByController ? Math.max(minReplicas, sandboxFleet.maxCount) : minReplicas)
    )
  );
  const latencyFirst = readBooleanEnv("OAH_LATENCY_FIRST_PROFILE", false) || minReplicas === maxReplicas;

  return {
    minReplicas,
    maxReplicas,
    readySessionsPerCapacityUnit: readPositiveIntEnv(
      "OAH_STANDALONE_WORKER_READY_SESSIONS_PER_CAPACITY_UNIT",
      standalone?.ready_sessions_per_capacity_unit ?? 1
    ),
    reservedSubagentCapacity: readNonNegativeIntEnv(
      "OAH_STANDALONE_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT",
      standalone?.reserved_capacity_for_subagent ?? 1
    ),
    scaleIntervalMs: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_INTERVAL_MS",
      controller?.scale_interval_ms ?? (latencyFirst ? 1_000 : 5_000)
    ),
    scaleUpCooldownMs: readNonNegativeIntEnv(
      "OAH_CONTROLLER_SCALE_UP_COOLDOWN_MS",
      controller?.cooldown_ms ?? (latencyFirst ? 0 : 1_000)
    ),
    scaleDownCooldownMs: readNonNegativeIntEnv(
      "OAH_CONTROLLER_SCALE_DOWN_COOLDOWN_MS",
      controller?.cooldown_ms ?? (latencyFirst ? 0 : 15_000)
    ),
    scaleUpSampleSize: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_UP_SAMPLE_SIZE",
      controller?.scale_up_window ?? (latencyFirst ? 1 : 2)
    ),
    scaleDownSampleSize: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_DOWN_SAMPLE_SIZE",
      controller?.scale_down_window ?? (latencyFirst ? 1 : 3)
    ),
    scaleUpBusyRatioThreshold: readRatioEnv("OAH_CONTROLLER_SCALE_UP_BUSY_RATIO_THRESHOLD", controller?.scale_up_busy_ratio_threshold ?? 0.75),
    scaleUpMaxReadyAgeMs: readPositiveIntEnv(
      "OAH_CONTROLLER_SCALE_UP_MAX_READY_AGE_MS",
      controller?.scale_up_max_ready_age_ms ?? (latencyFirst ? 500 : 2_000)
    )
  };
}

function resolveSandboxProviderKind(config: ServerConfig): SandboxFleetConfig["providerKind"] {
  const provider = config.sandbox?.provider ?? (config.sandbox?.self_hosted?.base_url?.trim() ? "self_hosted" : "embedded");
  return provider === "self_hosted" || provider === "e2b" ? provider : "embedded";
}

export function resolveSandboxFleetConfig(config: ServerConfig): SandboxFleetConfig {
  const providerKind = resolveSandboxProviderKind(config);
  const managedByController = providerKind !== "embedded";
  const configuredMinCount = config.sandbox?.fleet?.min_count;
  const configuredMaxCount = config.sandbox?.fleet?.max_count;
  const configuredWarmEmptyCount = (config.sandbox?.fleet as { warm_empty_count?: number | undefined } | undefined)
    ?.warm_empty_count;
  const configuredCpuPressureThreshold = (
    config.sandbox?.fleet as { resource_cpu_pressure_threshold?: number | undefined } | undefined
  )?.resource_cpu_pressure_threshold;
  const configuredMemoryPressureThreshold = (
    config.sandbox?.fleet as { resource_memory_pressure_threshold?: number | undefined } | undefined
  )?.resource_memory_pressure_threshold;
  const configuredDiskPressureThreshold = (
    config.sandbox?.fleet as { resource_disk_pressure_threshold?: number | undefined } | undefined
  )?.resource_disk_pressure_threshold;
  const minCount = readNonNegativeIntEnv(
    "OAH_SANDBOX_FLEET_MIN_COUNT",
    configuredMinCount ?? (managedByController ? 1 : 0)
  );
  const defaultMaxCount = managedByController ? Math.max(minCount, 64) : Math.max(1, minCount);
  const maxCount = Math.max(
    minCount,
    readPositiveIntEnv("OAH_SANDBOX_FLEET_MAX_COUNT", configuredMaxCount ?? defaultMaxCount)
  );
  const warmEmptyCount = readNonNegativeIntEnv(
    "OAH_SANDBOX_FLEET_WARM_EMPTY_COUNT",
    configuredWarmEmptyCount ?? (managedByController ? 1 : 0)
  );

  return {
    providerKind,
    managedByController,
    minCount,
    maxCount,
    maxWorkspacesPerSandbox: readPositiveIntEnv(
      "OAH_SANDBOX_FLEET_MAX_WORKSPACES_PER_SANDBOX",
      config.sandbox?.fleet?.max_workspaces_per_sandbox ?? 32
    ),
    ownerlessPool: readEnumEnv(
      "OAH_SANDBOX_FLEET_OWNERLESS_POOL",
      ["shared", "dedicated"],
      config.sandbox?.fleet?.ownerless_pool ?? "shared"
    ),
    warmEmptyCount,
    resourceCpuPressureThreshold: readRatioEnv(
      "OAH_SANDBOX_FLEET_RESOURCE_CPU_PRESSURE_THRESHOLD",
      configuredCpuPressureThreshold ?? 0.8
    ),
    resourceMemoryPressureThreshold: readRatioEnv(
      "OAH_SANDBOX_FLEET_RESOURCE_MEMORY_PRESSURE_THRESHOLD",
      configuredMemoryPressureThreshold ?? 0.8
    ),
    resourceDiskPressureThreshold: readRatioEnv(
      "OAH_SANDBOX_FLEET_RESOURCE_DISK_PRESSURE_THRESHOLD",
      configuredDiskPressureThreshold ?? 0.85
    )
  };
}
