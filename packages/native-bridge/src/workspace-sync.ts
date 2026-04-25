import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { resolveWorkspaceSyncBinary } from "./resolve-binary.js";

const NATIVE_PROTOCOL_VERSION = 1;
const DEFAULT_NATIVE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_NATIVE_WORKSPACE_SYNC_WORKER_COUNT = 1;

function readBooleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function parseJsonPayload<T>(payload: string, source: "stdout" | "stderr"): T {
  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new NativeWorkspaceSyncBridgeError(
      `Failed to parse ${source} JSON from native workspace sync binary: ${error instanceof Error ? error.message : String(error)}`,
      "native_invalid_json"
    );
  }
}

interface NativeCommandSuccessResponse {
  ok: true;
  protocolVersion: number;
  bridgeTimings?: NativeWorkspaceSyncBridgeTimings | undefined;
  workerTimings?: NativeWorkspaceSyncWorkerTimings | undefined;
}

interface NativeCommandFailureResponse {
  ok: false;
  protocolVersion?: number | undefined;
  code?: string | undefined;
  message?: string | undefined;
}

export interface NativeWorkspaceSyncVersionResult extends NativeCommandSuccessResponse {
  name: string;
  version: string;
}

export interface NativeDirectoryFingerprintInput {
  rootDir: string;
  excludeRelativePaths?: string[] | undefined;
}

export interface NativeDirectoryFingerprintResult extends NativeCommandSuccessResponse {
  fingerprint: string;
  fileCount: number;
  emptyDirectoryCount: number;
}

export interface NativeDirectoryFingerprintBatchEntry {
  rootDir: string;
  fingerprint: string;
  fileCount: number;
  emptyDirectoryCount: number;
}

export interface NativeDirectoryFingerprintBatchResult extends NativeCommandSuccessResponse {
  results: NativeDirectoryFingerprintBatchEntry[];
}

export interface NativeScannedFileEntry {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export interface NativeScanLocalTreeResult extends NativeCommandSuccessResponse {
  fingerprint: string;
  files: NativeScannedFileEntry[];
  directories: string[];
  emptyDirectories: string[];
}

export interface NativePlanRemoteEntry {
  relativePath: string;
  key: string;
  size: number;
  lastModifiedMs?: number | undefined;
  isDirectory: boolean;
}

export interface NativePlanUploadCandidate {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  remoteKey: string;
}

export interface NativePlanLocalToRemoteResult extends NativeCommandSuccessResponse {
  fingerprint: string;
  uploadCandidates: NativePlanUploadCandidate[];
  infoCheckCandidates: NativePlanUploadCandidate[];
  emptyDirectoriesToCreate: string[];
  keysToDelete: string[];
}

export interface NativePlanDownloadCandidate {
  relativePath: string;
  targetPath: string;
  size: number;
  remoteKey: string;
}

export interface NativePlanRemoteToLocalResult extends NativeCommandSuccessResponse {
  removePaths: string[];
  directoriesToCreate: string[];
  downloadCandidates: NativePlanDownloadCandidate[];
  infoCheckCandidates: NativePlanDownloadCandidate[];
}

export interface NativeSeedUploadFile {
  relativePath: string;
  absolutePath: string;
  remotePath: string;
  size: number;
  mtimeMs: number;
}

export interface NativePlanSeedUploadResult extends NativeCommandSuccessResponse {
  fingerprint: string;
  directories: string[];
  files: NativeSeedUploadFile[];
}

export interface NativeWorkspaceSyncObjectStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  accessKey?: string | undefined;
  secretKey?: string | undefined;
  sessionToken?: string | undefined;
}

export interface NativeSyncBundleConfig {
  mode?: "off" | "auto" | "force" | undefined;
  minFileCount?: number | undefined;
  minTotalBytes?: number | undefined;
  layout?: "sidecar" | "primary" | undefined;
  trustManagedPrefixes?: boolean | undefined;
}

export interface NativeSandboxHttpConfig {
  baseUrl: string;
  sandboxId: string;
  headers?: Record<string, string> | undefined;
}

