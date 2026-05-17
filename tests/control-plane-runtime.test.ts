import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "@oah/config";
import { buildWorkspaceId } from "@oah/config";
import type { RunRepository, SessionRepository, WorkspaceRecord, WorkspaceRepository } from "@oah/engine-core";
import { prepareControlPlaneRuntime } from "../apps/server/src/bootstrap/control-plane-runtime.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

function createWorkspace(input: Partial<WorkspaceRecord> & Pick<WorkspaceRecord, "id" | "rootPath">): WorkspaceRecord {
  return {
    name: path.basename(input.rootPath),
    executionPolicy: "local",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    kind: "project",
    readOnly: false,
    historyMirrorEnabled: true,
    settings: {},
    workspaceModels: {},
    agents: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    catalog: {
      workspaceId: input.id,
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: []
    },
    ...input
  };
}

function createWorkspaceRepository(seed: WorkspaceRecord[] = []): WorkspaceRepository {
  const workspaces = new Map(seed.map((workspace) => [workspace.id, workspace]));
  return {
    create: vi.fn(async (workspace: WorkspaceRecord) => {
      workspaces.set(workspace.id, workspace);
      return workspace;
    }),
    upsert: vi.fn(async (workspace: WorkspaceRecord) => {
      workspaces.set(workspace.id, workspace);
      return workspace;
    }),
    getById: vi.fn(async (id: string) => workspaces.get(id) ?? null),
    list: vi.fn(async (pageSize: number, cursor?: string) => {
      const startIndex = cursor ? Number.parseInt(cursor, 10) : 0;
      return [...workspaces.values()].slice(startIndex, startIndex + pageSize);
    }),
    delete: vi.fn(async (id: string) => {
      workspaces.delete(id);
    })
  };
}

