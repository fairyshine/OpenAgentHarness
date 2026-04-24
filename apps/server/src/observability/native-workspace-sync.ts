export type NativeWorkspaceSyncImplementation = "rust" | "ts";
export type NativeWorkspaceSyncOutcome = "success" | "failure";
export type NativeWorkspaceSyncOperation =
  | "fingerprint"
  | "fingerprint_batch"
  | "scan"
  | "plan_local_to_remote"
  | "sync_local_to_remote"
  | "plan_remote_to_local"
  | "sync_remote_to_local"
  | "plan_seed_upload"
  | "sync_local_to_sandbox_http";

interface AttemptLabels {
  operation: NativeWorkspaceSyncOperation;
  implementation: NativeWorkspaceSyncImplementation;
  outcome: NativeWorkspaceSyncOutcome;
}

interface DurationLabels {
  operation: NativeWorkspaceSyncOperation;
  implementation: NativeWorkspaceSyncImplementation;
}

interface FallbackLabels {
  operation: NativeWorkspaceSyncOperation;
  attemptedImplementation: NativeWorkspaceSyncImplementation;
  fallbackImplementation: NativeWorkspaceSyncImplementation;
}

interface DurationStats extends DurationLabels {
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
}

export interface NativeWorkspaceSyncObservabilitySnapshot {
  attempts: Array<AttemptLabels & { count: number }>;
  durations: DurationStats[];
  fallbacks: Array<FallbackLabels & { count: number }>;
}

const attemptCounters = new Map<string, AttemptLabels & { count: number }>();
const durationStats = new Map<string, DurationStats>();
const fallbackCounters = new Map<string, FallbackLabels & { count: number }>();

