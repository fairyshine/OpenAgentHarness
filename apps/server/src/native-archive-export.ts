import type { WorkspaceArchiveRecord } from "@oah/engine-core";

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";

const NATIVE_PROTOCOL_VERSION = 1;
const DEFAULT_NATIVE_TIMEOUT_MS = 5 * 60 * 1000;
const ARCHIVE_EXPORT_BINARY_BASENAME = process.platform === "win32" ? "oah-archive-export.exe" : "oah-archive-export";
const ARCHIVE_STREAM_FLUSH_BYTES = 128 * 1024;
const DEFAULT_NATIVE_ARCHIVE_EXPORT_WORKER_COUNT = 1;

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

type ArchiveStreamRecord =
  | {
      type: "header";
      outputPath: string;
      archiveDate: string;
      exportPath: string;
      exportedAt: string;
    }
  | {
      type: "archive";
      archive: Pick<
        WorkspaceArchiveRecord,
        "id" | "workspaceId" | "scopeType" | "scopeId" | "archiveDate" | "archivedAt" | "deletedAt" | "timezone" | "workspace"
      >;
    }
  | {
      type: "session" | "run" | "message" | "engine_message" | "run_step" | "tool_call" | "hook_run" | "artifact";
      archiveId: string;
      row: Record<string, unknown>;
    };

type NativeArchiveWorkerStreamRecord =
  | {
      type: "request_start";
      requestId: string;
      outputPath: string;
      archiveDate: string;
      exportPath: string;
      exportedAt: string;
    }
  | {
      type: "request_end";
      requestId: string;
    }
  | ArchiveStreamRecord;

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

export interface NativeArchiveBundleWriteResult extends NativeArchiveBundleResult {
  archiveIds: string[];
}

interface NativeArchiveBundleWriter {
  writeArchive(archive: WorkspaceArchiveRecord): Promise<void>;
}

interface NativeArchiveWorkerSuccessResponse extends NativeCommandSuccessResponse {
  requestId: string;
  outputPath: string;
  archiveDate: string;
  archiveCount: number;
}

interface NativeArchiveWorkerFailureResponse extends NativeCommandFailureResponse {
  requestId: string;
  outputPath?: string | undefined;
  archiveDate?: string | undefined;
  archiveCount?: number | undefined;
}

type NativeArchiveBundleInput =
  | {
      outputPath: string;
      archiveDate: string;
      exportPath: string;
      exportedAt: string;
      archives: WorkspaceArchiveRecord[];
    }
  | {
      outputPath: string;
      archiveDate: string;
      exportPath: string;
      exportedAt: string;
      produceArchives: (writer: NativeArchiveBundleWriter) => Promise<string[]>;
    };

export class NativeArchiveExportError extends Error {
  readonly code: string;

  constructor(message: string, code = "native_archive_export_failed") {
    super(message);
    this.name = "NativeArchiveExportError";
    this.code = code;
  }
}

let nativeArchiveWorkerPoolPromise: Promise<NativeArchiveExportWorkerPool> | undefined;
let nativeArchiveWorkerRequestSequence = 0;
const nativeArchiveExportStdinStreams = new WeakSet<object>();

type NativeArchiveExportMode = "off" | "auto" | "force";

function resolveNativeArchiveExportMode(): NativeArchiveExportMode {
  const value = process.env.OAH_NATIVE_ARCHIVE_EXPORT?.trim().toLowerCase();
  if (value === "auto") {
    return "auto";
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return "force";
  }
  return "off";
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
  return resolveNativeArchiveExportMode() !== "off";
}

export function shouldPreferNativeArchiveExportBundle(pendingArchiveDateCount: number): boolean {
  const mode = resolveNativeArchiveExportMode();
  if (mode === "force") {
    return true;
  }
  if (mode === "auto") {
    return pendingArchiveDateCount > 1;
  }
  return false;
}

