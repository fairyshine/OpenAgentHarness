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
  directoriesToCreate: string[];
  downloadCandidates: NativePlanDownloadCandidate[];
  infoCheckCandidates: NativePlanDownloadCandidate[];
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
  remoteEntries: NativePlanRemoteEntry[];
}): Promise<NativePlanRemoteToLocalResult> {
  return runNativeWorkspaceSyncCommand<NativePlanRemoteToLocalResult>(["plan-remote-to-local"], {
    rootDir: input.rootDir,
    remoteEntries: input.remoteEntries,
    ...(input.excludeRelativePaths ? { excludeRelativePaths: input.excludeRelativePaths } : {})
  });
}

export { resolveWorkspaceSyncBinary };
