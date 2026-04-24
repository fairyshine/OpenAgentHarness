import type { WorkspaceArchiveRecord } from "@oah/engine-core";

import { spawn } from "node:child_process";
import path from "node:path";

const NATIVE_PROTOCOL_VERSION = 1;
const DEFAULT_NATIVE_TIMEOUT_MS = 5 * 60 * 1000;
const ARCHIVE_EXPORT_BINARY_BASENAME = process.platform === "win32" ? "oah-archive-export.exe" : "oah-archive-export";

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

export interface NativeArchiveDirectoryInspection extends NativeCommandSuccessResponse {
  unexpectedDirectories: string[];
  leftoverTempFiles: string[];
  unexpectedFiles: string[];
  missingChecksums: string[];
  orphanChecksums: string[];
}

export interface NativeArchiveChecksumResult extends NativeCommandSuccessResponse {
  filePath: string;
  outputPath: string;
  checksum: string;
}

export interface NativeArchiveBundleResult extends NativeCommandSuccessResponse {
  outputPath: string;
  archiveDate: string;
  archiveCount: number;
}

export class NativeArchiveExportError extends Error {
  readonly code: string;

  constructor(message: string, code = "native_archive_export_failed") {
    super(message);
    this.name = "NativeArchiveExportError";
    this.code = code;
  }
}

function readBooleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function parseJsonPayload<T>(payload: string, source: "stdout" | "stderr"): T {
  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new NativeArchiveExportError(
      `Failed to parse ${source} JSON from native archive export binary: ${error instanceof Error ? error.message : String(error)}`,
      "native_archive_invalid_json"
    );
  }
}

export function isNativeArchiveExportEnabled(): boolean {
  return readBooleanEnv("OAH_NATIVE_ARCHIVE_EXPORT");
}

export function resolveArchiveExportBinary(): string | undefined {
  const explicit = process.env.OAH_NATIVE_ARCHIVE_EXPORT_BINARY?.trim();
  if (explicit) {
    return explicit;
  }

  return path.resolve(process.cwd(), "native", "bin", ARCHIVE_EXPORT_BINARY_BASENAME);
}

async function runNativeArchiveExportCommand<TResponse extends NativeCommandSuccessResponse>(
  args: string[],
  payload?: Record<string, unknown>
): Promise<TResponse> {
  const binary = resolveArchiveExportBinary();
  if (!binary) {
    throw new NativeArchiveExportError(
      "Native archive export binary was not found. Set OAH_NATIVE_ARCHIVE_EXPORT_BINARY or build native/oah-archive-export.",
      "native_archive_binary_missing"
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
    throw new NativeArchiveExportError(
      `Native archive export command timed out after ${DEFAULT_NATIVE_TIMEOUT_MS}ms.`,
      "native_archive_command_timeout"
    );
  }

  if (exitCode !== 0) {
    const trimmedStderr = stderr.trim();
    const failure = trimmedStderr ? parseJsonPayload<NativeCommandFailureResponse>(trimmedStderr, "stderr") : undefined;
    throw new NativeArchiveExportError(
      failure?.message ?? `Native archive export command failed with exit code ${exitCode}.`,
      failure?.code ?? "native_archive_command_failed"
    );
  }

  const response = parseJsonPayload<TResponse>(stdout.trim(), "stdout");
  if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new NativeArchiveExportError(
      `Native archive export protocol mismatch. Expected ${NATIVE_PROTOCOL_VERSION}, received ${response.protocolVersion}.`,
      "native_archive_protocol_mismatch"
    );
  }

  return response;
}

export async function inspectNativeArchiveExportDirectory(input: {
  exportRoot: string;
}): Promise<NativeArchiveDirectoryInspection> {
  return runNativeArchiveExportCommand<NativeArchiveDirectoryInspection>(["inspect-export-root"], {
    exportRoot: input.exportRoot
  });
}

export async function writeNativeArchiveChecksum(input: {
  filePath: string;
  outputPath?: string | undefined;
}): Promise<NativeArchiveChecksumResult> {
  return runNativeArchiveExportCommand<NativeArchiveChecksumResult>(["write-checksum"], {
    filePath: input.filePath,
    ...(input.outputPath ? { outputPath: input.outputPath } : {})
  });
}

export async function writeNativeArchiveBundle(input: {
  outputPath: string;
  archiveDate: string;
  exportPath: string;
  exportedAt: string;
  archives: WorkspaceArchiveRecord[];
}): Promise<NativeArchiveBundleResult> {
  return runNativeArchiveExportCommand<NativeArchiveBundleResult>(["write-bundle"], {
    outputPath: input.outputPath,
    archiveDate: input.archiveDate,
    exportPath: input.exportPath,
    exportedAt: input.exportedAt,
    archives: input.archives
  });
}
