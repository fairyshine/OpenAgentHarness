import { hasErrorCode } from "./error-codes.js";

let installed = false;

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

export function isRecoverableBackgroundProcessError(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code &&
    [
      "ABORT_ERR",
      "ECANCELED",
      "ECONNABORTED",
      "ECONNRESET",
      "EPIPE",
      "ENOENT",
      "ENOTDIR",
      "EPERM",
      "ERR_STREAM_PREMATURE_CLOSE"
    ].includes(code)
  ) {
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

  return /aborted|cancelled|canceled|premature close|socket hang up|stream terminated/iu.test(message);
}

export function installProcessSafetyHandlers(): void {
  if (installed) {
    return;
  }
  installed = true;

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
