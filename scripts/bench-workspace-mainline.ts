import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cp, mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { WorkspaceRecord } from "../packages/engine-core/src/index.ts";
import { createSandboxBackedWorkspaceInitializer } from "../apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts";
import type { SandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";
import {
  computeNativeDirectoryFingerprint,
  planNativeSeedUpload,
  shutdownNativeWorkspaceSyncWorkerPool,
  syncNativeLocalToSandboxHttp
} from "../packages/native-bridge/src/index.ts";

type BenchmarkMode = "ts" | "oneshot" | "persistent";
type NativeBenchmarkMode = Exclude<BenchmarkMode, "ts">;

interface BenchmarkOptions {
  files: number;
  sizeBytes: number;
  iterations: number;
  seedSyncRepeats: number;
  runtimeSourceDir?: string;
  runtimeSourceLabel?: string;
}

interface BenchmarkMeasurement {
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  requestCounts: BenchmarkRequestCounts;
}

interface BenchmarkRow {
  scenario: string;
  mode: BenchmarkMode;
  iterations: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  avgRequests: number;
  avgCreateSandboxRequests: number;
  avgStatRequests: number;
  avgEntriesRequests: number;
  avgMkdirRequests: number;
  avgUploadRequests: number;
  avgDeleteRequests: number;
  avgForegroundCommandRequests: number;
}

interface SandboxEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  sizeBytes?: number;
  updatedAt?: string;
  readOnly?: boolean;
}

interface SandboxRecord {
  id: string;
  rootDir: string;
  rootPath: string;
}

interface BenchmarkRequestCounts {
  total: number;
  createSandbox: number;
  stat: number;
  entries: number;
  mkdir: number;
  upload: number;
  delete: number;
  foregroundCommand: number;
}

const DEFAULT_OPTIONS: BenchmarkOptions = {
  files: Number.parseInt(process.env.OAH_BENCH_MAINLINE_FILES || "64", 10) || 64,
  sizeBytes: Number.parseInt(process.env.OAH_BENCH_MAINLINE_SIZE_BYTES || "16384", 10) || 16384,
  iterations: Number.parseInt(process.env.OAH_BENCH_MAINLINE_ITERATIONS || "8", 10) || 8,
  seedSyncRepeats: Number.parseInt(process.env.OAH_BENCH_MAINLINE_SEED_SYNC_REPEATS || "3", 10) || 3,
  ...resolveRuntimeSourceOptions()
};

const WORKSPACE_SYNC_BINARY_BASENAME = process.platform === "win32" ? "oah-workspace-sync.exe" : "oah-workspace-sync";

