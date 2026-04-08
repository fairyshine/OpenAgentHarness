import type { FastifyInstance } from "fastify";

import {
  modelProviderListSchema,
  platformModelListSchema,
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
  workspaceTemplateListSchema
} from "@oah/api-contracts";
import { SUPPORTED_MODEL_PROVIDERS } from "@oah/model-gateway";
import { AppError } from "@oah/runtime-core";

import { createParamsSchema } from "../context.js";
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
    dependencies.healthCheck
      ? dependencies.healthCheck()
      : {
          status: "ok"
        }
  );

  app.get("/readyz", async (_request, reply) => {
    const payload = dependencies.readinessCheck
      ? await dependencies.readinessCheck()
      : {
          status: "ready"
        };

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
    const query = storageTableQuerySchema.parse(request.query);
    const table = storagePostgresTableNameSchema.parse(params.table);
    return reply.send(
      storagePostgresTablePageSchema.parse(
        await dependencies.storageAdmin.postgresTable(table, {
          limit: query.limit,
          offset: query.offset,
          ...(query.q ? { q: query.q } : {}),
          ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
          ...(query.sessionId ? { sessionId: query.sessionId } : {}),
          ...(query.runId ? { runId: query.runId } : {})
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
