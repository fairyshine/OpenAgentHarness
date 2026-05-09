import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";

import type { JsonHttpRequest } from "./types.js";

export function appendTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function assertHttpSuccess(
  operation: string,
  response: {
    status: number;
    body: unknown;
    text: string;
  }
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const message =
    extractStatusMessage(response.body) ?? (response.text.trim() || `${operation} failed with status ${response.status}`);
  throw new Error(`${operation} failed with status ${response.status}: ${message}`);
}

export function extractStatusMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const error = Reflect.get(body, "error");
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  const message = Reflect.get(body, "message");
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

export async function defaultJsonHttpRequest(
  input: JsonHttpRequest
): Promise<{
  status: number;
  body: unknown;
  text: string;
}> {
  const url = new URL(input.url);
  const transport = url.protocol === "https:" ? https : http;
  const ca = input.caFile ? await readFile(input.caFile, "utf8") : undefined;

  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: input.method,
        headers: input.headers,
        ...(url.protocol === "https:"
          ? {
              ca,
              rejectUnauthorized: input.skipTlsVerify ? false : true
            }
          : {})
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(input.timeoutMs ?? 0, () => {
      request.destroy(new Error(`request timed out after ${input.timeoutMs}ms`));
    });
    if (input.body) {
      request.write(input.body);
    }
    request.end();
  });

  const body = text.trim().length > 0 ? tryParseJson(text) : undefined;

  return {
    status,
    body,
    text
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
