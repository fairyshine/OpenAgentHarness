import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as configModule from "@oah/config";
import * as nativeBridge from "@oah/native-bridge";
import { createLocalWorkspaceCommandExecutor, createLocalWorkspaceFileSystem, type WorkspaceRecord } from "@oah/engine-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxBackedWorkspaceInitializer } from "../apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts";
import type { SandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map(async (targetPath) => {
      await rm(targetPath, { recursive: true, force: true });
    })
  );
});

describe("sandbox-backed workspace initializer", () => {
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

    const sandboxHost: SandboxHost = {
      providerKind: "self_hosted",
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

    const nativeSyncSpy = vi.spyOn(nativeBridge, "syncNativeLocalToSandboxHttp").mockImplementation(async (input) => {
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
});
