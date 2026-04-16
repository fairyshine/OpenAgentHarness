import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createE2BCompatibleSandboxHost } from "../apps/server/src/bootstrap/e2b-compatible-sandbox-host.ts";
import { bootstrapRuntime } from "../apps/server/src/bootstrap.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (targetPath) => {
      await rm(targetPath, { recursive: true, force: true });
    })
  );
});

function createFilesystemBackedSandboxHost(baseDir: string) {
  const sandboxRoots = new Map<string, string>();

  async function ensureSandbox(workspaceId: string): Promise<{
    sandboxId: string;
    rootPath: string;
    release(options?: { dirty?: boolean | undefined }): Promise<void>;
  }> {
    const existing = sandboxRoots.get(workspaceId);
    if (existing) {
      return {
        sandboxId: workspaceId,
        rootPath: "/workspace",
        async release() {
          return undefined;
        }
      };
    }

    const sandboxRoot = path.join(baseDir, workspaceId);
    await mkdir(sandboxRoot, { recursive: true });
    sandboxRoots.set(workspaceId, sandboxRoot);
    return {
      sandboxId: workspaceId,
      rootPath: "/workspace",
      async release() {
        return undefined;
      }
    };
  }

  function resolveSandboxPath(sandboxId: string, remotePath: string): string {
    const sandboxRoot = sandboxRoots.get(sandboxId);
    if (!sandboxRoot) {
      throw new Error(`Sandbox ${sandboxId} was not initialized.`);
    }

    const absolutePath = path.join(sandboxRoot, remotePath.replace(/^\/+/u, ""));
    return absolutePath;
  }

  return {
    sandboxRoots,
    host: createE2BCompatibleSandboxHost({
      providerKind: "e2b",
      service: {
        async acquireExecution(input) {
          return ensureSandbox(input.workspace.id);
        },
        async acquireFileAccess(input) {
          return ensureSandbox(input.workspace.id);
        },
        async runCommand() {
          return {
            stdout: "",
            stderr: "",
            exitCode: 0
          };
        },
        async runProcess() {
          return {
            stdout: "",
            stderr: "",
            exitCode: 0
          };
        },
        async runBackground() {
          return {
            outputPath: "/tmp/oah-background.log",
            taskId: "task-1",
            pid: 1
          };
        },
        async stat(input) {
          const entry = await stat(resolveSandboxPath(input.sandboxId, input.path));
          return {
            kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            birthtimeMs: entry.birthtimeMs
          };
        },
        async readFile(input) {
          return readFile(resolveSandboxPath(input.sandboxId, input.path));
        },
        async readdir(input) {
          const entries = await readdir(resolveSandboxPath(input.sandboxId, input.path), { withFileTypes: true });
          return entries.map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? ("directory" as const) : ("file" as const)
          }));
        },
        async mkdir(input) {
          await mkdir(resolveSandboxPath(input.sandboxId, input.path), { recursive: input.recursive ?? false });
        },
        async writeFile(input) {
          const targetPath = resolveSandboxPath(input.sandboxId, input.path);
          await mkdir(path.dirname(targetPath), { recursive: true });
          await writeFile(targetPath, input.data);
        },
        async rm(input) {
          await rm(resolveSandboxPath(input.sandboxId, input.path), {
            recursive: input.recursive ?? false,
            force: input.force ?? false
          });
        },
        async rename(input) {
          const targetPath = resolveSandboxPath(input.sandboxId, input.targetPath);
          await mkdir(path.dirname(targetPath), { recursive: true });
          await rename(resolveSandboxPath(input.sandboxId, input.sourcePath), targetPath);
        },
        async close() {
          return undefined;
        }
      }
    })
  };
}

describe("bootstrap remote sandbox mode", () => {
  it("does not treat local workspace_dir as runtime truth for e2b-backed workspaces", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-remote-sandbox-bootstrap-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const blueprintDir = path.join(tempDir, "blueprints");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const sandboxRootsDir = path.join(tempDir, "sandbox-roots");
    const configPath = path.join(tempDir, "server.yaml");
    const ignoredLocalWorkspace = path.join(workspaceDir, "ignored-local-workspace");
    const blueprintRoot = path.join(blueprintDir, "workspace");

    tempDirs.push(sandboxRootsDir);

    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(blueprintRoot, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(sandboxRootsDir, { recursive: true }),
      mkdir(path.join(ignoredLocalWorkspace, ".openharness"), { recursive: true }),
      mkdir(path.join(blueprintRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(blueprintRoot, "nested"), { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(ignoredLocalWorkspace, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(ignoredLocalWorkspace, "README.md"), "this local workspace should be ignored\n", "utf8"),
      writeFile(path.join(blueprintRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(blueprintRoot, "README.md"), "# Remote Blueprint\n", "utf8"),
      writeFile(path.join(blueprintRoot, "nested", "deep.txt"), "uploaded into sandbox\n", "utf8"),
      writeFile(
        path.join(modelsDir, "openai.yaml"),
        `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
        "utf8"
      ),
      writeFile(
        configPath,
        `
server:
  host: 127.0.0.1
  port: 8787
storage: {}
paths:
  workspace_dir: ./workspaces
  blueprint_dir: ./blueprints
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
sandbox:
  provider: e2b
  e2b:
    base_url: https://sandbox.example.test/internal/v1
`,
        "utf8"
      )
    ]);

    const sandboxHost = createFilesystemBackedSandboxHost(sandboxRootsDir);
    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api",
      sandboxHostFactory: async () => sandboxHost.host
    });

    try {
      expect(runtime.importWorkspace).toBeUndefined();

      const beforeCreate = await runtime.runtimeService.listWorkspaces(20);
      expect(beforeCreate.items).toEqual([]);

      const workspace = await runtime.runtimeService.createWorkspace({
        input: {
          name: "Remote Sandbox Workspace",
          blueprint: "workspace"
        }
      });

      expect(workspace.rootPath).toBe("/workspace");

      const afterCreate = await runtime.runtimeService.listWorkspaces(20);
      expect(afterCreate.items).toHaveLength(1);
      expect(afterCreate.items[0]).toMatchObject({
        id: workspace.id,
        name: "Remote Sandbox Workspace",
        rootPath: "/workspace"
      });

      const nestedFile = await runtime.runtimeService.getWorkspaceFileContent(workspace.id, {
        path: "nested/deep.txt",
        encoding: "utf8"
      });
      expect(nestedFile).toMatchObject({
        path: "nested/deep.txt",
        content: "uploaded into sandbox\n"
      });

      const sandboxRoot = sandboxHost.sandboxRoots.get(workspace.id);
      expect(sandboxRoot).toBeDefined();
      await expect(readFile(path.join(sandboxRoot!, "workspace", "README.md"), "utf8")).resolves.toBe("# Remote Blueprint\n");
      await expect(readFile(path.join(sandboxRoot!, "workspace", "nested", "deep.txt"), "utf8")).resolves.toBe(
        "uploaded into sandbox\n"
      );
    } finally {
      await runtime.close();
    }
  });
});
