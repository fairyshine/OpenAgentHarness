import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
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

export async function launchWebUi(options: WebUiOptions): Promise<void> {
  const staticRoot = await resolveWebUiStaticRoot();
  if (staticRoot) {
    await launchStaticWebUi({ ...options, staticRoot });
    return;
  }

  await launchViteWebUi(options);
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
  const publicUrl = `http://${options.host}:${options.port}`;
  const server = createPackagedWebUiServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

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
      response.statusCode = 500;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(error instanceof Error ? error.message : "Internal WebUI server error.");
    }
  });
}

function shouldProxy(requestUrl: string): boolean {
  const pathOnly = requestUrl.split("?")[0] ?? requestUrl;
  return STATIC_PROXY_PREFIXES.some((prefix) => pathOnly === prefix.slice(0, -1) || pathOnly.startsWith(prefix));
}

async function proxyRequest(connection: OahConnection, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const targetUrl = new URL(request.url ?? "/", connection.baseUrl);
  const headers = buildProxyHeaders(connection, request);
  const method = request.method ?? "GET";
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const body = hasBody ? await readRequestBody(request) : undefined;

  await new Promise<void>((resolve, reject) => {
    const upstreamRequest = (targetUrl.protocol === "https:" ? httpsRequest : httpRequest)(
      targetUrl,
      {
        method,
        headers
      },
      (upstreamResponse) => {
        response.statusCode = upstreamResponse.statusCode ?? 502;
        response.statusMessage = upstreamResponse.statusMessage ?? "";
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (value !== undefined && key.toLowerCase() !== "connection") {
            response.setHeader(key, value);
          }
        }

        upstreamResponse.on("error", (error) => {
          if (!response.destroyed && !response.headersSent) {
            response.statusCode = 502;
            response.end("Upstream stream terminated.");
          } else if (!response.destroyed) {
            response.end();
          }
          resolve();
        });
        response.on("error", () => {
          upstreamRequest.destroy();
          upstreamResponse.destroy();
          resolve();
        });
        response.on("close", () => {
          upstreamRequest.destroy();
          upstreamResponse.destroy();
          resolve();
        });
        upstreamResponse.on("end", resolve);
        upstreamResponse.pipe(response);
      }
    );

    upstreamRequest.setTimeout(0);
    upstreamRequest.on("error", (error) => {
      if (response.headersSent || response.destroyed) {
        resolve();
        return;
      }
      response.statusCode = 502;
      response.end(error.message);
      resolve();
    });
    request.on("aborted", () => {
      upstreamRequest.destroy();
      resolve();
    });
    if (body) {
      upstreamRequest.end(body);
    } else {
      upstreamRequest.end();
    }
  });
}

function buildProxyHeaders(connection: OahConnection, request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "content-length") {
      continue;
    }
    if (Array.isArray(value)) {
      headers[key] = value;
      continue;
    }
    headers[key] = value;
  }

  if (connection.token?.trim() && !hasHeader(headers, "authorization")) {
    headers.authorization = `Bearer ${connection.token.trim()}`;
  }

  return headers;
}

function hasHeader(headers: Record<string, string | string[]>, name: string): boolean {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowerName);
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

  const stream = createReadStream(filePath);
  stream.on("error", (error) => {
    if (response.destroyed) {
      return;
    }

    if (!response.headersSent) {
      response.statusCode = error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? 404 : 500;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(response.statusCode === 404 ? "Not found" : "Failed to read static asset.");
      return;
    }

    response.end();
  });
  stream.pipe(response);
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
