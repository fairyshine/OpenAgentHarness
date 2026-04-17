import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyRequest } from "fastify";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const openApiSpecPath = path.join(repoRoot, "docs", "openapi", "openapi.yaml");
const brandLogoPath = path.join(repoRoot, "assets", "logo-readme.png");

function loadPngDataUrl(filePath: string): string {
  try {
    return `data:image/png;base64,${readFileSync(filePath).toString("base64")}`;
  } catch {
    return "";
  }
}

const brandLogoDataUrl = loadPngDataUrl(brandLogoPath);

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getRequestOrigin(request: FastifyRequest): string {
  const host = request.headers.host?.trim() || "localhost";
  return `${request.protocol}://${host}`;
}

export async function loadOpenApiSpec(origin: string): Promise<string> {
  const raw = await readFile(openApiSpecPath, "utf8");
  return raw.replace(
    /servers:\n\s+- url:\s+.+?\n\s+description:\s+.+?\n/u,
    `servers:\n  - url: ${origin}/api/v1\n    description: Current server\n`
  );
}

export async function loadOpenApiDocument(origin: string): Promise<Record<string, unknown>> {
  return YAML.parse(await loadOpenApiSpec(origin)) as Record<string, unknown>;
}

function buildBrandLogoHtml(): string {
  if (!brandLogoDataUrl) {
    return "";
  }

  return `<img class="brand-logo" src="${brandLogoDataUrl}" alt="Open Agent Harness logo" />`;
}

function buildFaviconLinks(): string {
  if (!brandLogoDataUrl) {
    return "";
  }

  return `
    <link rel="icon" type="image/png" href="${brandLogoDataUrl}" />
    <link rel="apple-touch-icon" href="${brandLogoDataUrl}" />`;
}

export function buildApiIndex(request: FastifyRequest) {
  const origin = getRequestOrigin(request);
  const groups = {
    workspaces: {
      description: "Create, import, inspect, and enumerate workspaces exposed by this server.",
      routes: [
        "GET /api/v1/workspaces",
        "POST /api/v1/workspaces",
        "POST /api/v1/workspaces/import",
        "GET /api/v1/blueprints"
      ]
    },
    sessions: {
      description: "Create sessions inside workspaces and manage session-level metadata.",
      routes: [
        "POST /api/v1/workspaces/{workspaceId}/sessions",
        "GET /api/v1/workspaces/{workspaceId}/sessions",
        "GET /api/v1/sessions/{sessionId}",
        "PATCH /api/v1/sessions/{sessionId}",
        "DELETE /api/v1/sessions/{sessionId}"
      ]
    },
    messagesAndRuns: {
      description: "Send messages, inspect run state, follow run steps, and cancel active work.",
      routes: [
        "POST /api/v1/sessions/{sessionId}/messages",
        "GET /api/v1/sessions/{sessionId}/messages",
        "GET /api/v1/sessions/{sessionId}/runs",
        "GET /api/v1/sessions/{sessionId}/events",
        "GET /api/v1/runs/{runId}",
        "GET /api/v1/runs/{runId}/steps",
        "POST /api/v1/runs/{runId}/cancel",
        "POST /api/v1/runs/{runId}/requeue",
        "POST /api/v1/runs/requeue"
      ]
    },
    filesAndCatalog: {
      description: "Inspect workspace catalog state and use sandbox-scoped file and command surfaces for execution data access.",
      routes: [
        "GET /api/v1/workspaces/{workspaceId}/catalog",
        "POST /api/v1/sandboxes",
        "GET /api/v1/sandboxes/{sandboxId}",
        "GET /api/v1/sandboxes/{sandboxId}/files/entries",
        "GET /api/v1/sandboxes/{sandboxId}/files/content",
        "PUT /api/v1/sandboxes/{sandboxId}/files/content",
        "PUT /api/v1/sandboxes/{sandboxId}/files/upload",
        "GET /api/v1/sandboxes/{sandboxId}/files/download",
        "POST /api/v1/sandboxes/{sandboxId}/directories",
        "DELETE /api/v1/sandboxes/{sandboxId}/files/entry",
        "PATCH /api/v1/sandboxes/{sandboxId}/files/move",
        "POST /api/v1/sandboxes/{sandboxId}/commands/foreground"
      ]
    },
    modelsAndDiagnostics: {
      description: "Discover model/provider configuration and inspect service diagnostics.",
      routes: [
        "GET /api/v1/model-providers",
        "GET /api/v1/platform-models",
        "POST /api/v1/platform-models/refresh",
        "POST /api/v1/platform-models/refresh/distributed"
      ]
    }
  };

  return {
    name: "Open Agent Harness API",
    docs: {
      landingPage: `${origin}/`,
      docsPage: `${origin}/docs`,
      openapiYaml: `${origin}/openapi.yaml`,
      openapiJson: `${origin}/openapi.json`
    },
    probes: {
      healthz: `${origin}/healthz`,
      readyz: `${origin}/readyz`
    },
    auth: {
      apiPrefix: "/api/v1",
      standaloneBehavior: "When no external caller-context resolver is configured, /api/v1 requests run as standalone:anonymous.",
      hostedBehavior: "When an external caller-context resolver is configured, clients must present caller context through the host integration."
    },
    entrypoints: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.routes])),
    groups
  };
}