function createMetricKey(labels: object): string {
  return Object.entries(labels as Record<string, string>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function formatLabels(labels: object): string {
  const entries = Object.entries(labels as Record<string, string>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "";
  }

  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function toErrorDetails(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message
    };
  }

  return {
    errorMessage: String(error)
  };
}

function incrementAttempt(labels: AttemptLabels): void {
  const key = createMetricKey(labels);
  const current = attemptCounters.get(key);
  if (current) {
    current.count += 1;
    return;
  }

  attemptCounters.set(key, { ...labels, count: 1 });
}

function updateDuration(labels: DurationLabels, durationMs: number): void {
  const key = createMetricKey(labels);
  const current = durationStats.get(key);
  if (current) {
    current.count += 1;
    current.totalMs += durationMs;
    current.lastMs = durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    return;
  }

  durationStats.set(key, {
    ...labels,
    count: 1,
    totalMs: durationMs,
    lastMs: durationMs,
    maxMs: durationMs
  });
}

function incrementFallback(labels: FallbackLabels): void {
  const key = createMetricKey({
    operation: labels.operation,
    attemptedImplementation: labels.attemptedImplementation,
    fallbackImplementation: labels.fallbackImplementation
  });
  const current = fallbackCounters.get(key);
  if (current) {
    current.count += 1;
    return;
  }

  fallbackCounters.set(key, { ...labels, count: 1 });
}

function logStructured(level: "info" | "warn", payload: Record<string, unknown>): void {
  const message = `[oah-native] ${JSON.stringify(payload)}`;
  if (level === "warn") {
    console.warn(message);
    return;
  }

  console.info(message);
}

export async function observeNativeWorkspaceSyncOperation<T>(input: {
  operation: NativeWorkspaceSyncOperation;
  implementation: NativeWorkspaceSyncImplementation;
  target: string;
  action: () => Promise<T>;
  logSuccess?: boolean | undefined;
  logFailure?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}): Promise<T> {
  const start = Date.now();

  try {
    const result = await input.action();
    const durationMs = Date.now() - start;
    incrementAttempt({
      operation: input.operation,
      implementation: input.implementation,
      outcome: "success"
    });
    updateDuration(
      {
        operation: input.operation,
        implementation: input.implementation
      },
      durationMs
    );

    if (input.logSuccess ?? input.implementation === "rust") {
      logStructured("info", {
        event: "workspace_sync_operation",
        operation: input.operation,
        implementation: input.implementation,
        outcome: "success",
        durationMs,
        target: input.target,
        ...(input.metadata ?? {})
      });
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - start;
    incrementAttempt({
      operation: input.operation,
      implementation: input.implementation,
      outcome: "failure"
    });
    updateDuration(
      {
        operation: input.operation,
        implementation: input.implementation
      },
      durationMs
    );

    if (input.logFailure ?? false) {
      logStructured("warn", {
        event: "workspace_sync_operation",
        operation: input.operation,
        implementation: input.implementation,
        outcome: "failure",
        durationMs,
        target: input.target,
        ...(input.metadata ?? {}),
        ...toErrorDetails(error)
      });
    }

    throw error;
  }
}

export function recordNativeWorkspaceSyncFallback(input: {
  operation: NativeWorkspaceSyncOperation;
  target: string;
  error: unknown;
  attemptedImplementation?: NativeWorkspaceSyncImplementation | undefined;
  fallbackImplementation?: NativeWorkspaceSyncImplementation | undefined;
  metadata?: Record<string, unknown> | undefined;
}): void {
  const attemptedImplementation = input.attemptedImplementation ?? "rust";
  const fallbackImplementation = input.fallbackImplementation ?? "ts";
  incrementFallback({
    operation: input.operation,
    attemptedImplementation,
    fallbackImplementation
  });
  logStructured("warn", {
    event: "workspace_sync_fallback",
    operation: input.operation,
    target: input.target,
    attemptedImplementation,
    fallbackImplementation,
    ...(input.metadata ?? {}),
    ...toErrorDetails(input.error)
  });
}

export function getNativeWorkspaceSyncObservabilitySnapshot(): NativeWorkspaceSyncObservabilitySnapshot {
  return {
    attempts: [...attemptCounters.values()].sort((left, right) =>
      createMetricKey({
        operation: left.operation,
        implementation: left.implementation,
        outcome: left.outcome
      }).localeCompare(
        createMetricKey({
          operation: right.operation,
          implementation: right.implementation,
          outcome: right.outcome
        })
      )
    ),
    durations: [...durationStats.values()].sort((left, right) =>
      createMetricKey({
        operation: left.operation,
        implementation: left.implementation
      }).localeCompare(
        createMetricKey({
          operation: right.operation,
          implementation: right.implementation
        })
      )
    ),
    fallbacks: [...fallbackCounters.values()].sort((left, right) =>
      createMetricKey({
        operation: left.operation,
        attemptedImplementation: left.attemptedImplementation,
        fallbackImplementation: left.fallbackImplementation
      }).localeCompare(
        createMetricKey({
          operation: right.operation,
          attemptedImplementation: right.attemptedImplementation,
          fallbackImplementation: right.fallbackImplementation
        })
      )
    )
  };
}

export function renderNativeWorkspaceSyncMetrics(): string {
  const snapshot = getNativeWorkspaceSyncObservabilitySnapshot();
  const lines = [
    "# HELP oah_native_workspace_sync_attempts_total Total observed workspace sync operation attempts by implementation and outcome.",
    "# TYPE oah_native_workspace_sync_attempts_total counter"
  ];

  for (const attempt of snapshot.attempts) {
    lines.push(
      `oah_native_workspace_sync_attempts_total${formatLabels({
        operation: attempt.operation,
        implementation: attempt.implementation,
        outcome: attempt.outcome
      })} ${attempt.count}`
    );
  }

  lines.push(
    "# HELP oah_native_workspace_sync_duration_ms_total Total cumulative observed workspace sync duration in milliseconds.",
    "# TYPE oah_native_workspace_sync_duration_ms_total counter"
  );
  for (const duration of snapshot.durations) {
    lines.push(
      `oah_native_workspace_sync_duration_ms_total${formatLabels({
        operation: duration.operation,
        implementation: duration.implementation
      })} ${duration.totalMs}`
    );
  }

  lines.push(
    "# HELP oah_native_workspace_sync_duration_ms_count Number of observed workspace sync durations.",
    "# TYPE oah_native_workspace_sync_duration_ms_count counter"
  );
  for (const duration of snapshot.durations) {
    lines.push(
      `oah_native_workspace_sync_duration_ms_count${formatLabels({
        operation: duration.operation,
        implementation: duration.implementation
      })} ${duration.count}`
    );
  }

  lines.push(
    "# HELP oah_native_workspace_sync_duration_ms_last Most recent observed workspace sync duration in milliseconds.",
    "# TYPE oah_native_workspace_sync_duration_ms_last gauge"
  );
  for (const duration of snapshot.durations) {
    lines.push(
      `oah_native_workspace_sync_duration_ms_last${formatLabels({
        operation: duration.operation,
        implementation: duration.implementation
      })} ${duration.lastMs}`
    );
  }

  lines.push(
    "# HELP oah_native_workspace_sync_duration_ms_max Maximum observed workspace sync duration in milliseconds.",
    "# TYPE oah_native_workspace_sync_duration_ms_max gauge"
  );
  for (const duration of snapshot.durations) {
    lines.push(
      `oah_native_workspace_sync_duration_ms_max${formatLabels({
        operation: duration.operation,
        implementation: duration.implementation
      })} ${duration.maxMs}`
    );
  }

  lines.push(
    "# HELP oah_native_workspace_sync_fallbacks_total Total native workspace sync fallbacks from one implementation to another.",
    "# TYPE oah_native_workspace_sync_fallbacks_total counter"
  );
  for (const fallback of snapshot.fallbacks) {
    lines.push(
      `oah_native_workspace_sync_fallbacks_total${formatLabels({
        operation: fallback.operation,
        attempted_implementation: fallback.attemptedImplementation,
        fallback_implementation: fallback.fallbackImplementation
      })} ${fallback.count}`
    );
  }

  return `${lines.join("\n")}\n`;
}

export function resetNativeWorkspaceSyncObservabilityForTests(): void {
  attemptCounters.clear();
  durationStats.clear();
  fallbackCounters.clear();
}
