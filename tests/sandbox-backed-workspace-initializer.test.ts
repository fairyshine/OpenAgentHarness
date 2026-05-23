import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as configModule from "@oah/config";
import { createLocalWorkspaceCommandExecutor, createLocalWorkspaceFileSystem, type WorkspaceRecord } from "@oah/engine-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSandboxBackedWorkspaceInitializer,
  createSelfHostedWorkspaceDelegatingInitializer,
  nativeWorkspaceSyncAdapter,
  resolveSandboxSeedTransferStrategy,
  resolveSeedDirectoriesToCreate
} from "../apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts";
import type { SandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";

const tempDirs: string[] = [];

function createWorkspaceRecordFixture(input: {
  id: string;
  name: string;
  rootPath?: string | undefined;
  externalRef?: string | undefined;
}): WorkspaceRecord {
  return {
    id: input.id,
    kind: "project",
    readOnly: false,
    historyMirrorEnabled: true,
    defaultAgent: "assistant",
    settings: {
      defaultAgent: "assistant"
    },
    workspaceModels: {},
    agents: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    catalog: {
      workspaceId: input.id,
      models: [],
      actions: []
    },
    ...(input.externalRef ? { externalRef: input.externalRef } : {}),
    name: input.name,
    rootPath: input.rootPath ?? `/data/workspaces/${input.id}`,
    executionPolicy: "local",
    status: "active",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z"
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs/promises");
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    tempDirs.splice(0).map(async (targetPath) => {
      await rm(targetPath, { recursive: true, force: true });
    })
  );
});