export function buildDeveloperLandingHtml(request: FastifyRequest): string {
  const origin = getRequestOrigin(request);
  const apiIndex = `${origin}/api/v1`;
  const docsPage = `${origin}/docs`;
  const openApiYaml = `${origin}/openapi.yaml`;
  const openApiJson = `${origin}/openapi.json`;
  const healthz = `${origin}/healthz`;
  const readyz = `${origin}/readyz`;
  const sampleWorkspaceList = `${origin}/api/v1/workspaces?pageSize=20`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Agent Harness</title>
    ${buildFaviconLinks()}
    <style>
      :root {
        color-scheme: light;
        --background: hsl(0 0% 94%);
        --foreground: hsl(0 0% 9%);
        --muted-foreground: hsl(0 0% 38%);
        --border: hsl(0 0% 82%);
        --muted: hsl(0 0% 91.2%);
        --card: hsl(0 0% 98.8%);
        --app-shell-background: #e7e7e3;
        --app-shell-gradient:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.65), transparent 30%),
          radial-gradient(circle at top right, rgba(255, 255, 255, 0.45), transparent 24%),
          linear-gradient(180deg, #ebebe7 0%, #ddddda 100%);
        --pane-background: linear-gradient(180deg, rgba(255, 255, 253, 0.88) 0%, rgba(249, 249, 246, 0.96) 100%);
        --pane-border: rgba(17, 17, 17, 0.08);
        --pane-shadow: rgba(17, 17, 17, 0.22);
        --code: #f2ede3;
        --code-border: rgba(17, 17, 17, 0.08);
        --pill: rgba(255, 255, 255, 0.75);
        --pill-hover: rgba(255, 255, 255, 0.92);
        --accent-strong: #111214;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
        font-feature-settings: "cv02", "cv03", "cv04", "cv11";
        background-color: var(--app-shell-background);
        background-image: var(--app-shell-gradient);
        color: var(--foreground);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        letter-spacing: -0.01em;
      }
      main {
        position: relative;
        max-width: 1040px;
        margin: 0 auto;
        padding: 28px 20px 56px;
      }
      .hero, .panel {
        position: relative;
        overflow: hidden;
        border: 1px solid var(--pane-border);
        border-radius: 16px;
        background: var(--pane-background);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74), 0 18px 40px -34px rgba(17, 17, 17, 0.24);
        animation: rise-in 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .hero {
        padding: 28px;
        min-height: 260px;
      }
      .hero::before,
      .panel::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.52), transparent 34%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.14), transparent 40%);
        pointer-events: none;
      }
      .hero > *,
      .panel > * {
        position: relative;
        z-index: 1;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 11px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--foreground) 9%, transparent);
        background: var(--pill);
        color: rgba(20, 20, 20, 0.76);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      h1 {
        max-width: 760px;
        margin: 18px 0 12px;
        font-size: clamp(32px, 6vw, 52px);
        line-height: 1.02;
        letter-spacing: -0.045em;
        text-wrap: balance;
      }
      p {
        margin: 0;
        color: var(--muted-foreground);
        line-height: 1.7;
      }
      .grid {
        display: grid;
        gap: 16px;
        margin-top: 22px;
      }
      .grid.two {
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      }
      .panel {
        padding: 22px;
      }
      .panel h2 {
        margin: 0 0 10px;
        font-size: 17px;
        letter-spacing: -0.03em;
      }
      ul {
        margin: 12px 0 0;
        padding-left: 18px;
        color: var(--muted-foreground);
      }
      li + li {
        margin-top: 8px;
      }
      a {
        color: var(--accent-strong);
      }
      code, pre {
        font-family: "SFMono-Regular", "Consolas", monospace;
      }
      code {
        background: var(--code);
        padding: 2px 6px;
        border-radius: 8px;
        border: 1px solid var(--code-border);
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      pre {
        margin: 12px 0 0;
        padding: 14px;
        border-radius: 16px;
        overflow-x: auto;
        background: var(--code);
        border: 1px solid var(--code-border);
        color: var(--foreground);
        line-height: 1.6;
      }
      .links {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
      }
      .links a {
        text-decoration: none;
        border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
        background: var(--pill);
        color: var(--foreground);
        padding: 10px 14px;
        border-radius: 999px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82), 0 10px 18px -16px rgba(17, 17, 17, 0.28);
        transition:
          transform 180ms ease,
          background-color 180ms ease,
          border-color 180ms ease;
      }
      .links a:hover {
        background: var(--pill-hover);
        border-color: color-mix(in srgb, var(--foreground) 11%, transparent);
        transform: translateY(-1px);
      }
      .lede {
        max-width: 680px;
        font-size: 15px;
      }
      .surface-kicker {
        margin-bottom: 8px;
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.48);
      }
      .brand-logo {
        display: block;
        width: 72px;
        height: 72px;
        object-fit: contain;
      }
      .brand-block {
        display: inline-flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 16px;
      }
      .brand-block-copy {
        display: grid;
        gap: 8px;
      }
      .brand-block-copy .surface-kicker {
        margin: 0;
      }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 18px;
      }
      .info-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 11px;
        border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
        border-radius: 999px;
        background: var(--pill);
        color: var(--foreground);
        font-size: 12px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      .panel-muted {
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.46);
      }
      .stat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
        margin-top: 18px;
      }
      .stat {
        padding: 12px 13px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
        background: rgba(255, 255, 255, 0.48);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      .stat-label {
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.48);
      }
      .stat-value {
        margin-top: 6px;
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.03em;
      }
      .card-grid {
        display: grid;
        gap: 12px;
        margin-top: 14px;
      }
      .card-grid.three {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .subcard {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--foreground) 7%, transparent);
        background: rgba(255, 255, 255, 0.34);
      }
      .subcard h3 {
        margin: 0 0 8px;
        font-size: 15px;
        letter-spacing: -0.03em;
      }
      .subcard p {
        font-size: 14px;
      }
      .subcard li {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .subcard ul {
        margin-top: 10px;
      }
      .route-list {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
      }
      .route-list li + li {
        margin-top: 8px;
      }
      .route-list code {
        display: inline-block;
        min-width: 220px;
      }
      @keyframes rise-in {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @media (max-width: 640px) {
        main {
          padding: 18px 14px 34px;
        }
        .hero,
        .panel {
          border-radius: 14px;
        }
        .hero {
          padding: 20px;
        }
        .panel {
          padding: 18px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="brand-block">
          ${buildBrandLogoHtml()}
          <div class="brand-block-copy">
            <span class="eyebrow">Developer Entry</span>
            <p class="surface-kicker">OpenAgentHarness / Runtime Endpoint</p>
          </div>
        </div>
        <h1>Open Agent Harness is listening.</h1>
        <p class="lede">
          This server exposes a headless agent runtime over HTTP. Start here, then use the OpenAPI spec or the API index to
          explore the surface area on your own.
        </p>
        <div class="meta-row">
          <span class="info-chip">Theme: runtime workbench</span>
          <span class="info-chip">Surface: developer entry</span>
          <span class="info-chip">Base URL: ${escapeHtml(origin)}</span>
        </div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Primary Prefix</div>
            <div class="stat-value">/api/v1</div>
          </div>
          <div class="stat">
            <div class="stat-label">API Spec</div>
            <div class="stat-value">OpenAPI 3.1</div>
          </div>
          <div class="stat">
            <div class="stat-label">Realtime</div>
            <div class="stat-value">SSE Events</div>
          </div>
          <div class="stat">
            <div class="stat-label">Files</div>
            <div class="stat-value">Workspace I/O</div>
          </div>
        </div>
        <div class="links">
          <a href="${escapeHtml(docsPage)}">Open Docs</a>
          <a href="${escapeHtml(openApiYaml)}">OpenAPI YAML</a>
          <a href="${escapeHtml(openApiJson)}">OpenAPI JSON</a>
          <a href="${escapeHtml(apiIndex)}">API Index</a>
          <a href="${escapeHtml(healthz)}">Health</a>
          <a href="${escapeHtml(readyz)}">Readiness</a>
        </div>
      </section>

      <div class="grid two">
        <section class="panel">
          <p class="panel-muted">Start Here</p>
          <h2>What To Open</h2>
          <ul>
            <li><a href="${escapeHtml(docsPage)}">${escapeHtml(docsPage)}</a> for a human-readable quickstart.</li>
            <li><a href="${escapeHtml(openApiYaml)}">${escapeHtml(openApiYaml)}</a> for the raw OpenAPI document.</li>
            <li><a href="${escapeHtml(openApiJson)}">${escapeHtml(openApiJson)}</a> for direct import into API clients and tooling.</li>
            <li><a href="${escapeHtml(apiIndex)}">${escapeHtml(apiIndex)}</a> for a machine-readable route index.</li>
          </ul>
        </section>

        <section class="panel">
          <p class="panel-muted">Probe The Server</p>
          <h2>First Calls</h2>
          <ul>
            <li><code>GET /healthz</code> and <code>GET /readyz</code> to verify the process and dependencies.</li>
            <li><code>GET /api/v1/workspaces</code> to inspect available workspaces.</li>
            <li><code>GET /api/v1/model-providers</code> and <code>GET /api/v1/platform-models</code> to inspect model configuration.</li>
          </ul>
        </section>
      </div>

      <section class="panel" style="margin-top: 18px;">
        <p class="panel-muted">Use Directly</p>
        <h2>Quick Probe</h2>
        <p>If this server is running in standalone mode, many <code>/api/v1</code> requests work immediately as <code>standalone:anonymous</code>.</p>
        <pre>curl ${escapeHtml(JSON.stringify(sampleWorkspaceList))}
curl ${escapeHtml(JSON.stringify(openApiYaml))}
curl ${escapeHtml(JSON.stringify(openApiJson))}
curl ${escapeHtml(JSON.stringify(apiIndex))}</pre>
      </section>

      <section class="panel" style="margin-top: 18px;">
        <p class="panel-muted">Common Workflows</p>
        <h2>Choose A Task, Then Follow The Matching Surface</h2>
        <div class="card-grid three">
          <article class="subcard">
            <h3>Inspect Runtime State</h3>
            <p>Start with health, workspace list, session list, then drill into messages and runs.</p>
            <ul>
              <li><code>GET /healthz</code></li>
              <li><code>GET /api/v1/workspaces</code></li>
              <li><code>GET /api/v1/workspaces/{workspaceId}/sessions</code></li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Send Work Into A Session</h3>
            <p>Create a session, post a message, then follow run state and event streaming.</p>
            <ul>
              <li><code>POST /api/v1/workspaces/{workspaceId}/sessions</code></li>
              <li><code>POST /api/v1/sessions/{sessionId}/messages</code></li>
              <li><code>GET /api/v1/sessions/{sessionId}/events</code></li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Work With Files</h3>
            <p>Resolve a sandbox, then browse, read, write, upload, download, or move entries inside its root filesystem.</p>
            <ul>
              <li><code>GET /api/v1/sandboxes/{sandboxId}</code></li>
              <li><code>GET /api/v1/sandboxes/{sandboxId}/files/entries</code></li>
              <li><code>PUT /api/v1/sandboxes/{sandboxId}/files/upload</code></li>
            </ul>
          </article>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function buildDeveloperDocsHtml(request: FastifyRequest): string {
  const origin = getRequestOrigin(request);
  const apiIndex = `${origin}/api/v1`;
  const openApiYaml = `${origin}/openapi.yaml`;
  const openApiJson = `${origin}/openapi.json`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Agent Harness Docs</title>
    ${buildFaviconLinks()}
    <style>
      :root {
        color-scheme: light;
        --foreground: hsl(0 0% 9%);
        --muted-foreground: hsl(0 0% 38%);
        --app-shell-background: #e7e7e3;
        --app-shell-gradient:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.65), transparent 30%),
          radial-gradient(circle at top right, rgba(255, 255, 255, 0.45), transparent 24%),
          linear-gradient(180deg, #ebebe7 0%, #ddddda 100%);
        --pane-background: linear-gradient(180deg, rgba(255, 255, 253, 0.88) 0%, rgba(249, 249, 246, 0.96) 100%);
        --pane-border: rgba(17, 17, 17, 0.08);
        --code: #f2ede3;
        --code-border: rgba(17, 17, 17, 0.08);
        --pill: rgba(255, 255, 255, 0.75);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
        font-feature-settings: "cv02", "cv03", "cv04", "cv11";
        background-color: var(--app-shell-background);
        background-image: var(--app-shell-gradient);
        color: var(--foreground);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        letter-spacing: -0.01em;
      }
      main {
        max-width: 980px;
        margin: 0 auto;
        padding: 28px 20px 56px;
      }
      section {
        position: relative;
        overflow: hidden;
        background: var(--pane-background);
        border: 1px solid var(--pane-border);
        border-radius: 16px;
        padding: 22px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74), 0 18px 40px -34px rgba(17, 17, 17, 0.24);
        animation: rise-in 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      section::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.52), transparent 34%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.14), transparent 40%);
        pointer-events: none;
      }
      section > * {
        position: relative;
        z-index: 1;
      }
      section + section {
        margin-top: 16px;
      }
      h1, h2 {
        margin: 0 0 10px;
        letter-spacing: -0.04em;
      }
      p, li {
        color: var(--muted-foreground);
        line-height: 1.7;
      }
      code, pre {
        font-family: "SFMono-Regular", "Consolas", monospace;
      }
      code {
        background: var(--code);
        padding: 2px 6px;
        border-radius: 8px;
        border: 1px solid var(--code-border);
      }
      pre {
        margin: 12px 0 0;
        background: var(--code);
        padding: 14px;
        border-radius: 16px;
        overflow-x: auto;
        border: 1px solid var(--code-border);
      }
      .surface-kicker {
        margin-bottom: 8px;
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.48);
      }
      .brand-logo {
        display: block;
        width: 64px;
        height: 64px;
        object-fit: contain;
      }
      .brand-block {
        display: inline-flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 16px;
      }
      .brand-block-copy {
        display: grid;
        gap: 6px;
      }
      .brand-block-copy .surface-kicker,
      .brand-block-copy h1 {
        margin: 0;
      }
      a {
        color: #111214;
      }
      .link-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .link-row a {
        text-decoration: none;
        padding: 10px 14px;
        border-radius: 999px;
        background: var(--pill);
        border: 1px solid rgba(17, 17, 17, 0.08);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      .grid {
        display: grid;
        gap: 16px;
      }
      .grid.two {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .subcard {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(17, 17, 17, 0.07);
        background: rgba(255, 255, 255, 0.34);
      }
      .subcard h3 {
        margin: 0 0 8px;
        font-size: 15px;
        letter-spacing: -0.03em;
      }
      .subcard p, .subcard li {
        font-size: 14px;
      }
      .step-list {
        margin: 12px 0 0;
        padding-left: 18px;
      }
      .route-list {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
      }
      .route-list li + li {
        margin-top: 8px;
      }
      .route-list code {
        display: inline-block;
        min-width: 240px;
      }
      .callout {
        margin-top: 14px;
        padding: 13px 14px;
        border-radius: 14px;
        border: 1px solid rgba(17, 17, 17, 0.07);
        background: rgba(255, 255, 255, 0.42);
      }
      @keyframes rise-in {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @media (max-width: 640px) {
        main {
          padding: 18px 14px 34px;
        }
        section {
          padding: 18px;
          border-radius: 14px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <div class="brand-block">
          ${buildBrandLogoHtml()}
          <div class="brand-block-copy">
            <p class="surface-kicker">OpenAgentHarness / Docs</p>
            <h1>Developer Quickstart</h1>
          </div>
        </div>
        <p>
          Open Agent Harness serves its HTTP API under <code>/api/v1</code>. Use the API index and OpenAPI YAML below to inspect
          routes, payloads, and response shapes.
        </p>
        <div class="link-row">
          <a href="${escapeHtml(apiIndex)}">API Index</a>
          <a href="${escapeHtml(openApiYaml)}">OpenAPI YAML</a>
          <a href="${escapeHtml(openApiJson)}">OpenAPI JSON</a>
          <a href="${escapeHtml(origin)}/">Landing Page</a>
        </div>
        <div class="callout">
          Use this page when you want a short guided path. Use <code>/api/v1</code> when you want a machine-readable route index. Use
          <code>/openapi.yaml</code> or <code>/openapi.json</code> when you want schema-level detail in Postman, Insomnia, codegen, or your own tooling.
        </div>
      </section>

      <section>
        <p class="surface-kicker">Caller Context</p>
        <h2>How Auth Works</h2>
        <p>
          In standalone mode, <code>/api/v1</code> requests are handled as <code>standalone:anonymous</code>. In hosted mode, the
          upstream integration must attach caller context before requests reach this process.
        </p>
      </section>

      <section>
        <p class="surface-kicker">Three Minute Path</p>
        <h2>Start Here If You Are New</h2>
        <ol class="step-list">
          <li>Probe <code>/healthz</code> and <code>/readyz</code> to confirm the process and backing services are up.</li>
          <li>Read <code>/api/v1</code> to see the route families exposed by this concrete server.</li>
          <li>List workspaces with <code>GET /api/v1/workspaces</code>.</li>
          <li>Create or pick a session, then send a message with <code>POST /api/v1/sessions/{sessionId}/messages</code>.</li>
          <li>Follow live state over <code>GET /api/v1/sessions/{sessionId}/events</code>.</li>
        </ol>
      </section>

      <section>
        <p class="surface-kicker">By Job</p>
        <h2>Common Endpoint Groups</h2>
        <div class="grid two">
          <article class="subcard">
            <h3>Workspace Discovery</h3>
            <ul class="route-list">
              <li><code>GET /api/v1/workspaces</code> List visible workspaces</li>
              <li><code>GET /api/v1/blueprints</code> List blueprints</li>
              <li><code>POST /api/v1/workspaces</code> Create a managed workspace</li>
              <li><code>POST /api/v1/workspaces/import</code> Register an existing root</li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Conversation Runtime</h3>
            <ul class="route-list">
              <li><code>POST /api/v1/workspaces/{workspaceId}/sessions</code> Create a session</li>
              <li><code>POST /api/v1/sessions/{sessionId}/messages</code> Queue a new user message</li>
              <li><code>GET /api/v1/sessions/{sessionId}/runs</code> Inspect runs</li>
              <li><code>GET /api/v1/runs/{runId}/steps</code> Inspect run steps</li>
              <li><code>POST /api/v1/runs/{runId}/requeue</code> Manually requeue a quarantined recovery run</li>
              <li><code>POST /api/v1/runs/requeue</code> Batch requeue recovery runs with per-item results</li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Realtime Streaming</h3>
            <ul class="route-list">
              <li><code>GET /api/v1/sessions/{sessionId}/events</code> Session-scoped SSE stream</li>
              <li><code>?cursor=...</code> Resume after the last seen event</li>
              <li><code>?runId=...</code> Narrow the stream to one run</li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Sandbox Files</h3>
            <ul class="route-list">
              <li><code>POST /api/v1/sandboxes</code> Create or resolve a sandbox</li>
              <li><code>GET /api/v1/sandboxes/{sandboxId}/files/entries</code> List files</li>
              <li><code>GET /api/v1/sandboxes/{sandboxId}/files/content</code> Read a file</li>
              <li><code>PUT /api/v1/sandboxes/{sandboxId}/files/content</code> Write a file</li>
              <li><code>PUT /api/v1/sandboxes/{sandboxId}/files/upload</code> Upload raw bytes</li>
            </ul>
          </article>
        </div>
      </section>

      <section>
        <p class="surface-kicker">Streaming Notes</p>
        <h2>Event Stream Expectations</h2>
        <div class="grid two">
          <article class="subcard">
            <h3>Transport</h3>
            <p>The event stream is Server-Sent Events. Expect <code>event:</code>, <code>data:</code>, and optional <code>id:</code> lines.</p>
          </article>
          <article class="subcard">
            <h3>Replay</h3>
            <p>Persist the latest cursor you receive, then reconnect with <code>?cursor=...</code> to continue from that point.</p>
          </article>
        </div>
      </section>

      <section>
        <p class="surface-kicker">Minimal Flow</p>
        <h2>Minimal Flow</h2>
        <pre>curl ${escapeHtml(JSON.stringify(`${origin}/api/v1/workspaces?pageSize=20`))}
curl ${escapeHtml(JSON.stringify(`${origin}/api/v1/model-providers`))}
curl ${escapeHtml(JSON.stringify(`${origin}/api/v1/platform-models`))}

# create a workspace
curl -X POST ${escapeHtml(JSON.stringify(`${origin}/api/v1/workspaces`))} \\
  -H "content-type: application/json" \\
  -d '{"name":"demo","rootPath":"/tmp/demo","executionPolicy":"local"}'

# create a session in that workspace
curl -X POST ${escapeHtml(JSON.stringify(`${origin}/api/v1/workspaces/{workspaceId}/sessions`))} \\
  -H "content-type: application/json" \\
  -d '{}'</pre>
      </section>
    </main>
  </body>
</html>`;
}
