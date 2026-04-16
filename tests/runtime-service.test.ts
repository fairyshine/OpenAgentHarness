import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeService, createLocalWorkspaceFileSystem } from "@oah/runtime-core";
import type { HookRunAuditRecord, ToolCallAuditRecord, WorkspaceArchiveRecord, WorkspaceFileSystem } from "@oah/runtime-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";
import type { Message } from "@oah/api-contracts";

import { FakeModelGateway } from "./helpers/fake-model-gateway";

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out while waiting for condition.");
}

async function readStreamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function messageParts(message: Pick<Message, "content">) {
  return Array.isArray(message.content) ? message.content : [];
}

function messageText(message: Pick<Message, "content"> | undefined) {
  if (!message) {
    return undefined;
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }

      if (
        part.type === "tool-result" &&
        typeof part.output === "object" &&
        part.output !== null &&
        ((part.output as { type?: unknown }).type === "text" ||
          (part.output as { type?: unknown }).type === "error-text") &&
        typeof (part.output as { value?: unknown }).value === "string"
      ) {
        return [(part.output as { value: string }).value];
      }

      return [];
    })
    .join("\n\n");
}

function messageToolName(message: Pick<Message, "content"> | undefined) {
  return messageParts(message ?? { content: "" })
    .find((part) => part.type === "tool-call" || part.type === "tool-result")
    ?.toolName;
}

function messageToolCallId(message: Pick<Message, "content"> | undefined) {
  return messageParts(message ?? { content: "" })
    .find((part) => part.type === "tool-call" || part.type === "tool-result")
    ?.toolCallId;
}

function extractFieldValue(text: string | undefined, key: string) {
  if (!text) {
    return undefined;
  }

  const match = text.match(new RegExp(`^${key}:\\s+(.+)$`, "m"));
  return match?.[1]?.trim();
}

function hasToolCallPart(message: Pick<Message, "content"> | undefined, toolName: string, toolCallId: string) {
  return messageParts(message ?? { content: "" }).some(
    (part) => part.type === "tool-call" && part.toolName === toolName && part.toolCallId === toolCallId
  );
}

function hasToolResultPart(message: Pick<Message, "content"> | undefined, toolName: string, toolCallId: string) {
  return messageParts(message ?? { content: "" }).some(
    (part) => part.type === "tool-result" && part.toolName === toolName && part.toolCallId === toolCallId
  );
}