describe("sandbox-backed workspace initializer", () => {
  it("derives seed transfer strategy from sandbox capabilities", () => {
    expect(
      resolveSandboxSeedTransferStrategy({
        sandboxHost: {
          providerKind: "self_hosted"
        },
        selfHostedSandbox: {
          id: "sandbox-1",
          baseUrl: "http://127.0.0.1:8787/internal/v1"
        }
      })
    ).toMatchObject({
      archiveUpload: true,
      nativeHttpUpload: true,
      createOnlyLeafEmptyDirectories: true
    });

    expect(
      resolveSandboxSeedTransferStrategy({
        sandboxHost: {
          providerKind: "e2b"
        }
      })
    ).toEqual({
      archiveUpload: false,
      nativeHttpUpload: false,
      createOnlyLeafEmptyDirectories: false
    });
  });

  it("uses the seed strategy to decide which remote directories need explicit mkdir", () => {
    const existingEntries = new Map([
      [
        "/workspace/existing",
        {
          path: "/workspace/existing",
          kind: "directory" as const
        }
      ]
    ]);

    expect(
      resolveSeedDirectoriesToCreate({
        strategy: {
          archiveUpload: false,
          nativeHttpUpload: false,
          createOnlyLeafEmptyDirectories: false
        },
        directories: ["/workspace/parent", "/workspace/parent/child", "/workspace/empty", "/workspace/existing"],
        filePaths: ["/workspace/parent/child/file.txt"],
        existingEntries
      })
    ).toEqual(["/workspace/parent", "/workspace/parent/child", "/workspace/empty"]);

    expect(
      resolveSeedDirectoriesToCreate({
        strategy: {
          archiveUpload: false,
          nativeHttpUpload: false,
          createOnlyLeafEmptyDirectories: true
        },
        directories: ["/workspace/parent", "/workspace/parent/child", "/workspace/empty", "/workspace/existing"],
        filePaths: ["/workspace/parent/child/file.txt"],
        existingEntries
      })
    ).toEqual(["/workspace/empty"]);
  });

  it("delegates object-storage backed workspace creation to self-hosted workers", async () => {
    const workspace = createWorkspaceRecordFixture({
      id: "ws_worker_created",
      name: "worker-created",
      externalRef: "s3://test-bucket/workspace/ws_worker_created"
    });
    const getWorkspaceRecord = vi.fn(async (workspaceId: string) => (workspaceId === workspace.id ? workspace : undefined));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "sandbox-1",
          workspaceId: workspace.id,
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox",
          rootPath: "/data/workspaces/ws_worker_created",
          name: workspace.name,
          kind: "project",
          executionPolicy: "local",
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const initializer = createSelfHostedWorkspaceDelegatingInitializer({
      selfHosted: {
        baseUrl: "http://oah-sandbox:8787/internal/v1",
        headers: {
          authorization: "Bearer test-token"
        }
      },
      getWorkspaceRecord
    });

    await expect(
      initializer.initialize({
        name: "worker-created",
        runtime: "node",
        executionPolicy: "local",
        ownerId: "owner-1",
        workspaceId: workspace.id
      } as Parameters<typeof initializer.initialize>[0] & { workspaceId: string })
    ).resolves.toEqual(workspace);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("http://oah-sandbox:8787/internal/v1/sandboxes");
    expect(fetchSpy.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer test-token"
        })
      })
    );
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      workspaceId: workspace.id,
      name: "worker-created",
      runtime: "node",
      executionPolicy: "local",
      ownerId: "owner-1"
    });
    expect(getWorkspaceRecord).toHaveBeenCalledWith(workspace.id);
  });

  it("waits briefly for a delegated self-hosted workspace record to become visible", async () => {
    vi.stubEnv("OAH_SELF_HOSTED_WORKSPACE_RECORD_WAIT_MS", "200");
    const workspace = createWorkspaceRecordFixture({
      id: "ws_worker_eventual",
      name: "worker-eventual"
    });
    const getWorkspaceRecord = vi
      .fn(async (_workspaceId: string): Promise<WorkspaceRecord | undefined> => undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(workspace);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "sandbox-eventual",
          workspaceId: workspace.id,
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox",
          rootPath: workspace.rootPath,
          name: workspace.name,
          kind: "project",
          executionPolicy: "local",
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const initializer = createSelfHostedWorkspaceDelegatingInitializer({
      selfHosted: {
        baseUrl: "http://oah-sandbox:8787/internal/v1"
      },
      getWorkspaceRecord
    });

    await expect(
      initializer.initialize({
        name: "worker-eventual",
        runtime: "node",
        executionPolicy: "local",
        workspaceId: workspace.id
      } as Parameters<typeof initializer.initialize>[0] & { workspaceId: string })
    ).resolves.toEqual(workspace);

    expect(getWorkspaceRecord).toHaveBeenCalledTimes(2);
  });

  it("uploads runtime files into self-hosted sandbox workspaces", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-self-hosted-workspace-init-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteWorkspaceRoot = path.join(tempDir, "remote-workspace");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteWorkspaceRoot, { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(runtimeRoot, "README.md"), "# Seeded from runtime\n", "utf8"),
      writeFile(path.join(runtimeRoot, "nested", "notes.txt"), "hello from runtime\n", "utf8")
    ]);
    const sourceMtime = new Date("2026-04-18T12:34:56.000Z");
    await Promise.all([
      utimes(path.join(runtimeRoot, "README.md"), sourceMtime, sourceMtime),
      utimes(path.join(runtimeRoot, "nested", "notes.txt"), sourceMtime, sourceMtime)
    ]);

    const localWorkspaceFileSystem = createLocalWorkspaceFileSystem();
    const sandboxHost: SandboxHost = {
      providerKind: "self_hosted",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: {
        ...localWorkspaceFileSystem,
        async writeFile(targetPath, data, options) {
          await mkdir(path.dirname(targetPath), { recursive: true });
          await localWorkspaceFileSystem.writeFile(targetPath, data, options);
        }
      },
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteWorkspaceRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "ws_remote_seed",
          workspaceId: "ws_remote_seed",
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox",
          rootPath: "/workspace",
          name: "remote-seed",
          kind: "project",
          executionPolicy: "local",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost,
      selfHosted: {
        baseUrl: "http://127.0.0.1:8787/internal/v1"
      }
    });

    const initialized = await initializer.initialize({
      name: "remote-seed",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(initialized.rootPath).toBe("/workspace");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(remoteWorkspaceRoot, "README.md"), "utf8")).resolves.toBe("# Seeded from runtime\n");
    await expect(readFile(path.join(remoteWorkspaceRoot, "nested", "notes.txt"), "utf8")).resolves.toBe(
      "hello from runtime\n"
    );
    expect((await stat(path.join(remoteWorkspaceRoot, "README.md"))).mtime.toISOString()).toBe("2026-04-18T12:34:56.000Z");
    await expect(readFile(path.join(remoteWorkspaceRoot, ".openharness", "settings.yaml"), "utf8")).resolves.toBe(
      "default_agent: assistant\nruntime: workspace\n"
    );
  });

  it("uses archive upload for large self-hosted seed initialization when enabled", async () => {
    vi.stubEnv("OAH_SANDBOX_SEED_ARCHIVE_UPLOAD", "1");
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "0");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-self-hosted-archive-seed-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteWorkspaceRoot = path.join(tempDir, "remote-workspace");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteWorkspaceRoot, { recursive: true })
    ]);

    await writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(
          path.join(index % 2 === 0 ? runtimeRoot : path.join(runtimeRoot, "nested"), `file-${index}.txt`),
          `payload-${index}\n`,
          "utf8"
        )
      )
    );

    const localWorkspaceFileSystem = createLocalWorkspaceFileSystem();
    const baseCommandExecutor = createLocalWorkspaceCommandExecutor();
    let writeFileCalls = 0;
    let foregroundCalls = 0;
    const sandboxHost: SandboxHost = {
      providerKind: "self_hosted",
      workspaceCommandExecutor: {
        ...baseCommandExecutor,
        async runForeground(input) {
          foregroundCalls += 1;
          return baseCommandExecutor.runForeground(input);
        }
      },
      workspaceFileSystem: {
        ...localWorkspaceFileSystem,
        async writeFile(targetPath, data, options) {
          writeFileCalls += 1;
          await mkdir(path.dirname(targetPath), { recursive: true });
          await localWorkspaceFileSystem.writeFile(targetPath, data, options);
        }
      },
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteWorkspaceRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "ws_remote_archive",
          workspaceId: "ws_remote_archive",
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox",
          rootPath: "/workspace",
          name: "remote-archive",
          kind: "project",
          executionPolicy: "local",
          createdAt: "2026-04-24T00:00:00.000Z",
          updatedAt: "2026-04-24T00:00:00.000Z"
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost,
      selfHosted: {
        baseUrl: "http://127.0.0.1:8787/internal/v1"
      }
    });

    await initializer.initialize({
      name: "archive-seed",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(writeFileCalls).toBe(1);
    expect(foregroundCalls).toBe(1);
    await expect(readFile(path.join(remoteWorkspaceRoot, "file-0.txt"), "utf8")).resolves.toBe("payload-0\n");
    await expect(readFile(path.join(remoteWorkspaceRoot, "nested", "file-1.txt"), "utf8")).resolves.toBe("payload-1\n");
    await expect(stat(path.join(remoteWorkspaceRoot, ".openharness", ".oah-seed-upload"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("reuses the prepared seed archive across repeated self-hosted initialization", async () => {
    vi.stubEnv("OAH_SANDBOX_SEED_ARCHIVE_UPLOAD", "1");
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "0");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-self-hosted-archive-cache-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteWorkspaceRoot = path.join(tempDir, "remote-workspace");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteWorkspaceRoot, { recursive: true })
    ]);

    await writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(
          path.join(index % 2 === 0 ? runtimeRoot : path.join(runtimeRoot, "nested"), `file-${index}.txt`),
          `payload-${index}\n`,
          "utf8"
        )
      )
    );

    const localWorkspaceFileSystem = createLocalWorkspaceFileSystem();
    const baseCommandExecutor = createLocalWorkspaceCommandExecutor();
    const sandboxHost: SandboxHost = {
      providerKind: "self_hosted",
      workspaceCommandExecutor: baseCommandExecutor,
      workspaceFileSystem: {
        ...localWorkspaceFileSystem,
        async writeFile(targetPath, data, options) {
          await mkdir(path.dirname(targetPath), { recursive: true });
          await localWorkspaceFileSystem.writeFile(targetPath, data, options);
        }
      },
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteWorkspaceRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          id: "ws_remote_archive_cache",
          workspaceId: "ws_remote_archive_cache",
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox",
          rootPath: "/workspace",
          name: "remote-archive-cache",
          kind: "project",
          executionPolicy: "local",
          createdAt: "2026-04-24T00:00:00.000Z",
          updatedAt: "2026-04-24T00:00:00.000Z"
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost,
      selfHosted: {
        baseUrl: "http://127.0.0.1:8787/internal/v1"
      }
    });

    const tempRootEntriesBefore = new Set(
      (await readdir(os.tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("oah-sandbox-prepared-seed-"))
        .map((entry) => entry.name)
    );

    await initializer.initialize({
      name: "archive-cache-seed",
      runtime: "workspace",
      executionPolicy: "local"
    });

    const preparedSeedArchives = await Promise.all(
      (await readdir(os.tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("oah-sandbox-prepared-seed-"))
        .map(async (entry) => {
          const archivePath = path.join(os.tmpdir(), entry.name, "workspace-seed.tar");
          const archiveStat = await stat(archivePath).catch(() => undefined);
          return archiveStat && !tempRootEntriesBefore.has(entry.name)
            ? {
                archivePath,
                archiveStat
              }
            : undefined;
        })
    );
    const preparedSeedArchive = preparedSeedArchives.find(
      (entry): entry is { archivePath: string; archiveStat: Awaited<ReturnType<typeof stat>> } => Boolean(entry)
    );

    expect(preparedSeedArchive).toBeDefined();

    const { archivePath, archiveStat: firstArchiveStat } = preparedSeedArchive!;

    await new Promise((resolve) => setTimeout(resolve, 20));

    await initializer.initialize({
      name: "archive-cache-seed",
      runtime: "workspace",
      executionPolicy: "local"
    });

    const secondArchiveStat = await stat(archivePath);
    expect(secondArchiveStat.mtimeMs).toBe(firstArchiveStat.mtimeMs);
  });

  it("uses native self-hosted sandbox upload when enabled", async () => {
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC", "1");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-native-self-hosted-workspace-init-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteWorkspaceRoot = path.join(tempDir, "remote-workspace");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteWorkspaceRoot, { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(runtimeRoot, "README.md"), "# Native seeded\n", "utf8"),
      writeFile(path.join(runtimeRoot, "nested", "notes.txt"), "native path\n", "utf8")
    ]);

    const localWorkspaceFileSystem = createLocalWorkspaceFileSystem();
    const writeFileSpy = vi.fn<typeof localWorkspaceFileSystem.writeFile>();
    const sandboxHost: SandboxHost = {
      providerKind: "self_hosted",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: {
        ...localWorkspaceFileSystem,
        async writeFile(targetPath, data, options) {
          writeFileSpy(targetPath, data, options);
          throw new Error("expected native sandbox upload path");
        }
      },
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteWorkspaceRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "ws_remote_native_seed",
          workspaceId: "ws_remote_native_seed",
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox",
          rootPath: "/workspace",
          name: "remote-native-seed",
          kind: "project",
          executionPolicy: "local",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const nativeSyncSpy = vi.spyOn(nativeWorkspaceSyncAdapter, "syncLocalToSandboxHttp").mockImplementation(async (input) => {
      expect(input.remoteRootPath).toBe("/workspace");
      expect(input.sandbox.sandboxId).toBe("ws_remote_native_seed");
      await mkdir(path.join(remoteWorkspaceRoot, ".openharness"), { recursive: true });
      await mkdir(path.join(remoteWorkspaceRoot, "nested"), { recursive: true });
      await Promise.all([
        writeFile(path.join(remoteWorkspaceRoot, "README.md"), "# Native seeded\n", "utf8"),
        writeFile(path.join(remoteWorkspaceRoot, "nested", "notes.txt"), "native path\n", "utf8"),
        writeFile(path.join(remoteWorkspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\nruntime: workspace\n", "utf8")
      ]);
      return {
        ok: true,
        protocolVersion: 1,
        localFingerprint: "seed-fingerprint",
        createdDirectoryCount: 3,
        uploadedFileCount: 3
      };
    });
    const fingerprintSpy = vi
      .spyOn(nativeWorkspaceSyncAdapter, "computeDirectoryFingerprint")
      .mockImplementation(async ({ rootDir }) => ({
        ok: true,
        protocolVersion: 1,
        fingerprint: `fp:${rootDir}`,
        fileCount: 1,
        emptyDirectoryCount: 0
      }));
    const fingerprintBatchSpy = vi
      .spyOn(nativeWorkspaceSyncAdapter, "computeDirectoryFingerprintBatch")
      .mockImplementation(async ({ directories }) => ({
        ok: true,
        protocolVersion: 1,
        results: directories.map((directory) => ({
          rootDir: directory.rootDir,
          fingerprint: `fp:${directory.rootDir}`,
          fileCount: 1,
          emptyDirectoryCount: 0
        }))
      }));

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost,
      selfHosted: {
        baseUrl: "http://127.0.0.1:8787/internal/v1",
        headers: {
          authorization: "Bearer test-token"
        }
      }
    });

    const initialized = await initializer.initialize({
      name: "remote-native-seed",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(initialized.rootPath).toBe("/workspace");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(nativeSyncSpy).toHaveBeenCalledTimes(1);
    expect(fingerprintBatchSpy).toHaveBeenCalledTimes(1);
    expect(fingerprintSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    await expect(readFile(path.join(remoteWorkspaceRoot, "README.md"), "utf8")).resolves.toBe("# Native seeded\n");
    await expect(readFile(path.join(remoteWorkspaceRoot, "nested", "notes.txt"), "utf8")).resolves.toBe("native path\n");
  });

  it("uploads workspace seed files with bounded concurrency", async () => {
    vi.stubEnv("OAH_SANDBOX_SEED_UPLOAD_CONCURRENCY", "4");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-concurrent-workspace-init-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteWorkspaceRoot = path.join(tempDir, "remote-workspace");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteWorkspaceRoot, { recursive: true })
    ]);

    await writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeFile(
          path.join(index % 2 === 0 ? runtimeRoot : path.join(runtimeRoot, "nested"), `file-${index}.txt`),
          `payload-${index}\n`,
          "utf8"
        )
      )
    );

    let inFlightWrites = 0;
    let maxConcurrentWrites = 0;
    const localWorkspaceFileSystem = createLocalWorkspaceFileSystem();

    const sandboxHost: SandboxHost = {
      providerKind: "embedded",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: {
        ...localWorkspaceFileSystem,
        async writeFile(targetPath, data, options) {
          inFlightWrites += 1;
          maxConcurrentWrites = Math.max(maxConcurrentWrites, inFlightWrites);
          await new Promise((resolve) => setTimeout(resolve, 20));
          try {
            await localWorkspaceFileSystem.writeFile(targetPath, data, options);
          } finally {
            inFlightWrites = Math.max(0, inFlightWrites - 1);
          }
        }
      },
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteWorkspaceRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "embedded",
          executionModel: "local_embedded",
          workerPlacement: "api_process"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost
    });

    await initializer.initialize({
      name: "concurrent-seed",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(maxConcurrentWrites).toBeGreaterThan(1);
    await expect(readFile(path.join(remoteWorkspaceRoot, "file-0.txt"), "utf8")).resolves.toBe("payload-0\n");
    await expect(readFile(path.join(remoteWorkspaceRoot, "nested", "file-1.txt"), "utf8")).resolves.toBe("payload-1\n");
  });

  it("reuses prepared runtime seeds for repeated workspace creation with the same inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-prepared-seed-cache-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteRootA = path.join(tempDir, "remote-a");
    const remoteRootB = path.join(tempDir, "remote-b");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteRootA, { recursive: true }),
      mkdir(remoteRootB, { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(runtimeRoot, "README.md"), "# Seeded once\n", "utf8")
    ]);

    const initializeSpy = vi.spyOn(configModule, "initializeWorkspaceFromRuntime");
    const discoverSpy = vi.spyOn(configModule, "discoverWorkspace");

    let leaseIndex = 0;
    const remoteRoots = [remoteRootA, remoteRootB];
    const sandboxHost: SandboxHost = {
      providerKind: "embedded",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: createLocalWorkspaceFileSystem(),
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          const rootPath = remoteRoots[leaseIndex] ?? remoteRoots.at(-1)!;
          leaseIndex += 1;
          return {
            workspace: {
              ...input.workspace,
              rootPath
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "embedded",
          executionModel: "local_embedded",
          workerPlacement: "api_process"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost
    });

    await initializer.initialize({
      name: "seed-a",
      runtime: "workspace",
      executionPolicy: "local"
    });
    await initializer.initialize({
      name: "seed-b",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(initializeSpy).toHaveBeenCalledTimes(1);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(remoteRootA, "README.md"), "utf8")).resolves.toBe("# Seeded once\n");
    await expect(readFile(path.join(remoteRootB, "README.md"), "utf8")).resolves.toBe("# Seeded once\n");
  });

  it("reuses self-hosted listing metadata to avoid per-file stat calls and redundant non-empty directory mkdirs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-self-hosted-seed-metadata-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteRoot = path.join(tempDir, "remote-root");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteRoot, { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(runtimeRoot, "README.md"), "# HTTP metadata\n", "utf8"),
      writeFile(path.join(runtimeRoot, "nested", "notes.txt"), "no extra stats please\n", "utf8")
    ]);

    let statCalls = 0;
    let mkdirCalls = 0;
    let writeFileCalls = 0;
    const localWorkspaceFileSystem = createLocalWorkspaceFileSystem();
    const sandboxHost: SandboxHost = {
      providerKind: "self_hosted",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: {
        ...localWorkspaceFileSystem,
        async readdir(targetPath) {
          const entries = await localWorkspaceFileSystem.readdir(targetPath);
          return Promise.all(
            entries.map(async (entry) => {
              const absolutePath = path.join(targetPath, entry.name);
              const entryStat = await stat(absolutePath).catch(() => null);
              return {
                ...entry,
                ...(entryStat?.isFile() ? { sizeBytes: Number(entryStat.size) } : {}),
                ...(entryStat?.mtime ? { updatedAt: entryStat.mtime.toISOString() } : {})
              };
            })
          );
        },
        async stat(targetPath) {
          statCalls += 1;
          return localWorkspaceFileSystem.stat(targetPath);
        },
        async mkdir(targetPath, options) {
          mkdirCalls += 1;
          return localWorkspaceFileSystem.mkdir(targetPath, options);
        },
        async writeFile(targetPath, data, options) {
          writeFileCalls += 1;
          await mkdir(path.dirname(targetPath), { recursive: true });
          await localWorkspaceFileSystem.writeFile(targetPath, data, options);
        }
      },
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost
    });

    await initializer.initialize({
      name: "seed-http-a",
      runtime: "workspace",
      executionPolicy: "local"
    });

    const statCallsAfterFirstInit = statCalls;
    const mkdirCallsAfterFirstInit = mkdirCalls;
    const writeFileCallsAfterFirstInit = writeFileCalls;

    await initializer.initialize({
      name: "seed-http-b",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(writeFileCallsAfterFirstInit).toBeGreaterThan(0);
    expect(writeFileCalls).toBe(writeFileCallsAfterFirstInit);
    expect(statCalls - statCallsAfterFirstInit).toBe(1);
    expect(mkdirCalls - mkdirCallsAfterFirstInit).toBe(0);
    await expect(readFile(path.join(remoteRoot, "README.md"), "utf8")).resolves.toBe("# HTTP metadata\n");
    await expect(readFile(path.join(remoteRoot, "nested", "notes.txt"), "utf8")).resolves.toBe("no extra stats please\n");
  });

  it("removes stale remote seed entries and fixes file-directory mismatches before upload", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-seed-upload-prune-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteRoot = path.join(tempDir, "remote-root");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(path.join(remoteRoot, "old-dir"), { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(runtimeRoot, "README.md"), "# Fresh seed\n", "utf8"),
      writeFile(path.join(runtimeRoot, "nested", "notes.txt"), "fresh note\n", "utf8"),
      writeFile(path.join(remoteRoot, "stale.txt"), "remove me\n", "utf8"),
      writeFile(path.join(remoteRoot, "nested"), "wrong type\n", "utf8"),
      writeFile(path.join(remoteRoot, "old-dir", "ghost.txt"), "ghost\n", "utf8")
    ]);

    const sandboxHost: SandboxHost = {
      providerKind: "embedded",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: createLocalWorkspaceFileSystem(),
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "embedded",
          executionModel: "local_embedded",
          workerPlacement: "api_process"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost
    });

    await initializer.initialize({
      name: "seed-cleanup",
      runtime: "workspace",
      executionPolicy: "local"
    });

    await expect(stat(path.join(remoteRoot, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(remoteRoot, "old-dir"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(remoteRoot, "nested"))).isDirectory()).toBe(true);
    await expect(readFile(path.join(remoteRoot, "nested", "notes.txt"), "utf8")).resolves.toBe("fresh note\n");
    await expect(readFile(path.join(remoteRoot, "README.md"), "utf8")).resolves.toBe("# Fresh seed\n");
  });

  it("reuses the prepared seed root directly without creating extra staging copies", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-prepared-seed-direct-upload-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteRootA = path.join(tempDir, "remote-a");
    const remoteRootB = path.join(tempDir, "remote-b");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteRootA, { recursive: true }),
      mkdir(remoteRootB, { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(runtimeRoot, "README.md"), "# Seeded once\n", "utf8")
    ]);

    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const mkdtempSpy = vi.fn(actualFs.mkdtemp);

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      mkdtemp: mkdtempSpy
    }));

    const { createSandboxBackedWorkspaceInitializer: createInitializer } = await import(
      "../apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts"
    );

    let leaseIndex = 0;
    const remoteRoots = [remoteRootA, remoteRootB];
    const sandboxHost: SandboxHost = {
      providerKind: "embedded",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: createLocalWorkspaceFileSystem(),
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          const rootPath = remoteRoots[leaseIndex] ?? remoteRoots.at(-1)!;
          leaseIndex += 1;
          return {
            workspace: {
              ...input.workspace,
              rootPath
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "embedded",
          executionModel: "local_embedded",
          workerPlacement: "api_process"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const initializer = createInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost
    });

    await initializer.initialize({
      name: "seed-a",
      runtime: "workspace",
      executionPolicy: "local"
    });
    await initializer.initialize({
      name: "seed-b",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(mkdtempSpy).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(remoteRootA, "README.md"), "utf8")).resolves.toBe("# Seeded once\n");
    await expect(readFile(path.join(remoteRootB, "README.md"), "utf8")).resolves.toBe("# Seeded once\n");
  });
});
