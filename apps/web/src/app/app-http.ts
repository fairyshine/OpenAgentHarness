import type { ErrorResponse } from "@oah/api-contracts";

import type { AppRequestErrorSummary, ConnectionSettings } from "./support-types";

function normalizeBaseUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/\/+$/u, "");
}

function buildUrl(baseUrl: string, path: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}${path}` : path;
}

function buildAuthHeaders(connection: ConnectionSettings, extraHeaders?: HeadersInit): Headers {
  const headers = new Headers(extraHeaders);
  const token = connection.token.trim();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) {
    return undefined as T;
  }

  return JSON.parse(raw) as T;
}

class HttpRequestError extends Error {
  readonly code?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly statusCode: number;
  readonly statusText: string;

  constructor(input: {
    message: string;
    statusCode: number;
    statusText: string;
    code?: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "HttpRequestError";
    this.code = input.code;
    this.details = input.details;
    this.statusCode = input.statusCode;
    this.statusText = input.statusText;
  }
}

async function createHttpRequestError(response: Response): Promise<HttpRequestError> {
  const body = await readJsonResponse<ErrorResponse>(response).catch(() => undefined);
  return new HttpRequestError({
    message: body?.error?.message ?? `${response.status} ${response.statusText}`,
    statusCode: response.status,
    statusText: response.statusText,
    ...(body?.error?.code ? { code: body.error.code } : {}),
    ...(body?.error?.details ? { details: body.error.details } : {})
  });
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error instanceof HttpRequestError && error.code) {
      return `${error.code}: ${error.message}`;
    }

    return error.message;
  }

  return String(error);
}

function toErrorSummary(error: unknown): AppRequestErrorSummary | null {
  if (error instanceof HttpRequestError) {
    return {
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
      statusCode: error.statusCode,
      statusText: error.statusText,
      timestamp: new Date().toISOString()
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      timestamp: new Date().toISOString()
    };
  }

  if (typeof error === "string") {
    return {
      message: error,
      timestamp: new Date().toISOString()
    };
  }

  return null;
}

function isNotFoundError(error: unknown) {
  const message = toErrorMessage(error);
  return message.startsWith("404 ") || message.toLowerCase().includes("not found");
}

function downloadJsonFile(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadCsvFile(filename: string, columns: string[], rows: Array<Record<string, unknown>>) {
  const escapeCsv = (value: unknown) => {
    const text =
      typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
    return `"${text.replaceAll('"', '""')}"`;
  };

  const csv = [columns.map(escapeCsv).join(","), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))].join("\n");
  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export {
  buildAuthHeaders,
  buildUrl,
  createHttpRequestError,
  downloadCsvFile,
  downloadJsonFile,
  isNotFoundError,
  normalizeBaseUrl,
  readJsonResponse,
  toErrorMessage,
  toErrorSummary
};