export interface NativeObjectStoreRequestCounts {
  listRequests: number;
  getRequests: number;
  headRequests: number;
  putRequests: number;
  deleteRequests: number;
}

export interface NativeWorkspaceSyncBridgeTimings {
  mode: "persistent" | "oneshot";
  poolInitMs: number;
  queueWaitMs: number;
  writeMs: number;
  responseWaitMs: number;
  totalBridgeMs: number;
}

export interface NativeWorkspaceSyncWorkerTimings {
  receiveDelayMs: number;
  parseMs: number;
  handleMs: number;
  serializeMs: number;
  writeMs: number;
  totalWorkerMs: number;
}

export interface NativeSyncLocalToRemotePhaseTimings {
  scanMs: number;
  fingerprintMs: number;
  clientCreateMs: number;
  manifestReadMs: number;
  bundleBuildMs: number;
  bundleBodyPrepareMs: number;
  bundleUploadMs: number;
  bundleTransport: "none" | "memory" | "tempfile";
  bundleBytes: number;
  manifestWriteMs: number;
  deleteMs: number;
  totalPrimaryPathMs: number;
  totalCommandMs: number;
}

export interface NativeSyncLocalToRemoteResult extends NativeCommandSuccessResponse {
  localFingerprint: string;
  uploadedFileCount: number;
  deletedRemoteCount: number;
  createdEmptyDirectoryCount: number;
  requestCounts?: NativeObjectStoreRequestCounts | undefined;
  phaseTimings?: NativeSyncLocalToRemotePhaseTimings | undefined;
}

export interface NativeSyncRemoteToLocalResult extends NativeCommandSuccessResponse {
  localFingerprint: string;
  removedPathCount: number;
  createdDirectoryCount: number;
  downloadedFileCount: number;
  requestCounts?: NativeObjectStoreRequestCounts | undefined;
}

export interface NativeSyncLocalToSandboxHttpResult extends NativeCommandSuccessResponse {
  localFingerprint: string;
  createdDirectoryCount: number;
  uploadedFileCount: number;
}

export class NativeWorkspaceSyncBridgeError extends Error {
  readonly code: string;

  constructor(message: string, code = "native_workspace_sync_failed") {
    super(message);
    this.name = "NativeWorkspaceSyncBridgeError";
    this.code = code;
  }
}

interface NativeWorkspaceSyncWorkerRequest {
  requestId: string;
  command: string;
  payload?: Record<string, unknown>;
  sentAtMs?: number | undefined;
}

interface NativeWorkspaceSyncWorkerSuccessResponse extends NativeCommandSuccessResponse {
  requestId: string;
}

interface NativeWorkspaceSyncWorkerFailureResponse extends NativeCommandFailureResponse {
  requestId: string;
}

const nativeWorkspaceSyncStdinStreams = new WeakSet<object>();
type NativeWorkspaceSyncGlobalState = {
  workerPoolPromise?: Promise<NativeWorkspaceSyncWorkerPool> | undefined;
  requestSequence: number;
};

function getNativeWorkspaceSyncGlobalState(): NativeWorkspaceSyncGlobalState {
  const scope = globalThis as typeof globalThis & {
    __oahNativeWorkspaceSyncGlobalState?: NativeWorkspaceSyncGlobalState | undefined;
  };
  scope.__oahNativeWorkspaceSyncGlobalState ??= {
    workerPoolPromise: undefined,
    requestSequence: 0
  };
  return scope.__oahNativeWorkspaceSyncGlobalState;
}

const nativeWorkspaceSyncGlobalState = getNativeWorkspaceSyncGlobalState();

