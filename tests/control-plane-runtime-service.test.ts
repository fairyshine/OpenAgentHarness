import { describe, expect, it, vi } from "vitest";

import type { Session } from "@oah/api-contracts";
import { ControlPlaneEngineService } from "@oah/engine-core";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "ses_1",
    workspaceId: "ws_1",
    subjectRef: "user_1",
    agentName: "assistant",
    activeAgentName: "assistant",
    status: "active",
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:00.000Z",
    ...overrides
  };
}

function createKernel(overrides: Partial<ConstructorParameters<typeof ControlPlaneEngineService>[0]> = {}) {
  return {
    createWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    getWorkspace: vi.fn(),
    getWorkspaceRecord: vi.fn(),
    getWorkspaceCatalog: vi.fn(),
    listWorkspaceEntries: vi.fn(),
    getWorkspaceFileContent: vi.fn(),
    putWorkspaceFileContent: vi.fn(),
    uploadWorkspaceFile: vi.fn(),
    getWorkspaceFileDownload: vi.fn(),
    openWorkspaceFileDownload: vi.fn(),
    getWorkspaceFileStat: vi.fn(),
    runWorkspaceCommandForeground: vi.fn(),
    runWorkspaceCommandProcess: vi.fn(),
    runWorkspaceCommandBackground: vi.fn(),
    createWorkspaceDirectory: vi.fn(),
    deleteWorkspaceEntry: vi.fn(),
    moveWorkspaceEntry: vi.fn(),
    deleteWorkspace: vi.fn(),
    createSession: vi.fn(async () => createSession()),
    listWorkspaceSessions: vi.fn(),
    triggerActionRun: vi.fn(),
    getSession: vi.fn(async () => createSession()),
    updateSession: vi.fn(async () => createSession()),
    deleteSession: vi.fn(),
    listSessionMessages: vi.fn(async () => ({ items: [] })),
    listSessionRuns: vi.fn(async () => ({ items: [] })),
    createSessionMessage: vi.fn(async () => ({ messageId: "msg_1", runId: "run_1", status: "queued" as const })),
    listSessionEvents: vi.fn(async () => []),
    subscribeSessionEvents: vi.fn(() => () => undefined),
    getRun: vi.fn(async () => ({
      id: "run_1",
      workspaceId: "ws_1",
      sessionId: "ses_1",
      initiatorRef: "user_1",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "assistant",
      effectiveAgentName: "assistant",
      switchCount: 0,
      status: "queued",
      createdAt: "2026-04-17T00:00:00.000Z"
    })),
    listRunSteps: vi.fn(async () => ({ items: [] })),
    cancelRun: vi.fn(async () => ({ runId: "run_1", status: "cancellation_requested" as const })),
    requeueRun: vi.fn(async () => ({
      runId: "run_1",
      status: "queued" as const,
      previousStatus: "failed" as const,
      source: "manual_requeue" as const
    })),
    ...overrides
  };
}

