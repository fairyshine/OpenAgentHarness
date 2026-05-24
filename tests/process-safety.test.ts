import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installProcessSafetyHandlers,
  isRecoverableBackgroundProcessError,
  isRecoverableUnhandledWatcherError
} from "../apps/server/src/bootstrap/process-safety.ts";

class FakeFsWatcher extends EventEmitter {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server process safety", () => {
  it("treats known background lifecycle races as recoverable", () => {
    expect(isRecoverableBackgroundProcessError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isRecoverableBackgroundProcessError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRecoverableBackgroundProcessError(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isRecoverableBackgroundProcessError(Object.assign(new Error("temporary io"), { code: "EIO" }))).toBe(true);
    expect(isRecoverableBackgroundProcessError(Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }))).toBe(true);
    expect(
      isRecoverableBackgroundProcessError({
        name: "AppError",
        statusCode: 404,
        code: "run_not_found",
        message: "Run was not found."
      })
    ).toBe(true);
    expect(
      isRecoverableBackgroundProcessError({
        name: "AppError",
        statusCode: 404,
        code: "session_not_found",
        message: "Session was already removed."
      })
    ).toBe(true);
    expect(
      isRecoverableBackgroundProcessError({
        name: "AppError",
        statusCode: 404,
        code: "agent_task_not_found",
        message: "Task was already removed."
      })
    ).toBe(true);
    expect(
      isRecoverableBackgroundProcessError(
        Object.assign(new TypeError("terminated"), {
          cause: {
            code: "UND_ERR_BODY_TIMEOUT",
            message: "Body Timeout Error"
          }
        })
      )
    ).toBe(true);
    expect(isRecoverableBackgroundProcessError(Object.assign(new Error("request aborted"), { code: "ABORT_ERR" }))).toBe(true);
    expect(isRecoverableBackgroundProcessError(new Error("connection refused"))).toBe(true);
    expect(isRecoverableBackgroundProcessError(new Error("request timed out"))).toBe(true);
    expect(isRecoverableBackgroundProcessError(new Error("socket hang up"))).toBe(true);
  });

  it("does not hide unexpected process exceptions", () => {
    expect(isRecoverableBackgroundProcessError(new Error("database is corrupt"))).toBe(false);
    expect(isRecoverableBackgroundProcessError(Object.assign(new Error("bad argument"), { code: "EINVAL" }))).toBe(false);
    expect(
      isRecoverableBackgroundProcessError({
        name: "AppError",
        statusCode: 500,
        code: "worker_recovery_failed",
        message: "Recovery failed."
      })
    ).toBe(false);
  });

  it("recognizes recursive fs.watch directory deletion races", () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, scandir '/tmp/ws_1/assistant_artifacts'"), {
      code: "ENOENT",
      syscall: "scandir",
      path: "/tmp/ws_1/assistant_artifacts",
      stack: "Error: ENOENT\n    at #watchFolder (node:internal/fs/recursive_watch:115:21)"
    });

    expect(isRecoverableUnhandledWatcherError(error)).toBe(true);
    expect(isRecoverableUnhandledWatcherError(Object.assign(new Error("bad argument"), { code: "EINVAL" }))).toBe(false);
  });

  it("consumes unhandled recoverable FSWatcher error events", () => {
    installProcessSafetyHandlers();
    const watcher = new FakeFsWatcher();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = Object.assign(new Error("missing artifacts directory"), {
      code: "ENOENT",
      syscall: "scandir",
      path: "/tmp/ws_1/assistant_artifacts"
    });

    expect(() => watcher.emit("error", error)).not.toThrow();
    expect(watcher.closeCalls).toBe(1);
    expect(consoleWarn).toHaveBeenCalledWith("[oah-bootstrap] Recovered from unhandled file watcher error.", error);
  });
});
