import { nowIso } from "../utils.js";

export interface RunExecutionContext {
  currentAgentName: string;
  injectSystemReminder: boolean;
  delegatedRunIds: string[];
}

export type AutomaticRecoveryStrategy = "fail" | "requeue_running" | "requeue_all";

export type RecoveryActor =
  | "worker_startup"
  | "worker_startup_requeue"
  | "worker_drain_timeout"
  | "worker_drain_timeout_requeue"
  | "manual_operator_requeue";

export function timeoutMsFromSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value * 1000);
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "aborted" ||
      error.message === "This operation was aborted")
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveArchiveTimeZone(): string {
  return process.env.OAH_ARCHIVE_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function formatArchiveDate(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

export function buildArchiveMetadata() {
  const deletedAt = nowIso();
  const timezone = resolveArchiveTimeZone();

  return {
    archiveDate: formatArchiveDate(deletedAt, timezone),
    archivedAt: deletedAt,
    deletedAt,
    timezone
  };
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number | undefined,
  timeoutMessage: string
): Promise<T> {
  if (timeoutMs === undefined) {
    return operation(undefined);
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    return await Promise.race([
      operation(abortController.signal),
      new Promise<T>((_resolve, reject) => {
        abortController.signal.addEventListener(
          "abort",
          () => {
            reject(new Error(timeoutMessage));
          },
          { once: true }
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
