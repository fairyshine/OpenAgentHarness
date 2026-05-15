import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export type DesktopConnection = {
  baseUrl: string;
  token?: string;
  source: "explicit" | "local-daemon";
};

export type WebEntry =
  | {
      kind: "url";
      url: string;
    }
  | {
      kind: "file";
      filePath: string;
    };

export type DesktopLaunchPlan = {
  connection: DesktopConnection;
  webEntry: WebEntry;
  home: string;
};

const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DEFAULT_DAEMON_PORT = 8787;

export function resolveOahHome(input?: string | undefined): string {
  return path.resolve(input ?? process.env.OAH_HOME ?? path.join(homedir(), ".openagentharness"));
}

export async function resolveDesktopLaunchPlan(options: {
  home?: string | undefined;
  apiBaseUrl?: string | undefined;
  token?: string | undefined;
  webUrl?: string | undefined;
  autoStartDaemon?: boolean | undefined;
} = {}): Promise<DesktopLaunchPlan> {
  if (options.autoStartDaemon !== false && !options.apiBaseUrl && !process.env.OAH_DESKTOP_API_BASE_URL && !process.env.OAH_BASE_URL) {
    await startLocalDaemon({ home: options.home });
  }

  return {
    connection: await resolveDesktopConnection(options),
    webEntry: await resolveWebEntry(options.webUrl),
    home: resolveOahHome(options.home)
  };
}

export async function resolveDesktopConnection(options: {
  home?: string | undefined;
  apiBaseUrl?: string | undefined;
  token?: string | undefined;
} = {}): Promise<DesktopConnection> {
  const explicitBaseUrl = options.apiBaseUrl ?? process.env.OAH_DESKTOP_API_BASE_URL ?? process.env.OAH_BASE_URL;
  if (explicitBaseUrl?.trim()) {
    const token = options.token ?? process.env.OAH_DESKTOP_TOKEN ?? process.env.OAH_TOKEN ?? process.env.OAH_LOCAL_API_TOKEN;
    return {
      baseUrl: explicitBaseUrl.trim().replace(/\/+$/u, ""),
      ...(token?.trim() ? { token: token.trim() } : {}),
      source: "explicit"
    };
  }

  const home = resolveOahHome(options.home);
  const endpoint = await readDaemonEndpoint(path.join(home, "config", "daemon.yaml"));
  const token =
    options.token ??
    process.env.OAH_DESKTOP_TOKEN ??
    process.env.OAH_TOKEN ??
    process.env.OAH_LOCAL_API_TOKEN ??
    (await readToken(path.join(home, "run", "token")));
  return {
    baseUrl: endpoint,
    ...(token?.trim() ? { token: token.trim() } : {}),
    source: "local-daemon"
  };
}

export async function resolveWebEntry(webUrl = process.env.OAH_DESKTOP_WEB_URL): Promise<WebEntry> {
  if (webUrl?.trim()) {
    return {
      kind: "url",
      url: webUrl.trim()
    };
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const webDistIndex = await resolveWebDistIndex(moduleDir);
  await assertExists(
    webDistIndex,
    `WebUI build not found. Run pnpm --filter @oah/web build first or set OAH_DESKTOP_WEB_DIST.`
  );
  return {
    kind: "file",
    filePath: webDistIndex
  };
}

export function webEntryToUrl(entry: WebEntry): string {
  return entry.kind === "url" ? entry.url : pathToFileURL(entry.filePath).toString();
}

export async function startLocalDaemon(options: { home?: string | undefined }): Promise<void> {
  const command = await resolveCliCommand(options);
  await new Promise<void>((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      stdio: "ignore",
      env: process.env
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function resolveCliCommand(options: { home?: string | undefined }): Promise<{ command: string; args: string[]; cwd: string }> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  const homeArgs = options.home ? ["--home", options.home] : [];
  const explicitCliEntry = process.env.OAH_DESKTOP_CLI_ENTRY?.trim();
  if (explicitCliEntry) {
    return {
      command: process.execPath,
      args: [explicitCliEntry, "daemon", "start", ...homeArgs],
      cwd: path.dirname(explicitCliEntry)
    };
  }

  const cliSourceEntry = path.join(repoRoot, "apps", "cli", "src", "index.ts");
  if (await pathExists(cliSourceEntry)) {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    return {
      command: pnpmCommand,
      args: ["--filter", "@oah/cli", "dev", "--", "daemon", "start", ...homeArgs],
      cwd: repoRoot
    };
  }

  const cliDistCandidates = [
    path.resolve(moduleDir, "../../cli/dist/index.js"),
    path.resolve(moduleDir, "../cli/index.js"),
    path.resolve(moduleDir, "cli/index.js")
  ];

  for (const cliEntry of cliDistCandidates) {
    if (await pathExists(cliEntry)) {
      return {
        command: process.execPath,
        args: [cliEntry, "daemon", "start", ...homeArgs],
        cwd: path.dirname(cliEntry)
      };
    }
  }

  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return {
    command: pnpmCommand,
    args: ["--filter", "@oah/cli", "dev", "--", "daemon", "start", ...homeArgs],
    cwd: repoRoot
  };
}

async function resolveWebDistIndex(moduleDir: string): Promise<string> {
  const distRootCandidates = [
    process.env.OAH_DESKTOP_WEB_DIST,
    process.resourcesPath ? path.join(process.resourcesPath, "webui") : undefined,
    path.resolve(moduleDir, "../webui"),
    path.resolve(moduleDir, "../../cli/dist/webui"),
    path.resolve(moduleDir, "../../web/dist"),
    path.resolve(moduleDir, "../../../apps/cli/dist/webui"),
    path.resolve(moduleDir, "../../../apps/web/dist")
  ]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const distRoot of distRootCandidates) {
    const indexPath = path.join(distRoot, "index.html");
    if (await pathExists(indexPath)) {
      return indexPath;
    }
  }

  return path.join(distRootCandidates[0] ?? path.resolve(moduleDir, "../../web/dist"), "index.html");
}

async function readDaemonEndpoint(configPath: string): Promise<string> {
  const content = await readFile(configPath, "utf8").catch(() => "");
  const server = readYamlSection(content, "server");
  const host = normalizeHost(server.host ?? DEFAULT_DAEMON_HOST);
  const port = parsePort(server.port, DEFAULT_DAEMON_PORT);
  return `http://${host}:${port}`;
}

function normalizeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function readYamlSection(content: string, sectionName: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inSection = false;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\t/g, "    ");
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    if (!line.startsWith(" ") && line.endsWith(":")) {
      inSection = line.slice(0, -1).trim() === sectionName;
      continue;
    }
    if (!inSection || !line.startsWith(" ")) {
      continue;
    }

    const match = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/u);
    if (match?.[1] && match[2] !== undefined) {
      result[match[1]] = match[2].replace(/^["']|["']$/gu, "");
    }
  }
  return result;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

async function readToken(tokenPath: string): Promise<string | undefined> {
  const token = await readFile(tokenPath, "utf8").catch(() => "");
  return token.trim() || undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

async function assertExists(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
