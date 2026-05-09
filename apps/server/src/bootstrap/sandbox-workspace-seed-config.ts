export const SANDBOX_WORKSPACE_ROOT = "/workspace";
export const DEFAULT_DELEGATED_WORKSPACE_RECORD_POLL_MS = 50;

const DEFAULT_SEED_UPLOAD_CONCURRENCY = 8;
const DEFAULT_SEED_ARCHIVE_UPLOAD_MODE = "auto";
const DEFAULT_SEED_ARCHIVE_MIN_FILE_COUNT = 16;
const DEFAULT_SEED_ARCHIVE_MIN_TOTAL_BYTES = 128 * 1024;
const DEFAULT_SEED_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DELEGATED_WORKSPACE_RECORD_WAIT_MS = 2_000;

export function resolveSeedUploadConcurrency(): number {
  const raw = process.env.OAH_SANDBOX_SEED_UPLOAD_CONCURRENCY;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_SEED_UPLOAD_CONCURRENCY;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEED_UPLOAD_CONCURRENCY;
}

export function resolveSeedArchiveUploadMode(): "off" | "auto" | "force" {
  const raw = process.env.OAH_SANDBOX_SEED_ARCHIVE_UPLOAD?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_SEED_ARCHIVE_UPLOAD_MODE as "auto";
  }

  if (["0", "false", "off", "no", "disabled"].includes(raw)) {
    return "off";
  }

  if (["1", "true", "on", "yes", "enabled", "force"].includes(raw)) {
    return "force";
  }

  return "auto";
}

export function resolveSeedArchiveTimeoutMs(): number {
  const raw = process.env.OAH_SANDBOX_SEED_ARCHIVE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_SEED_ARCHIVE_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEED_ARCHIVE_TIMEOUT_MS;
}

export function shouldWarmPreparedSeedArchive(): boolean {
  return resolveSeedArchiveUploadMode() !== "off";
}

export function shouldAttemptSeedArchiveUpload(input: { fileCount: number; totalBytes: number }): boolean {
  const mode = resolveSeedArchiveUploadMode();
  if (mode === "off") {
    return false;
  }

  if (mode === "force") {
    return input.fileCount > 0;
  }

  return input.fileCount >= DEFAULT_SEED_ARCHIVE_MIN_FILE_COUNT || input.totalBytes >= DEFAULT_SEED_ARCHIVE_MIN_TOTAL_BYTES;
}

export function resolveDelegatedWorkspaceRecordWaitMs(): number {
  const raw = process.env.OAH_SELF_HOSTED_WORKSPACE_RECORD_WAIT_MS?.trim();
  if (!raw) {
    return DEFAULT_DELEGATED_WORKSPACE_RECORD_WAIT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELEGATED_WORKSPACE_RECORD_WAIT_MS;
}