function resolveNativeWorkspaceSyncWorkerCount(): number {
  const explicit = process.env.OAH_NATIVE_WORKSPACE_SYNC_WORKERS?.trim();
  if (!explicit) {
    return DEFAULT_NATIVE_WORKSPACE_SYNC_WORKER_COUNT;
  }

  const parsed = Number.parseInt(explicit, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : DEFAULT_NATIVE_WORKSPACE_SYNC_WORKER_COUNT;
}

function isPersistentNativeWorkspaceSyncEnabled(): boolean {
  return readBooleanEnv("OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT");
}

function shouldUsePersistentNativeWorkspaceSyncCommand(command: string): boolean {
  return [
    "ready",
    "fingerprint",
    "fingerprint-batch",
    "scan-local-tree",
    "plan-local-to-remote",
    "plan-remote-to-local",
    "plan-seed-upload",
    "sync-local-to-remote",
    "sync-remote-to-local",
    "sync-local-to-sandbox-http"
  ].includes(command);
}

function getNativeWorkspaceSyncStdin(child: ReturnType<typeof spawn>) {
  const stdin = child.stdin;
  if (!stdin) {
    child.kill("SIGTERM");
    throw new NativeWorkspaceSyncBridgeError(
      "Native workspace sync stdin stream is unavailable.",
      "native_stdin_unavailable"
    );
  }
  if (!nativeWorkspaceSyncStdinStreams.has(stdin)) {
    stdin.on("error", () => {
      // Errors are surfaced through the write callback and worker close handling.
    });
    nativeWorkspaceSyncStdinStreams.add(stdin);
  }
  if (stdin.destroyed || stdin.writableEnded || !stdin.writable) {
    throw new NativeWorkspaceSyncBridgeError(
      "Native workspace sync stdin stream is not writable.",
      "native_stdin_unavailable"
    );
  }
  return stdin;
}

async function writeNativeWorkspaceSyncPayload(child: ReturnType<typeof spawn>, payload: string): Promise<void> {
  const stdin = getNativeWorkspaceSyncStdin(child);
  await new Promise<void>((resolve, reject) => {
    stdin.write(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

class NativeWorkspaceSyncWorker {
  readonly #child: ReturnType<typeof spawn>;
  readonly #pendingResponses = new Map<
    string,
    {
      resolve: (response: NativeWorkspaceSyncWorkerSuccessResponse) => void;
      reject: (error: Error) => void;
      timeoutHandle: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #queueStart = Promise.resolve();
  #queue = this.#queueStart;
  #stdoutBuffer = "";
  #stderrBuffer = "";
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(child: ReturnType<typeof spawn>, onTerminated?: (error: NativeWorkspaceSyncBridgeError) => void) {
    this.#child = child;

    if (!child.stdout || !child.stderr) {
      child.kill("SIGTERM");
      throw new NativeWorkspaceSyncBridgeError(
        "Native workspace sync worker stdio streams are unavailable.",
        "native_worker_stdio_unavailable"
      );
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#stdoutBuffer += chunk.toString();
      void this.#drainStdoutBuffer();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrBuffer = `${this.#stderrBuffer}${chunk.toString()}`.slice(-32_768);
    });
    child.on("error", (error) => {
      const workerError = new NativeWorkspaceSyncBridgeError(
        `Native workspace sync worker failed: ${error instanceof Error ? error.message : String(error)}`,
        "native_worker_failed"
      );
      onTerminated?.(workerError);
      this.#failAllPending(workerError);
    });
    child.on("close", (code) => {
      this.#closed = true;
      const workerError = new NativeWorkspaceSyncBridgeError(
        `Native workspace sync worker exited with code ${code ?? 0}.${this.#stderrBuffer ? ` ${this.#stderrBuffer.trim()}` : ""}`,
        "native_worker_exited"
      );
      onTerminated?.(workerError);
      this.#failAllPending(workerError);
    });
  }

  async runCommand<TResponse extends NativeCommandSuccessResponse>(
    command: string,
    payload?: Record<string, unknown>
  ): Promise<TResponse> {
    const queuedAt = performance.now();
    const run = async (): Promise<TResponse> => {
      const commandStartedAt = performance.now();
      const queueWaitMs = Math.max(0, Math.round(commandStartedAt - queuedAt));
      if (this.#closed) {
        throw new NativeWorkspaceSyncBridgeError("Native workspace sync worker is no longer available.", "native_worker_closed");
      }

      const requestId = `workspace-sync-${Date.now()}-${nativeWorkspaceSyncGlobalState.requestSequence += 1}`;
      const responsePromise = new Promise<NativeWorkspaceSyncWorkerSuccessResponse>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          this.#pendingResponses.delete(requestId);
          reject(
            new NativeWorkspaceSyncBridgeError(
              `Native workspace sync worker command ${command} timed out after ${DEFAULT_NATIVE_TIMEOUT_MS}ms.`,
              "native_command_timeout"
            )
          );
        }, DEFAULT_NATIVE_TIMEOUT_MS);
        this.#pendingResponses.set(requestId, {
          resolve,
          reject,
          timeoutHandle
        });
      });

      try {
        const request: NativeWorkspaceSyncWorkerRequest = {
          requestId,
          command,
          sentAtMs: Date.now(),
          ...(payload !== undefined ? { payload } : {})
        };
        const writeStartedAt = performance.now();
        await writeNativeWorkspaceSyncPayload(this.#child, `${JSON.stringify(request)}\n`);
        const writeMs = Math.max(0, Math.round(performance.now() - writeStartedAt));
        const responseWaitStartedAt = performance.now();
        const response = await responsePromise;
        const responseWaitMs = Math.max(0, Math.round(performance.now() - responseWaitStartedAt));
        return {
          ...(response as unknown as TResponse),
          bridgeTimings: {
            mode: "persistent",
            poolInitMs: 0,
            queueWaitMs,
            writeMs,
            responseWaitMs,
            totalBridgeMs: Math.max(0, Math.round(performance.now() - commandStartedAt))
          }
        };
      } catch (error) {
        const pending = this.#pendingResponses.get(requestId);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
        }
        this.#pendingResponses.delete(requestId);
        throw error;
      }
    };

    const resultPromise = this.#queue.then(run, run);
    this.#queue = resultPromise.then(
      () => undefined,
      () => undefined
    );
    return resultPromise;
  }

  async #drainStdoutBuffer(): Promise<void> {
    while (true) {
      const newlineIndex = this.#stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      const response = parseJsonPayload<NativeWorkspaceSyncWorkerSuccessResponse | NativeWorkspaceSyncWorkerFailureResponse>(
        line,
        "stdout"
      );
      const pending = this.#pendingResponses.get(response.requestId);
      if (!pending) {
        continue;
      }
      clearTimeout(pending.timeoutHandle);
      this.#pendingResponses.delete(response.requestId);

      if (response.ok) {
        pending.resolve(response);
        continue;
      }

      pending.reject(
        new NativeWorkspaceSyncBridgeError(
          response.message ?? `Native workspace sync worker request ${response.requestId} failed.`,
          response.code ?? "native_worker_request_failed"
        )
      );
    }
  }

  #failAllPending(error: Error): void {
    for (const pending of this.#pendingResponses.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
    }
    this.#pendingResponses.clear();
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    const waitForClose = new Promise<void>((resolve) => {
      const finish = () => resolve();
      this.#child.once("close", finish);
      this.#child.once("error", finish);
      setTimeout(finish, 500).unref();
    });

    if (this.#closed) {
      this.#closePromise = waitForClose;
      return this.#closePromise;
    }

    this.#closed = true;
    this.#child.kill("SIGTERM");
    this.#failAllPending(
      new NativeWorkspaceSyncBridgeError("Native workspace sync worker was closed.", "native_worker_closed")
    );
    this.#closePromise = waitForClose;
    return this.#closePromise;
  }
}

