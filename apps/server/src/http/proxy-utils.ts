import { Readable } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";

export function resolveOwnerId(input: { ownerId?: string | undefined; userId?: string | undefined }): string | undefined {
  const ownerId = input.ownerId?.trim();
  if (ownerId) {
    return ownerId;
  }

  const userId = input.userId?.trim();
  return userId && userId.length > 0 ? userId : undefined;
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

export function buildProxyBody(request: FastifyRequest): Buffer | string | undefined {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  if (Buffer.isBuffer(request.body)) {
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

  await reply.send(Readable.fromWeb(response.body as never));
}
