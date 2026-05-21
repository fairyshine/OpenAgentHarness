import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import type { OahConnection } from "../api/oah-api.js";
import { resolveDaemonPaths } from "../daemon/lifecycle.js";

export type WebUiOptions = {
  connection: OahConnection;
  host: string;
  port: number;
  open?: boolean;
};

type WebUiServerOptions = WebUiOptions & {
  staticRoot: string;
};

const STATIC_PROXY_PREFIXES = ["/api/", "/internal/", "/healthz", "/readyz", "/metrics"] as const;
const MAX_WEBUI_PORT_ATTEMPTS = 20;
const WEBUI_PORT_PROBE_TIMEOUT_MS = 200;

export async function launchWebUi(options: WebUiOptions): Promise<void> {
  const port = await resolveAvailableWebUiPort(options.host, options.port);
  if (port !== options.port) {
    console.error(`WebUI port ${options.port} is in use; using ${port} instead.`);
  }

  const resolvedOptions = { ...options, port };
  const staticRoot = await resolveWebUiStaticRoot();
  if (staticRoot) {
    await launchStaticWebUi({ ...resolvedOptions, staticRoot });
    return;
  }

  await launchViteWebUi(resolvedOptions);
}

export async function resolveWebUiStaticRoot(): Promise<string | undefined> {
  const paths = resolveDaemonPaths();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OAH_WEB_DIST,
    path.resolve(moduleDir, "../webui"),
    path.resolve(moduleDir, "../../../web/dist"),
    path.join(paths.repoRoot, "apps", "web", "dist"),
    path.join(paths.repoRoot, "web", "dist"),
    path.join(paths.repoRoot, "dist", "web")
  ]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, "index.html");
    if (await pathExists(indexPath)) {
      return candidate;
    }
  }

  return undefined;
}

