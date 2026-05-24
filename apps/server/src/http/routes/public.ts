import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  distributedPlatformModelRefreshResultSchema,
  healthReportSchema,
  platformAssetDetailSchema,
  modelProviderListSchema,
  platformAssetListSchema,
  platformAssetMutationResponseSchema,
  platformModelListSchema,
  platformModelSnapshotSchema,
  readinessReportSchema,
  systemProfileSchema,
  updateWorkspaceRuntimeResponseSchema,
  uploadPlatformAssetRequestSchema,
  uploadWorkspaceRuntimeRequestSchema,
  uploadWorkspaceRuntimeResponseSchema,
  workspaceRuntimeListSchema
} from "@oah/api-contracts";
import type { PlatformAssetKind } from "@oah/api-contracts";
import { AppError } from "@oah/engine-core";
import { SUPPORTED_MODEL_PROVIDERS } from "@oah/model-runtime/providers";

import { createParamsSchema, writeSseEvent } from "../context.js";
import { readRequestBodyBuffer } from "../proxy-utils.js";
import { describeSandboxTopology } from "../../sandbox-topology.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";
import { renderNativeWorkspaceSyncMetrics } from "../../observability/native-workspace-sync.js";
import { renderObjectStorageMetrics } from "../../observability/object-storage.js";
import { registerPublicStorageRoutes } from "./public-storage-lazy.js";
import { buildSystemProfile } from "../../system-profile.js";

let developerDocsModulePromise: Promise<typeof import("../developer-docs.js")> | undefined;
const RUNTIME_UPLOAD_BODY_LIMIT_BYTES = 256 * 1024 * 1024;
const PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES = 256 * 1024 * 1024;

function loadDeveloperDocsModule(): Promise<typeof import("../developer-docs.js")> {
  developerDocsModulePromise ??= import("../developer-docs.js");
  return developerDocsModulePromise;
}

function runtimeUploadErrorToAppError(error: unknown): AppError | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const code = (error as Error & { code?: string }).code;
  if (code === "runtime_already_exists") {
    return new AppError(409, "runtime_already_exists", error.message);
  }
  if (code === "runtime_not_found") {
    return new AppError(404, "runtime_not_found", error.message);
  }
  if (code === "empty_runtime_zip") {
    return new AppError(400, "empty_runtime_zip", error.message);
  }
  if (code === "invalid_runtime_zip") {
    return new AppError(400, "invalid_runtime_zip", error.message);
  }

  return undefined;
}

function requirePlatformAssetManagement(dependencies: AppDependencies, options: AppRouteOptions): void {
  if (options.workspaceMode === "single" || !dependencies.listPlatformAssets) {
    throw new AppError(501, "platform_assets_unavailable", "Platform asset management is not available on this server.");
  }
}