describe("prepareControlPlaneRuntime", () => {
  it("preserves registered managed workspaces when their root still exists but discovery skipped them", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-control-plane-preserve-workspace-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const workspaceRoot = path.join(workspaceDir, "ws_2db225d598b1453192c472c4218eb894");
    await mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");

    const workspace = createWorkspace({
      id: "ws_2db225d598b1453192c472c4218eb894",
      rootPath: workspaceRoot,
      name: "ws_2db225d598b1453192c472c4218eb894"
    });
    const workspaceRepository = createWorkspaceRepository([workspace]);
    const runtime = await prepareControlPlaneRuntime({
      config: {
        paths: {
          workspace_dir: workspaceDir
        }
      } as ServerConfig,
      persistence: {
        workspaceRepository,
        sessionRepository: {} as SessionRepository,
        runRepository: {} as RunRepository,
        listPersistedWorkspaces: vi.fn(async () => [workspace])
      },
      discoveredWorkspaces: [],
      managesWorkspaceRegistry: true,
      enableControlPlaneFacade: true,
      remoteSandboxProvider: false,
      singleWorkspaceDefined: false,
      models: {},
      toolDir: path.join(tempDir, "tools"),
      sqliteShadowRoot: path.join(tempDir, ".openharness", "data", "workspace-state"),
      pollingConfig: { enabled: false, intervalMs: 1_000 },
      workspaceModelMetadataDiscovery: "manual",
      getPlatformAgents: vi.fn(async () => ({})),
      logWorkspaceDiscoveryError: vi.fn(),
      discoverWorkspaceWithEnrichedModels: vi.fn(),
      applyManagedWorkspaceExternalRef: (candidate) => candidate,
      withWorkspaceDefinitionTimestamp: vi.fn(async (candidate) => candidate),
      listRepositoryWorkspaces: vi.fn(async () => [workspace])
    });

    try {
      await runtime.initialize();
      expect(runtime.visibleWorkspaceIds.has(workspace.id)).toBe(true);
      await expect(access(workspaceRoot)).resolves.toBeUndefined();
      await expect(runtime.workspaceRepository.getById(workspace.id)).resolves.toMatchObject({
        id: workspace.id,
        rootPath: workspaceRoot
      });
      expect(workspaceRepository.delete).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("does not remove a retained workspace root when deleting a stale duplicate workspace id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-control-plane-stale-duplicate-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const workspaceRoot = path.join(workspaceDir, "repo");
    await mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(path.join(workspaceRoot, "README.md"), "# repo\n", "utf8");

    const canonicalId = buildWorkspaceId("project", "repo", workspaceRoot);
    const discovered = createWorkspace({
      id: canonicalId,
      rootPath: workspaceRoot,
      name: "repo",
      updatedAt: "2026-01-03T00:00:00.000Z"
    });
    const stale = createWorkspace({
      ...discovered,
      id: "ws_older_duplicate",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    const workspaceRepository = createWorkspaceRepository([discovered, stale]);
    const runtime = await prepareControlPlaneRuntime({
      config: {
        paths: {
          workspace_dir: workspaceDir
        }
      } as ServerConfig,
      persistence: {
        workspaceRepository,
        sessionRepository: {} as SessionRepository,
        runRepository: {} as RunRepository,
        listPersistedWorkspaces: vi.fn(async () => [discovered, stale])
      },
      discoveredWorkspaces: [discovered],
      managesWorkspaceRegistry: true,
      enableControlPlaneFacade: true,
      remoteSandboxProvider: false,
      singleWorkspaceDefined: false,
      models: {},
      toolDir: path.join(tempDir, "tools"),
      sqliteShadowRoot: path.join(tempDir, ".openharness", "data", "workspace-state"),
      pollingConfig: { enabled: false, intervalMs: 1_000 },
      workspaceModelMetadataDiscovery: "eager",
      getPlatformAgents: vi.fn(async () => ({})),
      logWorkspaceDiscoveryError: vi.fn(),
      discoverWorkspaceWithEnrichedModels: vi.fn(),
      applyManagedWorkspaceExternalRef: (candidate) => candidate,
      withWorkspaceDefinitionTimestamp: vi.fn(async (candidate) => candidate),
      listRepositoryWorkspaces: vi
        .fn()
        .mockResolvedValueOnce([discovered, stale])
        .mockResolvedValueOnce([discovered])
    });

    try {
      await runtime.initialize();
      await expect(access(workspaceRoot)).resolves.toBeUndefined();
      await expect(access(path.join(workspaceRoot, "README.md"))).resolves.toBeUndefined();
      await expect(runtime.workspaceRepository.getById(canonicalId)).resolves.toMatchObject({
        id: canonicalId,
        rootPath: workspaceRoot
      });
      await expect(runtime.workspaceRepository.getById(stale.id)).resolves.toBeNull();
      expect(workspaceRepository.delete).toHaveBeenCalledWith(stale.id);
    } finally {
      await runtime.close();
    }
  });

  it("does not read all persisted workspaces for unscoped api-only control planes", async () => {
    const workspaceRepository = createWorkspaceRepository();
    const sessionRepository = {} as SessionRepository;
    const runRepository = {} as RunRepository;
    const listPersistedWorkspaces = vi.fn(async () => []);
    const listWorkspaceSnapshots = vi.fn(async () => []);
    const listRepositoryWorkspaces = vi.fn(async () => []);

    const runtime = await prepareControlPlaneRuntime({
      config: {
        paths: {
          workspace_dir: "/tmp/oah-workspaces"
        }
      } as ServerConfig,
      persistence: {
        workspaceRepository,
        sessionRepository,
        runRepository,
        listPersistedWorkspaces,
        listWorkspaceSnapshots
      },
      discoveredWorkspaces: [],
      managesWorkspaceRegistry: false,
      enableControlPlaneFacade: true,
      remoteSandboxProvider: true,
      singleWorkspaceDefined: false,
      models: {},
      toolDir: "/tmp/oah-tools",
      sqliteShadowRoot: "/tmp/oah-sqlite",
      pollingConfig: { enabled: false, intervalMs: 1_000 },
      workspaceModelMetadataDiscovery: "manual",
      getPlatformAgents: vi.fn(async () => ({})),
      logWorkspaceDiscoveryError: vi.fn(),
      discoverWorkspaceWithEnrichedModels: vi.fn(),
      applyManagedWorkspaceExternalRef: (workspace) => workspace,
      withWorkspaceDefinitionTimestamp: vi.fn(async (workspace) => workspace),
      listRepositoryWorkspaces
    });

    await runtime.initialize();
    await runtime.close();

    expect(listPersistedWorkspaces).not.toHaveBeenCalled();
    expect(listWorkspaceSnapshots).not.toHaveBeenCalled();
    expect(listRepositoryWorkspaces).not.toHaveBeenCalled();
    expect(workspaceRepository.list).not.toHaveBeenCalled();
    expect(workspaceRepository.upsert).not.toHaveBeenCalled();
    expect(runtime.workspaceRepository).toBe(workspaceRepository);
    expect(runtime.sessionRepository).toBe(sessionRepository);
    expect(runtime.runRepository).toBe(runRepository);
  });
});