async function createRuntime(delayMs = 0) {
  const gateway = new FakeModelGateway(delayMs);
  const persistence = createMemoryRuntimePersistence();
  const runtimeService = new RuntimeService({
    defaultModel: "openai-default",
    modelGateway: gateway,
    ...persistence,
    workspaceInitializer: {
      async initialize(input) {
        return {
          rootPath: input.rootPath,
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
      }
    }
  });

  const workspace = await runtimeService.createWorkspace({
    input: {
      name: "demo",
      blueprint: "workspace",
      rootPath: "/tmp/demo",
      executionPolicy: "local"
    }
  });

  return { gateway, runtimeService, workspace };
}

describe("runtime service", () => {
  it("creates workspaces from a blueprint initializer result", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
            defaultAgent: "builder",
            projectAgentsMd: "Template rule: always add tests.",
            settings: {
              defaultAgent: "builder",
              skillDirs: []
            },
            workspaceModels: {},
            agents: {
              builder: {
                name: "builder",
                mode: "primary",
                prompt: "You are builder.",
                tools: {
                  native: [],
                  actions: [],
                  skills: [],
                  external: []
                },
                switch: [],
                subagents: []
              }
            },
            actions: {},
            skills: {},
            toolServers: {},
            hooks: {},
            catalog: {
              workspaceId: "blueprint",
              agents: [{ name: "builder", mode: "primary", source: "workspace" }],
              models: [],
              actions: [],
              skills: [],
              tools: [],
              hooks: [],
              nativeTools: []
            }
          };
        }
      }
    });

    const workspace = await runtimeService.createWorkspace({
      input: {
        name: "demo",
        blueprint: "workspace",
        rootPath: "/tmp/demo",
        serviceName: "svc-alpha",
        executionPolicy: "local"
      }
    });

    const stored = await runtimeService.getWorkspaceRecord(workspace.id);
    expect(stored.defaultAgent).toBe("builder");
    expect(stored.projectAgentsMd).toBe("Template rule: always add tests.");
    expect(stored.catalog.workspaceId).toBe(workspace.id);
    expect(stored.settings.defaultAgent).toBe("builder");
    expect(stored.serviceName).toBe("svc-alpha");
    expect(workspace.kind).toBe("project");
    expect(workspace.readOnly).toBe(false);
    expect(workspace.serviceName).toBe("svc-alpha");
  });

  it("normalizes legacy chat workspaces when listing and loading", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "ws_legacy_chat",
      name: "legacy-chat",
      rootPath: "/tmp/legacy-chat",
      executionPolicy: "local",
      status: "active",
      kind: "chat" as never,
      readOnly: true,
      historyMirrorEnabled: false,
      defaultAgent: "default",
      settings: {
        defaultAgent: "default",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_legacy_chat",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    } as never);

    await expect(runtimeService.listWorkspaces(20)).resolves.toMatchObject({
      items: [
        {
          id: "ws_legacy_chat",
          kind: "project",
          readOnly: false
        }
      ]
    });

    await expect(runtimeService.getWorkspaceRecord("ws_legacy_chat")).resolves.toMatchObject({
      id: "ws_legacy_chat",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true
    });
  });

  it("preserves the initializer workspace id when creating a workspace", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceInitializer: {
        async initialize(input) {
          return {
            id: "ws_stable_demo",
            rootPath: input.rootPath,
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
        }
      }
    });

    const workspace = await runtimeService.createWorkspace({
      input: {
        name: "demo",
        blueprint: "workspace",
        rootPath: "/tmp/demo",
        executionPolicy: "local"
      }
    });

    expect(workspace.id).toBe("ws_stable_demo");
    expect((await runtimeService.getWorkspaceRecord("ws_stable_demo")).catalog.workspaceId).toBe("ws_stable_demo");
  });

  it("deletes workspace records and cascades in-memory session data", async () => {
    let deletedWorkspaceRoot = "";
    const archivedWorkspaces: WorkspaceArchiveRecord[] = [];
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceArchiveRepository: {
        async archiveWorkspace(input) {
          const archived: WorkspaceArchiveRecord = {
            id: `archive_${input.workspace.id}`,
            workspaceId: input.workspace.id,
            scopeType: "workspace",
            scopeId: input.workspace.id,
            archiveDate: input.archiveDate,
            archivedAt: input.archivedAt,
            deletedAt: input.deletedAt,
            timezone: input.timezone,
            workspace: input.workspace,
            sessions: [],
            runs: [],
            messages: [],
            runtimeMessages: [],
            runSteps: [],
            toolCalls: [],
            hookRuns: [],
            artifacts: []
          };
          archivedWorkspaces.push(archived);
          return archived;
        },
        async archiveSessionTree(input) {
          const archived: WorkspaceArchiveRecord = {
            id: `archive_${input.rootSessionId}`,
            workspaceId: input.workspace.id,
            scopeType: "session",
            scopeId: input.rootSessionId,
            archiveDate: input.archiveDate,
            archivedAt: input.archivedAt,
            deletedAt: input.deletedAt,
            timezone: input.timezone,
            workspace: input.workspace,
            sessions: [],
            runs: [],
            messages: [],
            runtimeMessages: [],
            runSteps: [],
            toolCalls: [],
            hookRuns: [],
            artifacts: []
          };
          archivedWorkspaces.push(archived);
          return archived;
        },
        async listPendingArchiveDates() {
          return [];
        },
        async listByArchiveDate() {
          return [];
        },
        async markExported() {},
        async pruneExportedBefore() {
          return 0;
        }
      },
      workspaceDeletionHandler: {
        async deleteWorkspace(workspace) {
          deletedWorkspaceRoot = workspace.rootPath;
        }
      },
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
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
        }
      }
    });

    const workspace = await runtimeService.createWorkspace({
      input: {
        name: "demo",
        blueprint: "workspace",
        rootPath: "/tmp/workspace-delete-demo",
        executionPolicy: "local"
      }
    });

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller: {
        subjectRef: "dev:test",
        authSource: "test",
        scopes: [],
        workspaceAccess: []
      },
      input: {}
    });

    await runtimeService.deleteWorkspace(workspace.id);

    expect(deletedWorkspaceRoot).toBe("/tmp/workspace-delete-demo");
    expect(archivedWorkspaces).toHaveLength(1);
    expect(archivedWorkspaces[0]).toMatchObject({
      workspaceId: workspace.id,
      workspace: {
        id: workspace.id,
        rootPath: "/tmp/workspace-delete-demo"
      }
    });
    await expect(runtimeService.getWorkspace(workspace.id)).rejects.toMatchObject({
      code: "workspace_not_found"
    });
    await expect(runtimeService.getSession(session.id)).rejects.toMatchObject({
      code: "session_not_found"
    });
  });

  it("routes workspace file mutations through the workspace file access lease", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "oah-workspace-source-"));
    const materializedRoot = await mkdtemp(path.join(tmpdir(), "oah-workspace-materialized-"));
    const releases: Array<{ dirty?: boolean | undefined }> = [];
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceFileAccessProvider: {
        async acquire({ workspace }) {
          return {
            workspace: {
              ...workspace,
              rootPath: materializedRoot
            },
            async release(options) {
              releases.push(options ?? {});
            }
          };
        }
      },
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
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
        }
      }
    });

    try {
      const workspace = await runtimeService.createWorkspace({
        input: {
          name: "demo",
          blueprint: "workspace",
          rootPath: sourceRoot,
          executionPolicy: "local"
        }
      });

      await runtimeService.putWorkspaceFileContent(workspace.id, {
        path: "README.md",
        content: "# materialized\n",
        encoding: "utf8",
        overwrite: true
      });

      await expect(readFile(path.join(materializedRoot, "README.md"), "utf8")).resolves.toBe("# materialized\n");
      await expect(readFile(path.join(sourceRoot, "README.md"), "utf8")).rejects.toThrow();
      expect(releases).toEqual([{ dirty: true }]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(materializedRoot, { recursive: true, force: true });
    }
  });

  it("routes workspace file reads through the workspace file access lease", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "oah-workspace-source-"));
    const materializedRoot = await mkdtemp(path.join(tmpdir(), "oah-workspace-materialized-"));
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceFileAccessProvider: {
        async acquire({ workspace }) {
          return {
            workspace: {
              ...workspace,
              rootPath: materializedRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
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
        }
      }
    });

    try {
      await writeFile(path.join(materializedRoot, "README.md"), "# materialized-read\n", "utf8");
      const workspace = await runtimeService.createWorkspace({
        input: {
          name: "demo",
          blueprint: "workspace",
          rootPath: sourceRoot,
          executionPolicy: "local"
        }
      });

      const file = await runtimeService.getWorkspaceFileContent(workspace.id, {
        path: "README.md",
        encoding: "utf8"
      });

      expect(file.content).toBe("# materialized-read\n");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(materializedRoot, { recursive: true, force: true });
    }
  });

  it("routes workspace file operations through the injected workspace file system", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "oah-workspace-filesystem-"));
    const localFileSystem = createLocalWorkspaceFileSystem();
    const writeCalls: string[] = [];
    const readCalls: string[] = [];
    const fileSystem: WorkspaceFileSystem = {
      ...localFileSystem,
      async writeFile(targetPath, data) {
        writeCalls.push(targetPath);
        await localFileSystem.writeFile(targetPath, data);
      },
      async readFile(targetPath) {
        readCalls.push(targetPath);
        return localFileSystem.readFile(targetPath);
      }
    };

    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceFileSystem: fileSystem,
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
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
        }
      }
    });

    try {
      const workspace = await runtimeService.createWorkspace({
        input: {
          name: "demo",
          blueprint: "workspace",
          rootPath: sourceRoot,
          executionPolicy: "local"
        }
      });

      await runtimeService.putWorkspaceFileContent(workspace.id, {
        path: "README.md",
        content: "# fs adapter\n",
        encoding: "utf8",
        overwrite: true
      });

      const content = await runtimeService.getWorkspaceFileContent(workspace.id, {
        path: "README.md",
        encoding: "utf8"
      });

      expect(content.content).toBe("# fs adapter\n");
      expect(writeCalls).toContain(path.join(sourceRoot, "README.md"));
      expect(readCalls).toContain(path.join(sourceRoot, "README.md"));
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("keeps a read lease open for workspace downloads until the caller releases it", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "oah-workspace-source-"));
    const materializedRoot = await mkdtemp(path.join(tmpdir(), "oah-workspace-materialized-"));
    const releases: Array<{ dirty?: boolean | undefined }> = [];
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceFileAccessProvider: {
        async acquire({ workspace }) {
          return {
            workspace: {
              ...workspace,
              rootPath: materializedRoot
            },
            async release(options) {
              releases.push(options ?? {});
            }
          };
        }
      },
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
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
        }
      }
    });

    try {
      await writeFile(path.join(materializedRoot, "README.md"), "# download\n", "utf8");
      const workspace = await runtimeService.createWorkspace({
        input: {
          name: "demo",
          blueprint: "workspace",
          rootPath: sourceRoot,
          executionPolicy: "local"
        }
      });

      const handle = await runtimeService.openWorkspaceFileDownload(workspace.id, "README.md");
      expect(handle.file.path).toBe("README.md");
      expect(await readStreamText(handle.file.openReadStream())).toBe("# download\n");
      expect(releases).toEqual([]);

      await handle.release({ dirty: false });
      expect(releases).toEqual([{ dirty: false }]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(materializedRoot, { recursive: true, force: true });
    }
  });

  it("deletes child sessions when removing a parent session", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const archivedSessionTrees: WorkspaceArchiveRecord[] = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceArchiveRepository: {
        async archiveWorkspace(input) {
          const archived: WorkspaceArchiveRecord = {
            id: `archive_${input.workspace.id}`,
            workspaceId: input.workspace.id,
            scopeType: "workspace",
            scopeId: input.workspace.id,
            archiveDate: input.archiveDate,
            archivedAt: input.archivedAt,
            deletedAt: input.deletedAt,
            timezone: input.timezone,
            workspace: input.workspace,
            sessions: [],
            runs: [],
            messages: [],
            runtimeMessages: [],
            runSteps: [],
            toolCalls: [],
            hookRuns: [],
            artifacts: []
          };
          return archived;
        },
        async archiveSessionTree(input) {
          const archived: WorkspaceArchiveRecord = {
            id: `archive_${input.rootSessionId}`,
            workspaceId: input.workspace.id,
            scopeType: "session",
            scopeId: input.rootSessionId,
            archiveDate: input.archiveDate,
            archivedAt: input.archivedAt,
            deletedAt: input.deletedAt,
            timezone: input.timezone,
            workspace: input.workspace,
            sessions: input.sessionIds.map((id) => ({
              id,
              workspaceId: input.workspace.id,
              subjectRef: "dev:test",
              activeAgentName: "default",
              status: "active",
              createdAt: "2026-04-07T00:00:00.000Z",
              updatedAt: "2026-04-07T00:00:00.000Z"
            })),
            runs: [],
            messages: [],
            runtimeMessages: [],
            runSteps: [],
            toolCalls: [],
            hookRuns: [],
            artifacts: []
          };
          archivedSessionTrees.push(archived);
          return archived;
        },
        async listPendingArchiveDates() {
          return [];
        },
        async listByArchiveDate() {
          return [];
        },
        async markExported() {},
        async pruneExportedBefore() {
          return 0;
        }
      },
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
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
        }
      }
    });

    const workspace = await runtimeService.createWorkspace({
      input: {
        name: "demo",
        blueprint: "workspace",
        rootPath: "/tmp/demo-delete-session-tree",
        executionPolicy: "local"
      }
    });

    const createdAt = "2026-04-07T00:00:00.000Z";
    const updatedAt = "2026-04-07T00:00:00.000Z";

    await persistence.sessionRepository.create({
      id: "ses-parent",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "default",
      title: "Parent",
      status: "active",
      createdAt,
      updatedAt
    });
    await persistence.sessionRepository.create({
      id: "ses-child",
      workspaceId: workspace.id,
      parentSessionId: "ses-parent",
      subjectRef: "dev:test",
      activeAgentName: "default",
      title: "Child",
      status: "active",
      createdAt,
      updatedAt
    });
    await persistence.sessionRepository.create({
      id: "ses-grandchild",
      workspaceId: workspace.id,
      parentSessionId: "ses-child",
      subjectRef: "dev:test",
      activeAgentName: "default",
      title: "Grandchild",
      status: "active",
      createdAt,
      updatedAt
    });
    await persistence.sessionRepository.create({
      id: "ses-sibling",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "default",
      title: "Sibling",
      status: "active",
      createdAt,
      updatedAt
    });

    await runtimeService.deleteSession("ses-parent");

    expect(archivedSessionTrees).toHaveLength(1);
    expect(archivedSessionTrees[0]).toMatchObject({
      workspaceId: workspace.id,
      scopeType: "session",
      scopeId: "ses-parent"
    });
    expect(archivedSessionTrees[0]?.sessions.map((entry) => entry.id).sort()).toEqual([
      "ses-child",
      "ses-grandchild",
      "ses-parent"
    ]);
    await expect(runtimeService.getSession("ses-parent")).rejects.toMatchObject({ code: "session_not_found" });
    await expect(runtimeService.getSession("ses-child")).rejects.toMatchObject({ code: "session_not_found" });
    await expect(runtimeService.getSession("ses-grandchild")).rejects.toMatchObject({ code: "session_not_found" });
    await expect(runtimeService.getSession("ses-sibling")).resolves.toMatchObject({ id: "ses-sibling" });
  });

  it("serializes runs inside a session", async () => {
    const { runtimeService, workspace } = await createRuntime(30);
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const first = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "first" }
    });
    const second = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "second" }
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id);
      return events.filter((event) => event.event === "run.completed").length === 2;
    });

    const events = await runtimeService.listSessionEvents(session.id);
    const runStarted = events.filter((event) => event.event === "run.started").map((event) => event.runId);
    const runCompleted = events.filter((event) => event.event === "run.completed").map((event) => event.runId);

    expect(runStarted).toEqual([first.runId, second.runId]);
    expect(runCompleted).toEqual([first.runId, second.runId]);
  });

  it("skips redundant runtime message rewrites when later events do not change the projection", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    let replaceCalls = 0;
    const runtimeMessageRepository = {
      async replaceBySessionId(sessionId: string, messages: Awaited<ReturnType<typeof persistence.runtimeMessageRepository.listBySessionId>>) {
        replaceCalls += 1;
        await persistence.runtimeMessageRepository.replaceBySessionId(sessionId, messages);
      },
      listBySessionId(sessionId: string) {
        return persistence.runtimeMessageRepository.listBySessionId(sessionId);
      }
    };
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      runtimeMessageRepository,
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
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
        }
      }
    });

    const workspace = await runtimeService.createWorkspace({
      input: {
        name: "runtime-message-sync",
        blueprint: "workspace",
        rootPath: "/tmp/runtime-message-sync",
        executionPolicy: "local"
      }
    });
    const caller = {
      subjectRef: "dev:test",
      authSource: "test",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
      return events.some((event) => event.event === "run.completed");
    });

    expect(replaceCalls).toBe(2);
    await expect(persistence.runtimeMessageRepository.listBySessionId(session.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" })
      ])
    );
  });

  it("persists AI SDK step request, response, and provider metadata snapshots", async () => {
    const { runtimeService, workspace, gateway } = await createRuntime();
    gateway.streamScenarioFactory = () => ({
      text: "snapshots persisted",
      stepRequest: {
        body: {
          prompt: "persist snapshots"
        }
      },
      stepResponse: {
        id: "resp_snapshot_1",
        model: "openai-default",
        headers: {
          "x-request-id": "req_snapshot_1"
        }
      },
      stepProviderMetadata: {
        openai: {
          requestId: "req_snapshot_1",
          sessionId: "sess_snapshot_1"
        }
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "persist snapshots" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    const modelCallStep = runSteps.items.find((step) => step.stepType === "model_call");

    expect(modelCallStep?.output).toMatchObject({
      response: {
        request: {
          body: {
            prompt: "persist snapshots"
          }
        },
        response: {
          id: "resp_snapshot_1",
          model: "openai-default",
          headers: {
            "x-request-id": "req_snapshot_1"
          }
        },
        providerMetadata: {
          openai: {
            requestId: "req_snapshot_1",
            sessionId: "sess_snapshot_1"
          }
        }
      }
    });
  });

  it("supports a third session message and lists persisted messages with the default page size", async () => {
    const { runtimeService, workspace } = await createRuntime();
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const first = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "first" }
    });
    const second = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "second" }
    });
    const third = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "third" }
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id);
      return events.filter((event) => event.event === "run.completed").length === 3;
    });

    const messages = await runtimeService.listSessionMessages(session.id);
    const userMessages = messages.items.filter((message) => message.role === "user");
    const assistantMessages = messages.items.filter((message) => message.role === "assistant");

    expect(userMessages).toHaveLength(3);
    expect(assistantMessages).toHaveLength(3);
    expect(messageText(userMessages[0])).toBe("first");
    expect(messageText(userMessages[1])).toBe("second");
    expect(messageText(userMessages[2])).toBe("third");

    const events = await runtimeService.listSessionEvents(session.id);
    const runStarted = events.filter((event) => event.event === "run.started").map((event) => event.runId);
    const runCompleted = events.filter((event) => event.event === "run.completed").map((event) => event.runId);

    expect(runStarted).toEqual([first.runId, second.runId, third.runId]);
    expect(runCompleted).toEqual([first.runId, second.runId, third.runId]);
  });

  it("lists all runs for a session in reverse chronological order", async () => {
    const { runtimeService, workspace } = await createRuntime();
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const first = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "first" }
    });
    const second = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "second" }
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id);
      return events.filter((event) => event.event === "run.completed").length === 2;
    });

    const runs = await runtimeService.listSessionRuns(session.id, 20);
    expect(runs.items).toHaveLength(2);
    expect(runs.items.map((run) => run.id)).toEqual(expect.arrayContaining([first.runId, second.runId]));
    expect(runs.items.every((run) => run.sessionId === session.id)).toBe(true);
  });

  it("includes the first session event when listing without a cursor", async () => {
    const { runtimeService, workspace } = await createRuntime();
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const events = await runtimeService.listSessionEvents(session.id);

    expect(events.at(0)?.event).toBe("run.queued");
    expect(events.at(0)?.runId).toBe(accepted.runId);
  });

  it("allows different sessions to run concurrently", async () => {
    const { runtimeService, workspace, gateway } = await createRuntime(60);
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const sessionA = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: { title: "a" }
    });
    const sessionB = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: { title: "b" }
    });

    await Promise.all([
      runtimeService.createSessionMessage({
        sessionId: sessionA.id,
        caller,
        input: { content: "alpha" }
      }),
      runtimeService.createSessionMessage({
        sessionId: sessionB.id,
        caller,
        input: { content: "beta" }
      })
    ]);

    await waitFor(() => gateway.maxConcurrentStreams >= 2);
    expect(gateway.maxConcurrentStreams).toBeGreaterThanOrEqual(2);
  });

  it("cancels queued or running runs", async () => {
    const { runtimeService, workspace } = await createRuntime(80);
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "cancel me" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "running";
    });

    await runtimeService.cancelRun(accepted.runId);
    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "cancelled";
    });

    const run = await runtimeService.getRun(accepted.runId);
    expect(run.status).toBe("cancelled");
  });

  it("uses a discovered workspace default agent when session input omits agentName", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_demo",
      name: "demo",
      rootPath: "/tmp/demo",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_demo",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const session = await runtimeService.createSession({
      workspaceId: "project_demo",
      caller: {
        subjectRef: "dev:test",
        authSource: "standalone_server",
        scopes: [],
        workspaceAccess: []
      },
      input: {}
    });

    expect(session.activeAgentName).toBe("builder");
  });

  it("falls back to the platform assistant when a workspace has no explicit default agent", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_platform_default",
      name: "platform-default",
      rootPath: "/tmp/platform-default",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        assistant: {
          name: "assistant",
          mode: "primary",
          prompt: "You are the platform assistant.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["builder"],
          subagents: []
        },
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["assistant"],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_platform_default",
        agents: [
          { name: "assistant", mode: "primary", source: "platform" },
          { name: "builder", mode: "primary", source: "platform" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const session = await runtimeService.createSession({
      workspaceId: "project_platform_default",
      caller: {
        subjectRef: "dev:test",
        authSource: "test",
        scopes: [],
        workspaceAccess: []
      },
      input: {}
    });

    expect(session.activeAgentName).toBe("assistant");
  });

  it("updates the session active agent for subsequent runs and rejects non-primary targets", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_session_agent_update",
      name: "session-agent-update",
      rootPath: "/tmp/session-agent-update",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["assistant"],
          subagents: []
        },
        assistant: {
          name: "assistant",
          mode: "primary",
          prompt: "You are the assistant agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["builder"],
          subagents: []
        },
        planner: {
          name: "planner",
          mode: "all",
          prompt: "You are the planner agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["assistant"],
          subagents: []
        },
        reviewer: {
          name: "reviewer",
          mode: "subagent",
          prompt: "You are the reviewer subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_session_agent_update",
        agents: [
          { name: "builder", mode: "primary", source: "workspace" },
          { name: "assistant", mode: "primary", source: "workspace" },
          { name: "planner", mode: "all", source: "workspace" },
          { name: "reviewer", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_session_agent_update",
      caller,
      input: {}
    });

    const updatedSession = await runtimeService.updateSession({
      sessionId: session.id,
      input: {
        activeAgentName: "assistant"
      }
    });

    expect(updatedSession.activeAgentName).toBe("assistant");

    const updatedAllModeSession = await runtimeService.updateSession({
      sessionId: session.id,
      input: {
        activeAgentName: "planner"
      }
    });

    expect(updatedAllModeSession.activeAgentName).toBe("planner");

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "continue with the planner" }
    });
    const run = await runtimeService.getRun(accepted.runId);

    expect(run.agentName).toBe("planner");
    expect(run.effectiveAgentName).toBe("planner");

    await expect(
      runtimeService.updateSession({
        sessionId: session.id,
        input: {
          activeAgentName: "reviewer"
        }
      })
    ).rejects.toMatchObject({
      code: "invalid_session_agent_target"
    });
  });

  it("injects AGENTS.md and the active agent prompt without a system reminder when the session explicitly selects an agent", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt",
      name: "prompt-workspace",
      rootPath: "/tmp/prompt-workspace",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      projectAgentsMd: "Repository rule: always add tests.",
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder agent.",
          systemReminder: "Stay focused on implementation.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_prompt",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_prompt",
      caller,
      input: {
        agentName: "builder"
      }
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "implement feature" }
    });

    await waitFor(() => gateway.invocations.length > 0);

    const systemMessages = gateway.invocations
      .at(0)
      ?.input.messages?.filter((message) => message.role === "system")
      .map((message) => message.content);
    const userMessage = gateway.invocations.at(0)?.input.messages?.find((message) => message.role === "user");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages?.[0]).toContain("Repository rule: always add tests.");
    expect(systemMessages?.[0]).toContain("You are the builder agent.");
    expect(systemMessages?.[0]).not.toContain("Stay focused on implementation.");
    expect(messageText(userMessage)).toBe("implement feature");
  });

  it("does not inject system reminder for default-agent sessions before any agent switch", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt_default_agent",
      name: "prompt-default-agent",
      rootPath: "/tmp/prompt-default-agent",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder agent.",
          systemReminder: "Stay focused on implementation.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_prompt_default_agent",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_prompt_default_agent",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "implement feature" }
    });

    await waitFor(() => gateway.invocations.length > 0);

    const systemMessages = gateway.invocations
      .at(0)
      ?.input.messages?.filter((message) => message.role === "system")
      .map((message) => message.content);
    const userMessage = gateway.invocations.at(0)?.input.messages?.find((message) => message.role === "user");
    expect(systemMessages?.some((message) => message.includes("<system_reminder>"))).toBe(false);
    expect(messageText(userMessage)).not.toContain("<system_reminder>");
  });

  it("injects a system reminder on the next user turn after the session agent is manually switched", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_manual_agent_switch",
      name: "manual-agent-switch",
      rootPath: "/tmp/manual-agent-switch",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planning agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["build"],
          subagents: []
        },
        build: {
          name: "build",
          mode: "primary",
          prompt: "You are the build agent.",
          systemReminder: "Take over implementation and continue from the planner's handoff.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_manual_agent_switch",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "build", mode: "primary", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_manual_agent_switch",
      caller,
      input: {}
    });

    const firstAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Plan this task first." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(firstAccepted.runId);
      return run.status === "completed";
    });

    await runtimeService.updateSession({
      sessionId: session.id,
      input: {
        activeAgentName: "build"
      }
    });

    const secondAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Now implement it." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(secondAccepted.runId);
      return run.status === "completed";
    });

    const thirdAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Continue with the implementation." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(thirdAccepted.runId);
      return run.status === "completed";
    });

    expect(gateway.invocations).toHaveLength(3);

    const firstUserMessage = [...(gateway.invocations.at(0)?.input.messages ?? [])].reverse().find((message) => message.role === "user");
    const secondSystemMessages = gateway.invocations
      .at(1)
      ?.input.messages?.filter((message) => message.role === "system")
      .map((message) => message.content);
    const secondUserMessage = [...(gateway.invocations.at(1)?.input.messages ?? [])].reverse().find((message) => message.role === "user");
    const thirdUserMessage = [...(gateway.invocations.at(2)?.input.messages ?? [])].reverse().find((message) => message.role === "user");

    expect(messageText(firstUserMessage)).toBe("Plan this task first.");
    expect(secondSystemMessages).toHaveLength(1);
    expect(secondSystemMessages?.[0]).toContain("You are the build agent.");
    expect(secondSystemMessages?.[0]).not.toContain("Take over implementation");
    expect(messageText(secondUserMessage)).toContain("<system_reminder>");
    expect(messageText(secondUserMessage)).toContain("Take over implementation and continue from the planner's handoff.");
    expect(messageText(secondUserMessage)).toContain("Now implement it.");
    expect(messageText(thirdUserMessage)).toBe("Continue with the implementation.");
  });

  it("switches agents mid-run and uses the switched prompt, model, and reminder on the next step", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Build agent finished the implementation.",
      toolSteps: [
        {
          toolName: "AgentSwitch",
          input: { to: "build" },
          toolCallId: "call_switch"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_switch",
      name: "agent-switch",
      rootPath: "/tmp/agent-switch",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planning agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["build"],
          subagents: []
        },
        build: {
          name: "build",
          mode: "primary",
          prompt: "You are the build agent.",
          systemReminder: "Take over implementation and continue from the planner's handoff.",
          modelRef: "platform/build-model",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_switch",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "build", mode: "primary", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_switch",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Plan first, then hand off to build." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    await waitFor(() => gateway.invocations.length >= 2);

    const run = await runtimeService.getRun(accepted.runId);
    const updatedSession = await runtimeService.getSession(session.id);
    const events = await runtimeService.listSessionEvents(session.id);
    const initialSystemMessages = gateway.invocations
      .at(0)
      ?.input.messages?.filter((message) => message.role === "system")
      .map((message) => message.content);
    const switchedInvocation = gateway.invocations.at(1);
    const switchedSystemMessages = switchedInvocation?.input.messages
      ?.filter((message) => message.role === "system")
      .map((message) => message.content);
    const switchedUserMessage = [...(switchedInvocation?.input.messages ?? [])].reverse().find((message) => message.role === "user");

    expect(run.effectiveAgentName).toBe("build");
    expect(run.switchCount).toBe(1);
    expect(updatedSession.activeAgentName).toBe("build");
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["agent.switch.requested", "agent.switched", "run.completed"])
    );
    expect(initialSystemMessages).toHaveLength(1);
    expect(initialSystemMessages?.[0]).toContain("You are the planning agent.");
    expect(switchedInvocation?.model).toBe("build-model");
    expect(switchedSystemMessages).toHaveLength(1);
    expect(switchedSystemMessages?.[0]).toContain("You are the build agent.");
    expect(switchedSystemMessages?.[0]).not.toContain("You are the planning agent.");
    expect(switchedSystemMessages?.[0]).not.toContain("<system_reminder>");
    expect(switchedSystemMessages?.[0]).not.toContain("Take over implementation");
    expect(messageText(switchedUserMessage)).toContain("<system_reminder>");
    expect(messageText(switchedUserMessage)).toContain("Take over implementation");
    expect(messageText(switchedUserMessage)).toContain("Plan first, then hand off to build.");

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "agent_switch" && step.status === "completed")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "tool_call" && step.name === "AgentSwitch")).toBe(true);

    const messages = await runtimeService.listSessionMessages(session.id, 20);
    const assistantToolCallMessage = messages.items.find((message) => hasToolCallPart(message, "AgentSwitch", "call_switch"));
    const toolResultMessage = messages.items.find((message) => hasToolResultPart(message, "AgentSwitch", "call_switch"));
    const finalAssistantMessage = [...messages.items].reverse().find((message) => message.role === "assistant");

    expect(assistantToolCallMessage?.metadata).toMatchObject({
      agentName: "plan",
      effectiveAgentName: "plan",
      agentMode: "primary",
      modelCallStepSeq: expect.any(Number),
      systemMessages: [
        {
          role: "system",
          content: expect.stringContaining("You are the planning agent.")
        }
      ]
    });
    expect(toolResultMessage?.metadata).toMatchObject({
      agentName: "plan",
      effectiveAgentName: "plan",
      agentMode: "primary",
      modelCallStepSeq: expect.any(Number),
      systemMessages: [
        {
          role: "system",
          content: expect.stringContaining("You are the planning agent.")
        }
      ]
    });
    expect(finalAssistantMessage?.metadata).toMatchObject({
      agentName: "build",
      effectiveAgentName: "build",
      agentMode: "primary",
      modelCallStepSeq: expect.any(Number),
      systemMessages: [
        {
          role: "system",
          content: expect.stringContaining("You are the build agent.")
        }
      ]
    });
    expect(
      (finalAssistantMessage?.metadata as { systemMessages?: Array<{ content?: string }> } | undefined)?.systemMessages?.[0]?.content
    ).not.toContain("Take over implementation");
    expect((assistantToolCallMessage?.metadata as { modelCallStepSeq?: number } | undefined)?.modelCallStepSeq).toBe(
      (toolResultMessage?.metadata as { modelCallStepSeq?: number } | undefined)?.modelCallStepSeq
    );
    expect((finalAssistantMessage?.metadata as { modelCallStepSeq?: number } | undefined)?.modelCallStepSeq).not.toBe(
      (assistantToolCallMessage?.metadata as { modelCallStepSeq?: number } | undefined)?.modelCallStepSeq
    );
  });

  it("persists assistant text before an AgentSwitch as a separate message with the pre-switch agent metadata", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      preToolText: "计划已制定好！以下是本次会话的学习路线：先理解核心概念，再进入练习。",
      text: "现在开始第一步：什么是大语言模型？",
      toolSteps: [
        {
          toolName: "AgentSwitch",
          input: { to: "learn" },
          toolCallId: "call_switch"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_switch_transcript",
      name: "agent-switch-transcript",
      rootPath: "/tmp/agent-switch-transcript",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planning agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["learn"],
          subagents: []
        },
        learn: {
          name: "learn",
          mode: "primary",
          prompt: "You are the teaching agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_switch_transcript",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "learn", mode: "primary", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_switch_transcript",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "先帮我制定学习路线，然后切到教学模式。" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const messages = await runtimeService.listSessionMessages(session.id, 20);
    const planTextMessage = messages.items.find(
      (message) => message.role === "assistant" && messageText(message)?.includes("计划已制定好！以下是本次会话的学习路线")
    );
    const assistantToolCallMessage = messages.items.find((message) => hasToolCallPart(message, "AgentSwitch", "call_switch"));
    const toolResultMessage = messages.items.find((message) => hasToolResultPart(message, "AgentSwitch", "call_switch"));
    const learnTextMessage = messages.items.find(
      (message) => message.role === "assistant" && messageText(message)?.includes("现在开始第一步：什么是大语言模型？")
    );

    expect(messages.items.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "tool", "assistant"]);
    expect(messageText(planTextMessage)).toContain("计划已制定好");
    expect(messageText(planTextMessage)).not.toContain("现在开始第一步");
    expect(planTextMessage?.metadata).toMatchObject({
      agentName: "plan",
      effectiveAgentName: "plan",
      agentMode: "primary"
    });
    expect(assistantToolCallMessage?.metadata).toMatchObject({
      agentName: "plan",
      effectiveAgentName: "plan",
      agentMode: "primary"
    });
    expect(toolResultMessage?.metadata).toMatchObject({
      agentName: "plan",
      effectiveAgentName: "plan",
      agentMode: "primary"
    });
    expect(learnTextMessage?.metadata).toMatchObject({
      agentName: "learn",
      effectiveAgentName: "learn",
      agentMode: "primary"
    });
    expect(messages.items.indexOf(planTextMessage as Message)).toBeLessThan(
      messages.items.indexOf(assistantToolCallMessage as Message)
    );

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const planCompletedEvent = events.find(
      (event) => event.event === "message.completed" && event.data.messageId === planTextMessage?.id
    );
    expect(planCompletedEvent?.data.metadata).toMatchObject({
      agentName: "plan",
      effectiveAgentName: "plan"
    });
  });

  it("delegates to a subagent, awaits the child run, and inherits the parent model when the subagent has no model", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        return {
          text: "Subagent result: repository facts are ready."
        };
      }

      return {
        text: "Parent integrated the subagent result.",
        toolSteps: [
          {
            toolName: "SubAgent",
            input: {
              description: "Gather repo facts",
              prompt: "Inspect the repository and summarize the key facts.",
              subagent_name: "researcher"
            },
            toolCallId: "call_agent"
          }
        ]
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      platformModels: {
        "planner-model": {
          provider: "openai",
          name: "gpt-4.1-mini"
        }
      },
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_delegate",
      name: "agent-delegate",
      rootPath: "/tmp/agent-delegate",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          modelRef: "platform/planner-model",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: ["researcher"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_delegate",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" }
        ],
        models: [{ ref: "platform/planner-model", name: "planner-model", source: "platform", provider: "openai" }],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_delegate",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Use a subagent to gather the repo facts, then continue." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const parentRun = await runtimeService.getRun(accepted.runId);
    const delegatedRuns = ((parentRun.metadata?.delegatedRuns as Array<{ childRunId: string }> | undefined) ?? []).map(
      (record) => record.childRunId
    );

    expect(delegatedRuns).toHaveLength(1);

    const childRun = await runtimeService.getRun(delegatedRuns[0]!);
    const childSession = await runtimeService.getSession(childRun.sessionId!);
    await waitFor(async () => {
      const run = await runtimeService.getRun(childRun.id);
      return run.status === "completed";
    });

    const parentMessages = await runtimeService.listSessionMessages(session.id, 50);
    const agentToolMessage = parentMessages.items.find(
      (message) => message.role === "tool" && messageToolName(message) === "SubAgent"
    );
    const events = await runtimeService.listSessionEvents(session.id);
    const childInvocation = gateway.invocations.find((invocation) =>
      invocation.input.messages?.some(
        (message) => message.role === "system" && message.content.includes("You are the researcher subagent.")
      )
    );

    expect(childRun.triggerType).toBe("system");
    expect(childRun.parentRunId).toBe(accepted.runId);
    expect(childSession.parentSessionId).toBe(session.id);
    expect(childRun.metadata).toMatchObject({
      parentRunId: accepted.runId,
      parentSessionId: session.id,
      parentAgentName: "plan"
    });
    expect(childInvocation?.model).toBe("planner-model");
    expect(messageText(agentToolMessage)).toContain("completed: true");
    expect(messageText(agentToolMessage)).toContain("subagent_name: researcher");
    expect(messageText(agentToolMessage)).toContain("task_id:");
    expect(messageText(agentToolMessage)).toContain(`task_id: ${childRun.sessionId}`);
    expect(messageText(agentToolMessage)).toContain(`run_id: ${childRun.id}`);
    expect(messageText(agentToolMessage)).toContain("result:");
    expect(messageText(agentToolMessage)).toContain("Subagent result: repository facts are ready.");
    expect(messageText(agentToolMessage)).not.toContain("agent_id:");
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["agent.delegate.started", "agent.delegate.completed", "run.completed"])
    );

    const parentRunSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(parentRunSteps.items.some((step) => step.stepType === "agent_delegate" && step.status === "completed")).toBe(true);
    expect(parentRunSteps.items.some((step) => step.stepType === "tool_call" && step.name === "SubAgent")).toBe(true);
  });

  it("falls back to the last tool result when the awaited subagent assistant message is blank", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-agent-delegate-fallback-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        return {
          text: "   \n",
          toolSteps: [
            {
              toolName: "Bash",
              input: {
                command: "printf subagent-tool-fallback"
              },
              toolCallId: "call_subagent_bash"
            }
          ]
        };
      }

      return {
        text: "Parent integrated the fallback result.",
        toolSteps: [
          {
            toolName: "SubAgent",
            input: {
              description: "Gather repo facts",
              prompt: "Inspect the repository and summarize the key facts.",
              subagent_name: "researcher"
            },
            toolCallId: "call_agent"
          }
        ]
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_delegate_tool_fallback",
      name: "agent-delegate-tool-fallback",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: ["researcher"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: ["Bash"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_delegate_tool_fallback",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_delegate_tool_fallback",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Use a subagent to gather the repo facts, then continue." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const parentMessages = await runtimeService.listSessionMessages(session.id, 50);
    const agentToolMessage = parentMessages.items.find(
      (message) => message.role === "tool" && messageToolName(message) === "SubAgent"
    );
    const events = await runtimeService.listSessionEvents(session.id);

    expect(messageText(agentToolMessage)).toContain("result:");
    expect(messageText(agentToolMessage)).toContain("exit_code: 0");
    expect(messageText(agentToolMessage)).toContain("stdout:");
    expect(messageText(agentToolMessage)).toContain("subagent-tool-fallback");
    expect(events.find((event) => event.event === "agent.delegate.completed")?.data).toMatchObject({
      output: expect.stringContaining("subagent-tool-fallback")
    });
  });

  it("persists reasoning-only assistant completions as message parts", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_reasoning_only_completion",
      name: "reasoning-only-completion",
      rootPath: "/tmp/reasoning-only-completion",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planning agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_reasoning_only_completion",
        agents: [{ name: "plan", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    gateway.streamScenarioFactory = () => ({
      text: "",
      reasoning: [
        {
          type: "reasoning",
          text: " 用户要求切换到plan模式，我已经成功切换。_plan_"
        }
      ]
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_reasoning_only_completion",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "switch to plan mode" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const messages = await runtimeService.listSessionMessages(session.id, 50);
    const assistantMessage = messages.items.find(
      (message) => message.runId === accepted.runId && message.role === "assistant"
    );
    const events = await runtimeService.listSessionEvents(session.id);
    const completedEvent = events.find(
      (event) => event.runId === accepted.runId && event.event === "message.completed" && event.data.messageId === assistantMessage?.id
    );

    expect(assistantMessage?.content).toEqual([
      {
        type: "reasoning",
        text: " 用户要求切换到plan模式，我已经成功切换。_plan_"
      }
    ]);
    expect(completedEvent?.data.content).toEqual([
      {
        type: "reasoning",
        text: " 用户要求切换到plan模式，我已经成功切换。_plan_"
      }
    ]);
    expect(completedEvent?.data.metadata).toMatchObject({
      agentName: "plan",
      effectiveAgentName: "plan",
      agentMode: "primary"
    });
  });

  it("includes systemMessages in message.delta metadata only when the prompt changes", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "abcdefgh"
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_delta_metadata_prompt_dedup",
      name: "delta-metadata-prompt-dedup",
      rootPath: "/tmp/delta-metadata-prompt-dedup",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_delta_metadata_prompt_dedup",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_delta_metadata_prompt_dedup",
      caller,
      input: {
        agentName: "builder"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "stream two chunks please" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const deltaEvents = events.filter((event) => event.event === "message.delta");

    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents[0]?.data.metadata).toMatchObject({
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary",
      systemMessages: [
        {
          role: "system",
          content: expect.stringContaining("You are the builder agent.")
        }
      ]
    });
    expect(deltaEvents[1]?.data.metadata).toMatchObject({
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary"
    });
    expect(deltaEvents[1]?.data.metadata).not.toHaveProperty("systemMessages");
  });

  it("defaults SubAgent launches to background when the target agent enables it", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        return {
          text: "Background subagent finished its report."
        };
      }

      return {
        text: "Parent observed the background result.",
        toolSteps: [
          {
            toolName: "SubAgent",
            input: {
              description: "Research in background",
              prompt: "Collect the repository facts and report back.",
              subagent_name: "researcher"
            },
            toolCallId: "call_agent_background"
          }
        ]
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_background",
      name: "agent-background",
      rootPath: "/tmp/agent-background",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          tools: {
            native: [],
            external: []
          },
          actions: [],
          skills: [],
          switch: [],
          subagents: ["researcher"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          background: true,
          tools: {
            native: [],
            external: []
          },
          actions: [],
          skills: [],
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_background",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_background",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run a background agent, then wait for it." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    await waitFor(async () => {
      const messages = await runtimeService.listSessionMessages(session.id, 50);
      return messages.items.filter((message) => message.role === "tool" && messageToolName(message) === "SubAgent").length === 2;
    });

    const messages = await runtimeService.listSessionMessages(session.id, 50);
    const backgroundMessages = messages.items.filter(
      (message) => message.role === "tool" && messageToolName(message) === "SubAgent"
    );
    const backgroundMessage = backgroundMessages[0];
    const completionMessage = backgroundMessages.at(-1);

    expect(backgroundMessages).toHaveLength(2);
    expect(messageText(backgroundMessage)).toContain("started: true");
    expect(messageText(backgroundMessage)).toContain("subagent_name: researcher");
    expect(messageText(backgroundMessage)).toContain("description: Research in background");
    expect(messageText(backgroundMessage)).toContain("task_id:");
    expect(messageText(completionMessage)).toContain("task_id:");
    expect(messageText(completionMessage)).toContain("run_id:");
    expect(messageText(completionMessage)).toContain("status: completed");
    expect(messageText(completionMessage)).toContain("subagent_name: researcher");
    expect(messageText(completionMessage)).toContain("Background subagent finished its report.");
    expect(completionMessage?.metadata).toMatchObject({
      synthetic: true,
      delegatedUpdate: "completed",
      toolStatus: "completed",
      toolSourceType: "agent"
    });
  });

  it("can launch multiple background subagents in parallel", async () => {
    const gateway = new FakeModelGateway(20);
    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        return {
          text: "Research background result is ready."
        };
      }

      if (systemMessages.some((message) => message.includes("You are the reviewer subagent."))) {
        return {
          text: "Review background result is ready."
        };
      }

      return {
        text: "Parent launched two background delegations.",
        toolBatches: [
          [
            {
              toolName: "SubAgent",
              input: {
                description: "Research in background",
                prompt: "Collect repository facts in the background.",
                subagent_name: "researcher",
                run_in_background: true
              },
              toolCallId: "call_background_researcher"
            },
            {
              toolName: "SubAgent",
              input: {
                description: "Review in background",
                prompt: "Review the repository in the background.",
                subagent_name: "reviewer",
                run_in_background: true
              },
              toolCallId: "call_background_reviewer"
            }
          ]
        ]
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_parallel_background_agents",
      name: "parallel-background-agents",
      rootPath: "/tmp/parallel-background-agents",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          tools: {
            native: [],
            external: []
          },
          actions: [],
          skills: [],
          switch: [],
          subagents: ["researcher", "reviewer"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: [],
            external: []
          },
          actions: [],
          skills: [],
          switch: [],
          subagents: []
        },
        reviewer: {
          name: "reviewer",
          mode: "subagent",
          prompt: "You are the reviewer subagent.",
          tools: {
            native: [],
            external: []
          },
          actions: [],
          skills: [],
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_parallel_background_agents",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" },
          { name: "reviewer", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_parallel_background_agents",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Start two background subagents." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const parentRun = await runtimeService.getRun(accepted.runId);
    const delegatedRuns =
      (parentRun.metadata?.delegatedRuns as Array<{ childRunId: string; childSessionId: string }> | undefined) ?? [];

    expect(delegatedRuns).toHaveLength(2);
    expect(new Set(delegatedRuns.map((record) => record.childSessionId)).size).toBe(2);

    await Promise.all(
      delegatedRuns.map(async (record) => {
        await waitFor(async () => {
          const childRun = await runtimeService.getRun(record.childRunId);
          return childRun.status === "completed";
        });
      })
    );

    await waitFor(async () => {
      const toolMessages = (await runtimeService.listSessionMessages(session.id, 100)).items.filter(
        (message) => message.role === "tool" && messageToolName(message) === "SubAgent"
      );
      return toolMessages.length === 4;
    });

    const toolMessages = (await runtimeService.listSessionMessages(session.id, 100)).items.filter(
      (message) => message.role === "tool" && messageToolName(message) === "SubAgent"
    );

    expect(toolMessages).toHaveLength(4);
    expect(toolMessages.some((message) => messageText(message).includes("Research background result is ready."))).toBe(true);
    expect(toolMessages.some((message) => messageText(message).includes("Review background result is ready."))).toBe(true);
    expect(gateway.maxConcurrentStreams).toBeGreaterThanOrEqual(3);
  });

  it("forwards agent sampling settings including topP to the model gateway", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_sampling",
      name: "agent-sampling",
      rootPath: "/tmp/agent-sampling",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder agent.",
          temperature: 0.3,
          topP: 0.8,
          maxTokens: 256,
          tools: {
            native: [],
            external: []
          },
          actions: [],
          skills: [],
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_sampling",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_sampling",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    expect(gateway.invocations.at(0)?.input.temperature).toBe(0.3);
    expect(gateway.invocations.at(0)?.input.topP).toBe(0.8);
    expect(gateway.invocations.at(0)?.input.maxTokens).toBe(256);
  });

  it("reuses the same child session when SubAgent is called with task_id", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        const delegatedTurns = input.messages?.filter((message) => {
          if (message.role !== "user") {
            return false;
          }

          const text = typeof message.content === "string" ? message.content : "";
          return text.includes("<delegated_task");
        }).length ?? 0;

        return {
          text:
            delegatedTurns >= 2
              ? "Resumed subagent result: second pass complete."
              : "Initial subagent result: first pass complete."
        };
      }

      const latestUserMessage = input.messages?.filter((message) => message.role === "user").at(-1);
      const latestText = typeof latestUserMessage?.content === "string" ? latestUserMessage.content : "";

      if (latestText.includes("Resume the same subagent task")) {
        return {
          text: "Parent completed the resumed delegation.",
          toolSteps: [
            {
              toolName: "SubAgent",
              input: {
                description: "Resume repo research",
                prompt: "Continue the same repository investigation and report only new findings.",
                subagent_name: "researcher",
                task_id: "TASK_ID_PLACEHOLDER"
              },
              toolCallId: "call_resume_agent"
            }
          ]
        };
      }

      return {
        text: "Parent started the initial background delegation.",
        toolSteps: [
          {
            toolName: "SubAgent",
            input: {
              description: "Start repo research",
              prompt: "Inspect the repository and report the first pass findings.",
              subagent_name: "researcher",
              run_in_background: true
            },
            toolCallId: "call_start_agent"
          }
        ]
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_resume",
      name: "agent-resume",
      rootPath: "/tmp/agent-resume",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: ["researcher"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_resume",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_resume",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const firstAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Start a background subagent task." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(firstAccepted.runId);
      return run.status === "completed";
    });

    const firstMessages = await runtimeService.listSessionMessages(session.id, 20);
    const initialToolMessage = firstMessages.items.find(
      (message) => message.role === "tool" && messageToolName(message) === "SubAgent"
    );
    const taskId = extractFieldValue(messageText(initialToolMessage), "task_id");

    expect(taskId).toBeTruthy();

    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        const delegatedTurns = input.messages?.filter((message) => {
          if (message.role !== "user") {
            return false;
          }

          const text = typeof message.content === "string" ? message.content : "";
          return text.includes("<delegated_task");
        }).length ?? 0;

        return {
          text:
            delegatedTurns >= 2
              ? "Resumed subagent result: second pass complete."
              : "Initial subagent result: first pass complete."
        };
      }

      return {
        text: "Parent completed the resumed delegation.",
        toolSteps: [
          {
            toolName: "SubAgent",
            input: {
              description: "Resume repo research",
              prompt: "Continue the same repository investigation and report only new findings.",
              subagent_name: "researcher",
              task_id: taskId
            },
            toolCallId: "call_resume_agent"
          }
        ]
      };
    };

    const secondAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Resume the same subagent task." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(secondAccepted.runId);
      return run.status === "completed";
    });

    const secondRun = await runtimeService.getRun(secondAccepted.runId);
    const delegatedRecords =
      (secondRun.metadata?.delegatedRuns as Array<{ childRunId: string; childSessionId: string }> | undefined) ?? [];

    expect(delegatedRecords).toHaveLength(1);
    expect(delegatedRecords[0]?.childSessionId).toBe(taskId);

    const childMessages = await runtimeService.listSessionMessages(taskId!, 20);
    const childUserMessages = childMessages.items.filter((message) => message.role === "user");
    const childAssistantMessages = childMessages.items.filter((message) => message.role === "assistant");
    const resumedToolMessage = (await runtimeService.listSessionMessages(session.id, 30)).items
      .filter((message) => message.role === "tool" && messageToolName(message) === "SubAgent")
      .at(-1);

    expect(childUserMessages).toHaveLength(2);
    expect(childAssistantMessages).toHaveLength(2);
    expect(messageText(resumedToolMessage)).toContain(`task_id: ${taskId}`);
    expect(messageText(resumedToolMessage)).toContain("Resumed subagent result: second pass complete.");
  });

  it("rejects resuming a missing subagent task_id", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Parent tried to resume a missing task.",
      toolSteps: [
        {
          toolName: "SubAgent",
          input: {
            description: "Resume missing task",
            prompt: "Continue the missing task.",
            task_id: "ses_missing_task"
          },
          toolCallId: "call_missing_task"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_missing_task_resume",
      name: "missing-task-resume",
      rootPath: "/tmp/missing-task-resume",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: ["researcher"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_missing_task_resume",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_missing_task_resume",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Resume a task that does not exist." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "failed";
    });

    await expect(runtimeService.getRun(accepted.runId)).resolves.toMatchObject({
      status: "failed",
      errorCode: "task_not_found"
    });
  });

  it("rejects resuming a subagent task with a mismatched subagent_name", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        return {
          text: "Initial research task complete."
        };
      }

      return {
        text: "Parent delegated work.",
        toolSteps: [
          {
            toolName: "SubAgent",
            input: {
              description: "Start research",
              prompt: "Inspect the repository.",
              subagent_name: "researcher",
              run_in_background: true
            },
            toolCallId: "call_start_research"
          }
        ]
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_task_mismatch",
      name: "task-mismatch",
      rootPath: "/tmp/task-mismatch",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: ["researcher", "reviewer"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        },
        reviewer: {
          name: "reviewer",
          mode: "subagent",
          prompt: "You are the reviewer subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_task_mismatch",
        agents: [
          { name: "plan", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" },
          { name: "reviewer", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_task_mismatch",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const initialAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Start the initial subagent task." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(initialAccepted.runId);
      return run.status === "completed";
    });

    const initialMessages = await runtimeService.listSessionMessages(session.id, 20);
    const initialToolMessage = initialMessages.items.find(
      (message) => message.role === "tool" && messageToolName(message) === "SubAgent"
    );
    const taskId = extractFieldValue(messageText(initialToolMessage), "task_id");

    gateway.streamScenarioFactory = () => ({
      text: "Parent attempted a mismatched resume.",
      toolSteps: [
        {
          toolName: "SubAgent",
          input: {
            description: "Resume as reviewer",
            prompt: "Continue the previous task, but as reviewer.",
            subagent_name: "reviewer",
            task_id: taskId
          },
          toolCallId: "call_mismatch_resume"
        }
      ]
    });

    const resumedAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Resume with the wrong subagent type." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(resumedAccepted.runId);
      return run.status === "failed";
    });

    await expect(runtimeService.getRun(resumedAccepted.runId)).resolves.toMatchObject({
      status: "failed",
      errorCode: "task_agent_mismatch"
    });
  });

  it("runs an action command and stores the result on the run", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action",
      name: "action-workspace",
      rootPath: "/tmp/action-workspace",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo text",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: false,
          directory: "/tmp",
          entry: {
            command: "printf action-ok"
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action",
        agents: [],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo text",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: false
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const accepted = await runtimeService.triggerActionRun({
      workspaceId: "project_action",
      actionName: "debug.echo",
      caller: {
        subjectRef: "dev:test",
        authSource: "standalone_server",
        scopes: [],
        workspaceAccess: []
      }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const run = await runtimeService.getRun(accepted.runId);
    expect(accepted.sessionId).toBeTruthy();
    expect(run.sessionId).toBe(accepted.sessionId);
    expect(run.metadata).toMatchObject({
      actionName: "debug.echo",
      stdout: "action-ok"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "tool_call" && step.name === "debug.echo")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.completed")).toBe(true);
  });

  it("rejects invalid API action input against input_schema before enqueueing the run", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action_validation",
      name: "action-validation",
      rootPath: "/tmp/action-validation",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo mode",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: false,
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string"
              }
            },
            required: ["mode"],
            additionalProperties: false
          },
          directory: "/tmp",
          entry: {
            command: "printf validation-ok"
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action_validation",
        agents: [],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo mode",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: false
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await expect(
      runtimeService.triggerActionRun({
        workspaceId: "project_action_validation",
        actionName: "debug.echo",
        caller: {
          subjectRef: "dev:test",
          authSource: "standalone_server",
          scopes: [],
          workspaceAccess: []
        },
        input: {
          mode: 123
        }
      })
    ).rejects.toMatchObject({
      code: "action_input_invalid",
      statusCode: 400
    });
  });

  it("rejects user-triggered action runs when callableByUser is false", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action_user_guard",
      name: "action-user-guard",
      rootPath: "/tmp/action-user-guard",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo mode",
          callableByApi: true,
          callableByUser: false,
          exposeToLlm: false,
          directory: "/tmp",
          entry: {
            command: "printf forbidden"
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action_user_guard",
        agents: [],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo mode",
            callableByApi: true,
            callableByUser: false,
            exposeToLlm: false
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await expect(
      runtimeService.triggerActionRun({
        workspaceId: "project_action_user_guard",
        actionName: "debug.echo",
        triggerSource: "user",
        caller: {
          subjectRef: "dev:test",
          authSource: "standalone_server",
          scopes: [],
          workspaceAccess: []
        }
      })
    ).rejects.toMatchObject({
      code: "action_not_callable_by_user",
      statusCode: 403
    });
  });

  it("streams session-attached action runs as tool-call and tool-result messages", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action_session_stream",
      name: "action-session-stream",
      rootPath: "/tmp/action-session-stream",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Run actions directly when asked.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo text",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: false,
          retryPolicy: "safe",
          directory: "/tmp",
          entry: {
            command: "printf session-action-ok"
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action_session_stream",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo text",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: false,
            retryPolicy: "safe"
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_action_session_stream",
      caller,
      input: {}
    });

    const accepted = await runtimeService.triggerActionRun({
      workspaceId: "project_action_session_stream",
      sessionId: session.id,
      actionName: "debug.echo",
      caller
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const page = await runtimeService.listSessionMessages(session.id, 20);
    const expectedToolCallId = `action-run:${accepted.runId}:debug.echo`;
    expect(page.items.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(hasToolCallPart(page.items[0], "debug.echo", expectedToolCallId)).toBe(true);
    expect(hasToolResultPart(page.items[1], "debug.echo", expectedToolCallId)).toBe(true);
    expect(messageText(page.items[1])).toBe("session-action-ok");
    expect(page.items[0]?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "action",
      toolDurationMs: expect.any(Number),
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary"
    });
    expect(page.items[1]?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "action",
      toolDurationMs: expect.any(Number),
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary"
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.find((event) => event.event === "tool.started")?.data).toMatchObject({
      toolCallId: expectedToolCallId,
      toolName: "debug.echo",
      sourceType: "action",
      retryPolicy: "safe",
      metadata: {
        agentName: "builder",
        effectiveAgentName: "builder",
        agentMode: "primary"
      }
    });
    expect(events.find((event) => event.event === "tool.completed")?.data).toMatchObject({
      toolCallId: expectedToolCallId,
      toolName: "debug.echo",
      sourceType: "action",
      retryPolicy: "safe",
      output: "session-action-ok",
      metadata: {
        agentName: "builder",
        effectiveAgentName: "builder",
        agentMode: "primary"
      }
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.name === "debug.echo")?.input).toMatchObject({
      toolCallId: expectedToolCallId,
      sourceType: "action",
      retryPolicy: "safe"
    });
  });

  it("persists failed tool output for session-attached action runs", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action_session_failure",
      name: "action-session-failure",
      rootPath: "/tmp/action-session-failure",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Run actions directly when asked.",
          tools: {
            native: [],
            actions: ["debug.fail"],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.fail": {
          name: "debug.fail",
          description: "Fail loudly",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: false,
          retryPolicy: "manual",
          directory: "/tmp",
          entry: {
            command: "node -e \"process.stderr.write('boom fail'); process.exit(1)\""
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action_session_failure",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.fail",
            description: "Fail loudly",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: false,
            retryPolicy: "manual"
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_action_session_failure",
      caller,
      input: {}
    });

    const accepted = await runtimeService.triggerActionRun({
      workspaceId: "project_action_session_failure",
      sessionId: session.id,
      actionName: "debug.fail",
      caller
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "failed";
    });

    const expectedToolCallId = `action-run:${accepted.runId}:debug.fail`;
    const page = await runtimeService.listSessionMessages(session.id, 20);
    expect(page.items.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(hasToolCallPart(page.items[0], "debug.fail", expectedToolCallId)).toBe(true);
    expect(hasToolResultPart(page.items[1], "debug.fail", expectedToolCallId)).toBe(true);
    expect(messageText(page.items[1])).toContain("boom fail");
    expect(page.items[0]?.metadata).toMatchObject({
      toolStatus: "failed",
      toolSourceType: "action",
      toolDurationMs: expect.any(Number),
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary"
    });
    expect(page.items[1]?.metadata).toMatchObject({
      toolStatus: "failed",
      toolSourceType: "action",
      toolDurationMs: expect.any(Number),
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary"
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.find((event) => event.event === "tool.failed")?.data).toMatchObject({
      toolCallId: expectedToolCallId,
      toolName: "debug.fail",
      sourceType: "action",
      retryPolicy: "manual",
      errorCode: "action_failed",
      errorMessage: "boom fail",
      metadata: {
        agentName: "builder",
        effectiveAgentName: "builder",
        agentMode: "primary"
      }
    });
  });

  it("resolves workspace model refs for agent execution", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_workspace_model",
      name: "workspace-model",
      rootPath: "/tmp/workspace-model",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "writer",
      settings: {
        defaultAgent: "writer",
        skillDirs: []
      },
      workspaceModels: {
        "repo-model": {
          provider: "openai",
          name: "gpt-4.1-mini"
        }
      },
      agents: {
        writer: {
          name: "writer",
          mode: "primary",
          prompt: "Use the repo model.",
          modelRef: "workspace/repo-model",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_workspace_model",
        agents: [{ name: "writer", mode: "primary", source: "workspace" }],
        models: [
          {
            ref: "workspace/repo-model",
            name: "repo-model",
            source: "workspace",
            provider: "openai",
            modelName: "gpt-4.1-mini"
          }
        ],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_workspace_model",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(() => gateway.invocations.length > 0);

    expect(gateway.invocations.at(0)?.model).toBe("workspace/repo-model");
    expect(gateway.invocations.at(0)?.input.modelDefinition).toMatchObject({
      provider: "openai",
      name: "gpt-4.1-mini"
    });
  });

  it("times out action runs with a terminal timed_out status", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_timeout_action",
      name: "timeout-action",
      rootPath: "/tmp/timeout-action",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {
        "debug.sleep": {
          name: "debug.sleep",
          description: "Sleep too long",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: false,
          directory: "/tmp",
          entry: {
            command: "sleep 1",
            timeoutSeconds: 0.01
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_timeout_action",
        agents: [],
        models: [],
        actions: [
          {
            name: "debug.sleep",
            description: "Sleep too long",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: false
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const accepted = await runtimeService.triggerActionRun({
      workspaceId: "project_timeout_action",
      actionName: "debug.sleep",
      caller: {
        subjectRef: "dev:test",
        authSource: "standalone_server",
        scopes: [],
        workspaceAccess: []
      }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "timed_out";
    });

    await expect(runtimeService.cancelRun(accepted.runId)).resolves.toEqual({
      runId: accepted.runId,
      status: "cancellation_requested"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "tool_call" && step.name === "debug.sleep")).toBe(true);
    expect(runSteps.items.find((step) => step.name === "debug.sleep")?.status).toBe("failed");
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.timed_out")).toBe(true);
  });

  it("enforces agent run_timeout_seconds with a terminal timed_out status", async () => {
    const gateway = new FakeModelGateway(40);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_timeout_policy",
      name: "run-timeout-policy",
      rootPath: "/tmp/run-timeout-policy",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Be quick.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: [],
          policy: {
            runTimeoutSeconds: 0.02
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_timeout_policy",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_run_timeout_policy",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "This response should time out." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "timed_out";
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
      return events.some((event) => event.event === "run.failed");
    });

    const run = await runtimeService.getRun(accepted.runId);
    expect(run.errorCode).toBe("run_timed_out");

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.find((event) => event.event === "run.failed")?.data).toMatchObject({
      status: "timed_out",
      errorCode: "run_timed_out"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "model_call" && step.status === "failed")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.timed_out")).toBe(true);
  });

  it("enforces agent tool_timeout_seconds for native tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-tool-timeout-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      toolSteps: [
        {
          toolName: "Bash",
          input: {
            command: "sleep 1"
          },
          toolCallId: "call_shell_timeout"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_tool_timeout_policy",
      name: "tool-timeout-policy",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use the shell tool when needed.",
          tools: {
            native: ["Bash"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: [],
          policy: {
            toolTimeoutSeconds: 0.01
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_tool_timeout_policy",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: ["Bash"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_tool_timeout_policy",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run the shell command." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "failed";
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["tool.started", "tool.failed", "run.failed"]));
    expect(events.find((event) => event.event === "tool.failed")?.data).toMatchObject({
      toolCallId: "call_shell_timeout",
      toolName: "Bash",
      sourceType: "native",
      errorCode: "tool_timed_out"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.name === "Bash")?.status).toBe("failed");
    expect(runSteps.items.find((step) => step.name === "Bash")?.output).toMatchObject({
      errorCode: "tool_timed_out"
    });
  });

  it("persists heartbeatAt while a run is active", async () => {
    const gateway = new FakeModelGateway(120);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      runHeartbeatIntervalMs: 30,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_heartbeat",
      name: "run-heartbeat",
      rootPath: "/tmp/run-heartbeat",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Reply slowly.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_heartbeat",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_run_heartbeat",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Please answer." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return typeof run.startedAt === "string" && typeof run.heartbeatAt === "string" && run.heartbeatAt > run.startedAt;
    });

    const activeRun = await runtimeService.getRun(accepted.runId);
    expect(activeRun.heartbeatAt).toBeDefined();

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const completedRun = await runtimeService.getRun(accepted.runId);
    expect(completedRun.heartbeatAt).toBeDefined();
  });

  it("recovers stale active runs as failed", async () => {
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_recovery",
      name: "run-recovery",
      rootPath: "/tmp/run-recovery",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Recover stale runs safely.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_recovery",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.sessionRepository.create({
      id: "ses_recovery",
      workspaceId: "project_run_recovery",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_stale",
      workspaceId: "project_run_recovery",
      sessionId: "ses_recovery",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "running",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      heartbeatAt: "2026-04-01T00:00:20.000Z"
    });

    await persistence.runRepository.create({
      id: "run_recent",
      workspaceId: "project_run_recovery",
      sessionId: "ses_recovery",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_2",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "waiting_tool",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:30.000Z",
      heartbeatAt: "2026-04-01T00:00:55.000Z"
    });

    const recovered = await runtimeService.recoverStaleRuns({
      staleBefore: "2026-04-01T00:00:40.000Z"
    });

    expect(recovered.recoveredRunIds).toEqual(["run_stale"]);

    const staleRun = await runtimeService.getRun("run_stale");
    expect(staleRun.status).toBe("failed");
    expect(staleRun.errorCode).toBe("worker_recovery_failed");
    expect(staleRun.endedAt).toBeDefined();
    expect(staleRun.metadata).toMatchObject({
      recoveryAttempts: 0,
      recoveredBy: "worker_startup",
      recovery: {
        state: "failed",
        strategy: "fail",
        lastOutcome: "failed",
        reason: "fail_closed"
      }
    });

    const recentRun = await runtimeService.getRun("run_recent");
    expect(recentRun.status).toBe("waiting_tool");

    const events = await runtimeService.listSessionEvents("ses_recovery", undefined, "run_stale");
    expect(events.find((event) => event.event === "run.failed")?.data).toMatchObject({
      status: "failed",
      errorCode: "worker_recovery_failed",
      recoveredBy: "worker_startup",
      recoveryState: "failed",
      recoveryReason: "fail_closed"
    });

    const runSteps = await runtimeService.listRunSteps("run_stale");
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.failed")).toBe(true);
  });

  it("requeues stale running runs when stale-run recovery is enabled", async () => {
    const persistence = createMemoryRuntimePersistence();
    const enqueuedRuns: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      ...persistence,
      runQueue: {
        async enqueue(sessionId, runId) {
          enqueuedRuns.push({ sessionId, runId });
        }
      },
      staleRunRecovery: {
        strategy: "requeue_running",
        maxAttempts: 2
      }
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_requeue",
      name: "run-requeue",
      rootPath: "/tmp/run-requeue",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Recover stale runs by requeueing safe work.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_requeue",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.sessionRepository.create({
      id: "ses_requeue",
      workspaceId: "project_run_requeue",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_stale_requeue",
      workspaceId: "project_run_requeue",
      sessionId: "ses_requeue",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "running",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      heartbeatAt: "2026-04-01T00:00:20.000Z"
    });

    const recovered = await runtimeService.recoverStaleRuns({
      staleBefore: "2026-04-01T00:00:40.000Z"
    });

    expect(recovered.recoveredRunIds).toEqual([]);
    expect(recovered.requeuedRunIds).toEqual(["run_stale_requeue"]);
    expect(enqueuedRuns).toEqual([{ sessionId: "ses_requeue", runId: "run_stale_requeue" }]);

    const requeuedRun = await runtimeService.getRun("run_stale_requeue");
    expect(requeuedRun.status).toBe("queued");
    expect(requeuedRun.startedAt).toBeUndefined();
    expect(requeuedRun.heartbeatAt).toBeUndefined();
    expect(requeuedRun.metadata).toMatchObject({
      recoveryAttempts: 1,
      recoveredBy: "worker_startup_requeue",
      recovery: {
        state: "requeued",
        strategy: "requeue_running",
        attempts: 1,
        lastOutcome: "requeued",
        reason: "automatic_requeue"
      }
    });

    const events = await runtimeService.listSessionEvents("ses_requeue", undefined, "run_stale_requeue");
    expect(events.find((event) => event.event === "run.queued")?.data).toMatchObject({
      status: "queued",
      recoveredBy: "worker_startup_requeue",
      recoveryAttempt: 1,
      recoveryState: "requeued",
      recoveryReason: "automatic_requeue",
      recoveryStrategy: "requeue_running"
    });

    const runSteps = await runtimeService.listRunSteps("run_stale_requeue");
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.requeued")).toBe(true);
  });

  it("quarantines stale runs after recovery attempts are exhausted", async () => {
    const persistence = createMemoryRuntimePersistence();
    const enqueuedRuns: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      ...persistence,
      runQueue: {
        async enqueue(sessionId, runId) {
          enqueuedRuns.push({ sessionId, runId });
        }
      },
      staleRunRecovery: {
        strategy: "requeue_all",
        maxAttempts: 2
      }
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_quarantine",
      name: "run-quarantine",
      rootPath: "/tmp/run-quarantine",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Quarantine stale runs after repeated recovery failures.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_quarantine",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.sessionRepository.create({
      id: "ses_quarantine",
      workspaceId: "project_run_quarantine",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_stale_quarantine",
      workspaceId: "project_run_quarantine",
      sessionId: "ses_quarantine",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "running",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      heartbeatAt: "2026-04-01T00:00:20.000Z",
      metadata: {
        recoveryAttempts: 2,
        recovery: {
          attempts: 2,
          maxAttempts: 2,
          state: "requeued",
          lastOutcome: "requeued"
        }
      }
    });

    const recovered = await runtimeService.recoverStaleRuns({
      staleBefore: "2026-04-01T00:00:40.000Z"
    });

    expect(recovered.recoveredRunIds).toEqual(["run_stale_quarantine"]);
    expect(recovered.requeuedRunIds).toEqual([]);
    expect(enqueuedRuns).toEqual([]);

    const quarantinedRun = await runtimeService.getRun("run_stale_quarantine");
    expect(quarantinedRun.status).toBe("failed");
    expect(quarantinedRun.metadata).toMatchObject({
      recoveryAttempts: 2,
      recoveredBy: "worker_startup",
      recovery: {
        state: "quarantined",
        strategy: "requeue_all",
        attempts: 2,
        maxAttempts: 2,
        lastOutcome: "failed",
        reason: "max_attempts_exhausted",
        deadLetter: {
          status: "quarantined",
          reason: "max_attempts_exhausted"
        }
      }
    });

    const events = await runtimeService.listSessionEvents("ses_quarantine", undefined, "run_stale_quarantine");
    expect(events.find((event) => event.event === "run.failed")?.data).toMatchObject({
      status: "failed",
      recoveredBy: "worker_startup",
      recoveryAttempt: 2,
      recoveryState: "quarantined",
      recoveryReason: "max_attempts_exhausted"
    });
  });

  it("manually requeues quarantined recovery runs", async () => {
    const persistence = createMemoryRuntimePersistence();
    const enqueuedRuns: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      ...persistence,
      runQueue: {
        async enqueue(sessionId, runId) {
          enqueuedRuns.push({ sessionId, runId });
        }
      },
      staleRunRecovery: {
        strategy: "requeue_all",
        maxAttempts: 2
      }
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_manual_requeue",
      name: "run-manual-requeue",
      rootPath: "/tmp/run-manual-requeue",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Allow operators to requeue quarantined runs safely.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_manual_requeue",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.sessionRepository.create({
      id: "ses_manual_requeue",
      workspaceId: "project_run_manual_requeue",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_manual_requeue",
      workspaceId: "project_run_manual_requeue",
      sessionId: "ses_manual_requeue",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "failed",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      heartbeatAt: "2026-04-01T00:00:20.000Z",
      endedAt: "2026-04-01T00:01:00.000Z",
      errorCode: "worker_recovery_failed",
      errorMessage: "Run was recovered as failed after worker heartbeat expired.",
      metadata: {
        recoveryAttempts: 2,
        recovery: {
          state: "quarantined",
          strategy: "requeue_all",
          attempts: 2,
          maxAttempts: 2,
          lastOutcome: "failed",
          reason: "max_attempts_exhausted",
          deadLetter: {
            status: "quarantined",
            reason: "max_attempts_exhausted",
            at: "2026-04-01T00:01:00.000Z"
          }
        }
      }
    });

    const result = await runtimeService.requeueRun("run_manual_requeue", "dev:operator");

    expect(result).toMatchObject({
      runId: "run_manual_requeue",
      status: "queued",
      previousStatus: "failed",
      source: "manual_requeue"
    });
    expect(enqueuedRuns).toEqual([{ sessionId: "ses_manual_requeue", runId: "run_manual_requeue" }]);

    const requeuedRun = await runtimeService.getRun("run_manual_requeue");
    expect(requeuedRun.status).toBe("queued");
    expect(requeuedRun.errorCode).toBeUndefined();
    expect(requeuedRun.errorMessage).toBeUndefined();
    expect(requeuedRun.startedAt).toBeUndefined();
    expect(requeuedRun.endedAt).toBeUndefined();
    expect(requeuedRun.metadata).toMatchObject({
      recoveryAttempts: 2,
      recoveredBy: "manual_operator_requeue",
      recoveryRequestedBy: "dev:operator",
      recovery: {
        state: "requeued",
        strategy: "manual",
        attempts: 2,
        maxAttempts: 2,
        lastOutcome: "requeued",
        reason: "manual_operator_requeue",
        manualRequeueCount: 1,
        lastManualRequeueBy: "dev:operator"
      }
    });
    expect((requeuedRun.metadata as { recovery?: { deadLetter?: unknown } }).recovery?.deadLetter).toBeUndefined();

    const events = await runtimeService.listSessionEvents("ses_manual_requeue", undefined, "run_manual_requeue");
    expect(events.find((event) => event.event === "run.queued")?.data).toMatchObject({
      status: "queued",
      recoveredBy: "manual_operator_requeue",
      recoveryState: "requeued",
      recoveryReason: "manual_operator_requeue",
      recoveryStrategy: "manual",
      previousStatus: "failed",
      requestedBy: "dev:operator"
    });
  });

  it("requeues active runs after a drain timeout when configured to requeue", async () => {
    const persistence = createMemoryRuntimePersistence();
    const enqueuedRuns: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      ...persistence,
      runQueue: {
        async enqueue(sessionId, runId) {
          enqueuedRuns.push({ sessionId, runId });
        }
      },
      staleRunRecovery: {
        strategy: "requeue_all",
        maxAttempts: 2
      }
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_drain_requeue",
      name: "run-drain-requeue",
      rootPath: "/tmp/run-drain-requeue",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Recover drain-timed-out runs by requeueing safe work.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_drain_requeue",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.sessionRepository.create({
      id: "ses_drain_requeue",
      workspaceId: "project_run_drain_requeue",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_drain_requeue",
      workspaceId: "project_run_drain_requeue",
      sessionId: "ses_drain_requeue",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "running",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      heartbeatAt: "2026-04-01T00:00:20.000Z"
    });

    await expect(runtimeService.recoverRunAfterDrainTimeout("run_drain_requeue", "requeue_all")).resolves.toBe("requeued");
    expect(enqueuedRuns).toEqual([{ sessionId: "ses_drain_requeue", runId: "run_drain_requeue" }]);

    const requeuedRun = await runtimeService.getRun("run_drain_requeue");
    expect(requeuedRun.status).toBe("queued");
    expect(requeuedRun.metadata).toMatchObject({
      recoveryAttempts: 1,
      recoveredBy: "worker_drain_timeout_requeue",
      recovery: {
        state: "requeued",
        strategy: "requeue_all",
        attempts: 1,
        lastOutcome: "requeued",
        reason: "automatic_requeue"
      }
    });

    const events = await runtimeService.listSessionEvents("ses_drain_requeue", undefined, "run_drain_requeue");
    expect(events.find((event) => event.event === "run.queued")?.data).toMatchObject({
      status: "queued",
      recoveredBy: "worker_drain_timeout_requeue",
      recoveryAttempt: 1,
      recoveryState: "requeued",
      recoveryReason: "automatic_requeue",
      recoveryStrategy: "requeue_all"
    });
  });

  it("quarantines waiting_tool runs after a drain timeout when only running requeue is allowed", async () => {
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      ...persistence,
      runQueue: {
        async enqueue() {
          return undefined;
        }
      },
      staleRunRecovery: {
        strategy: "requeue_all",
        maxAttempts: 2
      }
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_drain_fail",
      name: "run-drain-fail",
      rootPath: "/tmp/run-drain-fail",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Quarantine drain-timeout runs that cannot be safely requeued.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_drain_fail",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.sessionRepository.create({
      id: "ses_drain_fail",
      workspaceId: "project_run_drain_fail",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_drain_fail",
      workspaceId: "project_run_drain_fail",
      sessionId: "ses_drain_fail",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "waiting_tool",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      heartbeatAt: "2026-04-01T00:00:20.000Z"
    });

    await expect(runtimeService.recoverRunAfterDrainTimeout("run_drain_fail", "requeue_running")).resolves.toBe("failed");

    const failedRun = await runtimeService.getRun("run_drain_fail");
    expect(failedRun.status).toBe("failed");
    expect(failedRun.errorCode).toBe("worker_recovery_failed");
    expect(failedRun.metadata).toMatchObject({
      recoveryAttempts: 0,
      recoveredBy: "worker_drain_timeout",
      recovery: {
        state: "quarantined",
        strategy: "requeue_running",
        attempts: 0,
        lastOutcome: "failed",
        reason: "waiting_tool_manual_resume_required",
        deadLetter: {
          status: "quarantined",
          reason: "waiting_tool_manual_resume_required"
        }
      }
    });

    const events = await runtimeService.listSessionEvents("ses_drain_fail", undefined, "run_drain_fail");
    expect(events.find((event) => event.event === "run.failed")?.data).toMatchObject({
      status: "failed",
      recoveredBy: "worker_drain_timeout",
      recoveryAttempt: 0,
      recoveryState: "quarantined",
      recoveryReason: "waiting_tool_manual_resume_required",
      recoveryStrategy: "requeue_running"
    });
  });

  it("keeps runs in waiting_tool until all parallel tool calls finish", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-parallel-tools-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      toolBatches: [
        [
          {
            toolName: "Glob",
            input: {
              pattern: "**/*"
            },
            toolCallId: "call_list_fast",
            delayMs: 150
          },
          {
            toolName: "Glob",
            input: {
              pattern: "**/*"
            },
            toolCallId: "call_list_slow",
            delayMs: 450
          }
        ]
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_parallel_tools",
      name: "parallel-tools",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use Glob when needed.",
          tools: {
            native: ["Glob"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: [],
          policy: {
            parallelToolCalls: true
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_parallel_tools",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: ["Glob"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_parallel_tools",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "List the workspace twice." }
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
      return events.filter((event) => event.event === "tool.completed").length === 1;
    });

    const inFlightRun = await runtimeService.getRun(accepted.runId);
    expect(inFlightRun.status).toBe("waiting_tool");

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const messages = await runtimeService.listSessionMessages(session.id, 20);
    expect(messages.items.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "assistant"
    ]);
    expect(messages.items.filter((message) => hasToolCallPart(message, "Glob", "call_list_fast"))).toHaveLength(1);
    expect(messages.items.filter((message) => hasToolCallPart(message, "Glob", "call_list_slow"))).toHaveLength(1);
    expect(messages.items.find((message) => hasToolCallPart(message, "Glob", "call_list_fast"))?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "native",
      toolDurationMs: expect.any(Number)
    });
    expect(messages.items.find((message) => hasToolCallPart(message, "Glob", "call_list_slow"))?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "native",
      toolDurationMs: expect.any(Number)
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.filter((event) => event.event === "message.completed")).toHaveLength(5);

    expect(gateway.maxConcurrentToolExecutions).toBeGreaterThan(1);
  });

  it("respects agent parallel_tool_calls false by serializing tool batches", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-serial-tools-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      toolBatches: [
        [
          {
            toolName: "Glob",
            input: {
              pattern: "**/*"
            },
            toolCallId: "call_list_one",
            delayMs: 120
          },
          {
            toolName: "Glob",
            input: {
              pattern: "**/*"
            },
            toolCallId: "call_list_two",
            delayMs: 120
          }
        ]
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_serial_tools",
      name: "serial-tools",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use Glob when needed.",
          tools: {
            native: ["Glob"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: [],
          policy: {
            parallelToolCalls: false
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_serial_tools",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: ["Glob"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_serial_tools",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "List the workspace twice." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    expect(gateway.maxConcurrentToolExecutions).toBe(1);
  });

  it("composes system prompts with llm-optimized prompt, actions catalog, skills catalog, and environment summary", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      platformModels: {
        "openai-default": {
          provider: "openai",
          name: "gpt-4o-mini"
        }
      },
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt_compose",
      name: "prompt-compose",
      rootPath: "/tmp/prompt-compose",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [],
        systemPrompt: {
          base: {
            content: "Workspace base prompt."
          },
          llmOptimized: {
            models: {
              "platform/openai-default": {
                content: "Model-specific guidance."
              }
            }
          },
          compose: {
            order: [
              "base",
              "llm_optimized",
              "agent",
              "environment",
              "agent_switches",
              "subagents",
              "actions",
              "skills",
              "project_agents_md"
            ],
            includeEnvironment: true
          }
        }
      },
      projectAgentsMd: "Repository conventions live here.",
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder.",
          tools: {
            native: [],
            actions: [],
            skills: ["repo-explorer"],
            external: []
          },
          switch: ["reviewer"],
          subagents: ["researcher"]
        },
        reviewer: {
          name: "reviewer",
          mode: "primary",
          prompt: "You are the reviewer.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: ["builder"],
          subagents: []
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: "/tmp",
          entry: {
            command: "printf ok"
          }
        }
      },
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Explore the repository.",
          exposeToLlm: true,
          directory: "/tmp/repo-explorer",
          sourceRoot: "/tmp",
          content: "# Repo Explorer"
        }
      },
      toolServers: {
        "docs-server": {
          name: "docs-server",
          enabled: true,
          transportType: "stdio"
        }
      },
      hooks: {},
      catalog: {
        workspaceId: "project_prompt_compose",
        agents: [
          { name: "builder", mode: "primary", source: "workspace" },
          { name: "reviewer", mode: "primary", source: "workspace" },
          { name: "researcher", mode: "subagent", source: "workspace" }
        ],
        models: [{ ref: "platform/openai-default", name: "openai-default", source: "platform", provider: "openai" }],
        actions: [{ name: "debug.echo", description: "Echo", callableByApi: true, callableByUser: true, exposeToLlm: true }],
        skills: [{ name: "repo-explorer", description: "Explore the repository.", exposeToLlm: true }],
        tools: [{ name: "docs-server", transportType: "stdio" }],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_prompt_compose",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "ship it" }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];
    expect(systemMessages).toHaveLength(1);
    const composedSystemPrompt = systemMessages[0]?.content ?? "";

    expect(composedSystemPrompt).toContain("Workspace base prompt.");
    expect(composedSystemPrompt).toContain("Model-specific guidance.");
    expect(composedSystemPrompt).toContain("You are the builder.");
    expect(composedSystemPrompt).toContain("Repository conventions live here.");
    expect(composedSystemPrompt).toContain("<available_actions>");
    expect(composedSystemPrompt).toContain("call `run_action`");
    expect(composedSystemPrompt).toContain("<available_skills>");
    expect(composedSystemPrompt).toContain("call `Skill`");
    expect(composedSystemPrompt).toContain("<available_agent_switches");
    expect(composedSystemPrompt).toContain("<available_agents");
    expect(composedSystemPrompt).toContain("available_actions: debug.echo");
    expect(composedSystemPrompt).toContain("available_skills: repo-explorer");
    expect(composedSystemPrompt).toContain("available_tool_servers: docs-server");
    expect(composedSystemPrompt.indexOf("available_actions: debug.echo")).toBeLessThan(
      composedSystemPrompt.indexOf("<available_agent_switches")
    );
    expect(composedSystemPrompt.indexOf("active_agent: builder")).toBeLessThan(
      composedSystemPrompt.indexOf("<available_agent_switches")
    );
    expect(composedSystemPrompt.indexOf("<available_agent_switches")).toBeLessThan(
      composedSystemPrompt.indexOf("<available_agents")
    );
    expect(composedSystemPrompt.indexOf("<available_agents")).toBeLessThan(
      composedSystemPrompt.indexOf("<available_actions>")
    );
    expect(composedSystemPrompt.indexOf("<available_actions>")).toBeLessThan(composedSystemPrompt.indexOf("<available_skills>"));
    expect(composedSystemPrompt.indexOf("<available_skills>")).toBeLessThan(
      composedSystemPrompt.indexOf("Repository conventions live here.")
    );
  });

  it("activates skills through tool calls and persists tool messages before the final assistant reply", async () => {
    const skillRoot = await mkdtemp(path.join(tmpdir(), "oah-skill-"));
    const skillDirectory = path.join(skillRoot, "repo-explorer");
    await mkdir(path.join(skillDirectory, "references"), { recursive: true });
    await writeFile(path.join(skillDirectory, "references", "guide.md"), "# Repo Guide\nUse ripgrep first.\n", "utf8");

    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "I loaded the repo-explorer skill and its guide.",
      toolSteps: [
        {
          toolName: "Skill",
          input: { name: "repo-explorer" },
          toolCallId: "call_activate"
        },
        {
          toolName: "Skill",
          input: { name: "repo-explorer", resource_path: "references/guide.md" },
          toolCallId: "call_resource"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_skill_activation",
      name: "skill-activation",
      rootPath: skillRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [skillRoot]
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use repo skills when needed.",
          tools: {
            native: [],
            actions: [],
            skills: ["repo-explorer"],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Explore repository structure and helper docs.",
          exposeToLlm: true,
          directory: skillDirectory,
          sourceRoot: skillRoot,
          content: "# Repo Explorer\n\nStart with a quick tree and then inspect focused files."
        }
      },
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_skill_activation",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [{ name: "repo-explorer", description: "Explore repository structure and helper docs.", exposeToLlm: true }],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_skill_activation",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Figure out how to explore the repo safely." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const messages = await runtimeService.listSessionMessages(session.id, 20);
    expect(messages.items.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);

    const activationToolCallMessage = messages.items[1];
    expect(hasToolCallPart(activationToolCallMessage, "Skill", "call_activate")).toBe(true);

    const activationMessage = messages.items[2];
    expect(messageToolName(activationMessage)).toBe("Skill");
    expect(messageToolCallId(activationMessage)).toBe("call_activate");
    expect(messageText(activationMessage)).toContain("skill: repo-explorer");
    expect(messageText(activationMessage)).toContain("content:");
    expect(messageText(activationMessage)).toContain("resources:");
    expect(messageText(activationMessage)).toContain("references/guide.md");

    const resourceToolCallMessage = messages.items[3];
    expect(hasToolCallPart(resourceToolCallMessage, "Skill", "call_resource")).toBe(true);

    const resourceMessage = messages.items[4];
    expect(messageToolName(resourceMessage)).toBe("Skill");
    expect(messageToolCallId(resourceMessage)).toBe("call_resource");
    expect(messageText(resourceMessage)).toContain("skill: repo-explorer");
    expect(messageText(resourceMessage)).toContain("resource_path: references/guide.md");
    expect(messageText(resourceMessage)).toContain("content:");
    expect(messageText(resourceMessage)).toContain("Use ripgrep first.");

    const assistantMessage = messages.items[5];
    expect(messageText(assistantMessage)).toBe("I loaded the repo-explorer skill and its guide.");

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.filter((event) => event.event === "tool.started")).toHaveLength(2);
    expect(events.filter((event) => event.event === "tool.completed")).toHaveLength(2);
    expect(events.find((event) => event.event === "tool.started")?.data).toMatchObject({
      toolName: "Skill",
      sourceType: "skill"
    });
    expect(events.find((event) => event.event === "tool.completed")?.data).toMatchObject({
      toolName: "Skill",
      sourceType: "skill"
    });
    expect(events.filter((event) => event.event === "message.completed")).toHaveLength(5);

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    const modelCallSteps = runSteps.items.filter((step) => step.stepType === "model_call");
    expect(modelCallSteps).toHaveLength(3);
    expect(modelCallSteps.every((step) => step.status === "completed")).toBe(true);
    expect(modelCallSteps.map((step) => step.name)).toEqual(["openai-default", "openai-default", "openai-default"]);
    expect(modelCallSteps[0]?.input).toMatchObject({
      request: {
        model: "openai-default",
        canonicalModelRef: "platform/openai-default",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Use repo skills when needed.")
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("<available_skills>")
          }),
          { role: "user", content: "Figure out how to explore the repo safely." }
        ])
      },
      runtime: {
        messageCount: 2,
        runtimeToolNames: expect.arrayContaining(["Skill"]),
        runtimeTools: expect.arrayContaining([
          expect.objectContaining({
            name: "Skill",
            description: expect.any(String),
            inputSchema: expect.any(Object)
          })
        ]),
        activeToolNames: expect.arrayContaining(["Skill"])
      }
    });
    expect(modelCallSteps[0]?.output).toMatchObject({
      response: {
        finishReason: "tool-calls",
        toolCalls: [
          {
            toolCallId: "call_activate",
            toolName: "Skill",
            input: { name: "repo-explorer" }
          }
        ],
        toolResults: [
          expect.objectContaining({
            toolCallId: "call_activate",
            toolName: "Skill"
          })
        ]
      },
      runtime: {
        toolCallsCount: 1,
        toolResultsCount: 1
      }
    });
    expect(
      modelCallSteps.some((step) =>
        (
          (step.output as { response?: { toolCalls?: Array<{ toolCallId?: string; toolName?: string; input?: unknown }> } } | undefined)
            ?.response?.toolCalls
        )?.some(
          (toolCall) =>
            toolCall.toolCallId === "call_resource" &&
            toolCall.toolName === "Skill" &&
            typeof toolCall.input === "object" &&
            toolCall.input !== null &&
            (toolCall.input as { name?: unknown }).name === "repo-explorer" &&
            (toolCall.input as { resource_path?: unknown }).resource_path === "references/guide.md"
        ) ?? false
      )
    ).toBe(true);
    expect(
      modelCallSteps.some((step) =>
        (
          (step.output as { response?: { toolResults?: Array<{ toolCallId?: string; toolName?: string; output?: unknown }> } } | undefined)
            ?.response?.toolResults
        )?.some(
          (toolResult) => toolResult.toolCallId === "call_resource" && toolResult.toolName === "Skill"
        ) ?? false
      )
    ).toBe(true);
    expect(
      modelCallSteps.some((step) => (step.output as { response?: { finishReason?: string } } | undefined)?.response?.finishReason === "stop")
    ).toBe(true);
    expect(
      modelCallSteps.some(
        (step) => (step.output as { response?: { text?: string } } | undefined)?.response?.text === "I loaded the repo-explorer skill and its guide."
      )
    ).toBe(true);
  });

  it("runs actions through the built-in run_action tool and persists the tool result", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "I ran the debug.echo action.",
      toolSteps: [
        {
          toolName: "run_action",
          input: {
            name: "debug.echo",
            input: {
              mode: "quick"
            }
          },
          toolCallId: "call_action"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action_tool",
      name: "action-tool",
      rootPath: "/tmp/action-tool",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use actions when helpful.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo the provided mode.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          retryPolicy: "safe",
          directory: "/tmp",
          entry: {
            command:
              "node -e \"const input = JSON.parse(process.env.OPENHARNESS_ACTION_INPUT || 'null'); process.stdout.write('mode:' + (input?.mode ?? 'none'));\""
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action_tool",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo the provided mode.",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: true,
            retryPolicy: "safe"
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_action_tool",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run the debug action." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const page = await runtimeService.listSessionMessages(session.id, 20);
    expect(page.items.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(hasToolCallPart(page.items[1], "run_action", "call_action")).toBe(true);
    expect(messageToolName(page.items[2])).toBe("run_action");
    expect(messageToolCallId(page.items[2])).toBe("call_action");
    expect(messageText(page.items[2])).toContain("name: debug.echo");
    expect(messageText(page.items[2])).toContain("exit_code: 0");
    expect(messageText(page.items[2])).toContain("output:");
    expect(messageText(page.items[2])).toContain("mode:quick");
    expect(page.items[1]?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "action",
      toolDurationMs: expect.any(Number),
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary"
    });
    expect(page.items[2]?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "action",
      toolDurationMs: expect.any(Number),
      agentName: "builder",
      effectiveAgentName: "builder",
      agentMode: "primary"
    });
    expect(messageText(page.items[3])).toBe("I ran the debug.echo action.");

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.find((event) => event.event === "tool.started")?.data).toMatchObject({
      toolCallId: "call_action",
      toolName: "run_action",
      retryPolicy: "safe",
      metadata: {
        agentName: "builder",
        effectiveAgentName: "builder",
        agentMode: "primary"
      }
    });
    expect(events.find((event) => event.event === "tool.completed")?.data).toMatchObject({
      toolCallId: "call_action",
      toolName: "run_action",
      retryPolicy: "safe",
      metadata: {
        agentName: "builder",
        effectiveAgentName: "builder",
        agentMode: "primary"
      }
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.name === "run_action")?.input).toMatchObject({
      retryPolicy: "safe",
      input: {
        name: "debug.echo",
        input: {
          mode: "quick"
        }
      }
    });
  });

  it("rejects invalid run_action input against the action input_schema", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "I attempted the action.",
      toolSteps: [
        {
          toolName: "run_action",
          input: {
            name: "debug.echo",
            input: {
              mode: 42
            }
          },
          toolCallId: "call_invalid_action"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action_tool_invalid",
      name: "action-tool-invalid",
      rootPath: "/tmp/action-tool-invalid",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use actions when helpful.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo the provided mode.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          retryPolicy: "safe",
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string"
              }
            },
            required: ["mode"],
            additionalProperties: false
          },
          directory: "/tmp",
          entry: {
            command:
              "node -e \"const input = JSON.parse(process.env.OPENHARNESS_ACTION_INPUT || 'null'); process.stdout.write('mode:' + (input?.mode ?? 'none'));\""
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action_tool_invalid",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo the provided mode.",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: true,
            retryPolicy: "safe"
          }
        ],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_action_tool_invalid",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run the debug action with invalid input." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status !== "queued" && run.status !== "running" && run.status !== "waiting_tool";
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.find((event) => event.event === "tool.failed")?.data).toMatchObject({
      toolCallId: "call_invalid_action",
      toolName: "run_action",
      errorCode: "action_input_invalid"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.stepType === "tool_call" && step.name === "run_action")).toMatchObject({
      status: "failed",
      output: expect.objectContaining({
        errorCode: "action_input_invalid"
      })
    });
  });

  it("projects native tool visibility per agent and exposes them in the workspace catalog", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_native_catalog",
      name: "native-catalog",
      rootPath: "/tmp/native-catalog",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [],
        systemPrompt: {
          compose: {
            order: ["agent", "environment"],
            includeEnvironment: true
          }
        }
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use native tools when helpful.",
          tools: {
            native: ["Bash", "Read"],
            actions: ["debug.echo"],
            skills: ["repo-explorer"],
            external: []
          },
          switch: ["reviewer"],
          subagents: ["reviewer"]
        },
        reviewer: {
          name: "reviewer",
          mode: "subagent",
          prompt: "Review implementation details.",
          tools: {
            native: ["Read"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo input for debugging.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: "/tmp/native-catalog/actions/debug.echo",
          entry: {
            command: "printf ok"
          }
        }
      },
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Explore repository files safely.",
          exposeToLlm: true,
          directory: "/tmp/native-catalog/skills/repo-explorer",
          sourceRoot: "/tmp/native-catalog/skills/repo-explorer",
          content: "# Repo Explorer"
        }
      },
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_native_catalog",
        agents: [
          { name: "builder", mode: "primary", source: "workspace" },
          { name: "reviewer", mode: "subagent", source: "workspace" }
        ],
        models: [],
        actions: [{ name: "debug.echo", description: "Echo input for debugging.", callableByApi: true, callableByUser: true, exposeToLlm: true }],
        skills: [{ name: "repo-explorer", description: "Explore repository files safely.", exposeToLlm: true }],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const catalog = await runtimeService.getWorkspaceCatalog("project_native_catalog");
    expect(catalog.nativeTools).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "TodoWrite"
    ]);
    expect(catalog.runtimeTools).toEqual(expect.arrayContaining(["Bash", "Read", "run_action", "Skill", "AgentSwitch", "SubAgent"]));

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_native_catalog",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Inspect the workspace." }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];
    const environmentMessage = systemMessages.find((message) => message.content.includes("<environment>"))?.content ?? "";

    expect(environmentMessage).toContain("available_native_tools: Bash, Read");
    expect(environmentMessage).not.toContain("Write");
    expect(environmentMessage).not.toContain("file.");
  });

  it("executes native tools and persists their tool results", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-native-tools-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Native tools completed.",
      toolSteps: [
        {
          toolName: "Write",
          input: {
            file_path: "notes/summary.txt",
            content: "hello native tools"
          },
          toolCallId: "call_write"
        },
        {
          toolName: "Read",
          input: {
            file_path: "notes/summary.txt"
          },
          toolCallId: "call_read"
        },
        {
          toolName: "Glob",
          input: {
            pattern: "notes/*.txt"
          },
          toolCallId: "call_glob"
        },
        {
          toolName: "Bash",
          input: {
            command: "printf shell-ok"
          },
          toolCallId: "call_bash"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_native_tools",
      name: "native-tools",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use native tools when useful.",
          tools: {
            native: ["Write", "Read", "Glob", "Bash"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_native_tools",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_native_tools",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Use the native tools." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const writtenContent = await readFile(path.join(workspaceRoot, "notes", "summary.txt"), "utf8");
    expect(writtenContent).toBe("hello native tools");

    const page = await runtimeService.listSessionMessages(session.id, 20);
    expect(page.items.map((message) => (message.role === "assistant" ? "assistant" : messageToolName(message) ?? message.role))).toEqual([
      "user",
      "assistant",
      "Write",
      "assistant",
      "Read",
      "assistant",
      "Glob",
      "assistant",
      "Bash",
      "assistant"
    ]);
    expect(hasToolCallPart(page.items[1], "Write", "call_write")).toBe(true);
    expect(messageText(page.items[2])).toContain("file_path: notes/summary.txt");
    expect(messageText(page.items[2])).toContain("bytes_written:");
    expect(hasToolCallPart(page.items[3], "Read", "call_read")).toBe(true);
    expect(messageText(page.items[4])).toContain("file_path: notes/summary.txt");
    expect(messageText(page.items[4])).toContain("content:");
    expect(messageText(page.items[4])).toContain("hello native tools");
    expect(hasToolCallPart(page.items[5], "Glob", "call_glob")).toBe(true);
    expect(messageText(page.items[6])).toContain("pattern: notes/*.txt");
    expect(messageText(page.items[6])).toContain("files:");
    expect(messageText(page.items[6])).toContain("notes/summary.txt");
    expect(hasToolCallPart(page.items[7], "Bash", "call_bash")).toBe(true);
    expect(messageText(page.items[8])).toContain("exit_code: 0");
    expect(messageText(page.items[8])).toContain("stdout:");
    expect(messageText(page.items[8])).toContain("shell-ok");
    expect(messageText(page.items[9])).toBe("Native tools completed.");

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.name === "Write")?.input).toMatchObject({
      retryPolicy: "manual"
    });
    expect(runSteps.items.find((step) => step.name === "Read")?.input).toMatchObject({
      retryPolicy: "safe"
    });
    expect(runSteps.items.find((step) => step.name === "Glob")?.input).toMatchObject({
      retryPolicy: "safe"
    });
    expect(runSteps.items.find((step) => step.name === "Bash")?.input).toMatchObject({
      retryPolicy: "manual"
    });
  });

  it("persists failed tool executions as tool results so later runs can reuse the session history", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-tool-error-history-"));
    await mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "notes", "broken.html"), "<html>old</html>");
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = (input) => {
      const latestMessage = input.messages?.at(-1);
      const latestContent =
        typeof latestMessage?.content === "string"
          ? latestMessage.content
          : latestMessage?.content
              ?.filter((part): part is Extract<(typeof latestMessage.content)[number], { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join("\n\n") ?? "";

      if (latestContent.includes("First run")) {
        return {
          text: "Recovered after the failed write.",
          toolSteps: [
            {
              toolName: "Write",
              input: {
                file_path: "notes/broken.html",
                content: "<html></html>"
              },
              toolCallId: "call_write_fail",
              continueOnError: true
            }
          ]
        };
      }

      return {
        text: "Second run completed without missing tool results."
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_failed_tool_history",
      name: "failed-tool-history",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use native tools when useful.",
          tools: {
            native: ["Write"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_failed_tool_history",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: ["Write"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_failed_tool_history",
      caller,
      input: {}
    });

    const firstAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "First run should recover from a failed write." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(firstAccepted.runId);
      return run.status === "completed";
    });

    const secondAccepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Second run should still work." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(secondAccepted.runId);
      return run.status === "completed";
    });

    const messages = await runtimeService.listSessionMessages(session.id, 20);
    const failedToolCallMessage = messages.items.find((message) =>
      hasToolCallPart(message, "Write", "call_write_fail")
    );
    const failedToolResultMessage = messages.items.find((message) =>
      hasToolResultPart(message, "Write", "call_write_fail")
    );

    expect(failedToolCallMessage).toBeDefined();
    expect(failedToolResultMessage).toBeDefined();
    expect(messageText(failedToolResultMessage)).toContain("requires the target file to be read first");
    expect(messages.items.at(-1)?.role).toBe("assistant");
    expect(messageText(messages.items.at(-1))).toBe("Second run completed without missing tool results.");

    const firstRunSteps = await runtimeService.listRunSteps(firstAccepted.runId);
    const firstModelCallStep = firstRunSteps.items.find((step) => step.stepType === "model_call");
    expect(firstModelCallStep?.output).toMatchObject({
      response: {
        toolErrors: [
          expect.objectContaining({
            toolCallId: "call_write_fail",
            toolName: "Write"
          })
        ]
      },
      runtime: {
        toolCallsCount: 1,
        toolResultsCount: 0,
        toolErrorsCount: 1
      }
    });

    const secondRun = await runtimeService.getRun(secondAccepted.runId);
    expect(secondRun.errorCode).toBeUndefined();
    expect(secondRun.errorMessage).toBeUndefined();
  });

  it("auto-repairs legacy sessions with missing tool results before continuing the conversation", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Recovered the legacy session."
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_legacy_history_repair",
      name: "legacy-history-repair",
      rootPath: "/tmp/legacy-history-repair",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Continue helping the user.",
          tools: {
            native: ["Write"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_legacy_history_repair",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: ["Write"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_legacy_history_repair",
      caller,
      input: {}
    });

    await persistence.messageRepository.create({
      id: "msg_legacy_user",
      sessionId: session.id,
      role: "user",
      content: "Earlier request",
      createdAt: "2026-04-07T10:00:00.000Z"
    });
    await persistence.messageRepository.create({
      id: "msg_legacy_tool_call",
      sessionId: session.id,
      runId: "run_legacy_missing_tool_result",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_legacy_write",
          toolName: "Write",
          input: {
            file_path: "index.html",
            content: "<html>legacy</html>"
          }
        }
      ],
      createdAt: "2026-04-07T10:00:01.000Z"
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Please continue the legacy session." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const messages = await runtimeService.listSessionMessages(session.id, 20);
    const repairedToolMessage = messages.items.find((message) => message.id === "msg_legacy_tool_call~missing-tool-result");
    expect(repairedToolMessage).toBeDefined();
    expect(hasToolResultPart(repairedToolMessage, "Write", "call_legacy_write")).toBe(true);
    expect(messageText(repairedToolMessage)).toContain(
      "Tool result unavailable because the original run ended before this tool call result was recorded."
    );
    expect(messages.items.at(-1)?.role).toBe("assistant");
    expect(messageText(messages.items.at(-1))).toBe("Recovered the legacy session.");
  });

  it("writes hook and tool call audit records when hooks and actions run", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Audit finished.",
      toolSteps: [
        {
          toolName: "run_action",
          input: {
            name: "debug.echo",
            input: {
              mode: "audit"
            }
          },
          toolCallId: "call_audit_action"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const recordedToolCalls: ToolCallAuditRecord[] = [];
    const recordedHookRuns: HookRunAuditRecord[] = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      toolCallAuditRepository: {
        async create(input) {
          recordedToolCalls.push(input);
          return input;
        }
      },
      hookRunAuditRepository: {
        async create(input) {
          recordedHookRuns.push(input);
          return input;
        }
      }
    });

    await persistence.workspaceRepository.upsert({
      id: "project_audit_records",
      name: "audit-records",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use the available action.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo the provided mode for auditing.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          retryPolicy: "safe",
          directory: "/tmp",
          entry: {
            command:
              "node -e \"const input = JSON.parse(process.env.OPENHARNESS_ACTION_INPUT || 'null'); process.stdout.write('audit:' + (input?.mode ?? 'none'));\""
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-request": {
          name: "rewrite-request",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{model_request:{temperature:0.4}}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_audit_records",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo the provided mode for auditing.",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: true,
            retryPolicy: "safe"
          }
        ],
        skills: [],
        tools: [],
        hooks: [{ name: "rewrite-request", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_audit_records",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Please run the audit action." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    expect(recordedHookRuns.length).toBeGreaterThanOrEqual(1);
    expect(
      recordedHookRuns.find((record) => record.hookName === "rewrite-request" && record.eventName === "before_model_call")
    ).toMatchObject({
      hookName: "rewrite-request",
      eventName: "before_model_call",
      status: "completed",
      capabilities: ["rewrite_model_request"],
      patch: {
        model_request: {
          temperature: 0.4
        }
      }
    });

    expect(recordedToolCalls).toHaveLength(1);
    expect(recordedToolCalls[0]).toMatchObject({
      toolName: "run_action",
      sourceType: "action",
      status: "completed",
      request: {
        toolCallId: "call_audit_action",
        sourceType: "action",
        retryPolicy: "safe",
        input: {
          name: "debug.echo",
          input: {
            mode: "audit"
          }
        }
      }
    });
    expect(recordedToolCalls[0]?.response).toMatchObject({
      sourceType: "action",
      retryPolicy: "safe",
      output: {
        value: expect.stringContaining("audit:audit")
      }
    });
  });

  it("moves runs into waiting_tool while a model tool call is in flight", async () => {
    const skillRoot = await mkdtemp(path.join(tmpdir(), "oah-waiting-tool-"));
    const skillDirectory = path.join(skillRoot, "repo-explorer");
    await mkdir(skillDirectory, { recursive: true });

    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Tool call finished.",
      toolSteps: [
        {
          toolName: "Skill",
          input: { name: "repo-explorer" },
          toolCallId: "call_wait",
          delayMs: 150
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_waiting_tool",
      name: "waiting-tool",
      rootPath: skillRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [skillRoot]
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use skills as needed.",
          tools: {
            native: [],
            actions: [],
            skills: ["repo-explorer"],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Repository explorer",
          exposeToLlm: true,
          directory: skillDirectory,
          sourceRoot: skillRoot,
          content: "# Repo Explorer"
        }
      },
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_waiting_tool",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [{ name: "repo-explorer", description: "Repository explorer", exposeToLlm: true }],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_waiting_tool",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Load the skill." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "waiting_tool";
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });
  });

  it("does not inject environment summaries when compose order omits the environment segment", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt_compose",
      name: "project-prompt-compose",
      rootPath: "/tmp/project-prompt-compose",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      defaultAgent: "assistant",
      settings: {
        defaultAgent: "assistant",
        skillDirs: [],
        systemPrompt: {
          compose: {
            order: ["agent"],
            includeEnvironment: true
          }
        }
      },
      workspaceModels: {},
      agents: {
        assistant: {
          name: "assistant",
          mode: "primary",
          prompt: "You are a project assistant.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_prompt_compose",
        agents: [{ name: "assistant", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_prompt_compose",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];

    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.content).toContain("You are a project assistant.");
    expect(systemMessages[0]?.content.includes("<environment>")).toBe(false);
  });

  it("exposes execution capabilities for project workspaces when actions, skills, tools, and hooks are configured", async () => {
    const gateway = new FakeModelGateway();
    let capturedToolNames: string[] = [];
    let capturedMcpNames: string[] = [];
    gateway.streamScenarioFactory = (_input, options) => {
      capturedToolNames = Object.keys(options?.tools ?? {});
      capturedMcpNames = (options?.toolServers ?? []).map((server) => server.name);
      return {
        text: "project reply"
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_runtime_catalog",
      name: "project-runtime-catalog",
      rootPath: "/tmp/project-runtime-catalog",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      defaultAgent: "assistant",
      settings: {
        defaultAgent: "assistant",
        skillDirs: [],
        systemPrompt: {
          compose: {
            order: ["agent", "actions", "skills"],
            includeEnvironment: true
          }
        }
      },
      workspaceModels: {},
      agents: {
        assistant: {
          name: "assistant",
          mode: "primary",
          prompt: "You are a project assistant.",
          tools: {
            native: [],
            actions: ["dangerous.run"],
            skills: ["repo-explorer"],
            external: ["docs"]
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "dangerous.run": {
          name: "dangerous.run",
          description: "Runs inside project workspaces.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: "/tmp/project-runtime-catalog/actions/dangerous.run",
          entry: {
            command: "printf unsafe"
          }
        }
      },
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Exposed inside project workspaces.",
          exposeToLlm: true,
          directory: "/tmp/project-runtime-catalog/skills/repo-explorer",
          sourceRoot: "/tmp/project-runtime-catalog/skills/repo-explorer",
          content: "# Repo Explorer"
        }
      },
      toolServers: {
        docs: {
          name: "docs",
          enabled: true,
          transportType: "http",
          url: "http://127.0.0.1:9123"
        }
      },
      hooks: {
        "rewrite-request": {
          name: "rewrite-request",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({systemMessage:\"Hook warning.\",hookSpecificOutput:{patch:{model_request:{temperature:0.9}}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_runtime_catalog",
        agents: [{ name: "assistant", mode: "primary", source: "workspace" }],
        models: [],
        actions: [{ name: "dangerous.run", callableByApi: true, callableByUser: true, exposeToLlm: true }],
        skills: [{ name: "repo-explorer", exposeToLlm: true }],
        tools: [{ name: "docs", transportType: "http" }],
        hooks: [{ name: "rewrite-request", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: ["shell"]
      }
    });

    const catalog = await runtimeService.getWorkspaceCatalog("project_runtime_catalog");
    expect(catalog.actions).toEqual([{ name: "dangerous.run", callableByApi: true, callableByUser: true, exposeToLlm: true }]);
    expect(catalog.skills).toEqual([{ name: "repo-explorer", exposeToLlm: true }]);
    expect(catalog.tools).toEqual([{ name: "docs", transportType: "http" }]);
    expect(catalog.hooks).toEqual([{ name: "rewrite-request", handlerType: "command", events: ["before_model_call"] }]);
    expect(catalog.nativeTools).toEqual(expect.arrayContaining(["Bash", "Read", "Write"]));
    expect(catalog.runtimeTools).toEqual(expect.arrayContaining(["run_action", "Skill"]));

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_runtime_catalog",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];
    expect(systemMessages.some((message) => message.content.includes("You are a project assistant."))).toBe(true);
    expect(systemMessages.some((message) => message.content.includes("<available_actions>"))).toBe(true);
    expect(systemMessages.some((message) => message.content.includes("<available_skills>"))).toBe(true);
    expect(capturedToolNames).toEqual(expect.arrayContaining(["run_action", "Skill"]));
    expect(capturedMcpNames).toEqual(["docs"]);

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "hook")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "tool_call")).toBe(false);
  });

  it("applies before_model_call command hooks to patch request and inject context", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_before_hook",
      name: "before-hook",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Hook-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-request": {
          name: "rewrite-request",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({systemMessage:\"Hook warning.\",hookSpecificOutput:{additionalContext:\"Check secrets before answering.\",patch:{model_request:{temperature:0.7,top_p:0.6}}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_before_hook",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [{ name: "rewrite-request", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_before_hook",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      if (gateway.invocations.length > 0) {
        return true;
      }

      const runs = await runtimeService.listSessionEvents(session.id);
      return runs.some((event) => event.event === "run.failed");
    });
    const run = await runtimeService.listSessionEvents(session.id);
    const acceptedRunId = run.find((event) => event.event === "run.queued")?.runId;
    const runSteps = acceptedRunId ? await runtimeService.listRunSteps(acceptedRunId) : { items: [] };
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-request")).toBe(true);
    expect(
      runSteps.items.find((step) => step.stepType === "hook" && step.name === "rewrite-request")?.status
    ).toBe("completed");
    expect(gateway.invocations.at(0)?.input.temperature).toBe(0.7);
    expect(gateway.invocations.at(0)?.input.topP).toBe(0.6);
    expect(gateway.invocations.at(0)?.input.messages?.some((message) => message.content.includes("Hook warning."))).toBe(true);
    expect(
      gateway.invocations.at(0)?.input.messages?.some((message) => message.content.includes("Check secrets before answering."))
    ).toBe(true);
  });

  it("treats command hook timeout_seconds as a non-blocking timeout and emits a notice", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_before_hook_timeout",
      name: "before-hook-timeout",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Hook-timeout-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "slow-before-hook": {
          name: "slow-before-hook",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              timeout_seconds: 1,
              command:
                "cat >/dev/null; node -e 'setTimeout(() => process.stdout.write(JSON.stringify({systemMessage:\"too late\"})), 2000)'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_before_hook_timeout",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [{ name: "slow-before-hook", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_before_hook_timeout",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    }, 5_000);

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "slow-before-hook")).toBe(true);
    expect(runSteps.items.find((step) => step.stepType === "hook" && step.name === "slow-before-hook")?.status).toBe("failed");
    expect(events.find((event) => event.event === "hook.notice")?.data).toMatchObject({
      hookName: "slow-before-hook",
      eventName: "before_model_call",
      errorCode: "hook_execution_failed"
    });
    expect(gateway.invocations.at(0)?.input.messages?.some((message) => message.content === "too late")).toBe(false);
  });

  it("treats prompt hook timeout_seconds as a non-blocking timeout and emits a notice", async () => {
    const gateway = new FakeModelGateway();
    gateway.generateDelayMs = 2_000;
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt_hook_timeout",
      name: "prompt-hook-timeout",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Prompt-hook-timeout-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "slow-prompt-hook": {
          name: "slow-prompt-hook",
          events: ["after_model_call"],
          handlerType: "prompt",
          capabilities: ["rewrite_model_response"],
          definition: {
            handler: {
              type: "prompt",
              timeout_seconds: 1,
              prompt: {
                inline: "return a JSON patch"
              }
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_prompt_hook_timeout",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [{ name: "slow-prompt-hook", handlerType: "prompt", events: ["after_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_prompt_hook_timeout",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    }, 5_000);

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    const assistantMessages = await runtimeService.listSessionMessages(session.id, 50);

    expect(runSteps.items.find((step) => step.stepType === "hook" && step.name === "slow-prompt-hook")?.status).toBe("failed");
    expect(events.find((event) => event.event === "hook.notice")?.data).toMatchObject({
      hookName: "slow-prompt-hook",
      eventName: "after_model_call",
      errorCode: "hook_execution_failed"
    });
    expect(messageText(assistantMessages.items.find((message) => message.role === "assistant"))).toBe("reply:hello");
  });

  it("applies context build hooks before and after composing model messages", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_context_hooks",
      name: "context-hooks",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Context-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-context": {
          name: "rewrite-context",
          events: ["before_context_build"],
          handlerType: "command",
          capabilities: ["rewrite_context"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{context:{messages:[{role:\"user\",content:\"rewritten hello\"}]}}}}))'"
            }
          }
        },
        "annotate-context": {
          name: "annotate-context",
          events: ["after_context_build"],
          handlerType: "command",
          capabilities: [],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({systemMessage:\"Context assembled.\"}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_context_hooks",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [
          { name: "rewrite-context", handlerType: "command", events: ["before_context_build"] },
          { name: "annotate-context", handlerType: "command", events: ["after_context_build"] }
        ],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_context_hooks",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const messages = gateway.invocations.at(0)?.input.messages ?? [];
    const events = await runtimeService.listSessionEvents(session.id);
    const acceptedRunId = events.find((event) => event.event === "run.queued")?.runId;
    const runSteps = acceptedRunId ? await runtimeService.listRunSteps(acceptedRunId) : { items: [] };

    expect(messages.some((message) => message.role === "user" && message.content === "rewritten hello")).toBe(true);
    expect(messages.some((message) => message.role === "user" && message.content === "hello")).toBe(false);
    expect(messages.some((message) => message.role === "system" && message.content.includes("Context assembled."))).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-context")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "annotate-context")).toBe(true);
  });

  it("applies tool dispatch hooks to rewrite tool input and output", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "oah-tool-hooks-"));
    const actionDir = path.join(tempDir, "actions", "echo");
    await mkdir(actionDir, { recursive: true });
    await writeFile(
      path.join(actionDir, "echo-input.js"),
      'process.stdout.write(process.env.OPENHARNESS_ACTION_INPUT || "");',
      "utf8"
    );

    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "tool flow complete",
      toolSteps: [
        {
          toolName: "run_action",
          input: {
            name: "debug.echo",
            input: {
              message: "original"
            }
          },
          toolCallId: "call_tool"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_tool_hooks",
      name: "tool-hooks",
      rootPath: tempDir,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Tool-aware builder.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo action input",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: actionDir,
          entry: {
            command: "node ./echo-input.js"
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-tool-input": {
          name: "rewrite-tool-input",
          events: ["before_tool_dispatch"],
          matcher: "run_action",
          handlerType: "command",
          capabilities: ["rewrite_tool_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{tool_input:{input:{message:\"patched\"}}}}}))'"
            }
          }
        },
        "rewrite-tool-output": {
          name: "rewrite-tool-output",
          events: ["after_tool_dispatch"],
          matcher: "run_action",
          handlerType: "command",
          capabilities: ["rewrite_tool_response"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{tool_output:\"tool output patched\"}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_tool_hooks",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo action input",
            exposeToLlm: true,
            callableByUser: true,
            callableByApi: true
          }
        ],
        skills: [],
        tools: [],
        hooks: [
          {
            name: "rewrite-tool-input",
            matcher: "run_action",
            handlerType: "command",
            events: ["before_tool_dispatch"]
          },
          {
            name: "rewrite-tool-output",
            matcher: "run_action",
            handlerType: "command",
            events: ["after_tool_dispatch"]
          }
        ],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_tool_hooks",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run the debug action." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const messages = await runtimeService.listSessionMessages(session.id, 50);
    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    const toolStarted = events.find((event) => event.event === "tool.started");
    const toolMessage = messages.items.find((message) => message.role === "tool");
    const toolStep = runSteps.items.find((step) => step.stepType === "tool_call" && step.name === "run_action");

    expect((toolStarted?.data.input as { input?: { message?: string } } | undefined)?.input?.message).toBe("patched");
    expect((toolStep?.input?.input as { input?: { message?: string } } | undefined)?.input?.message).toBe("patched");
    expect(messageText(toolMessage)).toBe("tool output patched");
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-tool-input")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-tool-output")).toBe(true);
  });

  it("applies after_model_call prompt hooks to rewrite model output", async () => {
    const gateway = new FakeModelGateway();
    gateway.generateResponseFactory = (input) => {
      const content = input.prompt ?? input.messages?.map((message) => message.content).join("\n") ?? "";
      if (!content.includes("rewrite-output")) {
        return undefined;
      }

      return {
        model: input.model ?? "openai-default",
        text: JSON.stringify({
          hookSpecificOutput: {
            patch: {
              model_response: {
                text: "hooked reply"
              }
            }
          }
        }),
        finishReason: "stop"
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_after_hook",
      name: "after-hook",
      rootPath: "/tmp/after-hook",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "After-hook builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-output": {
          name: "rewrite-output",
          events: ["after_model_call"],
          handlerType: "prompt",
          capabilities: ["rewrite_model_response"],
          definition: {
            handler: {
              type: "prompt",
              prompt: {
                inline: "rewrite-output"
              }
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_after_hook",
        agents: [{ name: "builder", mode: "primary", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [{ name: "rewrite-output", handlerType: "prompt", events: ["after_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_after_hook",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-output")).toBe(true);
    expect(
      runSteps.items.find((step) => step.stepType === "hook" && step.name === "rewrite-output")?.status
    ).toBe("completed");

    const page = await runtimeService.listSessionMessages(session.id, 50);
    expect(messageText(page.items.find((message) => message.role === "assistant"))).toBe("hooked reply");
  });
});