function parseArgs(argv: string[]): BenchmarkOptions {
  const options = { ...DEFAULT_OPTIONS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg?.startsWith("--") || value === undefined) {
      continue;
    }

    switch (arg) {
      case "--files":
        options.files = Math.max(1, Number.parseInt(value, 10) || options.files);
        index += 1;
        break;
      case "--size-bytes":
        options.sizeBytes = Math.max(1, Number.parseInt(value, 10) || options.sizeBytes);
        index += 1;
        break;
      case "--iterations":
        options.iterations = Math.max(1, Number.parseInt(value, 10) || options.iterations);
        index += 1;
        break;
      case "--seed-sync-repeats":
        options.seedSyncRepeats = Math.max(1, Number.parseInt(value, 10) || options.seedSyncRepeats);
        index += 1;
        break;
      case "--runtime-source-dir":
        options.runtimeSourceDir = path.resolve(value);
        options.runtimeSourceLabel = path.basename(options.runtimeSourceDir);
        index += 1;
        break;
      case "--runtime-name":
        if (process.env.OAH_DEPLOY_ROOT) {
          options.runtimeSourceDir = path.resolve(process.env.OAH_DEPLOY_ROOT, "source", "runtimes", value);
          options.runtimeSourceLabel = value;
        }
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function resolveRuntimeSourceOptions(): Pick<BenchmarkOptions, "runtimeSourceDir" | "runtimeSourceLabel"> {
  const explicitSourceDir = process.env.OAH_BENCH_MAINLINE_RUNTIME_SOURCE_DIR?.trim();
  if (explicitSourceDir) {
    const runtimeSourceDir = path.resolve(explicitSourceDir);
    return {
      runtimeSourceDir,
      runtimeSourceLabel: path.basename(runtimeSourceDir)
    };
  }

  const deployRoot = process.env.OAH_DEPLOY_ROOT?.trim();
  const runtimeName = process.env.OAH_BENCH_MAINLINE_RUNTIME_NAME?.trim();
  if (deployRoot && runtimeName) {
    return {
      runtimeSourceDir: path.resolve(deployRoot, "source", "runtimes", runtimeName),
      runtimeSourceLabel: runtimeName
    };
  }

  return {};
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function createEmptyBenchmarkRequestCounts(): BenchmarkRequestCounts {
  return {
    total: 0,
    createSandbox: 0,
    stat: 0,
    entries: 0,
    mkdir: 0,
    upload: 0,
    delete: 0,
    foregroundCommand: 0
  };
}

function addBenchmarkRequestCounts(
  left: BenchmarkRequestCounts,
  right: BenchmarkRequestCounts
): BenchmarkRequestCounts {
  return {
    total: left.total + right.total,
    createSandbox: left.createSandbox + right.createSandbox,
    stat: left.stat + right.stat,
    entries: left.entries + right.entries,
    mkdir: left.mkdir + right.mkdir,
    upload: left.upload + right.upload,
    delete: left.delete + right.delete,
    foregroundCommand: left.foregroundCommand + right.foregroundCommand
  };
}

async function resolveKnownGoodWorkspaceSyncBinary(): Promise<string | undefined> {
  const configured = process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY?.trim();
  if (configured) {
    return configured;
  }

  const candidates = [
    path.resolve(process.cwd(), ".native-target", "release", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "target", "release", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "target", "debug", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "bin", WORKSPACE_SYNC_BINARY_BASENAME)
  ];

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates and keep scanning.
    }
  }

  return undefined;
}

async function configureBenchmarkMode(mode: BenchmarkMode, binary: string | undefined): Promise<void> {
  await shutdownNativeWorkspaceSyncWorkerPool();

  process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY = binary ?? process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY ?? "";
  process.env.OAH_NATIVE_WORKSPACE_SYNC = mode === "ts" ? "0" : "1";
  process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT = mode === "persistent" ? "1" : "0";
}

async function createFixture(rootDir: string, files: number, sizeBytes: number): Promise<void> {
  const payload = Buffer.alloc(sizeBytes, "b");
  for (let index = 0; index < files; index += 1) {
    const relativeDirectory = path.join(
      `batch-${String(index % 8).padStart(2, "0")}`,
      `group-${String(index % 4).padStart(2, "0")}`
    );
    const absoluteDirectory = path.join(rootDir, relativeDirectory);
    const absoluteFile = path.join(absoluteDirectory, `file-${String(index).padStart(4, "0")}.txt`);
    await mkdir(absoluteDirectory, { recursive: true });
    await writeFile(absoluteFile, payload);
    const mtime = new Date(Date.now() - index * 1000);
    await utimes(absoluteFile, mtime, mtime);
  }

  await mkdir(path.join(rootDir, ".openharness"), { recursive: true });
  await writeFile(path.join(rootDir, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      cp(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), {
        dereference: false,
        force: true,
        recursive: true
      })
    )
  );
}

async function prepareBenchmarkWorkspace(rootDir: string, options: BenchmarkOptions): Promise<void> {
  if (options.runtimeSourceDir) {
    await copyDirectoryContents(options.runtimeSourceDir, rootDir);
    return;
  }

  await createFixture(rootDir, options.files, options.sizeBytes);
}

