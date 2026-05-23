import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachFsWatcherSafetyHandlers,
  closeFsWatcher,
  isRecoverableFsWatcherError
} from "../apps/server/src/bootstrap/workspace-registry.ts";

class FakeWatcher extends EventEmitter {
  closeCalls = 0;
  throwOnClose = false;

  close(): void {
    this.closeCalls += 1;
    if (this.throwOnClose) {
      throw new Error("close failed");
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

describe("workspace registry fs watchers", () => {
  it("treats watcher lifecycle errors as recoverable", () => {
    expect(isRecoverableFsWatcherError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isRecoverableFsWatcherError(Object.assign(new Error("gone"), { code: "ENOTDIR" }))).toBe(true);
    expect(isRecoverableFsWatcherError(Object.assign(new Error("permission"), { code: "EPERM" }))).toBe(true);
    expect(isRecoverableFsWatcherError(Object.assign(new Error("access denied"), { code: "EACCES" }))).toBe(true);
    expect(isRecoverableFsWatcherError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(true);
    expect(isRecoverableFsWatcherError(Object.assign(new Error("bad"), { code: "EINVAL" }))).toBe(false);
    expect(isRecoverableFsWatcherError(new Error("plain"))).toBe(false);
  });

  it("handles async FSWatcher ENOENT errors without throwing", () => {
    const watcher = new FakeWatcher();
    const onChange = vi.fn();
    const onError = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = Object.assign(new Error("directory disappeared"), { code: "ENOENT" });

    attachFsWatcherSafetyHandlers(watcher as unknown as FSWatcher, "/tmp/oah/ws_1", onChange, onError);

    expect(() => watcher.emit("error", error)).not.toThrow();
    expect(watcher.closeCalls).toBe(1);
    expect(onError).toHaveBeenCalledWith({
      targetPath: "/tmp/oah/ws_1",
      error,
      recoverable: true
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("logs unexpected watcher errors but still consumes them", () => {
    const watcher = new FakeWatcher();
    const onChange = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = Object.assign(new Error("unexpected watch failure"), { code: "EINVAL" });

    attachFsWatcherSafetyHandlers(watcher as unknown as FSWatcher, "/tmp/oah/ws_2", onChange);

    expect(() => watcher.emit("error", error)).not.toThrow();
    expect(watcher.closeCalls).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith("[oah-bootstrap] File watcher failed for /tmp/oah/ws_2.", error);
  });

  it("swallows errors raised while closing failed watchers", () => {
    const watcher = new FakeWatcher();
    watcher.throwOnClose = true;

    expect(() => closeFsWatcher(watcher as unknown as FSWatcher)).not.toThrow();
    expect(watcher.closeCalls).toBe(1);
  });

  it("closes a watcher and schedules a resync when the watched path disappears just after opening", async () => {
    const watcher = new FakeWatcher();
    const onChange = vi.fn();
    const onError = vi.fn();
    const fsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
    const accessMock = vi.fn().mockRejectedValue(missingError);
    const watchMock = vi.fn().mockReturnValue(watcher as unknown as FSWatcher);

    vi.doMock("node:fs/promises", () => ({
      ...fsPromises,
      access: accessMock
    }));
    vi.doMock("node:fs", () => ({
      ...fs,
      watch: watchMock
    }));
    vi.resetModules();
    const { openFsWatcher } = await import("../apps/server/src/bootstrap/workspace-registry.ts");

    const opened = openFsWatcher("/tmp/oah/ws_missing/.openharness/agents", onChange, {
      recursive: true,
      onError
    });
    await Promise.resolve();

    expect(opened).toBe(watcher);
    expect(watcher.closeCalls).toBe(1);
    expect(onError).toHaveBeenCalledWith({
      targetPath: "/tmp/oah/ws_missing/.openharness/agents",
      error: missingError,
      recoverable: true
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
