import { spawn } from "node:child_process";

import { resolveWorkspaceSyncBinary } from "./resolve-binary.js";

const NATIVE_PROTOCOL_VERSION = 1;
const DEFAULT_NATIVE_TIMEOUT_MS = 5 * 60 * 1000;

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

export interface NativeSandboxHttpConfig {
  baseUrl: string;
  sandboxId: string;
  headers?: Record<string, string> | undefined;
}

export interface NativeSyncLocalToRemoteResult extends NativeCommandSuccessResponse {
  localFingerprint: string;
  uploadedFileCount: number;
  deletedRemoteCount: number;
  createdEmptyDirectoryCount: number;
}

export interface NativeSyncRemoteToLocalResult extends NativeCommandSuccessResponse {
  removedPathCount: number;
  createdDirectoryCount: number;
  downloadedFileCount: number;
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

async function runNativeWorkspaceSyncCommand<TResponse extends NativeCommandSuccessResponse>(
  args: string[],
  payload?: Record<string, unknown>
): Promise<TResponse> {
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

  if (payload !== undefined) {
    child.stdin.write(JSON.stringify(payload));
  }
  child.stdin.end();

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

  return response;
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
  objectStore: NativeWorkspaceSyncObjectStoreConfig;
}): Promise<NativeSyncLocalToRemoteResult> {
  return runNativeWorkspaceSyncCommand<NativeSyncLocalToRemoteResult>(["sync-local-to-remote"], {
    rootDir: input.rootDir,
    remotePrefix: input.remotePrefix,
    objectStore: input.objectStore,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {}),
    ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {})
  });
}

export async function syncNativeRemoteToLocal(input: {
  rootDir: string;
  remotePrefix: string;
  excludeRelativePaths?: string[] | undefined;
  preserveTopLevelNames?: string[] | undefined;
  maxConcurrency?: number | undefined;
  objectStore: NativeWorkspaceSyncObjectStoreConfig;
}): Promise<NativeSyncRemoteToLocalResult> {
  return runNativeWorkspaceSyncCommand<NativeSyncRemoteToLocalResult>(["sync-remote-to-local"], {
    rootDir: input.rootDir,
    remotePrefix: input.remotePrefix,
    objectStore: input.objectStore,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {}),
    ...(input.preserveTopLevelNames ? { preserveTopLevelNames: input.preserveTopLevelNames } : {}),
    ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {})
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