describe("ControlPlaneEngineService", () => {
  it("refreshes workspace definitions before session creation", async () => {
    const refreshWorkspaceDefinition = vi.fn(async () => undefined);
    const createSessionKernel = vi.fn(async () => createSession());
    const service = new ControlPlaneEngineService(
      createKernel({
        createSession: createSessionKernel
      }),
      {
        workspaceDefinitionRefresher: {
          refreshWorkspaceDefinition
        }
      }
    );

    await service.createSession({
      workspaceId: "ws_1",
      caller: { subjectRef: "user_1", authSource: "test", scopes: [], workspaceAccess: [] },
      input: { title: "Demo" }
    });

    expect(refreshWorkspaceDefinition).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceDefinition).toHaveBeenCalledWith("ws_1");
    expect(refreshWorkspaceDefinition.mock.invocationCallOrder[0]).toBeLessThan(createSessionKernel.mock.invocationCallOrder[0]);
  });

  it("logs and swallows workspace definition refresh failures before session creation", async () => {
    const warn = vi.fn();
    const createSessionKernel = vi.fn(async () => createSession());
    const service = new ControlPlaneEngineService(
      createKernel({
        createSession: createSessionKernel
      }),
      {
        workspaceDefinitionRefresher: {
          refreshWorkspaceDefinition: vi.fn(async () => {
            throw new Error("refresh failed");
          })
        },
        logger: {
          warn
        }
      }
    );

    await expect(
      service.createSession({
        workspaceId: "ws_1",
        caller: { subjectRef: "user_1", authSource: "test", scopes: [], workspaceAccess: [] },
        input: { title: "Demo" }
      })
    ).resolves.toMatchObject({ id: "ses_1" });

    expect(createSessionKernel).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Workspace definition refresh failed before session creation.", {
      workspaceId: "ws_1",
      errorMessage: "refresh failed"
    });
  });

  it("starts workspace prewarm after session creation without blocking the response", async () => {
    let resolvePrewarm: (() => void) | undefined;
    const prewarmWorkspace = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrewarm = resolve;
        })
    );
    const service = new ControlPlaneEngineService(createKernel(), {
      workspacePrewarmer: {
        prewarmWorkspace
      }
    });

    const session = await service.createSession({
      workspaceId: "ws_1",
      caller: { subjectRef: "user_1", authSource: "test", scopes: [], workspaceAccess: [] },
      input: { title: "Demo" }
    });

    expect(session.id).toBe("ses_1");
    expect(prewarmWorkspace).toHaveBeenCalledTimes(1);
    expect(prewarmWorkspace).toHaveBeenCalledWith("ws_1");

    resolvePrewarm?.();
  });

  it("logs and swallows workspace prewarm failures after session creation", async () => {
    const warn = vi.fn();
    const service = new ControlPlaneEngineService(createKernel(), {
      workspacePrewarmer: {
        prewarmWorkspace: vi.fn(async () => {
          throw new Error("prewarm failed");
        })
      },
      logger: {
        warn
      }
    });

    await expect(
      service.createSession({
        workspaceId: "ws_1",
        caller: { subjectRef: "user_1", authSource: "test", scopes: [], workspaceAccess: [] },
        input: { title: "Demo" }
      })
    ).resolves.toMatchObject({ id: "ses_1" });
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith("Workspace prewarm failed after session creation.", {
      workspaceId: "ws_1",
      errorMessage: "prewarm failed"
    });
  });

  it("refreshes workspace activity after session operations", async () => {
    const touchWorkspace = vi.fn(async () => undefined);
    const session = createSession();
    const service = new ControlPlaneEngineService(
      {
        createWorkspace: vi.fn(),
        listWorkspaces: vi.fn(),
        getWorkspace: vi.fn(),
        getWorkspaceRecord: vi.fn(),
        getWorkspaceCatalog: vi.fn(),
        listWorkspaceEntries: vi.fn(),
        getWorkspaceFileContent: vi.fn(),
        putWorkspaceFileContent: vi.fn(),
        uploadWorkspaceFile: vi.fn(),
        getWorkspaceFileDownload: vi.fn(),
        openWorkspaceFileDownload: vi.fn(),
        getWorkspaceFileStat: vi.fn(),
        runWorkspaceCommandForeground: vi.fn(),
        runWorkspaceCommandProcess: vi.fn(),
        runWorkspaceCommandBackground: vi.fn(),
        createWorkspaceDirectory: vi.fn(),
        deleteWorkspaceEntry: vi.fn(),
        moveWorkspaceEntry: vi.fn(),
        deleteWorkspace: vi.fn(),
        createSession: vi.fn(async () => session),
        listWorkspaceSessions: vi.fn(),
        triggerActionRun: vi.fn(),
        getSession: vi.fn(async () => session),
        updateSession: vi.fn(async () => session),
        deleteSession: vi.fn(),
        listSessionMessages: vi.fn(async () => ({ items: [] })),
        listSessionRuns: vi.fn(async () => ({ items: [] })),
        createSessionMessage: vi.fn(async () => ({ messageId: "msg_1", runId: "run_1", status: "queued" as const })),
        listSessionEvents: vi.fn(async () => []),
        subscribeSessionEvents: vi.fn(() => () => undefined),
        getRun: vi.fn(async () => ({
          id: "run_1",
          workspaceId: "ws_1",
          sessionId: "ses_1",
          initiatorRef: "user_1",
          triggerType: "message",
          triggerRef: "msg_1",
          agentName: "assistant",
          effectiveAgentName: "assistant",
          switchCount: 0,
          status: "queued",
          createdAt: "2026-04-17T00:00:00.000Z"
        })),
        listRunSteps: vi.fn(async () => ({ items: [] })),
        cancelRun: vi.fn(async () => ({ runId: "run_1", status: "cancellation_requested" as const })),
        requeueRun: vi.fn(async () => ({
          runId: "run_1",
          status: "queued" as const,
          previousStatus: "failed" as const,
          source: "manual_requeue" as const
        }))
      },
      {
        workspaceActivityTracker: {
          touchWorkspace
        }
      }
    );

    await service.createSession({
      workspaceId: "ws_1",
      caller: { subjectRef: "user_1", authSource: "test", scopes: [], workspaceAccess: [] },
      input: { title: "Demo" }
    });
    await service.getSession("ses_1");
    await service.createSessionMessage({
      sessionId: "ses_1",
      caller: { subjectRef: "user_1", authSource: "test", scopes: [], workspaceAccess: [] },
      input: { content: "hello" }
    });
    await service.listSessionMessages("ses_1");
    await service.listSessionEvents("ses_1");
    await service.deleteSession("ses_1");

    expect(touchWorkspace).toHaveBeenCalledTimes(6);
    expect(touchWorkspace).toHaveBeenNthCalledWith(1, "ws_1");
    expect(touchWorkspace).toHaveBeenNthCalledWith(2, "ws_1");
    expect(touchWorkspace).toHaveBeenNthCalledWith(3, "ws_1");
    expect(touchWorkspace).toHaveBeenNthCalledWith(4, "ws_1");
    expect(touchWorkspace).toHaveBeenNthCalledWith(5, "ws_1");
    expect(touchWorkspace).toHaveBeenNthCalledWith(6, "ws_1");
  });

  it("refreshes workspace activity for workspace and run reads", async () => {
    const touchWorkspace = vi.fn(async () => undefined);
    const service = new ControlPlaneEngineService(
      {
        createWorkspace: vi.fn(),
        listWorkspaces: vi.fn(),
        getWorkspace: vi.fn(async () => ({ id: "ws_1" })),
        getWorkspaceRecord: vi.fn(async () => ({ id: "ws_1" })),
        getWorkspaceCatalog: vi.fn(async () => ({ agents: [], models: [], actions: [], toolServers: [], hooks: [] })),
        listWorkspaceEntries: vi.fn(),
        getWorkspaceFileContent: vi.fn(),
        putWorkspaceFileContent: vi.fn(),
        uploadWorkspaceFile: vi.fn(),
        getWorkspaceFileDownload: vi.fn(),
        openWorkspaceFileDownload: vi.fn(),
        getWorkspaceFileStat: vi.fn(),
        runWorkspaceCommandForeground: vi.fn(),
        runWorkspaceCommandProcess: vi.fn(),
        runWorkspaceCommandBackground: vi.fn(),
        createWorkspaceDirectory: vi.fn(),
        deleteWorkspaceEntry: vi.fn(),
        moveWorkspaceEntry: vi.fn(),
        deleteWorkspace: vi.fn(),
        createSession: vi.fn(),
        listWorkspaceSessions: vi.fn(),
        triggerActionRun: vi.fn(),
        getSession: vi.fn(async () => createSession()),
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
        listSessionMessages: vi.fn(),
        listSessionRuns: vi.fn(),
        createSessionMessage: vi.fn(),
        listSessionEvents: vi.fn(),
        subscribeSessionEvents: vi.fn(() => () => undefined),
        getRun: vi.fn(async () => ({
          id: "run_1",
          workspaceId: "ws_1",
          sessionId: "ses_1",
          initiatorRef: "user_1",
          triggerType: "message",
          triggerRef: "msg_1",
          agentName: "assistant",
          effectiveAgentName: "assistant",
          switchCount: 0,
          status: "queued",
          createdAt: "2026-04-17T00:00:00.000Z"
        })),
        listRunSteps: vi.fn(async () => ({ items: [] })),
        cancelRun: vi.fn(async () => ({ runId: "run_1", status: "cancellation_requested" as const })),
        requeueRun: vi.fn(async () => ({
          runId: "run_1",
          status: "queued" as const,
          previousStatus: "failed" as const,
          source: "manual_requeue" as const
        }))
      },
      {
        workspaceActivityTracker: {
          touchWorkspace
        }
      }
    );

    await service.getWorkspace("ws_1");
    await service.getWorkspaceCatalog("ws_1");
    await service.getRun("run_1");
    await service.listRunSteps("run_1");

    expect(touchWorkspace).toHaveBeenCalledTimes(4);
    expect(touchWorkspace).toHaveBeenCalledWith("ws_1");
  });

  it("refreshes workspace activity for file and command operations", async () => {
    const touchWorkspace = vi.fn(async () => undefined);
    const releaseDownload = vi.fn(async () => undefined);
    const service = new ControlPlaneEngineService(
      {
        createWorkspace: vi.fn(),
        listWorkspaces: vi.fn(),
        getWorkspace: vi.fn(),
        getWorkspaceRecord: vi.fn(),
        getWorkspaceCatalog: vi.fn(),
        listWorkspaceEntries: vi.fn(async () => ({ items: [] })),
        getWorkspaceFileContent: vi.fn(async () => ({ path: "/workspace/hello.txt", content: "hello" })),
        putWorkspaceFileContent: vi.fn(async () => ({ path: "/workspace/hello.txt", type: "file", sizeBytes: 5 })),
        uploadWorkspaceFile: vi.fn(async () => ({ path: "/workspace/upload.bin", type: "file", sizeBytes: 5 })),
        getWorkspaceFileDownload: vi.fn(async () => ({
          name: "hello.txt",
          path: "/workspace/hello.txt",
          sizeBytes: 5,
          etag: "etag",
          updatedAt: "2026-04-17T00:00:00.000Z",
          openReadStream: vi.fn()
        })),
        openWorkspaceFileDownload: vi.fn(async () => ({
          file: {
            name: "hello.txt",
            path: "/workspace/hello.txt",
            sizeBytes: 5,
            etag: "etag",
            updatedAt: "2026-04-17T00:00:00.000Z",
            openReadStream: vi.fn()
          },
          release: releaseDownload
        })),
        getWorkspaceFileStat: vi.fn(async () => ({ kind: "file", path: "/workspace/hello.txt", sizeBytes: 5 })),
        runWorkspaceCommandForeground: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
        runWorkspaceCommandProcess: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
        runWorkspaceCommandBackground: vi.fn(async () => ({ taskId: "task_1", outputPath: "/workspace/out.log" })),
        createWorkspaceDirectory: vi.fn(async () => ({ path: "/workspace/docs", type: "directory", sizeBytes: 0 })),
        deleteWorkspaceEntry: vi.fn(async () => ({ deleted: true, path: "/workspace/old.txt" })),
        moveWorkspaceEntry: vi.fn(async () => ({ path: "/workspace/new.txt", type: "file", sizeBytes: 5 })),
        deleteWorkspace: vi.fn(async () => undefined),
        createSession: vi.fn(),
        listWorkspaceSessions: vi.fn(),
        triggerActionRun: vi.fn(),
        getSession: vi.fn(async () => createSession()),
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
        listSessionMessages: vi.fn(),
        listSessionRuns: vi.fn(),
        createSessionMessage: vi.fn(),
        listSessionEvents: vi.fn(),
        subscribeSessionEvents: vi.fn(() => () => undefined),
        getRun: vi.fn(async () => ({
          id: "run_1",
          workspaceId: "ws_1",
          sessionId: "ses_1",
          initiatorRef: "user_1",
          triggerType: "message",
          triggerRef: "msg_1",
          agentName: "assistant",
          effectiveAgentName: "assistant",
          switchCount: 0,
          status: "queued",
          createdAt: "2026-04-17T00:00:00.000Z"
        })),
        listRunSteps: vi.fn(async () => ({ items: [] })),
        cancelRun: vi.fn(async () => ({ runId: "run_1", status: "cancellation_requested" as const })),
        requeueRun: vi.fn(async () => ({
          runId: "run_1",
          status: "queued" as const,
          previousStatus: "failed" as const,
          source: "manual_requeue" as const
        }))
      },
      {
        workspaceActivityTracker: {
          touchWorkspace
        }
      }
    );

    await service.listWorkspaceEntries("ws_1", {
      pageSize: 20,
      sortBy: "path",
      sortOrder: "asc"
    });
    await service.getWorkspaceFileContent("ws_1", { path: "/workspace/hello.txt", encoding: "utf8" });
    await service.putWorkspaceFileContent("ws_1", {
      path: "/workspace/hello.txt",
      content: "hello",
      encoding: "utf8"
    });
    await service.uploadWorkspaceFile("ws_1", {
      path: "/workspace/upload.bin",
      data: Buffer.from("hello")
    });
    await service.getWorkspaceFileDownload("ws_1", "/workspace/hello.txt");
    const downloadHandle = await service.openWorkspaceFileDownload("ws_1", "/workspace/hello.txt");
    await downloadHandle.release();
    await service.getWorkspaceFileStat("ws_1", "/workspace/hello.txt");
    await service.runWorkspaceCommandForeground("ws_1", { command: "pwd" });
    await service.runWorkspaceCommandProcess("ws_1", { executable: "pwd", args: [] });
    await service.runWorkspaceCommandBackground("ws_1", { command: "pwd", sessionId: "ses_1" });
    await service.createWorkspaceDirectory("ws_1", { path: "/workspace/docs", createParents: true });
    await service.deleteWorkspaceEntry("ws_1", { path: "/workspace/old.txt", recursive: false });
    await service.moveWorkspaceEntry("ws_1", {
      sourcePath: "/workspace/old.txt",
      targetPath: "/workspace/new.txt",
      overwrite: true
    });
    await service.deleteWorkspace("ws_1");

    expect(touchWorkspace).toHaveBeenCalledTimes(14);
    expect(touchWorkspace).toHaveBeenNthCalledWith(1, "ws_1");
    expect(touchWorkspace).toHaveBeenLastCalledWith("ws_1");
  });
});
