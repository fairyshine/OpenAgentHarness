import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverWorkspace } from "@oah/config";
import type { SystemProfile } from "@oah/api-contracts";
import type { CallerContext, EngineMessage, SortOrder, WorkspaceEntryPage, WorkspaceEntrySortBy, WorkspaceRecord } from "@oah/engine-core";
import { EngineService } from "@oah/engine-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import { createApp } from "../apps/server/src/app.ts";
import { createPlatformAssetManagement } from "../apps/server/src/bootstrap/platform-asset-management-service.ts";
import { createInternalWorkerApp } from "../apps/server/src/internal-worker-app.ts";
import {
  observeNativeWorkspaceSyncOperation,
  recordNativeWorkspaceSyncFallback,
  resetNativeWorkspaceSyncObservabilityForTests
} from "../apps/server/src/observability/native-workspace-sync.ts";
import type { StorageAdmin } from "../apps/server/src/storage-admin.ts";
import { loadConfigWorkspaceModule } from "../apps/server/src/bootstrap/module-loaders.ts";
import { FakeModelGateway } from "./helpers/fake-model-runtime";

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

interface DistributedPlatformModelRefreshResult {
  snapshot: PlatformModelSnapshot;
  summary: {
    attempted: number;
    succeeded: number;
    failed: number;
  };
  targets: Array<{
    workerId: string;
    runtimeInstanceId?: string;
    ownerBaseUrl: string;
    status: "refreshed" | "failed";
    snapshot?: PlatformModelSnapshot;
    error?: string;
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

async function createStartedApp(options?: { sandboxHostProviderKind?: "embedded" | "self_hosted" | "e2b" }) {
  const gateway = new FakeModelGateway(20);
  const persistence = createMemoryRuntimePersistence();
  const runtimeService = new EngineService({
    defaultModel: "openai-default",
    modelGateway: gateway,
    ...persistence,
    workspaceInitializer: {
      async initialize(input) {
        const rootPath = input.rootPath ?? (await mkdtemp(path.join(os.tmpdir(), "oah-http-created-")));
        tempWorkspaceRoots.push(rootPath);
        return {
          rootPath,
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
            workspaceId: "runtime",
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

  return createStartedAppWithEngineService(runtimeService, gateway, options);
}

async function createStartedAppWithEngineService(
  runtimeService: EngineService,
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
    refreshPlatformModels?: () => Promise<PlatformModelSnapshot>;
    refreshDistributedPlatformModels?: () => Promise<DistributedPlatformModelRefreshResult>;
    subscribePlatformModelSnapshot?: (listener: (snapshot: PlatformModelSnapshot) => void) => (() => void);
    systemProfile?: SystemProfile;
    importWorkspace?: (input: {
      rootPath: string;
      kind?: "project";
      name?: string;
      externalRef?: string;
      ownerId?: string;
      serviceName?: string;
    }) => Promise<any>;
    registerLocalWorkspace?: (input: {
      rootPath: string;
      name?: string;
      runtime?: string;
      ownerId?: string;
      serviceName?: string;
    }) => Promise<any>;
    repairLocalWorkspace?: (input: {
      workspaceId: string;
      rootPath: string;
      name?: string;
    }) => Promise<any>;
    workspaceMode?: "multi" | "single";
    resolveCallerContext?: (request: import("fastify").FastifyRequest) => Promise<CallerContext | undefined> | CallerContext | undefined;
    resolveWorkspaceOwnership?: (workspaceId: string) => Promise<{
      workspaceId: string;
      version: string;
      ownerWorkerId: string;
      ownerBaseUrl?: string;
      health: "healthy" | "late";
      lastActivityAt: string;
      localPath: string;
      remotePrefix?: string | undefined;
      isLocalOwner: boolean;
    } | undefined>;
    storageAdmin?: StorageAdmin;
    assignWorkspacePlacementOwnerAffinity?: (input: {
      workspaceId: string;
      ownerId: string;
      overwrite?: boolean | undefined;
    }) => Promise<void>;
    releaseWorkspacePlacement?: (input: {
      workspaceId: string;
      state?: "unassigned" | "draining" | "evicted" | undefined;
    }) => Promise<void>;
    clearWorkspaceCoordination?: (workspaceId: string) => Promise<void>;
    touchWorkspaceActivity?: (workspaceId: string) => Promise<void>;
    listWorkspaceEntriesFast?: (input: {
      workspaceId: string;
      path?: string | undefined;
      pageSize: number;
      cursor?: string | undefined;
      sortBy: WorkspaceEntrySortBy;
      sortOrder: SortOrder;
      includeDirectoryDescendantUpdatedAt?: boolean | undefined;
      includeEntryMetadata?: boolean | undefined;
    }) => Promise<WorkspaceEntryPage | undefined>;
    uploadWorkspaceRuntime?: (input: {
      runtimeName: string;
      zipBuffer: Buffer;
      overwrite: boolean;
      requireExisting?: boolean | undefined;
    }) => Promise<{ name: string }>;
    deleteWorkspaceRuntime?: (input: { runtimeName: string }) => Promise<void>;
    listPlatformAssets?: Parameters<typeof createApp>[0]["listPlatformAssets"];
    getPlatformAssetDetail?: Parameters<typeof createApp>[0]["getPlatformAssetDetail"];
    uploadPlatformModelAsset?: Parameters<typeof createApp>[0]["uploadPlatformModelAsset"];
    deletePlatformModelAsset?: Parameters<typeof createApp>[0]["deletePlatformModelAsset"];
    uploadPlatformToolAsset?: Parameters<typeof createApp>[0]["uploadPlatformToolAsset"];
    deletePlatformToolAsset?: Parameters<typeof createApp>[0]["deletePlatformToolAsset"];
    uploadPlatformSkillAsset?: Parameters<typeof createApp>[0]["uploadPlatformSkillAsset"];
    deletePlatformSkillAsset?: Parameters<typeof createApp>[0]["deletePlatformSkillAsset"];
    sandboxHostProviderKind?: "embedded" | "self_hosted" | "e2b";
    sandboxOwnerFallbackBaseUrl?: string;
    localOwnerBaseUrl?: string;
    localApiAuthToken?: string;
  }
) {
  const app = createApp({
    runtimeService,
    modelGateway: gateway,
    defaultModel: "openai-default",
    ...(options?.systemProfile ? { systemProfile: options.systemProfile } : {}),
    logger: false,
    listWorkspaceRuntimes: async () => [{ name: "workspace" }],
    ...(options?.uploadWorkspaceRuntime ? { uploadWorkspaceRuntime: options.uploadWorkspaceRuntime } : {}),
    ...(options?.deleteWorkspaceRuntime ? { deleteWorkspaceRuntime: options.deleteWorkspaceRuntime } : {}),
    ...(options?.listPlatformAssets ? { listPlatformAssets: options.listPlatformAssets } : {}),
    ...(options?.getPlatformAssetDetail ? { getPlatformAssetDetail: options.getPlatformAssetDetail } : {}),
    ...(options?.uploadPlatformModelAsset ? { uploadPlatformModelAsset: options.uploadPlatformModelAsset } : {}),
    ...(options?.deletePlatformModelAsset ? { deletePlatformModelAsset: options.deletePlatformModelAsset } : {}),
    ...(options?.uploadPlatformToolAsset ? { uploadPlatformToolAsset: options.uploadPlatformToolAsset } : {}),
    ...(options?.deletePlatformToolAsset ? { deletePlatformToolAsset: options.deletePlatformToolAsset } : {}),
    ...(options?.uploadPlatformSkillAsset ? { uploadPlatformSkillAsset: options.uploadPlatformSkillAsset } : {}),
    ...(options?.deletePlatformSkillAsset ? { deletePlatformSkillAsset: options.deletePlatformSkillAsset } : {}),
    ...(options?.listPlatformModels ? { listPlatformModels: options.listPlatformModels } : {}),
    ...(options?.getPlatformModelSnapshot ? { getPlatformModelSnapshot: options.getPlatformModelSnapshot } : {}),
    ...(options?.refreshPlatformModels ? { refreshPlatformModels: options.refreshPlatformModels } : {}),
    ...(options?.refreshDistributedPlatformModels
      ? { refreshDistributedPlatformModels: options.refreshDistributedPlatformModels }
      : {}),
    ...(options?.subscribePlatformModelSnapshot
      ? { subscribePlatformModelSnapshot: options.subscribePlatformModelSnapshot }
      : {}),
    ...(options?.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
    ...(options?.resolveCallerContext ? { resolveCallerContext: options.resolveCallerContext } : {}),
    ...(options?.resolveWorkspaceOwnership ? { resolveWorkspaceOwnership: options.resolveWorkspaceOwnership } : {}),
    ...(options?.storageAdmin ? { storageAdmin: options.storageAdmin } : {}),
    ...(options?.assignWorkspacePlacementOwnerAffinity
      ? { assignWorkspacePlacementOwnerAffinity: options.assignWorkspacePlacementOwnerAffinity }
      : {}),
    ...(options?.releaseWorkspacePlacement ? { releaseWorkspacePlacement: options.releaseWorkspacePlacement } : {}),
    ...(options?.clearWorkspaceCoordination ? { clearWorkspaceCoordination: options.clearWorkspaceCoordination } : {}),
    ...(options?.touchWorkspaceActivity ? { touchWorkspaceActivity: options.touchWorkspaceActivity } : {}),
    ...(options?.listWorkspaceEntriesFast ? { listWorkspaceEntriesFast: options.listWorkspaceEntriesFast } : {}),
    ...(options?.sandboxHostProviderKind ? { sandboxHostProviderKind: options.sandboxHostProviderKind } : {}),
    ...(options?.sandboxOwnerFallbackBaseUrl ? { sandboxOwnerFallbackBaseUrl: options.sandboxOwnerFallbackBaseUrl } : {}),
    ...(options?.localOwnerBaseUrl ? { localOwnerBaseUrl: options.localOwnerBaseUrl } : {}),
    ...(options?.localApiAuthToken ? { localApiAuthToken: options.localApiAuthToken } : {}),
    ...(options?.importWorkspace ? { importWorkspace: options.importWorkspace } : {}),
    ...(options?.registerLocalWorkspace ? { registerLocalWorkspace: options.registerLocalWorkspace } : {}),
    ...(options?.repairLocalWorkspace ? { repairLocalWorkspace: options.repairLocalWorkspace } : {})
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
  const runtimeService = new EngineService({
    defaultModel: "openai-default",
    modelGateway: gateway,
    ...persistence
  });

  return createStartedAppWithEngineService(runtimeService, gateway);
}

async function createStartedInternalWorkerApp(options?: {
  sandboxHostProviderKind?: "embedded" | "self_hosted" | "e2b";
  beginDrain?: (() => Promise<void> | void) | undefined;
  readinessCheck?: (() => Promise<{
    status: "ready" | "not_ready";
    draining?: boolean;
    reason?: "draining" | "worker_disk_pressure" | "checks_down";
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
    };
  }> | {
    status: "ready" | "not_ready";
    draining?: boolean;
    reason?: "draining" | "worker_disk_pressure" | "checks_down";
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
    };
  }) | undefined;
}) {
  const gateway = new FakeModelGateway(20);
  const persistence = createMemoryRuntimePersistence();
  const runtimeService = new EngineService({
    defaultModel: "openai-default",
    modelGateway: gateway,
    ...persistence
  });

  const app = createInternalWorkerApp({
    runtimeService,
    modelGateway: gateway,
    defaultModel: "openai-default",
    logger: false,
    ...(options?.beginDrain ? { beginDrain: options.beginDrain } : {}),
    ...(options?.readinessCheck ? { readinessCheck: options.readinessCheck } : {}),
    ...(options?.sandboxHostProviderKind ? { sandboxHostProviderKind: options.sandboxHostProviderKind } : {})
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { app, baseUrl };
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
const activeClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetNativeWorkspaceSyncObservabilityForTests();
  if (activeApp) {
    await activeApp.app.close();
    activeApp = undefined;
  }

  await Promise.all(activeClosers.splice(0).map(async (close) => close()));

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
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      storage: {
        primary: "sqlite",
        events: "memory",
        runQueue: "in_process"
      },
      process: {
        mode: "api_only",
        label: "API only",
        execution: "none"
      },
      sandbox: {
        provider: "embedded",
        executionModel: "local_embedded",
        workerPlacement: "api_process"
      },
      checks: {
        postgres: "not_configured",
        redisEvents: "not_configured",
        redisRunQueue: "not_configured"
      },
      worker: {
        mode: "disabled",
        draining: false,
        acceptsNewRuns: true,
        sessionSerialBoundary: "session",
        localSlots: [],
        activeWorkers: [],
        pool: null
      }
    });
  }, 30_000);

  it("reports readiness status", async () => {
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/readyz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      draining: false,
      checks: {
        postgres: "not_configured",
        redisEvents: "not_configured",
        redisRunQueue: "not_configured"
      }
    });
  });

  it("reports the default enterprise system profile", async () => {
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/api/v1/system/profile`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      apiCompatibility: "oah/v1",
      product: "open-agent-harness",
      edition: "enterprise",
      runtimeMode: "embedded",
      deploymentKind: "oah",
      displayName: "OAH enterprise server",
      capabilities: {
        localDaemonControl: false,
        localWorkspacePaths: false,
        workspaceRegistration: true,
        storageInspection: false,
        assetManagement: false,
        modelManagement: false,
        localDaemonSupervisor: false
      }
    });
  });

  it("reports an OAP local daemon system profile when configured by the runtime", async () => {
    activeApp = await createStartedApp({
      systemProfile: {
        apiCompatibility: "oah/v1",
        product: "open-agent-harness",
        edition: "personal",
        runtimeMode: "daemon",
        deploymentKind: "oap",
        displayName: "OAP local daemon",
        capabilities: {
          localDaemonControl: true,
          localWorkspacePaths: true,
          workspaceRegistration: true,
          storageInspection: true,
          assetManagement: false,
          modelManagement: true,
          localDaemonSupervisor: true
        }
      }
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/system/profile`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      edition: "personal",
      runtimeMode: "daemon",
      deploymentKind: "oap",
      displayName: "OAP local daemon",
      capabilities: {
        localDaemonControl: true,
        localWorkspacePaths: true,
        modelManagement: true,
        localDaemonSupervisor: true
      }
    });
  });

  it("registers local workspace paths only when the server profile advertises the capability", async () => {
    const registerLocalWorkspace = vi.fn(
      async (input: { rootPath: string; name?: string; runtime?: string; ownerId?: string; serviceName?: string }) => ({
      id: "project-local-demo",
      name: input.name ?? "local-demo",
      ...(input.runtime ? { runtime: input.runtime } : {}),
      rootPath: input.rootPath,
      externalRef: `local:path:${input.rootPath}`,
      executionPolicy: "local",
      status: "active",
      kind: "project",
      readOnly: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
      })
    );
    activeApp = await createStartedApp({
      systemProfile: {
        apiCompatibility: "oah/v1",
        product: "open-agent-harness",
        edition: "personal",
        runtimeMode: "daemon",
        deploymentKind: "oap",
        displayName: "OAP local daemon",
        capabilities: {
          localDaemonControl: true,
          localWorkspacePaths: true,
          workspaceRegistration: true,
          storageInspection: true,
          assetManagement: false,
          modelManagement: true,
          localDaemonSupervisor: true
        }
      },
      registerLocalWorkspace
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/local/workspaces/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootPath: "/Users/demo/repo",
        name: "Demo Repo",
        runtime: "vibe-coding",
        ownerId: "owner-1",
        serviceName: "Local_Service"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "project-local-demo",
      name: "Demo Repo",
      runtime: "vibe-coding",
      rootPath: "/Users/demo/repo",
      externalRef: "local:path:/Users/demo/repo"
    });
    expect(registerLocalWorkspace).toHaveBeenCalledWith({
      rootPath: "/Users/demo/repo",
      name: "Demo Repo",
      runtime: "vibe-coding",
      ownerId: "owner-1",
      serviceName: "local_service"
    });
  });

  it("rejects local workspace path registration on enterprise profiles", async () => {
    activeApp = await createStartedApp({
      registerLocalWorkspace: vi.fn()
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/local/workspaces/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: "/Users/demo/repo" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "local_workspace_registration_forbidden"
      }
    });
  });

