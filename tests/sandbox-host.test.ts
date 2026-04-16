import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppError,
  RuntimeService,
  type WorkspaceRecord
} from "@oah/runtime-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import {
  createE2BCompatibleSandboxHost,
  createHttpE2BCompatibleSandboxService
} from "../apps/server/src/bootstrap/e2b-compatible-sandbox-host.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createMaterializationSandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";
import { WorkspaceMaterializationDrainingError } from "../apps/server/src/bootstrap/workspace-materialization.ts";
import { FakeModelGateway } from "./helpers/fake-model-gateway";

const tempRoots: string[] = [];

function buildWorkspace(overrides?: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws_test",
    kind: "project",
    name: "Test",
    rootPath: "/tmp/source",
    readOnly: false,
    agents: {},
    models: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    settings: {
      defaultAgent: "assistant",
      skillDirs: []
    },
    executionPolicy: "local",
    status: "active",
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    historyMirrorEnabled: false,
    ...overrides
  };
}

async function createPersistedWorkspace(overrides?: Partial<WorkspaceRecord>): Promise<WorkspaceRecord> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "oah-sandbox-host-"));
  tempRoots.push(rootPath);
  return buildWorkspace({
    rootPath,
    ...overrides
  });
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((rootPath) =>
      rm(rootPath, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("materialization sandbox host", () => {
  it("maps execution leases onto the materialized local workspace path", async () => {
    const release = vi.fn(async () => undefined);
    const host = createMaterializationSandboxHost({
      materializationManager: {
        acquireWorkspace: vi.fn(async () => ({
          workspaceId: "ws_test",
          version: "live",
          ownerWorkerId: "worker_1",
          localPath: "/tmp/materialized/ws_test",
          sourceKind: "object_store",
          remotePrefix: "workspaces/ws_test",
          markDirty: vi.fn(),
          touch: vi.fn(),
          release
        })),
        diagnostics: vi.fn(() => ({
          draining: false,
          cachedCopies: 0,
          objectStoreCopies: 0,
          dirtyCopies: 0,
          busyCopies: 0,
          idleCopies: 0,
          failureCount: 0,
          blockerCount: 0,
          failures: []
        })),
        refreshLeases: vi.fn(async () => undefined),
        flushIdleCopies: vi.fn(async () => []),
        evictIdleCopies: vi.fn(async () => []),
        beginDrain: vi.fn(async () => ({
          drainStartedAt: "2026-04-15T00:00:00.000Z",
          flushed: [],
          evicted: []
        })),
        close: vi.fn(async () => undefined)
      } as never
    });

    expect(host.providerKind).toBe("self_hosted");
    expect(host.workspaceCommandExecutor).toBeDefined();
    expect(host.workspaceFileSystem).toBeDefined();
    expect(host.workspaceExecutionProvider).toBeDefined();
    expect(host.workspaceFileAccessProvider).toBeDefined();

    const lease = await host.workspaceExecutionProvider.acquire({
      workspace: buildWorkspace(),
      run: {
        id: "run_1",
        sessionId: "ses_1",
        workspaceId: "ws_test",
        status: "queued",
        triggerType: "message",
        effectiveAgentName: "main",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z"
      }
    });

    expect(lease.workspace.rootPath).toBe("/tmp/materialized/ws_test");
    await lease.release({ dirty: true });
    expect(release).toHaveBeenCalledWith({ dirty: true });
  });

  it("converts draining materialization failures into AppError", async () => {
    const host = createMaterializationSandboxHost({
      materializationManager: {
        acquireWorkspace: vi.fn(async () => {
          throw new WorkspaceMaterializationDrainingError("draining");
        }),
        diagnostics: vi.fn(() => ({
          draining: true,
          cachedCopies: 0,
          objectStoreCopies: 0,
          dirtyCopies: 0,
          busyCopies: 0,
          idleCopies: 0,
          failureCount: 0,
          blockerCount: 0,
          failures: []
        })),
        refreshLeases: vi.fn(async () => undefined),
        flushIdleCopies: vi.fn(async () => []),
        evictIdleCopies: vi.fn(async () => []),
        beginDrain: vi.fn(async () => ({
          drainStartedAt: "2026-04-15T00:00:00.000Z",
          flushed: [],
          evicted: []
        })),
        close: vi.fn(async () => undefined)
      } as never
    });

    await expect(
      host.workspaceFileAccessProvider.acquire({
        workspace: buildWorkspace(),
        access: "write",
        path: "README.md"
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 503,
      code: "workspace_materialization_draining",
      message: "draining"
    });
  });

  it("adapts an e2b-compatible sandbox service into the sandbox host contract", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const host = createE2BCompatibleSandboxHost({
      service: {
        async acquireExecution() {
          operations.push({ kind: "acquire_execution" });
          return {
            sandboxId: "sandbox-1",
            rootPath: "/workspace/ws_test",
            async release(options) {
              operations.push({ kind: "release_execution", dirty: options?.dirty ?? false });
            }
          };
        },
        async acquireFileAccess() {
          operations.push({ kind: "acquire_file_access" });
          return {
            sandboxId: "sandbox-1",
            rootPath: "/workspace/ws_test",
            async release(options) {
              operations.push({ kind: "release_file_access", dirty: options?.dirty ?? false });
            }
          };
        },
        async runCommand(input) {
          operations.push({ kind: "run_command", sandboxId: input.sandboxId, cwd: input.cwd, command: input.command });
          return {
            stdout: "ok",
            stderr: "",
            exitCode: 0
          };
        },
        async runProcess(input) {
          operations.push({
            kind: "run_process",
            sandboxId: input.sandboxId,
            cwd: input.cwd,
            executable: input.executable,
            args: input.args
          });
          return {
            stdout: "process",
            stderr: "",
            exitCode: 0
          };
        },
        async runBackground(input) {
          operations.push({ kind: "run_background", sandboxId: input.sandboxId, command: input.command });
          return {
            outputPath: "/tmp/log",
            taskId: "task-1",
            pid: 123
          };
        },
        async stat(input) {
          operations.push({ kind: "stat", path: input.path });
          return {
            kind: "directory",
            size: 0,
            mtimeMs: 1,
            birthtimeMs: 1
          };
        },
        async readFile(input) {
          operations.push({ kind: "read_file", path: input.path });
          return Buffer.from("hello");
        },
        async readdir(input) {
          operations.push({ kind: "readdir", path: input.path });
          return [{ name: "README.md", kind: "file" }];
        },
        async mkdir(input) {
          operations.push({ kind: "mkdir", path: input.path, recursive: input.recursive ?? false });
        },
        async writeFile(input) {
          operations.push({ kind: "write_file", path: input.path, size: input.data.length });
        },
        async rm(input) {
          operations.push({ kind: "rm", path: input.path, recursive: input.recursive ?? false });
        },
        async rename(input) {
          operations.push({ kind: "rename", sourcePath: input.sourcePath, targetPath: input.targetPath });
        },
        async realpath(input) {
          operations.push({ kind: "realpath", path: input.path });
          return input.path;
        },
        diagnostics() {
          return {
            provider: "fake-e2b"
          };
        },
        async maintain(options) {
          operations.push({ kind: "maintain", idleBefore: options.idleBefore });
        },
        async beginDrain() {
          operations.push({ kind: "begin_drain" });
        },
        async close() {
          operations.push({ kind: "close" });
        }
      }
    });

    const executionLease = await host.workspaceExecutionProvider.acquire({
      workspace: buildWorkspace(),
      run: {
        id: "run_1",
        sessionId: "ses_1",
        workspaceId: "ws_test",
        status: "queued",
        triggerType: "message",
        effectiveAgentName: "main",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z"
      }
    });
    expect(host.providerKind).toBe("e2b");
    expect(executionLease.workspace.rootPath).toBe("/__oah_sandbox__/sandbox-1/workspace/ws_test");

    await host.workspaceCommandExecutor.runForeground({
      workspace: executionLease.workspace,
      command: "pwd"
    });
    await host.workspaceCommandExecutor.runProcess({
      workspace: executionLease.workspace,
      executable: "node",
      args: ["-v"]
    });
    await host.workspaceCommandExecutor.runBackground({
      workspace: executionLease.workspace,
      command: "npm test",
      sessionId: "ses_1"
    });
    await host.workspaceFileSystem.realpath("/__oah_sandbox__/sandbox-1/workspace/ws_test");
    await host.workspaceFileSystem.stat("/__oah_sandbox__/sandbox-1/workspace/ws_test");
    await host.workspaceFileSystem.readFile("/__oah_sandbox__/sandbox-1/workspace/ws_test/README.md");
    await host.workspaceFileSystem.readdir("/__oah_sandbox__/sandbox-1/workspace/ws_test");
    await host.workspaceFileSystem.mkdir("/__oah_sandbox__/sandbox-1/workspace/ws_test/tmp", { recursive: true });
    await host.workspaceFileSystem.writeFile("/__oah_sandbox__/sandbox-1/workspace/ws_test/README.md", Buffer.from("x"));
    await host.workspaceFileSystem.rm("/__oah_sandbox__/sandbox-1/workspace/ws_test/tmp", { recursive: true, force: true });
    await host.workspaceFileSystem.rename(
      "/__oah_sandbox__/sandbox-1/workspace/ws_test/a.txt",
      "/__oah_sandbox__/sandbox-1/workspace/ws_test/b.txt"
    );
    await host.maintain({
      idleBefore: "2026-04-15T00:00:00.000Z"
    });
    await host.beginDrain();
    await executionLease.release({ dirty: true });

    const fileLease = await host.workspaceFileAccessProvider.acquire({
      workspace: buildWorkspace(),
      access: "write",
      path: "README.md"
    });
    await fileLease.release();
    await host.close();

    expect(host.diagnostics()).toEqual({
      provider: "fake-e2b"
    });
    expect(operations).toEqual(
      expect.arrayContaining([
        { kind: "acquire_execution" },
        { kind: "run_command", sandboxId: "sandbox-1", cwd: "/workspace/ws_test", command: "pwd" },
        { kind: "run_process", sandboxId: "sandbox-1", cwd: "/workspace/ws_test", executable: "node", args: ["-v"] },
        { kind: "run_background", sandboxId: "sandbox-1", command: "npm test" },
        { kind: "stat", path: "/workspace/ws_test" },
        { kind: "read_file", path: "/workspace/ws_test/README.md" },
        { kind: "readdir", path: "/workspace/ws_test" },
        { kind: "mkdir", path: "/workspace/ws_test/tmp", recursive: true },
        { kind: "write_file", path: "/workspace/ws_test/README.md", size: 1 },
        { kind: "rm", path: "/workspace/ws_test/tmp", recursive: true },
        { kind: "rename", sourcePath: "/workspace/ws_test/a.txt", targetPath: "/workspace/ws_test/b.txt" },
        { kind: "maintain", idleBefore: "2026-04-15T00:00:00.000Z" },
        { kind: "begin_drain" },
        { kind: "release_execution", dirty: true },
        { kind: "acquire_file_access" },
        { kind: "release_file_access", dirty: false },
        { kind: "close" }
      ])
    );
  });

  it("can consume the http sandbox interface through the e2b-compatible host adapter", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });
    const workspace = await createPersistedWorkspace();
    await writeFile(path.join(workspace.rootPath, "hello.txt"), "hello over http\n", "utf8");
    await persistence.workspaceRepository.upsert(workspace);

    const app = createApp({
      runtimeService,
      modelGateway: gateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceMode: "multi"
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const address = app.server.address() as AddressInfo;
      const host = createE2BCompatibleSandboxHost({
        service: createHttpE2BCompatibleSandboxService({
          baseUrl: `http://127.0.0.1:${address.port}/internal/v1`
        })
      });

      const executionLease = await host.workspaceExecutionProvider.acquire({
        workspace,
        run: {
          id: "run_http",
          sessionId: "ses_http",
          workspaceId: workspace.id,
          status: "queued",
          triggerType: "message",
          effectiveAgentName: "main",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z"
        }
      });

      expect(
        fetchSpy.mock.calls.some(([input, init]) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          return url.endsWith("/internal/v1/sandboxes") && (init?.method ?? "GET") === "POST";
        })
      ).toBe(true);
      expect(executionLease.workspace.rootPath).toBe(`/__oah_sandbox__/${workspace.id}/workspace`);

      const foreground = await host.workspaceCommandExecutor.runForeground({
        workspace: executionLease.workspace,
        command: "cat hello.txt",
        cwd: executionLease.workspace.rootPath
      });
      expect(foreground).toMatchObject({
        stdout: "hello over http\n",
        exitCode: 0
      });

      const readFile = await host.workspaceFileSystem.readFile(`${executionLease.workspace.rootPath}/hello.txt`);
      expect(readFile.toString("utf8")).toBe("hello over http\n");

      await host.workspaceFileSystem.writeFile(`${executionLease.workspace.rootPath}/created.txt`, Buffer.from("created\n"));
      const created = await runtimeService.getWorkspaceFileContent(workspace.id, {
        path: "created.txt",
        encoding: "utf8"
      });
      expect(created.content).toBe("created\n");
    } finally {
      fetchSpy.mockRestore();
      await app.close();
    }
  });
});
