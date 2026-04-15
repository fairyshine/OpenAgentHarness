import type { FastifyInstance } from "fastify";

import {
  healthReportSchema,
  modelProviderListSchema,
  platformModelListSchema,
  readinessReportSchema,
  storageOverviewSchema,
  storagePostgresTableNameSchema,
  storagePostgresTablePageSchema,
  storageRedisDeleteKeyResponseSchema,
  storageRedisDeleteKeysRequestSchema,
  storageRedisDeleteKeysResponseSchema,
  storageRedisKeyDetailSchema,
  storageRedisKeyPageSchema,
  storageRedisKeyQuerySchema,
  storageRedisKeysQuerySchema,
  storageRedisMaintenanceRequestSchema,
  storageRedisMaintenanceResponseSchema,
  storageTableQuerySchema,
  uploadWorkspaceTemplateRequestSchema,
  uploadWorkspaceTemplateResponseSchema,
  workspaceTemplateListSchema
} from "@oah/api-contracts";
import { SUPPORTED_MODEL_PROVIDERS } from "@oah/model-gateway";
import { AppError } from "@oah/runtime-core";

import { createParamsSchema, writeSseEvent } from "../context.js";
import {
  buildApiIndex,
  buildDeveloperDocsHtml,
  buildDeveloperLandingHtml,
  getRequestOrigin,
  loadOpenApiDocument,
  loadOpenApiSpec
} from "../developer-docs.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";

export function registerPublicRoutes(app: FastifyInstance, dependencies: AppDependencies, options: AppRouteOptions): void {
  app.get("/", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(buildDeveloperLandingHtml(request));
  });

  app.get("/docs", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(buildDeveloperDocsHtml(request));
  });

  app.get("/openapi.yaml", async (request, reply) => {
    reply.type("application/yaml; charset=utf-8");
    return reply.send(await loadOpenApiSpec(getRequestOrigin(request)));
  });

  app.get("/openapi.json", async (request, reply) => reply.send(await loadOpenApiDocument(getRequestOrigin(request))));

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

  app.get("/api/v1", async (request, reply) => reply.send(buildApiIndex(request)));

  app.get("/api/v1/workspace-templates", async (_request, reply) => {
    if (options.workspaceMode === "single" || !dependencies.listWorkspaceTemplates) {
      throw new AppError(501, "workspace_templates_unavailable", "Workspace templates are not available on this server.");
    }

    const templates = await dependencies.listWorkspaceTemplates();
    return reply.send(
      workspaceTemplateListSchema.parse({
        items: templates
      })
    );
  });

  app.post("/api/v1/workspace-templates/upload", async (request, reply) => {
    if (options.workspaceMode === "single" || !dependencies.uploadWorkspaceTemplate) {
      throw new AppError(501, "template_upload_unavailable", "Template upload is not available on this server.");
    }

    if (!Buffer.isBuffer(request.body)) {
      throw new AppError(415, "invalid_content_type", "Template upload requires Content-Type: application/octet-stream.");
    }

    const query = uploadWorkspaceTemplateRequestSchema.parse(request.query);

    try {
      const template = await dependencies.uploadWorkspaceTemplate({
        templateName: query.name,
        zipBuffer: request.body,
        overwrite: query.overwrite
      });
      return reply.status(201).send(uploadWorkspaceTemplateResponseSchema.parse({ name: template.name }));
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "template_already_exists") {
        throw new AppError(409, "template_already_exists", error.message);
      }
      if (error instanceof Error && (error as Error & { code?: string }).code === "empty_template_zip") {
        throw new AppError(400, "empty_template_zip", error.message);
      }
      throw error;
    }
  });

  app.delete("/api/v1/workspace-templates/:templateName", async (request, reply) => {
    if (options.workspaceMode === "single" || !dependencies.deleteWorkspaceTemplate) {
      throw new AppError(501, "template_delete_unavailable", "Template deletion is not available on this server.");
    }

    const params = createParamsSchema("templateName").parse(request.params);

    try {
      await dependencies.deleteWorkspaceTemplate({
        templateName: params.templateName
      });
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "template_not_found") {
        throw new AppError(404, "template_not_found", error.message);
      }
      throw error;
    }
  });

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

  app.get("/api/v1/storage/overview", async (_request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    return reply.send(storageOverviewSchema.parse(await dependencies.storageAdmin.overview()));
  });

  app.get("/api/v1/storage/postgres/tables/:table", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const params = createParamsSchema("table").parse(request.params);
    const rawQuery = request.query as Record<string, unknown>;
    const parsedQuery = storageTableQuerySchema.parse(request.query);
    const query = {
      ...parsedQuery,
      ...(typeof rawQuery.status === "string" ? { status: rawQuery.status } : {}),
      ...(typeof rawQuery.errorCode === "string" ? { errorCode: rawQuery.errorCode } : {}),
      ...(typeof rawQuery.recoveryState === "string" ? { recoveryState: rawQuery.recoveryState } : {})
    };
    const table = storagePostgresTableNameSchema.parse(params.table);
    return reply.send(
      storagePostgresTablePageSchema.parse(
        await dependencies.storageAdmin.postgresTable(table, {
          limit: query.limit,
          offset: query.offset,
          ...(query.q ? { q: query.q } : {}),
          ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
          ...(query.sessionId ? { sessionId: query.sessionId } : {}),
          ...(query.runId ? { runId: query.runId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.errorCode ? { errorCode: query.errorCode } : {}),
          ...(query.recoveryState ? { recoveryState: query.recoveryState } : {})
        })
      )
    );
  });

  app.get("/api/v1/storage/redis/keys", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeysQuerySchema.parse(request.query);
    return reply.send(
      storageRedisKeyPageSchema.parse(await dependencies.storageAdmin.redisKeys(query.pattern, query.cursor, query.pageSize))
    );
  });

  app.get("/api/v1/storage/redis/key", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeyQuerySchema.parse(request.query);
    return reply.send(storageRedisKeyDetailSchema.parse(await dependencies.storageAdmin.redisKeyDetail(query.key)));
  });

  app.delete("/api/v1/storage/redis/key", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeyQuerySchema.parse(request.query);
    return reply.send(storageRedisDeleteKeyResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKey(query.key)));
  });

  app.post("/api/v1/storage/redis/keys/delete", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisDeleteKeysRequestSchema.parse(request.body);
    return reply.send(storageRedisDeleteKeysResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKeys(body.keys)));
  });

  app.post("/api/v1/storage/redis/session-queue/clear", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisMaintenanceRequestSchema.parse(request.body);
    return reply.send(
      storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.clearRedisSessionQueue(body.key))
    );
  });

  app.post("/api/v1/storage/redis/session-lock/release", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisMaintenanceRequestSchema.parse(request.body);
    return reply.send(
      storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.releaseRedisSessionLock(body.key))
    );
  });
}