export function resolveDefaultNativeArchiveExportWorkerCount(): number {
  const explicit = process.env.OAH_NATIVE_ARCHIVE_EXPORT_WORKERS?.trim();
  if (explicit) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, parsed);
    }
  }

  if (!isNativeArchiveExportEnabled()) {
    return DEFAULT_NATIVE_ARCHIVE_EXPORT_WORKER_COUNT;
  }

  return Math.max(
    1,
    Math.min(4, typeof availableParallelism === "function" ? availableParallelism() : DEFAULT_NATIVE_ARCHIVE_EXPORT_WORKER_COUNT)
  );
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

  const stdin = child.stdin;
  if (!stdin) {
    child.kill("SIGTERM");
    throw new NativeArchiveExportError("Native archive export stdin stream is unavailable.", "native_archive_stdin_unavailable");
  }

  if (payload !== undefined) {
    stdin.write(JSON.stringify(payload));
  }
  stdin.end();

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

function waitForNativeArchiveExportExit(input: {
  child: ReturnType<typeof spawn>;
  stdoutRef: { value: string };
  stderrRef: { value: string };
  timeoutHandle: ReturnType<typeof setTimeout>;
  timeoutTriggeredRef: { value: boolean };
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    input.child.on("error", reject);
    input.child.on("close", (code) => resolve(code ?? 0));
  }).finally(() => {
    clearTimeout(input.timeoutHandle);
  });
}

function getNativeArchiveExportStdin(child: ReturnType<typeof spawn>) {
  const stdin = child.stdin;
  if (!stdin) {
    child.kill("SIGTERM");
    throw new NativeArchiveExportError("Native archive export stdin stream is unavailable.", "native_archive_stdin_unavailable");
  }
  if (!nativeArchiveExportStdinStreams.has(stdin)) {
    stdin.on("error", () => {
      // Errors are surfaced through the write callback and worker close handling.
    });
    nativeArchiveExportStdinStreams.add(stdin);
  }
  if (stdin.destroyed || stdin.writableEnded || !stdin.writable) {
    throw new NativeArchiveExportError("Native archive export stdin stream is not writable.", "native_archive_stdin_unavailable");
  }

  return stdin;
}

