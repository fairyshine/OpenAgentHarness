import type { ChatLine } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readToolStatus(value: unknown): ChatLine["toolStatus"] | undefined {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "denied" ||
    value === "waiting" ||
    value === "started"
  ) {
    return value === "started" ? "running" : value;
  }
  return undefined;
}

export function truncateSingleLine(value: string, limit = 96) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(1, limit - 1))}…` : normalized;
}

export function jsonPreview(value: unknown, limit = 96) {
  try {
    return truncateSingleLine(typeof value === "string" ? value : JSON.stringify(value), limit);
  } catch {
    return truncateSingleLine(String(value), limit);
  }
}

export function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function summarizeToolInput(value: unknown) {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return truncateSingleLine(value);
  }
  if (!isRecord(value)) {
    return jsonPreview(value);
  }

  for (const key of ["command", "cmd", "query", "path", "filePath", "filename", "url", "name"]) {
    const field = value[key];
    if (typeof field === "string" && field.trim().length > 0) {
      return key === "command" || key === "cmd" ? `$ ${truncateSingleLine(field)}` : truncateSingleLine(field);
    }
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .slice(0, 3)
    .map(([key, entryValue]) => `${key}: ${jsonPreview(entryValue, 36)}`);
  return truncateSingleLine(entries.join(", "));
}

export function readToolMetadata(metadata: unknown) {
  const record = isRecord(metadata) ? metadata : undefined;
  return {
    toolStatus: readToolStatus(record?.toolStatus),
    durationMs: readNumber(record?.toolDurationMs),
    sourceType: readString(record?.toolSourceType)
  };
}

export function formatDuration(durationMs: number | undefined) {
  if (durationMs === undefined) {
    return "";
  }
  return durationMs < 1000 ? `${Math.max(0, Math.round(durationMs))} ms` : `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)} s`;
}

export function toolOutputToText(output: unknown): { text: string; failed: boolean; denied: boolean } {
  if (!isRecord(output)) {
    return {
      text: typeof output === "string" ? output : prettyJson(output),
      failed: false,
      denied: false
    };
  }

  switch (output.type) {
    case "text":
      return { text: typeof output.value === "string" ? output.value : prettyJson(output.value), failed: false, denied: false };
    case "json":
      return { text: prettyJson(output.value), failed: false, denied: false };
    case "error-text":
      return { text: typeof output.value === "string" ? output.value : "Tool execution failed.", failed: true, denied: false };
    case "error-json":
      return { text: prettyJson(output.value), failed: true, denied: false };
    case "execution-denied":
      return {
        text: typeof output.reason === "string" ? output.reason : "Execution denied.",
        failed: true,
        denied: true
      };
    case "content":
      if (Array.isArray(output.value)) {
        return {
          text: output.value
            .map((item) => {
              if (!isRecord(item)) {
                return "";
              }
              if (item.type === "text" && typeof item.text === "string") {
                return item.text;
              }
              if (item.type === "file-data" || item.type === "file-url") {
                return `[file] ${readString(item.filename) ?? readString(item.url) ?? ""}`.trim();
              }
              if (item.type === "image-data" || item.type === "image-url") {
                return `[image] ${readString(item.url) ?? ""}`.trim();
              }
              return "";
            })
            .filter(Boolean)
            .join("\n"),
          failed: false,
          denied: false
        };
      }
      return { text: prettyJson(output.value), failed: false, denied: false };
    default:
      return { text: prettyJson(output), failed: false, denied: false };
  }
}

export function stringifyMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (isRecord(part)) {
          if (part.type === "text" && typeof part.text === "string") {
            return part.text;
          }
          if (part.type === "reasoning") {
            return "";
          }
          if (part.type === "tool-call" && typeof part.toolName === "string") {
            return `[tool-call] ${part.toolName}`;
          }
          if (part.type === "tool-result" && typeof part.toolName === "string") {
            return `[tool-result] ${part.toolName}`;
          }
          if (part.type === "file" && typeof part.filename === "string") {
            return `[file] ${part.filename}`;
          }
          if (part.type === "image") {
            return "[image]";
          }
          if (part.type === "tool-approval-request" && typeof part.toolCallId === "string") {
            return `[approval] ${part.toolCallId}`;
          }
        }
        return JSON.stringify(part);
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  return JSON.stringify(value) ?? String(value);
}