async function measureIterations(
  iterations: number,
  action: () => Promise<void>,
  options?: {
    beforeEach?: () => Promise<void> | void;
    afterEach?: () => Promise<BenchmarkRequestCounts> | BenchmarkRequestCounts;
  }
): Promise<BenchmarkMeasurement> {
  const durations: number[] = [];
  let requestCounts = createEmptyBenchmarkRequestCounts();
  for (let index = 0; index < iterations; index += 1) {
    await options?.beforeEach?.();
    const start = performance.now();
    await action();
    durations.push(performance.now() - start);
    if (options?.afterEach) {
      requestCounts = addBenchmarkRequestCounts(requestCounts, await options.afterEach());
    }
  }

  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  return {
    iterations,
    totalMs: round(totalMs),
    avgMs: round(totalMs / iterations),
    minMs: round(Math.min(...durations)),
    maxMs: round(Math.max(...durations)),
    requestCounts: {
      total: round(requestCounts.total / iterations),
      createSandbox: round(requestCounts.createSandbox / iterations),
      stat: round(requestCounts.stat / iterations),
      entries: round(requestCounts.entries / iterations),
      mkdir: round(requestCounts.mkdir / iterations),
      upload: round(requestCounts.upload / iterations),
      delete: round(requestCounts.delete / iterations),
      foregroundCommand: round(requestCounts.foregroundCommand / iterations)
    }
  };
}

function normalizeAbsoluteSandboxPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").trim();
  if (!normalized || normalized === "." || normalized === "/") {
    return "/";
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return `/${segments.join("/")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function sandboxPathToAbsolute(rootDir: string, targetPath: string): string {
  const normalized = normalizeAbsoluteSandboxPath(targetPath);
  if (normalized === "/") {
    return rootDir;
  }
  return path.join(rootDir, normalized.slice(1));
}

function parseBenchSandboxTargetPath(targetPath: string): {
  sandboxId: string;
  normalizedPath: string;
} {
  const normalizedPath = normalizeAbsoluteSandboxPath(targetPath);
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments[0] !== "__bench" || segments.length < 2) {
    throw new Error(`Benchmark sandbox path must start with /__bench/<sandboxId>, received ${targetPath}`);
  }

  return {
    sandboxId: segments[1]!,
    normalizedPath
  };
}

async function statIfExists(targetPath: string) {
  return stat(targetPath).catch(() => null);
}

async function collectSandboxEntries(rootDir: string, sandboxPath: string): Promise<SandboxEntry[]> {
  const absoluteDirectory = sandboxPathToAbsolute(rootDir, sandboxPath);
  const directoryStat = await statIfExists(absoluteDirectory);
  if (!directoryStat?.isDirectory()) {
    return [];
  }

  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const mapped = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = normalizeAbsoluteSandboxPath(path.posix.join(sandboxPath, entry.name));
      const absoluteEntryPath = sandboxPathToAbsolute(rootDir, entryPath);
      const entryStat = await statIfExists(absoluteEntryPath);
      return {
        path: entryPath,
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        ...(entryStat?.isFile() ? { sizeBytes: Number(entryStat.size) } : {}),
        ...(entryStat?.mtime ? { updatedAt: entryStat.mtime.toISOString() } : {}),
        readOnly: false
      } satisfies SandboxEntry;
    })
  );
  return mapped
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(reply: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  reply.statusCode = statusCode;
  reply.setHeader("content-type", "application/json");
  reply.end(body);
}

function parseSandboxRequest(pathname: string): {
  sandboxId: string;
  resource: string;
} | null {
  const match = pathname.match(/^\/internal\/v1\/sandboxes\/([^/]+)\/(.+)$/);
  if (!match) {
    return null;
  }

  return {
    sandboxId: match[1]!,
    resource: match[2]!
  };
}

async function createSandboxServer(rootDir: string): Promise<{
  baseUrl: string;
  defaultSandboxId: string;
  resetRequestCounts(): void;
  snapshotRequestCounts(): BenchmarkRequestCounts;
  close(): Promise<void>;
}> {
  const sandboxes = new Map<string, SandboxRecord>();
  let requestCounts = createEmptyBenchmarkRequestCounts();
  let sandboxSequence = 0;

  async function ensureSandbox(input: { sandboxId?: string; rootPath: string }): Promise<SandboxRecord> {
    const sandboxId = input.sandboxId ?? `sb_bench_${String(sandboxSequence += 1).padStart(4, "0")}`;
    const existing = sandboxes.get(sandboxId);
    if (existing) {
      return existing;
    }

    const sandboxRootDir = path.join(rootDir, sandboxId);
    await mkdir(sandboxRootDir, { recursive: true });
    const record = {
      id: sandboxId,
      rootDir: sandboxRootDir,
      rootPath: normalizeAbsoluteSandboxPath(input.rootPath)
    } satisfies SandboxRecord;
    sandboxes.set(sandboxId, record);
    return record;
  }

  const defaultSandbox = await ensureSandbox({
    sandboxId: "sb_bench",
    rootPath: "/workspace"
  });

  const server = createServer(async (request, reply) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    const method = request.method ?? "GET";

    if (method === "POST" && pathname === "/internal/v1/sandboxes") {
      requestCounts.createSandbox += 1;
      requestCounts.total += 1;
      const body = JSON.parse((await readRequestBody(request)).toString("utf8")) as {
        name?: string;
        executionPolicy?: string;
      };
      const sandbox = await ensureSandbox({
        rootPath: `/__bench/sb_bench_${String(sandboxSequence + 1).padStart(4, "0")}/workspace`
      });
      const now = new Date().toISOString();
      sendJson(reply, 201, {
        id: sandbox.id,
        workspaceId: sandbox.id,
        provider: "self_hosted",
        executionModel: "sandbox_hosted",
        workerPlacement: "inside_sandbox",
        rootPath: sandbox.rootPath,
        name: body.name ?? sandbox.id,
        kind: "project",
        executionPolicy: body.executionPolicy ?? "local",
        createdAt: now,
        updatedAt: now
      });
      return;
    }

    const sandboxRequest = parseSandboxRequest(pathname);
    if (!sandboxRequest) {
      reply.statusCode = 404;
      reply.end();
      return;
    }

    const sandbox = sandboxes.get(sandboxRequest.sandboxId);
    if (!sandbox) {
      reply.statusCode = 404;
      reply.end();
      return;
    }

    if (method === "GET" && sandboxRequest.resource === "files/stat") {
      requestCounts.stat += 1;
      requestCounts.total += 1;
      const targetPath = requestUrl.searchParams.get("path") ?? sandbox.rootPath;
      const absolutePath = sandboxPathToAbsolute(sandbox.rootDir, targetPath);
      const entry = await statIfExists(absolutePath);
      if (!entry) {
        reply.statusCode = 404;
        reply.end();
        return;
      }

      sendJson(reply, 200, {
        kind: entry.isDirectory() ? "directory" : "file",
        size: Number(entry.size),
        mtimeMs: Number(entry.mtimeMs),
        birthtimeMs: Number(entry.birthtimeMs),
        path: normalizeAbsoluteSandboxPath(targetPath)
      });
      return;
    }

    if (method === "GET" && sandboxRequest.resource === "files/entries") {
      requestCounts.entries += 1;
      requestCounts.total += 1;
      const targetPath = requestUrl.searchParams.get("path") ?? sandbox.rootPath;
      sendJson(reply, 200, {
        workspaceId: sandbox.id,
        path: normalizeAbsoluteSandboxPath(targetPath),
        items: await collectSandboxEntries(sandbox.rootDir, targetPath),
        nextCursor: null
      });
      return;
    }

    if (method === "POST" && sandboxRequest.resource === "directories") {
      requestCounts.mkdir += 1;
      requestCounts.total += 1;
      const body = JSON.parse((await readRequestBody(request)).toString("utf8")) as {
        path?: string;
        createParents?: boolean;
      };
      const targetPath = normalizeAbsoluteSandboxPath(body.path ?? sandbox.rootPath);
      await mkdir(sandboxPathToAbsolute(sandbox.rootDir, targetPath), { recursive: body.createParents !== false });
      sendJson(reply, 200, {
        path: targetPath,
        name: path.posix.basename(targetPath),
        type: "directory",
        readOnly: false
      });
      return;
    }

    if (method === "PUT" && sandboxRequest.resource === "files/upload") {
      requestCounts.upload += 1;
      requestCounts.total += 1;
      const targetPath = normalizeAbsoluteSandboxPath(requestUrl.searchParams.get("path") ?? sandbox.rootPath);
      const overwrite = requestUrl.searchParams.get("overwrite") !== "false";
      const mtimeMs = Number(requestUrl.searchParams.get("mtimeMs") ?? "0");
      const absolutePath = sandboxPathToAbsolute(sandbox.rootDir, targetPath);
      const existing = await statIfExists(absolutePath);
      if (existing && !overwrite) {
        sendJson(reply, 409, { code: "workspace_entry_exists", message: "exists" });
        return;
      }

      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, await readRequestBody(request));
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        const modifiedAt = new Date(mtimeMs);
        await utimes(absolutePath, modifiedAt, modifiedAt);
      }
      sendJson(reply, 200, {
        path: targetPath,
        name: path.posix.basename(targetPath),
        type: "file",
        readOnly: false
      });
      return;
    }

    if (method === "DELETE" && sandboxRequest.resource === "files/entry") {
      requestCounts.delete += 1;
      requestCounts.total += 1;
      const targetPath = normalizeAbsoluteSandboxPath(requestUrl.searchParams.get("path") ?? sandbox.rootPath);
      const recursive = requestUrl.searchParams.get("recursive") === "true";
      const absolutePath = sandboxPathToAbsolute(sandbox.rootDir, targetPath);
      const existing = await statIfExists(absolutePath);
      if (!existing) {
        reply.statusCode = 404;
        reply.end();
        return;
      }

      await rm(absolutePath, { recursive, force: true });
      sendJson(reply, 200, {
        workspaceId: sandbox.id,
        path: targetPath,
        type: existing.isDirectory() ? "directory" : "file",
        deleted: true
      });
      return;
    }

    if (method === "POST" && sandboxRequest.resource === "commands/foreground") {
      requestCounts.foregroundCommand += 1;
      requestCounts.total += 1;
      const body = JSON.parse((await readRequestBody(request)).toString("utf8")) as {
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
        stdinText?: string;
      };
      const absoluteCwd = sandboxPathToAbsolute(sandbox.rootDir, body.cwd ?? sandbox.rootPath);
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", body.command], {
          cwd: absoluteCwd,
          env: {
            ...process.env,
            ...(body.env ?? {})
          },
          stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let timeoutTriggered = false;
        const timeoutMs = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? body.timeoutMs : 30_000;
        const timeoutHandle = setTimeout(() => {
          timeoutTriggered = true;
          child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timeoutHandle);
          resolve({
            stdout,
            stderr: timeoutTriggered ? (stderr || `timed out after ${timeoutMs}ms`) : stderr,
            exitCode: timeoutTriggered ? 124 : (code ?? 0)
          });
        });

        if (typeof body.stdinText === "string" && body.stdinText.length > 0) {
          child.stdin.write(body.stdinText);
        }
        child.stdin.end();
      });
      sendJson(reply, 200, result);
      return;
    }

    reply.statusCode = 404;
    reply.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve benchmark sandbox server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/internal/v1`,
    defaultSandboxId: defaultSandbox.id,
    resetRequestCounts() {
      requestCounts = createEmptyBenchmarkRequestCounts();
    },
    snapshotRequestCounts() {
      return { ...requestCounts };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function createBenchHttpWorkspaceFileSystem(baseUrl: string): SandboxHost["workspaceFileSystem"] {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function request(pathname: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${normalizedBaseUrl}${pathname}`, init);
    return response;
  }

  return {
    async realpath(targetPath) {
      return normalizeAbsoluteSandboxPath(targetPath);
    },
    async stat(targetPath) {
      const { sandboxId, normalizedPath } = parseBenchSandboxTargetPath(targetPath);
      const response = await request(
        `/sandboxes/${sandboxId}/files/stat?path=${encodeURIComponent(normalizedPath)}`
      );
      if (response.status === 404) {
        throw new Error(`ENOENT: ${normalizedPath}`);
      }
      if (!response.ok) {
        throw new Error(`Failed to stat benchmark sandbox path ${normalizedPath}: ${response.status} ${response.statusText}`);
      }
      const payload = (await response.json()) as {
        kind: "file" | "directory" | "other";
        size: number;
        mtimeMs: number;
        birthtimeMs: number;
      };
      return payload;
    },
    async readFile() {
      throw new Error("Benchmark sandbox HTTP filesystem does not support readFile.");
    },
    openReadStream() {
      throw new Error("Benchmark sandbox HTTP filesystem does not support openReadStream.");
    },
    async readdir(targetPath) {
      const { sandboxId, normalizedPath } = parseBenchSandboxTargetPath(targetPath);
      const response = await request(
        `/sandboxes/${sandboxId}/files/entries?path=${encodeURIComponent(normalizedPath)}&pageSize=200&sortBy=name&sortOrder=asc`
      );
      if (response.status === 404) {
        return [];
      }
      if (!response.ok) {
        throw new Error(
          `Failed to list benchmark sandbox path ${normalizedPath}: ${response.status} ${response.statusText}`
        );
      }
      const payload = (await response.json()) as {
        items: Array<{
          name: string;
          type: "file" | "directory" | "other";
          sizeBytes?: number;
          updatedAt?: string;
        }>;
      };
      return payload.items.map((entry) => ({
        name: entry.name,
        kind: entry.type === "directory" ? "directory" : entry.type === "file" ? "file" : "other",
        ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
        ...(typeof entry.updatedAt === "string" && entry.updatedAt.trim().length > 0 ? { updatedAt: entry.updatedAt } : {})
      }));
    },
    async mkdir(targetPath, options) {
      const { sandboxId, normalizedPath } = parseBenchSandboxTargetPath(targetPath);
      const response = await request(`/sandboxes/${sandboxId}/directories`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          path: normalizedPath,
          createParents: options?.recursive !== false
        })
      });
      if (!response.ok) {
        throw new Error(
          `Failed to create benchmark sandbox directory ${normalizedPath}: ${response.status} ${response.statusText}`
        );
      }
    },
    async writeFile(targetPath, data, options) {
      const { sandboxId, normalizedPath } = parseBenchSandboxTargetPath(targetPath);
      const query = new URLSearchParams({
        path: normalizedPath,
        overwrite: "true",
        ...(typeof options?.mtimeMs === "number" && Number.isFinite(options.mtimeMs) && options.mtimeMs > 0
          ? { mtimeMs: String(options.mtimeMs) }
          : {})
      });
      const response = await request(`/sandboxes/${sandboxId}/files/upload?${query.toString()}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream"
        },
        body: data
      });
      if (!response.ok) {
        throw new Error(
          `Failed to write benchmark sandbox file ${normalizedPath}: ${response.status} ${response.statusText}`
        );
      }
    },
    async rm(targetPath, options) {
      const { sandboxId, normalizedPath } = parseBenchSandboxTargetPath(targetPath);
      const query = new URLSearchParams({
        path: normalizedPath,
        recursive: options?.recursive ? "true" : "false"
      });
      const response = await request(`/sandboxes/${sandboxId}/files/entry?${query.toString()}`, {
        method: "DELETE"
      });
      if (response.status === 404 || response.ok) {
        return;
      }
      throw new Error(
        `Failed to delete benchmark sandbox entry ${normalizedPath}: ${response.status} ${response.statusText}`
      );
    },
    async rename() {
      throw new Error("Benchmark sandbox HTTP filesystem does not support rename.");
    }
  };
}