class NativeWorkspaceSyncWorkerPool {
  #nextWorkerIndex = 0;

  constructor(private readonly workers: NativeWorkspaceSyncWorker[]) {}

  async runCommand<TResponse extends NativeCommandSuccessResponse>(
    command: string,
    payload?: Record<string, unknown>
  ): Promise<TResponse> {
    const worker = this.workers[this.#nextWorkerIndex % this.workers.length];
    this.#nextWorkerIndex += 1;
    if (!worker) {
      throw new NativeWorkspaceSyncBridgeError("Native workspace sync worker pool is empty.", "native_worker_unavailable");
    }
    return worker.runCommand<TResponse>(command, payload);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}

async function getNativeWorkspaceSyncWorkerPool(): Promise<NativeWorkspaceSyncWorkerPool> {
  const binary = resolveWorkspaceSyncBinary();
  if (!binary) {
    throw new NativeWorkspaceSyncBridgeError(
      "Native workspace sync binary was not found. Set OAH_NATIVE_WORKSPACE_SYNC_BINARY or build native/oah-workspace-sync.",
      "native_binary_missing"
    );
  }

  nativeWorkspaceSyncGlobalState.workerPoolPromise ??= (async () => {
    const workers = Array.from({ length: resolveNativeWorkspaceSyncWorkerCount() }, () =>
      new NativeWorkspaceSyncWorker(
        spawn(binary, ["serve"], {
          stdio: ["pipe", "pipe", "pipe"]
        }),
        () => {
          nativeWorkspaceSyncGlobalState.workerPoolPromise = undefined;
        }
      )
    );
    try {
      await Promise.all(workers.map((worker) => worker.runCommand<NativeCommandSuccessResponse>("ready")));
      return new NativeWorkspaceSyncWorkerPool(workers);
    } catch (error) {
      await Promise.all(workers.map((worker) => worker.close().catch(() => undefined)));
      throw error;
    }
  })();
  return nativeWorkspaceSyncGlobalState.workerPoolPromise;
}

export async function shutdownNativeWorkspaceSyncWorkerPool(): Promise<void> {
  const workerPool = await nativeWorkspaceSyncGlobalState.workerPoolPromise?.catch(() => undefined);
  nativeWorkspaceSyncGlobalState.workerPoolPromise = undefined;
  await workerPool?.close();
}

export async function ensureNativeWorkspaceSyncWorkerPoolReady(): Promise<void> {
  if (!isNativeWorkspaceSyncEnabled() || !isPersistentNativeWorkspaceSyncEnabled()) {
    return;
  }

  await getNativeWorkspaceSyncWorkerPool();
}

async function runNativeWorkspaceSyncCommandOnce<TResponse extends NativeCommandSuccessResponse>(
  args: string[],
  payload?: Record<string, unknown>
): Promise<TResponse> {
  const commandStartedAt = performance.now();
  const binary = resolveWorkspaceSyncBinary();
  if (!binary) {
    throw new NativeWorkspaceSyncBridgeError(
      "Native workspace sync binary was not found. Set OAH_NATIVE_WORKSPACE_SYNC_BINARY or build native/oah-workspace-sync.",
      "native_binary_missing"
    );
  }

  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timeoutTriggered = false;

  const timeoutHandle = setTimeout(() => {
    timeoutTriggered = true;
    child.kill("SIGTERM");
  }, DEFAULT_NATIVE_TIMEOUT_MS);

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  let writeMs = 0;
  if (payload !== undefined) {
    const writeStartedAt = performance.now();
    child.stdin.write(JSON.stringify(payload));
    writeMs = Math.max(0, Math.round(performance.now() - writeStartedAt));
  }
  child.stdin.end();

  const responseWaitStartedAt = performance.now();
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  }).finally(() => {
    clearTimeout(timeoutHandle);
  });

