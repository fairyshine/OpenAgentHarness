import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, openSync } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export type DaemonCommandOptions = {
  home?: string | undefined;
};

export type DaemonStartOptions = DaemonCommandOptions & {
  auth?: boolean | undefined;
  timeoutMs?: number | undefined;
};

export type DaemonLogOptions = DaemonCommandOptions & {
  lines?: number | undefined;
  follow?: boolean | undefined;
};

export type DaemonApiConnection = {
  baseUrl: string;
  token?: string | undefined;
};

type DaemonPaths = {
  packageRoot: string;
  repoRoot: string;
  home: string;
  configPath: string;
  runDir: string;
  logDir: string;
  pidPath: string;
  tokenPath: string;
  versionPath: string;
  logPath: string;
};

type ServerEndpoint = {
  host: string;
  port: number;
  baseUrl: string;
};

const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DEFAULT_DAEMON_PORT = 8787;
const DEFAULT_DAEMON_START_TIMEOUT_MS = 90_000;
const DAEMON_READY_PROBE_TIMEOUT_MS = 2_000;
const HOME_VERSION = "1";

function readBoolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  return fallback;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldEnableLocalApiAuth(auth?: boolean | undefined): boolean {
  return auth ?? readBoolEnv("OAH_LOCAL_API_AUTH", false);
}

export function resolveOahHome(input?: string | undefined): string {
  return path.resolve(input ?? process.env.OAH_HOME ?? process.env.OAH_INSTALL_ROOT ?? path.join(homedir(), ".openagentharness"));
}

export function resolveDaemonPaths(options: DaemonCommandOptions = {}): DaemonPaths {
  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), "../..");
  const repoRoot = resolveSourceRepoRoot(packageRoot) ?? packageRoot;
  const home = resolveOahHome(options.home);
  const runDir = path.join(home, "run");
  const logDir = path.join(home, "logs");
  return {
    packageRoot,
    repoRoot,
    home,
    configPath: path.join(home, "config", "daemon.yaml"),
    runDir,
    logDir,
    pidPath: path.join(runDir, "daemon.pid"),
    tokenPath: path.join(runDir, "token"),
    versionPath: path.join(home, ".oah-home-version"),
    logPath: path.join(logDir, "daemon.log")
  };
}

export async function initDaemonHome(options: DaemonCommandOptions = {}): Promise<DaemonPaths> {
  const paths = resolveDaemonPaths(options);
  const templateRoot = await resolveDeployRootTemplate(paths);
  await assertExists(templateRoot, `template deploy root not found: ${templateRoot}`);
  await mkdir(paths.home, { recursive: true });
  await copyMissingTree(templateRoot, paths.home);
  await Promise.all([mkdir(paths.runDir, { recursive: true }), mkdir(paths.logDir, { recursive: true })]);
  if (!(await pathExists(paths.versionPath))) {
    await writeFile(paths.versionPath, `${HOME_VERSION}\n`, { mode: 0o644 });
  }
  await ensureDaemonToken(paths);
  return paths;
}

export async function resolveDaemonApiConnection(options: DaemonCommandOptions = {}): Promise<DaemonApiConnection> {
  const paths = await initDaemonHome(options);
  const endpoint = await readDaemonEndpoint(paths.configPath);
  const token = process.env.OAH_LOCAL_API_TOKEN?.trim() || (await ensureDaemonToken(paths));
  return {
    baseUrl: endpoint.baseUrl,
    ...(token ? { token } : {})
  };
}

