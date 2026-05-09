function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeFileSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function pathLeaf(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/g, "");
  if (!normalized) {
    return "";
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function addRecentId(list: string[], id: string) {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, 8);
}

function filterStable<T>(list: T[], predicate: (value: T) => boolean) {
  const next = list.filter(predicate);
  return next.length === list.length && next.every((value, index) => Object.is(value, list[index])) ? list : next;
}

export {
  addRecentId,
  filterStable,
  isRecord,
  pathLeaf,
  prettyJson,
  readStringArray,
  sanitizeFileSegment,
  uniqueStrings
};