  if (timeoutTriggered) {
    throw new NativeWorkspaceSyncBridgeError(
      `Native workspace sync command timed out after ${DEFAULT_NATIVE_TIMEOUT_MS}ms.`,
      "native_command_timeout"
    );
  }

  if (exitCode !== 0) {
    const trimmedStderr = stderr.trim();
    const failure = trimmedStderr ? parseJsonPayload<NativeCommandFailureResponse>(trimmedStderr, "stderr") : undefined;
    throw new NativeWorkspaceSyncBridgeError(
      failure?.message ?? `Native workspace sync command failed with exit code ${exitCode}.`,
      failure?.code ?? "native_command_failed"
    );
  }

  const response = parseJsonPayload<TResponse>(stdout.trim(), "stdout");
  if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new NativeWorkspaceSyncBridgeError(
      `Native workspace sync protocol mismatch. Expected ${NATIVE_PROTOCOL_VERSION}, received ${response.protocolVersion}.`,
      "native_protocol_mismatch"
    );
  }

  return {
    ...response,
    bridgeTimings: {
      mode: "oneshot",
      poolInitMs: 0,
      queueWaitMs: 0,
      writeMs,
      responseWaitMs: Math.max(0, Math.round(performance.now() - responseWaitStartedAt)),
      totalBridgeMs: Math.max(0, Math.round(performance.now() - commandStartedAt))
    }
  };
}

