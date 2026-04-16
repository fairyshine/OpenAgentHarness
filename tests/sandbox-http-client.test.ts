import { describe, expect, it, vi } from "vitest";

import { createSandboxHttpClient, type SandboxHttpTransport } from "@oah/api-contracts";

describe("sandbox http client", () => {
  it("serializes create and list requests through the shared transport", async () => {
    const requestJson = vi
      .fn<SandboxHttpTransport["requestJson"]>()
      .mockResolvedValueOnce({
        id: "ws_test",
        workspaceId: "ws_test",
        provider: "self_hosted",
        rootPath: "/workspace",
        name: "Test",
        kind: "project",
        executionPolicy: "local",
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:00.000Z"
      })
      .mockResolvedValueOnce({
        workspaceId: "ws_test",
        path: "/workspace",
        items: [],
        nextCursor: "cursor-1"
      });
    const requestBytes = vi.fn<SandboxHttpTransport["requestBytes"]>().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const client = createSandboxHttpClient({
      requestJson,
      requestBytes
    });

    const sandbox = await client.createSandbox({
      workspaceId: "ws_test",
      executionPolicy: "local"
    });
    const page = await client.listEntries("ws_test", {
      path: "/workspace",
      pageSize: 100,
      sortBy: "name",
      sortOrder: "asc"
    });

    expect(sandbox.id).toBe("ws_test");
    expect(page.nextCursor).toBe("cursor-1");
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      "/sandboxes",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      "/sandboxes/ws_test/files/entries?path=%2Fworkspace&pageSize=100&sortBy=name&sortOrder=asc"
    );
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it("serializes binary upload and download through the shared transport", async () => {
    const requestJson = vi.fn<SandboxHttpTransport["requestJson"]>().mockResolvedValue({
      path: "/workspace/hello.bin",
      name: "hello.bin",
      type: "file",
      readOnly: false
    });
    const requestBytes = vi.fn<SandboxHttpTransport["requestBytes"]>().mockResolvedValue(new Uint8Array([7, 8, 9]));
    const client = createSandboxHttpClient({
      requestJson,
      requestBytes
    });

    const payload = new Uint8Array([1, 2, 3]);
    await client.uploadFile("ws_test", {
      path: "/workspace/hello.bin",
      overwrite: true,
      data: payload,
      contentType: "application/octet-stream"
    });
    const downloaded = await client.downloadFile("ws_test", {
      path: "/workspace/hello.bin"
    });

    expect(downloaded).toEqual(new Uint8Array([7, 8, 9]));
    expect(requestJson).toHaveBeenCalledWith(
      "/sandboxes/ws_test/files/upload?path=%2Fworkspace%2Fhello.bin&overwrite=true",
      expect.objectContaining({
        method: "PUT",
        body: payload
      })
    );
    expect(requestBytes).toHaveBeenCalledWith("/sandboxes/ws_test/files/download?path=%2Fworkspace%2Fhello.bin");
  });

  it("serializes command execution through the shared transport", async () => {
    const requestJson = vi
      .fn<SandboxHttpTransport["requestJson"]>()
      .mockResolvedValueOnce({
        stdout: "ok\n",
        stderr: "",
        exitCode: 0
      })
      .mockResolvedValueOnce({
        outputPath: "/tmp/log",
        taskId: "task-1",
        pid: 42
      });
    const requestBytes = vi.fn<SandboxHttpTransport["requestBytes"]>().mockResolvedValue(new Uint8Array());
    const client = createSandboxHttpClient({
      requestJson,
      requestBytes
    });

    const foreground = await client.runForegroundCommand("ws_test", {
      command: "pwd",
      cwd: "/workspace"
    });
    const background = await client.runBackgroundCommand("ws_test", {
      command: "npm test",
      sessionId: "ses_1"
    });

    expect(foreground.exitCode).toBe(0);
    expect(background.pid).toBe(42);
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      "/sandboxes/ws_test/commands/foreground",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      "/sandboxes/ws_test/commands/background",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(requestBytes).not.toHaveBeenCalled();
  });
});