function createBenchHttpWorkspaceCommandExecutor(baseUrl: string): SandboxHost["workspaceCommandExecutor"] {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function runForegroundRequest(input: {
    workspace: WorkspaceRecord;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdinText?: string;
  }) {
    const { sandboxId } = parseBenchSandboxTargetPath(input.workspace.rootPath);
    const response = await fetch(`${normalizedBaseUrl}/sandboxes/${sandboxId}/commands/foreground`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: input.command,
        ...(input.cwd ? { cwd: normalizeAbsoluteSandboxPath(input.cwd) } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
        ...(typeof input.stdinText === "string" ? { stdinText: input.stdinText } : {})
      })
    });
    if (!response.ok) {
      throw new Error(`Benchmark sandbox foreground command failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>;
  }

  return {
    async runForeground(input) {
      return runForegroundRequest(input);
    },
    async runProcess(input) {
      return runForegroundRequest({
        workspace: input.workspace,
        command: [shellQuote(input.executable), ...input.args.map((arg) => shellQuote(arg))].join(" "),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
        ...(typeof input.stdinText === "string" ? { stdinText: input.stdinText } : {})
      });
    },
    async runBackground() {
      throw new Error("Benchmark sandbox host does not support background commands.");
    }
  };
}

function createBenchmarkSandboxHost(baseUrl: string): SandboxHost {
  return {
    providerKind: "self_hosted",
    workspaceCommandExecutor: createBenchHttpWorkspaceCommandExecutor(baseUrl),
    workspaceFileSystem: createBenchHttpWorkspaceFileSystem(baseUrl),
    workspaceExecutionProvider: {
      async acquire(input: { workspace: WorkspaceRecord }) {
        return {
          workspace: input.workspace,
          async release() {
            return undefined;
          }
        };
      }
    },
    workspaceFileAccessProvider: {
      async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
        return {
          workspace: input.workspace,
          async release() {
            return undefined;
          }
        };
      }
    },
    diagnostics() {
      return {
        provider: "self_hosted",
        executionModel: "sandbox_hosted",
        workerPlacement: "inside_sandbox"
      };
    },
    async maintain() {
      return undefined;
    },
    async beginDrain() {
      return undefined;
    },
    async close() {
      return undefined;
    }
  };
}

function measurementToRow(
  scenario: string,
  mode: BenchmarkMode,
  measurement: BenchmarkMeasurement
): BenchmarkRow {
  return {
    scenario,
    mode,
    iterations: measurement.iterations,
    avgMs: measurement.avgMs,
    minMs: measurement.minMs,
    maxMs: measurement.maxMs,
    avgRequests: measurement.requestCounts.total,
    avgCreateSandboxRequests: measurement.requestCounts.createSandbox,
    avgStatRequests: measurement.requestCounts.stat,
    avgEntriesRequests: measurement.requestCounts.entries,
    avgMkdirRequests: measurement.requestCounts.mkdir,
    avgUploadRequests: measurement.requestCounts.upload,
    avgDeleteRequests: measurement.requestCounts.delete,
    avgForegroundCommandRequests: measurement.requestCounts.foregroundCommand
  };
}

async function runNativeModeBenchmarks(options: BenchmarkOptions, mode: NativeBenchmarkMode, binary: string): Promise<BenchmarkRow[]> {
  await configureBenchmarkMode(mode, binary);
  console.log(`[bench] using binary=${binary}`);
  console.log(`[bench] starting native-direct mode=${mode}`);

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), `oah-bench-mainline-fixture-${mode}-`));
  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), `oah-bench-mainline-sandbox-${mode}-`));
  try {
    await prepareBenchmarkWorkspace(fixtureRoot, options);
    const sandboxServer = await createSandboxServer(sandboxRoot);
    try {
      const rows: BenchmarkRow[] = [];

      console.log(`[bench] native-direct mode=${mode} scenario=fingerprint`);
      rows.push(
        measurementToRow(
          "native_direct_fingerprint",
          mode,
          await measureIterations(options.iterations, async () => {
            await computeNativeDirectoryFingerprint({
              rootDir: fixtureRoot
            });
          })
        )
      );

      console.log(`[bench] native-direct mode=${mode} scenario=plan_seed_upload`);
      rows.push(
        measurementToRow(
          "native_direct_plan_seed_upload",
          mode,
          await measureIterations(options.iterations, async () => {
            await planNativeSeedUpload({
              rootDir: fixtureRoot,
              remoteBasePath: "/workspace"
            });
          })
        )
      );

      console.log(`[bench] native-direct mode=${mode} scenario=sync_local_to_sandbox_http_cold`);
      rows.push(
        measurementToRow(
          "native_direct_sync_local_to_sandbox_http_cold",
          mode,
          await measureIterations(
            1,
            async () => {
              await syncNativeLocalToSandboxHttp({
                rootDir: fixtureRoot,
                remoteRootPath: `/workspace/${mode}-cold`,
                sandbox: {
                  baseUrl: sandboxServer.baseUrl,
                  sandboxId: sandboxServer.defaultSandboxId
                }
              });
            },
            {
              beforeEach() {
                sandboxServer.resetRequestCounts();
              },
              afterEach() {
                return sandboxServer.snapshotRequestCounts();
              }
            }
          )
        )
      );

      console.log(`[bench] native-direct mode=${mode} scenario=sync_local_to_sandbox_http_warm`);
      rows.push(
        measurementToRow(
          "native_direct_sync_local_to_sandbox_http_warm",
          mode,
          await measureIterations(
            options.seedSyncRepeats,
            async () => {
              await syncNativeLocalToSandboxHttp({
                rootDir: fixtureRoot,
                remoteRootPath: `/workspace/${mode}-warm`,
                sandbox: {
                  baseUrl: sandboxServer.baseUrl,
                  sandboxId: sandboxServer.defaultSandboxId
                }
              });
            },
            {
              beforeEach() {
                sandboxServer.resetRequestCounts();
              },
              afterEach() {
                return sandboxServer.snapshotRequestCounts();
              }
            }
          )
        )
      );

      return rows;
    } finally {
      console.log(`[bench] closing native-direct mode=${mode}`);
      await sandboxServer.close();
      await shutdownNativeWorkspaceSyncWorkerPool();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  }
}

async function runInitializerBenchmarks(options: BenchmarkOptions, mode: BenchmarkMode, binary: string): Promise<BenchmarkRow[]> {
  await configureBenchmarkMode(mode, binary);
  console.log(`[bench] using binary=${binary}`);
  console.log(`[bench] starting initializer mode=${mode}`);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `oah-bench-mainline-initializer-${mode}-`));
  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), `oah-bench-mainline-init-sandbox-${mode}-`));
  try {
    const runtimeDir = path.join(tempRoot, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempRoot, "tools");
    const skillsDir = path.join(tempRoot, "skills");

    await Promise.all([
      prepareBenchmarkWorkspace(runtimeRoot, options),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true })
    ]);

    const sandboxServer = await createSandboxServer(sandboxRoot);
    const sandboxHost = createBenchmarkSandboxHost(sandboxServer.baseUrl);
    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost,
      selfHosted: {
        baseUrl: sandboxServer.baseUrl
      }
    });

    try {
      const rows: BenchmarkRow[] = [];

      console.log(`[bench] initializer mode=${mode} scenario=seed_prepare_cold`);
      rows.push(
        measurementToRow(
          "initializer_seed_prepare_cold",
          mode,
          await measureIterations(
            1,
            async () => {
              await initializer.initialize({
                name: `bench-${mode}-cold-${Date.now().toString(36)}`,
                runtime: "workspace",
                executionPolicy: "local"
              });
            },
            {
              beforeEach() {
                sandboxServer.resetRequestCounts();
              },
              afterEach() {
                return sandboxServer.snapshotRequestCounts();
              }
            }
          )
        )
      );

      console.log(`[bench] initializer mode=${mode} scenario=seed_prepare_warm`);
      rows.push(
        measurementToRow(
          "initializer_seed_prepare_warm",
          mode,
          await measureIterations(
            options.seedSyncRepeats,
            async () => {
              await initializer.initialize({
                name: `bench-${mode}-warm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                runtime: "workspace",
                executionPolicy: "local"
              });
            },
            {
              beforeEach() {
                sandboxServer.resetRequestCounts();
              },
              afterEach() {
                return sandboxServer.snapshotRequestCounts();
              }
            }
          )
        )
      );

      return rows;
    } finally {
      console.log(`[bench] closing initializer mode=${mode}`);
      await sandboxServer.close();
      await shutdownNativeWorkspaceSyncWorkerPool();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const binary = await resolveKnownGoodWorkspaceSyncBinary();
  if (!binary) {
    throw new Error("Failed to resolve a runnable native workspace sync binary for benchmarking.");
  }

  console.log(
    `Benchmarking workspace mainline paths files=${options.files} sizeBytes=${options.sizeBytes} iterations=${options.iterations} warmRepeats=${options.seedSyncRepeats}`
  );
  if (options.runtimeSourceDir) {
    console.log(
      `Benchmark runtime source=${options.runtimeSourceLabel ?? "custom"} path=${options.runtimeSourceDir}`
    );
  }
  console.log("Modes: ts fallback, oneshot native bridge, persistent native worker.");

  const rows = [
    ...(await runNativeModeBenchmarks(options, "oneshot", binary)),
    ...(await runNativeModeBenchmarks(options, "persistent", binary)),
    ...(await runInitializerBenchmarks(options, "ts", binary)),
    ...(await runInitializerBenchmarks(options, "oneshot", binary)),
    ...(await runInitializerBenchmarks(options, "persistent", binary))
  ];

  console.table(rows);
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