export async function startDaemon(options: DaemonStartOptions = {}): Promise<string> {
  const paths = await initDaemonHome(options);
  const endpoint = await readDaemonEndpoint(paths.configPath);
  const current = await readPidStatus(paths.pidPath);
  if (current.kind === "running") {
    const profile = await fetchSystemProfile(endpoint.baseUrl).catch(() => null);
    return `OAP daemon is already running (pid ${current.pid}) at ${endpoint.baseUrl}${profile ? ` as ${profile}` : ""}.`;
  }
  if (current.kind === "stale") {
    await rm(paths.pidPath, { force: true });
  }

  const existingEndpoint = await fetchSystemProfile(endpoint.baseUrl).catch(() => null);
  const existingHealth = existingEndpoint ? true : await fetchHealth(endpoint.baseUrl).catch(() => false);
  if (existingHealth) {
    throw new Error(
      `Port ${endpoint.port} already responds at ${endpoint.baseUrl} (${existingEndpoint ?? "unknown service"}). Stop that process or change ${paths.configPath}.`
    );
  }

  const token = process.env.OAH_LOCAL_API_TOKEN?.trim() || (shouldEnableLocalApiAuth(options.auth) ? await ensureDaemonToken(paths) : undefined);
  const command = await resolveServerCommand(paths);
  const logFd = openSync(paths.logPath, "a", 0o644);
  const child = spawn(command.command, command.args, {
    cwd: paths.repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      OAH_HOME: paths.home,
      OAH_DEPLOY_ROOT: process.env.OAH_DEPLOY_ROOT ?? paths.home,
      ...(token ? { OAH_LOCAL_API_TOKEN: token } : {})
    }
  });
  child.on("error", (error) => {
    process.stderr.write(`Failed to start OAP daemon process: ${error.message}\n`);
  });
  child.unref();
  await writeFile(paths.pidPath, `${child.pid}\n`, { mode: 0o644 });

  const startupTimeoutMs = options.timeoutMs ?? readPositiveIntEnv("OAH_DAEMON_START_TIMEOUT_MS", DEFAULT_DAEMON_START_TIMEOUT_MS);
  const started = await waitForDaemon(endpoint.baseUrl, child.pid, startupTimeoutMs);
  if (!started.ok) {
    throw new Error(`OAP daemon did not become ready: ${started.reason}. See ${paths.logPath}.`);
  }

  return `OAP daemon started (pid ${child.pid}) at ${endpoint.baseUrl}. Logs: ${paths.logPath}`;
}

export async function daemonStatus(options: DaemonCommandOptions = {}): Promise<string> {
  const paths = resolveDaemonPaths(options);
  const endpoint = await readDaemonEndpoint(paths.configPath).catch(() => ({
    host: DEFAULT_DAEMON_HOST,
    port: DEFAULT_DAEMON_PORT,
    baseUrl: `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`
  }));
  const current = await readPidStatus(paths.pidPath);
  if (current.kind === "missing") {
    const profile = await fetchSystemProfile(endpoint.baseUrl).catch(() => null);
    return profile
      ? `OAP daemon responds at ${endpoint.baseUrl} (${profile}), but no PID file exists at ${paths.pidPath}.`
      : `OAP daemon is stopped.`;
  }
  if (current.kind === "stale") {
    return `OAP daemon is stopped; stale PID file found for pid ${current.pid} at ${paths.pidPath}.`;
  }

  const profile = await fetchSystemProfile(endpoint.baseUrl).catch(() => null);
  return profile
    ? `OAP daemon is running (pid ${current.pid}) at ${endpoint.baseUrl} as ${profile}.`
    : `OAP daemon process is running (pid ${current.pid}), but ${endpoint.baseUrl} is not healthy yet.`;
}

export async function isDaemonProcessRunning(options: DaemonCommandOptions = {}): Promise<boolean> {
  const paths = resolveDaemonPaths(options);
  return (await readPidStatus(paths.pidPath)).kind === "running";
}

export async function stopDaemon(options: DaemonCommandOptions = {}): Promise<string> {
  const paths = resolveDaemonPaths(options);
  const current = await readPidStatus(paths.pidPath);
  if (current.kind === "missing") {
    return "OAP daemon is already stopped.";
  }
  if (current.kind === "stale") {
    await rm(paths.pidPath, { force: true });
    return `Removed stale OAP daemon PID file for pid ${current.pid}.`;
  }

  process.kill(current.pid, "SIGTERM");
  const stopped = await waitForExit(current.pid, 8_000);
  if (!stopped) {
    process.kill(current.pid, "SIGKILL");
    await waitForExit(current.pid, 3_000);
  }
  await rm(paths.pidPath, { force: true });
  return stopped ? `OAP daemon stopped (pid ${current.pid}).` : `OAP daemon force-stopped (pid ${current.pid}).`;
}