  it("repairs a local workspace path on personal profiles", async () => {
    const repairLocalWorkspace = vi.fn(
      async (input: { workspaceId: string; rootPath: string; name?: string }) =>
        ({
          id: input.workspaceId,
          name: input.name ?? "Moved Repo",
          rootPath: input.rootPath,
          externalRef: `local:path:${input.rootPath}`,
          executionPolicy: "local",
          status: "active",
          kind: "project",
          readOnly: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z"
        }) as const
    );
    activeApp = await createStartedApp({
      systemProfile: {
        apiCompatibility: "oah/v1",
        product: "open-agent-harness",
        edition: "personal",
        runtimeMode: "daemon",
        deploymentKind: "oap",
        displayName: "OAP local daemon",
        capabilities: {
          localDaemonControl: true,
          localWorkspacePaths: true,
          workspaceRegistration: true,
          storageInspection: true,
          assetManagement: false,
          modelManagement: true,
          localDaemonSupervisor: true
        }
      },
      repairLocalWorkspace
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/local/workspaces/project-old/repair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootPath: "/Users/demo/moved-repo",
        name: "Moved Repo"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "project-old",
      name: "Moved Repo",
      rootPath: "/Users/demo/moved-repo",
      externalRef: "local:path:/Users/demo/moved-repo"
    });
    expect(repairLocalWorkspace).toHaveBeenCalledWith({
      workspaceId: "project-old",
      rootPath: "/Users/demo/moved-repo",
      name: "Moved Repo"
    });
  });