function readPlatformAssetKind(params: unknown): PlatformAssetKind {
  const assetKind = createParamsSchema("assetKind").parse(params).assetKind;
  if (assetKind === "runtimes") return "runtime";
  if (assetKind === "models") return "model";
  if (assetKind === "tools") return "tool";
  if (assetKind === "skills") return "skill";
  throw new AppError(404, "platform_asset_kind_not_found", `Unsupported platform asset kind: ${assetKind}`);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "invalid_request_body", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const objectValue = asObject(value, label);
  const entries = Object.entries(objectValue);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    throw new AppError(400, "invalid_request_body", `${label} values must be strings.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function readToolAssetBody(body: unknown): {
  definition: Record<string, unknown>;
  serverFiles?: Record<string, string> | undefined;
} {
  const objectValue = asObject(body, "Tool asset request body");
  const definition = asObject(objectValue.definition, "Tool asset definition");
  const serverFiles = readStringMap(objectValue.serverFiles, "Tool server files");
  return {
    definition,
    ...(serverFiles ? { serverFiles } : {})
  };
}

function readSkillAssetBody(body: unknown): {
  skillMarkdown: string;
  files?: Record<string, string> | undefined;
} {
  const objectValue = asObject(body, "Skill asset request body");
  if (typeof objectValue.skillMarkdown !== "string" || objectValue.skillMarkdown.trim().length === 0) {
    throw new AppError(400, "invalid_request_body", "Skill asset request body must include skillMarkdown.");
  }
  const files = readStringMap(objectValue.files, "Skill files");
  return {
    skillMarkdown: objectValue.skillMarkdown,
    ...(files ? { files } : {})
  };
}

export function registerPublicRoutes(app: FastifyInstance, dependencies: AppDependencies, options: AppRouteOptions): void {
  const listRuntimes = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.listWorkspaceRuntimes) {
      throw new AppError(501, "workspace_runtimes_unavailable", "Workspace runtimes are not available on this server.");
    }

    const runtimes = await dependencies.listWorkspaceRuntimes();
    return reply.send(
      workspaceRuntimeListSchema.parse({
        items: runtimes
      })
    );
  };

  const uploadRuntime = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadWorkspaceRuntime) {
      throw new AppError(501, "runtime_upload_unavailable", "Runtime upload is not available on this server.");
    }

    const zipBuffer = await readRequestBodyBuffer(request.body);
    if (!zipBuffer) {
      throw new AppError(415, "invalid_content_type", "Runtime upload requires Content-Type: application/octet-stream.");
    }

    const query = uploadWorkspaceRuntimeRequestSchema.parse(request.query);

    try {
      const runtime = await dependencies.uploadWorkspaceRuntime({
        runtimeName: query.name,
        zipBuffer,
        overwrite: query.overwrite
      });
      return reply.status(201).send(uploadWorkspaceRuntimeResponseSchema.parse({ name: runtime.name }));
    } catch (error) {
      const appError = runtimeUploadErrorToAppError(error);
      if (appError) throw appError;
      throw error;
    }
  };

  const updateRuntime = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadWorkspaceRuntime) {
      throw new AppError(501, "runtime_update_unavailable", "Runtime update is not available on this server.");
    }

    const params = createParamsSchema("runtimeName").parse(request.params);
    const zipBuffer = await readRequestBodyBuffer(request.body);
    if (!zipBuffer) {
      throw new AppError(415, "invalid_content_type", "Runtime update requires Content-Type: application/octet-stream.");
    }

    try {
      const runtime = await dependencies.uploadWorkspaceRuntime({
        runtimeName: params.runtimeName,
        zipBuffer,
        overwrite: true,
        requireExisting: true
      });
      return reply.send(updateWorkspaceRuntimeResponseSchema.parse({ name: runtime.name }));
    } catch (error) {
      const appError = runtimeUploadErrorToAppError(error);
      if (appError) throw appError;
      throw error;
    }
  };

  const deleteRuntime = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.deleteWorkspaceRuntime) {
      throw new AppError(501, "runtime_delete_unavailable", "Runtime deletion is not available on this server.");
    }

    const params = createParamsSchema("runtimeName").parse(request.params);

    try {
      await dependencies.deleteWorkspaceRuntime({
        runtimeName: params.runtimeName
      });
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "runtime_not_found") {
        throw new AppError(404, "runtime_not_found", error.message);
      }
      throw error;
    }
  };

  const listPlatformAssets = async (request: FastifyRequest, reply: FastifyReply) => {
    const kind = readPlatformAssetKind(request.params);
    if (kind === "runtime") {
      if (options.workspaceMode === "single" || !dependencies.listWorkspaceRuntimes) {
        throw new AppError(501, "workspace_runtimes_unavailable", "Workspace runtimes are not available on this server.");
      }
      return reply.send(platformAssetListSchema.parse({ kind, items: await dependencies.listWorkspaceRuntimes() }));
    }
    requirePlatformAssetManagement(dependencies, options);
    return reply.send(platformAssetListSchema.parse(await dependencies.listPlatformAssets!(kind)));
  };

  const getPlatformAssetDetail = async (request: FastifyRequest, reply: FastifyReply) => {
    const kind = readPlatformAssetKind(request.params);
    if (kind === "runtime") {
      throw new AppError(501, "workspace_runtime_detail_unavailable", "Workspace runtime details are not available on this server.");
    }
    if (options.workspaceMode === "single" || !dependencies.getPlatformAssetDetail) {
      throw new AppError(501, "platform_assets_unavailable", "Platform asset details are not available on this server.");
    }
    const params = createParamsSchema("assetName").parse(request.params);
    return reply.send(platformAssetDetailSchema.parse(await dependencies.getPlatformAssetDetail(kind, params.assetName)));
  };

  const uploadPlatformRuntimeAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadWorkspaceRuntime) {
      throw new AppError(501, "runtime_upload_unavailable", "Runtime upload is not available on this server.");
    }

    const zipBuffer = await readRequestBodyBuffer(request.body);
    if (!zipBuffer) {
      throw new AppError(415, "invalid_content_type", "Runtime asset upload requires Content-Type: application/octet-stream.");
    }

    const query = uploadWorkspaceRuntimeRequestSchema.parse(request.query);

    try {
      const runtime = await dependencies.uploadWorkspaceRuntime({
        runtimeName: query.name,
        zipBuffer,
        overwrite: query.overwrite
      });
      return reply.status(201).send(platformAssetMutationResponseSchema.parse({ kind: "runtime", name: runtime.name }));
    } catch (error) {
      const appError = runtimeUploadErrorToAppError(error);
      if (appError) throw appError;
      throw error;
    }
  };

  const updatePlatformRuntimeAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadWorkspaceRuntime) {
      throw new AppError(501, "runtime_update_unavailable", "Runtime update is not available on this server.");
    }

    const params = createParamsSchema("runtimeName").parse(request.params);
    const zipBuffer = await readRequestBodyBuffer(request.body);
    if (!zipBuffer) {
      throw new AppError(415, "invalid_content_type", "Runtime asset update requires Content-Type: application/octet-stream.");
    }

    try {
      const runtime = await dependencies.uploadWorkspaceRuntime({
        runtimeName: params.runtimeName,
        zipBuffer,
        overwrite: true,
        requireExisting: true
      });
      return reply.send(platformAssetMutationResponseSchema.parse({ kind: "runtime", name: runtime.name }));
    } catch (error) {
      const appError = runtimeUploadErrorToAppError(error);
      if (appError) throw appError;
      throw error;
    }
  };

  const uploadPlatformModelAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadPlatformModelAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform model asset upload is not available on this server.");
    }

    const yamlBuffer = await readRequestBodyBuffer(request.body);
    if (!yamlBuffer) {
      throw new AppError(415, "invalid_content_type", "Model asset upload requires Content-Type: application/octet-stream.");
    }

    const query = uploadPlatformAssetRequestSchema.parse(request.query);
    return reply.status(201).send(
      platformAssetMutationResponseSchema.parse(
        await dependencies.uploadPlatformModelAsset({
          name: query.name,
          yamlBuffer,
          overwrite: query.overwrite
        })
      )
    );
  };

  const updatePlatformModelAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadPlatformModelAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform model asset update is not available on this server.");
    }

    const params = createParamsSchema("assetName").parse(request.params);
    const yamlBuffer = await readRequestBodyBuffer(request.body);
    if (!yamlBuffer) {
      throw new AppError(415, "invalid_content_type", "Model asset update requires Content-Type: application/octet-stream.");
    }

    return reply.send(
      platformAssetMutationResponseSchema.parse(
        await dependencies.uploadPlatformModelAsset({
          name: params.assetName,
          yamlBuffer,
          overwrite: true,
          requireExisting: true
        })
      )
    );
  };

  const deletePlatformModelAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.deletePlatformModelAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform model asset deletion is not available on this server.");
    }

    const params = createParamsSchema("assetName").parse(request.params);
    await dependencies.deletePlatformModelAsset({ name: params.assetName });
    return reply.status(204).send();
  };

  const uploadPlatformToolAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadPlatformToolAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform tool asset upload is not available on this server.");
    }

    const query = uploadPlatformAssetRequestSchema.parse(request.query);
    const body = readToolAssetBody(request.body);
    return reply.status(201).send(
      platformAssetMutationResponseSchema.parse(
        await dependencies.uploadPlatformToolAsset({
          name: query.name,
          definition: body.definition,
          ...(body.serverFiles ? { serverFiles: body.serverFiles } : {}),
          overwrite: query.overwrite
        })
      )
    );
  };

  const updatePlatformToolAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadPlatformToolAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform tool asset update is not available on this server.");
    }

    const params = createParamsSchema("assetName").parse(request.params);
    const body = readToolAssetBody(request.body);
    return reply.send(
      platformAssetMutationResponseSchema.parse(
        await dependencies.uploadPlatformToolAsset({
          name: params.assetName,
          definition: body.definition,
          ...(body.serverFiles ? { serverFiles: body.serverFiles } : {}),
          overwrite: true,
          requireExisting: true
        })
      )
    );
  };

  const deletePlatformToolAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.deletePlatformToolAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform tool asset deletion is not available on this server.");
    }

    const params = createParamsSchema("assetName").parse(request.params);
    await dependencies.deletePlatformToolAsset({ name: params.assetName });
    return reply.status(204).send();
  };

  const uploadPlatformSkillAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadPlatformSkillAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform skill asset upload is not available on this server.");
    }

    const query = uploadPlatformAssetRequestSchema.parse(request.query);
    const body = readSkillAssetBody(request.body);
    return reply.status(201).send(
      platformAssetMutationResponseSchema.parse(
        await dependencies.uploadPlatformSkillAsset({
          name: query.name,
          skillMarkdown: body.skillMarkdown,
          ...(body.files ? { files: body.files } : {}),
          overwrite: query.overwrite
        })
      )
    );
  };

  const updatePlatformSkillAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadPlatformSkillAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform skill asset update is not available on this server.");
    }

    const params = createParamsSchema("assetName").parse(request.params);
    const body = readSkillAssetBody(request.body);
    return reply.send(
      platformAssetMutationResponseSchema.parse(
        await dependencies.uploadPlatformSkillAsset({
          name: params.assetName,
          skillMarkdown: body.skillMarkdown,
          ...(body.files ? { files: body.files } : {}),
          overwrite: true,
          requireExisting: true
        })
      )
    );
  };

  const deletePlatformSkillAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.workspaceMode === "single" || !dependencies.deletePlatformSkillAsset) {
      throw new AppError(501, "platform_assets_unavailable", "Platform skill asset deletion is not available on this server.");
    }

    const params = createParamsSchema("assetName").parse(request.params);
    await dependencies.deletePlatformSkillAsset({ name: params.assetName });
    return reply.status(204).send();
  };

  app.get("/", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send((await loadDeveloperDocsModule()).buildDeveloperLandingHtml(request));
  });

  app.get("/docs", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send((await loadDeveloperDocsModule()).buildDeveloperDocsHtml(request));
  });

  app.get("/openapi.yaml", async (request, reply) => {
    reply.type("application/yaml; charset=utf-8");
    const developerDocs = await loadDeveloperDocsModule();
    return reply.send(await developerDocs.loadOpenApiSpec(developerDocs.getRequestOrigin(request)));
  });

  app.get("/openapi.json", async (request, reply) => {
    const developerDocs = await loadDeveloperDocsModule();
    return reply.send(await developerDocs.loadOpenApiDocument(developerDocs.getRequestOrigin(request)));
  });

  app.get("/healthz", async () =>
    healthReportSchema.parse(
      dependencies.healthCheck
        ? await dependencies.healthCheck()
        : {
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
            sandbox: describeSandboxTopology(dependencies.sandboxHostProviderKind),
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
          }
    )
  );

  app.get("/readyz", async (_request, reply) => {
    const payload = readinessReportSchema.parse(
      dependencies.readinessCheck
        ? await dependencies.readinessCheck()
        : {
            status: "ready",
            draining: false,
            checks: {
              postgres: "not_configured",
              redisEvents: "not_configured",
              redisRunQueue: "not_configured"
            }
          }
    );

    if (payload.status === "not_ready") {
      return reply.status(503).send(payload);
    }

    return reply.send(payload);
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return reply.send(`${renderNativeWorkspaceSyncMetrics()}${renderObjectStorageMetrics()}`);
  });

  app.get("/api/v1", async (request, reply) => reply.send((await loadDeveloperDocsModule()).buildApiIndex(request)));

  app.get("/api/v1/system/profile", async (_request, reply) =>
    {
      const profile =
        dependencies.systemProfile ??
        buildSystemProfile({
          workspaceMode: options.workspaceMode,
          storageInspection: Boolean(dependencies.storageAdmin),
          assetManagement: Boolean(dependencies.listPlatformAssets)
        });

      return reply.send(
        systemProfileSchema.parse({
          ...profile,
          capabilities: {
            ...profile.capabilities,
            assetManagement: Boolean(dependencies.listPlatformAssets)
          }
        })
      );
    }
  );

  app.get("/api/v1/runtimes", listRuntimes);
  app.post("/api/v1/runtimes/upload", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, uploadRuntime);
  app.put("/api/v1/runtimes/:runtimeName", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, updateRuntime);
  app.delete("/api/v1/runtimes/:runtimeName", deleteRuntime);
  // Keep legacy /blueprints aliases during the runtime API rename so staggered web/api deploys do not 404.
  app.get("/api/v1/blueprints", listRuntimes);
  app.post("/api/v1/blueprints/upload", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, uploadRuntime);
  app.put("/api/v1/blueprints/:runtimeName", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, updateRuntime);
  app.delete("/api/v1/blueprints/:runtimeName", deleteRuntime);

  app.get("/api/v1/assets/:assetKind", listPlatformAssets);
  app.get("/api/v1/assets/:assetKind/:assetName", getPlatformAssetDetail);
  app.post("/api/v1/assets/runtimes/upload", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, uploadPlatformRuntimeAsset);
  app.put("/api/v1/assets/runtimes/:runtimeName", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, updatePlatformRuntimeAsset);
  app.delete("/api/v1/assets/runtimes/:runtimeName", deleteRuntime);
  app.post(
    "/api/v1/assets/models/upload",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    uploadPlatformModelAsset
  );
  app.put(
    "/api/v1/assets/models/:assetName",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    updatePlatformModelAsset
  );
  app.delete("/api/v1/assets/models/:assetName", deletePlatformModelAsset);
  app.post(
    "/api/v1/assets/tools/upload",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    uploadPlatformToolAsset
  );
  app.put(
    "/api/v1/assets/tools/:assetName",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    updatePlatformToolAsset
  );
  app.delete("/api/v1/assets/tools/:assetName", deletePlatformToolAsset);
  app.post(
    "/api/v1/assets/skills/upload",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    uploadPlatformSkillAsset
  );
  app.put(
    "/api/v1/assets/skills/:assetName",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    updatePlatformSkillAsset
  );
  app.delete("/api/v1/assets/skills/:assetName", deletePlatformSkillAsset);
  // Keep the longer route name as a compatibility alias for early clients.
  app.get("/api/v1/platform-assets/:assetKind", listPlatformAssets);
  app.get("/api/v1/platform-assets/:assetKind/:assetName", getPlatformAssetDetail);
  app.post("/api/v1/platform-assets/runtimes/upload", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, uploadPlatformRuntimeAsset);
  app.put("/api/v1/platform-assets/runtimes/:runtimeName", { bodyLimit: RUNTIME_UPLOAD_BODY_LIMIT_BYTES }, updatePlatformRuntimeAsset);
  app.delete("/api/v1/platform-assets/runtimes/:runtimeName", deleteRuntime);
  app.post(
    "/api/v1/platform-assets/models/upload",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    uploadPlatformModelAsset
  );
  app.put(
    "/api/v1/platform-assets/models/:assetName",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    updatePlatformModelAsset
  );
  app.delete("/api/v1/platform-assets/models/:assetName", deletePlatformModelAsset);
  app.post(
    "/api/v1/platform-assets/tools/upload",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    uploadPlatformToolAsset
  );
  app.put(
    "/api/v1/platform-assets/tools/:assetName",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    updatePlatformToolAsset
  );
  app.delete("/api/v1/platform-assets/tools/:assetName", deletePlatformToolAsset);
  app.post(
    "/api/v1/platform-assets/skills/upload",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    uploadPlatformSkillAsset
  );
  app.put(
    "/api/v1/platform-assets/skills/:assetName",
    { bodyLimit: PLATFORM_ASSET_UPLOAD_BODY_LIMIT_BYTES },
    updatePlatformSkillAsset
  );
  app.delete("/api/v1/platform-assets/skills/:assetName", deletePlatformSkillAsset);

  app.get("/api/v1/model-providers", async (_request, reply) =>
    reply.send(
      modelProviderListSchema.parse({
        items: SUPPORTED_MODEL_PROVIDERS
      })
    )
  );

  app.get("/api/v1/platform-models", async (_request, reply) => {
    if (!dependencies.listPlatformModels) {
      throw new AppError(404, "platform_models_unavailable", "Platform models are not available.");
    }

    const items = await dependencies.listPlatformModels();
    return reply.send(
      platformModelListSchema.parse({
        items
      })
    );
  });

  app.post("/api/v1/platform-models/refresh", async (_request, reply) => {
    if (!dependencies.refreshPlatformModels) {
      throw new AppError(404, "platform_models_unavailable", "Platform model refresh is not available.");
    }

    return reply.send(platformModelSnapshotSchema.parse(await dependencies.refreshPlatformModels()));
  });

  app.post("/api/v1/platform-models/refresh/distributed", async (_request, reply) => {
    if (!dependencies.refreshDistributedPlatformModels) {
      throw new AppError(
        404,
        "platform_models_unavailable",
        "Distributed platform model refresh is not available."
      );
    }

    return reply.send(distributedPlatformModelRefreshResultSchema.parse(await dependencies.refreshDistributedPlatformModels()));
  });

  app.get(
    "/api/v1/platform-models/events",
    {
      logLevel: "warn"
    },
    async (request, reply) => {
      if (!dependencies.getPlatformModelSnapshot || !dependencies.subscribePlatformModelSnapshot) {
        throw new AppError(404, "platform_models_unavailable", "Platform model live updates are not available.");
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(": connected\n\n");

      const sendSnapshot = (
        event: "platform-models.snapshot" | "platform-models.updated",
        snapshot: Awaited<ReturnType<NonNullable<typeof dependencies.getPlatformModelSnapshot>>>
      ) => {
        writeSseEvent(reply, event, snapshot as Record<string, unknown>);
      };

      sendSnapshot("platform-models.snapshot", await dependencies.getPlatformModelSnapshot());
      const unsubscribe = dependencies.subscribePlatformModelSnapshot((snapshot) => {
        sendSnapshot("platform-models.updated", snapshot);
      });

      request.raw.on("close", () => {
        unsubscribe();
        reply.raw.end();
      });
    }
  );

  registerPublicStorageRoutes(app, dependencies);
}
