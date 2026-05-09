import { describe, expect, it } from "vitest";

import { EngineService, createId, nowIso } from "@oah/engine-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import { FakeModelGateway } from "./helpers/fake-model-runtime";

async function createLazyRuntime() {
    const persistence = createMemoryRuntimePersistence();
    let executionProviderAcquired = false;
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      executionServicesMode: "lazy",
      ...persistence,
      workspaceExecutionProvider: {
        async acquire() {
          executionProviderAcquired = true;
          return {
            commandExecutor: undefined,
            fileSystem: undefined,
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
            agents: {
              default: {
                name: "default",
                mode: "primary"
              }
            },
            actions: {},
            skills: {},
            toolServers: {},
            hooks: {},
            catalog: {
              workspaceId: "runtime",
              agents: [{ name: "default", mode: "primary", source: "workspace" }],
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
        runtime: "workspace",
        rootPath: "/tmp/demo",
        executionPolicy: "local"
      }
    });

  return {
    persistence,
    runtimeService,
    workspace,
    executionProviderAcquired: () => executionProviderAcquired
  };
}

describe("runtime service lazy session access", () => {
  it("creates a session without initializing execution runtime services", async () => {
    const { runtimeService, workspace, executionProviderAcquired } = await createLazyRuntime();

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller: { subjectRef: "test:user" },
      input: {}
    });

    expect(session.workspaceId).toBe(workspace.id);
    expect(session.activeAgentName).toBe("default");
    expect(executionProviderAcquired()).toBe(false);
  });

  it("loads and deletes session records without initializing execution runtime services", async () => {
    const { runtimeService, workspace, executionProviderAcquired } = await createLazyRuntime();
    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller: { subjectRef: "test:user" },
      input: {}
    });

    await expect(runtimeService.getSession(session.id)).resolves.toMatchObject({ id: session.id });
    await expect(runtimeService.listWorkspaceSessions(workspace.id, 20)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: session.id })]
    });

    await runtimeService.deleteSession(session.id);

    await expect(runtimeService.getSession(session.id)).rejects.toMatchObject({ code: "session_not_found" });
    expect(executionProviderAcquired()).toBe(false);
  });

  it("loads session messages, runs, queue, and run steps without initializing execution runtime services", async () => {
    const { persistence, runtimeService, workspace, executionProviderAcquired } = await createLazyRuntime();
    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller: { subjectRef: "test:user" },
      input: {}
    });
    const now = nowIso();
    const run = await persistence.runRepository.create({
      id: createId("run"),
      workspaceId: workspace.id,
      sessionId: session.id,
      initiatorRef: "test:user",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: session.activeAgentName,
      effectiveAgentName: session.activeAgentName,
      switchCount: 0,
      status: "queued",
      createdAt: now
    });
    await persistence.messageRepository.create({
      id: "msg_1",
      sessionId: session.id,
      runId: run.id,
      role: "user",
      origin: "user",
      mode: "prompt",
      content: "hello",
      createdAt: now
    });
    await persistence.runStepRepository.create({
      id: "step_1",
      runId: run.id,
      seq: 1,
      stepType: "system",
      name: "run.queued",
      status: "completed",
      input: {},
      output: {},
      startedAt: now,
      endedAt: now
    });
    await persistence.sessionPendingRunQueueRepository.enqueue({
      sessionId: session.id,
      runId: run.id,
      createdAt: now
    });

    await expect(runtimeService.listSessionMessages(session.id, 20)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "msg_1" })]
    });
    await expect(runtimeService.listSessionRuns(session.id, 20)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: run.id })]
    });
    await expect(runtimeService.listRunSteps(run.id, 20)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "step_1" })]
    });
    await expect(runtimeService.listSessionQueuedRuns(session.id)).resolves.toMatchObject({
      items: [expect.objectContaining({ runId: run.id, messageId: "msg_1" })]
    });

    expect(executionProviderAcquired()).toBe(false);
  });
});