async function launchViteWebUi(options: WebUiOptions): Promise<void> {
  const paths = resolveDaemonPaths();
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = [
    "--filter",
    "@oah/web",
    "dev",
    "--",
    "--host",
    options.host,
    "--port",
    String(options.port),
    ...(options.open ? ["--open"] : [])
  ];

  console.error(`Starting WebUI at http://${options.host}:${options.port} with OAH API ${options.connection.baseUrl}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pnpmCommand, args, {
      cwd: paths.repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        OAH_WEB_PROXY_TARGET: options.connection.baseUrl,
        ...(options.connection.token ? { OAH_TOKEN: options.connection.token } : {})
      }
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`WebUI dev server exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`));
    });
  });
}

async function launchStaticWebUi(options: WebUiServerOptions): Promise<void> {
  const { server, port } = await listenStaticWebUi(options);
  const publicUrl = `http://${options.host}:${port}`;

  console.error(`Serving WebUI at ${publicUrl} with OAH API ${options.connection.baseUrl}`);
  console.error(`Using WebUI static bundle from ${options.staticRoot}`);
  if (options.open) {
    openBrowser(publicUrl);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
}

async function listenStaticWebUi(options: WebUiServerOptions): Promise<{ server: Server; port: number }> {
  for (let offset = 0; offset < MAX_WEBUI_PORT_ATTEMPTS; offset += 1) {
    const port = options.port + offset;
    if (await isWebUiPortInUse(options.host, port)) {
      continue;
    }

    const server = createPackagedWebUiServer({ ...options, port });
    try {
      await listen(server, options.host, port);
      return { server, port };
    } catch (error) {
      if (isAddressInUseError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Unable to start WebUI: ports ${options.port}-${options.port + MAX_WEBUI_PORT_ATTEMPTS - 1} are already in use.`
  );
}

async function resolveAvailableWebUiPort(host: string, requestedPort: number): Promise<number> {
  for (let offset = 0; offset < MAX_WEBUI_PORT_ATTEMPTS; offset += 1) {
    const port = requestedPort + offset;
    if (!(await isWebUiPortInUse(host, port))) {
      return port;
    }
  }

  throw new Error(`Unable to start WebUI: ports ${requestedPort}-${requestedPort + MAX_WEBUI_PORT_ATTEMPTS - 1} are already in use.`);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isAddressInUseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}

async function isWebUiPortInUse(host: string, port: number): Promise<boolean> {
  for (const candidateHost of probeHostsForBindHost(host)) {
    if (await canConnect(candidateHost, port)) {
      return true;
    }
  }
  return false;
}

function probeHostsForBindHost(host: string): string[] {
  if (host === "0.0.0.0" || host === "::") {
    return ["127.0.0.1", "::1"];
  }
  if (host === "localhost") {
    return ["127.0.0.1", "::1", "localhost"];
  }
  return [host];
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(WEBUI_PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export function createPackagedWebUiServer(options: WebUiServerOptions) {
  const staticRoot = path.resolve(options.staticRoot);
  return createServer(async (request, response) => {
    try {
      const requestUrl = request.url ?? "/";
      if (shouldProxy(requestUrl)) {
        await proxyRequest(options.connection, request, response);
        return;
      }

      await serveStaticFile(staticRoot, request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end(error instanceof Error ? error.message : "Internal WebUI server error.");
        return;
      }

      response.destroy(error instanceof Error ? error : undefined);
    }
  });
}

function shouldProxy(requestUrl: string): boolean {
  const pathOnly = requestUrl.split("?")[0] ?? requestUrl;
  return STATIC_PROXY_PREFIXES.some((prefix) => pathOnly === prefix.slice(0, -1) || pathOnly.startsWith(prefix));
}

async function proxyRequest(connection: OahConnection, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const targetUrl = new URL(request.url ?? "/", connection.baseUrl);
  if (shouldUseStreamingProxy(targetUrl)) {
    await proxyStreamingRequest(connection, targetUrl, request, response);
    return;
  }

  const headers = buildProxyHeaders(connection, request);
  const method = request.method ?? "GET";
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const body = hasBody ? await readRequestBody(request) : undefined;

  const upstream = await fetch(targetUrl, {
    method,
    headers,
    ...(body ? { body } : {})
  });

  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-encoding") {
      response.setHeader(key, value);
    }
  });

  if (!upstream.body) {
    response.end();
    return;
  }

  await pipeline(Readable.fromWeb(upstream.body), response);
}

function shouldUseStreamingProxy(targetUrl: URL): boolean {
  return targetUrl.pathname.endsWith("/events");
}

async function proxyStreamingRequest(
  connection: OahConnection,
  targetUrl: URL,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const headers = buildProxyHeaders(connection, request);
  const method = request.method ?? "GET";
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const body = hasBody ? await readRequestBody(request) : undefined;

  await new Promise<void>((resolve, reject) => {
    const upstreamRequest = (targetUrl.protocol === "https:" ? httpsRequest : httpRequest)(
      targetUrl,
      {
        method,
        headers: headersToNodeHeaders(headers)
      },
      (upstreamResponse) => {
        response.statusCode = upstreamResponse.statusCode ?? 502;
        response.statusMessage = upstreamResponse.statusMessage ?? "";
        copyUpstreamHeaders(upstreamResponse, response);

        upstreamResponse.once("error", (error) => {
          if (!response.writableEnded) {
            response.end();
          }
          reject(error);
        });
        response.once("close", () => {
          upstreamResponse.destroy();
          resolve();
        });

        void pipeline(upstreamResponse, response).then(resolve, reject);
      }
    );

    upstreamRequest.once("error", reject);
    request.once("close", () => upstreamRequest.destroy());
    upstreamRequest.end(body);
  });
}

function buildProxyHeaders(connection: OahConnection, request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "content-length") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }
    headers.set(key, value);
  }

  if (connection.token?.trim() && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${connection.token.trim()}`);
  }

  return headers;
}

function headersToNodeHeaders(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return entries;
}

function copyUpstreamHeaders(upstreamResponse: IncomingMessage, response: ServerResponse): void {
  for (const [key, value] of Object.entries(upstreamResponse.headers)) {
    if (value === undefined || key.toLowerCase() === "content-encoding") {
      continue;
    }

    response.setHeader(key, value);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function serveStaticFile(staticRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const requestedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/u, "");
  const candidatePath = path.resolve(staticRoot, relativePath);
  const rootPrefix = `${staticRoot}${path.sep}`;

  if (candidatePath !== staticRoot && !candidatePath.startsWith(rootPrefix)) {
    response.statusCode = 403;
    response.end("Forbidden");
    return;
  }

  const filePath = await resolveStaticFile(candidatePath, staticRoot);
  const contentType = contentTypeForPath(filePath);
  response.setHeader("content-type", contentType);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

async function resolveStaticFile(candidatePath: string, staticRoot: string): Promise<string> {
  const fileStats = await stat(candidatePath).catch(() => null);
  if (fileStats?.isFile()) {
    return candidatePath;
  }

  const directoryIndex = path.join(candidatePath, "index.html");
  const directoryIndexStats = await stat(directoryIndex).catch(() => null);
  if (directoryIndexStats?.isFile()) {
    return directoryIndex;
  }

  return path.join(staticRoot, "index.html");
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
