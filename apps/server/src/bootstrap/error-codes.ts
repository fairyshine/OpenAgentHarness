export function hasErrorCode(error: unknown, code: string, statusCode?: number): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === code && (statusCode === undefined || candidate.statusCode === statusCode);
}