async function runNativeWorkspaceSyncCommand<TResponse extends NativeCommandSuccessResponse>(
  args: string[],
  payload?: Record<string, unknown>
): Promise<TResponse> {
  if (isPersistentNativeWorkspaceSyncEnabled() && args.length === 1 && shouldUsePersistentNativeWorkspaceSyncCommand(args[0]!)) {
    try {
      const poolInitStartedAt = performance.now();
      const workerPool = await getNativeWorkspaceSyncWorkerPool();
      const poolInitMs = Math.max(0, Math.round(performance.now() - poolInitStartedAt));
      const response = await workerPool.runCommand<TResponse>(args[0]!, payload);
      return {
        ...response,
        bridgeTimings: {
          mode: "persistent",
          poolInitMs,
          queueWaitMs: response.bridgeTimings?.queueWaitMs ?? 0,
          writeMs: response.bridgeTimings?.writeMs ?? 0,
          responseWaitMs: response.bridgeTimings?.responseWaitMs ?? 0,
          totalBridgeMs: poolInitMs + (response.bridgeTimings?.totalBridgeMs ?? 0)
        }
      };
    } catch (error) {
      console.warn(
        `[oah-native] Falling back to one-shot native workspace sync for ${args.join(" ")}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return runNativeWorkspaceSyncCommandOnce<TResponse>(args, payload);
}

export function isNativeWorkspaceSyncEnabled(): boolean {
  return readBooleanEnv("OAH_NATIVE_WORKSPACE_SYNC");
}

export async function runWorkspaceSyncVersion(): Promise<NativeWorkspaceSyncVersionResult> {
  return runNativeWorkspaceSyncCommand<NativeWorkspaceSyncVersionResult>(["version"]);
}

export async function computeNativeDirectoryFingerprint(
  input: NativeDirectoryFingerprintInput
): Promise<NativeDirectoryFingerprintResult> {
  return runNativeWorkspaceSyncCommand<NativeDirectoryFingerprintResult>(["fingerprint"], {
    rootDir: input.rootDir,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {})
  });
}

export async function computeNativeDirectoryFingerprintBatch(input: {
  directories: NativeDirectoryFingerprintInput[];
}): Promise<NativeDirectoryFingerprintBatchResult> {
  return runNativeWorkspaceSyncCommand<NativeDirectoryFingerprintBatchResult>(["fingerprint-batch"], {
    directories: input.directories.map((directory) => ({
      rootDir: directory.rootDir,
      ...(directory.excludeRelativePaths ? { excludeRelativePaths: directory.excludeRelativePaths } : {})
    }))
  });
}

export async function scanNativeLocalTree(input: NativeDirectoryFingerprintInput): Promise<NativeScanLocalTreeResult> {
  return runNativeWorkspaceSyncCommand<NativeScanLocalTreeResult>(["scan-local-tree"], {
    rootDir: input.rootDir,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {})
  });
}

export async function planNativeLocalToRemote(input: {
  rootDir: string;
  excludeRelativePaths?: string[] | undefined;
  remoteEntries: NativePlanRemoteEntry[];
}): Promise<NativePlanLocalToRemoteResult> {
  return runNativeWorkspaceSyncCommand<NativePlanLocalToRemoteResult>(["plan-local-to-remote"], {
    rootDir: input.rootDir,
    remoteEntries: input.remoteEntries,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {})
  });
}

export async function planNativeRemoteToLocal(input: {
  rootDir: string;
  excludeRelativePaths?: string[] | undefined;
  preserveTopLevelNames?: string[] | undefined;
  remoteEntries: NativePlanRemoteEntry[];
}): Promise<NativePlanRemoteToLocalResult> {
  return runNativeWorkspaceSyncCommand<NativePlanRemoteToLocalResult>(["plan-remote-to-local"], {
    rootDir: input.rootDir,
    remoteEntries: input.remoteEntries,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {}),
    ...(input.preserveTopLevelNames ? { preserveTopLevelNames: input.preserveTopLevelNames } : {})
  });
}

export async function planNativeSeedUpload(input: {
  rootDir: string;
  remoteBasePath: string;
  excludeRelativePaths?: string[] | undefined;
}): Promise<NativePlanSeedUploadResult> {
  return runNativeWorkspaceSyncCommand<NativePlanSeedUploadResult>(["plan-seed-upload"], {
    rootDir: input.rootDir,
    remoteBasePath: input.remoteBasePath,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {})
  });
}

export async function syncNativeLocalToRemote(input: {
  rootDir: string;
  remotePrefix: string;
  excludeRelativePaths?: string[] | undefined;
  maxConcurrency?: number | undefined;
  inlineUploadThresholdBytes?: number | undefined;
  syncBundle?: NativeSyncBundleConfig | undefined;
  objectStore: NativeWorkspaceSyncObjectStoreConfig;
}): Promise<NativeSyncLocalToRemoteResult> {
  return runNativeWorkspaceSyncCommand<NativeSyncLocalToRemoteResult>(["sync-local-to-remote"], {
    rootDir: input.rootDir,
    remotePrefix: input.remotePrefix,
    objectStore: input.objectStore,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {}),
    ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
    ...(input.inlineUploadThresholdBytes ? { inlineUploadThresholdBytes: input.inlineUploadThresholdBytes } : {}),
    ...(input.syncBundle ? { syncBundle: input.syncBundle } : {})
  });
}

export async function syncNativeRemoteToLocal(input: {
  rootDir: string;
  remotePrefix: string;
  excludeRelativePaths?: string[] | undefined;
  preserveTopLevelNames?: string[] | undefined;
  maxConcurrency?: number | undefined;
  remoteEntries?: NativePlanRemoteEntry[] | undefined;
  hasSyncManifest?: boolean | undefined;
  bundleEntry?: NativePlanRemoteEntry | undefined;
  syncBundle?: NativeSyncBundleConfig | undefined;
  objectStore: NativeWorkspaceSyncObjectStoreConfig;
}): Promise<NativeSyncRemoteToLocalResult> {
  return runNativeWorkspaceSyncCommand<NativeSyncRemoteToLocalResult>(["sync-remote-to-local"], {
    rootDir: input.rootDir,
    remotePrefix: input.remotePrefix,
    objectStore: input.objectStore,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {}),
    ...(input.preserveTopLevelNames ? { preserveTopLevelNames: input.preserveTopLevelNames } : {}),
    ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
    ...(input.remoteEntries ? { remoteEntries: input.remoteEntries } : {}),
    ...(typeof input.hasSyncManifest === "boolean" ? { hasSyncManifest: input.hasSyncManifest } : {}),
    ...(input.bundleEntry ? { bundleEntry: input.bundleEntry } : {}),
    ...(input.syncBundle ? { syncBundle: input.syncBundle } : {})
  });
}

export async function syncNativeLocalToSandboxHttp(input: {
  rootDir: string;
  remoteRootPath: string;
  excludeRelativePaths?: string[] | undefined;
  maxConcurrency?: number | undefined;
  sandbox: NativeSandboxHttpConfig;
}): Promise<NativeSyncLocalToSandboxHttpResult> {
  return runNativeWorkspaceSyncCommand<NativeSyncLocalToSandboxHttpResult>(["sync-local-to-sandbox-http"], {
    rootDir: input.rootDir,
    remoteRootPath: input.remoteRootPath,
    sandbox: input.sandbox,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {}),
    ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {})
  });
}

export { resolveWorkspaceSyncBinary };
