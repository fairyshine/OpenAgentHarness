import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverWorkspace } from "@oah/config";
import type { CallerContext, WorkspaceRecord } from "@oah/runtime-core";
import { RuntimeService } from "@oah/runtime-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import { createApp } from "../apps/server/src/app.ts";
import type { StorageAdmin } from "../apps/server/src/storage-admin.ts";
import { FakeModelGateway } from "./helpers/fake-model-gateway";

interface PlatformModelSnapshot {
  revision: number;
  items: Array<{
    id: string;
    provider: string;
    modelName: string;
    url?: string;
    hasKey: boolean;
    metadata?: Record<string, unknown>;
    isDefault: boolean;
  }>;
}

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

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) {
        return [];
      }

      if ((part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
        return [(part as { text: string }).text];
      }

      const output = (part as { output?: unknown }).output;
      if (
        (part as { type?: unknown }).type === "tool-result" &&
        typeof output === "object" &&
        output !== null &&
        (((output as { type?: unknown }).type === "text" || (output as { type?: unknown }).type === "error-text") &&
          typeof (output as { value?: unknown }).value === "string")
      ) {
        return [(output as { value: string }).value];
      }

      return [];
    })
    .join("\n\n");
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
          toolServers: {},
          hooks: {},
          catalog: {
            workspaceId: "template",
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

  return createStartedAppWithRuntimeService(runtimeService, gateway);
}

