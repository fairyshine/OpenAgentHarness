import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function workspacePath(relativePath: string): string {
  return path.resolve(__dirname, relativePath);
}

function normalizeProxyHost(host: string | undefined): string {
  if (!host || host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }

  return host;
}

function parseServerConfig(content: string): { host?: string; port?: number } {
  const lines = content.split(/\r?\n/u);
  let inServerBlock = false;
  let host: string | undefined;
  let port: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    if (!inServerBlock) {
      if (/^server:\s*$/u.test(line.trim())) {
        inServerBlock = true;
      }
      continue;
    }

    if (!line.startsWith(" ") && line.trim().length > 0) {
      break;
    }

    const hostMatch = line.match(/^\s*host:\s*(.+?)\s*$/u);
    if (hostMatch) {
      host = hostMatch[1].replace(/^['"]|['"]$/gu, "");
      continue;
    }

    const portMatch = line.match(/^\s*port:\s*(\d+)\s*$/u);
    if (portMatch) {
      port = Number.parseInt(portMatch[1], 10);
    }
  }

  return { host, port };
}

function resolveProxyTarget(): string {
  if (process.env.OAH_WEB_PROXY_TARGET?.trim()) {
    return process.env.OAH_WEB_PROXY_TARGET.trim();
  }

  const dockerPublishedTarget = resolveLocalDockerApiProxyTarget();
  if (dockerPublishedTarget) {
    return dockerPublishedTarget;
  }

  const repoRoot = path.resolve(__dirname, "../..");
  const configuredPath = process.env.OAH_CONFIG?.trim();
  const candidateConfigPaths = [
    configuredPath ? path.resolve(repoRoot, configuredPath) : undefined,
    path.join(repoRoot, "test_server", "server.yaml"),
    path.join(repoRoot, "server.yaml"),
    path.join(repoRoot, "server.example.yaml")
  ].filter((value): value is string => Boolean(value));

  for (const candidatePath of candidateConfigPaths) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const parsed = parseServerConfig(fs.readFileSync(candidatePath, "utf8"));
      const port = parsed.port;
      if (!port || !Number.isFinite(port)) {
        continue;
      }

      const host = normalizeProxyHost(parsed.host);
      return `http://${host}:${port}`;
    } catch {
      continue;
    }
  }

  return "http://127.0.0.1:8787";
}

function resolveLocalDockerApiProxyTarget(): string | undefined {
  try {
    const output = execSync("docker ps --format '{{.Names}}\\t{{.Ports}}'", {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    for (const rawLine of output.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const [name, ports = ""] = line.split("\t");
      if (!/oah-api/u.test(name)) {
        continue;
      }

      const publishedPortMatch = ports.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)->8787\/tcp/u);
      if (publishedPortMatch) {
        const host =
          ports.includes("0.0.0.0:") || ports.includes("[::]:")
            ? resolveNonLoopbackHost() ?? "127.0.0.1"
            : "127.0.0.1";
        return `http://${host}:${publishedPortMatch[1]}`;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveNonLoopbackHost(): string | undefined {
  const interfaces = os.networkInterfaces();
  const preferred: string[] = [];
  const fallback: string[] = [];

  function isPreferredAddress(name: string, address: string): boolean {
    return (
      /^(en|eth|wlan)/u.test(name) &&
      (/^10\./u.test(address) || /^192\.168\./u.test(address) || /^172\.(1[6-9]|2\d|3[0-1])\./u.test(address))
    );
  }

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }

      if (isPreferredAddress(name, entry.address)) {
        preferred.push(entry.address);
        continue;
      }

      fallback.push(entry.address);
    }
  }

  return preferred[0] ?? fallback[0];
}

const proxyTarget = resolveProxyTarget();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": workspacePath("./src"),
      "@oah/api-contracts": workspacePath("../../packages/api-contracts/src/index.ts")
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true
      },
      "/internal": {
        target: proxyTarget,
        changeOrigin: true
      },
      "/healthz": {
        target: proxyTarget,
        changeOrigin: true
      },
      "/readyz": {
        target: proxyTarget,
        changeOrigin: true
      }
    }
  }
});
