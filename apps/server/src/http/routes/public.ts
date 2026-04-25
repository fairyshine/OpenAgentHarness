import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  distributedPlatformModelRefreshResultSchema,
  healthReportSchema,
  modelProviderListSchema,
  platformModelListSchema,
  platformModelSnapshotSchema,
  readinessReportSchema,
  uploadWorkspaceRuntimeRequestSchema,
  uploadWorkspaceRuntimeResponseSchema,
  workspaceRuntimeListSchema
} from "@oah/api-contracts";
import { AppError } from "@oah/engine-core";
import { SUPPORTED_MODEL_PROVIDERS } from "@oah/model-runtime/providers";

import { createParamsSchema, writeSseEvent } from "../context.js";
import { describeSandboxTopology } from "../../sandbox-topology.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";
import { renderNativeWorkspaceSyncMetrics } from "../../observability/native-workspace-sync.js";
import { registerPublicStorageRoutes } from "./public-storage-lazy.js";

let developerDocsModulePromise: Promise<typeof import("../developer-docs.js")> | undefined;

function loadDeveloperDocsModule(): Promise<typeof import("../developer-docs.js")> {
  developerDocsModulePromise ??= import("../developer-docs.js");
  return developerDocsModulePromise;
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

    if (!Buffer.isBuffer(request.body)) {
      throw new AppError(415, "invalid_content_type", "Runtime upload requires Content-Type: application/octet-stream.");
    }

    const query = uploadWorkspaceRuntimeRequestSchema.parse(request.query);

    try {
      const runtime = await dependencies.uploadWorkspaceRuntime({
        runtimeName: query.name,
        zipBuffer: request.body,
        overwrite: query.overwrite
      });
      return reply.status(201).send(uploadWorkspaceRuntimeResponseSchema.parse({ name: runtime.name }));
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "runtime_already_exists") {
        throw new AppError(409, "runtime_already_exists", error.message);
      }
      if (error instanceof Error && (error as Error & { code?: string }).code === "empty_runtime_zip") {
        throw new AppError(400, "empty_runtime_zip", error.message);
      }
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
    return reply.send(renderNativeWorkspaceSyncMetrics());
  });

  app.get("/api/v1", async (request, reply) => reply.send((await loadDeveloperDocsModule()).buildApiIndex(request)));

  app.get("/api/v1/runtimes", listRuntimes);
  app.post("/api/v1/runtimes/upload", uploadRuntime);
  app.delete("/api/v1/runtimes/:runtimeName", deleteRuntime);
  // Keep legacy /blueprints aliases during the runtime API rename so staggered web/api deploys do not 404.
  app.get("/api/v1/blueprints", listRuntimes);
  app.post("/api/v1/blueprints/upload", uploadRuntime);
  app.delete("/api/v1/blueprints/:runtimeName", deleteRuntime);

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