async function createStartedAppWithRuntimeService(
  runtimeService: RuntimeService,
  gateway: FakeModelGateway,
  options?: {
    listPlatformModels?: () => Promise<
      Array<{
        id: string;
        provider: string;
        modelName: string;
        url?: string;
        hasKey: boolean;
        metadata?: Record<string, unknown>;
        isDefault: boolean;
      }>
    >;
    getPlatformModelSnapshot?: () => Promise<PlatformModelSnapshot>;
    subscribePlatformModelSnapshot?: (listener: (snapshot: PlatformModelSnapshot) => void) => (() => void);
    importWorkspace?: (input: {
      rootPath: string;
      kind?: "project" | "chat";
      name?: string;
      externalRef?: string;
    }) => Promise<any>;
    workspaceMode?: "multi" | "single";
    resolveCallerContext?: (request: import("fastify").FastifyRequest) => Promise<CallerContext | undefined> | CallerContext | undefined;
    storageAdmin?: StorageAdmin;
  }
) {
  const app = createApp({
    runtimeService,
    modelGateway: gateway,
    defaultModel: "openai-default",
    logger: false,
    listWorkspaceTemplates: async () => [{ name: "workspace" }],
    ...(options?.listPlatformModels ? { listPlatformModels: options.listPlatformModels } : {}),
    ...(options?.getPlatformModelSnapshot ? { getPlatformModelSnapshot: options.getPlatformModelSnapshot } : {}),
    ...(options?.subscribePlatformModelSnapshot
      ? { subscribePlatformModelSnapshot: options.subscribePlatformModelSnapshot }
      : {}),
    ...(options?.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
    ...(options?.resolveCallerContext ? { resolveCallerContext: options.resolveCallerContext } : {}),
    ...(options?.storageAdmin ? { storageAdmin: options.storageAdmin } : {}),
    ...(options?.importWorkspace ? { importWorkspace: options.importWorkspace } : {})
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

  return createStartedAppWithRuntimeService(runtimeService, gateway);
}

const tempWorkspaceRoots: string[] = [];

async function createWorkspaceRecord(overrides?: Partial<WorkspaceRecord>): Promise<WorkspaceRecord> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "oah-http-files-"));
  tempWorkspaceRoots.push(rootPath);

  const now = new Date().toISOString();
  const workspaceId = `ws_${path.basename(rootPath).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;

  return {
    id: workspaceId,
    name: "files-workspace",
    rootPath,
    executionPolicy: "local",
    status: "active",
    createdAt: now,
    updatedAt: now,
    kind: "project",
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
      workspaceId,
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: []
    },
    ...(overrides ?? {})
  };
}

let activeApp: Awaited<ReturnType<typeof createStartedApp>> | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (activeApp) {
    await activeApp.app.close();
    activeApp = undefined;
  }

  await Promise.all(
    tempWorkspaceRoots.splice(0).map(async (rootPath) => {
      await rm(rootPath, { recursive: true, force: true });
    })
  );
});

describe("http api", () => {
  it("serves a developer landing page, docs page, api index, and openapi specs", async () => {
    activeApp = await createStartedApp();

    const [landingResponse, docsResponse, apiIndexResponse, openApiYamlResponse, openApiJsonResponse] = await Promise.all([
      fetch(`${activeApp.baseUrl}/`),
      fetch(`${activeApp.baseUrl}/docs`),
      fetch(`${activeApp.baseUrl}/api/v1`),
      fetch(`${activeApp.baseUrl}/openapi.yaml`),
      fetch(`${activeApp.baseUrl}/openapi.json`)
    ]);

    expect(landingResponse.status).toBe(200);
    expect(landingResponse.headers.get("content-type")).toContain("text/html");
    const landingBody = await landingResponse.text();
    expect(landingBody).toContain("/openapi.yaml");
    expect(landingBody).toContain("/openapi.json");

    expect(docsResponse.status).toBe(200);
    expect(docsResponse.headers.get("content-type")).toContain("text/html");
    const docsBody = await docsResponse.text();
    expect(docsBody).toContain("Developer Quickstart");
    expect(docsBody).toContain("OpenAPI JSON");

    expect(apiIndexResponse.status).toBe(200);
    await expect(apiIndexResponse.json()).resolves.toMatchObject({
      docs: {
        landingPage: `${activeApp.baseUrl}/`,
        docsPage: `${activeApp.baseUrl}/docs`,
        openapiYaml: `${activeApp.baseUrl}/openapi.yaml`,
        openapiJson: `${activeApp.baseUrl}/openapi.json`
      },
      probes: {
        healthz: `${activeApp.baseUrl}/healthz`,
        readyz: `${activeApp.baseUrl}/readyz`
      },
      groups: {
        workspaces: {
          description: expect.any(String),
          routes: expect.arrayContaining(["GET /api/v1/workspaces"])
        },
        messagesAndRuns: {
          description: expect.any(String),
          routes: expect.arrayContaining(["GET /api/v1/sessions/{sessionId}/events"])
        }
      },
      entrypoints: {
        workspaces: expect.arrayContaining(["GET /api/v1/workspaces"]),
        messagesAndRuns: expect.arrayContaining(["GET /api/v1/sessions/{sessionId}/events"])
      }
    });

    expect(openApiYamlResponse.status).toBe(200);
    expect(openApiYamlResponse.headers.get("content-type")).toContain("application/yaml");
    const openApiYamlBody = await openApiYamlResponse.text();
    expect(openApiYamlBody).toContain("openapi: 3.1.0");
    expect(openApiYamlBody).toContain(`- url: ${activeApp.baseUrl}/api/v1`);

    expect(openApiJsonResponse.status).toBe(200);
    const openApiJsonBody = (await openApiJsonResponse.json()) as { openapi: string; servers?: Array<{ url?: string }> };
    expect(openApiJsonBody.openapi).toBe("3.1.0");
    expect(openApiJsonBody.servers?.[0]?.url).toBe(`${activeApp.baseUrl}/api/v1`);
  });

  it("reports health status", async () => {
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok"
    });
  }, 30_000);

  it("reports readiness status", async () => {
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/readyz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready"
    });
  });

  it("lists workspace templates from template_dir", async () => {
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspace-templates`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{ name: "workspace" }]
    });
  });

  it("lists platform models loaded from model_dir", async () => {
    activeApp = await createStartedAppWithRuntimeService(new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(20),
      ...createMemoryRuntimePersistence()
    }), new FakeModelGateway(20), {
      listPlatformModels: async () => [
        {
          id: "openai-default",
          provider: "openai",
          modelName: "gpt-5",
          hasKey: true,
          isDefault: true,
          metadata: {
            tier: "default"
          }
        },
        {
          id: "compat-fast",
          provider: "openai-compatible",
          modelName: "qwen-max",
          url: "https://example.test/v1",
          hasKey: false,
          isDefault: false
        }
      ]
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/platform-models`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          id: "openai-default",
          provider: "openai",
          modelName: "gpt-5",
          hasKey: true,
          isDefault: true,
          metadata: {
            tier: "default"
          }
        },
        {
          id: "compat-fast",
          provider: "openai-compatible",
          modelName: "qwen-max",
          url: "https://example.test/v1",
          hasKey: false,
          isDefault: false
        }
      ]
    });
  });

  it("streams platform model snapshots over SSE", async () => {
    let revision = 0;
    let currentSnapshot: PlatformModelSnapshot = {
      revision,
      items: [
        {
          id: "openai-default",
          provider: "openai",
          modelName: "gpt-5",
          hasKey: true,
          isDefault: true
        }
      ]
    };
    const listeners = new Set<(snapshot: PlatformModelSnapshot) => void>();

    activeApp = await createStartedAppWithRuntimeService(
      new RuntimeService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence()
      }),
      new FakeModelGateway(20),
      {
        listPlatformModels: async () => currentSnapshot.items,
        getPlatformModelSnapshot: async () => currentSnapshot,
        subscribePlatformModelSnapshot(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      }
    );

    const response = await fetch(`${activeApp.baseUrl}/api/v1/platform-models/events`);
    expect(response.status).toBe(200);

    const framesPromise = readSseFrames(response, (events) => events.length >= 2);
    await waitFor(() => listeners.size === 1);

    revision += 1;
    currentSnapshot = {
      revision,
      items: [
        ...currentSnapshot.items,
        {
          id: "compat-fast",
          provider: "openai-compatible",
          modelName: "qwen-max",
          url: "https://example.test/v1",
          hasKey: false,
          isDefault: false
        }
      ]
    };
    listeners.forEach((listener) => listener(currentSnapshot));

    await expect(framesPromise).resolves.toEqual([
      {
        event: "platform-models.snapshot",
        data: {
          revision: 0,
          items: [
            {
              id: "openai-default",
              provider: "openai",
              modelName: "gpt-5",
              hasKey: true,
              isDefault: true
            }
          ]
        }
      },
      {
        event: "platform-models.updated",
        data: {
          revision: 1,
          items: [
            {
              id: "openai-default",
              provider: "openai",
              modelName: "gpt-5",
              hasKey: true,
              isDefault: true
            },
            {
              id: "compat-fast",
              provider: "openai-compatible",
              modelName: "qwen-max",
              url: "https://example.test/v1",
              hasKey: false,
              isDefault: false
            }
          ]
        }
      }
    ]);
  });

  it("exposes storage admin endpoints", async () => {
    const postgresTableOptions: Array<Record<string, unknown>> = [];
    const storageAdmin: StorageAdmin = {
      async overview() {
        return {
          postgres: {
            configured: true,
            available: true,
            primaryStorage: true,
            database: "oah_test",
            tables: [
              {
                name: "runs",
                rowCount: 12,
                orderBy: "created_at desc, id asc",
                description: "Run lifecycle records and status."
              }
            ],
            recovery: {
              trackedRuns: 4,
              quarantinedRuns: 2,
              requeuedRuns: 1,
              failedRecoveryRuns: 1,
              workerRecoveryFailures: 2,
              oldestQuarantinedAt: "2026-04-08T01:00:00.000Z",
              newestQuarantinedAt: "2026-04-09T02:00:00.000Z",
              newestRecoveredAt: "2026-04-10T03:00:00.000Z",
              topQuarantineReasons: [
                {
                  reason: "max_attempts_exhausted",
                  count: 2
                }
              ]
            }
          },
          redis: {
            configured: true,
            available: true,
            keyPrefix: "oah",
            eventBusEnabled: true,
            runQueueEnabled: true,
            dbSize: 8,
            readyQueue: {
              key: "oah:runs:ready",
              length: 2
            },
            sessionQueues: [],
            sessionLocks: [],
            eventBuffers: []
          }
        };
      },
      async postgresTable(_table, options) {
        postgresTableOptions.push({ ...options });
        return {
          table: "runs",
          rowCount: 12,
          orderBy: "created_at desc, id asc",
          offset: options.offset ?? 0,
          limit: options.limit,
          columns: ["id", "status"],
          ...(options.q ||
          options.workspaceId ||
          options.sessionId ||
          options.runId ||
          options.status ||
          options.errorCode ||
          options.recoveryState
            ? {
                appliedFilters: {
                  ...(options.q ? { q: options.q } : {}),
                  ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
                  ...(options.sessionId ? { sessionId: options.sessionId } : {}),
                  ...(options.runId ? { runId: options.runId } : {}),
                  ...(options.status ? { status: options.status } : {}),
                  ...(options.errorCode ? { errorCode: options.errorCode } : {}),
                  ...(options.recoveryState ? { recoveryState: options.recoveryState } : {})
                }
              }
            : {}),
          rows: [
            {
              id: "run_1",
              status: "completed"
            }
          ]
        };
      },
      async redisKeys() {
        return {
          pattern: "oah:*",
          items: [
            {
              key: "oah:runs:ready",
              type: "list",
              size: 2
            }
          ]
        };
      },
      async redisKeyDetail() {
        return {
          key: "oah:runs:ready",
          type: "list",
          size: 2,
          value: ["run_1", "run_2"]
        };
      },
      async deleteRedisKey() {
        return {
          key: "oah:runs:ready",
          deleted: true
        };
      },
      async deleteRedisKeys(keys) {
        return {
          items: keys.map((key) => ({
            key,
            deleted: true
          }))
        };
      },
      async clearRedisSessionQueue(key) {
        return {
          key,
          changed: true
        };
      },
      async releaseRedisSessionLock(key) {
        return {
          key,
          changed: true
        };
      },
      async close() {}
    };

    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });
    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway, {
      storageAdmin
    });

    const [
      overviewResponse,
      tableResponse,
      filteredTableResponse,
      keysResponse,
      keyResponse,
      deleteResponse,
      batchDeleteResponse,
      clearQueueResponse,
      releaseLockResponse
    ] = await Promise.all([
      fetch(`${activeApp.baseUrl}/api/v1/storage/overview`),
      fetch(`${activeApp.baseUrl}/api/v1/storage/postgres/tables/runs?limit=20&offset=40`),
      fetch(
        `${activeApp.baseUrl}/api/v1/storage/postgres/tables/runs?limit=20&q=completed&runId=run_1&status=failed&errorCode=worker_recovery_failed&recoveryState=quarantined`
      ),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/keys?pattern=oah:*`),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/key?key=oah:runs:ready`),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/key?key=oah:runs:ready`, {
        method: "DELETE"
      }),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/keys/delete`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          keys: ["oah:runs:ready", "oah:session:ses_1:queue"]
        })
      }),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/session-queue/clear`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          key: "oah:session:ses_1:queue"
        })
      }),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/session-lock/release`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          key: "oah:session:ses_1:lock"
        })
      })
    ]);

    expect(overviewResponse.status).toBe(200);
    expect(tableResponse.status).toBe(200);
    expect(filteredTableResponse.status).toBe(200);
    expect(keysResponse.status).toBe(200);
    expect(keyResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(batchDeleteResponse.status).toBe(200);
    expect(clearQueueResponse.status).toBe(200);
    expect(releaseLockResponse.status).toBe(200);

    await expect(overviewResponse.json()).resolves.toMatchObject({
      postgres: {
        database: "oah_test",
        recovery: {
          quarantinedRuns: 2,
          topQuarantineReasons: [
            {
              reason: "max_attempts_exhausted",
              count: 2
            }
          ]
        }
      },
      redis: {
        dbSize: 8
      }
    });
    await expect(tableResponse.json()).resolves.toMatchObject({
      table: "runs",
      rowCount: 12,
      offset: 40,
      limit: 20
    });
    await expect(filteredTableResponse.json()).resolves.toMatchObject({
      appliedFilters: {
        q: "completed",
        runId: "run_1",
        status: "failed",
        errorCode: "worker_recovery_failed",
        recoveryState: "quarantined"
      }
    });
    expect(postgresTableOptions.at(-1)).toMatchObject({
      limit: 20,
      q: "completed",
      runId: "run_1",
      status: "failed",
      errorCode: "worker_recovery_failed",
      recoveryState: "quarantined"
    });
    await expect(keysResponse.json()).resolves.toMatchObject({
      items: [{ key: "oah:runs:ready" }]
    });
    await expect(keyResponse.json()).resolves.toMatchObject({
      key: "oah:runs:ready",
      value: ["run_1", "run_2"]
    });
    await expect(deleteResponse.json()).resolves.toEqual({
      key: "oah:runs:ready",
      deleted: true
    });
    await expect(batchDeleteResponse.json()).resolves.toEqual({
      items: [
        { key: "oah:runs:ready", deleted: true },
        { key: "oah:session:ses_1:queue", deleted: true }
      ]
    });
    await expect(clearQueueResponse.json()).resolves.toEqual({
      key: "oah:session:ses_1:queue",
      changed: true
    });
    await expect(releaseLockResponse.json()).resolves.toEqual({
      key: "oah:session:ses_1:lock",
      changed: true
    });
  });

  it("accepts standalone requests without authorization when no host caller context resolver is configured", async () => {
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "no-auth-workspace",
        template: "workspace",
        rootPath: "/tmp/no-auth-workspace"
      })
    });

    expect(response.status).toBe(201);
  });

  it("lists workspaces and sessions over HTTP", async () => {
    activeApp = await createStartedApp();
    const authHeaders = {
      "content-type": "application/json"
    };

    const firstWorkspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "demo-a",
        template: "workspace",
        rootPath: "/tmp/demo-a"
      })
    });
    const firstWorkspace = (await firstWorkspaceResponse.json()) as { id: string };

    const secondWorkspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "demo-b",
        template: "workspace",
        rootPath: "/tmp/demo-b"
      })
    });
    const secondWorkspace = (await secondWorkspaceResponse.json()) as { id: string };

    const firstSessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${firstWorkspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        title: "session-a"
      })
    });
    const firstSession = (await firstSessionResponse.json()) as { id: string };

    const secondSessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${firstWorkspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        title: "session-b"
      })
    });
    const secondSession = (await secondSessionResponse.json()) as { id: string };

    const workspaceListResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces?pageSize=10`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(workspaceListResponse.status).toBe(200);
    const workspacePage = (await workspaceListResponse.json()) as {
      items: Array<{ id: string; kind: string; readOnly: boolean }>;
      nextCursor?: string;
    };

    expect(workspacePage.items.map((workspace) => workspace.id)).toEqual(
      expect.arrayContaining([firstWorkspace.id, secondWorkspace.id])
    );
    expect(workspacePage.items.every((workspace) => workspace.kind === "project")).toBe(true);
    expect(workspacePage.items.every((workspace) => workspace.readOnly === false)).toBe(true);
    expect(workspacePage.nextCursor).toBeUndefined();

    const workspaceDetailResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${firstWorkspace.id}`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(workspaceDetailResponse.status).toBe(200);
    await expect(workspaceDetailResponse.json()).resolves.toMatchObject({
      id: firstWorkspace.id,
      kind: "project",
      readOnly: false
    });

    const sessionListResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${firstWorkspace.id}/sessions?pageSize=10`,
      {
        headers: {
          authorization: "Bearer token-1"
        }
      }
    );
    expect(sessionListResponse.status).toBe(200);
    const sessionPage = (await sessionListResponse.json()) as {
      items: Array<{ id: string; workspaceId: string }>;
      nextCursor?: string;
    };

    expect(sessionPage.items.map((session) => session.id)).toEqual(expect.arrayContaining([firstSession.id, secondSession.id]));
    expect(sessionPage.items.every((session) => session.workspaceId === firstWorkspace.id)).toBe(true);
    expect(sessionPage.nextCursor).toBeUndefined();
  });

  it("patches the session active agent over HTTP for subsequent runs", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();

    await persistence.workspaceRepository.upsert({
      id: "workspace_http_agent_patch",
      name: "http-agent-patch",
      rootPath: "/tmp/http-agent-patch",
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
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
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
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "workspace_http_agent_patch",
        agents: [
          { name: "assistant", mode: "primary", source: "workspace" },
          { name: "builder", mode: "primary", source: "workspace" },
          { name: "planner", mode: "all", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway);

    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/workspace_http_agent_patch/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string; activeAgentName: string };
    expect(session.activeAgentName).toBe("assistant");

    const patchResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        title: "builder session",
        activeAgentName: "planner"
      })
    });

    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({
      id: session.id,
      title: "builder session",
      activeAgentName: "planner"
    });
  });

  it("imports existing workspaces over HTTP", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-http-import-"));
    await mkdir(path.join(tempDir, ".openharness"), { recursive: true });
    await writeFile(path.join(tempDir, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");

    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway, {
      async importWorkspace(input) {
        const discovered = await discoverWorkspace(input.rootPath, input.kind ?? "project", {
          platformModels: {}
        });
        const persisted = await persistence.workspaceRepository.upsert({
          ...discovered,
          name: input.name ?? discovered.name,
          externalRef: input.externalRef
        });
        return runtimeService.getWorkspace(persisted.id);
      }
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/import`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-1",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        rootPath: tempDir,
        name: "Imported Workspace",
        externalRef: "educlaw-agent-123"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      name: "Imported Workspace",
      rootPath: tempDir,
      kind: "project"
    });

    const persistedWorkspaces = await runtimeService.listWorkspaces(10);
    expect(persistedWorkspaces.items).toHaveLength(1);
    expect(persistedWorkspaces.items[0]).toMatchObject({
      name: "Imported Workspace",
      rootPath: tempDir
    });
  });

  it("locks workspace management routes in single-workspace mode", async () => {
    activeApp = await createStartedAppWithRuntimeService(
      new RuntimeService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence()
      }),
      new FakeModelGateway(20),
      {
        workspaceMode: "single"
      }
    );

    const [templatesResponse, createResponse, importResponse, deleteResponse] = await Promise.all([
      fetch(`${activeApp.baseUrl}/api/v1/workspace-templates`),
      fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "blocked-workspace",
          template: "workspace"
        })
      }),
      fetch(`${activeApp.baseUrl}/api/v1/workspaces/import`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          rootPath: "/tmp/blocked-workspace"
        })
      }),
      fetch(`${activeApp.baseUrl}/api/v1/workspaces/blocked`, {
        method: "DELETE"
      })
    ]);

    expect(templatesResponse.status).toBe(501);
    expect(createResponse.status).toBe(501);
    expect(importResponse.status).toBe(501);
    expect(deleteResponse.status).toBe(501);
  });

  it("deletes workspace records and managed workspace directories over HTTP", async () => {
    const managedRoot = await mkdtemp(path.join(os.tmpdir(), "oah-http-delete-root-"));
    const workspaceRoot = path.join(managedRoot, "workspace-a");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "README.md"), "temporary workspace", "utf8");

    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceDeletionHandler: {
        async deleteWorkspace(workspace) {
          const relativePath = path.relative(managedRoot, workspace.rootPath);
          if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            return;
          }

          await rm(workspace.rootPath, {
            recursive: true,
            force: true
          });
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
              tools: [],
              hooks: [],
              nativeTools: []
            }
          };
        }
      }
    });

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway);

    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "managed-workspace",
        template: "workspace",
        rootPath: workspaceRoot
      })
    });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const deleteResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(deleteResponse.status).toBe(204);

    const missingWorkspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(missingWorkspaceResponse.status).toBe(404);

    const missingSessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(missingSessionResponse.status).toBe(404);

    await expect(access(workspaceRoot)).rejects.toBeDefined();
  });

  it("manages workspace files over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithRuntimeService(
      new RuntimeService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway
    );

    const mkdirResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/directories`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "notes"
      })
    });
    expect(mkdirResponse.status).toBe(201);

    const writeResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/files/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "notes/hello.txt",
        content: "hello workspace",
        encoding: "utf8"
      })
    });
    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toMatchObject({
      path: "notes/hello.txt",
      type: "file",
      readOnly: false
    });

    const listResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/entries?path=notes`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      path: "notes",
      items: [
        {
          path: "notes/hello.txt",
          name: "hello.txt",
          type: "file"
        }
      ]
    });

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("notes/hello.txt")}`
    );
    expect(readResponse.status).toBe(200);
    const readPayload = (await readResponse.json()) as { content: string; etag?: string };
    expect(readPayload.content).toBe("hello workspace");
    expect(readPayload.etag).toBeTruthy();

    const moveResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/entries/move`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sourcePath: "notes/hello.txt",
        targetPath: "notes/renamed.txt"
      })
    });
    expect(moveResponse.status).toBe(200);
    await expect(moveResponse.json()).resolves.toMatchObject({
      path: "notes/renamed.txt",
      name: "renamed.txt"
    });

    const deleteResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/entries?path=${encodeURIComponent("notes/renamed.txt")}`,
      {
        method: "DELETE"
      }
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      workspaceId: workspace.id,
      path: "notes/renamed.txt",
      type: "file",
      deleted: true
    });
  });

  it("uploads and downloads workspace files over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithRuntimeService(
      new RuntimeService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway
    );

    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    const uploadResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/files/upload?path=${encodeURIComponent("bin/data.bin")}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream"
        },
        body: bytes
      }
    );
    expect(uploadResponse.status).toBe(200);
    await expect(uploadResponse.json()).resolves.toMatchObject({
      path: "bin/data.bin",
      type: "file",
      sizeBytes: 5
    });

    const downloadResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/files/download?path=${encodeURIComponent("bin/data.bin")}`
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-disposition")).toContain("data.bin");
    expect(downloadResponse.headers.get("etag")).toBeTruthy();
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(bytes);

    const contentResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("bin/data.bin")}&encoding=base64`
    );
    expect(contentResponse.status).toBe(200);
    const contentPayload = (await contentResponse.json()) as { content: string };
    expect(contentPayload.content).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("rejects unsafe paths and mutations on read-only workspaces", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord({
      readOnly: true
    });
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithRuntimeService(
      new RuntimeService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway
    );

    const traversalResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("../secret.txt")}`
    );
    expect(traversalResponse.status).toBe(403);

    const readonlyResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/directories`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "notes"
      })
    });
    expect(readonlyResponse.status).toBe(403);
    await expect(readonlyResponse.json()).resolves.toMatchObject({
      error: {
        code: "workspace_read_only"
      }
    });
  });

  it("returns run steps even when step output contains non-object JSON", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "ws_http_run_steps_scalar",
      name: "run-steps-scalar",
      rootPath: "/tmp/run-steps-scalar",
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
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_http_run_steps_scalar",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.runRepository.create({
      id: "run_http_scalar",
      workspaceId: "ws_http_run_steps_scalar",
      effectiveAgentName: "builder",
      triggerType: "system",
      status: "completed",
      createdAt: "2026-04-01T00:00:00.000Z"
    });
    await persistence.runStepRepository.create({
      id: "step_http_scalar",
      runId: "run_http_scalar",
      seq: 1,
      stepType: "system",
      status: "completed",
      input: "plain-text-input",
      output: ["scalar-like", 1, true],
      startedAt: "2026-04-01T00:00:00.000Z",
      endedAt: "2026-04-01T00:00:01.000Z"
    });

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway);

    const response = await fetch(`${activeApp.baseUrl}/api/v1/runs/run_http_scalar/steps?pageSize=200`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          id: "step_http_scalar",
          runId: "run_http_scalar",
          input: "plain-text-input",
          output: ["scalar-like", 1, true]
        }
      ]
    });
  });

  it("sanitizes chat workspace catalogs over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "chat_http_catalog",
      name: "chat-http-catalog",
      rootPath: "/tmp/chat-http-catalog",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "chat",
      readOnly: true,
      historyMirrorEnabled: false,
      defaultAgent: "assistant",
      settings: {
        defaultAgent: "assistant",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        assistant: {
          name: "assistant",
          mode: "primary",
          prompt: "You are a chat-only assistant.",
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
        "dangerous.run": {
          name: "dangerous.run",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: "/tmp/chat-http-catalog/actions/dangerous.run",
          entry: {
            command: "printf unsafe"
          }
        }
      },
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          exposeToLlm: true,
          directory: "/tmp/chat-http-catalog/skills/repo-explorer",
          sourceRoot: "/tmp/chat-http-catalog/skills/repo-explorer",
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
          handlerType: "prompt",
          capabilities: [],
          definition: {
            prompt: "should not run"
          }
        }
      },
      catalog: {
        workspaceId: "chat_http_catalog",
        agents: [{ name: "assistant", mode: "primary", source: "workspace" }],
        models: [],
        actions: [{ name: "dangerous.run", callableByApi: true, callableByUser: true, exposeToLlm: true }],
        skills: [{ name: "repo-explorer", exposeToLlm: true }],
        tools: [{ name: "docs", transportType: "http" }],
        hooks: [{ name: "rewrite-request", handlerType: "prompt", events: ["before_model_call"] }],
        nativeTools: ["shell"]
      }
    });
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway);

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/chat_http_catalog/catalog`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: "chat_http_catalog",
      agents: [{ name: "assistant", mode: "primary", source: "workspace" }],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: [],
      runtimeTools: []
    });
  });

  it("accepts standalone public routes without authorization and still skips auth on internal model routes", async () => {
    activeApp = await createStartedApp();

    const standalone = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
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
    expect(standalone.status).toBe(201);

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

  it("accepts host-injected caller context without relying on the bearer stub", async () => {
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
            toolServers: {},
            hooks: {},
            catalog: {
              workspaceId: "template",
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

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway, {
      resolveCallerContext: (request) => {
        if (request.headers["x-test-auth"] !== "ok") {
          return undefined;
        }

        return {
          subjectRef: "external:user-1",
          authSource: "external_gateway",
          scopes: ["workspace:read"],
          workspaceAccess: []
        };
      }
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-auth": "ok"
      },
      body: JSON.stringify({
        name: "resolver-demo",
        template: "workspace",
        rootPath: "/tmp/resolver-demo"
      })
    });

    expect(response.status).toBe(201);

    const created = (await response.json()) as { id: string };
    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${created.id}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-auth": "ok"
      },
      body: JSON.stringify({})
    });

    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };
    const storedSession = await persistence.sessionRepository.getById(session.id);
    expect(storedSession?.subjectRef).toBe("external:user-1");
  });

  it("returns missing caller context when host auth owns the boundary", async () => {
    activeApp = await createStartedAppWithRuntimeService(
      new RuntimeService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence(),
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
                tools: [],
                hooks: [],
                nativeTools: []
              }
            };
          }
        }
      }),
      new FakeModelGateway(20),
      {
        resolveCallerContext: () => undefined
      }
    );

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token-1"
      },
      body: JSON.stringify({
        name: "no-context",
        template: "workspace",
        rootPath: "/tmp/no-context"
      })
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unauthorized",
        message: "Missing caller context."
      }
    });
  });

  it("rejects non-loopback access to internal model routes", async () => {
    activeApp = await createStartedApp();

    const response = await activeApp.app.inject({
      method: "POST",
      url: "/internal/v1/models/generate",
      remoteAddress: "203.0.113.10",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        prompt: "hello"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "forbidden"
      }
    });
  });

  it("accepts private-network access to internal model routes when explicitly enabled", async () => {
    vi.stubEnv("OAH_ALLOW_PRIVATE_INTERNAL_MODEL_ROUTES", "true");
    activeApp = await createStartedApp();

    const response = await activeApp.app.inject({
      method: "POST",
      url: "/internal/v1/models/generate",
      remoteAddress: "192.168.97.1",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        prompt: "hello"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
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
      items: Array<{
        stepType: string;
        status: string;
        input?: {
          request?: {
            model?: string;
            messages?: Array<{ role: string; content: string }>;
          };
          runtime?: {
            runtimeToolNames?: string[];
          };
        };
        output?: {
          response?: {
            finishReason?: string;
            toolCalls?: Array<{ toolName?: string }>;
            toolResults?: Array<{ toolName?: string }>;
            text?: string;
          };
        };
      }>;
      nextCursor?: string;
    };
    expect(runStepsPage.items.some((step) => step.stepType === "model_call")).toBe(true);
    expect(runStepsPage.items.some((step) => step.stepType === "system")).toBe(true);
    expect(runStepsPage.items.every((step) => typeof step.status === "string")).toBe(true);
    expect(runStepsPage.items.find((step) => step.stepType === "model_call")).toMatchObject({
      input: {
        request: {
          model: "openai-default",
          messages: expect.arrayContaining([{ role: "user", content: "hello there" }])
        }
      },
      output: {
        response: {
          text: "reply:hello there",
          finishReason: "stop",
          toolCalls: [],
          toolResults: []
        }
      }
    });
    expect(runStepsPage.nextCursor).toBeUndefined();

    await waitFor(async () => {
      const messagesResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      const page = (await messagesResponse.json()) as { items: Array<{ role: string; content: unknown }> };
      return page.items.some((item) => item.role === "assistant" && extractMessageText(item.content).includes("reply:hello there"));
    });
  });

  it("manually requeues quarantined runs over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const enqueuedRuns: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
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
      id: "ws_http_requeue",
      name: "http-requeue",
      rootPath: "/tmp/http-requeue",
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
          prompt: "Allow HTTP recovery requeue.",
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
        workspaceId: "ws_http_requeue",
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
      id: "ses_http_requeue",
      workspaceId: "ws_http_requeue",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_http_requeue",
      workspaceId: "ws_http_requeue",
      sessionId: "ses_http_requeue",
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

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway);

    const response = await fetch(`${activeApp.baseUrl}/api/v1/runs/run_http_requeue/requeue`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-1"
      }
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      runId: "run_http_requeue",
      status: "queued",
      previousStatus: "failed",
      source: "manual_requeue"
    });
    expect(enqueuedRuns).toEqual([{ sessionId: "ses_http_requeue", runId: "run_http_requeue" }]);

    const requeuedRun = await runtimeService.getRun("run_http_requeue");
    expect(requeuedRun.status).toBe("queued");
    expect(requeuedRun.metadata).toMatchObject({
      recoveredBy: "manual_operator_requeue",
      recovery: {
        state: "requeued",
        strategy: "manual",
        manualRequeueCount: 1
      }
    });
  });

  it("batch requeues recovery runs over HTTP with per-item results", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const enqueuedRuns: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
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
      id: "ws_http_batch_requeue",
      name: "http-batch-requeue",
      rootPath: "/tmp/http-batch-requeue",
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
          prompt: "Allow HTTP batch recovery requeue.",
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
        workspaceId: "ws_http_batch_requeue",
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
      id: "ses_http_batch_requeue",
      workspaceId: "ws_http_batch_requeue",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_http_batch_requeue_ok",
      workspaceId: "ws_http_batch_requeue",
      sessionId: "ses_http_batch_requeue",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_ok",
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

    await persistence.runRepository.create({
      id: "run_http_batch_requeue_bad",
      workspaceId: "ws_http_batch_requeue",
      sessionId: "ses_http_batch_requeue",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_bad",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "completed",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      endedAt: "2026-04-01T00:00:50.000Z"
    });

    activeApp = await createStartedAppWithRuntimeService(runtimeService, gateway);

    const response = await fetch(`${activeApp.baseUrl}/api/v1/runs/requeue`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-1",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        runIds: ["run_http_batch_requeue_ok", "run_http_batch_requeue_bad"]
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          runId: "run_http_batch_requeue_ok",
          status: "queued",
          previousStatus: "failed",
          source: "manual_requeue"
        },
        {
          runId: "run_http_batch_requeue_bad",
          status: "error",
          errorCode: "run_requeue_invalid_status"
        }
      ]
    });
    expect(enqueuedRuns).toEqual([{ sessionId: "ses_http_batch_requeue", runId: "run_http_batch_requeue_ok" }]);
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
          external: []
        },
        switch: [],
        subagents: []
      }
    };
    workspace.catalog.agents = [{ name: "builder", mode: "primary", source: "workspace" }];

    const gateway = new FakeModelGateway(20);
    gateway.streamScenarioFactory = () => ({
      text: "I loaded the repo-explorer skill.",
      toolSteps: [
        {
          toolName: "Skill",
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
      toolName: "Skill",
      sourceType: "skill"
    });
    expect(events.find((event) => event.event === "tool.completed")?.data).toMatchObject({
      runId: accepted.runId,
      toolCallId: "call_activate_http",
      toolName: "Skill",
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
      const page = (await messagesResponse.json()) as { items: Array<{ role: string; content: unknown }> };
      return (
        page.items.filter((item) => item.role === "assistant" && extractMessageText(item.content).includes("reply:hello one"))
          .length === 1 &&
        page.items.filter((item) => item.role === "assistant" && extractMessageText(item.content).includes("reply:hello two"))
          .length === 1
      );
    });
  });
});