async function writeNativeArchiveExportPayload(child: ReturnType<typeof spawn>, payload: string): Promise<void> {
  const stdin = getNativeArchiveExportStdin(child);

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

class NativeArchiveExportStreamWriter {
  #buffer = "";

  constructor(private readonly child: ReturnType<typeof spawn>) {}

  async writeRecord(record: NativeArchiveWorkerStreamRecord): Promise<void> {
    this.#buffer += `${JSON.stringify(record)}\n`;
    if (this.#buffer.length >= ARCHIVE_STREAM_FLUSH_BYTES) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#buffer.length === 0) {
      return;
    }

    const payload = this.#buffer;
    this.#buffer = "";
    await writeNativeArchiveExportPayload(this.child, payload);
  }

  async end(): Promise<void> {
    await this.flush();
    getNativeArchiveExportStdin(this.child).end();
  }
}

class NativeArchiveExportWorker {
  readonly #child: ReturnType<typeof spawn>;
  readonly #streamWriter: NativeArchiveExportStreamWriter;
  readonly #pendingResponses = new Map<
    string,
    {
      resolve: (response: NativeArchiveWorkerSuccessResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly #queueStart = Promise.resolve();
  #queue = this.#queueStart;
  #stdoutBuffer = "";
  #stderrBuffer = "";
  #closed = false;

  constructor(
    child: ReturnType<typeof spawn>,
    onTerminated?: (error: NativeArchiveExportError) => void
  ) {
    this.#child = child;
    this.#streamWriter = new NativeArchiveExportStreamWriter(child);

    if (!child.stdout || !child.stderr) {
      child.kill("SIGTERM");
      throw new NativeArchiveExportError(
        "Native archive export worker stdio streams are unavailable.",
        "native_archive_worker_stdio_unavailable"
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
      const workerError = new NativeArchiveExportError(
        `Native archive export worker failed: ${error instanceof Error ? error.message : String(error)}`,
        "native_archive_worker_failed"
      );
      onTerminated?.(workerError);
      this.#failAllPending(workerError);
    });
    child.on("close", (code) => {
      this.#closed = true;
      const workerError = new NativeArchiveExportError(
        `Native archive export worker exited with code ${code ?? 0}.${this.#stderrBuffer ? ` ${this.#stderrBuffer.trim()}` : ""}`,
        "native_archive_worker_exited"
      );
      onTerminated?.(workerError);
      this.#failAllPending(workerError);
    });
  }

  async writeBundle(input: NativeArchiveBundleInput): Promise<NativeArchiveBundleWriteResult> {
    const run = async (): Promise<NativeArchiveBundleWriteResult> => {
      if (this.#closed) {
        throw new NativeArchiveExportError("Native archive export worker is no longer available.", "native_archive_worker_closed");
      }

      const requestId = `archive-${Date.now()}-${nativeArchiveWorkerRequestSequence += 1}`;
      const responsePromise = new Promise<NativeArchiveWorkerSuccessResponse>((resolve, reject) => {
        this.#pendingResponses.set(requestId, { resolve, reject });
      });

      try {
        await this.#streamWriter.writeRecord({
          type: "request_start",
          requestId,
          outputPath: input.outputPath,
          archiveDate: input.archiveDate,
          exportPath: input.exportPath,
          exportedAt: input.exportedAt
        });

        let archiveIds: string[] = [];
        if ("archives" in input) {
          archiveIds = input.archives.map((archive) => archive.id);
          for (const archive of input.archives) {
            await writeArchiveToNativeStream(this.#streamWriter, archive);
          }
        } else {
          archiveIds = await input.produceArchives({
            writeArchive: async (archive) => {
              await writeArchiveToNativeStream(this.#streamWriter, archive);
            }
          });
        }

        await this.#streamWriter.writeRecord({
          type: "request_end",
          requestId
        });
        await this.#streamWriter.flush();

        const response = await responsePromise;
        return {
          ...response,
          archiveIds
        };
      } catch (error) {
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

      const response = parseJsonPayload<NativeArchiveWorkerSuccessResponse | NativeArchiveWorkerFailureResponse>(line, "stdout");
      const pending = this.#pendingResponses.get(response.requestId);
      if (!pending) {
        continue;
      }
      this.#pendingResponses.delete(response.requestId);

      if (response.ok) {
        pending.resolve(response);
        continue;
      }

      pending.reject(
        new NativeArchiveExportError(
          response.message ?? `Native archive export worker request ${response.requestId} failed.`,
          response.code ?? "native_archive_worker_request_failed"
        )
      );
    }
  }

  #failAllPending(error: Error): void {
    for (const pending of this.#pendingResponses.values()) {
      pending.reject(error);
    }
    this.#pendingResponses.clear();
  }
}

class NativeArchiveExportWorkerPool {
  #nextWorkerIndex = 0;

  constructor(private readonly workers: NativeArchiveExportWorker[]) {}

  async writeBundle(input: NativeArchiveBundleInput): Promise<NativeArchiveBundleWriteResult> {
    const worker = this.workers[this.#nextWorkerIndex % this.workers.length];
    this.#nextWorkerIndex += 1;
    if (!worker) {
      throw new NativeArchiveExportError("Native archive export worker pool is empty.", "native_archive_worker_unavailable");
    }
    return worker.writeBundle(input);
  }
}

function toArchiveStreamRow<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

async function writeArchiveToNativeStream(writer: NativeArchiveExportStreamWriter, archive: WorkspaceArchiveRecord): Promise<void> {
  await writer.writeRecord({
    type: "archive",
    archive: {
      id: archive.id,
      workspaceId: archive.workspaceId,
      scopeType: archive.scopeType,
      scopeId: archive.scopeId,
      archiveDate: archive.archiveDate,
      archivedAt: archive.archivedAt,
      deletedAt: archive.deletedAt,
      timezone: archive.timezone,
      workspace: archive.workspace
    }
  });

  for (const row of archive.sessions) {
    await writer.writeRecord({
      type: "session",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
  for (const row of archive.runs) {
    await writer.writeRecord({
      type: "run",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
  for (const row of archive.messages) {
    await writer.writeRecord({
      type: "message",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
  for (const row of archive.engineMessages) {
    await writer.writeRecord({
      type: "engine_message",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
  for (const row of archive.runSteps) {
    await writer.writeRecord({
      type: "run_step",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
  for (const row of archive.toolCalls) {
    await writer.writeRecord({
      type: "tool_call",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
  for (const row of archive.hookRuns) {
    await writer.writeRecord({
      type: "hook_run",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
  for (const row of archive.artifacts) {
    await writer.writeRecord({
      type: "artifact",
      archiveId: archive.id,
      row: toArchiveStreamRow(row)
    });
  }
}

async function getNativeArchiveExportWorkerPool(): Promise<NativeArchiveExportWorkerPool> {
  const binary = resolveArchiveExportBinary();
  if (!binary) {
    throw new NativeArchiveExportError(
      "Native archive export binary was not found. Set OAH_NATIVE_ARCHIVE_EXPORT_BINARY or build native/oah-archive-export.",
      "native_archive_binary_missing"
    );
  }

  nativeArchiveWorkerPoolPromise ??= Promise.resolve(
    new NativeArchiveExportWorkerPool(
      Array.from({ length: resolveDefaultNativeArchiveExportWorkerCount() }, () =>
        new NativeArchiveExportWorker(
          spawn(binary, ["serve-write-bundle-stream"], {
            stdio: ["pipe", "pipe", "pipe"]
          }),
          () => {
            nativeArchiveWorkerPoolPromise = undefined;
          }
        )
      )
    )
  );
  return nativeArchiveWorkerPoolPromise;
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

async function writeNativeArchiveBundleOnce(input: NativeArchiveBundleInput): Promise<NativeArchiveBundleWriteResult> {
  const binary = resolveArchiveExportBinary();
  if (!binary) {
    throw new NativeArchiveExportError(
      "Native archive export binary was not found. Set OAH_NATIVE_ARCHIVE_EXPORT_BINARY or build native/oah-archive-export.",
      "native_archive_binary_missing"
    );
  }

  const child = spawn(binary, ["write-bundle-stream"], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdoutRef = { value: "" };
  const stderrRef = { value: "" };
  const timeoutTriggeredRef = { value: false };
  const timeoutHandle = setTimeout(() => {
    timeoutTriggeredRef.value = true;
    child.kill("SIGTERM");
  }, DEFAULT_NATIVE_TIMEOUT_MS);

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutRef.value += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrRef.value += chunk.toString();
  });
  const streamWriter = new NativeArchiveExportStreamWriter(child);

  let archiveIds: string[] = [];

  try {
    await streamWriter.writeRecord({
      type: "header",
      outputPath: input.outputPath,
      archiveDate: input.archiveDate,
      exportPath: input.exportPath,
      exportedAt: input.exportedAt
    });

    if ("archives" in input) {
      archiveIds = input.archives.map((archive) => archive.id);
      for (const archive of input.archives) {
        await writeArchiveToNativeStream(streamWriter, archive);
      }
    } else {
      archiveIds = await input.produceArchives({
        writeArchive: async (archive) => {
          await writeArchiveToNativeStream(streamWriter, archive);
        }
      });
    }

    await streamWriter.end();
  } catch (error) {
    child.stdin?.destroy(error instanceof Error ? error : undefined);
    child.kill("SIGTERM");
    throw error;
  }

  const exitCode = await waitForNativeArchiveExportExit({
    child,
    stdoutRef,
    stderrRef,
    timeoutHandle,
    timeoutTriggeredRef
  });

  if (timeoutTriggeredRef.value) {
    throw new NativeArchiveExportError(
      `Native archive export command timed out after ${DEFAULT_NATIVE_TIMEOUT_MS}ms.`,
      "native_archive_command_timeout"
    );
  }

  if (exitCode !== 0) {
    const trimmedStderr = stderrRef.value.trim();
    const failure = trimmedStderr ? parseJsonPayload<NativeCommandFailureResponse>(trimmedStderr, "stderr") : undefined;
    throw new NativeArchiveExportError(
      failure?.message ?? `Native archive export command failed with exit code ${exitCode}.`,
      failure?.code ?? "native_archive_command_failed"
    );
  }

  const response = parseJsonPayload<NativeArchiveBundleResult>(stdoutRef.value.trim(), "stdout");
  if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new NativeArchiveExportError(
      `Native archive export protocol mismatch. Expected ${NATIVE_PROTOCOL_VERSION}, received ${response.protocolVersion}.`,
      "native_archive_protocol_mismatch"
    );
  }

  return {
    ...response,
    archiveIds
  };
}

export async function writeNativeArchiveBundle(input: NativeArchiveBundleInput): Promise<NativeArchiveBundleWriteResult> {
  try {
    const workerPool = await getNativeArchiveExportWorkerPool();
    return await workerPool.writeBundle(input);
  } catch (error) {
    console.warn(
      `[oah-native] Falling back to one-shot native archive export for ${input.archiveDate}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return writeNativeArchiveBundleOnce(input);
  }
}