  it("rejects local workspace repair on enterprise profiles", async () => {
    activeApp = await createStartedApp({
      repairLocalWorkspace: vi.fn()
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/local/workspaces/project-old/repair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: "/Users/demo/moved-repo" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "local_workspace_registration_forbidden"
      }
    });
  });

  it("exposes native workspace sync metrics", async () => {
    await observeNativeWorkspaceSyncOperation({
      operation: "sync_local_to_remote",
      implementation: "rust",
      target: "/tmp/native-sync",
      action: async () => undefined
    });
    recordNativeWorkspaceSyncFallback({
      operation: "sync_local_to_remote",
      target: "/tmp/native-sync",
      error: new Error("native failed")
    });
    activeApp = await createStartedApp();

    const response = await fetch(`${activeApp.baseUrl}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("oah_native_workspace_sync_attempts_total");
    expect(body).toContain("oah_object_storage_operations_total");
    expect(body).toContain('operation="sync_local_to_remote"');
    expect(body).toContain('implementation="rust"');
    expect(body).toContain('outcome="success"');
    expect(body).toContain('oah_native_workspace_sync_fallbacks_total');
    expect(body).toContain('attempted_implementation="rust"');
    expect(body).toContain('fallback_implementation="ts"');
  });

  it("worker internal app exposes only readiness and internal surfaces", async () => {
    activeApp = await createStartedInternalWorkerApp();

    const [healthzResponse, readyzResponse, landingResponse] = await Promise.all([
      fetch(`${activeApp.baseUrl}/healthz`),
      fetch(`${activeApp.baseUrl}/readyz`),
      fetch(`${activeApp.baseUrl}/`)
    ]);

    expect(healthzResponse.status).toBe(200);
    await expect(healthzResponse.json()).resolves.toMatchObject({
      process: {
        mode: "standalone_worker",
        label: "standalone worker",
        execution: "redis_queue"
      }
    });

    expect(readyzResponse.status).toBe(200);
    await expect(readyzResponse.json()).resolves.toEqual({
      status: "ready",
      draining: false,
      checks: {
        postgres: "not_configured",
        redisEvents: "not_configured",
        redisRunQueue: "not_configured"
      }
    });

    expect(landingResponse.status).toBe(404);
  });

  it("exposes an internal drain control endpoint for Kubernetes preStop", async () => {
    let draining = false;
    let drainCalls = 0;
    activeApp = await createStartedInternalWorkerApp({
      beginDrain: async () => {
        drainCalls += 1;
        draining = true;
      },
      readinessCheck: async () => ({
        status: draining ? "not_ready" : "ready",
        ...(draining ? { draining: true, reason: "draining" as const } : { draining: false }),
        checks: {
          postgres: "not_configured",
          redisEvents: "not_configured",
          redisRunQueue: "not_configured"
        }
      })
    });

    const drainResponse = await fetch(`${activeApp.baseUrl}/internal/v1/control/drain`, {
      method: "POST"
    });
    expect(drainResponse.status).toBe(202);
    await expect(drainResponse.json()).resolves.toEqual({
      status: "accepted",
      draining: true
    });

    const readyzResponse = await fetch(`${activeApp.baseUrl}/readyz`);
    expect(readyzResponse.status).toBe(503);
    await expect(readyzResponse.json()).resolves.toEqual({
      status: "not_ready",
      draining: true,
      reason: "draining",
      checks: {
        postgres: "not_configured",
        redisEvents: "not_configured",
        redisRunQueue: "not_configured"
      }
    });

    expect(drainCalls).toBe(1);
  });

  it("lists workspace runtimes from runtime_dir", async () => {
    activeApp = await createStartedApp();

    const runtimesResponse = await fetch(`${activeApp.baseUrl}/api/v1/runtimes`);

    expect(runtimesResponse.status).toBe(200);
    await expect(runtimesResponse.json()).resolves.toEqual({
      items: [{ name: "workspace" }]
    });
  });

  it("keeps the legacy /blueprints route as an alias for runtimes", async () => {
    activeApp = await createStartedApp();

    const runtimesResponse = await fetch(`${activeApp.baseUrl}/api/v1/blueprints`);

    expect(runtimesResponse.status).toBe(200);
    await expect(runtimesResponse.json()).resolves.toEqual({
      items: [{ name: "workspace" }]
    });
  });

  it("uploads workspace runtimes with boolean query strings from the web client", async () => {
    const uploads: Array<{ runtimeName: string; overwrite: boolean; bytes: number }> = [];
    activeApp = await createStartedAppWithEngineService(new EngineService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(20),
      ...createMemoryRuntimePersistence()
    }), new FakeModelGateway(20), {
      uploadWorkspaceRuntime: async (input) => {
        uploads.push({
          runtimeName: input.runtimeName,
          overwrite: input.overwrite,
          bytes: input.zipBuffer.length
        });
        return { name: input.runtimeName };
      }
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/runtimes/upload?name=micro-learning-test&overwrite=false`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("zip-bytes")
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ name: "micro-learning-test" });
    expect(uploads).toEqual([
      {
        runtimeName: "micro-learning-test",
        overwrite: false,
        bytes: "zip-bytes".length
      }
    ]);
  });

  it("exposes workspace runtimes through the unified assets API", async () => {
    const uploads: Array<{ runtimeName: string; overwrite: boolean; requireExisting?: boolean; bytes: number }> = [];
    const deletes: string[] = [];
    activeApp = await createStartedAppWithEngineService(new EngineService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(20),
      ...createMemoryRuntimePersistence()
    }), new FakeModelGateway(20), {
      uploadWorkspaceRuntime: async (input) => {
        uploads.push({
          runtimeName: input.runtimeName,
          overwrite: input.overwrite,
          ...(input.requireExisting !== undefined ? { requireExisting: input.requireExisting } : {}),
          bytes: input.zipBuffer.length
        });
        return { name: input.runtimeName };
      },
      deleteWorkspaceRuntime: async (input) => {
        deletes.push(input.runtimeName);
      }
    });

    const listResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/runtimes`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      kind: "runtime",
      items: [{ name: "workspace" }]
    });

    const uploadResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/runtimes/upload?name=asset-runtime&overwrite=true`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("runtime-zip")
    });
    expect(uploadResponse.status).toBe(201);
    await expect(uploadResponse.json()).resolves.toEqual({ kind: "runtime", name: "asset-runtime" });

    const updateResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/runtimes/asset-runtime`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("runtime-zip-2")
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual({ kind: "runtime", name: "asset-runtime" });

    const deleteResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/runtimes/asset-runtime`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(204);

    expect(uploads).toEqual([
      { runtimeName: "asset-runtime", overwrite: true, bytes: "runtime-zip".length },
      { runtimeName: "asset-runtime", overwrite: true, requireExisting: true, bytes: "runtime-zip-2".length }
    ]);
    expect(deletes).toEqual(["asset-runtime"]);
  });

  it("returns a client error for invalid runtime zip uploads", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-http-runtime-upload-"));
    tempWorkspaceRoots.push(tempDir);
    const runtimeDir = path.join(tempDir, "runtimes");
    await mkdir(runtimeDir, { recursive: true });

    activeApp = await createStartedAppWithEngineService(new EngineService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(20),
      ...createMemoryRuntimePersistence()
    }), new FakeModelGateway(20), {
      uploadWorkspaceRuntime: async (input) => {
        const { uploadWorkspaceRuntime } = await import("@oah/config");
        return uploadWorkspaceRuntime({
          runtimeDir,
          runtimeName: input.runtimeName,
          zipBuffer: input.zipBuffer,
          overwrite: input.overwrite
        });
      }
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/runtimes/upload?name=micro-learning-test`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("not-a-zip")
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_runtime_zip"
      }
    });
  });

  it("manages platform model assets through the public API", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-platform-model-assets-"));
    tempWorkspaceRoots.push(tempDir);
    const config = {
      paths: {
        workspace_dir: path.join(tempDir, "workspaces"),
        runtime_dir: path.join(tempDir, "runtimes"),
        model_dir: path.join(tempDir, "models"),
        tool_dir: path.join(tempDir, "tools"),
        skill_dir: path.join(tempDir, "skills")
      },
      llm: {
        default_model: "managed"
      }
    } as Parameters<typeof createPlatformAssetManagement>[0]["config"];
    const assetManagement = createPlatformAssetManagement({
      config,
      loadConfigWorkspaceModule
    });

    activeApp = await createStartedAppWithEngineService(new EngineService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(20),
      ...createMemoryRuntimePersistence()
    }), new FakeModelGateway(20), assetManagement);

    const profileResponse = await fetch(`${activeApp.baseUrl}/api/v1/system/profile`);
    expect(profileResponse.status).toBe(200);
    await expect(profileResponse.json()).resolves.toMatchObject({
      capabilities: {
        assetManagement: true
      }
    });

    const uploadResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/models/upload?name=managed`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("managed:\n  provider: openai\n  name: gpt-5\n")
    });
    expect(uploadResponse.status).toBe(201);
    await expect(uploadResponse.json()).resolves.toEqual({ kind: "model", name: "managed" });

    const listResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/models`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      kind: "model",
      items: [{ id: "managed" }]
    });

    const detailResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/models/managed`);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({
      kind: "model",
      name: "managed",
      yaml: "managed:\n  provider: openai\n  name: gpt-5\n"
    });

    const updateResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/models/managed`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("managed:\n  provider: openai\n  name: gpt-5.1\n")
    });
    expect(updateResponse.status).toBe(200);
    await expect(readFile(path.join(config.paths.model_dir, "managed.yaml"), "utf8")).resolves.toContain("gpt-5.1");

    const deleteResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/models/managed`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(204);
    await expect(access(path.join(config.paths.model_dir, "managed.yaml"))).rejects.toThrow();
  });

  it("manages platform tool assets through the public API", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-platform-tool-assets-"));
    tempWorkspaceRoots.push(tempDir);
    const config = {
      paths: {
        workspace_dir: path.join(tempDir, "workspaces"),
        runtime_dir: path.join(tempDir, "runtimes"),
        model_dir: path.join(tempDir, "models"),
        tool_dir: path.join(tempDir, "tools"),
        skill_dir: path.join(tempDir, "skills")
      },
      llm: {
        default_model: "openai-default"
      }
    } as Parameters<typeof createPlatformAssetManagement>[0]["config"];
    const assetManagement = createPlatformAssetManagement({
      config,
      loadConfigWorkspaceModule
    });

    activeApp = await createStartedAppWithEngineService(new EngineService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(20),
      ...createMemoryRuntimePersistence()
    }), new FakeModelGateway(20), assetManagement);

    const uploadResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/tools/upload?name=repo-tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        definition: {
          command: "node ./servers/repo-tools/index.js",
          expose: {
            tool_prefix: "repo"
          }
        },
        serverFiles: {
          "index.js": "console.log('ok');\n"
        }
      })
    });
    expect(uploadResponse.status).toBe(201);
    await expect(uploadResponse.json()).resolves.toEqual({ kind: "tool", name: "repo-tools" });

    const listResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/tools`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      kind: "tool",
      items: [{ name: "repo-tools" }]
    });

    const detailResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/tools/repo-tools`);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({
      kind: "tool",
      name: "repo-tools",
      definition: {
        command: "node ./servers/repo-tools/index.js",
        expose: {
          tool_prefix: "repo"
        }
      },
      serverFiles: {
        "index.js": "console.log('ok');\n"
      }
    });

    const deleteResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/tools/repo-tools`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(204);
    await expect(access(path.join(config.paths.tool_dir, "servers", "repo-tools"))).rejects.toThrow();
  });

  it("manages platform skill assets through the public API", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-platform-skill-assets-"));
    tempWorkspaceRoots.push(tempDir);
    const config = {
      paths: {
        workspace_dir: path.join(tempDir, "workspaces"),
        runtime_dir: path.join(tempDir, "runtimes"),
        model_dir: path.join(tempDir, "models"),
        tool_dir: path.join(tempDir, "tools"),
        skill_dir: path.join(tempDir, "skills")
      },
      llm: {
        default_model: "openai-default"
      }
    } as Parameters<typeof createPlatformAssetManagement>[0]["config"];
    const assetManagement = createPlatformAssetManagement({
      config,
      loadConfigWorkspaceModule
    });

    activeApp = await createStartedAppWithEngineService(new EngineService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(20),
      ...createMemoryRuntimePersistence()
    }), new FakeModelGateway(20), assetManagement);

    const uploadResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/skills/upload?name=repo-scout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillMarkdown: "---\ndescription: Inspect repositories\n---\n# Repo scout\n\nRead the repository and summarize it.\n",
        files: {
          "references/checklist.md": "- inspect tree\n"
        }
      })
    });
    expect(uploadResponse.status).toBe(201);
    await expect(uploadResponse.json()).resolves.toEqual({ kind: "skill", name: "repo-scout" });

    const listResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/skills`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      kind: "skill",
      items: [{ name: "repo-scout" }]
    });

    const detailResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/skills/repo-scout`);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({
      kind: "skill",
      name: "repo-scout",
      skillMarkdown: "---\ndescription: Inspect repositories\n---\n# Repo scout\n\nRead the repository and summarize it.\n",
      files: {
        "references/checklist.md": "- inspect tree\n"
      }
    });

    const updateResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/skills/repo-scout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillMarkdown: "# Repo scout\n\nUpdated instructions.\n"
      })
    });
    expect(updateResponse.status).toBe(200);
    await expect(readFile(path.join(config.paths.skill_dir, "repo-scout", "SKILL.md"), "utf8")).resolves.toContain(
      "Updated instructions"
    );

    const deleteResponse = await fetch(`${activeApp.baseUrl}/api/v1/assets/skills/repo-scout`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(204);
    await expect(access(path.join(config.paths.skill_dir, "repo-scout"))).rejects.toThrow();
  });

  it("lists platform models loaded from model_dir", async () => {
    activeApp = await createStartedAppWithEngineService(new EngineService({
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

    activeApp = await createStartedAppWithEngineService(
      new EngineService({
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

  it("refreshes platform model snapshots only when explicitly requested", async () => {
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
    const nextSnapshot: PlatformModelSnapshot = {
      revision: 1,
      items: [
        {
          id: "openai-default",
          provider: "openai",
          modelName: "gpt-5.1",
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
    };
    const listeners = new Set<(snapshot: PlatformModelSnapshot) => void>();
    const refreshPlatformModels = vi.fn(async () => {
      currentSnapshot = nextSnapshot;
      revision = nextSnapshot.revision;
      listeners.forEach((listener) => listener(currentSnapshot));
      return currentSnapshot;
    });

    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence()
      }),
      new FakeModelGateway(20),
      {
        listPlatformModels: async () => currentSnapshot.items,
        getPlatformModelSnapshot: async () => currentSnapshot,
        refreshPlatformModels,
        subscribePlatformModelSnapshot(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      }
    );

    const initialList = await fetch(`${activeApp.baseUrl}/api/v1/platform-models`);
    await expect(initialList.json()).resolves.toEqual({
      items: currentSnapshot.items
    });

    const eventsResponse = await fetch(`${activeApp.baseUrl}/api/v1/platform-models/events`);
    expect(eventsResponse.status).toBe(200);
    const framesPromise = readSseFrames(eventsResponse, (events) => events.length >= 2);
    await waitFor(() => listeners.size === 1);

    const refreshResponse = await fetch(`${activeApp.baseUrl}/api/v1/platform-models/refresh`, {
      method: "POST"
    });
    expect(refreshResponse.status).toBe(200);
    await expect(refreshResponse.json()).resolves.toEqual(nextSnapshot);
    expect(refreshPlatformModels).toHaveBeenCalledTimes(1);

    const refreshedList = await fetch(`${activeApp.baseUrl}/api/v1/platform-models`);
    await expect(refreshedList.json()).resolves.toEqual({
      items: nextSnapshot.items
    });

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
        data: nextSnapshot
      }
    ]);
  });

  it("refreshes platform models across registered workers through one public endpoint", async () => {
    const distributedRefreshResult: DistributedPlatformModelRefreshResult = {
      snapshot: {
        revision: 2,
        items: [
          {
            id: "openai-default",
            provider: "openai",
            modelName: "gpt-5.1",
            hasKey: true,
            isDefault: true
          }
        ]
      },
      summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1
      },
      targets: [
        {
          workerId: "worker-a",
          runtimeInstanceId: "worker:pod-a",
          ownerBaseUrl: "http://worker-a.internal:8787",
          status: "refreshed",
          snapshot: {
            revision: 2,
            items: [
              {
                id: "openai-default",
                provider: "openai",
                modelName: "gpt-5.1",
                hasKey: true,
                isDefault: true
              }
            ]
          }
        },
        {
          workerId: "worker-b",
          runtimeInstanceId: "worker:pod-b",
          ownerBaseUrl: "http://worker-b.internal:8787",
          status: "failed",
          error: "HTTP 503"
        }
      ]
    };

    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence()
      }),
      new FakeModelGateway(20),
      {
        refreshDistributedPlatformModels: vi.fn(async () => distributedRefreshResult)
      }
    );

    const response = await fetch(`${activeApp.baseUrl}/api/v1/platform-models/refresh/distributed`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(distributedRefreshResult);
  });

  it("exposes storage admin endpoints", async () => {
    const overviewOptions: Array<Record<string, unknown>> = [];
    const postgresTableOptions: Array<Record<string, unknown>> = [];
    const storageAdmin: StorageAdmin = {
      async overview(options) {
        overviewOptions.push({ ...(options?.serviceName ? { serviceName: options.serviceName } : {}) });
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
          options.serviceName ||
          options.workspaceId ||
          options.sessionId ||
          options.runId ||
          options.status ||
          options.errorCode ||
          options.recoveryState ||
          options.searchMode
            ? {
                appliedFilters: {
                  ...(options.serviceName ? { serviceName: options.serviceName } : {}),
                  ...(options.q ? { q: options.q } : {}),
                  ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
                  ...(options.sessionId ? { sessionId: options.sessionId } : {}),
                  ...(options.runId ? { runId: options.runId } : {}),
                  ...(options.status ? { status: options.status } : {}),
                  ...(options.errorCode ? { errorCode: options.errorCode } : {}),
                  ...(options.recoveryState ? { recoveryState: options.recoveryState } : {}),
                  ...(options.searchMode ? { searchMode: options.searchMode } : {})
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
      async redisWorkerAffinity(input) {
        return {
          ...(input.ownerWorkerId ? { ownerWorkerId: input.ownerWorkerId } : {}),
          preferredWorkerId: "worker_1",
          ...(input.workspaceId === "ws_1" ? { workspaceAffinityWorkerId: "worker_1" } : {}),
          ...(input.sessionId === "ses_1" ? { sessionAffinityWorkerId: "worker_2" } : {}),
          ...(input.ownerId ? { ownerAffinityWorkerId: "worker_1" } : {}),
          candidates: [
            {
              workerId: "worker_1",
              processKind: "standalone",
              state: "idle",
              health: "healthy",
              score: 930,
              slotCapacity: 1,
              idleSlots: 1,
              busySlots: 0,
              matchingSessionSlots: 0,
              matchingWorkspaceSlots: input.workspaceId === "ws_1" ? 1 : 0,
              matchingOwnerWorkspaces: input.ownerId ? 1 : 0,
              reasons: ["healthy", "idle_slot_capacity", ...(input.ownerWorkerId === "worker_1" ? ["owner_worker"] : [])]
            },
            {
              workerId: "worker_2",
              processKind: "embedded",
              state: "busy",
              health: "healthy",
              score: 180,
              slotCapacity: 1,
              idleSlots: 0,
              busySlots: 1,
              matchingSessionSlots: input.sessionId === "ses_1" ? 1 : 0,
              matchingWorkspaceSlots: 0,
              matchingOwnerWorkspaces: 0,
              reasons: ["healthy", "slot_saturated", ...(input.sessionId === "ses_1" ? ["same_session"] : [])]
            }
          ]
        };
      },
      async redisWorkspacePlacements(input) {
        const workspaceId = input?.workspaceId;
        const ownerId = input?.ownerId;
        const ownerWorkerId = input?.ownerWorkerId;
        const state = input?.state;
        const items = [
          {
            workspaceId: workspaceId ?? "ws_1",
            version: "live",
            ownerId: ownerId ?? "user_1",
            ownerWorkerId: ownerWorkerId ?? "worker_1",
            ownerBaseUrl: "http://worker-1.internal:8787",
            state: state ?? "idle",
            sourceKind: "object_store" as const,
            localPath: "/tmp/materialized/ws_1",
            remotePrefix: "workspace/demo",
            dirty: false,
            refCount: 0,
            lastActivityAt: "2026-04-15T00:00:00.000Z",
            materializedAt: "2026-04-14T23:59:00.000Z",
            updatedAt: "2026-04-15T00:00:01.000Z"
          }
        ];
        return {
          items
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
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });
    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
      storageAdmin
    });

    const [
      overviewResponse,
      scopedOverviewResponse,
      tableResponse,
      filteredTableResponse,
      keysResponse,
      keyResponse,
      affinityResponse,
      placementsResponse,
      deleteResponse,
      batchDeleteResponse,
      clearQueueResponse,
      releaseLockResponse
    ] = await Promise.all([
      fetch(`${activeApp.baseUrl}/api/v1/storage/overview`),
      fetch(`${activeApp.baseUrl}/api/v1/storage/overview?serviceName=@default`),
      fetch(`${activeApp.baseUrl}/api/v1/storage/postgres/tables/runs?limit=20&offset=40`),
      fetch(
        `${activeApp.baseUrl}/api/v1/storage/postgres/tables/runs?limit=20&q=completed&searchMode=full_row&runId=run_1&status=failed&errorCode=worker_recovery_failed&recoveryState=quarantined&serviceName=acme`
      ),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/keys?pattern=oah:*`),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/key?key=oah:runs:ready`),
      fetch(
        `${activeApp.baseUrl}/api/v1/storage/redis/worker-affinity?workspaceId=ws_1&sessionId=ses_1&ownerWorkerId=worker_1`
      ),
      fetch(`${activeApp.baseUrl}/api/v1/storage/redis/workspace-placements?workspaceId=ws_1`),
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
    expect(scopedOverviewResponse.status).toBe(200);
    expect(tableResponse.status).toBe(200);
    expect(filteredTableResponse.status).toBe(200);
    expect(keysResponse.status).toBe(200);
    expect(keyResponse.status).toBe(200);
    expect(affinityResponse.status).toBe(200);
    expect(placementsResponse.status).toBe(200);
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
    await expect(scopedOverviewResponse.json()).resolves.toMatchObject({
      postgres: {
        database: "oah_test"
      }
    });
    expect(overviewOptions).toEqual([{}, { serviceName: "@default" }]);
    await expect(tableResponse.json()).resolves.toMatchObject({
      table: "runs",
      rowCount: 12,
      offset: 40,
      limit: 20
    });
    await expect(filteredTableResponse.json()).resolves.toMatchObject({
      appliedFilters: {
        serviceName: "acme",
        q: "completed",
        runId: "run_1",
        status: "failed",
        errorCode: "worker_recovery_failed",
        recoveryState: "quarantined",
        searchMode: "full_row"
      }
    });
    expect(postgresTableOptions.at(-1)).toMatchObject({
      limit: 20,
      serviceName: "acme",
      q: "completed",
      runId: "run_1",
      status: "failed",
      errorCode: "worker_recovery_failed",
      recoveryState: "quarantined",
      searchMode: "full_row"
    });
    await expect(keysResponse.json()).resolves.toMatchObject({
      items: [{ key: "oah:runs:ready" }]
    });
    await expect(keyResponse.json()).resolves.toMatchObject({
      key: "oah:runs:ready",
      value: ["run_1", "run_2"]
    });
    await expect(affinityResponse.json()).resolves.toMatchObject({
      ownerWorkerId: "worker_1",
      preferredWorkerId: "worker_1",
      workspaceAffinityWorkerId: "worker_1",
      sessionAffinityWorkerId: "worker_2",
      candidates: [{ workerId: "worker_1" }, { workerId: "worker_2" }]
    });
    await expect(placementsResponse.json()).resolves.toMatchObject({
      items: [
        {
          workspaceId: "ws_1",
          ownerId: "user_1",
          ownerWorkerId: "worker_1",
          state: "idle"
        }
      ]
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
        runtime: "workspace",
        rootPath: "/tmp/no-auth-workspace"
      })
    });

    expect(response.status).toBe(201);
  });

  it("enforces local API bearer token while leaving OAP public probes readable", async () => {
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence()
      }),
      new FakeModelGateway(20),
      {
        localApiAuthToken: "local-token",
        systemProfile: {
          apiCompatibility: "oah/v1",
          product: "open-agent-harness",
          edition: "personal",
          runtimeMode: "daemon",
          deploymentKind: "oap",
          displayName: "OAP local daemon",
          capabilities: {
            localDaemonControl: true,
            localWorkspacePaths: true,
            workspaceRegistration: true,
            storageInspection: false,
            assetManagement: false,
            modelManagement: true,
            localDaemonSupervisor: true
          }
        }
      }
    );

    const [
      profileResponse,
      healthResponse,
      missingTokenResponse,
      wrongTokenResponse,
      authorizedResponse,
      internalMissingTokenResponse,
      internalResponse
    ] = await Promise.all([
      fetch(`${activeApp.baseUrl}/api/v1/system/profile`),
      fetch(`${activeApp.baseUrl}/healthz`),
      fetch(`${activeApp.baseUrl}/api/v1/workspaces`),
      fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
        headers: {
          authorization: "Bearer wrong-token"
        }
      }),
      fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
        headers: {
          authorization: "Bearer local-token"
        }
      }),
      fetch(`${activeApp.baseUrl}/internal/v1/models/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          prompt: "hello"
        })
      }),
      fetch(`${activeApp.baseUrl}/internal/v1/models/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local-token"
        },
        body: JSON.stringify({
          prompt: "hello"
        })
      })
    ]);

    expect(profileResponse.status).toBe(200);
    expect(healthResponse.status).toBe(200);
    expect(missingTokenResponse.status).toBe(401);
    expect(wrongTokenResponse.status).toBe(401);
    expect(authorizedResponse.status).toBe(200);
    expect(internalMissingTokenResponse.status).toBe(401);
    expect(internalResponse.status).toBe(200);
    await expect(missingTokenResponse.json()).resolves.toMatchObject({
      error: {
        code: "unauthorized"
      }
    });
  });

  it("records workspace owner affinity from workspace creation without rebinding it during session creation", async () => {
    const assignedOwners: Array<{ workspaceId: string; ownerId: string; overwrite?: boolean }> = [];
    const initializerWorkspaceIds: string[] = [];
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceInitializer: {
        async initialize(input) {
          if (typeof (input as { workspaceId?: string | undefined }).workspaceId === "string") {
            initializerWorkspaceIds.push((input as { workspaceId: string }).workspaceId);
          }
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
              workspaceId: "runtime",
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
      assignWorkspacePlacementOwnerAffinity: async (input) => {
        assignedOwners.push({
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          overwrite: input.overwrite
        });
      },
      sandboxHostProviderKind: "self_hosted"
    });

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "placement-user-workspace",
        runtime: "workspace",
        rootPath: "/tmp/placement-user-workspace",
        ownerId: "user_explicit",
        serviceName: "Acme-App"
      })
    });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string; serviceName?: string };
    expect(workspace.serviceName).toBe("acme-app");

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    expect(sessionResponse.status).toBe(201);

    expect(initializerWorkspaceIds).toHaveLength(1);
    expect(assignedOwners).toEqual([
      {
        workspaceId: initializerWorkspaceIds[0],
        ownerId: "user_explicit",
        overwrite: true
      }
    ]);
    expect(workspace.id).toBe(initializerWorkspaceIds[0]);
  });

  it("persists owner affinity when creating a sandbox-backed workspace", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceInitializer: {
        async initialize(input) {
          const rootPath = input.rootPath ?? (await mkdtemp(path.join(os.tmpdir(), "oah-http-sandbox-create-")));
          tempWorkspaceRoots.push(rootPath);
          return {
            rootPath,
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
              workspaceId: "runtime",
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
      sandboxHostProviderKind: "e2b"
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "sandbox-owner-workspace",
        runtime: "workspace",
        ownerId: "owner_create"
      })
    });

    expect(response.status).toBe(201);
    const sandbox = (await response.json()) as { workspaceId: string };
    await expect(runtimeService.getWorkspace(sandbox.workspaceId)).resolves.toMatchObject({
      id: sandbox.workspaceId,
      ownerId: "owner_create"
    });
  });

  it("passes owner affinity through sandbox import requests", async () => {
    const importedInputs: Array<{
      rootPath: string;
      kind?: "project";
      name?: string;
      externalRef?: string;
      ownerId?: string;
      serviceName?: string;
    }> = [];
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
      sandboxHostProviderKind: "e2b",
      importWorkspace: async (input) => {
        importedInputs.push(input);
        const workspace = await createWorkspaceRecord({
          name: input.name ?? "imported-owner-workspace",
          ...(input.ownerId ? { ownerId: input.ownerId } : {})
        });
        await persistence.workspaceRepository.upsert(workspace);
        return workspace;
      }
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        rootPath: "/tmp/imported-owner-workspace",
        name: "imported-owner-workspace",
        ownerId: "owner_import"
      })
    });

    expect(response.status).toBe(201);
    expect(importedInputs).toEqual([
      expect.objectContaining({
        rootPath: "/tmp/imported-owner-workspace",
        name: "imported-owner-workspace",
        ownerId: "owner_import"
      })
    ]);
  });

  it("rejects sandbox requests whose owner does not match an existing workspace", async () => {
    const workspace = await createWorkspaceRecord({
      ownerId: "owner_existing"
    });
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert(workspace);
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
      sandboxHostProviderKind: "e2b"
    });

    const response = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        ownerId: "owner_other"
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "workspace_owner_mismatch"
      }
    });
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
        runtime: "workspace",
        rootPath: "/tmp/demo-a"
      })
    });
    const firstWorkspace = (await firstWorkspaceResponse.json()) as { id: string };

    const secondWorkspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "demo-b",
        runtime: "workspace",
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

    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

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
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
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
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence()
      }),
      new FakeModelGateway(20),
      {
        workspaceMode: "single"
      }
    );

    const [runtimesResponse, createResponse, importResponse, deleteResponse] = await Promise.all([
      fetch(`${activeApp.baseUrl}/api/v1/runtimes`),
      fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "blocked-workspace",
          runtime: "workspace"
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

    expect(runtimesResponse.status).toBe(501);
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
    const runtimeService = new EngineService({
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
              workspaceId: "runtime",
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "managed-workspace",
        runtime: "workspace",
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

    await waitFor(() =>
      access(workspaceRoot).then(
        () => false,
        () => true
      )
    );
  });

  it("returns from workspace deletion before managed artifact cleanup finishes over HTTP", async () => {
    const managedRoot = await mkdtemp(path.join(os.tmpdir(), "oah-http-delete-async-root-"));
    const workspaceRoot = path.join(managedRoot, "workspace-a");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "README.md"), "temporary workspace", "utf8");

    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupStarted = vi.fn();
    const cleanupFinished = vi.fn();
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceDeletionHandler: {
        async deleteWorkspace(workspace) {
          cleanupStarted(workspace.id);
          await cleanupGate;
          await rm(workspace.rootPath, {
            recursive: true,
            force: true
          });
          cleanupFinished(workspace.id);
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
              workspaceId: "runtime",
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "managed-workspace",
        runtime: "workspace",
        rootPath: workspaceRoot
      })
    });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };

    let deleteSettled = false;
    const deletePromise = fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer token-1"
      }
    }).then((response) => {
      deleteSettled = true;
      return response;
    });

    try {
      await waitFor(() => deleteSettled, 1_000);
      const deleteResponse = await deletePromise;
      expect(deleteResponse.status).toBe(204);
      expect(cleanupStarted).toHaveBeenCalledWith(workspace.id);
      expect(cleanupFinished).not.toHaveBeenCalled();
      await expect(access(workspaceRoot)).resolves.toBeUndefined();

      const missingWorkspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      expect(missingWorkspaceResponse.status).toBe(404);
    } finally {
      releaseCleanup?.();
    }

    await deletePromise;
    await waitFor(() => cleanupFinished.mock.calls.length > 0);
    await expect(access(workspaceRoot)).rejects.toBeDefined();
  });

  it("treats deleting an already-missing workspace as idempotent and clears coordination state", async () => {
    const clearedWorkspaceIds: string[] = [];
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: new FakeModelGateway(20),
        ...createMemoryRuntimePersistence()
      }),
      new FakeModelGateway(20),
      {
        clearWorkspaceCoordination: async (workspaceId: string) => {
          clearedWorkspaceIds.push(workspaceId);
        }
      }
    );

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/ws_missing`, {
      method: "DELETE"
    });

    expect(response.status).toBe(204);
    expect(clearedWorkspaceIds).toEqual(["ws_missing"]);
  });

  it("manages sandbox files over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway
    );

    const mkdirResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/directories`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/workspace/notes"
      })
    });
    expect(mkdirResponse.status).toBe(201);

    const writeResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/workspace/notes/hello.txt",
        content: "hello workspace",
        encoding: "utf8"
      })
    });
    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toMatchObject({
      path: "/workspace/notes/hello.txt",
      type: "file",
      readOnly: false
    });

    const listResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/entries?path=${encodeURIComponent("/workspace/notes")}`
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      path: "/workspace/notes",
      items: [
        {
          path: "/workspace/notes/hello.txt",
          name: "hello.txt",
          type: "file"
        }
      ]
    });

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content?path=${encodeURIComponent("/workspace/notes/hello.txt")}`
    );
    expect(readResponse.status).toBe(200);
    const readPayload = (await readResponse.json()) as { content: string; etag?: string };
    expect(readPayload.content).toBe("hello workspace");
    expect(readPayload.etag).toBeTruthy();

    const moveResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/move`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sourcePath: "/workspace/notes/hello.txt",
        targetPath: "/workspace/notes/renamed.txt"
      })
    });
    expect(moveResponse.status).toBe(200);
    await expect(moveResponse.json()).resolves.toMatchObject({
      path: "/workspace/notes/renamed.txt",
      name: "renamed.txt"
    });

    const deleteResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/entry?path=${encodeURIComponent("/workspace/notes/renamed.txt")}`,
      {
        method: "DELETE"
      }
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      workspaceId: workspace.id,
      path: "/workspace/notes/renamed.txt",
      type: "file",
      deleted: true
    });
  });

  it("keeps sandbox file operations active on the public HTTP API", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);
    const touchWorkspaceActivity = vi.fn(async (_workspaceId: string) => undefined);
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway,
      { touchWorkspaceActivity }
    );

    const writeResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/workspace/refresh-check.txt",
        content: "still here",
        encoding: "utf8"
      })
    });
    expect(writeResponse.status).toBe(200);

    const listResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/entries?path=${encodeURIComponent("/workspace")}`
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          path: "/workspace/refresh-check.txt",
          type: "file"
        })
      ])
    });

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content?path=${encodeURIComponent("/workspace/refresh-check.txt")}`
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      content: "still here"
    });

    expect(touchWorkspaceActivity).toHaveBeenCalledTimes(3);
    expect(touchWorkspaceActivity).toHaveBeenNthCalledWith(1, workspace.id);
    expect(touchWorkspaceActivity).toHaveBeenNthCalledWith(2, workspace.id);
    expect(touchWorkspaceActivity).toHaveBeenNthCalledWith(3, workspace.id);
  });

  it("serves workspace memory inspection and proposal review over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord({
      settings: {
        defaultAgent: "assistant",
        skillDirs: [],
        engine: {
          workspaceMemory: {
            enabled: true,
            writePolicy: "confirm-suggested"
          }
        }
      }
    });
    await mkdir(path.join(workspace.rootPath, ".openharness", "memory", "topics", "project"), { recursive: true });
    await mkdir(path.join(workspace.rootPath, ".openharness", "memory", "proposals"), { recursive: true });
    await writeFile(
      path.join(workspace.rootPath, ".openharness", "memory", "MEMORY.md"),
      "- [HTTP](.openharness/memory/topics/project/http.md) - HTTP memory API\n",
      "utf8"
    );
    await writeFile(
      path.join(workspace.rootPath, ".openharness", "memory", "topics", "project", "http.md"),
      [
        "---",
        "name: \"HTTP memory\"",
        "description: \"HTTP memory API\"",
        "type: project",
        "---",
        "",
        "Expose structured memory review endpoints."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace.rootPath, ".openharness", "memory", "proposals", "pending-http.md"),
      [
        "---",
        "id: \"pending-http\"",
        "status: \"pending\"",
        "tool: \"MemoryRemember\"",
        "target_path: \".openharness/memory/topics/project/http-applied.md\"",
        "created_at: \"2026-05-15T00:00:00.000Z\"",
        "---",
        "",
        "```json",
        JSON.stringify(
          {
            type: "project",
            title: "HTTP applied",
            content: "HTTP proposal application works."
          },
          null,
          2
        ),
        "```"
      ].join("\n"),
      "utf8"
    );
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway
    );

    const statusResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/memory/status`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      enabled: true,
      writePolicy: "confirm-suggested",
      topics: 1,
      pendingProposals: 1
    });

    const searchResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/memory/search?query=${encodeURIComponent("structured review")}`
    );
    expect(searchResponse.status).toBe(200);
    await expect(searchResponse.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      items: [
        expect.objectContaining({
          path: ".openharness/memory/topics/project/http.md",
          title: "HTTP memory"
        })
      ]
    });

    const proposalsResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/memory/proposals`);
    expect(proposalsResponse.status).toBe(200);
    await expect(proposalsResponse.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          path: ".openharness/memory/proposals/pending-http.md",
          status: "pending",
          tool: "MemoryRemember"
        })
      ]
    });

    const applyResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/memory/proposals/apply`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: ".openharness/memory/proposals/pending-http.md"
      })
    });
    expect(applyResponse.status).toBe(200);
    await expect(applyResponse.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      path: ".openharness/memory/proposals/pending-http.md",
      status: "applied"
    });
    await expect(
      readFile(path.join(workspace.rootPath, ".openharness", "memory", "topics", "project", "http-applied.md"), "utf8")
    ).resolves.toContain("HTTP proposal application works.");
  });

  it("serves sandbox file entries from the fast path when available", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);
    const listWorkspaceEntriesFast = vi.fn(async (input: {
      workspaceId: string;
      path?: string | undefined;
      pageSize: number;
      cursor?: string | undefined;
      sortBy: WorkspaceEntrySortBy;
      sortOrder: SortOrder;
      includeDirectoryDescendantUpdatedAt?: boolean | undefined;
      includeEntryMetadata?: boolean | undefined;
    }): Promise<WorkspaceEntryPage | undefined> => ({
      workspaceId: input.workspaceId,
      path: input.path ?? ".",
      items: [
        {
          path: "src",
          name: "src",
          type: "directory",
          readOnly: true
        }
      ]
    }));
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway,
      { listWorkspaceEntriesFast }
    );

    const listResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/entries?path=${encodeURIComponent("/workspace")}&includeEntryMetadata=false&includeDirectoryDescendantUpdatedAt=false`
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      path: "/workspace",
      items: [
        {
          path: "/workspace/src",
          name: "src",
          type: "directory",
          readOnly: true
        }
      ]
    });
    expect(listWorkspaceEntriesFast).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        path: ".",
        includeEntryMetadata: false,
        includeDirectoryDescendantUpdatedAt: false
      })
    );
  });

  it("uploads and downloads sandbox files over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway
    );

    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    const uploadResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/upload?path=${encodeURIComponent("/workspace/bin/data.bin")}`,
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
      path: "/workspace/bin/data.bin",
      type: "file",
      sizeBytes: 5
    });

    const downloadResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/download?path=${encodeURIComponent("/workspace/bin/data.bin")}`
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-disposition")).toContain("data.bin");
    expect(downloadResponse.headers.get("etag")).toBeTruthy();
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(bytes);

    const contentResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content?path=${encodeURIComponent("/workspace/bin/data.bin")}&encoding=base64`
    );
    expect(contentResponse.status).toBe(200);
    const contentPayload = (await contentResponse.json()) as { content: string };
    expect(contentPayload.content).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("returns a routing hint when sandbox files are owned by another worker", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway,
      {
        resolveWorkspaceOwnership: async (workspaceId) => ({
          workspaceId,
          version: "live",
          ownerWorkerId: "worker-remote",
          health: "healthy",
          lastActivityAt: "2026-04-14T12:00:00.000Z",
          localPath: "/tmp/worker-remote/ws",
          remotePrefix: "workspace/demo",
          isLocalOwner: false
        })
      }
    );

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content?path=${encodeURIComponent("/workspace/hello.txt")}`
    );
    expect(readResponse.status).toBe(409);
    await expect(readResponse.json()).resolves.toMatchObject({
      error: {
        code: "workspace_owned_by_another_worker",
        details: {
          workspaceId: workspace.id,
          ownerWorkerId: "worker-remote",
          version: "live",
          routingHint: "owner_worker"
        }
      }
    });

    const writeResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/workspace/hello.txt",
        content: "blocked",
        encoding: "utf8"
      })
    });
    expect(writeResponse.status).toBe(409);
    await expect(writeResponse.json()).resolves.toMatchObject({
      error: {
        code: "workspace_owned_by_another_worker"
      }
    });
  });

  it("proxies sandbox file requests to the owner when an internal owner base url is available", async () => {
    const ownerGateway = new FakeModelGateway(20);
    const ownerPersistence = createMemoryRuntimePersistence();
    const ownerRuntime = new EngineService({
      defaultModel: "openai-default",
      modelGateway: ownerGateway,
      ...ownerPersistence
    });
    const ownerWorkspace = await createWorkspaceRecord();
    await writeFile(path.join(ownerWorkspace.rootPath, "hello.txt"), "Hello from OAH.\n", "utf8");
    await ownerPersistence.workspaceRepository.upsert(ownerWorkspace);

    const ownerApp = createApp({
      runtimeService: ownerRuntime,
      modelGateway: ownerGateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceMode: "multi"
    });
    await ownerApp.listen({ host: "127.0.0.1", port: 0 });
    activeClosers.push(async () => {
      await ownerApp.close();
    });
    const ownerAddress = ownerApp.server.address() as AddressInfo;
    const ownerBaseUrl = `http://127.0.0.1:${ownerAddress.port}`;

    const proxyGateway = new FakeModelGateway(20);
    const proxyPersistence = createMemoryRuntimePersistence();
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: proxyGateway,
        ...proxyPersistence
      }),
      proxyGateway,
      {
        resolveWorkspaceOwnership: async (workspaceId) => ({
          workspaceId,
          version: "live",
          ownerWorkerId: "worker-owner",
          ownerBaseUrl,
          health: "healthy",
          lastActivityAt: "2026-04-14T12:00:00.000Z",
          localPath: "/tmp/worker-owner/ws",
          remotePrefix: "workspace/demo",
          isLocalOwner: false
        })
      }
    );

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${ownerWorkspace.id}/files/content?path=${encodeURIComponent("/workspace/hello.txt")}`
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      workspaceId: ownerWorkspace.id,
      path: "/workspace/hello.txt",
      content: "Hello from OAH.\n"
    });

    const writeResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${ownerWorkspace.id}/files/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/workspace/hello.txt",
        content: "proxied write\n",
        encoding: "utf8"
      })
    });
    expect(writeResponse.status).toBe(200);

    const verifyResponse = await fetch(
      `${ownerBaseUrl}/internal/v1/sandboxes/${ownerWorkspace.id}/files/content?path=${encodeURIComponent("/workspace/hello.txt")}`
    );
    expect(verifyResponse.status).toBe(200);
    await expect(verifyResponse.json()).resolves.toMatchObject({
      content: "proxied write\n"
    });
  });

  it("exposes sandbox-compatible create, file, stat, and command routes", async () => {
    activeApp = await createStartedApp();

    const createResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "sandbox-demo",
        runtime: "workspace"
      })
    });
    expect(createResponse.status).toBe(201);
    const sandbox = await createResponse.json();
    expect(sandbox).toMatchObject({
      provider: "embedded",
      rootPath: "/workspace",
      name: "sandbox-demo"
    });

    const writeResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${sandbox.id}/files/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/workspace/hello.txt",
        content: "hello sandbox\n",
        encoding: "utf8"
      })
    });
    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toMatchObject({
      path: "/workspace/hello.txt"
    });

    const statResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${sandbox.id}/files/stat?path=${encodeURIComponent("/workspace/hello.txt")}`
    );
    expect(statResponse.status).toBe(200);
    await expect(statResponse.json()).resolves.toMatchObject({
      kind: "file",
      path: "/workspace/hello.txt"
    });

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${sandbox.id}/files/content?path=${encodeURIComponent("/workspace/hello.txt")}`
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      workspaceId: sandbox.workspaceId,
      path: "/workspace/hello.txt",
      content: "hello sandbox\n"
    });

    const commandResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${sandbox.id}/commands/foreground`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: "cat hello.txt",
        cwd: "/workspace"
      })
    });
    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toMatchObject({
      stdout: "hello sandbox\n",
      stderr: "",
      exitCode: 0
    });
  });

  it("creates an internal sandbox-backed workspace when a missing workspaceId is supplied with runtime metadata", async () => {
    activeApp = await createStartedApp();

    const sandboxId = "ws_internal_sandbox_create";
    const createResponse = await fetch(`${activeApp.baseUrl}/internal/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: sandboxId,
        name: "internal-sandbox-create",
        runtime: "workspace"
      })
    });

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      id: sandboxId,
      workspaceId: sandboxId,
      name: "internal-sandbox-create",
      rootPath: "/workspace"
    });

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${sandboxId}`);
    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      id: sandboxId,
      name: "internal-sandbox-create"
    });

    const resolveResponse = await fetch(`${activeApp.baseUrl}/internal/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: sandboxId
      })
    });

    expect(resolveResponse.status).toBe(200);
    await expect(resolveResponse.json()).resolves.toMatchObject({
      id: sandboxId,
      workspaceId: sandboxId
    });
  });

  it("reports the configured e2b sandbox provider on sandbox responses", async () => {
    activeApp = await createStartedApp({
      sandboxHostProviderKind: "e2b"
    });

    const createResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "sandbox-provider-demo",
        runtime: "workspace"
      })
    });

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      provider: "e2b",
      executionModel: "sandbox_hosted",
      workerPlacement: "inside_sandbox"
    });
  });

  it("projects workspace root paths to the sandbox root for remote sandbox providers", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.create({
      id: "ws_remote_projection",
      name: "remote-projection",
      rootPath: "/data/workspaces/ws_remote_projection",
      executionPolicy: "local",
      status: "active",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      settings: {
        defaultAgent: "default",
        runtime: "workspace",
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
        workspaceId: "ws_remote_projection",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z"
    });

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
      sandboxHostProviderKind: "self_hosted"
    });

    const listResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces?pageSize=20`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: "ws_remote_projection",
          rootPath: "/workspace"
        })
      ]
    });

    const detailResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/ws_remote_projection`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: "ws_remote_projection",
      rootPath: "/workspace"
    });
  });

  it("proxies workspace deletion to the owner worker", async () => {
    const ownerGateway = new FakeModelGateway(20);
    const ownerPersistence = createMemoryRuntimePersistence();
    const ownerRuntime = new EngineService({
      defaultModel: "openai-default",
      modelGateway: ownerGateway,
      ...ownerPersistence
    });
    const ownerWorkspace = await createWorkspaceRecord();
    await ownerPersistence.workspaceRepository.upsert(ownerWorkspace);

    const ownerApp = createApp({
      runtimeService: ownerRuntime,
      modelGateway: ownerGateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceMode: "multi"
    });
    await ownerApp.listen({ host: "127.0.0.1", port: 0 });
    activeClosers.push(async () => {
      await ownerApp.close();
    });
    const ownerAddress = ownerApp.server.address() as AddressInfo;
    const ownerBaseUrl = `http://127.0.0.1:${ownerAddress.port}`;

    const proxyGateway = new FakeModelGateway(20);
    const proxyPersistence = createMemoryRuntimePersistence();
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: proxyGateway,
        ...proxyPersistence
      }),
      proxyGateway,
      {
        resolveWorkspaceOwnership: async (workspaceId) => ({
          workspaceId,
          version: "live",
          ownerWorkerId: "worker-owner",
          ownerBaseUrl,
          health: "healthy",
          lastActivityAt: "2026-04-16T00:00:00.000Z",
          localPath: "/tmp/worker-owner/ws",
          remotePrefix: "workspace/demo",
          isLocalOwner: false
        }),
        sandboxHostProviderKind: "self_hosted"
      }
    );

    const deleteResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${ownerWorkspace.id}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer token-1"
      }
    });

    expect(deleteResponse.status).toBe(204);
    await expect(ownerPersistence.workspaceRepository.getById(ownerWorkspace.id)).resolves.toBeNull();
  });

  it("delegates self-hosted workspace deletion to a fallback worker when no active owner lease is visible", async () => {
    const workerGateway = new FakeModelGateway(20);
    const workerPersistence = createMemoryRuntimePersistence();
    const workerDeleted = vi.fn();
    const workerRuntime = new EngineService({
      defaultModel: "openai-default",
      modelGateway: workerGateway,
      ...workerPersistence,
      workspaceDeletionHandler: {
        async deleteWorkspace(workspace) {
          workerDeleted(workspace.id);
        }
      }
    });
    const workspace = await createWorkspaceRecord();
    await workerPersistence.workspaceRepository.upsert(workspace);

    const workerApp = createApp({
      runtimeService: workerRuntime,
      modelGateway: workerGateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceMode: "multi"
    });
    await workerApp.listen({ host: "127.0.0.1", port: 0 });
    activeClosers.push(async () => {
      await workerApp.close();
    });
    const workerAddress = workerApp.server.address() as AddressInfo;
    const workerBaseUrl = `http://127.0.0.1:${workerAddress.port}`;

    const apiGateway = new FakeModelGateway(20);
    const apiPersistence = createMemoryRuntimePersistence();
    const apiDeleteHandler = vi.fn(async () => {
      throw new Error("API-side workspace deletion should have been delegated to the worker.");
    });
    await apiPersistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: apiGateway,
        ...apiPersistence,
        workspaceDeletionHandler: {
          deleteWorkspace: apiDeleteHandler
        }
      }),
      apiGateway,
      {
        sandboxHostProviderKind: "self_hosted",
        sandboxOwnerFallbackBaseUrl: workerBaseUrl
      }
    );

    const deleteResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer token-1"
      }
    });

    expect(deleteResponse.status).toBe(204);
    expect(apiDeleteHandler).not.toHaveBeenCalled();
    await waitFor(() => workerDeleted.mock.calls.some(([workspaceId]) => workspaceId === workspace.id));
    await expect(workerPersistence.workspaceRepository.getById(workspace.id)).resolves.toBeNull();
    await expect(apiPersistence.workspaceRepository.getById(workspace.id)).resolves.toEqual(expect.objectContaining({ id: workspace.id }));
  });

  it("delegates self-hosted workspace file uploads to a fallback worker when no active owner lease is visible", async () => {
    const workerGateway = new FakeModelGateway(20);
    const workerPersistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await workerPersistence.workspaceRepository.upsert(workspace);

    const workerApp = createApp({
      runtimeService: new EngineService({
        defaultModel: "openai-default",
        modelGateway: workerGateway,
        ...workerPersistence
      }),
      modelGateway: workerGateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceMode: "multi"
    });
    await workerApp.listen({ host: "127.0.0.1", port: 0 });
    activeClosers.push(async () => {
      await workerApp.close();
    });
    const workerAddress = workerApp.server.address() as AddressInfo;
    const workerBaseUrl = `http://127.0.0.1:${workerAddress.port}`;

    const apiGateway = new FakeModelGateway(20);
    const apiPersistence = createMemoryRuntimePersistence();
    const apiWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-api-upload-should-stay-empty-"));
    tempWorkspaceRoots.push(apiWorkspaceRoot);
    await apiPersistence.workspaceRepository.upsert({
      ...workspace,
      rootPath: apiWorkspaceRoot
    });
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: apiGateway,
        ...apiPersistence
      }),
      apiGateway,
      {
        sandboxHostProviderKind: "self_hosted",
        sandboxOwnerFallbackBaseUrl: workerBaseUrl
      }
    );

    const uploadResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/files/upload?path=${encodeURIComponent("delegated.bin")}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream"
        },
        body: Uint8Array.from([1, 2, 3, 4])
      }
    );

    expect(uploadResponse.status).toBe(200);
    await expect(readFile(path.join(workspace.rootPath, "delegated.bin"))).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    await expect(access(path.join(apiWorkspaceRoot, "delegated.bin"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("exposes a unified internal workspace lifecycle endpoint on workers", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const lifecycleCalls: Array<{
      workspaceId: string;
      operation: string;
      force?: boolean;
    }> = [];
    const app = createInternalWorkerApp({
      runtimeService: new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      modelGateway: gateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceLifecycle: {
        async execute(input) {
          lifecycleCalls.push(input);
          return {
            workspaceId: input.workspaceId,
            operation: input.operation,
            status: "completed",
            ...(input.operation === "evict"
              ? {
                  evicted: [],
                  skipped: []
                }
              : {})
          };
        }
      }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    activeClosers.push(async () => {
      await app.close();
    });
    const address = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/internal/v1/workspaces/ws_lifecycle/lifecycle`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        operation: "evict",
        force: true
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: "ws_lifecycle",
      operation: "evict",
      status: "completed",
      evicted: [],
      skipped: []
    });
    expect(lifecycleCalls).toEqual([
      {
        workspaceId: "ws_lifecycle",
        operation: "evict",
        force: true
      }
    ]);
  });

  it("proxies sandbox requests to the owner worker", async () => {
    const ownerGateway = new FakeModelGateway(20);
    const ownerPersistence = createMemoryRuntimePersistence();
    const ownerRuntime = new EngineService({
      defaultModel: "openai-default",
      modelGateway: ownerGateway,
      ...ownerPersistence
    });
    const ownerWorkspace = await createWorkspaceRecord();
    await writeFile(path.join(ownerWorkspace.rootPath, "hello.txt"), "Hello sandbox owner.\n", "utf8");
    await ownerPersistence.workspaceRepository.upsert(ownerWorkspace);

    const ownerApp = createApp({
      runtimeService: ownerRuntime,
      modelGateway: ownerGateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceMode: "multi"
    });
    await ownerApp.listen({ host: "127.0.0.1", port: 0 });
    activeClosers.push(async () => {
      await ownerApp.close();
    });
    const ownerAddress = ownerApp.server.address() as AddressInfo;
    const ownerBaseUrl = `http://127.0.0.1:${ownerAddress.port}`;

    const proxyGateway = new FakeModelGateway(20);
    const proxyPersistence = createMemoryRuntimePersistence();
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: proxyGateway,
        ...proxyPersistence
      }),
      proxyGateway,
      {
        resolveWorkspaceOwnership: async (workspaceId) => ({
          workspaceId,
          version: "live",
          ownerWorkerId: "worker-owner",
          ownerBaseUrl,
          health: "healthy",
          lastActivityAt: "2026-04-16T00:00:00.000Z",
          localPath: "/tmp/worker-owner/ws",
          remotePrefix: "workspace/demo",
          isLocalOwner: false
        }),
        sandboxHostProviderKind: "self_hosted"
      }
    );

    const infoResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${ownerWorkspace.id}`);
    expect(infoResponse.status).toBe(200);
    await expect(infoResponse.json()).resolves.toMatchObject({
      id: ownerWorkspace.id,
      rootPath: "/workspace"
    });

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${ownerWorkspace.id}/files/content?path=${encodeURIComponent("/workspace/hello.txt")}`
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      content: "Hello sandbox owner.\n"
    });

    const commandResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${ownerWorkspace.id}/commands/foreground`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: "cat hello.txt",
        cwd: "/workspace"
      })
    });
    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toMatchObject({
      stdout: "Hello sandbox owner.\n",
      exitCode: 0
    });
  });

  it("falls back to the configured sandbox owner base url for sandbox requests", async () => {
    const ownerGateway = new FakeModelGateway(20);
    const ownerPersistence = createMemoryRuntimePersistence();
    const ownerRuntime = new EngineService({
      defaultModel: "openai-default",
      modelGateway: ownerGateway,
      ...ownerPersistence
    });
    const ownerWorkspace = await createWorkspaceRecord();
    await writeFile(path.join(ownerWorkspace.rootPath, "hello.txt"), "Hello fallback owner.\n", "utf8");
    await ownerPersistence.workspaceRepository.upsert(ownerWorkspace);

    const ownerApp = createApp({
      runtimeService: ownerRuntime,
      modelGateway: ownerGateway,
      defaultModel: "openai-default",
      logger: false,
      workspaceMode: "multi"
    });
    await ownerApp.listen({ host: "127.0.0.1", port: 0 });
    activeClosers.push(async () => {
      await ownerApp.close();
    });
    const ownerAddress = ownerApp.server.address() as AddressInfo;
    const ownerBaseUrl = `http://127.0.0.1:${ownerAddress.port}`;

    const proxyGateway = new FakeModelGateway(20);
    const proxyPersistence = createMemoryRuntimePersistence();
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: proxyGateway,
        ...proxyPersistence
      }),
      proxyGateway,
      {
        resolveWorkspaceOwnership: async (workspaceId) => ({
          workspaceId,
          version: "live",
          ownerWorkerId: "worker-owner",
          health: "healthy",
          lastActivityAt: "2026-04-16T00:00:00.000Z",
          localPath: "/tmp/worker-owner/ws",
          remotePrefix: "workspace/demo",
          isLocalOwner: false
        }),
        sandboxHostProviderKind: "self_hosted",
        sandboxOwnerFallbackBaseUrl: `${ownerBaseUrl}/internal/v1`
      }
    );

    const readResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${ownerWorkspace.id}/files/content?path=${encodeURIComponent("/workspace/hello.txt")}`
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      content: "Hello fallback owner.\n"
    });
  });

  it("returns the local owner base url for sandbox creation responses served by the owner worker", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord();
    await persistence.workspaceRepository.upsert(workspace);

    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway,
      {
        sandboxHostProviderKind: "self_hosted",
        localOwnerBaseUrl: "http://worker-local.internal:8787"
      }
    );

    const response = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: workspace.id
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: workspace.id,
      ownerBaseUrl: "http://worker-local.internal:8787/internal/v1"
    });
  });

  it("rejects unsafe paths and mutations on read-only workspaces", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const workspace = await createWorkspaceRecord({
      readOnly: true
    });
    await persistence.workspaceRepository.upsert(workspace);
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
        defaultModel: "openai-default",
        modelGateway: gateway,
        ...persistence
      }),
      gateway
    );

    const traversalResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/files/content?path=${encodeURIComponent("/workspace/../secret.txt")}`
    );
    expect(traversalResponse.status).toBe(400);
    await expect(traversalResponse.json()).resolves.toMatchObject({
      error: {
        code: "invalid_sandbox_path"
      }
    });

    const readonlyResponse = await fetch(`${activeApp.baseUrl}/api/v1/sandboxes/${workspace.id}/directories`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/workspace/notes"
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
    const runtimeService = new EngineService({
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

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

  it("returns full project workspace catalogs over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "project_http_catalog",
      name: "project-http-catalog",
      rootPath: "/tmp/project-http-catalog",
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
          prompt: "You are a project assistant.",
          tools: {
            native: []
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
          directory: "/tmp/project-http-catalog/actions/dangerous.run",
          entry: {
            command: "printf unsafe"
          }
        }
      },
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          exposeToLlm: true,
          directory: "/tmp/project-http-catalog/skills/repo-explorer",
          sourceRoot: "/tmp/project-http-catalog/skills/repo-explorer",
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
        workspaceId: "project_http_catalog",
        agents: [{ name: "assistant", mode: "primary", source: "workspace" }],
        models: [],
        actions: [{ name: "dangerous.run", callableByApi: true, callableByUser: true, exposeToLlm: true }],
        skills: [{ name: "repo-explorer", exposeToLlm: true }],
        tools: [{ name: "docs", transportType: "http" }],
        hooks: [{ name: "rewrite-request", handlerType: "prompt", events: ["before_model_call"] }],
        nativeTools: ["shell"]
      }
    });
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

    const response = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/project_http_catalog/catalog`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: "project_http_catalog",
      agents: [{ name: "assistant", mode: "primary", source: "workspace" }],
      models: [],
      actions: [{ name: "dangerous.run", callableByApi: true, callableByUser: true, exposeToLlm: true }],
      skills: [{ name: "repo-explorer", exposeToLlm: true }],
      tools: [{ name: "docs", transportType: "http" }],
      hooks: [{ name: "rewrite-request", handlerType: "prompt", events: ["before_model_call"] }],
      nativeTools: expect.arrayContaining(["Bash", "Read", "Write"]),
      engineTools: expect.arrayContaining(["run_action", "Skill"])
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
        runtime: "workspace",
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
    const runtimeService = new EngineService({
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
              workspaceId: "runtime",
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway, {
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
        runtime: "workspace",
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
    activeApp = await createStartedAppWithEngineService(
      new EngineService({
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
                workspaceId: "runtime",
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
        runtime: "workspace",
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
        runtime: "workspace",
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
            engineToolNames?: string[];
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

  it("accepts structured user messages with image parts over HTTP", async () => {
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
        runtime: "workspace",
        rootPath: "/tmp/demo-multimodal"
      })
    });
    const workspace = (await workspaceResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    const session = (await sessionResponse.json()) as { id: string };

    const acceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: [
          {
            type: "text",
            text: "describe this"
          },
          {
            type: "image",
            image: "data:image/png;base64,AAAA",
            mediaType: "image/png"
          }
        ]
      })
    });

    expect(acceptedResponse.status).toBe(202);
    const accepted = (await acceptedResponse.json()) as { messageId: string };

    await waitFor(async () => {
      const messagesResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      const page = (await messagesResponse.json()) as { items: Array<{ id: string }> };
      return page.items.some((item) => item.id === accepted.messageId);
    });

    const messagesResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    const page = (await messagesResponse.json()) as { items: Array<{ id: string; role: string; content: unknown }> };
    expect(page.items.find((item) => item.id === accepted.messageId)).toEqual(
      expect.objectContaining({
        role: "user",
        content: [
          {
            type: "text",
            text: "describe this"
          },
          {
            type: "image",
            image: "data:image/png;base64,AAAA",
            mediaType: "image/png"
          }
        ]
      })
    );
  });

  it("manually requeues quarantined runs over HTTP", async () => {
    const gateway = new FakeModelGateway(20);
    const persistence = createMemoryRuntimePersistence();
    const enqueuedRuns: Array<{ sessionId: string; runId: string }> = [];
    const runtimeService = new EngineService({
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

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
    const runtimeService = new EngineService({
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

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

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
    const accepted = (await response.json()) as { runId: string; actionName: string; sessionId?: string };
    expect(accepted.actionName).toBe("debug.echo");
    expect(accepted.sessionId).toBeTruthy();

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

  it("rejects invalid action input over HTTP using input_schema validation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-http-action-validate-"));
    await mkdir(path.join(tempDir, ".openharness", "actions", "echo"), { recursive: true });

    await writeFile(
      path.join(tempDir, ".openharness", "actions", "echo", "ACTION.yaml"),
      `
