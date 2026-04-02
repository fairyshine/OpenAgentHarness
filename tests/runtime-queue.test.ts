import { describe, expect, it } from "vitest";

import { RuntimeService } from "@oah/runtime-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

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

describe("runtime queue integration", () => {
  it("uses the configured external run queue instead of local auto-processing", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const enqueues: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      runQueue: {
        async enqueue(sessionId, runId) {
          enqueues.push({ sessionId, runId });
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
              workspaceId: "template",
              agents: [],
              models: [],
              actions: [],
              skills: [],
              mcp: [],
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
        template: "workspace",
        rootPath: "/tmp/demo",
        executionPolicy: "local"
      }
    });
    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller: {
        subjectRef: "user_1",
        authSource: "test",
        scopes: [],
        workspaceAccess: [workspace.id]
      },
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller: {
        subjectRef: "user_1",
        authSource: "test",
        scopes: [],
        workspaceAccess: [workspace.id]
      },
      input: {
        content: "hello"
      }
    });

    expect(enqueues).toEqual([{ sessionId: session.id, runId: accepted.runId }]);
    expect((await runtimeService.getRun(accepted.runId)).status).toBe("queued");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await runtimeService.getRun(accepted.runId)).status).toBe("queued");

    await runtimeService.processQueuedRun(accepted.runId);
    await waitFor(async () => (await runtimeService.getRun(accepted.runId)).status === "completed");
  });
});
