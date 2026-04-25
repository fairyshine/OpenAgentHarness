import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppError,
  EngineService,
  type WorkspaceRecord
} from "@oah/engine-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import {
  createE2BCompatibleSandboxHost,
  createHttpE2BCompatibleSandboxService
} from "../apps/server/src/bootstrap/e2b-compatible-sandbox-host.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createLazySandboxHost, createMaterializationSandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";
import { WorkspaceMaterializationDrainingError } from "../apps/server/src/bootstrap/workspace-materialization.ts";
import { FakeModelGateway } from "./helpers/fake-model-runtime";

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

    expect(host.providerKind).toBe("embedded");
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

  it("defers embedded host construction until workspace access is requested", async () => {
    const acquireWorkspace = vi.fn(async () => ({
      workspaceId: "ws_test",
      version: "live",
      ownerWorkerId: "worker_1",
      localPath: "/tmp/materialized/ws_test",
      sourceKind: "object_store" as const,
      remotePrefix: "workspaces/ws_test",
      markDirty: vi.fn(),
      touch: vi.fn(),
      release: vi.fn(async () => undefined)
    }));
    const createHost = vi.fn(() =>
      createMaterializationSandboxHost({
        materializationManager: {
          acquireWorkspace,
          diagnostics: vi.fn(() => ({
            draining: false,
            cachedCopies: 1,
            objectStoreCopies: 1,
            dirtyCopies: 0,
            busyCopies: 0,
            idleCopies: 1,
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
      })
    );

    const host = createLazySandboxHost({
      providerKind: "embedded",
      createHost,
      diagnostics: {
        provider: "embedded",
        executionModel: "local_embedded",
        workerPlacement: "api_process"
      }
    });

    expect(createHost).not.toHaveBeenCalled();
    expect(host.diagnostics()).toMatchObject({
      provider: "embedded",
      executionModel: "local_embedded",
      workerPlacement: "api_process"
    });

    await host.maintain({ idleBefore: "2026-04-15T00:00:00.000Z" });
    await host.beginDrain();
    await host.close();

    expect(createHost).not.toHaveBeenCalled();

    await host.workspaceFileAccessProvider.acquire({
      workspace: buildWorkspace(),
      access: "read"
    });

    expect(createHost).toHaveBeenCalledTimes(1);
    expect(acquireWorkspace).toHaveBeenCalledTimes(1);
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
      provider: "fake-e2b",
      executionModel: "sandbox_hosted",
      workerPlacement: "inside_sandbox"
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
    const runtimeService = new EngineService({
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

  it("pins follow-up http sandbox requests to the owner base url returned by sandbox creation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://gateway.internal/internal/v1/sandboxes" && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "ws_test",
            workspaceId: "ws_test",
            provider: "self_hosted",
            executionModel: "sandbox_hosted",
            workerPlacement: "inside_sandbox",
            rootPath: "/workspace",
            name: "Test",
            kind: "project",
            executionPolicy: "local",
            ownerWorkerId: "worker_owner",
            ownerBaseUrl: "http://worker-owner.internal:8787/internal/v1",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z"
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url === "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/directories" && method === "POST") {
        expect(JSON.parse(String(init?.body))).toEqual({
          path: "/workspace/nested",
          createParents: true
        });

        return new Response(
          JSON.stringify({
            path: "/workspace/nested",
            name: "nested",
            type: "directory",
            readOnly: false
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url === "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace" && method === "GET") {
        return new Response(
          JSON.stringify({
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0,
            path: "/workspace"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    try {
      const service = createHttpE2BCompatibleSandboxService({
        baseUrl: "http://gateway.internal/internal/v1"
      });
      const workspace = buildWorkspace({
        id: "ws_test",
        rootPath: "/workspace"
      });

      const lease = await service.acquireFileAccess({
        workspace,
        access: "write"
      });
      await service.mkdir({
        sandboxId: lease.sandboxId,
        path: "/workspace/nested",
        recursive: true
      });

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "http://gateway.internal/internal/v1/sandboxes",
        expect.objectContaining({
          method: "POST"
        })
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace",
        expect.any(Object)
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/directories",
        expect.objectContaining({
          method: "POST"
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ensures the sandbox workspace root exists before listing files through the http adapter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://gateway.internal/internal/v1/sandboxes" && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "ws_test",
            workspaceId: "ws_test",
            provider: "self_hosted",
            executionModel: "sandbox_hosted",
            workerPlacement: "inside_sandbox",
            rootPath: "/workspace",
            name: "Test",
            kind: "project",
            executionPolicy: "local",
            ownerWorkerId: "worker_owner",
            ownerBaseUrl: "http://worker-owner.internal:8787/internal/v1",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z"
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url === "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace" && method === "GET") {
        return new Response(
          JSON.stringify({
            error: {
              code: "workspace_directory_not_found",
              message: "Directory . was not found."
            }
          }),
          {
            status: 404,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url === "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/directories" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          path: string;
          createParents: boolean;
        };

        if (body.path === "/workspace") {
          return new Response(
            JSON.stringify({
              error: {
                code: "workspace_root_mutation_not_allowed",
                message: "The workspace root cannot be modified directly."
              }
            }),
            {
              status: 400,
              headers: {
                "content-type": "application/json"
              }
            }
          );
        }

        expect(JSON.parse(String(init?.body))).toEqual({
          path: "/workspace/.openharness",
          createParents: true
        });

        return new Response(
          JSON.stringify({
            path: "/workspace/.openharness",
            name: ".openharness",
            type: "directory",
            readOnly: false
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (
        url ===
          "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/entries?path=%2Fworkspace&pageSize=200&sortBy=name&sortOrder=asc" &&
        method === "GET"
      ) {
        return new Response(
          JSON.stringify({
            workspaceId: "ws_test",
            path: "/workspace",
            items: [
              {
                path: "/workspace/alpha.txt",
                name: "alpha.txt",
                type: "file",
                readOnly: false
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    try {
      const service = createHttpE2BCompatibleSandboxService({
        baseUrl: "http://gateway.internal/internal/v1"
      });
      const workspace = buildWorkspace({
        id: "ws_test",
        rootPath: "/workspace"
      });

      const lease = await service.acquireFileAccess({
        workspace,
        access: "read"
      });
      const entries = await service.readdir({
        sandboxId: lease.sandboxId,
        path: "/workspace"
      });

      expect(entries).toEqual([{ name: "alpha.txt", kind: "file" }]);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "http://gateway.internal/internal/v1/sandboxes",
        expect.objectContaining({
          method: "POST"
        })
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace",
        expect.any(Object)
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/directories",
        expect.objectContaining({
          method: "POST"
        })
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        4,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/directories",
        expect.objectContaining({
          method: "POST"
        })
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        5,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/entries?path=%2Fworkspace&pageSize=200&sortBy=name&sortOrder=asc",
        expect.any(Object)
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("paginates sandbox directory listing through the http adapter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://gateway.internal/internal/v1/sandboxes" && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "ws_test",
            workspaceId: "ws_test",
            provider: "self_hosted",
            executionModel: "sandbox_hosted",
            workerPlacement: "inside_sandbox",
            rootPath: "/workspace",
            name: "Test",
            kind: "project",
            executionPolicy: "local",
            ownerWorkerId: "worker_owner",
            ownerBaseUrl: "http://worker-owner.internal:8787/internal/v1",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z"
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (
        url ===
          "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/entries?path=%2Fworkspace&pageSize=200&sortBy=name&sortOrder=asc" &&
        method === "GET"
      ) {
        return new Response(
          JSON.stringify({
            workspaceId: "ws_test",
            path: "/workspace",
            items: [
              {
                path: "alpha.txt",
                name: "alpha.txt",
                type: "file",
                readOnly: false
              }
            ],
            nextCursor: "cursor-1"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (
        url ===
          "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/entries?path=%2Fworkspace&pageSize=200&cursor=cursor-1&sortBy=name&sortOrder=asc" &&
        method === "GET"
      ) {
        return new Response(
          JSON.stringify({
            workspaceId: "ws_test",
            path: "/workspace",
            items: [
              {
                path: "beta.txt",
                name: "beta.txt",
                type: "file",
                readOnly: false
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url === "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace" && method === "GET") {
        return new Response(
          JSON.stringify({
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0,
            path: "/workspace"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    try {
      const service = createHttpE2BCompatibleSandboxService({
        baseUrl: "http://gateway.internal/internal/v1"
      });
      const workspace = buildWorkspace({
        id: "ws_test",
        rootPath: "/workspace"
      });

      const lease = await service.acquireFileAccess({
        workspace,
        access: "read"
      });
      const entries = await service.readdir({
        sandboxId: lease.sandboxId,
        path: "/workspace"
      });

      expect(entries).toEqual([
        { name: "alpha.txt", kind: "file" },
        { name: "beta.txt", kind: "file" }
      ]);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace",
        expect.any(Object)
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/entries?path=%2Fworkspace&pageSize=200&sortBy=name&sortOrder=asc",
        expect.any(Object)
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        4,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/entries?path=%2Fworkspace&pageSize=200&cursor=cursor-1&sortBy=name&sortOrder=asc",
        expect.any(Object)
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("includes workspace metadata when ensuring a self-hosted sandbox for a workspace", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://gateway.internal/internal/v1/sandboxes" && method === "POST") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          workspaceId: "ws_test",
          name: "Seed Workspace",
          runtime: "test-basic",
          ownerId: "owner-a",
          serviceName: "svc-a",
          executionPolicy: "local"
        });

        return new Response(
          JSON.stringify({
            id: "ws_test",
            workspaceId: "ws_test",
            provider: "self_hosted",
            executionModel: "sandbox_hosted",
            workerPlacement: "inside_sandbox",
            rootPath: "/workspace",
            name: "Seed Workspace",
            kind: "project",
            executionPolicy: "local",
            ownerWorkerId: "worker_owner",
            ownerBaseUrl: "http://worker-owner.internal:8787/internal/v1",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z"
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url === "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace" && method === "GET") {
        return new Response(
          JSON.stringify({
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0,
            path: "/workspace"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    try {
      const service = createHttpE2BCompatibleSandboxService({
        baseUrl: "http://gateway.internal/internal/v1"
      });
      const workspace = buildWorkspace({
        id: "ws_test",
        name: "Seed Workspace",
        runtime: "test-basic",
        ownerId: "owner-a",
        serviceName: "svc-a",
        rootPath: "/workspace"
      });

      const lease = await service.acquireFileAccess({
        workspace,
        access: "write"
      });
      await service.stat({
        sandboxId: lease.sandboxId,
        path: "/workspace"
      });

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "http://gateway.internal/internal/v1/sandboxes",
        expect.objectContaining({
          method: "POST"
        })
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace",
        expect.any(Object)
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to settings.runtime when ensuring a self-hosted sandbox for a workspace", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://gateway.internal/internal/v1/sandboxes" && method === "POST") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          workspaceId: "ws_test",
          name: "Seed Workspace",
          runtime: "test-basic",
          executionPolicy: "local"
        });

        return new Response(
          JSON.stringify({
            id: "ws_test",
            workspaceId: "ws_test",
            provider: "self_hosted",
            executionModel: "sandbox_hosted",
            workerPlacement: "inside_sandbox",
            rootPath: "/workspace",
            name: "Seed Workspace",
            kind: "project",
            executionPolicy: "local",
            ownerWorkerId: "worker_owner",
            ownerBaseUrl: "http://worker-owner.internal:8787/internal/v1",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z"
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url === "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace" && method === "GET") {
        return new Response(
          JSON.stringify({
            kind: "directory",
            size: 0,
            mtimeMs: 0,
            birthtimeMs: 0,
            path: "/workspace"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    try {
      const service = createHttpE2BCompatibleSandboxService({
        baseUrl: "http://gateway.internal/internal/v1"
      });
      const workspace = buildWorkspace({
        id: "ws_test",
        name: "Seed Workspace",
        rootPath: "/workspace",
        settings: {
          defaultAgent: "assistant",
          runtime: "test-basic",
          skillDirs: []
        }
      });

      const lease = await service.acquireFileAccess({
        workspace,
        access: "write"
      });
      await service.stat({
        sandboxId: lease.sandboxId,
        path: "/workspace"
      });

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "http://gateway.internal/internal/v1/sandboxes",
        expect.objectContaining({
          method: "POST"
        })
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "http://worker-owner.internal:8787/internal/v1/sandboxes/ws_test/files/stat?path=%2Fworkspace",
        expect.any(Object)
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
