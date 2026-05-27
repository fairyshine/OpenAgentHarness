import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRecord } from "@oah/engine-core";
import type { DirectoryObjectStore } from "../apps/server/src/object-storage.ts";

import { createMaterializedE2BCompatibleSandboxService } from "../apps/server/src/bootstrap/e2b-compatible-sandbox-host.ts";
import {
  createNativeE2BSandboxService,
  normalizeE2BApiUrl
} from "../apps/server/src/bootstrap/native-e2b-sandbox-service.ts";
import { WorkspaceMaterializationManager } from "../apps/server/src/bootstrap/workspace-materialization.ts";

function buildWorkspace(overrides?: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws_test",
    kind: "project",
    name: "Test Workspace",
    rootPath: "/workspace",
    readOnly: false,
    historyMirrorEnabled: true,
    defaultAgent: "assistant",
    settings: {
      defaultAgent: "assistant",
      skillDirs: []
    },
    workspaceModels: {},
    agents: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    catalog: {
      workspaceId: "ws_test",
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: [],
      engineTools: []
    },
    executionPolicy: "local",
    status: "active",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    ...overrides
  };
}

function createMemoryObjectStore(initialObjects?: Record<string, Buffer | string>): DirectoryObjectStore & {
  getStoredText(key: string): string | undefined;
} {
  const objects = new Map<string, { body: Buffer; lastModified: Date; metadata?: Record<string, string> | undefined }>();
  for (const [key, value] of Object.entries(initialObjects ?? {})) {
    objects.set(key, {
      body: Buffer.isBuffer(value) ? value : Buffer.from(value),
      lastModified: new Date("2026-04-16T00:00:00.000Z")
    });
  }

  return {
    bucket: "bucket",
    async listEntries(prefix) {
      const normalizedPrefix = prefix.replace(/^\/+|\/+$/gu, "");
      return [...objects.entries()]
        .filter(([key]) => key === normalizedPrefix || key.startsWith(`${normalizedPrefix}/`))
        .map(([key, value]) => ({
          key,
          size: value.body.byteLength,
          lastModified: value.lastModified
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
    },
    async getObject(key) {
      const object = objects.get(key);
      if (!object) {
        const error = new Error(`Object not found: ${key}`) as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      }

      return {
        body: object.body,
        metadata: object.metadata
      };
    },
    async putObject(key, body, options) {
      objects.set(key, {
        body,
        lastModified: options?.mtimeMs ? new Date(options.mtimeMs) : new Date("2026-04-16T00:00:00.000Z"),
        ...(options?.mtimeMs ? { metadata: { "oah-mtime-ms": String(options.mtimeMs) } } : {})
      });
    },
    async deleteObjects(keys) {
      for (const key of keys) {
        objects.delete(key);
      }
    },
    getStoredText(key) {
      return objects.get(key)?.body.toString("utf8");
    }
  };
}

describe("native e2b sandbox service", () => {
  it("uses the template list API before falling back to SDK template existence checks", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            templateID: "tpl-1",
            aliases: ["oah-worker"],
            names: ["oah-worker"]
          }
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const sandbox = {
        sandboxId: "sb-created",
        files: {
          makeDir: vi.fn(async () => true),
          write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
          read: vi.fn(async () => new Uint8Array()),
          getInfo: vi.fn(async () => ({
            name: "README.md",
            path: "/workspace/README.md",
            type: "file",
            size: 0,
            mode: 0o644,
            permissions: "rw-r--r--",
            owner: "user",
            group: "group"
          })),
          list: vi.fn(async () => []),
          remove: vi.fn(async () => undefined),
          rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
        },
        commands: {
          run: vi.fn(async () => ({
            stdout: "",
            stderr: "",
            exitCode: 0
          }))
        }
      };
      const exists = vi.fn(async () => false);
      const build = vi.fn(async () => ({
        alias: "oah-worker",
        name: "oah-worker",
        templateId: "tpl-oah-worker",
        buildId: "build-oah-worker"
      }));

      const service = createNativeE2BSandboxService({
        apiKey: "secret",
        apiUrl: "https://api.e2b.example",
        template: "oah-worker",
        sdk: {
          connect: vi.fn(async () => sandbox),
          create: vi.fn(async () => sandbox),
          list: vi.fn(() => ({
            hasNext: false,
            async nextItems() {
              return [];
            }
          }))
        } as never,
        templateSdk: {
          exists,
          build
        } as never
      });

      await service.acquireFileAccess({
        workspace: buildWorkspace(),
        access: "write"
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.e2b.example/templates",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-API-KEY": "secret"
          })
        })
      );
      expect(exists).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ensures the configured worker template exists before creating a sandbox", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch;
    const sandbox = {
      sandboxId: "sb-created",
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    };
    const create = vi.fn(async () => sandbox);
    const exists = vi.fn(async () => false);
    const build = vi.fn(async () => ({
      alias: "oah-worker",
      name: "oah-worker",
      templateId: "tpl-oah-worker",
      buildId: "build-oah-worker"
    }));

    try {
      const service = createNativeE2BSandboxService({
        apiKey: "secret",
        apiUrl: "https://api.e2b.example",
        template: "oah-worker",
        sdk: {
          connect: vi.fn(async () => sandbox),
          create,
          list: vi.fn(() => ({
            hasNext: false,
            async nextItems() {
              return [];
            }
          }))
        } as never,
        templateSdk: {
          exists,
          build
        } as never
      });

      await service.acquireFileAccess({
        workspace: buildWorkspace(),
        access: "write"
      });
      await service.acquireExecution({
        workspace: buildWorkspace(),
        run: {
          id: "run_1",
          sessionId: "ses_1",
          workspaceId: "ws_test",
          status: "queued",
          triggerType: "message",
          effectiveAgentName: "assistant",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z"
        }
      });

      expect(exists).toHaveBeenCalledTimes(1);
      expect(exists).toHaveBeenCalledWith(
        "oah-worker",
        expect.objectContaining({
          apiKey: "secret",
          apiUrl: "https://api.e2b.example"
        })
      );
      expect(build).toHaveBeenCalledTimes(1);
      expect(build).toHaveBeenCalledWith(
        expect.anything(),
        "oah-worker",
        expect.objectContaining({
          apiKey: "secret",
          apiUrl: "https://api.e2b.example",
          cpuCount: 2,
          memoryMB: 2048
        })
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(
        "oah-worker",
        expect.objectContaining({
          metadata: {
            oahSandboxGroup: "shared"
          }
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates sandboxes through the native E2B SDK and maps commands/filesystem operations", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const sandbox = {
      sandboxId: "sb-created",
      files: {
        makeDir: vi.fn(async (targetPath: string) => {
          operations.push({ kind: "make_dir", path: targetPath });
          return true;
        }),
        write: vi.fn(async (targetPath: string, data: ArrayBuffer) => {
          operations.push({ kind: "write", path: targetPath, size: data.byteLength });
          return { name: "README.md", path: targetPath };
        }),
        read: vi.fn(async (targetPath: string, opts?: { format?: string }) => {
          operations.push({ kind: "read", path: targetPath, format: opts?.format ?? "text" });
          if (opts?.format === "bytes") {
            return new Uint8Array([104, 105]);
          }
          if (opts?.format === "stream") {
            return Readable.toWeb(Readable.from(["stream-content"])) as ReadableStream<Uint8Array>;
          }
          return "hi";
        }),
        getInfo: vi.fn(async (targetPath: string) => {
          operations.push({ kind: "get_info", path: targetPath });
          return {
            name: "README.md",
            path: targetPath,
            type: "file",
            size: 2,
            mode: 0o644,
            permissions: "rw-r--r--",
            owner: "user",
            group: "group",
            modifiedTime: new Date("2026-04-16T00:00:00.000Z")
          };
        }),
        list: vi.fn(async (targetPath: string) => {
          operations.push({ kind: "list", path: targetPath });
          return [
            {
              name: "README.md",
              path: `${targetPath}/README.md`,
              type: "file",
              size: 2,
              mode: 0o644,
              permissions: "rw-r--r--",
              owner: "user",
              group: "group",
              modifiedTime: new Date("2026-04-16T00:00:00.000Z")
            },
            {
              name: "src",
              path: `${targetPath}/src`,
              type: "dir",
              size: 0,
              mode: 0o755,
              permissions: "rwxr-xr-x",
              owner: "user",
              group: "group",
              modifiedTime: new Date("2026-04-16T00:00:00.000Z")
            }
          ];
        }),
        remove: vi.fn(async (targetPath: string) => {
          operations.push({ kind: "remove", path: targetPath });
        }),
        rename: vi.fn(async (sourcePath: string, targetPath: string) => {
          operations.push({ kind: "rename", sourcePath, targetPath });
          return {
            name: "b.txt",
            path: targetPath,
            type: "file"
          };
        })
      },
      commands: {
        run: vi.fn(async (command: string, opts?: Record<string, unknown>) => {
          operations.push({ kind: "run", command, opts });
          if ((opts as { background?: boolean } | undefined)?.background) {
            return { pid: 321 };
          }

          return {
            stdout: "ok\n",
            stderr: "",
            exitCode: 0
          };
        })
      }
    };

    const sdk = {
      create: vi.fn(async (...args: unknown[]) => {
        operations.push({ kind: "create", args });
        return sandbox;
      }),
      connect: vi.fn(async (sandboxId: string) => {
        operations.push({ kind: "connect", sandboxId });
        return sandbox;
      }),
      list: vi.fn(() => ({
        hasNext: false,
        async nextItems() {
          return [];
        }
      }))
    };

    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      apiUrl: "https://api.e2b.example",
      template: "oah-template",
      timeoutMs: 120_000,
      requestTimeoutMs: 1_500,
      sdk: sdk as never
    });
    const workspace = buildWorkspace({
      externalRef: "ext-1",
      serviceName: "demo-service"
    });

    const lease = await service.acquireFileAccess({
      workspace,
      access: "write"
    });
    expect(lease).toMatchObject({
      sandboxId: "sb-created",
      rootPath: "/workspace/ws_test"
    });

    const foreground = await service.runCommand({
      sandboxId: lease.sandboxId,
      rootPath: lease.rootPath,
      command: "pwd",
      cwd: `${lease.rootPath}/app`,
      env: {
        HELLO: "world"
      }
    });
    expect(foreground).toEqual({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0
    });

    const processResult = await service.runProcess({
      sandboxId: lease.sandboxId,
      rootPath: lease.rootPath,
      executable: "node",
      args: ["-v"]
    });
    expect(processResult.exitCode).toBe(0);

    const background = await service.runBackground({
      sandboxId: lease.sandboxId,
      rootPath: lease.rootPath,
      command: "npm test",
      sessionId: "ses_1",
      cwd: `${lease.rootPath}/app`
    });
    expect(background.pid).toBe(321);
    expect(background.taskId).toMatch(/^task-e2b-/);
    expect(background.outputPath).toContain("/workspace/ws_test/.openharness/state/background/ses_1/");

    await expect(service.readFile({ sandboxId: lease.sandboxId, path: `${lease.rootPath}/README.md` })).resolves.toEqual(Buffer.from("hi"));
    await expect(service.openReadStream?.({ sandboxId: lease.sandboxId, path: `${lease.rootPath}/README.md` })).toBeTruthy();
    await expect(service.stat({ sandboxId: lease.sandboxId, path: `${lease.rootPath}/README.md` })).resolves.toMatchObject({
      kind: "file",
      size: 2
    });
    await expect(service.readdir({ sandboxId: lease.sandboxId, path: lease.rootPath })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "README.md", kind: "file", sizeBytes: 2 }),
        expect.objectContaining({ name: "src", kind: "directory" })
      ])
    );
    await service.mkdir({ sandboxId: lease.sandboxId, path: `${lease.rootPath}/tmp`, recursive: true });
    await service.writeFile({ sandboxId: lease.sandboxId, path: `${lease.rootPath}/README.md`, data: Buffer.from("hello") });
    await service.rm({ sandboxId: lease.sandboxId, path: `${lease.rootPath}/README.md` });
    await service.rm({ sandboxId: lease.sandboxId, path: `${lease.rootPath}/tmp`, recursive: true, force: true });
    await service.rename({
      sandboxId: lease.sandboxId,
      sourcePath: `${lease.rootPath}/a.txt`,
      targetPath: `${lease.rootPath}/b.txt`
    });

    expect(service.diagnostics()).toMatchObject({
      provider: "e2b",
      transport: "native_e2b",
      apiUrl: "https://api.e2b.example",
      template: "oah-template",
      timeoutMs: 120_000,
      executionModel: "sandbox_hosted",
      workerPlacement: "inside_sandbox"
    });

    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "create",
          args: [
            "oah-template",
            expect.objectContaining({
              apiKey: "secret",
              apiUrl: "https://api.e2b.example",
              requestTimeoutMs: 1500,
              timeoutMs: 120000,
              metadata: {
                oahSandboxGroup: "shared"
              }
            })
          ]
        }),
        { kind: "make_dir", path: "/workspace" },
        { kind: "make_dir", path: "/workspace/ws_test" },
        expect.objectContaining({ kind: "run", command: "pwd", opts: expect.objectContaining({ cwd: "/workspace/ws_test/app" }) }),
        expect.objectContaining({ kind: "run", command: "'node' '-v'" }),
        expect.objectContaining({ kind: "run", opts: expect.objectContaining({ background: true, cwd: "/workspace/ws_test/app" }) }),
        { kind: "read", path: "/workspace/ws_test/README.md", format: "bytes" },
        { kind: "get_info", path: "/workspace/ws_test/README.md" },
        { kind: "list", path: "/workspace/ws_test" },
        { kind: "make_dir", path: "/workspace/ws_test/tmp" },
        { kind: "write", path: "/workspace/ws_test/README.md", size: 5 },
        { kind: "remove", path: "/workspace/ws_test/README.md" },
        expect.objectContaining({ kind: "run", command: "rm -rf -- '/workspace/ws_test/tmp'" }),
        { kind: "rename", sourcePath: "/workspace/ws_test/a.txt", targetPath: "/workspace/ws_test/b.txt" }
      ])
    );
  });

  it("reuses existing sandboxes by group metadata before creating new ones", async () => {
    const sandbox = {
      sandboxId: "sb-existing",
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    };

    const connect = vi.fn(async () => sandbox);
    const create = vi.fn(async () => sandbox);
    const list = vi.fn(() => ({
      hasNext: true,
      async nextItems() {
        return [
          {
            sandboxId: "sb-existing",
            templateId: "tpl-1",
            metadata: {
              oahSandboxGroup: "owner:user-1"
            },
            startedAt: new Date("2026-04-16T00:00:00.000Z"),
            endAt: new Date("2026-04-16T01:00:00.000Z")
          }
        ];
      }
    }));

    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      sdk: {
        connect,
        create,
        list
      } as never
    });

    const firstLease = await service.acquireExecution({
      workspace: buildWorkspace({
        id: "ws_1",
        ownerId: "user-1",
        serviceName: "svc-alpha"
      }),
      run: {
        id: "run_1",
        sessionId: "ses_1",
        workspaceId: "ws_1",
        status: "queued",
        triggerType: "message",
        effectiveAgentName: "assistant",
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:00.000Z"
      }
    });
    const secondLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_2",
        ownerId: "user-1",
        serviceName: "svc-alpha"
      }),
      access: "read"
    });

    expect(firstLease.sandboxId).toBe("sb-existing");
    expect(secondLease.sandboxId).toBe("sb-existing");
    expect(firstLease.rootPath).toBe("/workspace/ws_1");
    expect(secondLease.rootPath).toBe("/workspace/ws_2");
    expect(list).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("shares one real sandbox across multiple workspaces with the same owner", async () => {
    const sandbox = {
      sandboxId: "sb-shared",
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    };

    const create = vi.fn(async () => sandbox);

    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      sdk: {
        connect: vi.fn(async () => sandbox),
        create,
        list: vi.fn(() => ({
          hasNext: false,
          async nextItems() {
            return [];
          }
        }))
      } as never
    });

    const firstLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_alpha",
        ownerId: "user-42",
        serviceName: "svc-demo"
      }),
      access: "write"
    });
    const secondLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_beta",
        ownerId: "user-42",
        serviceName: "svc-demo"
      }),
      access: "write"
    });

    expect(firstLease.sandboxId).toBe("sb-shared");
    expect(secondLease.sandboxId).toBe("sb-shared");
    expect(firstLease.rootPath).toBe("/workspace/ws_alpha");
    expect(secondLease.rootPath).toBe("/workspace/ws_beta");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      "oah-worker",
      expect.objectContaining({
        apiKey: "secret",
        metadata: {
          oahSandboxGroup: "owner:user-42",
          oahOwnerId: "user-42"
        },
        timeoutMs: 300000
      })
    );
  });

  it("shares the default sandbox across workspaces without owner ids", async () => {
    const sandbox = {
      sandboxId: "sb-default-shared",
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    };

    const create = vi.fn(async () => sandbox);

    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      sdk: {
        connect: vi.fn(async () => sandbox),
        create,
        list: vi.fn(() => ({
          hasNext: false,
          async nextItems() {
            return [];
          }
        }))
      } as never
    });

    const firstLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_public_1"
      }),
      access: "write"
    });
    const secondLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_public_2",
        serviceName: "another-service"
      }),
      access: "write"
    });

    expect(firstLease.sandboxId).toBe("sb-default-shared");
    expect(secondLease.sandboxId).toBe("sb-default-shared");
    expect(firstLease.rootPath).toBe("/workspace/ws_public_1");
    expect(secondLease.rootPath).toBe("/workspace/ws_public_2");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      "oah-worker",
      expect.objectContaining({
        apiKey: "secret",
        metadata: {
          oahSandboxGroup: "shared"
        },
        timeoutMs: 300000
      })
    );
  });

  it("replaces a cached sandbox when the remote sandbox becomes unavailable", async () => {
    const expiredSandbox = {
      sandboxId: "sb-expired",
      files: {
        makeDir: vi.fn(async () => {
          throw new Error("[unavailable] HTTP 502: This error is likely due to sandbox timeout.");
        }),
        write: vi.fn(),
        read: vi.fn(),
        getInfo: vi.fn(),
        list: vi.fn(),
        remove: vi.fn(),
        rename: vi.fn()
      },
      commands: {
        run: vi.fn()
      }
    };
    const replacementSandbox = {
      sandboxId: "sb-replacement",
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(),
        read: vi.fn(),
        getInfo: vi.fn(),
        list: vi.fn(),
        remove: vi.fn(),
        rename: vi.fn()
      },
      commands: {
        run: vi.fn()
      }
    };
    const create = vi.fn(async () => (create.mock.calls.length === 1 ? expiredSandbox : replacementSandbox));
    const kill = vi.fn(async () => true);
    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      sdk: {
        connect: vi.fn(),
        create,
        kill,
        list: vi.fn(() => ({
          hasNext: false,
          async nextItems() {
            return [];
          }
        }))
      } as never
    });

    const lease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_public_1"
      }),
      access: "write"
    });

    expect(lease.sandboxId).toBe("sb-replacement");
    expect(create).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(
      "sb-expired",
      expect.objectContaining({
        apiKey: "secret"
      })
    );
    expect(replacementSandbox.files.makeDir).toHaveBeenCalledWith("/workspace");
    expect(replacementSandbox.files.makeDir).toHaveBeenCalledWith("/workspace/ws_public_1");
  });

  it("hydrates native E2B sandboxes from materialized object storage and flushes dirty releases back", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oah-e2b-materialized-"));
    const remoteFiles = new Map<string, { data: Buffer; mtimeMs: number }>();
    const sandbox = {
      sandboxId: "sb-materialized",
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async (targetPath: string, data: ArrayBuffer) => {
          remoteFiles.set(targetPath, {
            data: Buffer.from(data),
            mtimeMs: Date.parse("2026-04-16T00:00:00.000Z")
          });
          return { name: path.posix.basename(targetPath), path: targetPath };
        }),
        read: vi.fn(async (targetPath: string, opts?: { format?: string }) => {
          const file = remoteFiles.get(targetPath);
          if (!file) {
            throw new Error(`not found: ${targetPath}`);
          }
          if (opts?.format === "bytes") {
            return file.data;
          }
          return file.data.toString("utf8");
        }),
        getInfo: vi.fn(async (targetPath: string) => ({
          name: path.posix.basename(targetPath),
          path: targetPath,
          type: "file",
          size: remoteFiles.get(targetPath)?.data.byteLength ?? 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group",
          modifiedTime: new Date(remoteFiles.get(targetPath)?.mtimeMs ?? Date.parse("2026-04-16T00:00:00.000Z"))
        })),
        list: vi.fn(async (targetPath: string) => {
          const childNames = new Set<string>();
          const files = [];
          for (const [filePath, file] of remoteFiles) {
            if (!filePath.startsWith(`${targetPath}/`)) {
              continue;
            }
            const relativePath = filePath.slice(targetPath.length + 1);
            const [name, ...rest] = relativePath.split("/");
            if (!name || childNames.has(name)) {
              continue;
            }
            childNames.add(name);
            if (rest.length > 0) {
              files.push({
                name,
                path: path.posix.join(targetPath, name),
                type: "dir",
                size: 0,
                mode: 0o755,
                permissions: "rwxr-xr-x",
                owner: "user",
                group: "group",
                modifiedTime: new Date("2026-04-16T00:00:00.000Z")
              });
              continue;
            }
            files.push({
              name,
              path: filePath,
              type: "file",
              size: file.data.byteLength,
              mode: 0o644,
              permissions: "rw-r--r--",
              owner: "user",
              group: "group",
              modifiedTime: new Date(file.mtimeMs)
            });
          }
          return files;
        }),
        remove: vi.fn(async (targetPath: string) => {
          remoteFiles.delete(targetPath);
        }),
        rename: vi.fn(async (sourcePath: string, targetPath: string) => {
          const file = remoteFiles.get(sourcePath);
          if (file) {
            remoteFiles.set(targetPath, file);
            remoteFiles.delete(sourcePath);
          }
          return { name: path.posix.basename(targetPath), path: targetPath, type: "file" };
        })
      },
      commands: {
        run: vi.fn(async (command: string) => {
          const touchMatch = /touch -m -d '([^']+)' -- '([^']+)'/u.exec(command);
          if (touchMatch) {
            const file = remoteFiles.get(touchMatch[2]!);
            if (file) {
              file.mtimeMs = Date.parse(touchMatch[1]!);
            }
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0
          };
        })
      }
    };
    const store = createMemoryObjectStore({
      "workspace/ws_materialized/README.md": "from-oss"
    });
    const materializationManager = new WorkspaceMaterializationManager({
      cacheRoot: path.join(tempRoot, ".openharness", "__materialized__"),
      workspaceRoot: path.join(tempRoot, "workspaces"),
      workerId: "worker-test",
      store
    });
    const service = createMaterializedE2BCompatibleSandboxService({
      service: createNativeE2BSandboxService({
        ensureTemplate: false,
        sdk: {
          connect: vi.fn(async () => sandbox),
          create: vi.fn(async () => sandbox),
          list: vi.fn(() => ({
            hasNext: false,
            async nextItems() {
              return [];
            }
          }))
        } as never
      }),
      materializationManager
    });
    const workspace = buildWorkspace({
      id: "ws_materialized",
      rootPath: path.join(tempRoot, "workspaces", "ws_materialized"),
      externalRef: "s3://bucket/workspace/ws_materialized"
    });

    try {
      const lease = await service.acquireFileAccess({
        workspace,
        access: "write"
      });

      expect(remoteFiles.get("/workspace/ws_materialized/README.md")?.data.toString("utf8")).toBe("from-oss");

      await service.writeFile({
        sandboxId: lease.sandboxId,
        path: `${lease.rootPath}/README.md`,
        data: Buffer.from("changed-in-e2b")
      });
      await lease.release({ dirty: true });

      expect(await readFile(path.join(tempRoot, "workspaces", "ws_materialized", "README.md"), "utf8")).toBe("changed-in-e2b");
      expect(store.getStoredText("workspace/ws_materialized/README.md")).toBe("changed-in-e2b");
      const cleanLease = await materializationManager.acquireWorkspace({ workspace });
      await cleanLease.release({ dirty: false });
      expect(cleanLease.localPath).toBe(path.join(tempRoot, "workspaces", "ws_materialized"));
    } finally {
      await service.close().catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("opens a new ownerless shared sandbox bucket when the current bucket is full", async () => {
    const sandboxes = ["sb-ownerless-1", "sb-ownerless-2"].map((sandboxId) => ({
      sandboxId,
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    }));

    const create = vi.fn(async () => sandboxes[create.mock.calls.length - 1] ?? sandboxes[0]);

    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      maxWorkspacesPerSandbox: 1,
      sdk: {
        connect: vi.fn(async () => sandboxes[0]),
        create,
        list: vi.fn(() => ({
          hasNext: false,
          async nextItems() {
            return [];
          }
        }))
      } as never
    });

    const firstLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_public_1"
      }),
      access: "write"
    });
    const secondLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_public_2"
      }),
      access: "write"
    });

    expect(firstLease.sandboxId).toBe("sb-ownerless-1");
    expect(secondLease.sandboxId).toBe("sb-ownerless-2");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(
      1,
      "oah-worker",
      expect.objectContaining({
        metadata: {
          oahSandboxGroup: "shared"
        }
      })
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      "oah-worker",
      expect.objectContaining({
        metadata: {
          oahSandboxGroup: "shared:2"
        }
      })
    );
  });

  it("releases ownerless shared sandbox capacity when a workspace is deleted", async () => {
    const sandboxes = ["sb-ownerless-1", "sb-ownerless-2"].map((sandboxId) => ({
      sandboxId,
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    }));

    const create = vi.fn(async () => sandboxes[create.mock.calls.length - 1] ?? sandboxes[0]);
    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      maxWorkspacesPerSandbox: 1,
      sdk: {
        connect: vi.fn(async () => sandboxes[0]),
        create,
        list: vi.fn(() => ({
          hasNext: false,
          async nextItems() {
            return [];
          }
        }))
      } as never
    });
    const firstWorkspace = buildWorkspace({ id: "ws_public_1" });
    const secondWorkspace = buildWorkspace({ id: "ws_public_2" });

    const firstLease = await service.acquireFileAccess({
      workspace: firstWorkspace,
      access: "write"
    });
    await service.deleteWorkspace?.(firstWorkspace);
    const secondLease = await service.acquireFileAccess({
      workspace: secondWorkspace,
      access: "write"
    });

    expect(firstLease.sandboxId).toBe("sb-ownerless-1");
    expect(secondLease.sandboxId).toBe("sb-ownerless-1");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("kills dedicated ownerless sandboxes when their workspace is deleted", async () => {
    const sandbox = {
      sandboxId: "sb-dedicated",
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    };
    const kill = vi.fn(async () => true);
    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      ownerlessPool: "dedicated",
      sdk: {
        connect: vi.fn(async () => sandbox),
        create: vi.fn(async () => sandbox),
        kill,
        list: vi.fn(() => ({
          hasNext: false,
          async nextItems() {
            return [];
          }
        }))
      } as never
    });
    const workspace = buildWorkspace({ id: "ws_public_1" });

    await service.acquireFileAccess({
      workspace,
      access: "write"
    });
    await service.deleteWorkspace?.(workspace);

    expect(kill).toHaveBeenCalledWith("sb-dedicated", expect.objectContaining({ apiKey: "secret" }));
  });

  it("keeps a warm ownerless sandbox ready and replenishes it after use", async () => {
    const sandboxes = ["sb-warm-1", "sb-warm-2", "sb-warm-3"].map((sandboxId) => ({
      sandboxId,
      files: {
        makeDir: vi.fn(async () => true),
        write: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md" })),
        read: vi.fn(async () => new Uint8Array()),
        getInfo: vi.fn(async () => ({
          name: "README.md",
          path: "/workspace/README.md",
          type: "file",
          size: 0,
          mode: 0o644,
          permissions: "rw-r--r--",
          owner: "user",
          group: "group"
        })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => ({ name: "README.md", path: "/workspace/README.md", type: "file" }))
      },
      commands: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0
        }))
      }
    }));

    const create = vi.fn(async () => sandboxes[create.mock.calls.length - 1] ?? sandboxes.at(-1)!);

    const service = createNativeE2BSandboxService({
      ensureTemplate: false,
      apiKey: "secret",
      maxWorkspacesPerSandbox: 1,
      warmEmptyCount: 1,
      sdk: {
        connect: vi.fn(async () => sandboxes[0]),
        create,
        list: vi.fn(() => ({
          hasNext: false,
          async nextItems() {
            return [];
          }
        }))
      } as never
    });

    await service.maintain?.({ idleBefore: "2026-04-16T00:00:00.000Z" });

    const firstLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_public_1"
      }),
      access: "write"
    });
    const secondLease = await service.acquireFileAccess({
      workspace: buildWorkspace({
        id: "ws_public_2"
      }),
      access: "write"
    });

    expect(firstLease.sandboxId).toBe("sb-warm-1");
    expect(secondLease.sandboxId).toBe("sb-warm-2");
    expect(create).toHaveBeenNthCalledWith(
      1,
      "oah-worker",
      expect.objectContaining({
        metadata: {
          oahSandboxGroup: "shared"
        }
      })
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      "oah-worker",
      expect.objectContaining({
        metadata: {
          oahSandboxGroup: "shared:2"
        }
      })
    );
    expect(service.diagnostics()).toMatchObject({
      warmEmptyCount: 1
    });
  });

  it("normalizes legacy internal sandbox gateway URLs into E2B apiUrl values", () => {
    expect(normalizeE2BApiUrl("https://sandbox-gateway.example.com/internal/v1")).toBe("https://sandbox-gateway.example.com");
    expect(normalizeE2BApiUrl("https://sandbox-gateway.example.com/custom/api")).toBe("https://sandbox-gateway.example.com/custom/api");
    expect(normalizeE2BApiUrl(undefined)).toBeUndefined();
  });
});