export async function restartDaemon(options: DaemonStartOptions = {}): Promise<string> {
  const stopMessage = await stopDaemon(options);
  const startMessage = await startDaemon(options);
  return `${stopMessage}\n${startMessage}`;
}

export async function readDaemonLogs(options: DaemonLogOptions = {}): Promise<string> {
  const paths = resolveDaemonPaths(options);
  if (!(await pathExists(paths.logPath))) {
    return `No daemon log file found at ${paths.logPath}.`;
  }
  const lineCount = Math.max(1, Math.min(options.lines ?? 80, 1000));
  return tailFile(paths.logPath, lineCount);
}

export function followDaemonLogs(options: DaemonLogOptions = {}): void {
  const paths = resolveDaemonPaths(options);
  const stream = createReadStream(paths.logPath, { encoding: "utf8", start: 0 });
  stream.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  stream.on("end", () => {
    const child = spawn("tail", ["-f", paths.logPath], {
      stdio: "inherit"
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
    });
  });
}

async function resolveServerCommand(paths: DaemonPaths): Promise<{ command: string; args: string[] }> {
  const distEntry = path.join(paths.repoRoot, "apps", "server", "dist", "index.js");
  if (await pathExists(distEntry)) {
    return {
      command: process.execPath,
      args: [distEntry, "--config", paths.configPath]
    };
  }

  const sourceEntry = path.join(paths.repoRoot, "apps", "server", "src", "index.ts");
  if (await pathExists(sourceEntry)) {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    assertCommandAvailable(
      pnpmCommand,
      [
        "Source checkout daemon startup requires pnpm because the server is launched through `pnpm exec tsx`.",
        "Install it with `corepack enable && corepack prepare pnpm@10.30.2 --activate`, then run `pnpm install`.",
        "Alternatively run `pnpm build` once so `oah daemon start` can use apps/server/dist/index.js without pnpm."
      ].join(" ")
    );
    return {
      command: pnpmCommand,
      args: ["exec", "tsx", "--tsconfig", "./apps/server/tsconfig.json", "./apps/server/src/index.ts", "--", "--config", paths.configPath]
    };
  }

  const packagedEntry = await resolvePackageEntrypoint("@oah/server/index");
  if (!packagedEntry || !(await pathExists(packagedEntry))) {
    throw new Error(`server entrypoint not found: ${sourceEntry}, ${distEntry}, or @oah/server/index`);
  }
  return {
    command: process.execPath,
    args: [packagedEntry, "--config", paths.configPath]
  };
}

function assertCommandAvailable(command: string, message: string): void {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore"
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    throw new Error(message);
  }
}

function resolveSourceRepoRoot(packageRoot: string): string | undefined {
  const candidates = [path.resolve(packageRoot, "../..")];
  return candidates.find(
    (candidate) =>
      existsSync(path.join(candidate, "pnpm-workspace.yaml")) &&
      existsSync(path.join(candidate, "template", "deploy-root")) &&
      existsSync(path.join(candidate, "apps", "server"))
  );
}

async function resolveDeployRootTemplate(paths: DaemonPaths): Promise<string> {
  const candidates = [
    process.env.OAH_DEPLOY_ROOT_TEMPLATE,
    path.join(paths.repoRoot, "template", "deploy-root"),
    path.join(paths.packageRoot, "dist", "assets", "deploy-root"),
    path.join(paths.packageRoot, "assets", "deploy-root")
  ]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "config", "daemon.yaml"))) {
      return candidate;
    }
  }
  return candidates[0] ?? path.join(paths.packageRoot, "dist", "assets", "deploy-root");
}

