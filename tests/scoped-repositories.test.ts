import { describe, expect, it } from "vitest";

import type { WorkspaceRecord, WorkspaceRepository } from "@oah/runtime-core";

import { ScopedWorkspaceRepository } from "../apps/server/src/bootstrap/scoped-repositories.ts";

function createWorkspace(id: string): WorkspaceRecord {
  return {
    id,
    name: id,
    rootPath: `/tmp/${id}`,
    executionPolicy: "local",
    status: "active",
    kind: "project",
    readOnly: false,
    historyMirrorEnabled: false,
    settings: {
      defaultAgent: "default",
      skillDirs: []
    },
    defaultAgent: "default",
    workspaceModels: {},
    agents: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    catalog: {
      workspaceId: id,
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: []
    },
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z"
  };
}

class StubWorkspaceRepository implements WorkspaceRepository {
  readonly items = new Map<string, WorkspaceRecord>();
  failOnCreate = false;
  failOnUpsert = false;
  failOnDelete = false;

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (this.failOnCreate) {
      throw new Error("create_failed");
    }

    this.items.set(input.id, input);
    return input;
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (this.failOnUpsert) {
      throw new Error("upsert_failed");
    }

    this.items.set(input.id, input);
    return input;
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    return this.items.get(id) ?? null;
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const startIndex = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    return [...this.items.values()].slice(startIndex, startIndex + pageSize);
  }

  async delete(id: string): Promise<void> {
    if (this.failOnDelete) {
      throw new Error("delete_failed");
    }

    this.items.delete(id);
  }
}

describe("scoped repositories", () => {
  it("does not expose a workspace when scoped create fails", async () => {
    const visibleWorkspaceIds = new Set<string>();
    const inner = new StubWorkspaceRepository();
    inner.failOnCreate = true;
    const repository = new ScopedWorkspaceRepository(inner, visibleWorkspaceIds);

    await expect(repository.create(createWorkspace("ws_scoped_create"))).rejects.toThrow("create_failed");

    expect(visibleWorkspaceIds.size).toBe(0);
    await expect(repository.getById("ws_scoped_create")).resolves.toBeNull();
    await expect(repository.list(20)).resolves.toEqual([]);
  });

  it("keeps a workspace visible when scoped delete fails", async () => {
    const visibleWorkspaceIds = new Set<string>(["ws_scoped_delete"]);
    const inner = new StubWorkspaceRepository();
    const workspace = createWorkspace("ws_scoped_delete");
    inner.items.set(workspace.id, workspace);
    const repository = new ScopedWorkspaceRepository(inner, visibleWorkspaceIds);

    inner.failOnDelete = true;
    await expect(repository.delete(workspace.id)).rejects.toThrow("delete_failed");

    expect(visibleWorkspaceIds.has(workspace.id)).toBe(true);
    await expect(repository.getById(workspace.id)).resolves.toEqual(workspace);
    await expect(repository.list(20)).resolves.toEqual([workspace]);
  });

  it("reuses an existing inner workspace on create conflicts and makes it visible", async () => {
    const workspace = createWorkspace("ws_scoped_existing");
    const visibleWorkspaceIds = new Set<string>();
    const inner = new StubWorkspaceRepository();
    inner.items.set(workspace.id, workspace);
    inner.failOnCreate = true;
    const repository = new ScopedWorkspaceRepository(inner, visibleWorkspaceIds);

    await expect(repository.create(workspace)).resolves.toEqual(workspace);

    expect(visibleWorkspaceIds.has(workspace.id)).toBe(true);
    await expect(repository.getById(workspace.id)).resolves.toEqual(workspace);
    await expect(repository.list(20)).resolves.toEqual([workspace]);
  });
});