name: debug.echo
description: Echo over HTTP
input_schema:
  type: object
  properties:
    mode:
      type: string
  required: [mode]
  additionalProperties: false
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
        body: JSON.stringify({
          input: {
            mode: 123
          }
        })
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "action_input_invalid"
      }
    });
  });

  it("rejects user-triggered action runs over HTTP when callable_by_user is false", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-http-action-user-guard-"));
    await mkdir(path.join(tempDir, ".openharness", "actions", "echo"), { recursive: true });

    await writeFile(
      path.join(tempDir, ".openharness", "actions", "echo", "ACTION.yaml"),
      `
name: debug.echo
description: Echo over HTTP
expose:
  callable_by_user: false
  callable_by_api: true
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
        body: JSON.stringify({
          triggerSource: "user"
        })
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "action_not_callable_by_user"
      }
    });
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
        runtime: "workspace",
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
        runtime: "workspace",
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

  it("manually compacts a session over HTTP", async () => {
    activeApp = await createStartedApp();
    const authHeaders = {
      authorization: "Bearer token-1",
      "content-type": "application/json"
    };

    const workspaceResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "demo-manual-compact",
        runtime: "workspace",
        rootPath: "/tmp/demo-manual-compact"
      })
    });
    const workspace = (await workspaceResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${activeApp.baseUrl}/api/v1/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    const session = (await sessionResponse.json()) as { id: string };

    const firstAcceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "manual compact http one"
      })
    });
    const firstAccepted = (await firstAcceptedResponse.json()) as { runId: string };
    await waitFor(async () => {
      const runResponse = await fetch(`${activeApp.baseUrl}/api/v1/runs/${firstAccepted.runId}`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      const run = (await runResponse.json()) as { status: string };
      return run.status === "completed";
    });

    const secondAcceptedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "manual compact http two"
      })
    });
    const secondAccepted = (await secondAcceptedResponse.json()) as { runId: string };
    await waitFor(async () => {
      const runResponse = await fetch(`${activeApp.baseUrl}/api/v1/runs/${secondAccepted.runId}`, {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      const run = (await runResponse.json()) as { status: string };
      return run.status === "completed";
    });

    const compactResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/compact`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        instructions: "Prioritize next steps and blockers."
      })
    });
    const compactBody = await compactResponse.text();
    expect(compactResponse.status).toBe(200);
    await expect(Promise.resolve(JSON.parse(compactBody))).resolves.toMatchObject({
      status: "completed",
      compacted: true,
      runId: expect.any(String)
    });

    const messagesResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    const page = (await messagesResponse.json()) as { items: Array<{ role: string; content: unknown }> };
    expect(page.items.some((item) => item.role === "system" && extractMessageText(item.content).length > 0)).toBe(true);
  });

  it("serves single-message lookup, anchor context lookup, and keyset-paginated session messages over HTTP", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    const now = new Date().toISOString();
    await persistence.workspaceRepository.upsert({
      id: "project_http_message_queries",
      name: "http-message-queries",
      rootPath: "/tmp/http-message-queries",
      executionPolicy: "local",
      status: "active",
      createdAt: now,
      updatedAt: now,
      kind: "project",
      readOnly: false,
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
        workspaceId: "project_http_message_queries",
        agents: [],
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
    } satisfies CallerContext;

    const session = await runtimeService.createSession({
      workspaceId: "project_http_message_queries",
      caller,
      input: {}
    });

    for (const [index, text] of ["message-1", "message-2", "message-3", "message-4", "message-5"].entries()) {
      await persistence.messageRepository.create({
        id: `msg_http_query_${index + 1}`,
        sessionId: session.id,
        runId: `run_http_query_${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: text,
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()
      });
    }

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

    const newestPageResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages?pageSize=2&direction=backward`,
      {
        headers: {
          authorization: "Bearer token-1"
        }
      }
    );
    expect(newestPageResponse.status).toBe(200);
    const newestPage = (await newestPageResponse.json()) as {
      items: Array<{ content: unknown }>;
      nextCursor?: string;
      totalCount?: number;
    };
    expect(newestPage.items.map((message) => extractMessageText(message.content))).toEqual(["message-4", "message-5"]);
    expect(newestPage.nextCursor).toEqual(expect.any(String));
    expect(newestPage.totalCount).toBe(5);

    const olderPageResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages?pageSize=2&direction=backward&cursor=${encodeURIComponent(newestPage.nextCursor ?? "")}`,
      {
        headers: {
          authorization: "Bearer token-1"
        }
      }
    );
    expect(olderPageResponse.status).toBe(200);
    const olderPage = (await olderPageResponse.json()) as {
      items: Array<{ content: unknown }>;
      nextCursor?: string;
      totalCount?: number;
    };
    expect(olderPage.items.map((message) => extractMessageText(message.content))).toEqual(["message-2", "message-3"]);
    expect(olderPage.nextCursor).toEqual(expect.any(String));
    expect(olderPage.totalCount).toBe(5);

    const messageResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages/msg_http_query_3`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(messageResponse.status).toBe(200);
    const message = (await messageResponse.json()) as { id: string; content: unknown };
    expect(message.id).toBe("msg_http_query_3");
    expect(extractMessageText(message.content)).toBe("message-3");

    const contextResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages/msg_http_query_3/context?before=2&after=1`,
      {
        headers: {
          authorization: "Bearer token-1"
        }
      }
    );
    expect(contextResponse.status).toBe(200);
    const context = (await contextResponse.json()) as {
      anchor: { content: unknown };
      before: Array<{ content: unknown }>;
      after: Array<{ content: unknown }>;
      hasMoreBefore: boolean;
      hasMoreAfter: boolean;
    };
    expect(extractMessageText(context.anchor.content)).toBe("message-3");
    expect(context.before.map((item) => extractMessageText(item.content))).toEqual(["message-1", "message-2"]);
    expect(context.after.map((item) => extractMessageText(item.content))).toEqual(["message-4"]);
    expect(context.hasMoreBefore).toBe(false);
    expect(context.hasMoreAfter).toBe(true);
  });

  it("serves transcript messages for Web session hydration without replaying raw stored messages", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new EngineService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });
    await persistence.workspaceRepository.upsert(
      await createWorkspaceRecord({
        id: "project_http_transcript_messages",
        historyMirrorEnabled: false
      })
    );

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    } satisfies CallerContext;
    const session = await runtimeService.createSession({
      workspaceId: "project_http_transcript_messages",
      caller,
      input: {}
    });
    await persistence.messageRepository.create({
      id: "msg_raw_old",
      sessionId: session.id,
      role: "assistant",
      content: "raw old",
      createdAt: "2024-01-01T00:00:00.000Z"
    });
    await persistence.engineMessageRepository.replaceBySessionId(session.id, [
      {
        id: "rtm_latest_1",
        sessionId: session.id,
        role: "assistant",
        kind: "assistant_text",
        content: "processed latest 1",
        createdAt: "2024-01-01T00:00:10.000Z"
      },
      {
        id: "rtm_latest_2",
        sessionId: session.id,
        role: "assistant",
        kind: "assistant_text",
        content: "processed latest 2",
        createdAt: "2024-01-01T00:00:11.000Z"
      }
    ] satisfies EngineMessage[]);

    activeApp = await createStartedAppWithEngineService(runtimeService, gateway);

    const snapshotResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/snapshot`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      messages: { items: Array<{ content: unknown }>; totalCount?: number };
    };
    expect(snapshot.messages.items.map((message) => extractMessageText(message.content))).toEqual([
      "processed latest 1",
      "processed latest 2"
    ]);
    expect(snapshot.messages.totalCount).toBe(2);

    const transcriptResponse = await fetch(
      `${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages?pageSize=8&direction=backward&view=transcript`,
      {
        headers: {
          authorization: "Bearer token-1"
        }
      }
    );
    expect(transcriptResponse.status).toBe(200);
    const transcriptPage = (await transcriptResponse.json()) as {
      items: Array<{ content: unknown }>;
      totalCount?: number;
    };
    expect(transcriptPage.items.map((message) => extractMessageText(message.content))).toEqual([
      "processed latest 1",
      "processed latest 2"
    ]);
    expect(transcriptPage.totalCount).toBe(2);

    const storedResponse = await fetch(`${activeApp.baseUrl}/api/v1/sessions/${session.id}/messages?pageSize=8`, {
      headers: {
        authorization: "Bearer token-1"
      }
    });
    expect(storedResponse.status).toBe(200);
    const storedPage = (await storedResponse.json()) as { items: Array<{ content: unknown }> };
    expect(storedPage.items.map((message) => extractMessageText(message.content))).toEqual(["raw old"]);
  });
});
