import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRecord } from "@oah/runtime-core";

import {
  createNativeE2BSandboxService,
  normalizeE2BApiUrl
} from "../apps/server/src/bootstrap/native-e2b-sandbox-service.ts";

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
      runtimeTools: []
    },
    executionPolicy: "local",
    status: "active",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    ...overrides
  };
}

describe("native e2b sandbox service", () => {
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
      expect.objectContaining({
        apiKey: "secret",
        metadata: {
          oahSandboxGroup: "shared"
        },
        timeoutMs: 300000
      })
    );
  });

  it("normalizes legacy internal sandbox gateway URLs into E2B apiUrl values", () => {
    expect(normalizeE2BApiUrl("https://sandbox-gateway.example.com/internal/v1")).toBe("https://sandbox-gateway.example.com");
    expect(normalizeE2BApiUrl("https://sandbox-gateway.example.com/custom/api")).toBe("https://sandbox-gateway.example.com/custom/api");
    expect(normalizeE2BApiUrl(undefined)).toBeUndefined();
  });
});