async function resolvePackageEntrypoint(specifier: string): Promise<string | undefined> {
  try {
    const resolved = import.meta.resolve(specifier);
    if (!resolved.startsWith("file:")) {
      return undefined;
    }
    return fileURLToPath(resolved);
  } catch {
    return undefined;
  }
}

async function copyMissingTree(source: string, target: string): Promise<void> {
  const sourceInfo = await stat(source);
  if (sourceInfo.isDirectory()) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyMissingTree(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  if (!(await pathExists(target))) {
    await cp(source, target, { force: false, errorOnExist: true });
  }
}

async function ensureDaemonToken(paths: DaemonPaths): Promise<string> {
  if (await pathExists(paths.tokenPath)) {
    return (await readFile(paths.tokenPath, "utf8")).trim();
  }
  await mkdir(paths.runDir, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  await writeFile(paths.tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

async function readDaemonEndpoint(configPath: string): Promise<ServerEndpoint> {
  const content = await readFile(configPath, "utf8");
  const server = readYamlSection(content, "server");
  const host = server.host ?? DEFAULT_DAEMON_HOST;
  const port = parsePort(server.port, DEFAULT_DAEMON_PORT);
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`
  };
}

function readYamlSection(content: string, sectionName: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/u);
  let inSection = false;
  for (const line of lines) {
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
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

async function readPidStatus(pidPath: string): Promise<{ kind: "missing" } | { kind: "stale"; pid: number } | { kind: "running"; pid: number }> {
  if (!(await pathExists(pidPath))) {
    return { kind: "missing" };
  }
  const raw = (await readFile(pidPath, "utf8")).trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { kind: "stale", pid: 0 };
  }
  return isProcessRunning(pid) ? { kind: "running", pid } : { kind: "stale", pid };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDaemon(baseUrl: string, pid: number | undefined, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let lastReason = "daemon did not respond yet";
  while (Date.now() < deadline) {
    if (pid && !isProcessRunning(pid)) {
      return { ok: false, reason: `process ${pid} exited early` };
    }
    const remainingMs = Math.max(1, deadline - Date.now());
    const probe = await probeDaemonReady(baseUrl, Math.min(DAEMON_READY_PROBE_TIMEOUT_MS, remainingMs));
    if (probe.ok) {
      return { ok: true };
    }
    lastReason = probe.reason;
    await delay(Math.min(500, Math.max(100, deadline - Date.now())));
  }
  const elapsedMs = Date.now() - startedAt;
  const processState = pid && isProcessRunning(pid) ? `; process ${pid} is still running` : "";
  return { ok: false, reason: `timed out after ${elapsedMs}ms waiting for /readyz (${lastReason}${processState})` };
}

async function probeDaemonReady(baseUrl: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/u, "")}/readyz`, timeoutMs);
    if (response.ok) {
      return { ok: true };
    }
    return { ok: false, reason: `/readyz returned ${response.status} ${response.statusText}` };
  } catch (error) {
    return { ok: false, reason: describeFetchError(error) };
  }
}

async function fetchHealth(baseUrl: string): Promise<boolean> {
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/u, "")}/healthz`, DAEMON_READY_PROBE_TIMEOUT_MS);
  return response.ok;
}

async function fetchSystemProfile(baseUrl: string): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/u, "")}/api/v1/system/profile`, DAEMON_READY_PROBE_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as { displayName?: string; deploymentKind?: string; runtimeMode?: string };
  return payload.displayName ?? `${payload.deploymentKind ?? "oah"} ${payload.runtimeMode ?? "server"}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "ready probe timed out";
    }
    return error.message;
  }
  return String(error);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(200);
  }
  return !isProcessRunning(pid);
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  const content = await readFile(filePath, "utf8");
  const rows = content.split(/\r?\n/u);
  return rows.slice(-lines).join("\n");
}

async function assertExists(filePath: string, message: string): Promise<void> {
  if (!(await pathExists(filePath))) {
    throw new Error(message);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
