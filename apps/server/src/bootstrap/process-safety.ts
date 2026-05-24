import { EventEmitter } from "node:events";

import { hasErrorCode } from "./error-codes.js";

let installed = false;
let eventEmitterPatchInstalled = false;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

function errorStatusCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}

function isRecoverableNotFoundRace(error: unknown): boolean {
  const code = errorCode(error);
  return typeof code === "string" && code.endsWith("_not_found") && errorStatusCode(error) === 404;
}

const RECOVERABLE_PROCESS_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECANCELED",
  "EACCES",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EIO",
  "ENOENT",
  "ENOTDIR",
  "ENOTFOUND",
  "ENOTCONN",
  "EPERM",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

const RECOVERABLE_UNHANDLED_WATCHER_ERROR_CODES = new Set(["ENOENT", "ENOTDIR", "EPERM", "EACCES", "EBUSY"]);

function errorPath(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "path" in error && typeof error.path === "string"
    ? error.path
    : undefined;
}

function errorSyscall(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "syscall" in error &&
    typeof error.syscall === "string"
    ? error.syscall
    : undefined;
}

function errorStack(error: unknown): string {
  return error instanceof Error && typeof error.stack === "string" ? error.stack : "";
}

function isLikelyFsWatcherEmitter(emitter: EventEmitter): boolean {
  const candidate = emitter as EventEmitter & {
    close?: unknown;
    ref?: unknown;
    unref?: unknown;
  };
  return (
    typeof candidate.close === "function" &&
    typeof candidate.ref === "function" &&
    typeof candidate.unref === "function"
  );
}

export function isRecoverableUnhandledWatcherError(error: unknown): boolean {
  const code = errorCode(error);
  if (!code || !RECOVERABLE_UNHANDLED_WATCHER_ERROR_CODES.has(code)) {
    return false;
  }

  const syscall = errorSyscall(error);
  if (syscall && /^(scandir|watch|stat|lstat|open)$/u.test(syscall)) {
    return true;
  }

  const path = errorPath(error);
  if (!path) {
    return false;
  }

  const message = errorMessage(error);
  const stack = errorStack(error);
  return /fs[\\/]recursive_watch|node:internal\/fs\/recursive_watch|scandir|watch/i.test(`${message}\n${stack}`);
}

export function isRecoverableBackgroundProcessError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && RECOVERABLE_PROCESS_ERROR_CODES.has(code)) {
    return true;
  }

  if (isRecoverableNotFoundRace(error) || hasErrorCode(error, "run_not_found", 404) || hasErrorCode(error, "workspace_not_found", 404)) {
    return true;
  }

  const cause = typeof error === "object" && error !== null && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  if (cause && isRecoverableBackgroundProcessError(cause)) {
    return true;
  }

  const message = errorMessage(error);
  if (error instanceof TypeError && message === "terminated") {
    return true;
  }

  return /aborted|cancelled|canceled|connection refused|connection reset|premature close|socket hang up|stream terminated|timed out|timeout/iu.test(
    message
  );
}

export function installProcessSafetyHandlers(): void {
  if (installed) {
    return;
  }
  installed = true;

  installUnhandledWatcherErrorSafety();

  process.on("uncaughtException", (error) => {
    if (isRecoverableBackgroundProcessError(error)) {
      console.warn("[oah-bootstrap] Recovered from background process exception.", error);
      return;
    }

    console.error(error);
    process.exitCode = 1;
    process.exit();
  });

  process.on("unhandledRejection", (reason) => {
    if (isRecoverableBackgroundProcessError(reason)) {
      console.warn("[oah-bootstrap] Recovered from background promise rejection.", reason);
      return;
    }

    console.error(reason);
    process.exitCode = 1;
    process.exit();
  });
}

function installUnhandledWatcherErrorSafety(): void {
  if (eventEmitterPatchInstalled) {
    return;
  }
  eventEmitterPatchInstalled = true;

  const originalEmit = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function patchedEmit(
    this: EventEmitter,
    eventName: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (
      eventName === "error" &&
      this.listenerCount("error") === 0 &&
      isLikelyFsWatcherEmitter(this) &&
      isRecoverableUnhandledWatcherError(args[0])
    ) {
      try {
        (this as EventEmitter & { close?: () => void }).close?.();
      } catch {
        // Closing an already-failed watcher can throw on some platforms.
      }
      console.warn("[oah-bootstrap] Recovered from unhandled file watcher error.", args[0]);
      return false;
    }

    return originalEmit.call(this, eventName, ...args);
  } as typeof EventEmitter.prototype.emit;
}
