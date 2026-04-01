import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeService } from "../packages/runtime-core/dist/index.js";
import { createMemoryRuntimePersistence } from "../packages/storage-memory/dist/index.js";
import { discoverWorkspace } from "../packages/config/dist/index.js";

import { createApp } from "../apps/server/dist/app.js";
import { FakeModelGateway } from "./helpers/fake-model-gateway";

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out while waiting for condition.");
}

async function readSseFrames(
  response: Response,
  stopWhen: (events: Array<{ event: string; data: Record<string, unknown>; cursor?: string }>) => boolean
) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Missing response body.");
  }

  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: Record<string, unknown>; cursor?: string }> = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const idLine = part
        .split("\n")
        .find((line) => line.startsWith("id:"));
      const eventLine = part
        .split("\n")
        .find((line) => line.startsWith("event:"));
      const dataLine = part
        .split("\n")
        .find((line) => line.startsWith("data:"));

      if (!eventLine || !dataLine) {
        continue;
      }

      events.push({
        event: eventLine.replace("event:", "").trim(),
        data: JSON.parse(dataLine.replace("data:", "").trim()) as Record<string, unknown>,
        ...(idLine ? { cursor: idLine.replace("id:", "").trim() } : {})
      });

      if (stopWhen(events)) {
        await reader.cancel();
        return events;
      }
    }
  }

  return events;
}

async function readSseEvents(
  response: Response,
  stopWhen: (events: Array<{ event: string; data: Record<string, unknown> }>) => boolean
) {
  const frames = await readSseFrames(response, (events) => stopWhen(events.map(({ event, data }) => ({ event, data }))));
  return frames.map(({ event, data }) => ({ event, data }));
}

