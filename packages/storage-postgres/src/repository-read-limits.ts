const DEFAULT_POSTGRES_BOUNDED_READ_LIMIT = 5_000;
const DEFAULT_POSTGRES_EVENT_READ_LIMIT = 1_000;
const MAX_POSTGRES_BOUNDED_READ_LIMIT = 100_000;

function resolvePostgresBoundedReadLimit(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim() || process.env.OAH_POSTGRES_BOUNDED_READ_LIMIT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_POSTGRES_BOUNDED_READ_LIMIT);
}

export {
  DEFAULT_POSTGRES_BOUNDED_READ_LIMIT,
  DEFAULT_POSTGRES_EVENT_READ_LIMIT,
  MAX_POSTGRES_BOUNDED_READ_LIMIT,
  resolvePostgresBoundedReadLimit
};
