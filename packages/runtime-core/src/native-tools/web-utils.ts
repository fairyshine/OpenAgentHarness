import { AppError } from "../errors.js";
import type { NativeToolSetOptions } from "./types.js";

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ");
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|tr)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

export function normalizeUrl(input: string): string {
  const parsed = new URL(input);
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }
  return parsed.toString();
}

export function isLikelyBinaryContent(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.length > 0 && !mime.startsWith("text/") && !mime.includes("json") && !mime.includes("xml") && !mime.includes("javascript");
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "OpenAgentHarness/0.1"
      }
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(408, "native_tool_timeout", `Fetching ${url} timed out.`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function answerWebFetchPrompt(
  options: NativeToolSetOptions | undefined,
  markdownContent: string,
  prompt: string,
  signal?: AbortSignal | undefined
): Promise<string> {
  if (!options?.modelGateway || !options.webFetchModel) {
    const preview = markdownContent.slice(0, 4_000);
    return [
      "Prompt execution fallback:",
      prompt,
      "",
      "Fetched content preview:",
      preview.length > 0 ? preview : "(empty page)"
    ].join("\n");
  }

  const response = await options.modelGateway.generate(
    {
      model: options.webFetchModel,
      messages: [
        {
          role: "user",
          content: [
            "Web page content:",
            "---",
            markdownContent,
            "---",
            "",
            prompt,
            "",
            "Provide a concise response based only on the content above."
          ].join("\n")
        }
      ]
    },
    signal ? { signal } : undefined
  );

  return response.text;
}

export function splitOutputLines(value: string): string[] {
  return value.length > 0 ? value.split(/\r?\n/) : [];
}