async function createStartedApp() {
  const gateway = new FakeModelGateway(20);
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
          mcpServers: {},
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

  const app = createApp({
    runtimeService,
    modelGateway: gateway,
    defaultModel: "openai-default",
    listWorkspaceTemplates: async () => [{ name: "workspace" }]
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { app, baseUrl };
}

async function createStartedAppWithWorkspace(workspace: Awaited<ReturnType<typeof discoverWorkspace>>) {
  const gateway = new FakeModelGateway(20);
  return createStartedAppWithWorkspaceAndGateway(workspace, gateway);
}

async function createStartedAppWithWorkspaceAndGateway(
  workspace: Awaited<ReturnType<typeof discoverWorkspace>>,
  gateway: FakeModelGateway
) {
  const persistence = createMemoryRuntimePersistence();
  await persistence.workspaceRepository.upsert(workspace);
  const runtimeService = new RuntimeService({
    defaultModel: "openai-default",
    modelGateway: gateway,
    ...persistence
  });

  const app = createApp({
    runtimeService,
    modelGateway: gateway,
    defaultModel: "openai-default",
    listWorkspaceTemplates: async () => [{ name: "workspace" }]
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { app, baseUrl };
}

let activeApp: Awaited<ReturnType<typeof createStartedApp>> | undefined;

afterEach(async () => {
  if (activeApp) {
    await activeApp.app.close();
    activeApp = undefined;
  }
});

describe("http api", () => {
  it("lists workspace templates from template_dir", async () => {
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspace-templates`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{ name: "workspace" }]
    });
  });

  it("requires bearer auth on public routes and skips it for internal model routes", async () => {
    activeApp = await createStartedApp();

    const unauthorized = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "demo",
        template: "workspace",
        rootPath: "/tmp/demo"
      })
    });
    expect(unauthorized.status).toBe(401);

    const internal = await fetch(`${activeApp.baseUrl}/internal/v1/models/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "hello"
      })
    });

    expect(internal.status).toBe(200);
    await expect(internal.json()).resolves.toMatchObject({
      model: "openai-default",
      text: "generated:hello"
    });
  });

  it("streams session lifecycle events and exposes 501 placeholders", async () => {
    activeApp = await createStartedApp();
    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "demo",
        template: "workspace",
        rootPath: "/tmp/demo"
      })
    });
    const workspace = (await workspaceResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    const session = (await sessionResponse.json()) as { id: string };

    const eventResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/events`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    const acceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "hello there"
      })
    });
    const accepted = (await acceptedResponse.json()) as { runId: string };

    const eventsPromise = readSseEvents(eventResponse, (events) =>
      events.some((event) => event.event === "run.completed" && event.data.runId === accepted.runId)
    );

    const runResponse = await fetch(`${activeApp.baseUrl}/api/v1/runs/${accepted.runId}`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(runResponse.status).toBe(200);

    const events = await eventsPromise;
    expect(events.map((event) => event.event)).toContain("run.queued");
    expect(events.map((event) => event.event)).toContain("run.started");
    expect(events.map((event) => event.event)).toContain("message.delta");
    expect(events.map((event) => event.event)).toContain("message.completed");
    expect(events.map((event) => event.event)).toContain("run.completed");

    const runStepsResponse = await fetch(`${activeApp.baseUrl}/api/v1/runs/${accepted.runId}/steps`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(runStepsResponse.status).toBe(200);
    const runStepsPage = (await runStepsResponse.json()) as {
      items: Array<{ stepType: string; status: string }>;
      nextCursor?: string;
    };
    expect(runStepsPage.items.some((step) => step.stepType === "model_call")).toBe(true);
    expect(runStepsPage.items.some((step) => step.stepType === "system")).toBe(true);
    expect(runStepsPage.items.every((step) => typeof step.status === "string")).toBe(true);
    expect(runStepsPage.nextCursor).toBeUndefined();

    await waitFor(async () => {
      const messagesResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      const page = (await messagesResponse.json()) as { items: Array<{ role: string; content: string }> };
      return page.items.some((item) => item.role === "assistant" && item.content.includes("reply:hello there"));
    });
  });

  it("executes action runs over HTTP for discovered workspaces", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-http-action-"));
    await mkdir(path.join(tempDir, ".openharness", "actions", "echo"), { recursive: true });

    await writeFile(
      path.join(tempDir, ".openharness", "actions", "echo", "ACTION.yaml"),
      `
name: debug.echo
description: Echo over HTTP
entry:
  command: printf "http-action-ok"
`,
      "utf8"
    );

    const workspace = await discoverWorkspace(tempDir, "project", {
      platformModels: {
        "openai-default": {
          provider: "openai",
          name: "gpt-4o-mini"
        }
      }
    });

    activeApp = await createStartedAppWithWorkspace(workspace);
    const response = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/actions/debug.echo/runs`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer token-1",
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      }
    );

    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { runId: string; actionName: string };
    expect(accepted.actionName).toBe("debug.echo");

    await waitFor(async () => {
      const runResponse = await fetch(`${activeApp.baseUrl}/api/v1/runs/${accepted.runId}`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      const run = (await runResponse.json()) as { status: string; metadata?: Record<string, unknown> };
      return run.status === "completed" && run.metadata?.stdout === "http-action-ok";
    });

    const runStepsResponse = await fetch(`${activeApp.baseUrl}/api/v1/runs/${accepted.runId}/steps`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(runStepsResponse.status).toBe(200);
    const runStepsPage = (await runStepsResponse.json()) as {
      items: Array<{ stepType: string; name?: string; status: string }>;
    };
    expect(runStepsPage.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepType: "tool_call",
          name: "debug.echo",
          status: "completed"
        })
      ])
    );
  });

  it("streams tool lifecycle events over HTTP SSE", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-http-tool-events-"));
    await mkdir(path.join(tempDir, ".openharness", "skills", "repo-explorer"), { recursive: true });

    await writeFile(
      path.join(tempDir, ".openharness", "skills", "repo-explorer", "SKILL.md"),
      `# Repo Explorer

Use ripgrep first.
`,
      "utf8"
    );

    const workspace = await discoverWorkspace(tempDir, "project", {
      platformModels: {
        "openai-default": {
          provider: "openai",
          name: "gpt-4o-mini"
        }
      }
    });

    workspace.defaultAgent = "builder";
    workspace.settings.defaultAgent = "builder";
    workspace.agents = {
      builder: {
        name: "builder",
        mode: "primary",
        prompt: "Use skills when needed.",
        tools: {
          native: [],
          actions: [],
          skills: ["repo-explorer"],
          mcp: []
        },
        switch: [],
        subagents: []
      }
    };
    workspace.catalog.agents = [{ name: "builder", source: "workspace" }];

    const gateway = new FakeModelGateway(20);
    gateway.streamScenarioFactory = () => ({
      text: "I loaded the repo-explorer skill.",
      toolSteps: [
        {
          toolName: "activate_skill",
          input: { name: "repo-explorer" },
          toolCallId: "call_activate_http"
        }
      ]
    });

    activeApp = await createStartedAppWithWorkspaceAndGateway(workspace, gateway);
    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    const session = (await sessionResponse.json()) as { id: string };

    const eventResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/events`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    const acceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Load the repo skill before answering."
      })
    });
    const accepted = (await acceptedResponse.json()) as { runId: string };

    const events = await readSseEvents(eventResponse, (items) =>
      items.some((event) => event.event === "run.completed" && event.data.runId === accepted.runId)
    );

    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["tool.started", "tool.completed", "run.completed"])
    );
    expect(events.find((event) => event.event === "tool.started")?.data).toMatchObject({
      runId: accepted.runId,
      toolCallId: "call_activate_http",
      toolName: "activate_skill",
      sourceType: "skill"
    });
    expect(events.find((event) => event.event === "tool.completed")?.data).toMatchObject({
      runId: accepted.runId,
      toolCallId: "call_activate_http",
      toolName: "activate_skill",
      sourceType: "skill"
    });
  });

  it("does not replay the last event when reconnecting with a cursor", async () => {
    activeApp = await createStartedApp();
    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "demo-cursor",
        template: "workspace",
        rootPath: "/tmp/demo-cursor"
      })
    });
    const workspace = (await workspaceResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    const session = (await sessionResponse.json()) as { id: string };

    const firstStreamResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/events`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    const firstAcceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "first run"
      })
    });
    const firstAccepted = (await firstAcceptedResponse.json()) as { runId: string };

    const firstFrames = await readSseFrames(firstStreamResponse, (events) =>
      events.some((event) => event.event === "run.completed" && event.data.runId === firstAccepted.runId)
    );
    const resumeCursor = firstFrames.at(-1)?.cursor;
    expect(resumeCursor).toBeDefined();

    const resumedStreamResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(resumeCursor!)}`,
      {
        headers: {
          authorization: "Bearer token-1"
        }
      }
    );

    const secondAcceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "second run"
      })
    });
    const secondAccepted = (await secondAcceptedResponse.json()) as { runId: string };

    const resumedFrames = await readSseFrames(resumedStreamResponse, (events) =>
      events.some((event) => event.event === "run.completed" && event.data.runId === secondAccepted.runId)
    );

    expect(resumedFrames.every((event) => event.data.runId !== firstAccepted.runId)).toBe(true);
    expect(resumedFrames.some((event) => event.data.runId === secondAccepted.runId)).toBe(true);
  });

  it("completes multiple message turns in the same session over HTTP", async () => {
    activeApp = await createStartedApp();
    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "demo-multi-turn",
        template: "workspace",
        rootPath: "/tmp/demo-multi-turn"
      })
    });
    const workspace = (await workspaceResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    const session = (await sessionResponse.json()) as { id: string };

    const firstEventResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/events`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    const firstAcceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "hello one"
      })
    });
    const firstAccepted = (await firstAcceptedResponse.json()) as { runId: string };

    const firstFrames = await readSseFrames(firstEventResponse, (events) =>
      events.some((event) => event.event === "run.completed" && event.data.runId === firstAccepted.runId)
    );
    const lastCursor = firstFrames.at(-1)?.cursor;
    expect(lastCursor).toBeDefined();

    const secondEventResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(lastCursor!)}`,
      {
        headers: {
          authorization: "Bearer token-1"
        }
      }
    );

    const secondAcceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "hello two"
      })
    });
    const secondAccepted = (await secondAcceptedResponse.json()) as { runId: string };

    const secondFrames = await readSseFrames(secondEventResponse, (events) =>
      events.some((event) => event.event === "run.completed" && event.data.runId === secondAccepted.runId)
    );

    expect(secondFrames.some((event) => event.data.runId === secondAccepted.runId)).toBe(true);

    await waitFor(async () => {
      const messagesResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      const page = (await messagesResponse.json()) as { items: Array<{ role: string; content: string }> };
      return (
        page.items.filter((item) => item.role === "assistant" && item.content.includes("reply:hello one")).length === 1 &&
        page.items.filter((item) => item.role === "assistant" && item.content.includes("reply:hello two")).length === 1
      );
    });
  });
});
