import { Readable } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";

export function resolveOwnerId(input: { ownerId?: string | undefined }): string | undefined {
  const ownerId = input.ownerId?.trim();
  return ownerId && ownerId.length > 0 ? ownerId : undefined;
}

export function copyProxyResponseHeaders(reply: FastifyReply, headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    if (name === "transfer-encoding" || name === "connection" || name === "keep-alive") {
      continue;
    }

    reply.header(name, value);
  }
}

export function buildOwnerProxyUrl(
  ownerBaseUrl: string,
  request: FastifyRequest,
  publicPathPattern: RegExp,
  internalPathPrefix: string
): string {
  const targetPath = (request.raw.url ?? request.url).replace(publicPathPattern, internalPathPrefix);
  const normalizedBaseUrl = (() => {
    try {
      const url = new URL(ownerBaseUrl);
      const normalizedPath = url.pathname.replace(/\/(?:api|internal)\/v1\/?$/u, "").replace(/\/+$/u, "");
      return `${url.origin}${normalizedPath}`;
    } catch {
      return ownerBaseUrl.replace(/\/(?:api|internal)\/v1\/?$/u, "").replace(/\/+$/u, "");
    }
  })();
  return `${normalizedBaseUrl}${targetPath}`;
}

export function buildProxyHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && contentType.length > 0) {
    headers.set("content-type", contentType);
  }

  const accept = request.headers.accept;
  if (typeof accept === "string" && accept.length > 0) {
    headers.set("accept", accept);
  }

  const ifMatch = request.headers["if-match"];
  if (typeof ifMatch === "string" && ifMatch.length > 0) {
    headers.set("if-match", ifMatch);
  }

  return headers;
}

export type ProxyRequestBody = Buffer | string | Readable;

export function isReadableRequestBody(body: unknown): body is Readable {
  return (
    typeof body === "object" &&
    body !== null &&
    "pipe" in body &&
    typeof (body as { pipe?: unknown }).pipe === "function" &&
    "on" in body &&
    typeof (body as { on?: unknown }).on === "function"
  );
}

export async function readRequestBodyBuffer(body: unknown): Promise<Buffer | undefined> {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (!isReadableRequestBody(body)) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function buildProxyBody(request: FastifyRequest): ProxyRequestBody | undefined {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  if (Buffer.isBuffer(request.body) || isReadableRequestBody(request.body)) {
    return request.body;
  }

  if (typeof request.body === "string") {
    return request.body;
  }

  if (request.body === undefined || request.body === null) {
    return undefined;
  }

  return JSON.stringify(request.body);
}

export function buildProxyRequestInit(request: FastifyRequest, body: ProxyRequestBody | undefined): RequestInit {
  const init = {
    method: request.method,
    headers: buildProxyHeaders(request),
    ...(body !== undefined ? { body: body as RequestInit["body"] } : {})
  } as RequestInit & { duplex?: "half" };
  if (body && isReadableRequestBody(body)) {
    init.duplex = "half";
  }
  return init;
}

export async function sendProxyResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);
  copyProxyResponseHeaders(reply, response.headers);
  if (!response.body) {
    await reply.send();
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    await reply.send(await response.text());
    return;
  }

  const stream = Readable.fromWeb(response.body as never);
  stream.on("error", () => {
    if (reply.raw.destroyed) {
      return;
    }

    if (!reply.raw.headersSent) {
      reply.raw.statusCode = 502;
      reply.raw.setHeader("content-type", "text/plain; charset=utf-8");
      reply.raw.end("Upstream stream terminated.");
      return;
    }

    reply.raw.end();
  });
  await reply.send(stream);
}
