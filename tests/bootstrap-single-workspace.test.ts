import { access, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildWorkspaceId } from "@oah/config";
import { createE2BCompatibleSandboxHost } from "../apps/server/src/bootstrap/e2b-compatible-sandbox-host.ts";

import {
  bootstrapRuntime,
  cleanupWorkspaceLocalArtifacts,
  findManagedWorkspaceIdsToDelete,
  reconcileDiscoveredWorkspaces
} from "../apps/server/src/bootstrap.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out while waiting for condition.");
}

function seedLegacyMirrorDatabase(dbPath: string, workspaceId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table if not exists sessions (
        id text primary key,
        workspace_id text not null,
        subject_ref text not null,
        agent_name text,
        active_agent_name text not null,
        title text,
        status text not null,
        last_run_at text,
        created_at text not null,
        updated_at text not null
      );
    `);
    db.prepare(
      `insert into sessions
       (id, workspace_id, subject_ref, agent_name, active_agent_name, title, status, last_run_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "ses_bootstrap_legacy",
      workspaceId,
      "dev:test",
      "assistant",
      "assistant",
      "restored from copied workspace",
      "active",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );
  } finally {
    db.close();
  }
}

describe("bootstrap single workspace mode", () => {
  it("cleans local workspace artifacts for deleted workspaces without always deleting the root", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-workspace-cleanup-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const shadowRoot = path.join(workspaceDir, ".openharness", "data", "workspace-state");
    const externalProjectRoot = path.join(tempDir, "external-project");
    const managedProjectRoot = path.join(workspaceDir, "managed-demo");
    const externalProjectDbPath = path.join(externalProjectRoot, ".openharness", "data", "history.db");
    const shadowDbPath = path.join(shadowRoot, "ws_external_read_only", "history.db");

    await Promise.all([
      mkdir(path.dirname(externalProjectDbPath), { recursive: true }),
      mkdir(path.dirname(shadowDbPath), { recursive: true }),
      mkdir(managedProjectRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(externalProjectDbPath, "project-db", "utf8"),
      writeFile(shadowDbPath, "shadow-db", "utf8"),
      writeFile(path.join(managedProjectRoot, "note.txt"), "project-root", "utf8")
    ]);

    const projectCleanup = await cleanupWorkspaceLocalArtifacts({
      workspace: {
        id: "ws_external_project",
        name: "external-project",
        rootPath: externalProjectRoot,
        executionPolicy: "local",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        kind: "project",
        readOnly: false,
        historyMirrorEnabled: true,
        settings: {
          defaultAgent: "assistant",
          skillDirs: []
        },
        defaultAgent: "assistant",
        workspaceModels: {},
        agents: {},
        actions: {},
        skills: {},
        toolServers: {},
        hooks: {},
        catalog: {
          workspaceId: "ws_external_project",
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      },
      paths: {
        workspace_dir: workspaceDir
      },
      sqliteShadowRoot: shadowRoot
    });
    const readOnlyProjectCleanup = await cleanupWorkspaceLocalArtifacts({
      workspace: {
        id: "ws_external_read_only",
        name: "external-read-only",
        rootPath: path.join(tempDir, "external-read-only"),
        executionPolicy: "local",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        kind: "project",
        readOnly: true,
        historyMirrorEnabled: true,
        settings: {
          defaultAgent: "assistant",
          skillDirs: []
        },
        defaultAgent: "assistant",
        workspaceModels: {},
        agents: {},
        actions: {},
        skills: {},
        toolServers: {},
        hooks: {},
        catalog: {
          workspaceId: "ws_external_read_only",
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      },
      paths: {
        workspace_dir: workspaceDir
      },
      sqliteShadowRoot: shadowRoot
    });
    const managedProjectCleanup = await cleanupWorkspaceLocalArtifacts({
      workspace: {
        id: "ws_managed_project",
        name: "managed-project",
        rootPath: managedProjectRoot,
        executionPolicy: "local",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        kind: "project",
        readOnly: false,
        historyMirrorEnabled: true,
        settings: {
          defaultAgent: "assistant",
          skillDirs: []
        },
        defaultAgent: "assistant",
        workspaceModels: {},
        agents: {},
        actions: {},
        skills: {},
        toolServers: {},
        hooks: {},
        catalog: {
          workspaceId: "ws_managed_project",
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      },
      paths: {
        workspace_dir: workspaceDir
      },
      sqliteShadowRoot: shadowRoot
    });

    expect(projectCleanup.mode).toBe("history_db");
    expect(readOnlyProjectCleanup.mode).toBe("shadow_history_db");
    expect(managedProjectCleanup.mode).toBe("workspace_root");
    await expect(access(externalProjectRoot)).resolves.toBeUndefined();
    await expect(access(externalProjectDbPath)).rejects.toBeDefined();
    await expect(access(shadowDbPath)).rejects.toBeDefined();
    await expect(access(managedProjectRoot)).rejects.toBeDefined();
  });

  it("reuses persisted workspace ids for rediscovered roots", async () => {
    const discovered = {
      id: buildWorkspaceId("project", "repo", "/tmp/repo"),
      name: "repo",
      rootPath: "/tmp/repo",
      executionPolicy: "local" as const,
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      kind: "project" as const,
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
        workspaceId: "blueprint",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    };

    const reconciled = reconcileDiscoveredWorkspaces([discovered], [
      {
        ...discovered,
        id: "ws_legacy_random",
        name: "Renamed Workspace",
        executionPolicy: "remote",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z"
      }
    ]);

    expect(reconciled).toEqual([
      expect.objectContaining({
        id: "ws_legacy_random",
        name: "Renamed Workspace",
        rootPath: "/tmp/repo",
        executionPolicy: "remote",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z"
      })
    ]);
  });

  it("deletes stale and duplicate managed workspaces during sync planning", async () => {
    const discovered = [
      {
        id: buildWorkspaceId("project", "repo", "/tmp/workspaces/repo"),
        name: "repo",
        rootPath: "/tmp/workspaces/repo",
        executionPolicy: "local" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        kind: "project" as const,
        readOnly: false,
        historyMirrorEnabled: true,
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
          workspaceId: "blueprint",
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      }
    ];

    const staleIds = findManagedWorkspaceIdsToDelete(
      discovered,
      [
        {
          ...discovered[0],
          id: "ws_latest_random",
          updatedAt: "2026-01-03T00:00:00.000Z"
        },
        {
          ...discovered[0],
          id: "ws_older_random",
          updatedAt: "2026-01-02T00:00:00.000Z"
        },
        {
          ...discovered[0],
          id: "ws_missing_workspace",
          rootPath: "/tmp/workspaces/removed",
          name: "removed"
        },
        {
          ...discovered[0],
          id: "ws_external_workspace",
          rootPath: "/tmp/external/repo",
          name: "external"
        }
      ],
      {
        workspace_dir: "/tmp/workspaces"
      }
    );

    expect(staleIds).toEqual(["ws_older_random", "ws_missing_workspace"]);
  });

  it("boots a single workspace directly from CLI flags without a server config file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-single-workspace-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "repo");
    const modelsDir = path.join(tempDir, "models");
    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true }),
      mkdir(modelsDir, { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );

    const runtime = await bootstrapRuntime({
      argv: ["--workspace", workspaceRoot, "--model-dir", modelsDir, "--default-model", "openai-default"],
      startWorker: false,
      processKind: "api"
    });

    try {
      const expectedWorkspaceId = buildWorkspaceId("project", "repo", workspaceRoot);
      expect(runtime.workspaceMode).toEqual({
        kind: "single",
        workspaceId: expectedWorkspaceId,
        workspaceKind: "project",
        rootPath: workspaceRoot
      });
      expect(runtime.listWorkspaceBlueprints).toBeUndefined();
      expect(runtime.importWorkspace).toBeUndefined();

      const workspacePage = await runtime.runtimeService.listWorkspaces(10);
      expect(workspacePage.items).toHaveLength(1);
      expect(workspacePage.items[0]).toMatchObject({
        id: expectedWorkspaceId,
        rootPath: workspaceRoot,
        kind: "project"
      });
      expect(runtime.config.paths.model_dir).toBe(modelsDir);
      expect(runtime.config.llm.default_model).toBe("openai-default");
      await expect(runtime.healthReport()).resolves.toMatchObject({
        storage: {
          primary: "sqlite"
        },
        worker: {
          mode: "disabled",
          activeWorkers: [],
          summary: {
            active: 0,
            healthy: 0,
            late: 0,
            busy: 0,
            embedded: 0,
            standalone: 0
          },
          pool: null
        }
      });
    } finally {
      await runtime.close();
    }
  });

  it("accepts an injected e2b-compatible sandbox host factory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-single-workspace-e2b-host-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "repo");
    const modelsDir = path.join(tempDir, "models");
    const hostOperations: string[] = [];
    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true }),
      mkdir(modelsDir, { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );

    const runtime = await bootstrapRuntime({
      argv: ["--workspace", workspaceRoot, "--model-dir", modelsDir, "--default-model", "openai-default"],
      startWorker: false,
      processKind: "api",
      sandboxHostFactory: async () =>
        createE2BCompatibleSandboxHost({
          service: {
            async acquireExecution(input) {
              return {
                sandboxId: "sandbox-1",
                rootPath: `/workspace/${input.workspace.id}`,
                async release() {}
              };
            },
            async acquireFileAccess(input) {
              return {
                sandboxId: "sandbox-1",
                rootPath: `/workspace/${input.workspace.id}`,
                async release() {}
              };
            },
            async runCommand() {
              return { stdout: "", stderr: "", exitCode: 0 };
            },
            async runProcess() {
              return { stdout: "", stderr: "", exitCode: 0 };
            },
            async runBackground() {
              return { outputPath: "/tmp/log", taskId: "task-1", pid: 1 };
            },
            async stat() {
              return { kind: "directory" as const, size: 0, mtimeMs: 0, birthtimeMs: 0 };
            },
            async readFile() {
              return Buffer.from("");
            },
            async readdir() {
              return [];
            },
            async mkdir() {
              return undefined;
            },
            async writeFile() {
              return undefined;
            },
            async rm() {
              return undefined;
            },
            async rename() {
              return undefined;
            },
            diagnostics() {
              return {
                provider: "fake-e2b"
              };
            },
            async maintain() {
              hostOperations.push("maintain");
            },
            async beginDrain() {
              hostOperations.push("beginDrain");
            },
            async close() {
              hostOperations.push("close");
            }
          }
        })
    });

    try {
      await runtime.beginDrain();
      await expect(runtime.healthReport()).resolves.toMatchObject({
        worker: {
          mode: "disabled"
        }
      });
    } finally {
      await runtime.close();
    }

    expect(hostOperations).toContain("beginDrain");
    expect(hostOperations).toContain("close");
  });

  it("skips invalid platform model files during multi-workspace bootstrap and logs the failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-bad-platform-model-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const blueprintsDir = path.join(tempDir, "blueprints");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const workspaceRoot = path.join(workspaceDir, "good-repo");
    const configPath = path.join(tempDir, "server.yaml");
    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true }),
      mkdir(blueprintsDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "valid.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
      path.join(modelsDir, "broken.yaml"),
      `
broken-provider:
  provider: openai-compatible
  key: \${env.MISSING_PLATFORM_MODEL_KEY}
  url: https://example.test/v1
  name: broken-model
`,
      "utf8"
    );
    await writeFile(
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
`,
      "utf8"
    );

    delete process.env.MISSING_PLATFORM_MODEL_KEY;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      await expect(runtime.listPlatformModels?.()).resolves.toEqual([
        expect.objectContaining({
          id: "openai-default",
          provider: "openai",
          modelName: "gpt-4o-mini",
          isDefault: true
        })
      ]);

      const workspaces = await runtime.runtimeService.listWorkspaces(10);
      expect(workspaces.items).toEqual([
        expect.objectContaining({
          rootPath: workspaceRoot,
          kind: "project"
        })
      ]);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load model definition"),
        expect.any(Error)
      );
      expect(consoleErrorSpy.mock.calls.some(([message]) => String(message).includes("broken.yaml"))).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
      await runtime.close();
    }
  });

  it("skips invalid workspaces during multi-workspace bootstrap and logs the failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-bad-workspace-model-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const blueprintsDir = path.join(tempDir, "blueprints");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const goodWorkspaceRoot = path.join(workspaceDir, "good-repo");
    const badWorkspaceRoot = path.join(workspaceDir, "broken-repo");
    const configPath = path.join(tempDir, "server.yaml");
    await Promise.all([
      mkdir(path.join(goodWorkspaceRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(badWorkspaceRoot, ".openharness", "models"), { recursive: true }),
      mkdir(blueprintsDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true })
    ]);

    await writeFile(path.join(goodWorkspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(path.join(badWorkspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(badWorkspaceRoot, ".openharness", "models", "broken.yaml"),
      `
workspace-broken:
  provider: openai
  key: \${env.MISSING_WORKSPACE_MODEL_KEY}
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
      path.join(modelsDir, "valid.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
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
`,
      "utf8"
    );

    delete process.env.MISSING_WORKSPACE_MODEL_KEY;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      const workspaces = await runtime.runtimeService.listWorkspaces(10);
      expect(workspaces.items).toEqual([
        expect.objectContaining({
          rootPath: goodWorkspaceRoot,
          kind: "project"
        })
      ]);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to discover project workspace"),
        expect.any(Error)
      );
      expect(consoleErrorSpy.mock.calls.some(([message]) => String(message).includes("broken-repo"))).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
      await runtime.close();
    }
  });

  it("fails fast when configured postgres storage is unavailable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-single-workspace-pg-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "repo");
    const modelsDir = path.join(tempDir, "models");
    const configPath = path.join(tempDir, "server.yaml");
    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(path.join(tempDir, "workspaces"), { recursive: true }),
      mkdir(path.join(tempDir, "blueprints"), { recursive: true }),
      mkdir(path.join(tempDir, "tools"), { recursive: true }),
      mkdir(path.join(tempDir, "skills"), { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage:
  postgres_url: postgres://127.0.0.1:9/oah_test
paths:
  workspace_dir: ./workspaces
  blueprint_dir: ./blueprints
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    await expect(
      bootstrapRuntime({
        argv: ["--config", configPath, "--workspace", workspaceRoot, "--model-dir", modelsDir, "--default-model", "openai-default"],
        startWorker: false,
        processKind: "api"
      })
    ).rejects.toThrow(/Configured PostgreSQL persistence is unavailable/);
  });

  it("recovers copied workspace history from a legacy history.db inside workspace_dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-legacy-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const blueprintsDir = path.join(tempDir, "blueprints");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const workspaceRoot = path.join(workspaceDir, "copied-repo");
    const configPath = path.join(tempDir, "server.yaml");
    const historyDbPath = path.join(workspaceRoot, ".openharness", "data", "history.db");

    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness", "data"), { recursive: true }),
      mkdir(blueprintsDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
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
`,
      "utf8"
    );

    seedLegacyMirrorDatabase(historyDbPath, buildWorkspaceId("project", "copied-repo", workspaceRoot));

    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      const workspacePage = await runtime.runtimeService.listWorkspaces(10);
      expect(workspacePage.items).toHaveLength(1);
      const workspace = workspacePage.items[0]!;
      expect(workspace.id).toBe(buildWorkspaceId("project", "copied-repo", workspaceRoot));

      const sessions = await runtime.runtimeService.listWorkspaceSessions(workspace.id, 10);
      expect(sessions.items).toEqual([
        expect.objectContaining({
          id: "ses_bootstrap_legacy",
          title: "restored from copied workspace"
        })
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("hot-discovers copied workspaces in workspace_dir and restores legacy history", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-hot-import-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const blueprintsDir = path.join(tempDir, "blueprints");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const stagingRoot = path.join(tempDir, "staging-repo");
    const finalWorkspaceRoot = path.join(workspaceDir, "copied-repo");
    const configPath = path.join(tempDir, "server.yaml");
    const expectedWorkspaceId = buildWorkspaceId("project", "copied-repo", finalWorkspaceRoot);

    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(blueprintsDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(path.join(stagingRoot, ".openharness", "data"), { recursive: true })
    ]);

    await writeFile(path.join(stagingRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
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
`,
      "utf8"
    );

    seedLegacyMirrorDatabase(path.join(stagingRoot, ".openharness", "data", "history.db"), expectedWorkspaceId);

    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      await expect(runtime.runtimeService.listWorkspaces(10)).resolves.toMatchObject({
        items: []
      });

      await rename(stagingRoot, finalWorkspaceRoot);
      await writeFile(path.join(workspaceDir, ".sync-trigger"), `${Date.now()}\n`, "utf8");

      await waitFor(async () => {
        const page = await runtime.runtimeService.listWorkspaces(10);
        return page.items.some((workspace) => workspace.id === expectedWorkspaceId);
      }, 8_000);

      const workspacePage = await runtime.runtimeService.listWorkspaces(10);
      expect(workspacePage.items).toEqual([
        expect.objectContaining({
          id: expectedWorkspaceId,
          rootPath: finalWorkspaceRoot
        })
      ]);

      const sessions = await runtime.runtimeService.listWorkspaceSessions(expectedWorkspaceId, 10);
      expect(sessions.items).toEqual([
        expect.objectContaining({
          id: "ses_bootstrap_legacy",
          title: "restored from copied workspace"
        })
      ]);

      await rm(finalWorkspaceRoot, { recursive: true, force: true });

      await waitFor(async () => {
        const page = await runtime.runtimeService.listWorkspaces(10);
        return page.items.length === 0;
      }, 8_000);

      await expect(runtime.runtimeService.getSession("ses_bootstrap_legacy")).rejects.toMatchObject({
        code: "session_not_found"
      });
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("restores imported external workspaces and their conversation history in sqlite mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-external-sqlite-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const blueprintsDir = path.join(tempDir, "blueprints");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const externalRoot = path.join(workspaceDir, "external-repo");
    const configPath = path.join(tempDir, "server.yaml");
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(blueprintsDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true })
    ]);
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
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
`,
      "utf8"
    );

    const runtimeA = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    let importedWorkspaceId = "";
    let sessionId = "";
    try {
      await mkdir(path.join(externalRoot, ".openharness"), { recursive: true });
      await writeFile(path.join(externalRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");

      const imported = await runtimeA.importWorkspace?.({
        rootPath: externalRoot,
        kind: "project",
        name: "External Repo"
      });

      expect(imported).toMatchObject({
        rootPath: externalRoot,
        kind: "project",
        name: "External Repo"
      });
      importedWorkspaceId = imported?.id ?? "";

      const session = await runtimeA.runtimeService.createSession({
        workspaceId: importedWorkspaceId,
        caller,
        input: {}
      });
      sessionId = session.id;

      const accepted = await runtimeA.runtimeService.createSessionMessage({
        sessionId,
        caller,
        input: {
          content: "hello external workspace"
        }
      });

      await expect(runtimeA.runtimeService.listSessionMessages(sessionId, 10)).resolves.toMatchObject({
        items: [expect.objectContaining({ role: "user", content: "hello external workspace" })]
      });

      await waitFor(async () => {
        const run = await runtimeA.runtimeService.getRun(accepted.runId);
        return ["completed", "failed", "cancelled"].includes(run.status);
      });
    } finally {
      await runtimeA.close();
    }

    const runtimeB = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      const workspaces = await runtimeB.runtimeService.listWorkspaces(10);
      expect(workspaces.items).toEqual([
        expect.objectContaining({
          id: importedWorkspaceId,
          rootPath: externalRoot,
          kind: "project",
          name: "External Repo"
        })
      ]);

      const sessions = await runtimeB.runtimeService.listWorkspaceSessions(importedWorkspaceId, 10);
      expect(sessions.items).toEqual([
        expect.objectContaining({
          id: sessionId,
          workspaceId: importedWorkspaceId
        })
      ]);

      const messages = await runtimeB.runtimeService.listSessionMessages(sessionId, 10);
      expect(messages.items).toEqual([
        expect.objectContaining({
          sessionId,
          role: "user",
          content: "hello external workspace"
        })
      ]);
    } finally {
      await runtimeB.close();
    }
  });

  it("reloads platform models from model_dir and refreshes workspace catalogs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-platform-model-reload-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const blueprintsDir = path.join(tempDir, "blueprints");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const workspaceRoot = path.join(workspaceDir, "demo-project");
    const configPath = path.join(tempDir, "server.yaml");
    const workspaceId = buildWorkspaceId("project", "demo-project", workspaceRoot);

    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(blueprintsDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
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
`,
      "utf8"
    );

    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      await expect(runtime.listPlatformModels!()).resolves.toEqual([
        expect.objectContaining({
          id: "openai-default",
          modelName: "gpt-4o-mini"
        })
      ]);

      await writeFile(
        path.join(modelsDir, "openai.yaml"),
        `
openai-default:
  provider: openai
  name: gpt-4.1-mini

compat-fast:
  provider: openai-compatible
  name: qwen-max
  url: https://example.test/v1
`,
        "utf8"
      );

      await waitFor(async () => {
        const items = await runtime.listPlatformModels!();
        const workspace = await runtime.runtimeService.getWorkspaceRecord(workspaceId);
        return (
          items.some((item) => item.id === "compat-fast" && item.modelName === "qwen-max") &&
          items.some((item) => item.id === "openai-default" && item.modelName === "gpt-4.1-mini") &&
          workspace.catalog.models.some((model) => model.ref === "platform/compat-fast" && model.modelName === "qwen-max") &&
          workspace.catalog.models.some((model) => model.ref === "platform/openai-default" && model.modelName === "gpt-4.1-mini")
        );
      }, 8_000);

      const refreshedWorkspace = await runtime.runtimeService.getWorkspaceRecord(workspaceId);
      expect(refreshedWorkspace.catalog.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ref: "platform/openai-default",
            modelName: "gpt-4.1-mini"
          }),
          expect.objectContaining({
            ref: "platform/compat-fast",
            modelName: "qwen-max"
          })
        ])
      );

      await expect(runtime.getPlatformModelSnapshot!()).resolves.toMatchObject({
        revision: 1,
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "compat-fast"
          })
        ])
      });
    } finally {
      await runtime.close();
    }
  }, 15_000);
});
